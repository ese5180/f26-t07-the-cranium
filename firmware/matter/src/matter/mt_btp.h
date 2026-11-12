/*
 * BTP, the Bluetooth Transport Protocol (Matter specification 4.19): how Matter messages travel over the CHIPoBLE
 * GATT service while a device is commissioned. The commissioner is the BTP client: it writes to the device's C1
 * characteristic and receives indications on C2. This is the framing only: the handshake, cutting a message into
 * segments and putting it back together, sequence numbers and acknowledgements. The GATT calls are the caller's.
 */
#ifndef MT_BTP_H_
#define MT_BTP_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_BTP_VERSION          4
#define MT_BTP_HANDSHAKE_REQ_LEN 9
#define MT_BTP_MIN_SEGMENT      20
#define MT_BTP_MAX_MESSAGE      1280

struct mt_btp {
	uint16_t segment_size; /* agreed in the handshake, at most the ATT MTU minus 3 */
	uint8_t window;        /* agreed receive window */
	uint8_t tx_seq;        /* sequence number of our next packet */
	uint8_t rx_seq;        /* sequence number of the peer's last packet */
	bool rx_unacked;       /* a received packet has not been acknowledged yet */
	uint8_t tx_unacked;    /* our packets the peer has not acknowledged */
	/* reassembly */
	uint8_t rx_buf[MT_BTP_MAX_MESSAGE];
	uint16_t rx_expected;
	uint16_t rx_len;
	bool rx_active;
};

/* The handshake request: our versions, the ATT MTU and our window. Writes MT_BTP_HANDSHAKE_REQ_LEN bytes. */
size_t mt_btp_handshake_request(uint8_t *out, uint16_t att_mtu, uint8_t window);
/* Takes the peer's handshake response. False if it is not one or picks something we did not offer. */
bool mt_btp_handshake_response(struct mt_btp *b, const uint8_t *pkt, size_t len, uint16_t att_mtu);

/*
 * Writes the next packet of a message into out (at least segment_size bytes), starting at *offset, which it
 * advances. Acknowledges the peer's last packet on the way. Returns the packet's length.
 */
size_t mt_btp_segment(struct mt_btp *b, const uint8_t *msg, size_t msg_len, size_t *offset, uint8_t *out);
/* A packet that only acknowledges. Returns its length (3). */
size_t mt_btp_ack(struct mt_btp *b, uint8_t *out);

enum mt_btp_rx {
	MT_BTP_RX_MORE,     /* part of a message; more to come */
	MT_BTP_RX_MESSAGE,  /* a whole message is in rx_buf, rx_len bytes */
	MT_BTP_RX_ACK_ONLY, /* only an acknowledgement */
	MT_BTP_RX_ERROR,    /* out of sequence, too long, or malformed: the connection must be closed */
};

/* Takes one packet from the peer. */
enum mt_btp_rx mt_btp_receive(struct mt_btp *b, const uint8_t *pkt, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* MT_BTP_H_ */
