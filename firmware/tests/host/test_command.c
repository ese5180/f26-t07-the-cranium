/*
 * Host-side tests of command.c: how a message on the commands topic is read, above all one that
 * nobody meant to be a command, and what the main loop does with a command and says about it. The
 * real file is compiled here, against fakes of the main loop's queue, the LEDs, the reports and the
 * location, with the address and undefined-behaviour sanitizers watching every read of a message.
 * It is built twice: as it is, and with CONFIG_APP_MEMFAULT, against fakes of src/mflt/mflt.h.
 */

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "command.c"
#include "cloud_events.h"

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
		if (strcmp(actual_, (expected)) != 0) {                                      \
			failures++;                                                          \
			printf("FAIL %s:%d: \"%s\", expected \"%s\"\n", __FILE__, __LINE__,  \
			       actual_, (expected));                                         \
		}                                                                            \
	} while (0)

#define ID  "3f9c2a1b7d4e6f80"
#define ID2 "a01b2c3d4e5f6789"

static struct {
	/* The main loop's queue: what was posted, and whether it is full. */
	void (*posted[4])(void);
	int posts;
	bool queue_full;
	/* The last [CMD] line, and how many there were. */
	char line[256];
	int lines;
	int identify_calls;
	unsigned int identify_seconds;
	int reports;
	int location_requests;
	enum location_hold hold;
	/* src/mflt/mflt.h, with CONFIG_APP_MEMFAULT only. */
	int heartbeats;
	int drains;
	int answers;
	uint16_t answer_seq;
} fake;

/* ---- what command.c calls ------------------------------------------------------------ */

int app_event_post(const struct app_event *event)
{
	CHECK(event->type == APP_EVENT_CALL);
	if (fake.queue_full || fake.posts >= (int)ARRAY_SIZE(fake.posted)) {
		return -ENOMSG;
	}
	fake.posted[fake.posts++] = event->call.function;
	return 0;
}

void console_event(const char *tag, const char *format, ...)
{
	va_list args;

	CHECK(strcmp(tag, "CMD") == 0);
	va_start(args, format);
	vsnprintf(fake.line, sizeof(fake.line), format, args);
	va_end(args);
	fake.lines++;
}

void ui_identify(unsigned int seconds)
{
	fake.identify_calls++;
	fake.identify_seconds = seconds;
}

void app_send_reports(void)
{
	fake.reports++;
}

enum location_hold location_request(void)
{
	fake.location_requests++;
	return fake.hold;
}

#if defined(CONFIG_APP_MEMFAULT)
void mflt_heartbeat_now(void)
{
	fake.heartbeats++;
}

void mflt_drain_now(void)
{
	fake.drains++;
}

void mflt_on_answer(uint16_t seq)
{
	fake.answers++;
	fake.answer_seq = seq;
}
#endif

/* ---- helpers ------------------------------------------------------------------------- */

static void start_over(void)
{
	memset(&fake, 0, sizeof(fake));
	atomic_set(&waiting, 0);
}

/* The main loop, running what was posted. */
static void run_loop(void)
{
	for (int i = 0; i < fake.posts; i++) {
		fake.posted[i]();
	}
	fake.posts = 0;
}

/* A message as it arrives: exactly that many bytes, with nothing readable after them. */
static enum command_fault parse_bytes(const char *bytes, size_t length, struct command *out)
{
	char *copy = malloc(length > 0 ? length : 1);
	enum command_fault fault;

	CHECK(copy != NULL);
	memcpy(copy, bytes, length);
	fault = command_parse(copy, length, out);
	free(copy);
	return fault;
}

static enum command_fault parse(const char *text, struct command *out)
{
	return parse_bytes(text, strlen(text), out);
}

/* What any result must be, good or bad. */
static void check_sane(const struct command *c, enum command_fault fault)
{
	size_t id_length = strlen(c->id);

	CHECK(c->fault == fault);
	CHECK(fault <= COMMAND_BUSY);
	CHECK(id_length == 0 || id_length == COMMAND_ID_LENGTH);
	for (size_t i = 0; i < id_length; i++) {
		CHECK(is_hex(c->id[i]));
	}
	CHECK(c->seconds >= 1 && c->seconds <= COMMAND_SECONDS_MAX);
	CHECK((fault == COMMAND_OK) == (c->kind != COMMAND_NONE));
	CHECK(fault != COMMAND_OK || id_length == COMMAND_ID_LENGTH);
}

/* ---- reading ------------------------------------------------------------------------- */

static void test_the_two_commands_as_the_console_sends_them(void)
{
	struct command c;

	CHECK(parse("{\"id\": \"" ID "\", \"cmd\": \"identify\", \"seconds\": 15}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_IDENTIFY);
	CHECK(c.seconds == 15);
	CHECK_TEXT(c.id, ID);
	check_sane(&c, COMMAND_OK);

	CHECK(parse("{\"id\":\"" ID2 "\",\"cmd\":\"report\"}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_REPORT);
	CHECK_TEXT(c.id, ID2);
	check_sane(&c, COMMAND_OK);

	/* Any order, any JSON white space, an id in capitals, and seconds with report. */
	CHECK(parse(" \r\n\t{ \"seconds\" :7 ,\"cmd\":\"identify\",\n\"id\":\"3F9C2A1B7D4E6F80\" }\n ", &c) ==
	      COMMAND_OK);
	CHECK(c.kind == COMMAND_IDENTIFY && c.seconds == 7);
	CHECK_TEXT(c.id, "3F9C2A1B7D4E6F80");
	CHECK(parse("{\"cmd\":\"report\",\"seconds\":30,\"id\":\"" ID "\"}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_REPORT);
}

static void test_seconds_from_1_to_60_or_else_15(void)
{
	static const struct {
		const char *seconds;
		uint8_t becomes;
	} cases[] = {
		{ "1", 1 }, { "60", 60 }, { "15", 15 }, { "42", 42 },
		{ "0", 15 }, { "61", 15 }, { "-5", 15 }, { "-0", 15 }, { "100", 15 },
		{ "4294967311", 15 }, { "99999999999999999999999999", 15 },
		/* 2^64 + 30: a count that wrapped would make it 30. */
		{ "18446744073709551646", 15 },
		{ "15.0", 15 }, { "1e1", 15 }, { "30.5", 15 }, { "6E1", 15 }, { "2e-1", 15 },
		{ "\"30\"", 15 }, { "true", 15 }, { "false", 15 }, { "null", 15 },
	};
	char json[160];
	struct command c;

	for (size_t i = 0; i < ARRAY_SIZE(cases); i++) {
		snprintf(json, sizeof(json), "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":%s}",
			 cases[i].seconds);
		CHECK(parse(json, &c) == COMMAND_OK);
		if (c.seconds != cases[i].becomes) {
			printf("seconds %s gave %u\n", cases[i].seconds, c.seconds);
		}
		CHECK(c.seconds == cases[i].becomes);
	}

	/* None at all. */
	CHECK(parse("{\"id\":\"" ID "\",\"cmd\":\"identify\"}", &c) == COMMAND_OK);
	CHECK(c.seconds == COMMAND_SECONDS_DEFAULT);
}

static void test_what_is_not_a_command(void)
{
	static const struct {
		const char *json;
		enum command_fault fault;
		/* The id goes into the answer. */
		bool id;
	} cases[] = {
		/* Not JSON, or not an object of plain values. */
		{ "", COMMAND_MALFORMED, false },
		{ " ", COMMAND_MALFORMED, false },
		{ "null", COMMAND_MALFORMED, false },
		{ "[\"" ID "\"]", COMMAND_MALFORMED, false },
		{ "\"identify\"", COMMAND_MALFORMED, false },
		{ "{", COMMAND_MALFORMED, false },
		{ "}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\"", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",}", COMMAND_MALFORMED, false },
		{ "{,\"id\":\"" ID "\"}", COMMAND_MALFORMED, false },
		{ "{\"id\" \"" ID "\"}", COMMAND_MALFORMED, false },
		{ "{\"id\":}", COMMAND_MALFORMED, false },
		{ "{id:\"" ID "\",cmd:\"identify\"}", COMMAND_MALFORMED, false },
		{ "{'id':'" ID "','cmd':'identify'}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\"}x", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\"}{\"id\":\"" ID2 "\",\"cmd\":\"report\"}",
		  COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":{}}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":[15]}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":{\"name\":\"identify\"}}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":015}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":-}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":1.}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":1e}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":+15}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":0x0f}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":NaN}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":tru}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":nulll}", COMMAND_MALFORMED, false },
		/* Strings: no escapes, no control characters, and an end. */
		{ "{\"id\":\"" ID "\",\"cmd\":\"ident\\u0069fy\"}", COMMAND_MALFORMED, false },
		{ "{\"\\u0069d\":\"" ID "\",\"cmd\":\"identify\"}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\\\"\"}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"iden\ntify\"}", COMMAND_MALFORMED, false },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify}", COMMAND_MALFORMED, false },
		/* The members: id, cmd and seconds, once each, and nothing else. */
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"extra\":1}", COMMAND_UNKNOWN_MEMBER, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"Seconds\":5}", COMMAND_UNKNOWN_MEMBER, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"report\",\"\":\"\"}", COMMAND_UNKNOWN_MEMBER, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"cmd\":\"report\"}", COMMAND_REPEATED_MEMBER, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":5,\"seconds\":6}", COMMAND_REPEATED_MEMBER,
		  true },
		{ "{\"id\":\"" ID "\",\"id\":\"" ID2 "\",\"cmd\":\"identify\"}", COMMAND_REPEATED_MEMBER, false },
		/* The id: 16 hexadecimal digits in a string. */
		{ "{\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{}", COMMAND_NO_ID, false },
		{ "{\"id\":\"3f9c2a1b7d4e6f8\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":\"3f9c2a1b7d4e6f801\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":\"3f9c2a1b7d4e6f8g\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":\" 3f9c2a1b7d4e6f8\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":\"3f9c2a1b-7d4e6f8\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":3966242104283070336,\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":null,\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":\"\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		{ "{\"id\":\"3f9c2a1b7d4e6f\xc3\xa9\",\"cmd\":\"identify\"}", COMMAND_NO_ID, false },
		/* The command: identify or report, as it is written. */
		{ "{\"id\":\"" ID "\"}", COMMAND_NO_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":7}", COMMAND_NO_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":null}", COMMAND_NO_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"IDENTIFY\"}", COMMAND_UNKNOWN_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"identify \"}", COMMAND_UNKNOWN_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"reboot\"}", COMMAND_UNKNOWN_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"factory_reset\"}", COMMAND_UNKNOWN_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"\"}", COMMAND_UNKNOWN_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"Memfault\"}", COMMAND_UNKNOWN_CMD, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack \",\"seq\":1}", COMMAND_UNKNOWN_CMD, true },
		/* memfault_ack's seq: once, a whole number from 0 to 65535. */
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\"}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":-1}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":65536}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":4294967297}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":1.5}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":1e2}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":\"7\"}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":null}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":true}", COMMAND_NO_SEQ, true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":1,\"seq\":2}", COMMAND_REPEATED_MEMBER,
		  true },
		{ "{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":1,\"ok\":true}", COMMAND_UNKNOWN_MEMBER,
		  true },
		{ "{\"cmd\":\"memfault_ack\",\"seq\":1}", COMMAND_NO_ID, false },
	};
	struct command c;

	for (size_t i = 0; i < ARRAY_SIZE(cases); i++) {
		enum command_fault fault = parse(cases[i].json, &c);

		if (fault != cases[i].fault || (c.id[0] != '\0') != cases[i].id) {
			printf("case %zu: %s gave %d, id \"%s\"\n", i, cases[i].json, fault, c.id);
		}
		CHECK(fault == cases[i].fault);
		CHECK((c.id[0] != '\0') == cases[i].id);
		CHECK(c.kind == COMMAND_NONE);
		check_sane(&c, fault);
	}
}

static void test_a_message_is_read_to_its_length_and_no_further(void)
{
	static const char good[] = "{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":20}";
	char buffer[COMMAND_MAX + 2];
	struct command c;

	/* Every message cut short is malformed, and no read goes past its end (the sanitizer says). */
	for (size_t length = 0; length < sizeof(good) - 1; length++) {
		CHECK(parse_bytes(good, length, &c) != COMMAND_OK);
		check_sane(&c, (enum command_fault)c.fault);
	}
	CHECK(parse_bytes(good, sizeof(good) - 1, &c) == COMMAND_OK);
	CHECK(c.seconds == 20);

	/* A NUL is a control character, wherever it is. */
	{
		char with_nul[sizeof(good)];

		memcpy(with_nul, good, sizeof(good));
		with_nul[12] = '\0';
		CHECK(parse_bytes(with_nul, sizeof(good) - 1, &c) == COMMAND_MALFORMED);
		CHECK(parse_bytes(good, sizeof(good), &c) == COMMAND_MALFORMED);
	}

	/* As long as it may be, white space and all, and one byte longer. */
	memset(buffer, ' ', sizeof(buffer));
	memcpy(buffer, good, sizeof(good) - 1);
	CHECK(parse_bytes(buffer, COMMAND_MAX, &c) == COMMAND_OK);
	CHECK(parse_bytes(buffer, COMMAND_MAX + 1, &c) == COMMAND_TOO_LONG);
	check_sane(&c, COMMAND_TOO_LONG);
	CHECK(c.id[0] == '\0');
	CHECK(command_parse(NULL, 0, &c) == COMMAND_MALFORMED);
}

/* Random bytes, and good messages with bytes changed, cut or doubled: never a bad read or result. */
static void test_whatever_arrives(void)
{
	static const char *const seeds[] = {
		"{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":15}",
		"{\"id\":\"" ID2 "\",\"cmd\":\"report\"}",
		"{ \"cmd\" : \"identify\" , \"seconds\" : 1e5 , \"id\" : \"" ID "\" }",
		"{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":65535}",
	};
	static const char alphabet[] = "{}[]\":,\\ \t\n-+.0123456789eEabcdefxyzidcmsrptnul\x01\x7f\xff";
	char message[COMMAND_MAX + 8];
	struct command c;
	unsigned int seed = 12345;
	int good = 0;

	for (int round = 0; round < 200000; round++) {
		size_t length;

		seed = seed * 1103515245U + 12345U;
		if (round % 2 == 0) {
			const char *base = seeds[(seed >> 8) % ARRAY_SIZE(seeds)];
			int changes = 1 + (int)((seed >> 4) % 4);

			length = strlen(base);
			memcpy(message, base, length);
			for (int i = 0; i < changes; i++) {
				seed = seed * 1103515245U + 12345U;
				message[(seed >> 8) % length] = alphabet[(seed >> 16) % (sizeof(alphabet) - 1)];
			}
			if ((seed >> 20) % 5 == 0) {
				length = (seed >> 3) % (length + 1);
			}
		} else {
			length = (seed >> 8) % sizeof(message);
			for (size_t i = 0; i < length; i++) {
				seed = seed * 1103515245U + 12345U;
				message[i] = alphabet[(seed >> 16) % (sizeof(alphabet) - 1)];
			}
		}

		check_sane(&c, parse_bytes(message, length, &c));
		good += c.fault == COMMAND_OK;
	}

	/* Some of the changed messages are still commands: the fuzzing reached past the first byte. */
	CHECK(good > 0);
}

/* ---- carrying out, and answering ----------------------------------------------------- */

static void received(const char *json)
{
	command_received(json, strlen(json));
}

static void test_identify_blinks_and_says_so(void)
{
	start_over();
	received("{\"id\":\"" ID "\",\"cmd\":\"identify\",\"seconds\":15}");

	/* Nothing happens on the MQTT library's thread but the handing over. */
	CHECK(fake.posts == 1);
	CHECK(fake.identify_calls == 0 && fake.lines == 0);

	run_loop();
	CHECK(fake.identify_calls == 1);
	CHECK(fake.identify_seconds == 15);
	CHECK(fake.lines == 1);
	CHECK_TEXT(fake.line, "identify for 15 s (" ID ")");
	CHECK(fake.reports == 0 && fake.location_requests == 0);

	received("{\"id\":\"" ID2 "\",\"cmd\":\"identify\",\"seconds\":99}");
	run_loop();
	CHECK(fake.identify_seconds == 15);
	CHECK_TEXT(fake.line, "identify for 15 s (" ID2 ")");

	received("{\"id\":\"" ID2 "\",\"cmd\":\"identify\",\"seconds\":60}");
	run_loop();
	CHECK(fake.identify_seconds == 60);
	CHECK_TEXT(fake.line, "identify for 60 s (" ID2 ")");
}

static void test_report_sends_everything_it_may(void)
{
	static const struct {
		enum location_hold hold;
		const char *line;
	} cases[] = {
		{ LOCATION_GO, "report: heartbeat, diagnostics and a location scan (" ID ")" },
		{ LOCATION_FLOOR, "report: heartbeat and diagnostics, no location scan: the last was less "
				  "than 10 minutes ago (" ID ")" },
		{ LOCATION_UPDATE, "report: heartbeat and diagnostics, no location scan: an update is under "
				   "way (" ID ")" },
		{ LOCATION_BLUETOOTH, "report: heartbeat and diagnostics, no location scan: Bluetooth is "
				      "open (" ID ")" },
		{ LOCATION_SCANNING, "report: heartbeat and diagnostics, no location scan: one is under way "
				     "(" ID ")" },
		{ LOCATION_OFFLINE, "report: heartbeat and diagnostics, no location scan: not connected (" ID
				    ")" },
		{ LOCATION_OFF, "report: heartbeat and diagnostics, no location scan: location is off until "
				"a restart (" ID ")" },
		{ LOCATION_RETRY, "report: heartbeat and diagnostics, no location scan: the Wi-Fi stack is "
				  "busy (" ID ")" },
		{ LOCATION_NONE, "report: heartbeat and diagnostics, no location scan: this board has no "
				 "Wi-Fi location (" ID ")" },
	};

	for (size_t i = 0; i < ARRAY_SIZE(cases); i++) {
		start_over();
		fake.hold = cases[i].hold;
		received("{\"id\":\"" ID "\",\"cmd\":\"report\"}");
		CHECK(fake.reports == 0);
		run_loop();
		CHECK(fake.reports == 1);
		CHECK(fake.location_requests == 1);
		CHECK(fake.identify_calls == 0);
		CHECK(fake.lines == 1);
		CHECK_TEXT(fake.line, cases[i].line);
		/* Each answer fits an event whole. */
		CHECK(strlen(fake.line) <= CLOUD_EVENTS_TEXT_MAX);
	}
}

static void test_what_is_ignored_says_why(void)
{
	start_over();
	received("{\"id\":\"" ID "\",\"cmd\":\"reboot\"}");
	run_loop();
	CHECK_TEXT(fake.line, "ignored: unknown cmd (" ID ")");

	received("{\"id\":\"" ID "\",\"cmd\":\"report\",\"text\":\"[BT] passkey 012345\"}");
	run_loop();
	CHECK_TEXT(fake.line, "ignored: unknown member (" ID ")");

	received("{\"id\":\"" ID "\"}");
	run_loop();
	CHECK_TEXT(fake.line, "ignored: no cmd (" ID ")");

	/* With no good id, there is none to say, and nothing of the message is repeated. */
	received("{\"id\":\"not-an-id\",\"cmd\":\"identify\"}");
	run_loop();
	CHECK_TEXT(fake.line, "ignored: no id");
	received("{\"id\":\"\\\"secret\\\"\",\"cmd\":\"identify\"}");
	run_loop();
	CHECK_TEXT(fake.line, "ignored: not a command");
	received("x");
	run_loop();
	CHECK_TEXT(fake.line, "ignored: not a command");

	{
		static const char start[] = "{\"id\":\"" ID "\",\"cmd\":\"identify\"}";
		static char long_message[COMMAND_MAX + 2];

		memset(long_message, ' ', sizeof(long_message) - 1);
		memcpy(long_message, start, sizeof(start) - 1);
		received(long_message);
		run_loop();
		CHECK_TEXT(fake.line, "ignored: too long");
	}

	/* Nothing was carried out. */
	CHECK(fake.identify_calls == 0 && fake.reports == 0 && fake.location_requests == 0);
	CHECK(fake.lines == 7);
}

static void test_one_waits_at_a_time(void)
{
	start_over();
	received("{\"id\":\"" ID "\",\"cmd\":\"identify\"}");
	CHECK(fake.posts == 1);

	/* A second before the main loop got to the first: answered at once, and dropped. */
	received("{\"id\":\"" ID2 "\",\"cmd\":\"report\"}");
	CHECK(fake.posts == 1);
	CHECK(fake.lines == 1);
	CHECK_TEXT(fake.line, "ignored: the board is busy (" ID2 ")");

	run_loop();
	CHECK(fake.identify_calls == 1);
	CHECK(fake.reports == 0);
	CHECK_TEXT(fake.line, "identify for 15 s (" ID ")");

	/* The main loop's queue is full: the same, and the next one gets through. */
	fake.queue_full = true;
	received("{\"id\":\"" ID2 "\",\"cmd\":\"report\"}");
	CHECK_TEXT(fake.line, "ignored: the board is busy (" ID2 ")");
	CHECK(atomic_get(&waiting) == 0);
	fake.queue_full = false;
	received("{\"id\":\"" ID2 "\",\"cmd\":\"report\"}");
	run_loop();
	CHECK(fake.reports == 1);
}

static void test_the_memfault_commands(void)
{
	struct command c;

	CHECK(parse("{\"id\":\"" ID "\",\"cmd\":\"memfault\"}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_MEMFAULT);
	check_sane(&c, COMMAND_OK);

	/* The answer for a chunk, as the function in AWS writes it: its whole range. */
	CHECK(parse("{\"id\":\"" ID2 "\",\"cmd\":\"memfault_ack\",\"seq\":4711}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_MEMFAULT_ACK && c.seq == 4711);
	check_sane(&c, COMMAND_OK);
	CHECK(parse("{\"seq\": 0, \"cmd\": \"memfault_ack\", \"id\": \"" ID "\"}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_MEMFAULT_ACK && c.seq == 0);
	CHECK(parse("{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":65535}", &c) == COMMAND_OK);
	CHECK(c.seq == 65535);

	/* seq with another command is nothing, as seconds is with report. */
	CHECK(parse("{\"id\":\"" ID "\",\"cmd\":\"report\",\"seq\":3}", &c) == COMMAND_OK);
	CHECK(c.kind == COMMAND_REPORT && c.seq == 0);
}

static void test_an_answer_for_a_chunk_is_never_answered_and_never_waits(void)
{
	start_over();

	received("{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":513}");
	CHECK(fake.posts == 0);
	CHECK(fake.lines == 0);
	CHECK(atomic_get(&waiting) == 0);
#if defined(CONFIG_APP_MEMFAULT)
	CHECK(fake.answers == 1 && fake.answer_seq == 513);
#endif

	/* A command waits for the main loop: the answer still goes through, and the command stays. */
	received("{\"id\":\"" ID2 "\",\"cmd\":\"identify\"}");
	CHECK(fake.posts == 1);
	received("{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":514}");
	CHECK(fake.posts == 1);
	CHECK(fake.lines == 0);
#if defined(CONFIG_APP_MEMFAULT)
	CHECK(fake.answers == 2 && fake.answer_seq == 514);
#endif
	run_loop();
	CHECK_TEXT(fake.line, "identify for 15 s (" ID2 ")");

	/* One that is not right is no answer, and is answered as any message that is not a command. */
	start_over();
	received("{\"id\":\"" ID "\",\"cmd\":\"memfault_ack\",\"seq\":70000}");
	run_loop();
	CHECK(fake.answers == 0);
	CHECK_TEXT(fake.line, "ignored: no seq (" ID ")");
}

static void test_memfault_takes_a_heartbeat_and_says_so(void)
{
	start_over();
	received("{\"id\":\"" ID "\",\"cmd\":\"memfault\"}");
	CHECK(fake.heartbeats == 0);
	run_loop();
	CHECK(fake.reports == 0);
	CHECK(fake.location_requests == 0);
#if defined(CONFIG_APP_MEMFAULT)
	CHECK(fake.heartbeats == 1);
	CHECK_TEXT(fake.line, "memfault: heartbeat taken, sending (" ID ")");
#else
	CHECK_TEXT(fake.line, "memfault: not in this firmware (" ID ")");
#endif

	/* report sends what Memfault data waits, along with the rest. */
	start_over();
	received("{\"id\":\"" ID2 "\",\"cmd\":\"report\"}");
	run_loop();
	CHECK(fake.reports == 1);
#if defined(CONFIG_APP_MEMFAULT)
	CHECK(fake.drains == 1);
	CHECK(fake.heartbeats == 0);
#endif
}

int main(void)
{
	test_the_two_commands_as_the_console_sends_them();
	test_seconds_from_1_to_60_or_else_15();
	test_what_is_not_a_command();
	test_a_message_is_read_to_its_length_and_no_further();
	test_whatever_arrives();
	test_identify_blinks_and_says_so();
	test_report_sends_everything_it_may();
	test_what_is_ignored_says_why();
	test_one_waits_at_a_time();
	test_the_memfault_commands();
	test_an_answer_for_a_chunk_is_never_answered_and_never_waits();
	test_memfault_takes_a_heartbeat_and_says_so();

	printf("%d command checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
