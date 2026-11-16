/* SPDX-License-Identifier: MIT */
#ifndef CRANIUM_PROTOCOL_H
#define CRANIUM_PROTOCOL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define CRANIUM_PAYLOAD_MAX 480
#define CRANIUM_FRAME_MAX 520
enum cranium_result { CRANIUM_OK, CRANIUM_FRAME, CRANIUM_CRC, CRANIUM_DUP };
struct cranium_frame { uint32_t seq; size_t length; char payload[CRANIUM_PAYLOAD_MAX+1]; };
uint16_t cranium_crc(const void *data, size_t length);
enum cranium_result cranium_parse(const char *line, size_t length, struct cranium_frame *out);
bool cranium_sequence_new(uint32_t seq, uint32_t previous, bool initialized);
#endif
