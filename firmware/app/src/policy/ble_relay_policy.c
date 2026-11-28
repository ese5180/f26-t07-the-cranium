#include "ble_relay_policy.h"

#include <errno.h>
#include <string.h>

void ble_relay_session_init(struct ble_relay_session *session)
{
	memset(session, 0, sizeof(*session));
	session->state = BLE_RELAY_NO_CHANNEL;
}

static bool streaming_or_opening(const struct ble_relay_session *session)
{
	return session->state == BLE_RELAY_OPENING || session->state == BLE_RELAY_STREAMING;
}

/* The stream is over for this reason. Only a stream that was there can end. */
static uint32_t end(struct ble_relay_session *session, uint8_t reason)
{
	if (!streaming_or_opening(session)) {
		return 0;
	}

	session->state = BLE_RELAY_ENDED;
	session->reason = reason;
	return BLE_RELAY_DO_WAKE;
}

/* With no socket on it, what the channel alone says. */
static enum ble_relay_state at_rest(const struct ble_relay_session *session)
{
	return session->channel ? BLE_RELAY_IDLE : BLE_RELAY_NO_CHANNEL;
}

uint32_t ble_relay_on_channel(struct ble_relay_session *session, bool up)
{
	if (up) {
		if (session->channel) {
			return 0;
		}

		session->channel = true;
		/* A socket from the last channel keeps its ended stream until it is closed. */
		if (session->state == BLE_RELAY_NO_CHANNEL) {
			session->state = BLE_RELAY_IDLE;
		}
		return BLE_RELAY_DO_HELLO;
	}

	if (!session->channel) {
		return 0;
	}

	session->channel = false;
	if (session->state == BLE_RELAY_IDLE) {
		session->state = BLE_RELAY_NO_CHANNEL;
		return 0;
	}

	return end(session, BLE_RELAY_REASON_LINK);
}

int ble_relay_on_connect(struct ble_relay_session *session, uint32_t now_ms, uint32_t *actions)
{
	*actions = 0;

	if (!session->channel) {
		return -ENETUNREACH;
	}

	if (session->state != BLE_RELAY_IDLE) {
		return -EBUSY;
	}

	session->state = BLE_RELAY_OPENING;
	session->reason = BLE_RELAY_REASON_NORMAL;
	session->open_deadline_ms = now_ms + BLE_RELAY_OPEN_TIMEOUT_MS;
	*actions = BLE_RELAY_DO_OPEN;
	return 0;
}

int ble_relay_connect_result(const struct ble_relay_session *session)
{
	switch (session->state) {
	case BLE_RELAY_STREAMING:
		return 0;
	case BLE_RELAY_OPENING:
		return -EINPROGRESS;
	case BLE_RELAY_ENDED:
		switch (session->reason) {
		case BLE_RELAY_REASON_REFUSED:
			return -ECONNREFUSED;
		case BLE_RELAY_REASON_TIMEOUT:
			return -ETIMEDOUT;
		case BLE_RELAY_REASON_LINK:
		case BLE_RELAY_REASON_CONNECT_FAILED:
			return -ENETUNREACH;
		default:
			return -ECONNRESET;
		}
	default:
		return -ENETUNREACH;
	}
}

/* The phone broke the protocol: the channel goes, and the stream with it. */
static uint32_t broken(struct ble_relay_session *session)
{
	return end(session, BLE_RELAY_REASON_PROTOCOL) | BLE_RELAY_DO_DROP;
}

uint32_t ble_relay_on_frame(struct ble_relay_session *session, uint8_t type, const uint8_t *payload,
			    size_t len)
{
	switch (type) {
	case BLE_RELAY_OPENED:
		if (session->state != BLE_RELAY_OPENING) {
			/* OPENED for a stream the board has already closed: its CLOSE is on the way. */
			return session->state == BLE_RELAY_IDLE || session->state == BLE_RELAY_ENDED
				       ? 0
				       : broken(session);
		}

		session->state = BLE_RELAY_STREAMING;
		return BLE_RELAY_DO_WAKE;
	case BLE_RELAY_CLOSE:
		/* A CLOSE that crossed the board's own is nothing new. */
		return end(session, len >= 1 ? payload[0] : BLE_RELAY_REASON_NORMAL);
	default:
		/* HELLO and OPEN are the board's to send. */
		return broken(session);
	}
}

bool ble_relay_on_data(struct ble_relay_session *session, uint32_t *actions)
{
	*actions = 0;

	switch (session->state) {
	case BLE_RELAY_STREAMING:
		return true;
	case BLE_RELAY_OPENING:
		/* Bytes before OPENED: the phone has no connection to have read them from. */
		*actions = broken(session);
		return false;
	default:
		/* What was on its way when the board closed the stream: dropped. */
		return false;
	}
}

uint32_t ble_relay_on_broken(struct ble_relay_session *session)
{
	return broken(session);
}

uint32_t ble_relay_on_socket_closed(struct ble_relay_session *session)
{
	uint32_t actions = 0;

	if (streaming_or_opening(session)) {
		session->reason = BLE_RELAY_REASON_NORMAL;
		actions = session->channel ? BLE_RELAY_DO_CLOSE : 0;
	}

	session->state = at_rest(session);
	return actions;
}

uint32_t ble_relay_on_handback(struct ble_relay_session *session)
{
	uint32_t actions = end(session, BLE_RELAY_REASON_HANDBACK);

	return actions != 0 && session->channel ? actions | BLE_RELAY_DO_CLOSE : actions;
}

uint32_t ble_relay_session_tick(struct ble_relay_session *session, uint32_t now_ms)
{
	uint32_t actions;

	if (session->state != BLE_RELAY_OPENING ||
	    (int32_t)(now_ms - session->open_deadline_ms) < 0) {
		return 0;
	}

	actions = end(session, BLE_RELAY_REASON_TIMEOUT);
	return session->channel ? actions | BLE_RELAY_DO_CLOSE : actions;
}

int ble_relay_stream_error(const struct ble_relay_session *session)
{
	switch (session->state) {
	case BLE_RELAY_STREAMING:
		return 0;
	case BLE_RELAY_ENDED:
		return -ECONNRESET;
	default:
		return -ENOTCONN;
	}
}

void ble_relay_offer_init(struct ble_relay_offer *offer)
{
	memset(offer, 0, sizeof(*offer));
}

uint32_t ble_relay_offer_tick(struct ble_relay_offer *offer, const struct ble_relay_view *view)
{
	uint32_t actions = 0;
	bool wanted;
	bool kept;

	if (view->wifi_up) {
		offer->wifi_down_seconds = 0;
		if (offer->wifi_up_seconds < UINT32_MAX) {
			offer->wifi_up_seconds++;
		}
	} else {
		offer->wifi_up_seconds = 0;
		if (offer->wifi_down_seconds < UINT32_MAX) {
			offer->wifi_down_seconds++;
		}
	}

	/* Wi-Fi has stayed back: the relayed connection ends, and the next one goes over Wi-Fi. */
	if (view->wifi_up && view->cloud_relayed && view->cloud_up &&
	    offer->wifi_up_seconds >= BLE_RELAY_HANDBACK_SECONDS) {
		actions |= BLE_RELAY_HANDBACK;
	}

	wanted = view->provisioned && !view->window && !view->wifi_up &&
		 offer->wifi_down_seconds >= BLE_RELAY_OFFER_AFTER_SECONDS;
	/* A relayed connection keeps its phone until it is handed back. */
	kept = offer->offering && view->provisioned && !view->window && view->channel &&
	       view->cloud_relayed;

	if ((wanted || kept) && !offer->offering) {
		offer->offering = true;
		actions |= BLE_RELAY_OFFER_START;
	} else if (!(wanted || kept) && offer->offering) {
		offer->offering = false;
		actions |= BLE_RELAY_OFFER_STOP;
	}

	return actions;
}

bool ble_relay_use_relay(bool wifi_up, bool channel)
{
	return !wifi_up && channel;
}

uint16_t ble_relay_credits_due(size_t room, uint16_t outstanding, uint16_t mps)
{
	size_t total;

	if (mps == 0) {
		return 0;
	}

	total = room / mps;
	if (total <= outstanding) {
		return 0;
	}

	total -= outstanding;
	return total > UINT16_MAX ? UINT16_MAX : (uint16_t)total;
}
