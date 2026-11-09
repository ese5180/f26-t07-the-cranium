#include "bt_passkey_policy.h"

#include <errno.h>
#include <string.h>

#include <zephyr/sys/printk.h>

bool bt_passkey_weak(uint32_t passkey)
{
	uint8_t digits[BT_PASSKEY_DIGITS];
	bool same = true;
	bool up = true;
	bool down = true;

	if (passkey > BT_PASSKEY_MAX) {
		return true;
	}

	for (int i = BT_PASSKEY_DIGITS - 1; i >= 0; i--) {
		digits[i] = (uint8_t)(passkey % 10U);
		passkey /= 10U;
	}

	for (int i = 1; i < BT_PASSKEY_DIGITS; i++) {
		same = same && digits[i] == digits[0];
		up = up && digits[i] == digits[i - 1] + 1;
		down = down && digits[i] + 1 == digits[i - 1];
	}

	return same || up || down;
}

bool bt_passkey_parse(const char *text, uint32_t *passkey)
{
	uint32_t value = 0;

	if (text == NULL || strlen(text) != BT_PASSKEY_DIGITS) {
		return false;
	}

	for (int i = 0; i < BT_PASSKEY_DIGITS; i++) {
		if (text[i] < '0' || text[i] > '9') {
			return false;
		}
		value = value * 10U + (uint32_t)(text[i] - '0');
	}

	if (bt_passkey_weak(value)) {
		return false;
	}

	*passkey = value;
	return true;
}

bool bt_passkey_parse_tag(const char *text, uint16_t *tag)
{
	uint16_t value = 0;

	if (text == NULL || strlen(text) != BT_PASSKEY_TAG_DIGITS) {
		return false;
	}

	for (int i = 0; i < BT_PASSKEY_TAG_DIGITS; i++) {
		char c = text[i];
		uint16_t digit;

		if (c >= '0' && c <= '9') {
			digit = (uint16_t)(c - '0');
		} else if (c >= 'a' && c <= 'f') {
			digit = (uint16_t)(c - 'a' + 10);
		} else if (c >= 'A' && c <= 'F') {
			digit = (uint16_t)(c - 'A' + 10);
		} else {
			return false;
		}
		value = (uint16_t)((value << 4) | digit);
	}

	*tag = value;
	return true;
}

bool bt_passkey_record_valid(const struct bt_passkey_record *record)
{
	return record->magic == BT_PASSKEY_RECORD_MAGIC && !bt_passkey_weak(record->passkey);
}

bool bt_passkey_locked(uint32_t failures, uint32_t budget)
{
	return failures >= budget;
}

uint32_t bt_passkey_choose(const struct bt_passkey_record *record, uint32_t failures,
			   uint32_t budget, uint32_t window_failures, uint32_t window_max)
{
	if (record == NULL || !bt_passkey_record_valid(record)) {
		return BT_PASSKEY_NONE;
	}

	/*
	 * A window that has had its failures is closing: an attempt that gets in before it has closed
	 * does not get to guess at the stored passkey as well.
	 */
	if (bt_passkey_locked(failures, budget) || window_failures >= window_max) {
		return BT_PASSKEY_NONE;
	}

	return record->passkey;
}

int bt_passkey_name(uint16_t tag, const char *prefix, char *buf, size_t len)
{
	int written = snprintk(buf, len, "%s-%04X", prefix, (unsigned int)tag);

	return written < 0 || (size_t)written >= len ? -ENOSPC : written;
}
