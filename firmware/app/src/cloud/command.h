/*
 * Commands from the console, from 1.13.0, on cranium/<thing name>/commands: see "Commands" in
 * firmware/README.md and docs/fleet.md.
 *
 *   {"id":"3f9c2a1b7d4e6f80","cmd":"identify","seconds":15}
 *   {"id":"a01b2c3d4e5f6789","cmd":"report"}
 *   {"id":"5e6f708192a3b4c5","cmd":"memfault"}                    from 1.14.0
 *   {"id":"0123456789abcdef","cmd":"memfault_ack","seq":4711}     from 1.14.0, from AWS only
 *
 * The message is read strictly: one JSON object with id, cmd and, for identify, seconds, and for
 * memfault_ack, seq, each at most once and nothing else in it; strings without escapes; values that
 * are strings, numbers, true, false or null, and nothing nested. id is 16 hexadecimal digits. cmd
 * is identify, report, memfault or memfault_ack. seconds is a whole number from 1 to 60; anything
 * else, or none, is 15. seq is a whole number from 0 to 65535, and a memfault_ack without one is
 * not a command.
 *
 * identify blinks LED1 and LED2 together at 5 Hz for that long (ui_identify()). report sends the
 * heartbeat and the diagnostics report at once, and asks for a location scan, which the location's
 * own rules can hold (location.h), and sends what Memfault data is waiting (mflt.h). memfault takes
 * a heartbeat of Memfault's metrics now and sends it, with whatever else waits. The board answers
 * each of these on its events topic with the tag CMD:
 *
 *   identify for 15 s (3f9c2a1b7d4e6f80)
 *   report: heartbeat, diagnostics and a location scan (a01b2c3d4e5f6789)
 *   report: heartbeat and diagnostics, no location scan: an update is under way (a01b2c3d4e5f6789)
 *   memfault: heartbeat taken, sending (5e6f708192a3b4c5)
 *   ignored: unknown cmd (3f9c2a1b7d4e6f80)
 *
 * with the id only when the message had a good one. The CMD line is on the serial console too.
 *
 * memfault_ack is not for people: the function in AWS that posts the board's Memfault chunks
 * sends it for each one, and it is never answered. It goes to mflt.h on the MQTT library's thread,
 * past the one command that waits for the main loop, so that it is never dropped as busy.
 */

#ifndef COMMAND_H_
#define COMMAND_H_

#include <stddef.h>
#include <stdint.h>

#define COMMAND_ID_LENGTH        16
/* A message longer than this is not read at all. The longest real one is about 60 bytes. */
#define COMMAND_MAX              256
#define COMMAND_SECONDS_DEFAULT  15
#define COMMAND_SECONDS_MAX      60

enum command_kind {
	COMMAND_NONE,
	COMMAND_IDENTIFY,
	COMMAND_REPORT,
	COMMAND_MEMFAULT,
	COMMAND_MEMFAULT_ACK,
};

/* Why a message is not a command, if it is not. */
enum command_fault {
	COMMAND_OK,
	COMMAND_TOO_LONG,
	COMMAND_MALFORMED,
	COMMAND_UNKNOWN_MEMBER,
	COMMAND_REPEATED_MEMBER,
	COMMAND_NO_ID,
	COMMAND_NO_CMD,
	COMMAND_UNKNOWN_CMD,
	/* A memfault_ack with no seq, or one that is not a whole number from 0 to 65535. */
	COMMAND_NO_SEQ,
	/* Not of the message: another was still waiting for the main loop, or its queue was full. */
	COMMAND_BUSY,
};

struct command {
	/* "" unless the message was well formed and its id was good. */
	char id[COMMAND_ID_LENGTH + 1];
	uint8_t kind;
	uint8_t seconds;
	uint8_t fault;
	/* memfault_ack's seq. */
	uint16_t seq;
};

/* Read a message. Fills in all of *out, and returns its fault: COMMAND_OK for a command. */
enum command_fault command_parse(const char *json, size_t len, struct command *out);

/*
 * A message on the commands topic, from the MQTT library's thread. It is read there, and the main
 * loop carries it out. One waits at a time: one that comes meanwhile is answered and dropped.
 */
void command_received(const char *payload, size_t len);

#endif /* COMMAND_H_ */
