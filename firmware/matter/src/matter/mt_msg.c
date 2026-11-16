/*
 * See mt_msg.h.
 */
#include "mt_msg.h"

#include <string.h>

#define MF_SOURCE   0x04u
#define MF_DSIZ_64  0x01u
#define EF_VENDOR   0x10u
#define EF_SX       0x08u
#define SF_MX       0x20u

static void le(uint8_t *o, uint64_t v, unsigned int n)
{
	for (unsigned int i = 0; i < n; i++) {
		o[i] = (uint8_t)(v >> (8 * i));
	}
}

static uint64_t rd(const uint8_t *i, unsigned int n)
{
	uint64_t v = 0;

	for (unsigned int k = 0; k < n; k++) {
		v |= (uint64_t)i[k] << (8 * k);
	}
	return v;
}

size_t mt_msg_encode_header(const struct mt_msg_header *h, uint8_t *out, size_t cap)
{
	size_t n = 8 + (h->has_source ? 8 : 0) + (h->has_dest ? 8 : 0);

	if (cap < n) {
		return 0;
	}
	out[0] = (uint8_t)((h->has_source ? MF_SOURCE : 0) | (h->has_dest ? MF_DSIZ_64 : 0));
	le(&out[1], h->session_id, 2);
	out[3] = h->security_flags;
	le(&out[4], h->counter, 4);
	size_t k = 8;

	if (h->has_source) {
		le(&out[k], h->source_node, 8);
		k += 8;
	}
	if (h->has_dest) {
		le(&out[k], h->dest_node, 8);
	}
	return n;
}

size_t mt_msg_decode_header(const uint8_t *in, size_t len, struct mt_msg_header *h)
{
	if (len < 8 || (in[0] >> 4) != 0) {
		return 0; /* only message format version 0 */
	}
	uint8_t dsiz = in[0] & 0x03u;
	size_t n = 8;

	memset(h, 0, sizeof(*h));
	h->session_id = (uint16_t)rd(&in[1], 2);
	h->security_flags = in[3];
	h->counter = (uint32_t)rd(&in[4], 4);
	if (in[0] & MF_SOURCE) {
		if (len < n + 8) {
			return 0;
		}
		h->has_source = true;
		h->source_node = rd(&in[n], 8);
		n += 8;
	}
	if (dsiz == 1) {
		if (len < n + 8) {
			return 0;
		}
		h->has_dest = true;
		h->dest_node = rd(&in[n], 8);
		n += 8;
	} else if (dsiz == 2) {
		if (len < n + 2) {
			return 0;
		}
		n += 2; /* a group: a commissioner never receives one */
	} else if (dsiz == 3) {
		return 0;
	}
	if (h->security_flags & SF_MX) {
		if (len < n + 2) {
			return 0;
		}
		size_t ext = (size_t)rd(&in[n], 2);

		if (len - n - 2 < ext) {
			return 0;
		}
		n += 2 + ext;
	}
	return n;
}

size_t mt_msg_encode_proto(const struct mt_proto_header *p, uint8_t *out, size_t cap)
{
	size_t n = 6 + (p->has_ack ? 4 : 0);

	if (cap < n) {
		return 0;
	}
	out[0] = (uint8_t)(p->exchange_flags | (p->has_ack ? MT_EX_ACK : 0));
	out[1] = p->opcode;
	le(&out[2], p->exchange_id, 2);
	le(&out[4], p->protocol_id, 2);
	if (p->has_ack) {
		le(&out[6], p->ack_counter, 4);
	}
	return n;
}

size_t mt_msg_decode_proto(const uint8_t *in, size_t len, struct mt_proto_header *p)
{
	size_t n = 6;

	if (len < 6) {
		return 0;
	}
	memset(p, 0, sizeof(*p));
	p->exchange_flags = in[0];
	p->opcode = in[1];
	p->exchange_id = (uint16_t)rd(&in[2], 2);
	if (in[0] & EF_VENDOR) {
		if (len < 8) {
			return 0;
		}
		n += 2; /* vendor ID before the protocol ID */
		p->protocol_id = (uint16_t)rd(&in[6], 2);
	} else {
		p->protocol_id = (uint16_t)rd(&in[4], 2);
	}
	if (in[0] & MT_EX_ACK) {
		if (len < n + 4) {
			return 0;
		}
		p->has_ack = true;
		p->ack_counter = (uint32_t)rd(&in[n], 4);
		n += 4;
	}
	if (in[0] & EF_SX) {
		if (len < n + 2) {
			return 0;
		}
		size_t ext = (size_t)rd(&in[n], 2);

		if (len - n - 2 < ext) {
			return 0;
		}
		n += 2 + ext;
	}
	return n;
}

void mt_msg_nonce(const struct mt_msg_header *h, uint64_t source_node, uint8_t nonce[MT_NONCE_LEN])
{
	nonce[0] = h->security_flags;
	le(&nonce[1], h->counter, 4);
	le(&nonce[5], source_node, 8);
}

bool mt_counter_accept(struct mt_counter_window *w, uint32_t counter)
{
	if (!w->initialised) {
		w->initialised = true;
		w->max = counter;
		w->bitmap = 0;
		return true;
	}
	if (counter == w->max) {
		return false;
	}
	uint32_t ahead = counter - w->max;

	if (ahead < 0x80000000u) {
		/* Newer: slide the window. */
		if (ahead > 32) {
			w->bitmap = 0;
		} else {
			/* The old largest is now ahead - 1 behind the new one. */
			w->bitmap = (ahead == 32 ? 0 : w->bitmap << ahead) | (1u << (ahead - 1));
		}
		w->max = counter;
		return true;
	}
	uint32_t behind = w->max - counter; /* 1 .. */

	if (behind > 32 || (w->bitmap & (1u << (behind - 1)))) {
		return false;
	}
	w->bitmap |= 1u << (behind - 1);
	return true;
}

size_t mt_status_report(uint8_t *out, uint16_t general, uint32_t protocol, uint16_t code)
{
	le(&out[0], general, 2);
	le(&out[2], protocol, 4);
	le(&out[6], code, 2);
	return 8;
}

bool mt_status_report_parse(const uint8_t *in, size_t len, uint16_t *general, uint32_t *protocol,
			    uint16_t *code)
{
	if (len < 8) {
		return false;
	}
	*general = (uint16_t)rd(&in[0], 2);
	*protocol = (uint32_t)rd(&in[2], 4);
	*code = (uint16_t)rd(&in[6], 2);
	return true;
}
