/*
 * The Matter message layer (Matter specification 4.4): the message header in clear, the protocol header inside
 * the (possibly encrypted) payload, and the nonce for AES-CCM. Encryption itself is mt_session.c's, through PSA.
 */
#ifndef MT_MSG_H_
#define MT_MSG_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_PROTO_SECURE_CHANNEL 0x0000u
#define MT_PROTO_IM             0x0001u
#define MT_PROTO_BDX            0x0002u

/* Secure channel opcodes */
#define MT_SC_STANDALONE_ACK 0x10u
#define MT_SC_PBKDF_REQ      0x20u
#define MT_SC_PBKDF_RESP     0x21u
#define MT_SC_PAKE1          0x22u
#define MT_SC_PAKE2          0x23u
#define MT_SC_PAKE3          0x24u
#define MT_SC_SIGMA1         0x30u
#define MT_SC_SIGMA2         0x31u
#define MT_SC_SIGMA3         0x32u
#define MT_SC_STATUS_REPORT  0x40u

/* Exchange flags */
#define MT_EX_INITIATOR   0x01u
#define MT_EX_ACK         0x02u
#define MT_EX_RELIABLE    0x04u

#define MT_MIC_LEN   16
#define MT_NONCE_LEN 13

struct mt_msg_header {
	uint16_t session_id;
	uint8_t security_flags; /* session type in bits 0-1: 0 unicast */
	uint32_t counter;
	bool has_source;
	uint64_t source_node;
	bool has_dest;
	uint64_t dest_node;
};

struct mt_proto_header {
	uint8_t exchange_flags;
	uint8_t opcode;
	uint16_t exchange_id;
	uint16_t protocol_id;
	bool has_ack;
	uint32_t ack_counter;
};

/* Encodes the message header; returns its length, or 0 if cap is too small. */
size_t mt_msg_encode_header(const struct mt_msg_header *h, uint8_t *out, size_t cap);
/* Decodes it; returns its length, or 0 if malformed. */
size_t mt_msg_decode_header(const uint8_t *in, size_t len, struct mt_msg_header *h);
size_t mt_msg_encode_proto(const struct mt_proto_header *p, uint8_t *out, size_t cap);
size_t mt_msg_decode_proto(const uint8_t *in, size_t len, struct mt_proto_header *p);
/* The AES-CCM nonce: security flags, counter, source node ID (0 when there is none). */
void mt_msg_nonce(const struct mt_msg_header *h, uint64_t source_node, uint8_t nonce[MT_NONCE_LEN]);

/* A received message counter against a window of 32 behind the largest seen (4.6.5). */
struct mt_counter_window {
	bool initialised;
	uint32_t max;
	uint32_t bitmap; /* bit i: max - 1 - i was seen */
};

/* True if the counter is new (and records it); false for a duplicate or one too old. */
bool mt_counter_accept(struct mt_counter_window *w, uint32_t counter);

/* A StatusReport body: general code, protocol, protocol code. */
size_t mt_status_report(uint8_t *out, uint16_t general, uint32_t protocol, uint16_t code);
bool mt_status_report_parse(const uint8_t *in, size_t len, uint16_t *general, uint32_t *protocol,
			    uint16_t *code);

#ifdef __cplusplus
}
#endif

#endif /* MT_MSG_H_ */
