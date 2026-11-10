/*
 * Listening sessions and what is on the decks now, from 1.18.0: what Mixxx on the Raspberry Pi plays,
 * sent to the cloud for the customer site's Mixes pages and Now playing. See "Sessions" in
 * firmware/README.md and docs/customer-data.md ("The messages") for the contract; the cloud checks every
 * field again (cloud/api/src/lib/sessions.mjs) and drops a message that does not keep it.
 *
 * Messages go to cranium/<thing name>/session, at QoS 0, as JSON of at most SESSION_JSON_MAX bytes:
 *
 *   {"v":1,"type":"session","id":"t1","startedAt":"2026-11-10T02:00:00Z","endedAt":"2026-11-10T02:03:20Z",
 *    "title":"Test set","tracks":[{"title":"Strobe","artist":"deadmau5","playedAt":"2026-11-10T02:00:10Z",
 *    "durationS":60}]}
 *   {"v":1,"type":"now","playing":true,"title":"Strobe","artist":"deadmau5","playedAt":"2026-11-10T02:00:10Z",
 *    "durationS":60}
 *   {"v":1,"type":"now","playing":false}
 *
 * The board has no clock of its own: times are Unix seconds that the Pi link brings (the link is not in
 * this firmware yet), or, for SESSION_TEST, the time the person types. Formatting is here and publishing
 * is in cloud.c; both use a buffer the caller gives, so that no buffer of this module's own takes RAM.
 * Texts are cut to SESSION_TEXT_MAX characters and made printable ASCII, with a quote and a backslash
 * escaped, as the cloud takes no control character.
 */

#ifndef SESSIONS_H_
#define SESSIONS_H_

#include <stddef.h>
#include <stdint.h>

/* The longest message there is room for; a longer one is refused with -ENOSPC, never cut. */
#define SESSION_JSON_MAX    448
#define SESSION_TEXT_MAX    48
#define SESSION_TRACKS_MAX  1
#define SESSION_ID_MAX      16
/* "2026-11-10T02:00:00Z" and its NUL. */
#define SESSION_TIME_MAX    21
/* The cloud takes no time before 2024 (cloud/api/src/lib/sessions.mjs EARLIEST_MS). */
#define SESSION_EARLIEST_S  1704067200LL

struct session_track {
	const char *title;
	const char *artist;
	/* Unix seconds. */
	int64_t played_at;
	/* 1 to 14400. */
	uint16_t duration_s;
};

/* Strict "YYYY-MM-DDTHH:MM:SSZ" to Unix seconds: 0, or -EINVAL. */
int session_time_parse(const char *iso, int64_t *unix_s);

/* Unix seconds to "YYYY-MM-DDTHH:MM:SSZ" (SESSION_TIME_MAX bytes). */
void session_time_format(int64_t unix_s, char *out);

/*
 * The message of a session into buf: id (1 to SESSION_ID_MAX letters, digits, - and _), the start,
 * the end (a negative ended_s leaves it out), a title (NULL leaves it out) and count tracks, at most
 * SESSION_TRACKS_MAX. Returns the length, -EINVAL for what the cloud would refuse, or -ENOSPC.
 */
int session_format_session(char *buf, size_t size, const char *id, int64_t started_s, int64_t ended_s,
			   const char *title, const struct session_track *tracks, size_t count);

/* The message of what is on the decks now; NULL track is "nothing". */
int session_format_now(char *buf, size_t size, const struct session_track *track);

/*
 * Format and publish, with the caller's scratch buffer of at least SESSION_JSON_MAX bytes. Returns what
 * the formatter or cloud_session_publish() returns.
 */
int session_send_session(char *scratch, size_t size, const char *id, int64_t started_s, int64_t ended_s,
			 const char *title, const struct session_track *tracks, size_t count);
int session_send_now(char *scratch, size_t size, const struct session_track *track);

/*
 * For the console's SESSION_TEST|<time>, a test bench with no Pi: a fake session of two tracks, started
 * at the time given (Unix seconds, from session_time_parse), as three messages: the session with its
 * first track, the second track as now playing, and the session again, ended. Returns 0 or the first
 * error. It uses a buffer on the caller's stack.
 */
int session_test_send(int64_t started_s);

#endif /* SESSIONS_H_ */
