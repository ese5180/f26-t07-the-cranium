/*
 * What the console's command code needs from the board. console.c and console_keys.c
 * implement this on the device; firmware/tests/host fakes it.
 */

#ifndef CONSOLE_PORT_H_
#define CONSOLE_PORT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "console_stream.h"

/*
 * One whole line of a reply, without its line ending. Only for the console task, which
 * may have to wait for room: a reply is never dropped. Log lines wait until the final
 * line of the reply has gone out.
 */
void console_port_reply(const char *text, size_t length, bool final);

/* One whole line from any thread, without its line ending. It never waits. */
void console_port_event(const char *text, size_t length);

/* Characters typed by the user, sent back. Only for the console task. */
void console_port_echo(const char *text, size_t length);

/*
 * Run a function on the main loop and return what it returned. The console task waits;
 * the main loop never waits for the console, so this cannot deadlock.
 */
int console_port_on_main(int (*function)(void *arg), void *arg);

/* Send out everything that is waiting, then restart. Does not return. */
void console_port_reboot(void);

/* A place for a test image to lose power: just before the init-complete flag. */
void console_port_before_init_flag(void);

#if defined(CONFIG_APP_TEST_FAULT_WIFI_DEAD)
/*
 * Stop the Wi-Fi chip's power: see src/fault_wifi.c. Runs on the main loop. -EALREADY if that has
 * been done, -ENOTSUP if the running image has no trailer, so that no revert could ever show.
 */
int console_port_wifi_dead(void);
#endif

/*
 * From 1.17.0, one check of the hardware self-test (SELFTEST, src/selftest.c). The checks are numbered
 * from 0 and run one at a time, on the console task, which waits for each: the Wi-Fi scan takes a few
 * seconds and the optional button step up to CONSOLE_SELFTEST_BUTTON_MS. Returns false past the last.
 * The detail never holds a network's name, an address or anything else that identifies a place.
 */
#define CONSOLE_SELFTEST_BUTTON_MS 10000
#define CONSOLE_SELFTEST_DETAIL    56

enum console_selftest_result {
	SELFTEST_PASS,
	SELFTEST_FAIL,
	/* Not run, with the reason in the detail. */
	SELFTEST_SKIP,
	/* Done, and only a person can tell: the LEDs. */
	SELFTEST_VISUAL,
};

struct console_selftest_check {
	const char *name;
	enum console_selftest_result result;
	char detail[CONSOLE_SELFTEST_DETAIL];
};

bool console_port_selftest(unsigned int index, bool press_button, struct console_selftest_check *out);

int64_t console_port_uptime_ms(void);
size_t console_port_free_heap(void);
const char *console_port_reset_reason(void);

/*
 * Creating the device's key pair, in steps. The first creates it inside TF-M and its
 * signing request, in memory; that takes seconds, so it runs on the console task, and on
 * failure *reason says in a few words what went wrong. The second puts the private key in
 * protected storage, in place of the old key and its certificate: it runs on the main loop.
 * The third prints the request as reply lines. The last wipes what the first left behind,
 * whatever happened. Nothing can read the key back out.
 */
int console_port_keygen_create(const char **reason);
int console_port_keygen_store(void);
int console_port_keygen_print(void);
void console_port_keygen_end(void);

/* Store a certificate that arrived through a stream. */
int console_port_store_certificate(enum console_stream_kind kind, const uint8_t *der,
				   size_t length);

#endif /* CONSOLE_PORT_H_ */
