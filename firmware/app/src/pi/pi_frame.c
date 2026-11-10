/*
 * The frames of the SPI link from the Raspberry Pi: see pi_frame.h.
 */

#include "pi_frame.h"

#include <stdbool.h>
#include <string.h>

uint32_t pi_crc32(const uint8_t *data, size_t length)
{
	uint32_t crc = 0xffffffffu;

	for (size_t i = 0; i < length; i++) {
		crc ^= data[i];
		for (int bit = 0; bit < 8; bit++) {
			crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
		}
	}
	return ~crc;
}

static void put16(uint8_t *at, uint16_t value)
{
	at[0] = (uint8_t)value;
	at[1] = (uint8_t)(value >> 8);
}

static uint16_t get16(const uint8_t *at)
{
	return (uint16_t)(at[0] | (at[1] << 8));
}

size_t pi_frame_encode(uint8_t *buf, size_t size, const struct pi_frame *frame)
{
	size_t used = PI_FRAME_HEADER + (size_t)frame->length + PI_FRAME_CRC;
	uint32_t crc;

	if (frame->length > PI_FRAME_PAYLOAD_MAX || size < used ||
	    (frame->length > 0 && frame->payload == NULL)) {
		return 0;
	}

	buf[0] = 'C';
	buf[1] = 'L';
	buf[2] = PI_FRAME_VERSION;
	buf[3] = frame->type;
	put16(buf + 4, frame->session);
	put16(buf + 6, frame->seq);
	put16(buf + 8, frame->ack);
	put16(buf + 10, frame->length);
	if (frame->length > 0) {
		memcpy(buf + PI_FRAME_HEADER, frame->payload, frame->length);
	}
	crc = pi_crc32(buf, PI_FRAME_HEADER + (size_t)frame->length);
	buf[used - 4] = (uint8_t)crc;
	buf[used - 3] = (uint8_t)(crc >> 8);
	buf[used - 2] = (uint8_t)(crc >> 16);
	buf[used - 1] = (uint8_t)(crc >> 24);
	return used;
}

static bool all_the_same(const uint8_t *buf, size_t length, uint8_t value)
{
	for (size_t i = 0; i < length; i++) {
		if (buf[i] != value) {
			return false;
		}
	}
	return true;
}

enum pi_frame_result pi_frame_decode(const uint8_t *buf, size_t received, struct pi_frame *frame)
{
	uint16_t length;
	uint32_t crc;
	size_t end;

	if (received == 0 || all_the_same(buf, received, 0x00) || all_the_same(buf, received, 0xff)) {
		return PI_FRAME_NOTHING;
	}
	if (received < PI_FRAME_HEADER + PI_FRAME_CRC || buf[0] != 'C' || buf[1] != 'L') {
		return PI_FRAME_BAD_MAGIC;
	}
	if (buf[2] != PI_FRAME_VERSION) {
		return PI_FRAME_BAD_VERSION;
	}
	length = get16(buf + 10);
	end = PI_FRAME_HEADER + (size_t)length;
	if (length > PI_FRAME_PAYLOAD_MAX || end + PI_FRAME_CRC > received) {
		return PI_FRAME_BAD_LENGTH;
	}
	crc = (uint32_t)buf[end] | ((uint32_t)buf[end + 1] << 8) | ((uint32_t)buf[end + 2] << 16) |
	      ((uint32_t)buf[end + 3] << 24);
	if (crc != pi_crc32(buf, end)) {
		return PI_FRAME_BAD_CRC;
	}

	frame->type = buf[3];
	frame->session = get16(buf + 4);
	frame->seq = get16(buf + 6);
	frame->ack = get16(buf + 8);
	frame->length = length;
	frame->payload = buf + PI_FRAME_HEADER;
	return PI_FRAME_OK;
}
