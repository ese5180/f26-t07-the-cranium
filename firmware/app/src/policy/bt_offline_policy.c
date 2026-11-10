#include "bt_offline_policy.h"

#include <string.h>

#include "bt_passkey_policy.h"

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

void bt_offline_encode(const struct bt_offline_status *status, uint8_t out[BT_OFFLINE_LEN])
{
	memset(out, 0, BT_OFFLINE_LEN);

	out[0] = BT_OFFLINE_FORMAT;
	out[1] = (uint8_t)status->wifi;
	out[2] = (uint8_t)status->cloud;
	out[3] = (uint8_t)status->update;
	out[4] = status->reboot;
	out[6] = status->running.major;
	out[7] = status->running.minor;
	put16(out + 8, status->running.revision);
	put32(out + 10, status->running.build);
	put32(out + 14, status->uptime_seconds);
	if (status->update == BT_OFFLINE_UPDATE_BT_WAITING) {
		out[18] = status->waiting.major;
		out[19] = status->waiting.minor;
	}
}

enum bt_offline_verdict bt_offline_accept_check(const uint8_t *data, size_t len, bool update_waiting,
						const struct bt_offline_version *waiting)
{
	if (data == NULL || len != BT_OFFLINE_ACCEPT_LEN || data[0] != BT_OFFLINE_OP_ACCEPT) {
		return BT_OFFLINE_ACCEPT_MALFORMED;
	}

	if (!update_waiting || waiting == NULL) {
		return BT_OFFLINE_ACCEPT_NOTHING_WAITING;
	}

	if (data[1] != waiting->major || data[2] != waiting->minor) {
		return BT_OFFLINE_ACCEPT_VERSION_MISMATCH;
	}

	return BT_OFFLINE_ACCEPT_OK;
}

bool bt_offline_passkey_from_random(const uint32_t *words, size_t n, uint32_t *passkey, uint16_t *tag)
{
	/* The largest multiple of a million in 32 bits: a word above it would favour small passkeys. */
	const uint32_t limit = 4294000000U;

	if (words == NULL || passkey == NULL || tag == NULL || n < 2) {
		return false;
	}

	for (size_t i = 0; i + 1 < n; i++) {
		uint32_t candidate = words[i] % 1000000U;

		if (words[i] >= limit || bt_passkey_weak(candidate)) {
			continue;
		}

		*passkey = candidate;
		*tag = (uint16_t)words[i + 1];
		return true;
	}

	return false;
}
