/*
 * Host-side tests of the Bluetooth relay's frames and decisions (src/policy/ble_relay_proto.h and
 * ble_relay_policy.h). Run with --print to get the sample frames that the apps' tests hold as well
 * (apps/ios CraniumKit RelayProtocolTests, apps/android RelayProtocolTest): change one only with the other.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ble_relay_policy.h"
#include "ble_relay_proto.h"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static const char thing[] = "cranium-0123456789abcdef";
static const char host[] = "example-ats.iot.us-east-1.amazonaws.com";

static void hex(const char *label, const uint8_t *bytes, int len)
{
	printf("%s ", label);
	for (int i = 0; i < len; i++) {
		printf("%02x", bytes[i]);
	}
	printf("\n");
}

/* ---- frames ---------------------------------------------------------------------------- */

static void test_header_is_type_then_length_little_endian(void)
{
	uint8_t out[3];

	ble_relay_header(BLE_RELAY_DATA, 0x0201, out);
	CHECK(out[0] == 0x04 && out[1] == 0x01 && out[2] == 0x02);
	CHECK(BLE_RELAY_HEADER_LEN == 3);
	CHECK(BLE_RELAY_PAYLOAD_MAX == 512);
}

static void test_hello_carries_version_room_and_name(void)
{
	uint8_t out[80];
	int len = ble_relay_hello(240, thing, out, sizeof(out));

	CHECK(len == 3 + 4 + (int)strlen(thing));
	CHECK(out[0] == BLE_RELAY_HELLO);
	CHECK(out[1] == 4 + strlen(thing) && out[2] == 0);
	CHECK(out[3] == BLE_RELAY_VERSION);
	CHECK(out[4] == 0);
	CHECK(out[5] == 240 && out[6] == 0);
	CHECK(memcmp(&out[7], thing, strlen(thing)) == 0);

	/* Too small a buffer, or too long a name: nothing. */
	CHECK(ble_relay_hello(240, thing, out, 10) == -1);
	{
		char long_name[BLE_RELAY_NAME_MAX + 2];

		memset(long_name, 'a', sizeof(long_name) - 1);
		long_name[sizeof(long_name) - 1] = '\0';
		CHECK(ble_relay_hello(240, long_name, out, sizeof(out)) == -1);
	}
}

static void test_open_carries_port_and_host(void)
{
	uint8_t out[160];
	int len = ble_relay_open(host, 8883, out, sizeof(out));

	CHECK(len == 3 + 2 + (int)strlen(host));
	CHECK(out[0] == BLE_RELAY_OPEN);
	CHECK(out[3] == (8883 & 0xff) && out[4] == (8883 >> 8));
	CHECK(memcmp(&out[5], host, strlen(host)) == 0);
	CHECK(ble_relay_open("", 8883, out, sizeof(out)) == -1);
	CHECK(ble_relay_open(host, 8883, out, 20) == -1);
}

static void test_close_is_one_byte(void)
{
	uint8_t out[4];

	CHECK(ble_relay_close(BLE_RELAY_REASON_HANDBACK, out) == 4);
	CHECK(out[0] == BLE_RELAY_CLOSE && out[1] == 1 && out[2] == 0 && out[3] == 6);
}

/* ---- reading ------------------------------------------------------------------------------ */

struct collected {
	uint8_t data[2048];
	size_t data_len;
	uint8_t types[16];
	uint8_t first_payload[16][BLE_RELAY_CONTROL_MAX];
	size_t payload_len[16];
	int frames;
	int errors;
};

/* Feed in pieces of step bytes, as segments would come. */
static void feed(struct ble_relay_reader *reader, const uint8_t *in, size_t len, size_t step,
		 struct collected *out)
{
	for (size_t at = 0; at < len;) {
		size_t piece = len - at < step ? len - at : step;
		size_t used = 0;

		while (used < piece) {
			struct ble_relay_item item;
			size_t took = ble_relay_read(reader, &in[at + used], piece - used, &item);

			CHECK(took > 0);
			used += took;
			if (item.kind == BLE_RELAY_ITEM_DATA) {
				memcpy(&out->data[out->data_len], item.data, item.len);
				out->data_len += item.len;
			} else if (item.kind == BLE_RELAY_ITEM_FRAME && out->frames < 16) {
				out->types[out->frames] = item.type;
				memcpy(out->first_payload[out->frames], item.data, item.len);
				out->payload_len[out->frames] = item.len;
				out->frames++;
			} else if (item.kind == BLE_RELAY_ITEM_ERROR) {
				out->errors++;
			}
			if (took == 0) {
				break;
			}
		}
		at += piece;
	}
}

static size_t stream_of_frames(uint8_t *out)
{
	size_t len = 0;

	/* OPENED, 300 bytes of DATA, an empty DATA, a type from a newer phone, more DATA, CLOSE. */
	ble_relay_header(BLE_RELAY_OPENED, 0, &out[len]);
	len += 3;
	ble_relay_header(BLE_RELAY_DATA, 300, &out[len]);
	len += 3;
	for (int i = 0; i < 300; i++) {
		out[len++] = (uint8_t)i;
	}
	ble_relay_header(BLE_RELAY_DATA, 0, &out[len]);
	len += 3;
	ble_relay_header(0x7e, 5, &out[len]);
	len += 3;
	memcpy(&out[len], "later", 5);
	len += 5;
	ble_relay_header(BLE_RELAY_DATA, 2, &out[len]);
	len += 3;
	out[len++] = 0xaa;
	out[len++] = 0xbb;
	len += (size_t)ble_relay_close(BLE_RELAY_REASON_PEER_CLOSED, &out[len]);
	return len;
}

static void test_reader_gets_the_same_whatever_the_pieces(void)
{
	uint8_t stream[512];
	size_t len = stream_of_frames(stream);
	size_t steps[] = { 1, 2, 3, 7, 64, 247, 512 };

	for (size_t s = 0; s < sizeof(steps) / sizeof(steps[0]); s++) {
		struct ble_relay_reader reader;
		struct collected got;

		memset(&got, 0, sizeof(got));
		ble_relay_reader_init(&reader, 400);
		feed(&reader, stream, len, steps[s], &got);

		CHECK(got.errors == 0);
		CHECK(got.data_len == 302);
		CHECK(got.data[0] == 0 && got.data[299] == (uint8_t)299);
		CHECK(got.data[300] == 0xaa && got.data[301] == 0xbb);
		CHECK(got.frames == 2);
		CHECK(got.types[0] == BLE_RELAY_OPENED && got.payload_len[0] == 0);
		CHECK(got.types[1] == BLE_RELAY_CLOSE && got.payload_len[1] == 1);
		CHECK(got.first_payload[1][0] == BLE_RELAY_REASON_PEER_CLOSED);
	}
}

static void test_reader_refuses_what_is_too_long(void)
{
	struct ble_relay_reader reader;
	struct ble_relay_item item;
	uint8_t frame[3];

	/* DATA longer than this side takes. */
	ble_relay_reader_init(&reader, 240);
	ble_relay_header(BLE_RELAY_DATA, 241, frame);
	CHECK(ble_relay_read(&reader, frame, 3, &item) == 3);
	CHECK(item.kind == BLE_RELAY_ITEM_ERROR);
	/* It stays broken. */
	CHECK(ble_relay_read(&reader, frame, 1, &item) == 1 && item.kind == BLE_RELAY_ITEM_ERROR);

	/* Anything over the protocol's limit, even of a type it would skip. */
	ble_relay_reader_init(&reader, 240);
	ble_relay_header(0x7e, BLE_RELAY_PAYLOAD_MAX + 1, frame);
	(void)ble_relay_read(&reader, frame, 3, &item);
	CHECK(item.kind == BLE_RELAY_ITEM_ERROR);

	/* A CLOSE with more than its reason, an OPENED with anything. */
	ble_relay_reader_init(&reader, 240);
	ble_relay_header(BLE_RELAY_CLOSE, 2, frame);
	(void)ble_relay_read(&reader, frame, 3, &item);
	CHECK(item.kind == BLE_RELAY_ITEM_ERROR);
	ble_relay_reader_init(&reader, 240);
	ble_relay_header(BLE_RELAY_OPENED, 1, frame);
	(void)ble_relay_read(&reader, frame, 3, &item);
	CHECK(item.kind == BLE_RELAY_ITEM_ERROR);

	/* A HELLO from a phone that fits the buffer is a frame, for the session to refuse. */
	ble_relay_reader_init(&reader, 240);
	{
		uint8_t hello[7] = { BLE_RELAY_HELLO, 4, 0, 1, 0, 240, 0 };
		size_t used = ble_relay_read(&reader, hello, sizeof(hello), &item);

		CHECK(used == sizeof(hello));
		CHECK(item.kind == BLE_RELAY_ITEM_FRAME && item.type == BLE_RELAY_HELLO);
	}
}

static void test_reader_stops_at_each_item(void)
{
	struct ble_relay_reader reader;
	struct ble_relay_item item;
	uint8_t two[8];
	size_t used;

	ble_relay_header(BLE_RELAY_OPENED, 0, two);
	ble_relay_header(BLE_RELAY_DATA, 2, &two[3]);
	two[6] = 1;
	two[7] = 2;
	ble_relay_reader_init(&reader, 240);

	used = ble_relay_read(&reader, two, sizeof(two), &item);
	CHECK(used == 3 && item.kind == BLE_RELAY_ITEM_FRAME);
	used += ble_relay_read(&reader, &two[used], sizeof(two) - used, &item);
	CHECK(used == 8 && item.kind == BLE_RELAY_ITEM_DATA && item.len == 2 && item.data == &two[6]);
	CHECK(ble_relay_read(&reader, two, 0, &item) == 0 && item.kind == BLE_RELAY_ITEM_NONE);
}

/* ---- the stream --------------------------------------------------------------------------- */

static void test_a_stream_from_channel_to_close(void)
{
	struct ble_relay_session s;
	uint32_t actions;
	uint8_t reason;

	ble_relay_session_init(&s);
	CHECK(ble_relay_on_connect(&s, 0, &actions) == -ENETUNREACH);

	CHECK(ble_relay_on_channel(&s, true) == BLE_RELAY_DO_HELLO);
	CHECK(s.state == BLE_RELAY_IDLE);
	CHECK(ble_relay_on_channel(&s, true) == 0);

	CHECK(ble_relay_on_connect(&s, 1000, &actions) == 0 && actions == BLE_RELAY_DO_OPEN);
	CHECK(ble_relay_connect_result(&s) == -EINPROGRESS);
	CHECK(ble_relay_on_connect(&s, 1000, &actions) == -EBUSY);
	CHECK(ble_relay_stream_error(&s) == -ENOTCONN);

	CHECK(ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0) == BLE_RELAY_DO_WAKE);
	CHECK(ble_relay_connect_result(&s) == 0);
	CHECK(ble_relay_stream_error(&s) == 0);
	CHECK(ble_relay_on_data(&s, &actions) && actions == 0);

	/* The server ends it: the socket reads its end, and closing it sends nothing more. */
	reason = BLE_RELAY_REASON_PEER_CLOSED;
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_CLOSE, &reason, 1) == BLE_RELAY_DO_WAKE);
	CHECK(s.state == BLE_RELAY_ENDED && ble_relay_stream_error(&s) == -ECONNRESET);
	CHECK(!ble_relay_on_data(&s, &actions) && actions == 0);
	CHECK(ble_relay_on_socket_closed(&s) == 0);
	CHECK(s.state == BLE_RELAY_IDLE);

	/* The next connection opens a new stream on the same channel. */
	CHECK(ble_relay_on_connect(&s, 2000, &actions) == 0);
}

static void test_the_board_closes_its_socket(void)
{
	struct ble_relay_session s;
	uint32_t actions;

	ble_relay_session_init(&s);
	(void)ble_relay_on_channel(&s, true);
	(void)ble_relay_on_connect(&s, 0, &actions);
	(void)ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0);

	CHECK(ble_relay_on_socket_closed(&s) == BLE_RELAY_DO_CLOSE);
	CHECK(s.reason == BLE_RELAY_REASON_NORMAL && s.state == BLE_RELAY_IDLE);
	/* What crossed the CLOSE is dropped quietly: DATA, OPENED, CLOSE. */
	CHECK(!ble_relay_on_data(&s, &actions) && actions == 0);
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_CLOSE, NULL, 0) == 0);
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0) == 0);
	CHECK(s.state == BLE_RELAY_IDLE);
}

static void test_refused_and_timed_out_opens(void)
{
	struct ble_relay_session s;
	uint32_t actions;
	uint8_t reason = BLE_RELAY_REASON_REFUSED;

	ble_relay_session_init(&s);
	(void)ble_relay_on_channel(&s, true);
	(void)ble_relay_on_connect(&s, 0, &actions);
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_CLOSE, &reason, 1) == BLE_RELAY_DO_WAKE);
	CHECK(ble_relay_connect_result(&s) == -ECONNREFUSED);
	(void)ble_relay_on_socket_closed(&s);

	reason = BLE_RELAY_REASON_CONNECT_FAILED;
	(void)ble_relay_on_connect(&s, 0, &actions);
	(void)ble_relay_on_frame(&s, BLE_RELAY_CLOSE, &reason, 1);
	CHECK(ble_relay_connect_result(&s) == -ENETUNREACH);
	(void)ble_relay_on_socket_closed(&s);

	/* No answer: at the deadline and not a millisecond before, also across the counter's wrap. */
	(void)ble_relay_on_connect(&s, UINT32_MAX - 1000, &actions);
	CHECK(ble_relay_session_tick(&s, UINT32_MAX - 1000 + BLE_RELAY_OPEN_TIMEOUT_MS - 1) == 0);
	CHECK(ble_relay_session_tick(&s, UINT32_MAX - 1000 + BLE_RELAY_OPEN_TIMEOUT_MS) ==
	      (BLE_RELAY_DO_WAKE | BLE_RELAY_DO_CLOSE));
	CHECK(s.reason == BLE_RELAY_REASON_TIMEOUT);
	CHECK(ble_relay_connect_result(&s) == -ETIMEDOUT);
	CHECK(ble_relay_session_tick(&s, 0) == 0);
	/* The CLOSE went with the timeout: closing the socket says nothing more. */
	CHECK(ble_relay_on_socket_closed(&s) == 0);
}

static void test_the_link_goes(void)
{
	struct ble_relay_session s;
	uint32_t actions;

	ble_relay_session_init(&s);
	(void)ble_relay_on_channel(&s, true);
	CHECK(ble_relay_on_channel(&s, false) == 0);
	CHECK(s.state == BLE_RELAY_NO_CHANNEL);

	(void)ble_relay_on_channel(&s, true);
	(void)ble_relay_on_connect(&s, 0, &actions);
	(void)ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0);
	CHECK(ble_relay_on_channel(&s, false) == BLE_RELAY_DO_WAKE);
	CHECK(s.state == BLE_RELAY_ENDED && s.reason == BLE_RELAY_REASON_LINK);
	CHECK(ble_relay_stream_error(&s) == -ECONNRESET);

	/* A new channel before the old socket is closed: HELLO, and the ended stream stays ended. */
	CHECK(ble_relay_on_channel(&s, true) == BLE_RELAY_DO_HELLO);
	CHECK(s.state == BLE_RELAY_ENDED);
	CHECK(ble_relay_on_connect(&s, 0, &actions) == -EBUSY);
	/* No CLOSE for a stream whose channel is gone. */
	CHECK(ble_relay_on_socket_closed(&s) == 0);
	CHECK(s.state == BLE_RELAY_IDLE);

	/* Closed with no channel left: no channel to rest on. */
	(void)ble_relay_on_connect(&s, 0, &actions);
	(void)ble_relay_on_channel(&s, false);
	CHECK(ble_relay_on_socket_closed(&s) == 0);
	CHECK(s.state == BLE_RELAY_NO_CHANNEL);
}

static void test_a_phone_that_breaks_the_protocol_loses_the_channel(void)
{
	struct ble_relay_session s;
	uint32_t actions;

	ble_relay_session_init(&s);
	(void)ble_relay_on_channel(&s, true);
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_HELLO, NULL, 0) == BLE_RELAY_DO_DROP);
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_OPEN, NULL, 0) == BLE_RELAY_DO_DROP);

	(void)ble_relay_on_connect(&s, 0, &actions);
	/* DATA before OPENED. */
	CHECK(!ble_relay_on_data(&s, &actions));
	CHECK(actions == (BLE_RELAY_DO_DROP | BLE_RELAY_DO_WAKE));
	CHECK(ble_relay_connect_result(&s) == -ECONNRESET);
	(void)ble_relay_on_socket_closed(&s);

	(void)ble_relay_on_connect(&s, 0, &actions);
	(void)ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0);
	CHECK(ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0) ==
	      (BLE_RELAY_DO_DROP | BLE_RELAY_DO_WAKE));
	(void)ble_relay_on_socket_closed(&s);

	(void)ble_relay_on_connect(&s, 0, &actions);
	CHECK(ble_relay_on_broken(&s) == (BLE_RELAY_DO_DROP | BLE_RELAY_DO_WAKE));
	CHECK(s.reason == BLE_RELAY_REASON_PROTOCOL);
}

static void test_handback_ends_the_stream_with_a_close(void)
{
	struct ble_relay_session s;
	uint32_t actions;

	ble_relay_session_init(&s);
	CHECK(ble_relay_on_handback(&s) == 0);
	(void)ble_relay_on_channel(&s, true);
	(void)ble_relay_on_connect(&s, 0, &actions);
	(void)ble_relay_on_frame(&s, BLE_RELAY_OPENED, NULL, 0);
	CHECK(ble_relay_on_handback(&s) == (BLE_RELAY_DO_WAKE | BLE_RELAY_DO_CLOSE));
	CHECK(s.reason == BLE_RELAY_REASON_HANDBACK);
	CHECK(ble_relay_on_handback(&s) == 0);
}

/* ---- offering the relay -------------------------------------------------------------------- */

static uint32_t seconds(struct ble_relay_offer *offer, const struct ble_relay_view *view, int n)
{
	uint32_t all = 0;

	for (int i = 0; i < n; i++) {
		all |= ble_relay_offer_tick(offer, view);
	}
	return all;
}

static void test_offered_only_after_a_minute_without_wifi(void)
{
	struct ble_relay_offer offer;
	struct ble_relay_view view = { .provisioned = true };

	ble_relay_offer_init(&offer);
	CHECK(seconds(&offer, &view, BLE_RELAY_OFFER_AFTER_SECONDS - 1) == 0);
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_OFFER_START);
	CHECK(offer.offering);
	CHECK(seconds(&offer, &view, 100) == 0);

	/* Wi-Fi is back, with no relayed connection: the offer goes at once. */
	view.wifi_up = true;
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_OFFER_STOP);

	/* A flap of Wi-Fi starts the minute over. */
	view.wifi_up = false;
	CHECK(seconds(&offer, &view, 30) == 0);
	view.wifi_up = true;
	(void)ble_relay_offer_tick(&offer, &view);
	view.wifi_up = false;
	CHECK(seconds(&offer, &view, BLE_RELAY_OFFER_AFTER_SECONDS - 1) == 0);
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_OFFER_START);
}

static void test_never_offered_unprovisioned_or_during_a_window(void)
{
	struct ble_relay_offer offer;
	struct ble_relay_view view = { 0 };

	ble_relay_offer_init(&offer);
	CHECK(seconds(&offer, &view, 600) == 0);

	view.provisioned = true;
	view.window = true;
	CHECK(seconds(&offer, &view, 600) == 0);

	/* The window closes: Wi-Fi has long been down, so the offer comes at once. */
	view.window = false;
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_OFFER_START);
	/* A window opens over it: the window has the radio. */
	view.window = true;
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_OFFER_STOP);
}

static void test_a_relayed_connection_is_handed_back_to_wifi(void)
{
	struct ble_relay_offer offer;
	struct ble_relay_view view = { .provisioned = true };
	uint32_t all;

	ble_relay_offer_init(&offer);
	(void)seconds(&offer, &view, BLE_RELAY_OFFER_AFTER_SECONDS);
	view.channel = true;
	view.cloud_relayed = true;
	view.cloud_up = true;
	CHECK(seconds(&offer, &view, 10) == 0);

	/* Wi-Fi back: the phone stays until Wi-Fi has held for the hand-back time. */
	view.wifi_up = true;
	CHECK(seconds(&offer, &view, BLE_RELAY_HANDBACK_SECONDS - 1) == 0);
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_HANDBACK);
	CHECK(ble_relay_offer_tick(&offer, &view) == BLE_RELAY_HANDBACK);

	/* The connection has ended: the offer goes. */
	view.cloud_up = false;
	view.cloud_relayed = false;
	all = ble_relay_offer_tick(&offer, &view);
	CHECK(all == BLE_RELAY_OFFER_STOP);
	CHECK(!offer.offering);
}

static void test_the_path_for_a_connection(void)
{
	CHECK(!ble_relay_use_relay(true, true));
	CHECK(!ble_relay_use_relay(true, false));
	CHECK(ble_relay_use_relay(false, true));
	CHECK(!ble_relay_use_relay(false, false));
}

static void test_credits_never_exceed_the_room(void)
{
	CHECK(ble_relay_credits_due(768, 0, 247) == 3);
	CHECK(ble_relay_credits_due(768, 2, 247) == 1);
	CHECK(ble_relay_credits_due(768, 3, 247) == 0);
	CHECK(ble_relay_credits_due(768, 9, 247) == 0);
	CHECK(ble_relay_credits_due(246, 0, 247) == 0);
	CHECK(ble_relay_credits_due(768, 0, 0) == 0);
	CHECK(ble_relay_credits_due((size_t)70000 * 2, 0, 1) == UINT16_MAX);
}

/* ---- the samples the apps check against ----------------------------------------------------- */

static void print_samples(void)
{
	uint8_t out[200];
	uint8_t data[5] = { 0x16, 0x03, 0x03, 0x00, 0x01 };

	hex("hello", out, ble_relay_hello(240, thing, out, sizeof(out)));
	hex("open", out, ble_relay_open(host, 8883, out, sizeof(out)));
	ble_relay_header(BLE_RELAY_DATA, sizeof(data), out);
	memcpy(&out[3], data, sizeof(data));
	hex("data", out, 3 + (int)sizeof(data));
	ble_relay_header(BLE_RELAY_OPENED, 0, out);
	hex("opened", out, 3);
	hex("close", out, ble_relay_close(BLE_RELAY_REASON_REFUSED, out));
}

int main(int argc, char **argv)
{
	if (argc > 1 && strcmp(argv[1], "--print") == 0) {
		print_samples();
		return 0;
	}

	test_header_is_type_then_length_little_endian();
	test_hello_carries_version_room_and_name();
	test_open_carries_port_and_host();
	test_close_is_one_byte();
	test_reader_gets_the_same_whatever_the_pieces();
	test_reader_refuses_what_is_too_long();
	test_reader_stops_at_each_item();
	test_a_stream_from_channel_to_close();
	test_the_board_closes_its_socket();
	test_refused_and_timed_out_opens();
	test_the_link_goes();
	test_a_phone_that_breaks_the_protocol_loses_the_channel();
	test_handback_ends_the_stream_with_a_close();
	test_offered_only_after_a_minute_without_wifi();
	test_never_offered_unprovisioned_or_during_a_window();
	test_a_relayed_connection_is_handed_back_to_wifi();
	test_the_path_for_a_connection();
	test_credits_never_exceed_the_room();

	printf("ble_relay_tests: %d checks, %d failures\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
