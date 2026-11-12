/*
 * See matter_policy.h.
 */
#include "matter_policy.h"

#include <string.h>

/* Verhoeff tables (dihedral group D5). */
static const uint8_t verhoeff_d[10][10] = {
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, {1, 2, 3, 4, 0, 6, 7, 8, 9, 5},
	{2, 3, 4, 0, 1, 7, 8, 9, 5, 6}, {3, 4, 0, 1, 2, 8, 9, 5, 6, 7},
	{4, 0, 1, 2, 3, 9, 5, 6, 7, 8}, {5, 9, 8, 7, 6, 0, 4, 3, 2, 1},
	{6, 5, 9, 8, 7, 1, 0, 4, 3, 2}, {7, 6, 5, 9, 8, 2, 1, 0, 4, 3},
	{8, 7, 6, 5, 9, 3, 2, 1, 0, 4}, {9, 8, 7, 6, 5, 4, 3, 2, 1, 0},
};
static const uint8_t verhoeff_p[8][10] = {
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, {1, 5, 7, 6, 2, 8, 3, 0, 9, 4},
	{5, 8, 0, 3, 7, 9, 6, 1, 4, 2}, {8, 9, 1, 6, 0, 4, 3, 5, 2, 7},
	{9, 4, 5, 3, 1, 2, 6, 8, 7, 0}, {4, 2, 8, 6, 5, 7, 3, 9, 0, 1},
	{2, 7, 9, 3, 8, 0, 6, 4, 1, 5}, {7, 0, 4, 6, 9, 1, 3, 2, 5, 8},
};
static const uint8_t verhoeff_inv[10] = {0, 4, 3, 2, 1, 5, 6, 7, 8, 9};

int mp_verhoeff_check_digit(const char *digits, size_t len)
{
	uint8_t c = 0;

	for (size_t i = 0; i < len; i++) {
		char ch = digits[len - 1 - i];

		if (ch < '0' || ch > '9') {
			return -1;
		}
		c = verhoeff_d[c][verhoeff_p[(i + 1) % 8][ch - '0']];
	}
	return verhoeff_inv[c];
}

bool mp_passcode_valid(uint32_t passcode)
{
	static const uint32_t forbidden[] = {
		0,        11111111, 22222222, 33333333, 44444444, 55555555,
		66666666, 77777777, 88888888, 99999999, 12345678, 87654321,
	};

	if (passcode > 99999998u) {
		return false;
	}
	for (size_t i = 0; i < sizeof(forbidden) / sizeof(forbidden[0]); i++) {
		if (passcode == forbidden[i]) {
			return false;
		}
	}
	return true;
}

static uint32_t digits_value(const char *d, size_t n)
{
	uint32_t v = 0;

	for (size_t i = 0; i < n; i++) {
		v = v * 10u + (uint32_t)(d[i] - '0');
	}
	return v;
}

enum mp_code_error mp_parse_manual_code(const char *text, struct mp_manual_code *out)
{
	char d[22];
	size_t n = 0;

	if (text == NULL || text[0] == '\0') {
		return MP_CODE_EMPTY;
	}
	for (const char *p = text; *p != '\0'; p++) {
		if (*p == '-' || *p == ' ') {
			continue;
		}
		if (*p < '0' || *p > '9') {
			return MP_CODE_NOT_DIGITS;
		}
		if (n == sizeof(d) - 1) {
			return MP_CODE_LENGTH;
		}
		d[n++] = *p;
	}
	d[n] = '\0';
	if (n == 0) {
		return MP_CODE_EMPTY;
	}
	if (n != 11 && n != 21) {
		return MP_CODE_LENGTH;
	}
	if (mp_verhoeff_check_digit(d, n - 1) != d[n - 1] - '0') {
		return MP_CODE_CHECK_DIGIT;
	}

	uint32_t chunk1 = (uint32_t)(d[0] - '0');

	if (chunk1 > 7) {
		return MP_CODE_FIRST_DIGIT;
	}
	bool vid_pid = (chunk1 & 0x4u) != 0;

	if (vid_pid != (n == 21)) {
		return MP_CODE_VID_PID;
	}

	uint32_t chunk2 = digits_value(&d[1], 5);
	uint32_t chunk3 = digits_value(&d[6], 4);

	if (chunk2 > 0xFFFFu || chunk3 > 0x1FFFu) {
		return MP_CODE_PASSCODE;
	}

	uint32_t passcode = (chunk3 << 14) | (chunk2 & 0x3FFFu);

	if (!mp_passcode_valid(passcode)) {
		return MP_CODE_PASSCODE;
	}

	uint32_t vid = 0;
	uint32_t pid = 0;

	if (vid_pid) {
		vid = digits_value(&d[10], 5);
		pid = digits_value(&d[15], 5);
		if (vid > 0xFFFFu || pid > 0xFFFFu) {
			return MP_CODE_VID_PID;
		}
	}

	if (out != NULL) {
		out->passcode = passcode;
		out->short_discriminator = (uint8_t)(((chunk1 & 0x3u) << 2) | (chunk2 >> 14));
		out->has_vid_pid = vid_pid;
		out->vendor_id = (uint16_t)vid;
		out->product_id = (uint16_t)pid;
	}
	return MP_CODE_OK;
}

bool mp_qr_code_plausible(const char *text)
{
	/* A version-0 payload is 88 bits: 15 base-38 characters at least (5 chars per 3 bytes, 3 per 2). */
	static const char alphabet[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";
	size_t n;

	if (text == NULL || strncmp(text, "MT:", 3) != 0) {
		return false;
	}
	n = strlen(text + 3);
	if (n < 19) {
		return false;
	}
	for (size_t i = 0; i < n; i++) {
		if (memchr(alphabet, text[3 + i], sizeof(alphabet) - 1) == NULL) {
			return false;
		}
	}
	return true;
}

uint32_t mp_backoff_ms(uint32_t attempt, uint32_t first_ms, uint32_t cap_ms)
{
	uint32_t ms = first_ms;

	if (first_ms >= cap_ms) {
		return cap_ms;
	}
	for (uint32_t i = 0; i < attempt; i++) {
		if (ms >= cap_ms / 2u) {
			return cap_ms;
		}
		ms *= 2u;
	}
	return ms;
}

enum mp_action mp_decide(const struct mp_device_view *view)
{
	if (view->on_fabric) {
		/* Reconnecting needs Thread but not the commissioner. */
		if (!view->same_device) {
			return MP_ACTION_REFUSE;
		}
		return view->thread_ready ? MP_ACTION_RECONNECT : MP_ACTION_WAIT;
	}
	if (!view->thread_ready || view->commissioner_busy) {
		return MP_ACTION_WAIT;
	}
	return MP_ACTION_COMMISSION;
}

/* Centre frequencies in MHz. */
static int thread_centre(uint8_t ch)
{
	return 2405 + 5 * ((int)ch - 11);
}

static int wifi_centre(uint8_t ch)
{
	return ch == 14 ? 2484 : 2407 + 5 * (int)ch;
}

bool mp_thread_channel_clear(uint8_t thread_channel, uint8_t wifi_channel)
{
	if (thread_channel < 11 || thread_channel > 26) {
		return false;
	}
	if (wifi_channel == 0 || wifi_channel > 14) {
		return true;
	}

	int gap = thread_centre(thread_channel) - wifi_centre(wifi_channel);

	if (gap < 0) {
		gap = -gap;
	}
	/* Half of 20 MHz Wi-Fi, half of 2 MHz Thread, and 1 MHz of guard. */
	return gap >= 10 + 1 + 1;
}

uint8_t mp_pick_thread_channel(uint8_t wifi_channel)
{
	uint8_t best = 25;
	int best_gap = -1;

	if (wifi_channel == 0 || wifi_channel > 14) {
		return 25;
	}
	/* 26 is last: some regions allow it only at low power. */
	for (uint8_t ch = 11; ch <= 25; ch++) {
		int gap = thread_centre(ch) - wifi_centre(wifi_channel);

		if (gap < 0) {
			gap = -gap;
		}
		if (gap > best_gap) {
			best_gap = gap;
			best = ch;
		}
	}
	return best;
}

void mp_qr_payload(uint16_t vendor_id, uint16_t product_id, uint8_t discovery, uint16_t discriminator,
		   uint32_t passcode, char out[23])
{
	static const char alphabet[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";
	uint8_t bits[11] = {0};
	unsigned int pos = 0;
	const struct {
		uint32_t value;
		unsigned int width;
	} fields[] = {
		{0, 3}, {vendor_id, 16}, {product_id, 16}, {0, 2}, {discovery, 8},
		{discriminator & 0x0FFFu, 12}, {passcode & 0x07FFFFFFu, 27}, {0, 4},
	};

	/* Packed least significant bit first. */
	for (size_t f = 0; f < sizeof(fields) / sizeof(fields[0]); f++) {
		for (unsigned int b = 0; b < fields[f].width; b++, pos++) {
			if (fields[f].value & (1u << b)) {
				bits[pos / 8] |= (uint8_t)(1u << (pos % 8));
			}
		}
	}
	memcpy(out, "MT:", 3);
	size_t n = 3;

	for (size_t i = 0; i < sizeof(bits); i += 3) {
		size_t take = sizeof(bits) - i < 3 ? sizeof(bits) - i : 3;
		uint32_t v = 0;
		unsigned int chars = take == 3 ? 5 : take == 2 ? 4 : 2;

		for (size_t k = 0; k < take; k++) {
			v |= (uint32_t)bits[i + k] << (8 * k);
		}
		for (unsigned int k = 0; k < chars; k++) {
			out[n++] = alphabet[v % 38];
			v /= 38;
		}
	}
	out[n] = '\0';
}

void mp_manual_code(uint16_t discriminator, uint32_t passcode, char out[12])
{
	uint8_t s = (uint8_t)((discriminator >> 8) & 0x0F);
	uint32_t chunk1 = s >> 2;
	uint32_t chunk2 = ((uint32_t)(s & 3u) << 14) | (passcode & 0x3FFFu);
	uint32_t chunk3 = (passcode >> 14) & 0x1FFFu;
	uint32_t parts[3] = {chunk1, chunk2, chunk3};
	unsigned int widths[3] = {1, 5, 4};
	size_t n = 0;

	for (int p = 0; p < 3; p++) {
		for (int d = (int)widths[p] - 1; d >= 0; d--) {
			uint32_t div = 1;

			for (int k = 0; k < d; k++) {
				div *= 10;
			}
			out[n++] = (char)('0' + (parts[p] / div) % 10);
		}
	}
	out[n] = (char)('0' + mp_verhoeff_check_digit(out, n));
	out[n + 1] = '\0';
}
