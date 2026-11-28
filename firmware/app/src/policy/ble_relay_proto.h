/*
 * The Bluetooth relay's bytes (docs/ble-relay.md), with no Bluetooth in it: how the board and a phone
 * frame what goes over the L2CAP channel, and how the board reads a stream of them. src/bt/ble_relay.c
 * does the Bluetooth, and firmware/tests/host runs this. From 1.21.0.
 *
 * An L2CAP channel is a byte stream to the apps (iOS and Android hand it over as an input and an output
 * stream), so every message is a frame: a type, a length and that many bytes.
 *
 *   0       1        3
 *   +-------+--------+---------------------+
 *   | type  | length | payload             |
 *   +-------+--------+---------------------+
 *            little-endian, at most BLE_RELAY_PAYLOAD_MAX
 *
 * What travels as DATA is the board's own TLS stream to AWS IoT: the phone moves it and cannot read or
 * change it. Nothing here is secret.
 */

#ifndef BLE_RELAY_PROTO_H_
#define BLE_RELAY_PROTO_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BLE_RELAY_VERSION      1
#define BLE_RELAY_HEADER_LEN   3
/* The most either side puts in one frame. A phone must take this much; the board says in HELLO what it takes. */
#define BLE_RELAY_PAYLOAD_MAX  512
/* The longest thing name in HELLO, and the longest host in OPEN. */
#define BLE_RELAY_NAME_MAX     64
#define BLE_RELAY_HOST_MAX     128
/* What the board keeps of a frame that is not DATA: OPENED has nothing, CLOSE one byte. */
#define BLE_RELAY_CONTROL_MAX  4

enum ble_relay_type {
	/* Board to phone, once a channel is up: version, flags, the largest DATA it takes, its thing name. */
	BLE_RELAY_HELLO = 0x01,
	/* Board to phone: open a TCP connection to this port and host. */
	BLE_RELAY_OPEN = 0x02,
	/* Phone to board: the TCP connection is up. */
	BLE_RELAY_OPENED = 0x03,
	/* Either way: bytes of the stream. */
	BLE_RELAY_DATA = 0x04,
	/* Either way: the stream is over, and why. The channel stays for the next one. */
	BLE_RELAY_CLOSE = 0x05,
};

enum ble_relay_reason {
	BLE_RELAY_REASON_NORMAL = 0,
	/* The phone will not relay this: a host or port it does not allow, or a board it was not asked to. */
	BLE_RELAY_REASON_REFUSED = 1,
	/* The TCP connection could not be made. */
	BLE_RELAY_REASON_CONNECT_FAILED = 2,
	/* The server, or the network between, ended the TCP connection. */
	BLE_RELAY_REASON_PEER_CLOSED = 3,
	/* OPENED did not come in time. */
	BLE_RELAY_REASON_TIMEOUT = 4,
	/* A frame that makes no sense here. */
	BLE_RELAY_REASON_PROTOCOL = 5,
	/* The board has Wi-Fi again and goes back to it. */
	BLE_RELAY_REASON_HANDBACK = 6,
	/* The Bluetooth link or the channel went. Never sent: there is nothing left to send it on. */
	BLE_RELAY_REASON_LINK = 7,
};

/* ---- writing frames ------------------------------------------------------------------------ */

/* The three bytes before a payload of len bytes. len must not exceed BLE_RELAY_PAYLOAD_MAX. */
void ble_relay_header(uint8_t type, uint16_t len, uint8_t out[BLE_RELAY_HEADER_LEN]);

/* HELLO in out; its length, or -1 if it does not fit or the name is too long. */
int ble_relay_hello(uint16_t data_max, const char *thing_name, uint8_t *out, size_t size);

/* OPEN in out; its length, or -1 if it does not fit or the host is empty or too long. */
int ble_relay_open(const char *host, uint16_t port, uint8_t *out, size_t size);

/* CLOSE in out, which has room for BLE_RELAY_HEADER_LEN + 1 bytes; its length. */
int ble_relay_close(uint8_t reason, uint8_t *out);

/* ---- reading a stream ---------------------------------------------------------------------- */

enum ble_relay_item_kind {
	/* The bytes so far make no whole item: feed more. */
	BLE_RELAY_ITEM_NONE = 0,
	/* Stream bytes, at item.data in the input itself: a DATA frame comes out in as many pieces as it took. */
	BLE_RELAY_ITEM_DATA,
	/* A whole frame other than DATA, its payload in the reader's control buffer. */
	BLE_RELAY_ITEM_FRAME,
	/* The stream is broken: a length over the limit, or a control frame too long for its type. Stays so. */
	BLE_RELAY_ITEM_ERROR,
};

struct ble_relay_item {
	enum ble_relay_item_kind kind;
	uint8_t type;
	const uint8_t *data;
	size_t len;
};

struct ble_relay_reader {
	uint8_t header[BLE_RELAY_HEADER_LEN];
	uint8_t have;
	uint8_t type;
	uint16_t left;
	uint16_t length;
	/* The largest DATA payload this side takes. */
	uint16_t data_max;
	uint8_t control[BLE_RELAY_CONTROL_MAX];
	bool failed;
};

void ble_relay_reader_init(struct ble_relay_reader *reader, uint16_t data_max);

/*
 * Take bytes from in until one item is complete or in runs out, and say what came in *item. Returns how
 * many bytes it took: call again with the rest. A type it does not know is skipped, payload and all, so
 * that a newer phone can add frames.
 */
size_t ble_relay_read(struct ble_relay_reader *reader, const uint8_t *in, size_t len,
		      struct ble_relay_item *item);

#endif /* BLE_RELAY_PROTO_H_ */
