/*
 * See mt_btp.h.
 */
#include "mt_btp.h"

#include <string.h>

#define F_BEGIN     0x01u
#define F_CONTINUE  0x02u
#define F_END       0x04u
#define F_ACK       0x08u
#define F_MGMT      0x20u
#define F_HANDSHAKE 0x40u
#define OPCODE_HANDSHAKE 0x6Cu

size_t mt_btp_handshake_request(uint8_t *out, uint16_t att_mtu, uint8_t window)
{
	out[0] = F_HANDSHAKE | F_MGMT | F_END | F_BEGIN;
	out[1] = OPCODE_HANDSHAKE;
	/* Supported versions, one per nibble, highest first: only 4. */
	out[2] = MT_BTP_VERSION;
	out[3] = 0;
	out[4] = 0;
	out[5] = 0;
	out[6] = (uint8_t)att_mtu;
	out[7] = (uint8_t)(att_mtu >> 8);
	out[8] = window;
	return MT_BTP_HANDSHAKE_REQ_LEN;
}

bool mt_btp_handshake_response(struct mt_btp *b, const uint8_t *pkt, size_t len, uint16_t att_mtu)
{
	if (len < 6 || pkt[0] != (F_HANDSHAKE | F_MGMT | F_END | F_BEGIN) || pkt[1] != OPCODE_HANDSHAKE ||
	    (pkt[2] & 0x0Fu) != MT_BTP_VERSION) {
		return false;
	}
	uint16_t seg = (uint16_t)(pkt[3] | (pkt[4] << 8));

	if (seg < MT_BTP_MIN_SEGMENT || seg > att_mtu - 3 || pkt[5] == 0) {
		return false;
	}
	memset(b, 0, sizeof(*b));
	b->segment_size = seg;
	b->window = pkt[5];
	/* The handshake counts as the peer's packet 0, unacknowledged until our first packet. */
	b->rx_seq = 0;
	b->rx_unacked = true;
	b->tx_seq = 0;
	return true;
}

static size_t header(struct mt_btp *b, uint8_t flags, uint8_t *out)
{
	size_t n = 1;

	if (b->rx_unacked) {
		flags |= F_ACK;
		out[n++] = b->rx_seq;
		b->rx_unacked = false;
	}
	out[0] = flags;
	out[n++] = b->tx_seq++;
	b->tx_unacked++;
	return n;
}

size_t mt_btp_segment(struct mt_btp *b, const uint8_t *msg, size_t msg_len, size_t *offset, uint8_t *out)
{
	bool first = *offset == 0;
	uint8_t flags = first ? F_BEGIN : F_CONTINUE;
	/* Room after the largest header: flags, ack, sequence, and length on the first. */
	size_t room = b->segment_size - (first ? 5u : 3u);
	size_t left = msg_len - *offset;
	size_t take = left < room ? left : room;

	if (take == left) {
		flags |= F_END;
	}
	size_t n = header(b, flags, out);

	if (first) {
		out[n++] = (uint8_t)msg_len;
		out[n++] = (uint8_t)(msg_len >> 8);
	}
	memcpy(&out[n], &msg[*offset], take);
	*offset += take;
	return n + take;
}

size_t mt_btp_ack(struct mt_btp *b, uint8_t *out)
{
	out[0] = F_ACK;
	out[1] = b->rx_seq;
	out[2] = b->tx_seq++;
	b->tx_unacked++;
	b->rx_unacked = false;
	return 3;
}

enum mt_btp_rx mt_btp_receive(struct mt_btp *b, const uint8_t *pkt, size_t len)
{
	size_t n = 1;

	if (len < 2) {
		return MT_BTP_RX_ERROR;
	}
	uint8_t flags = pkt[0];

	if (flags & (F_HANDSHAKE | F_MGMT)) {
		return MT_BTP_RX_ERROR;
	}
	if (flags & F_ACK) {
		uint8_t acked = pkt[n++];
		/* It must be one of ours still outstanding; it acknowledges that one and all before it. */
		uint8_t behind = (uint8_t)(b->tx_seq - 1u - acked);

		if (behind >= b->tx_unacked) {
			return MT_BTP_RX_ERROR;
		}
		b->tx_unacked = behind;
	}
	if (n >= len) {
		return MT_BTP_RX_ERROR;
	}
	uint8_t seq = pkt[n++];

	if (seq != (uint8_t)(b->rx_seq + 1u)) {
		return MT_BTP_RX_ERROR;
	}
	b->rx_seq = seq;
	b->rx_unacked = true;

	if (!(flags & (F_BEGIN | F_CONTINUE | F_END))) {
		return n == len ? MT_BTP_RX_ACK_ONLY : MT_BTP_RX_ERROR;
	}
	if (flags & F_BEGIN) {
		if (b->rx_active || len - n < 2) {
			return MT_BTP_RX_ERROR;
		}
		b->rx_expected = (uint16_t)(pkt[n] | (pkt[n + 1] << 8));
		n += 2;
		if (b->rx_expected > MT_BTP_MAX_MESSAGE) {
			return MT_BTP_RX_ERROR;
		}
		b->rx_len = 0;
		b->rx_active = true;
	} else if (!b->rx_active || !(flags & F_CONTINUE)) {
		return MT_BTP_RX_ERROR;
	}
	size_t payload = len - n;

	if (payload > (size_t)(b->rx_expected - b->rx_len)) {
		return MT_BTP_RX_ERROR;
	}
	memcpy(&b->rx_buf[b->rx_len], &pkt[n], payload);
	b->rx_len = (uint16_t)(b->rx_len + payload);
	if (flags & F_END) {
		b->rx_active = false;
		return b->rx_len == b->rx_expected ? MT_BTP_RX_MESSAGE : MT_BTP_RX_ERROR;
	}
	return MT_BTP_RX_MORE;
}

bool mt_btp_parse_handshake_request(const uint8_t *pkt, size_t len, uint16_t *client_mtu, uint8_t *client_window)
{
	bool v4 = false;

	if (len < MT_BTP_HANDSHAKE_REQ_LEN || pkt[0] != (F_HANDSHAKE | F_MGMT | F_END | F_BEGIN) ||
	    pkt[1] != OPCODE_HANDSHAKE) {
		return false;
	}
	for (int i = 2; i < 6; i++) {
		if ((pkt[i] & 0x0F) == MT_BTP_VERSION || (pkt[i] >> 4) == MT_BTP_VERSION) {
			v4 = true;
		}
	}
	*client_mtu = (uint16_t)(pkt[6] | (pkt[7] << 8));
	*client_window = pkt[8];
	return v4 && *client_window > 0;
}

size_t mt_btp_server_accept(struct mt_btp *b, uint8_t *out, uint16_t att_mtu, uint8_t window)
{
	uint16_t seg = (uint16_t)(att_mtu - 3);

	memset(b, 0, sizeof(*b));
	b->segment_size = seg;
	b->window = window;
	b->tx_seq = 1;      /* the response is our packet 0, which the client acknowledges first */
	b->tx_unacked = 1;
	b->rx_seq = 0xFF;   /* the client's first packet is its 0 */
	out[0] = F_HANDSHAKE | F_MGMT | F_END | F_BEGIN;
	out[1] = OPCODE_HANDSHAKE;
	out[2] = MT_BTP_VERSION;
	out[3] = (uint8_t)seg;
	out[4] = (uint8_t)(seg >> 8);
	out[5] = window;
	return 6;
}
