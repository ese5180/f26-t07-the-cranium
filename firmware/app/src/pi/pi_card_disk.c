/*
 * The SD card of a Raspberry Pi delta update on a board: see pi_card_disk.h.
 */

#include "pi_card_disk.h"

#include <errno.h>

#include <zephyr/devicetree.h>
#include <zephyr/drivers/disk.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/storage/disk_access.h>

#define DISK_NAME "SD"
#define PI_DELTA_NODE DT_NODELABEL(pi_delta)

BUILD_ASSERT(DT_NODE_EXISTS(PI_DELTA_NODE),
	     "a Pi delta build needs the pi_delta node: boards/pi_delta.overlay");

static const struct gpio_dt_spec card_detect = GPIO_DT_SPEC_GET_OR(PI_DELTA_NODE, cd_gpios, { 0 });
static K_MUTEX_DEFINE(card_lock);
static bool started;

static int card_read(void *ctx, uint64_t lba, uint8_t *buf, uint32_t count)
{
	ARG_UNUSED(ctx);
	if (lba + count > UINT32_MAX) {
		return -EINVAL;
	}
	return disk_access_read(DISK_NAME, buf, (uint32_t)lba, count);
}

static int card_write(void *ctx, uint64_t lba, const uint8_t *buf, uint32_t count)
{
	ARG_UNUSED(ctx);
	if (lba + count > UINT32_MAX) {
		return -EINVAL;
	}
	return disk_access_write(DISK_NAME, buf, (uint32_t)lba, count);
}

static int card_open(void *ctx, uint64_t *sectors)
{
	uint32_t count = 0;
	uint32_t size = 0;
	int err;

	ARG_UNUSED(ctx);
	/* Started again each time, for a card that was taken out and put back in between. */
	if (started) {
		(void)disk_access_ioctl(DISK_NAME, DISK_IOCTL_CTRL_DEINIT, NULL);
		started = false;
	}
	err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_CTRL_INIT, NULL);
	if (err != 0) {
		return err;
	}
	started = true;
	err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_COUNT, &count);
	if (err == 0) {
		err = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_SIZE, &size);
	}
	if (err == 0 && size != PI_SECTOR_SIZE) {
		err = -ENOTSUP;
	}
	*sectors = count;
	return err;
}

static bool card_present(void *ctx)
{
	ARG_UNUSED(ctx);
	if (card_detect.port == NULL) {
		return true;
	}
	return gpio_pin_get_dt(&card_detect) == 1;
}

static void card_lock_take(void *ctx)
{
	ARG_UNUSED(ctx);
	(void)k_mutex_lock(&card_lock, K_FOREVER);
}

static void card_lock_give(void *ctx)
{
	ARG_UNUSED(ctx);
	(void)k_mutex_unlock(&card_lock);
}

int pi_card_disk_lock_within(int32_t wait_ms)
{
	return k_mutex_lock(&card_lock, K_MSEC(wait_ms));
}

const struct pi_disk_ops pi_card_disk_ops = {
	.read = card_read,
	.write = card_write,
	.open = card_open,
	.present = card_present,
	.lock = card_lock_take,
	.unlock = card_lock_give,
};

int pi_card_disk_init(void)
{
	if (card_detect.port == NULL) {
		return 0;
	}
	if (!gpio_is_ready_dt(&card_detect)) {
		return -ENODEV;
	}
	return gpio_pin_configure_dt(&card_detect, GPIO_INPUT);
}
