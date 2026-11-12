/*
 * The golden image: one image a person can put back with a gesture, and that nothing but a record
 * signed with the golden key can replace.
 *
 * MCUboot calls mcuboot_status_change() before it looks at any slot. Two things can happen there.
 *
 * The gesture: if Button 2 is held through a reset and let go in the right window, this stores the
 * pinned image in external flash, or copies it back into the primary slot from there.
 *
 * A promotion (from firmware 1.19.3, in a build that has the golden public key): the application
 * has left a promotion record in external flash (golden_record.h). If its signature is good with the
 * golden key, its counter is above the one this bootloader keeps, and it names the image in the
 * primary slot, confirmed, this copies that image into golden_partition, makes it the pin, and
 * restarts. Whatever the outcome, its answer goes into the request sector, for the application to
 * report.
 *
 * The pin is the one rule of its own that this needs: MCUboot's downgrade check only looks at swaps,
 * and a direct copy is not one. It is the last promotion, kept in the last page of this bootloader's
 * own partition, which MCUboot write-protects before the application starts; before any promotion
 * it is the digest compiled in as CONFIG_CRANIUM_GOLDEN_SHA256, with counter 0.
 *
 * This code cannot start an image. It has no access to what MCUboot boots, and after writing an
 * image anywhere it restarts the board, so the unchanged boot path checks the result as it checks
 * any image.
 */

#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/sys/util.h>
#include <zephyr/toolchain.h>

#include "bootutil/bootutil_log.h"
#include "bootutil/bootutil_public.h"
#include "bootutil/crypto/sha.h"
#include "bootutil/fault_injection_hardening.h"
#include "bootutil/image.h"
#include "bootutil/mcuboot_status.h"
#include "mcuboot_config/mcuboot_config.h"
#include "src/bootutil_priv.h"

#if defined(CRANIUM_GOLDEN_PROMOTE)
/*
 * The ECDSA code that checks every image's signature here: tinycrypt, CONFIG_BOOT_ECDSA_TINYCRYPT. It
 * is in the bootloader anyway, so the golden key costs little more than its 64 bytes.
 */
#if !defined(MCUBOOT_USE_TINYCRYPT)
#error "Golden image promotion checks its signature with tinycrypt, as MCUboot does in this build"
#endif
#include <tinycrypt/constants.h>
#include <tinycrypt/ecc_dsa.h>
/* Made by tools/golden_promote.py c-key from firmware/keys/golden_promote_pub.pem: CMakeLists.txt. */
#include "golden_key.h"
#endif

#include "golden_policy.h"
#include "golden_record.h"

BOOT_LOG_MODULE_DECLARE(mcuboot);

BUILD_ASSERT(sizeof(CONFIG_CRANIUM_GOLDEN_SHA256) == 2 * IMAGE_HASH_SIZE + 1,
	     "CONFIG_CRANIUM_GOLDEN_SHA256 needs 64 hex digits: see tools/golden.py freeze");
BUILD_ASSERT(CONFIG_CRANIUM_GOLDEN_SIZE > 0 &&
	     CONFIG_CRANIUM_GOLDEN_SIZE <= PARTITION_SIZE(golden_partition),
	     "CONFIG_CRANIUM_GOLDEN_SIZE needs the size of the image: see tools/golden.py freeze");
BUILD_ASSERT(PARTITION_SIZE(golden_partition) == PARTITION_SIZE(slot0_partition),
	     "golden_partition has to hold anything the primary slot can");
BUILD_ASSERT(BOOT_IMAGE_NUMBER == 1, "One image is all this was written for");
BUILD_ASSERT(IMAGE_HASH_SIZE == GOLDEN_HASH_SIZE, "The pin is a SHA-256");
/* The request and info sectors lie past golden_partition, in no partition at all. */
BUILD_ASSERT(PARTITION_OFFSET(golden_partition) + PARTITION_SIZE(golden_partition) <=
	     GOLDEN_REQUEST_OFFSET, "The request sector overlaps golden_partition");

/*
 * The state page is the last page of this bootloader's partition. Its code has to end below it:
 * CMakeLists.txt checks that after the link.
 */
#define STATE_PAGE_SIZE 0x1000
BUILD_ASSERT(PARTITION_SIZE(boot_partition) == 0x10000, "The state page is at 0xf000 of 64 KiB");

/* After turning on the pull-up, before the first reading of the button. */
#define SETTLE_US       100
#define SLOW_BLINK_MS   500
#define TIMES_NOTHING   1
#define TIMES_REFUSED   3

static const struct gpio_dt_spec button = GPIO_DT_SPEC_GET(DT_ALIAS(sw1), gpios);
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);

/* The pin in force: the last promotion, or the one compiled in. */
static struct golden_pin pin;

/* Busy, because this build has no threads to sleep with, and the watchdog may be running. */
static void wait_ms(uint32_t ms)
{
	for (uint32_t waited = 0; waited < ms; waited += GOLDEN_SAMPLE_MS) {
		MCUBOOT_WATCHDOG_FEED();
		k_busy_wait(GOLDEN_SAMPLE_MS * USEC_PER_MSEC);
	}
}

static void blink(int times)
{
	for (int i = 0; i < times; i++) {
		(void)gpio_pin_set_dt(&led, 1);
		wait_ms(SLOW_BLINK_MS);
		(void)gpio_pin_set_dt(&led, 0);
		wait_ms(SLOW_BLINK_MS);
	}
}

/*
 * Follows the button until the gesture has been decided. Out of line and global, because this
 * is the first place where the pin is ready and not read yet: firmware/tests/hil/golden_bench.py
 * stops here to hold the button down from the debug port.
 */
__noinline enum golden_gesture_result golden_gesture_follow(void)
{
	struct golden_gesture gesture = { 0 };
	enum golden_gesture_result result;
	uint32_t now_ms = 0;
	bool led_ready = false;

	while (true) {
		result = golden_gesture_step(&gesture, now_ms, gpio_pin_get_dt(&button) > 0);
		if (result != GOLDEN_GESTURE_WAIT) {
			return result;
		}

		if (!led_ready) {
			led_ready = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE) == 0;
		}

		if (led_ready) {
			(void)gpio_pin_set_dt(&led, golden_gesture_led(now_ms));
		}

		MCUBOOT_WATCHDOG_FEED();
		k_busy_wait(GOLDEN_SAMPLE_MS * USEC_PER_MSEC);
		now_ms += GOLDEN_SAMPLE_MS;
	}
}

static bool gesture_fired(void)
{
	if (gpio_pin_configure_dt(&button, GPIO_INPUT) != 0) {
		return false;
	}

	k_busy_wait(SETTLE_US);

	switch (golden_gesture_follow()) {
	case GOLDEN_GESTURE_FIRED:
		BOOT_LOG_INF("golden: gesture completed");
		return true;
	case GOLDEN_GESTURE_NOT_COMPLETED:
		BOOT_LOG_INF("golden: Button 2 let go too early or too late, nothing done");
		return false;
	case GOLDEN_GESTURE_STUCK:
		BOOT_LOG_WRN("golden: Button 2 is still down after %d s, booting anyway",
			     GOLDEN_GIVE_UP_MS / MSEC_PER_SEC);
		return false;
	default:
		return false;
	}
}

static void pins_release(void)
{
	(void)gpio_pin_configure(button.port, button.pin, GPIO_DISCONNECTED);
	(void)gpio_pin_configure(led.port, led.pin, GPIO_DISCONNECTED);
}

/*
 * Reads the pin in force: the state page's good entry with the highest counter, or the one compiled
 * in. *next is where the next entry goes. False only when neither can be had: nothing may then be
 * written.
 */
static bool pin_load(size_t *next)
{
	const struct flash_area *boot;
	struct golden_state_scan scan;
	uint8_t entry[GOLDEN_STATE_ENTRY_SIZE];
	size_t base;
	bool ok = true;

	memset(&scan, 0, sizeof(scan));
	if (flash_area_open(PARTITION_ID(boot_partition), &boot) != 0) {
		return false;
	}

	base = flash_area_get_size(boot) - STATE_PAGE_SIZE;
	for (size_t at = 0; at < STATE_PAGE_SIZE && ok; at += sizeof(entry)) {
		ok = flash_area_read(boot, base + at, entry, sizeof(entry)) == 0;
		if (ok) {
			golden_state_scan_entry(&scan, entry);
		}
	}

	flash_area_close(boot);
	if (!ok) {
		return false;
	}

	*next = scan.next_set ? scan.next : STATE_PAGE_SIZE;
	if (scan.found) {
		pin = scan.best;
		return true;
	}

	memset(&pin, 0, sizeof(pin));
	pin.size = CONFIG_CRANIUM_GOLDEN_SIZE;
	return hex2bin(CONFIG_CRANIUM_GOLDEN_SHA256, sizeof(CONFIG_CRANIUM_GOLDEN_SHA256) - 1,
		       pin.sha256, sizeof(pin.sha256)) == sizeof(pin.sha256);
}

/*
 * What an area holds: an image with a good signature, its size, version and hash TLV. False when it
 * holds no such image.
 */
static bool image_read(struct boot_loader_state *state, const struct flash_area *area,
		       struct golden_running *image)
{
	static uint8_t tmp[256];
	struct image_header header;
	struct image_tlv_iter iter;
	FIH_DECLARE(rc, FIH_FAILURE);

	memset(image, 0, sizeof(*image));

	/* Validating takes seconds and does not feed the watchdog by itself. */
	MCUBOOT_WATCHDOG_FEED();

	if (boot_image_load_header(area, &header) != 0 || header.ih_magic != IMAGE_MAGIC ||
	    bootutil_tlv_iter_begin(&iter, &header, area, IMAGE_TLV_ANY, false) != 0) {
		return false;
	}

	FIH_CALL(bootutil_img_validate, rc, state, &header, area, tmp, sizeof(tmp), NULL, 0,
		 image->sha256);
	if (FIH_NOT_EQ(rc, FIH_SUCCESS)) {
		return false;
	}

	image->valid = true;
	image->size = iter.tlv_end;
	image->version.major = header.ih_ver.iv_major;
	image->version.minor = header.ih_ver.iv_minor;
	image->version.revision = header.ih_ver.iv_revision;
	image->version.build = header.ih_ver.iv_build_num;
	return true;
}

/* The bytes in this area are the pinned image, and carry a good signature. */
static bool matches_pin(struct boot_loader_state *state, const struct flash_area *area)
{
	struct golden_running image;
	FIH_DECLARE(rc, FIH_FAILURE);

	/* A file of another size cannot be the pinned image. */
	if (!image_read(state, area, &image) || image.size != pin.size) {
		return false;
	}

	FIH_CALL(boot_fih_memequal, rc, image.sha256, pin.sha256, sizeof(pin.sha256));
	return FIH_EQ(rc, FIH_SUCCESS);
}

/* Erases the golden partition and copies the primary slot's first `size` bytes into it. */
static int copy_to_golden(struct boot_loader_state *state, const struct flash_area *gold,
			  uint32_t size)
{
	const struct flash_area *primary = BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY);

	if (boot_erase_region(gold, 0, flash_area_get_size(gold), false) != 0) {
		return -1;
	}

	return boot_copy_region(state, primary, gold, 0, 0, size);
}

/*
 * The primary slot goes first, in the order golden_erase_steps() gives. Then the secondary slot,
 * so that no pending or leftover image can swap over the pinned one.
 */
static FUNC_NORETURN void restore(struct boot_loader_state *state, const struct flash_area *gold)
{
	const struct flash_area *primary = BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY);
	const struct flash_area *secondary = BOOT_IMG_AREA(state, BOOT_SLOT_SECONDARY);
	struct golden_erase_step steps[GOLDEN_ERASE_STEPS];
	int rc = 0;

	(void)gpio_pin_set_dt(&led, 1);
	BOOT_LOG_INF("golden: restoring the pinned image");

	golden_erase_steps(flash_area_get_size(primary),
			   boot_img_sector_size(state, BOOT_SLOT_PRIMARY, 0), steps);
	for (int i = 0; i < GOLDEN_ERASE_STEPS && rc == 0; i++) {
		rc = boot_erase_region(primary, steps[i].off, steps[i].size, false);
	}

	if (rc != 0 || boot_erase_region(secondary, 0, flash_area_get_size(secondary), false) != 0 ||
	    boot_copy_region(state, gold, primary, 0, 0, pin.size) != 0) {
		BOOT_LOG_ERR("golden: flash error during the restore, restarting");
	} else if (matches_pin(state, primary)) {
		BOOT_LOG_INF("golden: restored, restarting");
	} else {
		BOOT_LOG_ERR("golden: the restored image does not match the pin, restarting");
	}

	sys_reboot(SYS_REBOOT_COLD);
}

static FUNC_NORETURN void seal(struct boot_loader_state *state, const struct flash_area *gold)
{
	(void)gpio_pin_set_dt(&led, 1);
	BOOT_LOG_INF("golden: sealing the running image");

	if (copy_to_golden(state, gold, pin.size) != 0) {
		BOOT_LOG_ERR("golden: flash error while sealing, restarting");
	} else if (matches_pin(state, gold)) {
		BOOT_LOG_INF("golden: sealed, restarting");
	} else {
		BOOT_LOG_ERR("golden: the sealed copy does not match the pin, restarting");
	}

	sys_reboot(SYS_REBOOT_COLD);
}

/*
 * Opens what the gesture and a promotion need: MCUboot's own areas and sectors, and the golden
 * partition. What serial recovery does before it validates an image: bs_list_set() in
 * boot_serial.c. bootutil_img_validate() takes the largest allowed size from the sector layout.
 */
static int areas_open(struct boot_loader_state *state, const struct flash_area **gold)
{
	int rc;

	*gold = NULL;
	boot_state_clear(state);

	/* Closes what it opened if it fails, and a dead external flash ends here. */
	rc = boot_open_all_flash_areas(state);
	if (rc != 0) {
		boot_state_clear(state);
		return rc;
	}

	rc = boot_read_sectors(state, NULL);
	if (rc == 0) {
		rc = flash_area_open(PARTITION_ID(golden_partition), gold);
	}

	if (rc != 0) {
		*gold = NULL;
		boot_close_all_flash_areas(state);
		boot_state_clear(state);
	}

	return rc;
}

static void areas_close(struct boot_loader_state *state, const struct flash_area *gold)
{
	if (gold != NULL) {
		flash_area_close(gold);
	}

	boot_close_all_flash_areas(state);
	boot_state_clear(state);
}

#if defined(CRANIUM_GOLDEN_PROMOTE)

static const struct device *const ext = PARTITION_DEVICE(golden_partition);
static uint8_t request[GOLDEN_RECORD_SIZE];

/* The request sector holds a record that has no answer yet. One read of each in the usual case. */
static bool request_pending(void)
{
	uint32_t word;

	return device_is_ready(ext) &&
	       flash_read(ext, GOLDEN_REQUEST_OFFSET + GOLDEN_STATUS_OFFSET, &word, sizeof(word)) == 0 &&
	       golden_status_from_word(word) == GOLDEN_STATUS_PENDING &&
	       flash_read(ext, GOLDEN_REQUEST_OFFSET, request, sizeof(request)) == 0 &&
	       !golden_erased(request, sizeof(request));
}

/* ECDSA P-256 with SHA-256 over the record's signed bytes, with the golden public key. */
static bool record_signature_ok(const struct golden_record *record)
{
	bootutil_sha_context sha;
	uint8_t hash[32];
	uint8_t rs[64];

	if (!golden_der_signature(record->sig, record->sig_len, rs)) {
		return false;
	}

	bootutil_sha_init(&sha);
	bootutil_sha_update(&sha, request, GOLDEN_RECORD_SIGNED);
	bootutil_sha_finish(&sha, hash);
	bootutil_sha_drop(&sha);

	return uECC_verify(golden_promote_key, hash, sizeof(hash), rs, uECC_secp256r1()) ==
	       TC_CRYPTO_SUCCESS;
}

/* Confirmed: a trailer that says so, or none at all, which nothing can revert. */
static bool primary_confirmed(struct boot_loader_state *state)
{
	struct boot_swap_state swap;

	if (boot_read_swap_state(BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY), &swap) != 0) {
		return false;
	}

	if (swap.magic == BOOT_MAGIC_UNSET) {
		return true;
	}

	return swap.magic == BOOT_MAGIC_GOOD && swap.image_ok == BOOT_FLAG_SET;
}

static void answer(enum golden_status status)
{
	uint32_t word = golden_status_word(status);

	if (flash_write(ext, GOLDEN_REQUEST_OFFSET + GOLDEN_STATUS_OFFSET, &word, sizeof(word)) != 0) {
		BOOT_LOG_ERR("golden: the answer to the promotion could not be written");
	}
}

/* Appends the pin to the state page at `next`, erasing the page first when it is full. */
static int pin_store(const struct golden_pin *promoted, size_t next)
{
	const struct flash_area *boot;
	uint8_t entry[GOLDEN_STATE_ENTRY_SIZE];
	size_t base;
	int rc = 0;

	if (flash_area_open(PARTITION_ID(boot_partition), &boot) != 0) {
		return -1;
	}

	base = flash_area_get_size(boot) - STATE_PAGE_SIZE;
	if (next + sizeof(entry) > STATE_PAGE_SIZE) {
		rc = flash_area_erase(boot, base, STATE_PAGE_SIZE);
		next = 0;
	}

	golden_state_entry_encode(promoted, entry);
	/* The magic last: an entry cut off before it does not count. */
	if (rc == 0) {
		rc = flash_area_write(boot, base + next, entry, sizeof(entry) - 4);
	}
	if (rc == 0) {
		rc = flash_area_write(boot, base + next + sizeof(entry) - 4, entry + sizeof(entry) - 4,
				      4);
	}

	flash_area_close(boot);
	if (rc == 0) {
		pin = *promoted;
	}

	return rc;
}

/* A copy of the record that is golden now, for the application to report. */
static void info_write(void)
{
	if (flash_erase(ext, GOLDEN_INFO_OFFSET, GOLDEN_EXT_SECTOR) != 0 ||
	    flash_write(ext, GOLDEN_INFO_OFFSET, request, sizeof(request)) != 0) {
		BOOT_LOG_WRN("golden: the info sector could not be written");
	}
}

/*
 * The record request_pending() found. Returns only when no image area was written: after a seal
 * it restarts.
 */
static void promote(struct boot_loader_state *state, const struct flash_area *gold, size_t next)
{
	struct golden_record record;
	struct golden_running running;
	enum golden_status status;

	BOOT_LOG_INF("golden: a promotion record is waiting");
	if (!golden_record_parse(request, sizeof(request), &record)) {
		BOOT_LOG_ERR("golden: promotion refused, bad_record");
		answer(GOLDEN_STATUS_BAD_RECORD);
		return;
	}

	/* Sealed and pinned already, and cut off before the answer: finish that. */
	if (golden_pin_equal(&record.pin, &pin) && record_signature_ok(&record)) {
		info_write();
		answer(GOLDEN_STATUS_SEALED);
		return;
	}

	(void)image_read(state, BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY), &running);
	running.confirmed = primary_confirmed(state);
	status = golden_promote_decide(&record, record_signature_ok(&record), pin.counter, &running);
	if (status != GOLDEN_STATUS_SEALED) {
		BOOT_LOG_ERR("golden: promotion refused, %s", golden_status_name(status));
		answer(status);
		return;
	}

	(void)gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
	BOOT_LOG_INF("golden: promoting %u.%u.%u+%u, counter %u", record.pin.version.major,
		     record.pin.version.minor, record.pin.version.revision, record.pin.version.build,
		     record.pin.counter);

	/*
	 * The copy first, then the pin. Cut off in between, the copy is not the pin yet, so the gesture
	 * leaves it alone, and the request is still pending: the next boot does it again.
	 */
	if (copy_to_golden(state, gold, record.pin.size) != 0) {
		BOOT_LOG_ERR("golden: flash error while sealing the promotion");
		answer(GOLDEN_STATUS_FLASH_ERROR);
	} else if (!image_read(state, gold, &running) || running.size != record.pin.size ||
		   memcmp(running.sha256, record.pin.sha256, GOLDEN_HASH_SIZE) != 0) {
		BOOT_LOG_ERR("golden: the sealed copy does not match the promotion");
		answer(GOLDEN_STATUS_FLASH_ERROR);
	} else if (pin_store(&record.pin, next) != 0) {
		BOOT_LOG_ERR("golden: the new pin could not be stored");
		answer(GOLDEN_STATUS_FLASH_ERROR);
	} else {
		info_write();
		answer(GOLDEN_STATUS_SEALED);
		BOOT_LOG_INF("golden: promoted and sealed, restarting");
	}

	sys_reboot(SYS_REBOOT_COLD);
}

#else

static bool request_pending(void)
{
	return false;
}

#endif /* CRANIUM_GOLDEN_PROMOTE */

static void golden_act(struct boot_loader_state *state, const struct flash_area *gold)
{
	bool primary_ok;
	bool golden_ok;

	primary_ok = matches_pin(state, BOOT_IMG_AREA(state, BOOT_SLOT_PRIMARY));
	golden_ok = matches_pin(state, gold);
	BOOT_LOG_INF("golden: primary slot %s the pin, golden copy %s it",
		     primary_ok ? "matches" : "does not match",
		     golden_ok ? "matches" : "does not match");

	/* Nothing has been erased up to here. */
	switch (golden_decide(primary_ok, golden_ok)) {
	case GOLDEN_ACTION_RESTORE:
		restore(state, gold);
	case GOLDEN_ACTION_SEAL:
		seal(state, gold);
	case GOLDEN_ACTION_NOTHING:
		BOOT_LOG_INF("golden: nothing to do");
		blink(TIMES_NOTHING);
		break;
	default:
		BOOT_LOG_ERR("golden: refused, neither copy is the pinned image");
		blink(TIMES_REFUSED);
		break;
	}
}

void mcuboot_status_change(mcuboot_status_type_t status)
{
	struct boot_loader_state *state = boot_get_loader_state();
	const struct flash_area *gold;
	bool fired;
	bool pending;
	size_t next;
	int rc;

	if (status != MCUBOOT_STATUS_STARTUP || !gpio_is_ready_dt(&button) ||
	    !gpio_is_ready_dt(&led)) {
		return;
	}

	fired = gesture_fired();
	pending = request_pending();
	if (!fired && !pending) {
		/* The usual boot. */
		pins_release();
		return;
	}

	if (!pin_load(&next)) {
		BOOT_LOG_ERR("golden: refused, the pin cannot be read");
	} else if ((rc = areas_open(state, &gold)) != 0) {
		BOOT_LOG_ERR("golden: refused, flash layout: %d", rc);
	} else {
#if defined(CRANIUM_GOLDEN_PROMOTE)
		/* Before the gesture's action: a restore then uses the pin a promotion has just set. */
		if (pending) {
			promote(state, gold, next);
		}
#endif
		if (fired) {
			golden_act(state, gold);
		}

		areas_close(state, gold);
		pins_release();
		return;
	}

	if (fired) {
		blink(TIMES_REFUSED);
	}
	pins_release();
}
