/*
 * Host-side tests of src/cloud/sessions.c (from 1.18.0): the JSON of a listening session and of what is
 * on the decks now, the dates they carry, what is refused (the cloud drops what the contract does not
 * keep, cloud/api/src/lib/sessions.mjs), that a text with a quote or a control character is made safe,
 * and that nothing is ever written past the buffer it is given.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sessions.h"

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
		checks++;                                                                    \
		if (strcmp((actual), (expected)) != 0) {                                     \
			failures++;                                                          \
			printf("FAIL %s:%d: got \"%s\", expected \"%s\"\n", __FILE__, __LINE__, \
			       (actual), (expected));                                        \
		}                                                                            \
	} while (0)

/* cloud.c, which publishes in the firmware, is a fake here. */
static struct {
	int sent;
	char json[SESSION_JSON_MAX + 8];
	int result;
} fake;

int cloud_session_publish(const char *json)
{
	fake.sent++;
	snprintf(fake.json, sizeof(fake.json), "%s", json);
	return fake.result;
}

#define START 1794276000LL /* 2026-11-10T02:00:00Z */

static void test_times_round_trip_and_bad_ones_are_refused(void)
{
	int64_t value = 0;
	char text[SESSION_TIME_MAX];

	CHECK(session_time_parse("2026-11-10T02:00:00Z", &value) == 0);
	CHECK(value == START);
	session_time_format(START, text);
	CHECK_TEXT(text, "2026-11-10T02:00:00Z");

	/* Leap days, the end of a year, and the earliest time the cloud takes. */
	CHECK(session_time_parse("2028-02-29T23:59:59Z", &value) == 0);
	session_time_format(value, text);
	CHECK_TEXT(text, "2028-02-29T23:59:59Z");
	CHECK(session_time_parse("2024-01-01T00:00:00Z", &value) == 0);
	CHECK(value == SESSION_EARLIEST_S);
	CHECK(session_time_parse("2027-12-31T23:59:59Z", &value) == 0);
	session_time_format(value + 1, text);
	CHECK_TEXT(text, "2028-01-01T00:00:00Z");
	CHECK(session_time_parse("1970-01-01T00:00:00Z", &value) == 0 && value == 0);

	const char *const bad[] = { "", "yesterday", "2026-11-10 02:00:00Z", "2026-11-10T02:00:00",
				    "2026-11-10T02:00:00+01:00", "2026-13-10T02:00:00Z",
				    "2026-02-29T02:00:00Z", "2026-11-31T02:00:00Z", "2026-11-10T24:00:00Z",
				    "2026-11-10T02:60:00Z", "2026-11-10T02:00:60Z", "2026-11-10T02:00:00.5Z",
				    "2026-11-1AT02:00:00Z", "2026-11-00T02:00:00Z" };

	for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
		CHECK(session_time_parse(bad[i], &value) == -EINVAL);
	}
	CHECK(session_time_parse(NULL, &value) == -EINVAL);
}

static struct session_track track(const char *title, const char *artist, int64_t at, uint16_t length)
{
	struct session_track made = { .title = title, .artist = artist, .played_at = at, .duration_s = length };

	return made;
}

static void test_a_session_message_is_what_the_cloud_expects(void)
{
	char buf[SESSION_JSON_MAX];
	struct session_track one = track("Strobe", "deadmau5", START + 552, 600);

	CHECK(session_format_session(buf, sizeof(buf), "a1", START, START + 7200, "Friday set", &one, 1) > 0);
	CHECK_TEXT(buf,
		   "{\"v\":1,\"type\":\"session\",\"id\":\"a1\",\"startedAt\":\"2026-11-10T02:00:00Z\","
		   "\"endedAt\":\"2026-11-10T04:00:00Z\",\"title\":\"Friday set\",\"tracks\":[{\"title\":"
		   "\"Strobe\",\"artist\":\"deadmau5\",\"playedAt\":\"2026-11-10T02:09:12Z\",\"durationS\":600}]}");

	/* Only a start: no end, no title, no tracks. */
	CHECK(session_format_session(buf, sizeof(buf), "a1", START, -1, NULL, NULL, 0) > 0);
	CHECK_TEXT(buf, "{\"v\":1,\"type\":\"session\",\"id\":\"a1\",\"startedAt\":\"2026-11-10T02:00:00Z\"}");
}

static void test_now_playing_messages(void)
{
	char buf[SESSION_JSON_MAX];
	struct session_track one = track("Strobe", "", START + 5, 600);

	CHECK(session_format_now(buf, sizeof(buf), &one) > 0);
	CHECK_TEXT(buf,
		   "{\"v\":1,\"type\":\"now\",\"playing\":true,\"title\":\"Strobe\",\"artist\":\"\","
		   "\"playedAt\":\"2026-11-10T02:00:05Z\",\"durationS\":600}");
	CHECK(session_format_now(buf, sizeof(buf), NULL) > 0);
	CHECK_TEXT(buf, "{\"v\":1,\"type\":\"now\",\"playing\":false}");
}

static void test_what_the_cloud_would_refuse_is_refused_here(void)
{
	char buf[SESSION_JSON_MAX];
	struct session_track good = track("Strobe", "deadmau5", START + 10, 60);
	struct session_track bad;

	CHECK(session_format_session(buf, sizeof(buf), "", START, -1, NULL, NULL, 0) == -EINVAL);
	CHECK(session_format_session(buf, sizeof(buf), "has space", START, -1, NULL, NULL, 0) == -EINVAL);
	CHECK(session_format_session(buf, sizeof(buf), "12345678901234567", START, -1, NULL, NULL, 0) == -EINVAL);
	CHECK(session_format_session(buf, sizeof(buf), NULL, START, -1, NULL, NULL, 0) == -EINVAL);
	/* Before 2024, an end before the start, an end more than a day on, a blank title. */
	CHECK(session_format_session(buf, sizeof(buf), "a", 1000, -1, NULL, NULL, 0) == -EINVAL);
	CHECK(session_format_session(buf, sizeof(buf), "a", START, START - 1, NULL, NULL, 0) == -EINVAL);
	CHECK(session_format_session(buf, sizeof(buf), "a", START, START + 86401, NULL, NULL, 0) == -EINVAL);
	CHECK(session_format_session(buf, sizeof(buf), "a", START, -1, "   ", NULL, 0) == -EINVAL);
	/* More tracks than a message carries. */
	CHECK(session_format_session(buf, sizeof(buf), "a", START, -1, NULL, &good, 2) == -EINVAL);
	/* A track outside its session, with no length, too long, nameless, or without an artist. */
	bad = track("Strobe", "x", START - 1, 60);
	CHECK(session_format_session(buf, sizeof(buf), "a", START, -1, NULL, &bad, 1) == -EINVAL);
	bad = track("Strobe", "x", START + 100, 60);
	CHECK(session_format_session(buf, sizeof(buf), "a", START, START + 50, NULL, &bad, 1) == -EINVAL);
	bad = track("Strobe", "x", START + 10, 0);
	CHECK(session_format_now(buf, sizeof(buf), &bad) == -EINVAL);
	bad = track("Strobe", "x", START + 10, 14401);
	CHECK(session_format_now(buf, sizeof(buf), &bad) == -EINVAL);
	bad = track("", "x", START + 10, 60);
	CHECK(session_format_now(buf, sizeof(buf), &bad) == -EINVAL);
	bad = track("Strobe", NULL, START + 10, 60);
	CHECK(session_format_now(buf, sizeof(buf), &bad) == -EINVAL);
	bad = track("Strobe", "x", 5, 60);
	CHECK(session_format_now(buf, sizeof(buf), &bad) == -EINVAL);
}

static void test_texts_are_made_safe_and_cut(void)
{
	char buf[SESSION_JSON_MAX];
	struct session_track tricky = track("A \"quote\" and \\ slash\n\x01\xc3\xa9", "x", START + 10, 60);
	char longest[SESSION_TEXT_MAX + 20];

	CHECK(session_format_now(buf, sizeof(buf), &tricky) > 0);
	CHECK(strstr(buf, "\"title\":\"A \\\"quote\\\" and \\\\ slash???\"") != NULL ||
	      strstr(buf, "\"title\":\"A \\\"quote\\\" and \\\\ slash????\"") != NULL);
	/* No control character and nothing but ASCII is in it. */
	for (const char *c = buf; *c != '\0'; c++) {
		CHECK((unsigned char)*c >= 0x20 && (unsigned char)*c < 0x7f);
	}

	memset(longest, 'x', sizeof(longest) - 1);
	longest[sizeof(longest) - 1] = '\0';
	tricky = track(longest, "y", START + 10, 60);
	CHECK(session_format_now(buf, sizeof(buf), &tricky) > 0);
	CHECK(strstr(buf, "\"title\":\"xxxx") != NULL);
	CHECK(strstr(buf, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") == NULL);
}

static void test_nothing_is_written_past_the_buffer(void)
{
	struct session_track one = track("Strobe", "deadmau5", START + 552, 600);
	/* Canaries on both sides of a buffer of every size up to the message's own length. */
	for (size_t size = 1; size < 330; size++) {
		char arena[400];
		char *buf = arena + 20;
		int length;

		memset(arena, 0x5a, sizeof(arena));
		length = session_format_session(buf, size, "a1", START, START + 7200, "Friday set", &one, 1);
		CHECK(length > 0 || length == -ENOSPC);
		if (length > 0) {
			CHECK((size_t)length < size);
			CHECK(buf[length] == '\0');
		}
		for (size_t i = 0; i < 20; i++) {
			CHECK(arena[i] == 0x5a);
		}
		for (size_t i = 20 + size; i < sizeof(arena); i++) {
			CHECK(arena[i] == 0x5a);
		}
	}
	/* The longest texts of every field still fit the message's size, or are refused whole. */
	{
		char title[SESSION_TEXT_MAX + 1];
		char buf[SESSION_JSON_MAX];
		struct session_track big;
		int length;

		memset(title, 'q', SESSION_TEXT_MAX);
		title[SESSION_TEXT_MAX] = '\0';
		big = track(title, title, START + 10, 14400);
		length = session_format_session(buf, sizeof(buf), "0123456789abcdef", START, START + 7200, title,
						&big, 1);
		CHECK(length > 0 && length < SESSION_JSON_MAX);
	}
}

static void test_sending_goes_through_the_cloud(void)
{
	char scratch[SESSION_JSON_MAX];
	struct session_track one = track("Strobe", "deadmau5", START + 10, 60);

	memset(&fake, 0, sizeof(fake));
	CHECK(session_send_now(scratch, sizeof(scratch), &one) == 0);
	CHECK(fake.sent == 1);
	CHECK(strstr(fake.json, "\"playing\":true") != NULL);

	/* The cloud's refusal comes back; a message that is not valid is not sent at all. */
	fake.result = -ENOTCONN;
	CHECK(session_send_now(scratch, sizeof(scratch), &one) == -ENOTCONN);
	fake.sent = 0;
	CHECK(session_send_session(scratch, sizeof(scratch), "", START, -1, NULL, NULL, 0) == -EINVAL);
	CHECK(fake.sent == 0);

	/* The test session: three messages, in order, every one under the limit. */
	fake.result = 0;
	CHECK(session_test_send(START) == 0);
	CHECK(fake.sent == 3);
	CHECK(strstr(fake.json, "\"endedAt\":\"2026-11-10T02:02:10Z\"") != NULL);
	fake.sent = 0;
	fake.result = -ENOTCONN;
	CHECK(session_test_send(START) == -ENOTCONN);
	CHECK(fake.sent == 1);
}

int main(void)
{
	test_times_round_trip_and_bad_ones_are_refused();
	test_a_session_message_is_what_the_cloud_expects();
	test_now_playing_messages();
	test_what_the_cloud_would_refuse_is_refused_here();
	test_texts_are_made_safe_and_cut();
	test_nothing_is_written_past_the_buffer();
	test_sending_goes_through_the_cloud();

	printf("%d session checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
