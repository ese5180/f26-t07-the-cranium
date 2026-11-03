/*
 * Events to the console: what the board says about itself on the serial console also goes to AWS
 * IoT, so that the console in the cloud can show it. See "Events to the console" in
 * firmware/README.md.
 *
 * Each line that console_event() prints, and each log line of this application's own modules, is
 * one MQTT message on cranium/<thing name>/events, at QoS 0:
 *
 *   {"t":61234,"seq":17,"boot":42,"up":61240,"tag":"WIFI","text":"connected ip=10.0.0.7 rssi=-51"}
 *
 * t is the uptime in milliseconds when the line was printed, seq counts the lines of this boot from 1,
 * boot is the boot diary's count of boots (0 without the diary), and up is the uptime when the message
 * was sent: the cloud dates a line as the time it got the message, less up - t. "dropped":N comes
 * before "tag" when N lines are missing right before this one, for a full ring or for the rate limit,
 * and seq skips over them. text is at most CLOUD_EVENTS_TEXT_MAX characters of printable ASCII.
 *
 * Never sent: a line from anywhere else (Zephyr, the SDK, the Wi-Fi supplicant, MQTT, the
 * downloader), the Bluetooth passkey, a debug line, and a line with anything that looks like a
 * password, a key or a certificate in it. A network's name becomes "the network", and a URL "a URL".
 * The rules are in cloud_events.c, one per source.
 *
 * Lines can come from any thread. They wait in a ring in RAM, and the main loop sends them, oldest
 * first, while the board is connected. The console's own commands that change the board are events
 * too (console_cmd.c), by name only, and so is a certificate loaded there.
 */

#ifndef CLOUD_EVENTS_H_
#define CLOUD_EVENTS_H_

#include <stddef.h>
#include <stdint.h>

/* The lines that wait while the board is offline. When the ring is full, the oldest goes. */
#define CLOUD_EVENTS_RING            32
/* At most this many lines a second get into the ring, after a first CLOUD_EVENTS_BURST at once. */
#define CLOUD_EVENTS_PER_SECOND      5
#define CLOUD_EVENTS_BURST           20
/* The longest text, and the longest tag of a source that is sent ("boot_diary"). */
#define CLOUD_EVENTS_TEXT_MAX        160
#define CLOUD_EVENTS_TAG_MAX         10
/*
 * The longest message, with its terminating NUL: every number at its largest, and a text that is
 * all quotes, each of which takes two characters. tests/host/test_cloud_events.c makes one.
 */
#define CLOUD_EVENTS_JSON_MAX        456
/* The main loop sends at most this many at a time, and comes back for the rest. */
#define CLOUD_EVENTS_PER_CALL        8

/*
 * Until AWS IoT has taken an event in this boot, each connection sends one, no sooner than
 * CLOUD_EVENTS_START_MS after it came up, and the rest only once it has stayed up
 * CLOUD_EVENTS_PROOF_MS after that. AWS IoT closes the connection of a board that publishes where its
 * policy does not allow: after CLOUD_EVENTS_REFUSALS_MAX connections that ended that soon after
 * their first event, none are sent until a restart, and updates go on as before.
 */
#define CLOUD_EVENTS_START_MS        5000
#define CLOUD_EVENTS_PROOF_MS        5000
#define CLOUD_EVENTS_REFUSALS_MAX    2

#if defined(CONFIG_APP_CLOUD_EVENTS)

/*
 * A line that the console has printed as "[tag] text", from any thread and from an interrupt, as
 * the tag and the text after "[tag] ", which need not end in a NUL. Never waits: what does not get
 * in is counted in the next one that does.
 */
void cloud_events_add(const char *tag, const char *text, size_t length);

/* The main loop's: the connection to AWS IoT came up, or went down. */
void cloud_events_on_cloud_up(void);
void cloud_events_on_cloud_down(void);

/* The main loop's, once a second and when a line has come in: send what waits, as far as it may. */
void cloud_events_send(void);

#else

static inline void cloud_events_add(const char *tag, const char *text, size_t length)
{
	(void)tag;
	(void)text;
	(void)length;
}

static inline void cloud_events_on_cloud_up(void)
{
}

static inline void cloud_events_on_cloud_down(void)
{
}

static inline void cloud_events_send(void)
{
}

#endif /* CONFIG_APP_CLOUD_EVENTS */

#endif /* CLOUD_EVENTS_H_ */
