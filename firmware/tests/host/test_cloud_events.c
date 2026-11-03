/*
 * Host-side tests of cloud_events.c: what of the console's lines goes to the cloud, what never
 * does, what is replaced, the JSON it goes in, the ring that holds lines while the board is offline,
 * the rate limit, the order, and when a connection may carry them. The real file is compiled here,
 * against fakes of the cloud connection, the main loop's queue, the Wi-Fi credentials store and the
 * boot diary. Every message that goes out is parsed with cJSON, as the cloud would.
 *
 * Each console_event() call in the firmware, and each log line of its modules that could carry
 * something, has its line in test_every_line_of_the_firmware(), with what becomes of it.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <cJSON.h>

#include "cloud_events.c"

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

#define CHECK_TEXT(actual, expected)                                                         \
	do {                                                                                 \
		const char *actual_ = (actual);                                              \
		checks++;                                                                    \
		if (actual_ == NULL || strcmp(actual_, (expected)) != 0) {                   \
			failures++;                                                          \
			printf("FAIL %s:%d: \"%s\", expected \"%s\"\n", __FILE__, __LINE__,  \
			       actual_ != NULL ? actual_ : "(null)", (expected));            \
		}                                                                            \
	} while (0)

#define THING   "cranium-fe5b26c0c5b1dcd7"
#define BOOT    42
#define SENT_MAX 1024
/* Shaped like the name of an iPhone's hotspot: its apostrophe is three bytes of UTF-8. */
#define HOTSPOT "Tester\xe2\x80\x99s iPhone"

/* What the cloud got, as the cloud reads it. */
struct received {
	long long t;
	long long seq;
	long long boot;
	long long up;
	long long dropped;
	char tag[32];
	char text[CLOUD_EVENTS_TEXT_MAX * 2];
	char json[CLOUD_EVENTS_JSON_MAX + 1];
};

static struct {
	long long now_ms;
	bool connected;
	char ssid[NET_SSID_MAX + 1];

	/* The main loop's queue. */
	int posts;
	int queued_wakes;
	bool queue_full;

	/* What cloud_event_publish() was given, and what it answers. */
	struct received sent[SENT_MAX];
	int sends;
	int publish_result;
	/* Fails the publish with this number, -1 for none, after adding lines as another thread would. */
	int fail_at;
	int lines_during_publish;
} fake;

/* ---- what cloud_events.c calls -------------------------------------------------------- */

long long k_uptime_get(void)
{
	return fake.now_ms;
}

int app_event_post(const struct app_event *event)
{
	fake.posts++;
	CHECK(event->type == APP_EVENT_CALL);
	CHECK(event->call.function == cloud_events_send);

	if (fake.queue_full) {
		return -ENOMSG;
	}

	fake.queued_wakes++;
	return 0;
}

bool cloud_is_connected(void)
{
	return fake.connected;
}

size_t net_stored_ssid(char *buf, size_t len)
{
	snprintf(buf, len, "%s", fake.ssid);
	return strlen(buf);
}

uint32_t boot_diary_boots(void)
{
	return BOOT;
}

static long long number(const cJSON *object, const char *name)
{
	const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);

	return cJSON_IsNumber(item) ? (long long)item->valuedouble : -1;
}

static void add_line(const char *tag, const char *text);

int cloud_event_publish(const char *json)
{
	struct received *got;
	cJSON *parsed;

	if (fake.fail_at == fake.sends) {
		/* Other threads, over the seconds that this publish takes. */
		for (int i = 0; i < fake.lines_during_publish; i++) {
			fake.now_ms += 300;
			add_line("app", "while the main loop was publishing");
		}
		fake.fail_at = -1;
		return -EAGAIN;
	}

	if (fake.publish_result != 0) {
		return fake.publish_result;
	}

	CHECK(fake.sends < SENT_MAX);
	got = &fake.sent[fake.sends % SENT_MAX];
	memset(got, 0, sizeof(*got));
	CHECK(strlen(json) < sizeof(got->json));
	snprintf(got->json, sizeof(got->json), "%s", json);

	/* Valid JSON, and nothing in it but these. */
	parsed = cJSON_Parse(json);
	CHECK(parsed != NULL);
	if (parsed != NULL) {
		const cJSON *item;

		cJSON_ArrayForEach(item, parsed) {
			CHECK(strcmp(item->string, "t") == 0 || strcmp(item->string, "seq") == 0 ||
			      strcmp(item->string, "boot") == 0 || strcmp(item->string, "up") == 0 ||
			      strcmp(item->string, "dropped") == 0 || strcmp(item->string, "tag") == 0 ||
			      strcmp(item->string, "text") == 0);
		}

		got->t = number(parsed, "t");
		got->seq = number(parsed, "seq");
		got->boot = number(parsed, "boot");
		got->up = number(parsed, "up");
		got->dropped = cJSON_HasObjectItem(parsed, "dropped") ? number(parsed, "dropped") : 0;
		CHECK(!cJSON_HasObjectItem(parsed, "dropped") || got->dropped > 0);

		item = cJSON_GetObjectItemCaseSensitive(parsed, "tag");
		CHECK(cJSON_IsString(item));
		snprintf(got->tag, sizeof(got->tag), "%s", cJSON_IsString(item) ? item->valuestring : "");
		item = cJSON_GetObjectItemCaseSensitive(parsed, "text");
		CHECK(cJSON_IsString(item));
		snprintf(got->text, sizeof(got->text), "%s", cJSON_IsString(item) ? item->valuestring : "");
		CHECK(strlen(got->text) <= CLOUD_EVENTS_TEXT_MAX);
		for (const char *c = got->text; *c != '\0'; c++) {
			CHECK(*c >= ' ' && *c <= '~');
		}
		cJSON_Delete(parsed);
	}

	fake.sends++;
	return 0;
}

/* ---- helpers -------------------------------------------------------------------------- */

static void add_line(const char *tag, const char *text)
{
	cloud_events_add(tag, text, strlen(text));
}

/* A board that has just started: nothing waits, nothing was sent, and nothing is known of the topic. */
static void start_over(void)
{
	memset(ring, 0, sizeof(ring));
	oldest = 0;
	waiting = 0;
	next_seq = 1;
	missing = 0;
	tokens = (int64_t)CLOUD_EVENTS_BURST * MILLI;
	refilled_at = 0;
	atomic_set(&wake_posted, 0);
	atomic_set(&given_up, 0);
	memset(&link, 0, sizeof(link));
	link.probe_at = -1;

	memset(&fake, 0, sizeof(fake));
	fake.fail_at = -1;
	fake.now_ms = 1000;
}

/* What the main loop does with what it was given: one call per wake-up in its queue. */
static void main_loop_runs(void)
{
	while (fake.queued_wakes > 0) {
		fake.queued_wakes--;
		cloud_events_send();
	}
}

static void seconds_pass(int seconds)
{
	for (int i = 0; i < seconds; i++) {
		fake.now_ms += 1000;
		cloud_events_send();
		main_loop_runs();
	}
}

static void comes_up(void)
{
	fake.connected = true;
	cloud_events_on_cloud_up();
	main_loop_runs();
}

static void goes_down(void)
{
	fake.connected = false;
	cloud_events_on_cloud_down();
}

/* A connection over which AWS IoT has taken an event in this boot already. */
static void proven_connection(void)
{
	link.proven = true;
	comes_up();
}

/* The last line that went out. */
static const struct received *last(void)
{
	return fake.sends > 0 ? &fake.sent[(fake.sends - 1) % SENT_MAX] : NULL;
}

/* Send one line on a proven connection, and say what its text became; "" if it never went. */
static const char *becomes(const char *tag, const char *text)
{
	int before = fake.sends;

	add_line(tag, text);
	main_loop_runs();
	cloud_events_send();
	return fake.sends == before ? "" : last()->text;
}

/* Every message's seq follows the one before it and the lines it says are missing. */
static bool seq_adds_up(int from, long long first_seq)
{
	long long expected = first_seq;

	for (int i = from; i < fake.sends; i++) {
		const struct received *got = &fake.sent[i % SENT_MAX];

		if (got->seq != expected + got->dropped) {
			printf("seq %lld, expected %lld + %lld\n", got->seq, expected, got->dropped);
			return false;
		}
		expected = got->seq + 1;
	}

	return true;
}

/* ---- the message ---------------------------------------------------------------------- */

static void test_the_message(void)
{
	start_over();
	proven_connection();

	fake.now_ms = 61234;
	add_line("WIFI", "connected ip=10.0.0.7 rssi=-51");
	fake.now_ms = 61240;
	main_loop_runs();
	CHECK(fake.sends == 1);
	CHECK_TEXT(last()->json, "{\"t\":61234,\"seq\":1,\"boot\":42,\"up\":61240,\"tag\":\"WIFI\","
				 "\"text\":\"connected ip=10.0.0.7 rssi=-51\"}");

	/* Quotes and backslashes escaped; anything not printable ASCII, a byte at a time, a '?'. */
	CHECK_TEXT(becomes("cloud", "WRN: Job update rejected: {\"code\":\"x\\y\"}"),
		   "WRN: Job update rejected: {\"code\":\"x\\y\"}");
	CHECK(strstr(last()->json, "\"text\":\"WRN: Job update rejected: {\\\"code\\\":\\\"x\\\\y\\\"}\"}") != NULL);
	CHECK_TEXT(becomes("app", "tab\there, caf\xc3\xa9, bell\a, del\x7f"), "tab?here, caf??, bell?, del?");

	/* At most 160 characters: a longer text is cut and says so. */
	{
		char text[300];
		char expected[CLOUD_EVENTS_TEXT_MAX + 1];

		memset(text, 'a', sizeof(text) - 1);
		text[sizeof(text) - 1] = '\0';
		memset(expected, 'a', CLOUD_EVENTS_TEXT_MAX - 3);
		strcpy(expected + CLOUD_EVENTS_TEXT_MAX - 3, "...");
		CHECK_TEXT(becomes("app", text), expected);

		text[CLOUD_EVENTS_TEXT_MAX] = '\0';
		CHECK_TEXT(becomes("app", text), text);
		text[CLOUD_EVENTS_TEXT_MAX] = 'a';
		text[CLOUD_EVENTS_TEXT_MAX + 1] = '\0';
		CHECK_TEXT(becomes("app", text), expected);
	}

	/* The tag is the source's own, and the boot and the uptime of the send are in every one. */
	CHECK_TEXT(last()->tag, "app");
	CHECK(last()->boot == BOOT);
	CHECK(last()->up == fake.now_ms);
	CHECK(seq_adds_up(0, 1));
}

/* The longest message there can be fits its buffer, and the MQTT buffer with its topic. */
static void test_the_longest_message_fits(void)
{
	struct event worst = {
		.t = INT64_MAX,
		.seq = UINT32_MAX,
		.dropped = UINT32_MAX,
		.tag = "boot_diary",
	};
	char json[CLOUD_EVENTS_JSON_MAX + 8];
	const char topic[] = "cranium/" THING "/events";
	int length;

	memset(worst.text, '"', CLOUD_EVENTS_TEXT_MAX);
	worst.text[CLOUD_EVENTS_TEXT_MAX] = '\0';

	length = format_event(&worst, UINT32_MAX, INT64_MAX, json, CLOUD_EVENTS_JSON_MAX);
	CHECK(length == CLOUD_EVENTS_JSON_MAX - 1);
	CHECK((size_t)length == strlen(json));
	CHECK(format_event(&worst, UINT32_MAX, INT64_MAX, json, CLOUD_EVENTS_JSON_MAX - 1) == -ENOSPC);

	/* A fixed header of 3 bytes and the topic's length in 2, at QoS 0: as cloud.c asserts. */
	CHECK(sizeof(topic) - 1 == 39);
	CHECK(5 + (sizeof(topic) - 1) + (size_t)length <= 512);

	/* Every source's tag fits where it is kept. */
	for (size_t i = 0; i < ARRAY_SIZE(sources); i++) {
		CHECK(strlen(sources[i].tag) <= CLOUD_EVENTS_TAG_MAX);
	}

	/* And the longest real one: a cut text that is all quotes and backslashes. */
	{
		char text[300];
		struct cJSON *parsed;

		for (size_t i = 0; i < sizeof(text) - 1; i++) {
			text[i] = (i % 2) != 0 ? '"' : '\\';
		}
		text[sizeof(text) - 1] = '\0';

		start_over();
		proven_connection();
		fake.now_ms = INT32_MAX;
		add_line("boot_diary", text);
		main_loop_runs();
		CHECK(fake.sends == 1);
		CHECK(strlen(last()->json) < CLOUD_EVENTS_JSON_MAX);
		parsed = cJSON_Parse(last()->json);
		CHECK(parsed != NULL);
		cJSON_Delete(parsed);
	}
}

/* ---- what is never sent, and what is replaced ----------------------------------------- */

struct line {
	const char *tag;
	const char *text;
	/* What goes to the cloud: NULL for the text as it is, "" for nothing. */
	const char *becomes;
};

/*
 * The firmware's console_event() calls, each with a line it prints, and the log lines that carry a
 * value from outside. From git grep -n console_event firmware/app/src, and LOG_ with %s.
 */
static const struct line firmware_lines[] = {
	/* bt_ota.c */
	{ "BT", "refused a command: group 1, id 0, op 2", NULL },
	{ "BT", "refused an upload: not while an update is under way", NULL },
	{ "BT", "upload started, 456789 bytes", NULL },
	{ "BT", "a phone connected", NULL },
	{ "BT", "passkey 012345", "" },
	{ "BT", "paired: LE Secure Connections, authenticated", NULL },
	{ "BT", "pairing cancelled", NULL },
	{ "BT", "pairing failed: 4", NULL },
	{ "BT", "security not accepted: level 2, error 3", NULL },
	{ "BT", "link: interval 30.00 ms, latency 0, timeout 4000 ms", NULL },
	{ "BT", "link: PHY 2M out, 2M in", NULL },
	{ "BT", "link: packets up to 251 bytes out, 251 in", NULL },
	{ "BT", "the phone is gone: reason 0x13 (the phone closed the link)", NULL },
	{ "BT", "update over Bluetooth: 1.12.0+0 from 1.11.4+0, succeeded, proof cloud, update 3 of this board", NULL },
	{ "BT", "kept when it reaches the cloud; with no Wi-Fi in reach, hold Button 1, pair, and read the image list", NULL },
	{ "BT", "Bluetooth could not start: -5", NULL },
	{ "BT", "open for 180 s, to prove the image on trial", NULL },
	{ "BT", "advertising as Cranium-1A2B", NULL },
	{ "BT", "closed: nobody connected", NULL },
	{ "BT", "what arrived cannot be installed", NULL },
	{ "BT", "firmware 1.12.0+0 has arrived, hash 0011223344556677: press Button 1 to install it, Button 2 to erase it", NULL },
	{ "BT", "the image could not be installed", NULL },
	{ "BT", "trial: waiting for a minute of running", NULL },
	{ "BT", "not opening: an update is under way", NULL },
	/* console.c, console_cmd.c, main.c */
	{ "CONSOLE", "test image: losing power before the init flag", NULL },
	{ "CONSOLE", "stream aborted: idle timeout", NULL },
	{ "CONSOLE", "migrated: device id set to ABC123", NULL },
	{ "CONSOLE", "WIFI done on the serial console: save a WPA2 network and join it", NULL },
	/* fault_wifi.c, net.c */
	{ "WIFI", "test image: chip power cut", NULL },
	{ "WIFI", "test image: no trailer, so no revert could show: the chip stays on", NULL },
	{ "WIFI", "failed reason=wrong password", NULL },
	{ "WIFI", "failed reason=network not found", NULL },
	{ "WIFI", "connected ip=192.168.1.42 rssi=-51", NULL },
	{ "WIFI", "disconnected", NULL },
	/* stuck.c */
	{ "STUCK", "restarting reason=wifi_silent count=1", NULL },
	{ "stuck", "WRN: Restarted earlier for being stuck: reason=wifi_silent count=1", NULL },
	/* Log lines with a value from outside in them. */
	{ "net", "ERR: Leaving \"MyNetwork\": its security mode (2) is not allowed",
	  "ERR: Leaving the network: its security mode (2) is not allowed" },
	{ "net", "ERR: Leaving \"Some \"Other\" Net\": its security mode (2) is not allowed",
	  "ERR: Leaving the network: its security mode (2) is not allowed" },
	{ "cloud", "Connecting to AWS IoT as " THING, NULL },
	{ "cloud", "WRN: Job update rejected: {\"code\":\"InvalidStateTransition\",\"clientToken\":\"s3\"}", NULL },
	{ "ota", "ERR: Update cranium-1-12-0 failed: download_failed (cause -104)", NULL },
	{ "ota", "WRN: Refusing update job cranium-1-12-0: version_not_newer", NULL },
	{ "ota", "Downloading 456789 bytes of firmware 1.12.0+0 (attempt 1)", NULL },
	{ "ota", "Firmware 1.12.0+0 confirmed", NULL },
	{ "app", "Cranium firmware 1.12.0+0", NULL },
	{ "app", "Thing name: " THING, NULL },
	{ "app", "Connected to AWS IoT", NULL },
	{ "factory", "WRN: Factory reset: erasing all provisioned data", NULL },
	/* What no source in the firmware may send, and every module of Zephyr and the SDK. */
	{ "wpa_supp", "wlan0: CTRL-EVENT-CONNECTED - Connection to MyNetwork completed", "" },
	{ "net_mqtt_helper", "Publishing to topic: cranium/" THING "/events", "" },
	{ "downloader", "Connecting to bucket.s3.amazonaws.com", "" },
	{ "fota_download", "Downloading from https://bucket.s3.amazonaws.com/fw.bin?X-Amz-Signature=00", "" },
	{ "printk", "anything", "" },
	{ "cloud_events", "WRN: AWS IoT closed the connection right after an event", "" },
	{ "ota", "DBG: Using message ID 12", "" },
	{ "bt_ota", "Passkey for the phone: 012345", "" },
	{ "app", "-----BEGIN CERTIFICATE-----", "" },
	{ "app", "the PRIVATE KEY is here", "" },
	{ "app", "joining with password=correct-horse-battery", "" },
	{ "app", "Password: correct-horse-battery", "" },
	{ "net", "using psk=abcdef", "" },
	{ "app", "the passphrase is long", "" },
	{ "app", "client secret 1234", "" },
	{ "ota", "file=/fw.bin?X-Amz-Credential=AKIA&x-amz-signature=00", "" },
	/* URLs, with or without a query, are "a URL". */
	{ "ota", "fetching https://bucket.s3.amazonaws.com/firmware/1.12.0.bin now",
	  "fetching a URL now" },
	{ "cloud", "server mqtts://example-ats.iot.us-east-1.amazonaws.com:8883/mqtt",
	  "server a URL" },
	{ "app", "see \"http://x.example/y\" and ftp://z", "see \"a URL\" and a URL" },
	{ "app", "a ratio of 3:2, and a time of 10:30", NULL },
};

static void test_every_line_of_the_firmware(void)
{
	for (size_t i = 0; i < ARRAY_SIZE(firmware_lines); i++) {
		const struct line *line = &firmware_lines[i];
		const char *expected = line->becomes != NULL ? line->becomes : line->text;
		const char *got;

		start_over();
		proven_connection();
		strcpy(fake.ssid, "MyNetwork");
		got = becomes(line->tag, line->text);

		if (strcmp(got, expected) != 0) {
			printf("line %zu: [%s] %s\n", i, line->tag, line->text);
		}
		CHECK_TEXT(got, expected);

		/* A line that is never sent leaves no gap: it was never one of the events. */
		if (expected[0] == '\0') {
			CHECK(next_seq == 1);
			CHECK(waiting == 0);
		}
	}

	/* The passkey, whichever way it is written, and nothing of it anywhere else. */
	start_over();
	proven_connection();
	CHECK_TEXT(becomes("BT", "PASSKEY 012345"), "");
	CHECK_TEXT(becomes("BT", "the passkey is 012345"), "");
	CHECK_TEXT(becomes("BT", ""), "");
	CHECK(fake.sends == 0);
	CHECK(next_seq == 1);
}

static void test_network_names_are_taken_out(void)
{
	start_over();
	proven_connection();

	/* The stored network's name, wherever it stands, as a name of its own. */
	strcpy(fake.ssid, "MyNetwork");
	CHECK_TEXT(becomes("app", "joined MyNetwork, at last"), "joined the network, at last");
	CHECK_TEXT(becomes("ota", "MyNetwork"), "the network");
	CHECK_TEXT(becomes("ota", "MyNetworks and xMyNetwork"), "MyNetworks and xMyNetwork");

	strcpy(fake.ssid, "net");
	CHECK_TEXT(becomes("WIFI", "failed reason=network not found"), "failed reason=network not found");
	CHECK_TEXT(becomes("app", "net is down, net."), "the network is down, the network.");

	/* What is not ASCII in it is as it would be in a line. */
	strcpy(fake.ssid, HOTSPOT);
	CHECK_TEXT(becomes("app", "joined " HOTSPOT " now"), "joined the network now");
	strcpy(fake.ssid, "-x-");
	CHECK_TEXT(becomes("app", "a-x-b"), "athe networkb");

	/* No network stored: nothing is replaced but what the rules replace. */
	fake.ssid[0] = '\0';
	CHECK_TEXT(becomes("app", "joined MyNetwork"), "joined MyNetwork");
	CHECK_TEXT(becomes("net", "Leaving \"MyNetwork\": no"), "Leaving the network: no");
	CHECK_TEXT(becomes("WIFI", "joining \"half a name"), "joining the network");

	/* A text that the replacement makes longer is cut, and says so. */
	{
		char text[CLOUD_EVENTS_TEXT_MAX + 1];
		const char *got;

		strcpy(fake.ssid, "ab");
		memset(text, 'x', CLOUD_EVENTS_TEXT_MAX);
		text[CLOUD_EVENTS_TEXT_MAX] = '\0';
		memcpy(text + CLOUD_EVENTS_TEXT_MAX - 10, " ab ", 4);
		got = becomes("app", text);
		CHECK(strlen(got) == CLOUD_EVENTS_TEXT_MAX);
		CHECK(strstr(got, "ab") == NULL);
		CHECK(strcmp(got + CLOUD_EVENTS_TEXT_MAX - 3, "...") == 0);
	}
}

/* ---- the ring, the limit, the order --------------------------------------------------- */

static void test_offline_the_ring_keeps_the_last_32(void)
{
	char text[32];

	start_over();

	/* 40 lines, 300 ms apart: the limit lets every one in. */
	for (int i = 1; i <= 40; i++) {
		fake.now_ms += 300;
		snprintf(text, sizeof(text), "line %d", i);
		add_line("app", text);
	}

	CHECK(waiting == CLOUD_EVENTS_RING);
	CHECK(fake.posts == 0);

	/* When the cloud comes up: oldest first, with their times, and the first says 8 are missing. */
	proven_connection();
	seconds_pass(1);
	CHECK(fake.sends == CLOUD_EVENTS_RING);
	CHECK(fake.sent[0].seq == 9);
	CHECK(fake.sent[0].dropped == 8);
	CHECK_TEXT(fake.sent[0].text, "line 9");
	CHECK(fake.sent[0].t == 1000 + 9 * 300);
	for (int i = 1; i < CLOUD_EVENTS_RING; i++) {
		CHECK(fake.sent[i].seq == fake.sent[i - 1].seq + 1);
		CHECK(fake.sent[i].dropped == 0);
		CHECK(fake.sent[i].t == fake.sent[i - 1].t + 300);
		CHECK(fake.sent[i].up == fake.sent[0].up);
	}
	CHECK_TEXT(fake.sent[CLOUD_EVENTS_RING - 1].text, "line 40");
	CHECK(seq_adds_up(0, 1));

	/* Nothing is missing before the next one. */
	add_line("app", "line 41");
	main_loop_runs();
	CHECK(last()->seq == 41);
	CHECK(last()->dropped == 0);

	/* At most CLOUD_EVENTS_PER_CALL at a time: the main loop comes back for the rest. */
	start_over();
	for (int i = 0; i < 20; i++) {
		fake.now_ms += 300;
		add_line("app", "waiting");
	}
	link.proven = true;
	fake.connected = true;
	cloud_events_on_cloud_up();
	CHECK(fake.sends == CLOUD_EVENTS_PER_CALL);
	CHECK(fake.queued_wakes == 1);
	cloud_events_send();
	CHECK(fake.sends == 2 * CLOUD_EVENTS_PER_CALL);
	main_loop_runs();
	CHECK(fake.sends == 20);
	CHECK(fake.queued_wakes == 0);
	CHECK(seq_adds_up(0, 1));
}

static void test_the_rate_limit(void)
{
	int sent;

	start_over();
	proven_connection();

	/* 30 at once: the first 20 get in, and the next to get in says 10 are missing. */
	for (int i = 0; i < 30; i++) {
		add_line("app", "chatty");
	}
	main_loop_runs();
	CHECK(fake.sends == CLOUD_EVENTS_BURST);
	CHECK(fake.sent[CLOUD_EVENTS_BURST - 1].seq == CLOUD_EVENTS_BURST);

	fake.now_ms += 1000;
	add_line("app", "after a second");
	main_loop_runs();
	CHECK(last()->seq == 31);
	CHECK(last()->dropped == 10);
	CHECK(seq_adds_up(0, 1));

	/* A failure that prints 50 lines a second for a minute: 5 of them a second go. */
	sent = fake.sends;
	for (int ms = 0; ms < 60000; ms += 20) {
		fake.now_ms += 20;
		add_line("ota", "WRN: Download failed (-104): trying again");
		if (ms % 1000 == 0) {
			main_loop_runs();
			cloud_events_send();
		}
	}
	main_loop_runs();
	cloud_events_send();
	CHECK(fake.sends - sent >= 60 * CLOUD_EVENTS_PER_SECOND);
	CHECK(fake.sends - sent <= 60 * CLOUD_EVENTS_PER_SECOND + CLOUD_EVENTS_BURST);
	CHECK(seq_adds_up(0, 1));

	/* Quiet for a while, and the burst is there again, and no more than that. */
	fake.now_ms += 60000;
	sent = fake.sends;
	for (int i = 0; i < 2 * CLOUD_EVENTS_BURST; i++) {
		add_line("app", "after the quiet");
	}
	main_loop_runs();
	cloud_events_send();
	main_loop_runs();
	CHECK(fake.sends - sent == CLOUD_EVENTS_BURST);
	CHECK(seq_adds_up(0, 1));

	/* Offline, the limit and the ring together: whatever got lost, the numbers add up. */
	start_over();
	for (int ms = 0; ms < 30000; ms += 50) {
		fake.now_ms += 50;
		add_line("app", "offline and chatty");
	}
	proven_connection();
	seconds_pass(5);
	CHECK(fake.sends == CLOUD_EVENTS_RING);
	CHECK(fake.sent[0].dropped > 0);
	CHECK(seq_adds_up(0, 1));
	/* The lines the limit took after the last one that got in are for the next one to say. */
	CHECK(fake.sent[CLOUD_EVENTS_RING - 1].seq + missing == 30000 / 50);
	add_line("app", "and then");
	main_loop_runs();
	CHECK(last()->seq == 30000 / 50 + 1);
	CHECK(seq_adds_up(0, 1));
}

static void test_the_order_survives_a_failed_publish(void)
{
	char text[32];

	start_over();
	for (int i = 1; i <= 6; i++) {
		fake.now_ms += 300;
		snprintf(text, sizeof(text), "line %d", i);
		add_line("app", text);
	}

	/* The third fails: it stays at the front, and goes first next time. */
	fake.fail_at = 2;
	proven_connection();
	CHECK(fake.sends == 2);
	CHECK(waiting == 4);
	seconds_pass(1);
	CHECK(fake.sends == 6);
	for (int i = 0; i < 6; i++) {
		snprintf(text, sizeof(text), "line %d", i + 1);
		CHECK_TEXT(fake.sent[i].text, text);
		CHECK(fake.sent[i].seq == i + 1);
	}

	/* The cloud took nothing for a while: nothing is lost that fits in the ring. */
	fake.publish_result = -EAGAIN;
	for (int i = 0; i < 10; i++) {
		fake.now_ms += 300;
		add_line("app", "while the cloud is busy");
	}
	seconds_pass(3);
	CHECK(fake.sends == 6);
	CHECK(waiting == 10);
	fake.publish_result = 0;
	seconds_pass(2);
	CHECK(fake.sends == 16);
	CHECK(seq_adds_up(0, 1));

	/*
	 * Other threads fill the ring while one fails on its way out: it cannot go back, and the oldest
	 * that waits says so, as the ring does for the oldest it drops.
	 */
	start_over();
	add_line("app", "first");
	fake.fail_at = 0;
	fake.lines_during_publish = CLOUD_EVENTS_RING;
	link.proven = true;
	fake.connected = true;
	cloud_events_on_cloud_up();
	CHECK(fake.sends == 0);
	CHECK(waiting == CLOUD_EVENTS_RING);
	CHECK(ring[oldest].seq == 2);
	CHECK(ring[oldest].dropped == 1);
	seconds_pass(5);
	CHECK(fake.sends == CLOUD_EVENTS_RING);
	CHECK(fake.sent[0].seq == 2);
	CHECK(fake.sent[0].dropped == 1);
	CHECK(seq_adds_up(0, 1));
}

/* ---- the connection ------------------------------------------------------------------- */

static void test_a_connection_proves_the_topic_first(void)
{
	start_over();
	for (int i = 0; i < 5; i++) {
		fake.now_ms += 300;
		add_line("app", "waiting");
	}

	/* Nothing in the first seconds of the connection, where an update's messages go. */
	comes_up();
	seconds_pass(CLOUD_EVENTS_START_MS / 1000 - 1);
	CHECK(fake.sends == 0);

	/* Then one, and the rest only once the connection has lived with it. */
	seconds_pass(1);
	CHECK(fake.sends == 1);
	CHECK(fake.sent[0].seq == 1);
	add_line("app", "and another");
	main_loop_runs();
	seconds_pass(CLOUD_EVENTS_PROOF_MS / 1000 - 1);
	CHECK(fake.sends == 1);
	seconds_pass(1);
	CHECK(fake.sends == 6);
	CHECK(link.proven);
	CHECK(seq_adds_up(0, 1));

	/* From then on, a connection sends at once, and a line goes as soon as the main loop runs. */
	goes_down();
	add_line("app", "while offline");
	CHECK(fake.queued_wakes == 0);
	comes_up();
	CHECK(fake.sends == 7);
	add_line("app", "online");
	CHECK(fake.queued_wakes == 1);
	main_loop_runs();
	CHECK(fake.sends == 8);

	/* A connection that ends before its first event went proves nothing, and refuses nothing. */
	start_over();
	add_line("app", "waiting");
	comes_up();
	seconds_pass(1);
	goes_down();
	CHECK(link.refusals == 0);
	CHECK(!link.proven);
	comes_up();
	seconds_pass(CLOUD_EVENTS_START_MS / 1000);
	CHECK(fake.sends == 1);
}

static void test_a_topic_the_policy_refuses(void)
{
	start_over();
	add_line("app", "first");
	add_line("app", "second");

	/* The first event goes, and AWS IoT closes the connection: it goes back to the front. */
	comes_up();
	seconds_pass(CLOUD_EVENTS_START_MS / 1000);
	CHECK(fake.sends == 1);
	CHECK(waiting == 1);
	seconds_pass(1);
	goes_down();
	CHECK(link.refusals == 1);
	CHECK(waiting == 2);
	CHECK(!link.refused);

	/* The next connection tries it once more, and that is the last. */
	comes_up();
	seconds_pass(CLOUD_EVENTS_START_MS / 1000);
	CHECK(fake.sends == 2);
	CHECK(fake.sent[1].seq == 1);
	goes_down();
	CHECK(link.refused);
	CHECK(waiting == 2);

	/* From then on nothing goes, and nothing wakes the main loop for it, until a restart. */
	comes_up();
	add_line("app", "third");
	CHECK(fake.posts == 0);
	seconds_pass(60);
	CHECK(fake.sends == 2);

	/* A connection that lives on after its first event is no refusal, and the next is not judged. */
	start_over();
	add_line("app", "first");
	comes_up();
	seconds_pass(CLOUD_EVENTS_START_MS / 1000);
	seconds_pass(CLOUD_EVENTS_PROOF_MS / 1000);
	CHECK(link.proven);
	goes_down();
	CHECK(link.refusals == 0);
	add_line("app", "second");
	comes_up();
	CHECK(fake.sends == 2);
	goes_down();
	CHECK(link.refusals == 0);
	CHECK(!link.refused);
}

static void test_the_main_loop_is_woken_once(void)
{
	start_over();

	/* Offline: nobody is woken. The connection's coming up sends everything. */
	add_line("app", "one");
	CHECK(fake.posts == 0);

	proven_connection();
	CHECK(fake.sends == 1);

	/* Online: one wake-up for any number of lines, until the main loop has run it. */
	add_line("app", "two");
	add_line("app", "three");
	CHECK(fake.posts == 1);
	CHECK(fake.queued_wakes == 1);
	main_loop_runs();
	CHECK(fake.sends == 3);
	add_line("app", "four");
	CHECK(fake.posts == 2);
	main_loop_runs();

	/* A full queue: the next line tries again, and the tick sends what waits either way. */
	fake.queue_full = true;
	add_line("app", "five");
	CHECK(fake.posts == 3);
	CHECK(fake.queued_wakes == 0);
	fake.queue_full = false;
	add_line("app", "six");
	CHECK(fake.posts == 4);
	CHECK(fake.queued_wakes == 1);
	main_loop_runs();
	CHECK(fake.sends == 6);

	/* A line that is never sent wakes nobody. */
	add_line("BT", "passkey 012345");
	CHECK(fake.posts == 4);
	CHECK(seq_adds_up(0, 1));
}

int main(void)
{
	test_the_message();
	test_the_longest_message_fits();
	test_every_line_of_the_firmware();
	test_network_names_are_taken_out();
	test_offline_the_ring_keeps_the_last_32();
	test_the_rate_limit();
	test_the_order_survives_a_failed_publish();
	test_a_connection_proves_the_topic_first();
	test_a_topic_the_policy_refuses();
	test_the_main_loop_is_woken_once();

	printf("%d cloud event checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
