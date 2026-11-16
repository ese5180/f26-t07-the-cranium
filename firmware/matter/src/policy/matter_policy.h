/*
 * The commissioner's rules that need no radio: checking a setup code before anything starts, how long to wait
 * before trying again, whether a device is reconnected or commissioned, and which Thread channel keeps clear of
 * the Wi-Fi channel. Plain C, so that firmware/tests/host can run them on the build machine.
 *
 * The rules come from commissioning in practice (docs/matter-thread.md, "Lessons kept"): a bad setup code must
 * not leave the commissioner busy, retries back off but never stop for good, and a device already on the fabric
 * is never commissioned again.
 */
#ifndef MATTER_POLICY_H_
#define MATTER_POLICY_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* What a manual pairing code (11 or 21 digits, the number printed under a Matter QR code) holds. */
struct mp_manual_code {
	uint32_t passcode;
	/* The short discriminator: the top 4 bits of the 12-bit one, all a manual code carries. */
	uint8_t short_discriminator;
	bool has_vid_pid;
	uint16_t vendor_id;
	uint16_t product_id;
};

enum mp_code_error {
	MP_CODE_OK = 0,
	MP_CODE_EMPTY,
	MP_CODE_LENGTH,     /* not 11 or 21 digits once dashes and spaces are left out */
	MP_CODE_NOT_DIGITS,
	MP_CODE_CHECK_DIGIT, /* the Verhoeff check digit is wrong: a typo */
	MP_CODE_FIRST_DIGIT, /* 8 or 9 first: a later version of the format, or not a manual code */
	MP_CODE_VID_PID,     /* 21 digits, but the first digit says there is no vendor and product */
	MP_CODE_PASSCODE,    /* 0, over 99999998, or one the specification forbids (11111111, 12345678, ...) */
};

/* Reads a manual pairing code. Dashes and spaces are skipped. Nothing is written to out unless it is valid. */
enum mp_code_error mp_parse_manual_code(const char *text, struct mp_manual_code *out);

/*
 * The board's own onboarding codes, for a phone to commission it: the QR code payload ("MT:" and 19 base-38
 * characters) and the 11-digit manual code. discovery: 0x02 Bluetooth LE, 0x04 on the IP network.
 */
void mp_qr_payload(uint16_t vendor_id, uint16_t product_id, uint8_t discovery, uint16_t discriminator,
		   uint32_t passcode, char out[23]);
void mp_manual_code(uint16_t discriminator, uint32_t passcode, char out[12]);

/* Whether a passcode is one a device may have (Matter specification 5.1.7.1). */
bool mp_passcode_valid(uint32_t passcode);

/* The Verhoeff check digit of a string of decimal digits, or -1 if it holds anything else. */
int mp_verhoeff_check_digit(const char *digits, size_t len);

/* A QR code payload: "MT:" and at least the base-38 characters of the version-0 payload, all base-38. */
bool mp_qr_code_plausible(const char *text);

/*
 * How long to wait before attempt number `attempt` (0 for the first retry) of something that must keep being
 * tried: commissioning, becoming Thread leader, reconnecting to a device. It doubles from first_ms to cap_ms and
 * then stays there; it never gives up.
 */
uint32_t mp_backoff_ms(uint32_t attempt, uint32_t first_ms, uint32_t cap_ms);

/* The delays the firmware uses. */
#define MP_RECONNECT_FIRST_MS 10000u  /* after a restart, mains-powered devices are back within seconds */
#define MP_RETRY_FIRST_MS     15000u
#define MP_RETRY_CAP_MS       300000u
/* Bluetooth scans for one device before an attempt counts as failed; each scan is 60 s at most. */
#define MP_BLE_SCANS_PER_ATTEMPT 3u

enum mp_action {
	MP_ACTION_COMMISSION, /* new to this fabric: Bluetooth, PASE, credentials, CASE */
	MP_ACTION_RECONNECT,  /* on the fabric already: CASE over Thread, never commission again */
	MP_ACTION_WAIT,       /* busy with another device, or Thread is not up: try again later */
	MP_ACTION_REFUSE,     /* the node ID is taken by another device: commissioning would orphan it */
};

struct mp_device_view {
	bool on_fabric;         /* the commissioner holds an operational record for this node ID */
	bool same_device;       /* that record is this device (same vendor, product and discriminator) */
	bool thread_ready;      /* this board is Thread leader (or router) */
	bool commissioner_busy; /* another commissioning is running */
};

/* What to do with a device asked for by node ID. */
enum mp_action mp_decide(const struct mp_device_view *view);

/*
 * Whether an IEEE 802.15.4 channel (11 to 26) is clear of a 2.4 GHz Wi-Fi channel (1 to 14): their bands do
 * not overlap, with a guard of 1 MHz. A Wi-Fi channel of 0 means none, or 5 GHz: every Thread channel is clear.
 */
bool mp_thread_channel_clear(uint8_t thread_channel, uint8_t wifi_channel);

/* The Thread channel farthest from the Wi-Fi channel; 25 when there is no 2.4 GHz Wi-Fi. */
uint8_t mp_pick_thread_channel(uint8_t wifi_channel);

#ifdef __cplusplus
}
#endif

#endif /* MATTER_POLICY_H_ */
