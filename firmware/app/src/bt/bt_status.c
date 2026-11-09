#include "bt_status.h"

#include <string.h>

#define AT_SECONDS_LEFT 2
#define AT_IMAGE_BYTES  6
#define AT_UPTIME       58

static void put16(uint8_t *at, uint16_t value)
{
	at[0] = (uint8_t)value;
	at[1] = (uint8_t)(value >> 8);
}

static void put32(uint8_t *at, uint32_t value)
{
	put16(at, (uint16_t)value);
	put16(at + 2, (uint16_t)(value >> 16));
}

static void put_version(uint8_t *at, const struct fw_version *version)
{
	at[0] = version->major;
	at[1] = version->minor;
	put16(at + 2, version->revision);
	put32(at + 4, version->build);
}

void bt_status_encode(const struct bt_status *status, uint8_t out[BT_STATUS_LEN])
{
	memset(out, 0, BT_STATUS_LEN);

	out[0] = BT_STATUS_FORMAT;
	out[1] = (uint8_t)status->window;
	put16(out + AT_SECONDS_LEFT, status->seconds_left);
	out[4] = (uint8_t)status->image;
	out[5] = (uint8_t)status->refusal;
	put32(out + AT_IMAGE_BYTES, status->image_bytes);
	put_version(out + 10, &status->image_version);
	out[18] = (uint8_t)status->result;
	out[19] = status->closed;
	put_version(out + 20, &status->running);
	out[28] = (uint8_t)((status->on_trial ? 1U : 0U) | (((unsigned int)status->swap & 7U) << 1));
	out[29] = (uint8_t)status->last_via;
	out[30] = (uint8_t)status->last_outcome;
	out[31] = (uint8_t)status->last_proof;
	put_version(out + 32, &status->last_target);
	put_version(out + 40, &status->last_from);
	memcpy(out + 48, status->last_hash, BT_STATUS_HASH_LEN);
	put16(out + 56, status->last_count);
	put32(out + AT_UPTIME, status->uptime_seconds);
}

bool bt_status_news(const uint8_t a[BT_STATUS_LEN], const uint8_t b[BT_STATUS_LEN])
{
	for (size_t i = 0; i < BT_STATUS_LEN; i++) {
		bool counts_by_itself = (i >= AT_SECONDS_LEFT && i < AT_SECONDS_LEFT + 2) ||
					(i >= AT_IMAGE_BYTES && i < AT_IMAGE_BYTES + 4) ||
					(i >= AT_UPTIME && i < AT_UPTIME + 4);

		if (!counts_by_itself && a[i] != b[i]) {
			return true;
		}
	}

	return false;
}
