/*
 * Host-side tests of what src/pi/pi_rx.c does with a message's text from the Raspberry Pi before it
 * is kept or printed: control characters and bytes that are not valid UTF-8 become '?', valid text is
 * left as it is, and a message is never cut inside a character.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pi_rx.h"

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

/* Cleans `in` (n bytes) and checks that it became `want`, of the same length. */
static void check_clean(const char *in, size_t n, const char *want, int line)
{
	uint8_t buf[64];

	memcpy(buf, in, n);
	pi_rx_clean_text(buf, n);
	checks++;
	if (memcmp(buf, want, n) != 0) {
		failures++;
		printf("FAIL %s:%d: cleaning gave \"", __FILE__, line);
		for (size_t i = 0; i < n; i++) {
			printf(buf[i] >= 0x20 && buf[i] < 0x7f ? "%c" : "\\x%02x", buf[i]);
		}
		printf("\"\n");
	}
}

#define CLEAN(in, want)                                                                      \
	do {                                                                                 \
		_Static_assert(sizeof(in) == sizeof(want), "the same length");               \
		check_clean(in, sizeof(in) - 1, want, __LINE__);                             \
	} while (0)

static void test_valid_text_is_left_as_it_is(void)
{
	CLEAN("np|Daft Punk|One More Time|1", "np|Daft Punk|One More Time|1");
	/* é, an em dash, two CJK characters and an emoji: 2, 3, 3 and 4 bytes. */
	CLEAN("Beyonc\xc3\xa9 \xe2\x80\x94 \xe6\x9d\xb1\xe4\xba\xac \xf0\x9f\x8e\xa7",
	      "Beyonc\xc3\xa9 \xe2\x80\x94 \xe6\x9d\xb1\xe4\xba\xac \xf0\x9f\x8e\xa7");
	/* U+00A0, just above the C1 controls, and U+10FFFF, the last code point. */
	CLEAN("\xc2\xa0", "\xc2\xa0");
	CLEAN("\xf4\x8f\xbf\xbf", "\xf4\x8f\xbf\xbf");
}

static void test_control_characters_become_question_marks(void)
{
	CLEAN("a\x1b[2Jb", "a?[2Jb");
	CLEAN("a\r\nb\x7f", "a??b?");
	CLEAN("\x01\x1f", "??");
	/* U+009B, the 8-bit CSI, written as UTF-8: both of its bytes. */
	CLEAN("\xc2\x9b" "31m", "??31m");
	CLEAN("\xc2\x80\xc2\x9f", "????");
}

static void test_bytes_that_are_not_valid_utf8_become_question_marks(void)
{
	/* A lone 0x9b, the 8-bit CSI, and other lone continuation bytes. */
	CLEAN("\x9b" "31m", "?31m");
	CLEAN("a\x80\xbf" "b", "a??b");
	/* Overlong forms. */
	CLEAN("\xc0\xaf", "??");
	CLEAN("\xc1\xbf", "??");
	CLEAN("\xe0\x80\x80", "???");
	CLEAN("\xf0\x8f\xbf\xbf", "????");
	/* A surrogate, U+D800. */
	CLEAN("\xed\xa0\x80", "???");
	/* Above U+10FFFF. */
	CLEAN("\xf4\x90\x80\x80", "????");
	CLEAN("\xf5\x80\x80\x80", "????");
	/* Bytes that never appear in UTF-8. */
	CLEAN("\xfe\xff", "??");
	/* A sequence cut off by the end of the payload, and one cut off by another character. */
	CLEAN("ok\xe2\x82", "ok??");
	CLEAN("\xf0\x9f\x8e", "???");
	CLEAN("\xe2\x82" "a", "??a");
}

static void test_random_bytes(void)
{
	uint8_t buf[48];
	uint8_t again[48];
	unsigned int seed = 1;

	for (int round = 0; round < 2000; round++) {
		size_t n = 1 + round % sizeof(buf);

		for (size_t i = 0; i < n; i++) {
			seed = seed * 1103515245u + 12345u;
			/* Half of them continuation bytes, so that sequences of every length come up. */
			buf[i] = (seed >> 16) & 1 ? 0x80 | ((seed >> 8) & 0x3f) : (uint8_t)(seed >> 8);
		}
		pi_rx_clean_text(buf, n);
		/* What it gives is clean: cleaning it again changes nothing. */
		memcpy(again, buf, n);
		pi_rx_clean_text(again, n);
		CHECK(memcmp(again, buf, n) == 0);
		for (size_t i = 0; i < n; i++) {
			CHECK(buf[i] >= 0x20 && buf[i] != 0x7f && buf[i] < 0xf5 && buf[i] != 0xc0 && buf[i] != 0xc1);
		}
	}
}

static void test_a_cut_is_never_inside_a_character(void)
{
	/* "ab" then é (2 bytes), € (3 bytes) and 🎧 (4 bytes). */
	const uint8_t text[] = "ab\xc3\xa9\xe2\x82\xac\xf0\x9f\x8e\xa7";
	const size_t length = sizeof(text) - 1;

	/* Shorter than the limit: all of it. */
	CHECK(pi_rx_text_cut(text, length, 100) == length);
	CHECK(pi_rx_text_cut(text, length, length) == length);
	/* At a character's start. */
	CHECK(pi_rx_text_cut(text, length, 2) == 2);
	CHECK(pi_rx_text_cut(text, length, 4) == 4);
	CHECK(pi_rx_text_cut(text, length, 7) == 7);
	/* Inside é, inside €, inside 🎧: back to where that character starts. */
	CHECK(pi_rx_text_cut(text, length, 3) == 2);
	CHECK(pi_rx_text_cut(text, length, 5) == 4);
	CHECK(pi_rx_text_cut(text, length, 6) == 4);
	CHECK(pi_rx_text_cut(text, length, 8) == 7);
	CHECK(pi_rx_text_cut(text, length, 10) == 7);
	CHECK(pi_rx_text_cut(text, length, 0) == 0);
	CHECK(pi_rx_text_cut(text, 0, 10) == 0);
}

int main(void)
{
	test_valid_text_is_left_as_it_is();
	test_control_characters_become_question_marks();
	test_bytes_that_are_not_valid_utf8_become_question_marks();
	test_random_bytes();
	test_a_cut_is_never_inside_a_character();

	printf("%d pi rx checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
