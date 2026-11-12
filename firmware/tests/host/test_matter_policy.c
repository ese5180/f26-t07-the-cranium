/*
 * Host tests of the Matter commissioner's rules (firmware/matter/src/policy/matter_policy.c): setup codes,
 * back-off, reconnect versus commission, and the Thread channel next to Wi-Fi.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "matter_policy.h"

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

/* Builds a manual code from its fields, as the specification lays them out, with its check digit. */
static void make_code(char *out, uint32_t passcode, uint8_t short_disc, int vid, int pid)
{
	uint32_t chunk1 = ((vid >= 0) ? 4u : 0u) | (short_disc >> 2);
	uint32_t chunk2 = ((uint32_t)(short_disc & 3u) << 14) | (passcode & 0x3FFFu);
	uint32_t chunk3 = passcode >> 14;
	size_t n;

	if (vid >= 0) {
		snprintf(out, 32, "%u%05u%04u%05d%05d", chunk1, chunk2, chunk3, vid, pid);
	} else {
		snprintf(out, 32, "%u%05u%04u", chunk1, chunk2, chunk3);
	}
	n = strlen(out);
	out[n] = (char)('0' + mp_verhoeff_check_digit(out, n));
	out[n + 1] = '\0';
}

static void test_manual_codes(void)
{
	struct mp_manual_code code;
	char text[32];

	/* The Matter SDK's test device: passcode 20202021, discriminator 3840 (short 15). */
	CHECK(mp_parse_manual_code("34970112332", &code) == MP_CODE_OK);
	CHECK(code.passcode == 20202021u);
	CHECK(code.short_discriminator == 15);
	CHECK(!code.has_vid_pid);
	CHECK(mp_parse_manual_code("3497-011-2332", &code) == MP_CODE_OK);
	CHECK(mp_parse_manual_code("3497 0112 332", NULL) == MP_CODE_OK);

	/* Every single-digit typo is caught by the check digit. */
	for (size_t i = 0; i < 11; i++) {
		for (char c = '0'; c <= '9'; c++) {
			strcpy(text, "34970112332");
			if (text[i] == c) {
				continue;
			}
			text[i] = c;
			CHECK(mp_parse_manual_code(text, NULL) != MP_CODE_OK);
		}
	}
	/* And so is swapping two neighbours that differ. */
	strcpy(text, "43970112332");
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_CHECK_DIGIT);

	CHECK(mp_parse_manual_code("", NULL) == MP_CODE_EMPTY);
	CHECK(mp_parse_manual_code(NULL, NULL) == MP_CODE_EMPTY);
	CHECK(mp_parse_manual_code("--", NULL) == MP_CODE_EMPTY);
	CHECK(mp_parse_manual_code("3497011233", NULL) == MP_CODE_LENGTH);
	CHECK(mp_parse_manual_code("349701123321", NULL) == MP_CODE_LENGTH);
	CHECK(mp_parse_manual_code("3497011233x", NULL) == MP_CODE_NOT_DIGITS);
	CHECK(mp_parse_manual_code("MT:Y.K9042C00KA0648G00", NULL) == MP_CODE_NOT_DIGITS);
	CHECK(mp_parse_manual_code("1234567890123456789012345", NULL) == MP_CODE_LENGTH);

	/* Round trips over the whole range of fields. */
	for (uint32_t s = 0; s < 16; s++) {
		uint32_t passcodes[] = {1, 20202021, 99999998, 0x3FFF, 0x4000, 12345679};

		for (size_t i = 0; i < sizeof(passcodes) / sizeof(passcodes[0]); i++) {
			memset(&code, 0xAA, sizeof(code));
			make_code(text, passcodes[i], (uint8_t)s, -1, 0);
			CHECK(mp_parse_manual_code(text, &code) == MP_CODE_OK);
			CHECK(code.passcode == passcodes[i]);
			CHECK(code.short_discriminator == s);
			CHECK(!code.has_vid_pid);

			make_code(text, passcodes[i], (uint8_t)s, 0xFFF1, 0x8000);
			CHECK(strlen(text) == 21);
			CHECK(mp_parse_manual_code(text, &code) == MP_CODE_OK);
			CHECK(code.passcode == passcodes[i]);
			CHECK(code.short_discriminator == s);
			CHECK(code.has_vid_pid);
			CHECK(code.vendor_id == 0xFFF1);
			CHECK(code.product_id == 0x8000);
		}
	}

	/* Forbidden passcodes are refused, and nothing is written. */
	make_code(text, 12345678, 3, -1, 0);
	memset(&code, 0x55, sizeof(code));
	CHECK(mp_parse_manual_code(text, &code) == MP_CODE_PASSCODE);
	CHECK(code.passcode == 0x55555555u);
	make_code(text, 11111111, 3, -1, 0);
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_PASSCODE);
	make_code(text, 0, 3, -1, 0);
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_PASSCODE);

	/* 11 digits that claim a vendor and product, and 21 that do not. */
	strcpy(text, "7497011233");
	text[10] = (char)('0' + mp_verhoeff_check_digit(text, 10));
	text[11] = '\0';
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_VID_PID);
	strcpy(text, "34970112336553565535");
	text[20] = (char)('0' + mp_verhoeff_check_digit(text, 20));
	text[21] = '\0';
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_VID_PID);
	/* A vendor ID over 65535. */
	strcpy(text, "74970112339999900001");
	text[20] = (char)('0' + mp_verhoeff_check_digit(text, 20));
	text[21] = '\0';
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_VID_PID);
	/* A first digit of 8 or 9. */
	strcpy(text, "8497011233");
	text[10] = (char)('0' + mp_verhoeff_check_digit(text, 10));
	text[11] = '\0';
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_FIRST_DIGIT);
	/* A passcode over 99999998: chunk3 is 13 bits, so 8191 << 14 is reachable. */
	strcpy(text, "3000008191");
	text[10] = (char)('0' + mp_verhoeff_check_digit(text, 10));
	text[11] = '\0';
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_PASSCODE);
	/* chunk2 over 16 bits. */
	strcpy(text, "3999991233");
	text[10] = (char)('0' + mp_verhoeff_check_digit(text, 10));
	text[11] = '\0';
	CHECK(mp_parse_manual_code(text, NULL) == MP_CODE_PASSCODE);

	CHECK(mp_verhoeff_check_digit("12a", 3) == -1);
	CHECK(mp_verhoeff_check_digit("236", 3) == 3);
	CHECK(mp_passcode_valid(20202021));
	CHECK(!mp_passcode_valid(99999999));
	CHECK(!mp_passcode_valid(87654321));
}

static void test_qr_codes(void)
{
	/* The Matter SDK's test device. */
	CHECK(mp_qr_code_plausible("MT:Y.K9042C00KA0648G00"));
	CHECK(!mp_qr_code_plausible("MT:Y.K9042C00KA0"));
	CHECK(!mp_qr_code_plausible("Y.K9042C00KA0648G00"));
	CHECK(!mp_qr_code_plausible("mt:Y.K9042C00KA0648G00"));
	CHECK(!mp_qr_code_plausible("MT:y.K9042C00KA0648G00"));
	CHECK(!mp_qr_code_plausible("MT:Y.K9042C00KA0648G0 "));
	CHECK(!mp_qr_code_plausible(NULL));
}

static void test_backoff(void)
{
	CHECK(mp_backoff_ms(0, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS) == 15000u);
	CHECK(mp_backoff_ms(1, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS) == 30000u);
	CHECK(mp_backoff_ms(4, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS) == 240000u);
	CHECK(mp_backoff_ms(5, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS) == 300000u);
	/* Never gives up, never overflows, never shrinks. */
	uint32_t last = 0;

	for (uint32_t a = 0; a < 100000; a += 7) {
		uint32_t ms = mp_backoff_ms(a, MP_RETRY_FIRST_MS, MP_RETRY_CAP_MS);

		CHECK(ms >= last && ms <= MP_RETRY_CAP_MS && ms > 0);
		last = ms;
	}
	CHECK(mp_backoff_ms(0xFFFFFFFFu, 1, 0xFFFFFFFFu) == 0xFFFFFFFFu);
	CHECK(mp_backoff_ms(3, 500, 400) == 400);
	CHECK(mp_backoff_ms(0, MP_RECONNECT_FIRST_MS, MP_RETRY_CAP_MS) == 10000u);
}

static void test_decide(void)
{
	struct mp_device_view v;

	for (int bits = 0; bits < 16; bits++) {
		v.on_fabric = bits & 1;
		v.same_device = bits & 2;
		v.thread_ready = bits & 4;
		v.commissioner_busy = bits & 8;
		enum mp_action a = mp_decide(&v);

		/* A device on the fabric is never commissioned again. */
		if (v.on_fabric) {
			CHECK(a != MP_ACTION_COMMISSION);
		}
		/* Nothing starts before Thread is up. */
		if (!v.thread_ready) {
			CHECK(a == MP_ACTION_WAIT || a == MP_ACTION_REFUSE);
		}
		/* A busy commissioner does not stop a reconnect. */
		if (v.on_fabric && v.same_device && v.thread_ready) {
			CHECK(a == MP_ACTION_RECONNECT);
		}
		if (!v.on_fabric && v.thread_ready && !v.commissioner_busy) {
			CHECK(a == MP_ACTION_COMMISSION);
		}
		if (!v.on_fabric && v.commissioner_busy) {
			CHECK(a == MP_ACTION_WAIT);
		}
		if (v.on_fabric && !v.same_device) {
			CHECK(a == MP_ACTION_REFUSE);
		}
	}
}

static void test_channels(void)
{
	/* Wi-Fi 1 (2412 MHz) covers Thread 11 to 14 (2405 to 2420). */
	CHECK(!mp_thread_channel_clear(11, 1));
	CHECK(!mp_thread_channel_clear(13, 1));
	CHECK(mp_thread_channel_clear(15, 1));
	/* Wi-Fi 6 (2437) covers Thread 16 to 19. */
	CHECK(!mp_thread_channel_clear(17, 6));
	CHECK(mp_thread_channel_clear(15, 6));
	CHECK(mp_thread_channel_clear(20, 6));
	/* Wi-Fi 11 (2462) covers Thread 21 to 24; 15 is clear of it. */
	CHECK(!mp_thread_channel_clear(22, 11));
	CHECK(mp_thread_channel_clear(15, 11));
	CHECK(mp_thread_channel_clear(25, 11));
	/* No Wi-Fi, or 5 GHz. */
	CHECK(mp_thread_channel_clear(17, 0));
	CHECK(mp_thread_channel_clear(17, 36));
	CHECK(!mp_thread_channel_clear(10, 0));
	CHECK(!mp_thread_channel_clear(27, 0));

	CHECK(mp_pick_thread_channel(0) == 25);
	CHECK(mp_pick_thread_channel(36) == 25);
	CHECK(mp_pick_thread_channel(1) == 25);
	CHECK(mp_pick_thread_channel(6) == 25);
	CHECK(mp_pick_thread_channel(11) == 11);
	CHECK(mp_pick_thread_channel(14) == 11);
	for (uint8_t w = 1; w <= 14; w++) {
		uint8_t t = mp_pick_thread_channel(w);

		CHECK(t >= 11 && t <= 25);
		CHECK(mp_thread_channel_clear(t, w));
	}
}

int main(void)
{
	test_manual_codes();
	test_qr_codes();
	test_backoff();
	test_decide();
	test_channels();
	printf("matter policy: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
