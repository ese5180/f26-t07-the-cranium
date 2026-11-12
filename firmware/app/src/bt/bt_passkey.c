#include "bt_passkey.h"

#include <errno.h>
#include <string.h>

#include <psa/protected_storage.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

#include "bt_ota_policy.h"
#include "console.h"

LOG_MODULE_REGISTER(bt_passkey, CONFIG_APP_LOG_LEVEL);

/*
 * "CRAN" in the upper half, as store.c's records in internal trusted storage. Protected storage has
 * UIDs of its own: this is its only record from this firmware.
 */
#define PASSKEY_UID ((psa_storage_uid_t)0x4352414e00000101ULL)

/* The main loop's. No passkey in it: that is read for a window and wiped after. */
static struct bt_passkey_record kept;
static bool have_record;
static uint32_t failures_written;
static atomic_t state = ATOMIC_INIT(BT_PASSKEY_STATE_NONE);

/* What the Bluetooth threads see. 0 is a passkey too, so this holds the passkey plus one. */
static atomic_t window_passkey;
static atomic_t failures;

static void wipe(struct bt_passkey_record *record)
{
	volatile uint8_t *bytes = (volatile uint8_t *)record;

	for (size_t i = 0; i < sizeof(*record); i++) {
		bytes[i] = 0;
	}
}

static int read_record(struct bt_passkey_record *out)
{
	size_t read = 0;
	psa_status_t status = psa_ps_get(PASSKEY_UID, 0, sizeof(*out), out, &read);

	if (status == PSA_ERROR_DOES_NOT_EXIST) {
		return -ENOENT;
	}

	if (status != PSA_SUCCESS) {
		LOG_ERR("The passkey could not be read: %d", (int)status);
		return -EIO;
	}

	return read == sizeof(*out) && bt_passkey_record_valid(out) ? 0 : -EBADMSG;
}

static int write_record(const struct bt_passkey_record *record)
{
	psa_status_t status = psa_ps_set(PASSKEY_UID, sizeof(*record), record, PSA_STORAGE_FLAG_NONE);

	if (status != PSA_SUCCESS) {
		LOG_ERR("The passkey could not be written: %d", (int)status);
		return -EIO;
	}

	return 0;
}

static void set_state(enum bt_passkey_state now)
{
	(void)atomic_set(&state, (atomic_val_t)now);
}

static void say_locked(void)
{
	console_event("BT", "the board's passkey failed %u times and is not used any more: each pairing "
			    "shows a new passkey here until a new one is stored",
		      (unsigned int)atomic_get(&failures));
}

void bt_passkey_init(void)
{
	struct bt_passkey_record stored;
	int err = read_record(&stored);

	have_record = false;
	(void)atomic_set(&window_passkey, 0);

	if (err == -ENOENT) {
		LOG_INF("No passkey of the board's own is stored: each pairing shows a new one");
		set_state(BT_PASSKEY_STATE_NONE);
		return;
	}

	if (err != 0) {
		/* -EIO: protected storage answered with an error; -EBADMSG: the record is not one. */
		LOG_WRN("The board's passkey is stored but not usable: %d", err);
		wipe(&stored);
		set_state(BT_PASSKEY_STATE_UNREADABLE);
		console_event("BT", "the board's passkey cannot be read: each pairing shows a new passkey here");
		return;
	}

	kept = stored;
	kept.passkey = 0;
	wipe(&stored);
	have_record = true;
	failures_written = kept.failures;
	(void)atomic_set(&failures, (atomic_val_t)kept.failures);

	if (bt_passkey_locked(kept.failures, CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET)) {
		set_state(BT_PASSKEY_STATE_LOCKED);
		say_locked();
	} else {
		set_state(BT_PASSKEY_STATE_SET);
		LOG_INF("The board's passkey is stored, %u failures", (unsigned int)kept.failures);
	}
}

enum bt_passkey_state bt_passkey_state(void)
{
	return (enum bt_passkey_state)atomic_get(&state);
}

const char *bt_passkey_state_name(enum bt_passkey_state now)
{
	switch (now) {
	case BT_PASSKEY_STATE_SET:
		return "set";
	case BT_PASSKEY_STATE_LOCKED:
		return "locked";
	case BT_PASSKEY_STATE_UNREADABLE:
		return "unreadable";
	default:
		return "unset";
	}
}

uint32_t bt_passkey_failures(void)
{
	return (uint32_t)atomic_get(&failures);
}

bool bt_passkey_tag(uint16_t *tag)
{
	/* Only while a phone can pair with it: the console knows the passkey by this name. */
	if (!have_record || bt_passkey_state() != BT_PASSKEY_STATE_SET) {
		return false;
	}

	*tag = kept.tag;
	return true;
}

void bt_passkey_window_open(void)
{
	struct bt_passkey_record stored;

	(void)atomic_set(&window_passkey, 0);

	if (bt_passkey_state() != BT_PASSKEY_STATE_SET) {
		return;
	}

	/* Read again, and not kept since the boot: then it is in memory only while a window is open. */
	if (read_record(&stored) != 0 || stored.tag != kept.tag) {
		wipe(&stored);
		set_state(BT_PASSKEY_STATE_UNREADABLE);
		console_event("BT", "the board's passkey cannot be read: this window shows a new passkey "
				    "here for each pairing");
		return;
	}

	(void)atomic_set(&window_passkey, (atomic_val_t)stored.passkey + 1);
	wipe(&stored);
}

void bt_passkey_window_close(void)
{
	(void)atomic_set(&window_passkey, 0);
}

uint32_t bt_passkey_for_pairing(uint32_t window_failures)
{
	atomic_val_t held = atomic_get(&window_passkey);
	struct bt_passkey_record view = { .magic = BT_PASSKEY_RECORD_MAGIC };
	uint32_t passkey;

	if (held == 0) {
		return BT_PASSKEY_NONE;
	}

	view.passkey = (uint32_t)held - 1U;
	passkey = bt_passkey_choose(&view, (uint32_t)atomic_get(&failures),
				    CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET, window_failures,
				    BT_OTA_MAX_FAILED_PAIRINGS);
	wipe(&view);
	return passkey;
}

void bt_passkey_count_failure(void)
{
	(void)atomic_inc(&failures);
}

bool bt_passkey_persist(void)
{
	struct bt_passkey_record stored;
	uint32_t now = (uint32_t)atomic_get(&failures);
	bool written = false;

	if (!have_record || now == failures_written) {
		return false;
	}

	/* If this fails the count stays in memory, and holds until the board restarts. */
	if (read_record(&stored) == 0 && stored.tag == kept.tag) {
		stored.failures = now;
		written = write_record(&stored) == 0;
	}
	wipe(&stored);

	if (written) {
		failures_written = now;
		kept.failures = now;
	}

	if (bt_passkey_state() == BT_PASSKEY_STATE_SET &&
	    bt_passkey_locked(now, CONFIG_APP_BT_PASSKEY_FAILURE_BUDGET)) {
		(void)atomic_set(&window_passkey, 0);
		set_state(BT_PASSKEY_STATE_LOCKED);
		say_locked();
		return true;
	}

	return false;
}

int bt_passkey_store(uint32_t passkey, uint16_t tag)
{
	struct bt_passkey_record fresh = {
		.magic = BT_PASSKEY_RECORD_MAGIC,
		.passkey = passkey,
		.tag = tag,
	};
	int err;

	if (bt_passkey_weak(passkey)) {
		return -EINVAL;
	}

	err = write_record(&fresh);
	wipe(&fresh);
	if (err != 0) {
		return err;
	}

	kept = (struct bt_passkey_record){ .magic = BT_PASSKEY_RECORD_MAGIC, .tag = tag };
	have_record = true;
	failures_written = 0;
	(void)atomic_set(&failures, 0);
	(void)atomic_set(&window_passkey, 0);
	set_state(BT_PASSKEY_STATE_SET);
	return 0;
}

int bt_passkey_erase(void)
{
	psa_status_t status = psa_ps_remove(PASSKEY_UID);

	(void)atomic_set(&window_passkey, 0);
	if (status != PSA_SUCCESS && status != PSA_ERROR_DOES_NOT_EXIST) {
		LOG_ERR("The passkey could not be erased: %d", (int)status);
		return -EIO;
	}

	memset(&kept, 0, sizeof(kept));
	have_record = false;
	failures_written = 0;
	(void)atomic_set(&failures, 0);
	set_state(BT_PASSKEY_STATE_NONE);
	return 0;
}
