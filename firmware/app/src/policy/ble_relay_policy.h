/*
 * The Bluetooth relay's decisions (docs/ble-relay.md), with no Bluetooth and no sockets in it: the one
 * stream that a relay channel carries, when the board offers the relay at all, when it goes back to
 * Wi-Fi, and how many L2CAP credits it may give a phone. src/bt/ble_relay.c does the rest, and
 * firmware/tests/host runs this. From 1.21.0.
 *
 * The board picks Wi-Fi whenever it has it. Only a board whose Wi-Fi has been down for
 * BLE_RELAY_OFFER_AFTER_SECONDS advertises the relay; a connection to AWS IoT goes over the relay only
 * when Wi-Fi is down and a phone's channel is up; and a relayed connection ends once Wi-Fi has been
 * back for BLE_RELAY_HANDBACK_SECONDS, so that the next one goes over Wi-Fi.
 */

#ifndef BLE_RELAY_POLICY_H_
#define BLE_RELAY_POLICY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ble_relay_proto.h"

#define BLE_RELAY_OFFER_AFTER_SECONDS 60
#define BLE_RELAY_HANDBACK_SECONDS    30
/* From OPEN to OPENED: a phone resolves the host and makes a TCP connection in this time, or it is over. */
#define BLE_RELAY_OPEN_TIMEOUT_MS     15000

#define BLE_RELAY_BIT(n) (1u << (n))

/* ---- the stream on a channel ----------------------------------------------------------------- */

enum ble_relay_state {
	/* No phone, or a phone with no channel open. */
	BLE_RELAY_NO_CHANNEL = 0,
	/* A channel, HELLO sent, and no stream. */
	BLE_RELAY_IDLE,
	/* OPEN sent; OPENED has not come. */
	BLE_RELAY_OPENING,
	/* Bytes flow both ways. */
	BLE_RELAY_STREAMING,
	/* The stream is over (a CLOSE, the link, a timeout) and its socket is not closed yet. */
	BLE_RELAY_ENDED,
};

/* What ble_relay.c does next, as a set of these. */
#define BLE_RELAY_DO_HELLO BLE_RELAY_BIT(0)
#define BLE_RELAY_DO_OPEN  BLE_RELAY_BIT(1)
/* Send CLOSE with session.reason. */
#define BLE_RELAY_DO_CLOSE BLE_RELAY_BIT(2)
/* Wake whoever waits on the socket: connect(), recv(), poll(). */
#define BLE_RELAY_DO_WAKE  BLE_RELAY_BIT(3)
/* Drop the channel: the phone broke the protocol. */
#define BLE_RELAY_DO_DROP  BLE_RELAY_BIT(4)

struct ble_relay_session {
	enum ble_relay_state state;
	/* A channel is open, whatever the stream does: an ended stream's socket may outlive its channel. */
	bool channel;
	/* Why the stream ended, or what CLOSE says. */
	uint8_t reason;
	uint32_t open_deadline_ms;
};

void ble_relay_session_init(struct ble_relay_session *session);

/* The channel opened (up) or went (down). */
uint32_t ble_relay_on_channel(struct ble_relay_session *session, bool up);

/*
 * The socket's connect(): start a stream. 0 with BLE_RELAY_DO_OPEN in *actions, or -ENETUNREACH with no
 * channel, or -EBUSY with a stream already there.
 */
int ble_relay_on_connect(struct ble_relay_session *session, uint32_t now_ms, uint32_t *actions);

/*
 * What connect() returns once it has woken: 0 when the stream is up, -EINPROGRESS while it is not decided,
 * or the error for how it ended: -ECONNREFUSED, -ETIMEDOUT, -ENETUNREACH, -ECONNRESET.
 */
int ble_relay_connect_result(const struct ble_relay_session *session);

/* A whole frame other than DATA came from the phone. */
uint32_t ble_relay_on_frame(struct ble_relay_session *session, uint8_t type, const uint8_t *payload,
			    size_t len);

/* DATA came from the phone: whether its bytes are the stream's. If not, *actions says what to do. */
bool ble_relay_on_data(struct ble_relay_session *session, uint32_t *actions);

/* The reader found the stream broken. */
uint32_t ble_relay_on_broken(struct ble_relay_session *session);

/* The socket is closed. */
uint32_t ble_relay_on_socket_closed(struct ble_relay_session *session);

/* The board ends a relayed stream to go back to Wi-Fi. */
uint32_t ble_relay_on_handback(struct ble_relay_session *session);

/* Once a second, and whenever connect() wakes: a stream that OPENED never came for ends. */
uint32_t ble_relay_session_tick(struct ble_relay_session *session, uint32_t now_ms);

/* What send() and recv() say on a stream that is not up: -ENOTCONN, -ECONNRESET or 0 for none. */
int ble_relay_stream_error(const struct ble_relay_session *session);

/* ---- offering the relay, and going back to Wi-Fi ---------------------------------------------- */

struct ble_relay_view {
	/* The board has its AWS IoT settings and is not in factory mode. */
	bool provisioned;
	/* An update window or the status after an update over Bluetooth has the radio. */
	bool window;
	bool wifi_up;
	bool channel;
	bool cloud_up;
	/* The cloud connection that is up, or being made, goes over the relay. */
	bool cloud_relayed;
};

struct ble_relay_offer {
	uint32_t wifi_down_seconds;
	uint32_t wifi_up_seconds;
	bool offering;
};

#define BLE_RELAY_OFFER_START BLE_RELAY_BIT(0)
#define BLE_RELAY_OFFER_STOP  BLE_RELAY_BIT(1)
/* End the relayed cloud connection: Wi-Fi is back. */
#define BLE_RELAY_HANDBACK    BLE_RELAY_BIT(2)

void ble_relay_offer_init(struct ble_relay_offer *offer);

/* Once a second, on the main loop. */
uint32_t ble_relay_offer_tick(struct ble_relay_offer *offer, const struct ble_relay_view *view);

/* For a connection to AWS IoT about to be made: over the relay, or over Wi-Fi (or not at all). */
bool ble_relay_use_relay(bool wifi_up, bool channel);

/* ---- L2CAP credits ---------------------------------------------------------------------------- */

/*
 * Each credit lets the phone send one segment of up to mps bytes, all of which may be stream bytes: give
 * only as many as there is room for, counting those it still holds.
 */
uint16_t ble_relay_credits_due(size_t room, uint16_t outstanding, uint16_t mps);

#endif /* BLE_RELAY_POLICY_H_ */
