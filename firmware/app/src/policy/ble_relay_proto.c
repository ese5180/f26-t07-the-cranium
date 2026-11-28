#include "ble_relay_proto.h"

#include <string.h>

/* strlen, up to max + 1: strnlen is POSIX, not C11, and the host tests build as C11. */
static size_t bounded_len(const char *text, size_t max)
{
	size_t len = 0;

	while (len <= max && text[len] != '\0') {
		len++;
	}
	return len;
}

void ble_relay_header(uint8_t type, uint16_t len, uint8_t out[BLE_RELAY_HEADER_LEN])
{
	out[0] = type;
	out[1] = (uint8_t)(len & 0xff);
	out[2] = (uint8_t)(len >> 8);
}

int ble_relay_hello(uint16_t data_max, const char *thing_name, uint8_t *out, size_t size)
{
	size_t name_len = bounded_len(thing_name, BLE_RELAY_NAME_MAX);
	size_t payload = 4 + name_len;

	if (name_len > BLE_RELAY_NAME_MAX || size < BLE_RELAY_HEADER_LEN + payload) {
		return -1;
	}

	ble_relay_header(BLE_RELAY_HELLO, (uint16_t)payload, out);
	out[3] = BLE_RELAY_VERSION;
	/* Flags: none yet. A phone ignores the bits it does not know. */
	out[4] = 0;
	out[5] = (uint8_t)(data_max & 0xff);
	out[6] = (uint8_t)(data_max >> 8);
	memcpy(&out[7], thing_name, name_len);
	return (int)(BLE_RELAY_HEADER_LEN + payload);
}

int ble_relay_open(const char *host, uint16_t port, uint8_t *out, size_t size)
{
	size_t host_len = bounded_len(host, BLE_RELAY_HOST_MAX);
	size_t payload = 2 + host_len;

	if (host_len == 0 || host_len > BLE_RELAY_HOST_MAX || size < BLE_RELAY_HEADER_LEN + payload) {
		return -1;
	}

	ble_relay_header(BLE_RELAY_OPEN, (uint16_t)payload, out);
	out[3] = (uint8_t)(port & 0xff);
	out[4] = (uint8_t)(port >> 8);
	memcpy(&out[5], host, host_len);
	return (int)(BLE_RELAY_HEADER_LEN + payload);
}

int ble_relay_close(uint8_t reason, uint8_t *out)
{
	ble_relay_header(BLE_RELAY_CLOSE, 1, out);
	out[3] = reason;
	return BLE_RELAY_HEADER_LEN + 1;
}

void ble_relay_reader_init(struct ble_relay_reader *reader, uint16_t data_max)
{
	memset(reader, 0, sizeof(*reader));
	reader->data_max = data_max;
}

/* The most a control frame of this type may carry here, or -1 for a type to skip. */
static int control_max(uint8_t type)
{
	switch (type) {
	case BLE_RELAY_OPENED:
		return 0;
	case BLE_RELAY_CLOSE:
		return 1;
	/* What only the board sends: from a phone it is nonsense. */
	case BLE_RELAY_HELLO:
	case BLE_RELAY_OPEN:
		return BLE_RELAY_CONTROL_MAX;
	default:
		return -1;
	}
}

size_t ble_relay_read(struct ble_relay_reader *reader, const uint8_t *in, size_t len,
		      struct ble_relay_item *item)
{
	size_t used = 0;

	memset(item, 0, sizeof(*item));

	if (reader->failed) {
		item->kind = BLE_RELAY_ITEM_ERROR;
		return len;
	}

	while (used < len) {
		if (reader->have < BLE_RELAY_HEADER_LEN) {
			reader->header[reader->have++] = in[used++];
			if (reader->have < BLE_RELAY_HEADER_LEN) {
				continue;
			}

			reader->type = reader->header[0];
			reader->length = (uint16_t)(reader->header[1] | (reader->header[2] << 8));
			reader->left = reader->length;

			if (reader->length > BLE_RELAY_PAYLOAD_MAX ||
			    (reader->type == BLE_RELAY_DATA && reader->length > reader->data_max) ||
			    (control_max(reader->type) >= 0 &&
			     reader->length > control_max(reader->type))) {
				reader->failed = true;
				item->kind = BLE_RELAY_ITEM_ERROR;
				return len;
			}

			/* An empty DATA frame says nothing; any other empty frame is whole now. */
			if (reader->left == 0) {
				reader->have = 0;
				if (reader->type != BLE_RELAY_DATA && control_max(reader->type) >= 0) {
					item->kind = BLE_RELAY_ITEM_FRAME;
					item->type = reader->type;
					item->data = reader->control;
					return used;
				}
			}
			continue;
		}

		if (reader->type == BLE_RELAY_DATA) {
			size_t take = len - used < reader->left ? len - used : reader->left;

			item->kind = BLE_RELAY_ITEM_DATA;
			item->type = BLE_RELAY_DATA;
			item->data = &in[used];
			item->len = take;
			used += take;
			reader->left -= (uint16_t)take;
			if (reader->left == 0) {
				reader->have = 0;
			}
			return used;
		}

		if (control_max(reader->type) < 0) {
			/* Not ours to read: skipped. */
			size_t skip = len - used < reader->left ? len - used : reader->left;

			used += skip;
			reader->left -= (uint16_t)skip;
			if (reader->left == 0) {
				reader->have = 0;
			}
			continue;
		}

		reader->control[reader->length - reader->left] = in[used++];
		reader->left--;
		if (reader->left == 0) {
			reader->have = 0;
			item->kind = BLE_RELAY_ITEM_FRAME;
			item->type = reader->type;
			item->data = reader->control;
			item->len = reader->length;
			return used;
		}
	}

	return used;
}
