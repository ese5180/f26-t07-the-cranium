/*
 * BDX, the Bulk Data Exchange protocol (Matter specification 11.21), as the sending side of a transfer the
 * receiver drives: how an OTA requestor downloads an image from this board. Message bodies only.
 */
#ifndef MT_BDX_H_
#define MT_BDX_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_BDX_RECEIVE_INIT   0x04u
#define MT_BDX_RECEIVE_ACCEPT 0x05u
#define MT_BDX_BLOCK_QUERY    0x10u
#define MT_BDX_BLOCK          0x11u
#define MT_BDX_BLOCK_EOF      0x12u
#define MT_BDX_BLOCK_ACK      0x13u
#define MT_BDX_BLOCK_ACK_EOF  0x14u
#define MT_BDX_BLOCK_QUERY_SKIP 0x15u

#define MT_BDX_RECEIVER_DRIVE 0x20u

struct mt_bdx_init {
	uint8_t transfer_control; /* version in the low 4 bits, modes in the high */
	uint16_t max_block_size;
	uint64_t start_offset;
	uint64_t max_length;
	const uint8_t *file_designator;
	uint16_t file_designator_len;
};

bool mt_bdx_parse_init(const uint8_t *in, size_t len, struct mt_bdx_init *out);
/* ReceiveAccept: version 0, receiver drive, the block size and the length of the whole transfer. */
size_t mt_bdx_receive_accept(uint8_t *out, uint16_t max_block_size, uint64_t length);
/* BlockQuery, BlockAck, BlockAckEOF: a 4-byte counter. */
bool mt_bdx_parse_counter(const uint8_t *in, size_t len, uint32_t *counter);
/* BlockQueryWithSkip: counter and bytes to skip. */
bool mt_bdx_parse_query_skip(const uint8_t *in, size_t len, uint32_t *counter, uint64_t *skip);
/* Block and BlockEOF: the counter, then the data (written by the caller after the 4 bytes). */
size_t mt_bdx_block_header(uint8_t *out, uint32_t counter);

#ifdef __cplusplus
}
#endif

#endif /* MT_BDX_H_ */
