/*
 * Commands from the console: see command.h.
 *
 * A message is read on the MQTT library's thread, into one small struct, and handed to the main
 * loop, which carries it out and answers it. Nothing of the message is kept but that struct, and
 * nothing of it is repeated in the answer but a good id.
 */

#include "command.h"

#include <stdbool.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/util.h>

#include "app_events.h"
#include "console.h"
#include "location.h"
#include "ui.h"

/* ---- reading a message ---------------------------------------------------------------- */

struct reader {
	const char *at;
	const char *end;
};

enum value_type {
	VALUE_STRING,
	VALUE_NUMBER,
	VALUE_LITERAL,
};

struct value {
	enum value_type type;
	/* A string's text, without its quotes. */
	const char *text;
	size_t length;
	/* A number: whole if it has no fraction and no exponent, and then this, held below 10^7. */
	bool whole;
	long number;
};

static bool is_digit(char c)
{
	return c >= '0' && c <= '9';
}

static bool is_hex(char c)
{
	return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static void skip_blanks(struct reader *r)
{
	while (r->at < r->end && (*r->at == ' ' || *r->at == '\t' || *r->at == '\n' || *r->at == '\r')) {
		r->at++;
	}
}

static bool take(struct reader *r, char c)
{
	skip_blanks(r);
	if (r->at < r->end && *r->at == c) {
		r->at++;
		return true;
	}
	return false;
}

/* A string with no escape and no control character in it, which is all that a command needs. */
static bool read_string(struct reader *r, const char **text, size_t *length)
{
	skip_blanks(r);
	if (r->at >= r->end || *r->at != '"') {
		return false;
	}

	*text = ++r->at;
	while (r->at < r->end && *r->at != '"') {
		if (*r->at == '\\' || (unsigned char)*r->at < 0x20) {
			return false;
		}
		r->at++;
	}

	if (r->at >= r->end) {
		return false;
	}

	*length = (size_t)(r->at - *text);
	r->at++;
	return true;
}

static bool read_digits(struct reader *r, struct value *v, bool count)
{
	const char *start = r->at;

	while (r->at < r->end && is_digit(*r->at)) {
		if (count && v->number < 1000000) {
			v->number = v->number * 10 + (*r->at - '0');
		}
		r->at++;
	}

	return r->at > start;
}

/* A number as JSON writes it: -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)? */
static bool read_number(struct reader *r, struct value *v)
{
	bool negative = r->at < r->end && *r->at == '-';

	v->type = VALUE_NUMBER;
	v->whole = true;
	v->number = 0;

	if (negative) {
		r->at++;
	}

	if (r->at < r->end && *r->at == '0') {
		r->at++;
	} else if (!read_digits(r, v, true)) {
		return false;
	}

	if (r->at < r->end && *r->at == '.') {
		r->at++;
		v->whole = false;
		if (!read_digits(r, v, false)) {
			return false;
		}
	}

	if (r->at < r->end && (*r->at == 'e' || *r->at == 'E')) {
		r->at++;
		v->whole = false;
		if (r->at < r->end && (*r->at == '+' || *r->at == '-')) {
			r->at++;
		}
		if (!read_digits(r, v, false)) {
			return false;
		}
	}

	if (negative) {
		v->number = -v->number;
	}
	return true;
}

static bool read_literal(struct reader *r, const char *word)
{
	size_t length = strlen(word);

	if ((size_t)(r->end - r->at) < length || memcmp(r->at, word, length) != 0) {
		return false;
	}
	r->at += length;
	return true;
}

/* A string, a number, true, false or null. An object or an array is not read. */
static bool read_value(struct reader *r, struct value *v)
{
	skip_blanks(r);
	if (r->at >= r->end) {
		return false;
	}

	if (*r->at == '"') {
		v->type = VALUE_STRING;
		return read_string(r, &v->text, &v->length);
	}

	if (*r->at == '-' || is_digit(*r->at)) {
		return read_number(r, v);
	}

	v->type = VALUE_LITERAL;
	return read_literal(r, "true") || read_literal(r, "false") || read_literal(r, "null");
}

static bool is_text(const char *text, size_t length, const char *word)
{
	return length == strlen(word) && memcmp(text, word, length) == 0;
}

static bool is_id(const struct value *v)
{
	if (v->type != VALUE_STRING || v->length != COMMAND_ID_LENGTH) {
		return false;
	}

	for (size_t i = 0; i < v->length; i++) {
		if (!is_hex(v->text[i])) {
			return false;
		}
	}
	return true;
}

enum command_fault command_parse(const char *json, size_t len, struct command *out)
{
	struct reader r = { .at = json, .end = json + len };
	struct value id = { 0 };
	struct value cmd = { 0 };
	struct value seconds = { 0 };
	unsigned int seen_id = 0;
	unsigned int seen_cmd = 0;
	unsigned int seen_seconds = 0;
	enum command_fault members = COMMAND_OK;

	memset(out, 0, sizeof(*out));
	out->kind = COMMAND_NONE;
	out->seconds = COMMAND_SECONDS_DEFAULT;
	out->fault = COMMAND_MALFORMED;

	if (len > COMMAND_MAX) {
		out->fault = COMMAND_TOO_LONG;
		return COMMAND_TOO_LONG;
	}

	if (json == NULL || !take(&r, '{')) {
		return COMMAND_MALFORMED;
	}

	if (!take(&r, '}')) {
		do {
			const char *name;
			size_t name_length;
			struct value v;

			if (!read_string(&r, &name, &name_length) || !take(&r, ':') ||
			    !read_value(&r, &v)) {
				return COMMAND_MALFORMED;
			}

			if (is_text(name, name_length, "id")) {
				id = v;
				seen_id++;
			} else if (is_text(name, name_length, "cmd")) {
				cmd = v;
				seen_cmd++;
			} else if (is_text(name, name_length, "seconds")) {
				seconds = v;
				seen_seconds++;
			} else if (members == COMMAND_OK) {
				members = COMMAND_UNKNOWN_MEMBER;
			}
		} while (take(&r, ','));

		if (!take(&r, '}')) {
			return COMMAND_MALFORMED;
		}
	}

	skip_blanks(&r);
	if (r.at != r.end) {
		return COMMAND_MALFORMED;
	}

	/* Well formed: a good id goes into the answer, whatever else is wrong. */
	if (seen_id == 1 && is_id(&id)) {
		memcpy(out->id, id.text, COMMAND_ID_LENGTH);
		out->id[COMMAND_ID_LENGTH] = '\0';
	}

	if (members == COMMAND_OK && (seen_id > 1 || seen_cmd > 1 || seen_seconds > 1)) {
		members = COMMAND_REPEATED_MEMBER;
	}

	if (members != COMMAND_OK) {
		out->fault = members;
	} else if (out->id[0] == '\0') {
		out->fault = COMMAND_NO_ID;
	} else if (seen_cmd == 0 || cmd.type != VALUE_STRING) {
		out->fault = COMMAND_NO_CMD;
	} else if (is_text(cmd.text, cmd.length, "identify")) {
		out->kind = COMMAND_IDENTIFY;
		out->fault = COMMAND_OK;
	} else if (is_text(cmd.text, cmd.length, "report")) {
		out->kind = COMMAND_REPORT;
		out->fault = COMMAND_OK;
	} else {
		out->fault = COMMAND_UNKNOWN_CMD;
	}

	if (out->kind == COMMAND_IDENTIFY && seen_seconds == 1 && seconds.type == VALUE_NUMBER &&
	    seconds.whole && seconds.number >= 1 && seconds.number <= COMMAND_SECONDS_MAX) {
		out->seconds = (uint8_t)seconds.number;
	}

	return (enum command_fault)out->fault;
}

/* ---- carrying one out ----------------------------------------------------------------- */

/* Written by the MQTT library's thread while waiting is 0, and read by the main loop while 1. */
static struct command next;
static atomic_t waiting;

static const char *fault_text(enum command_fault fault)
{
	switch (fault) {
	case COMMAND_TOO_LONG:
		return "too long";
	case COMMAND_MALFORMED:
		return "not a command";
	case COMMAND_UNKNOWN_MEMBER:
		return "unknown member";
	case COMMAND_REPEATED_MEMBER:
		return "repeated member";
	case COMMAND_NO_ID:
		return "no id";
	case COMMAND_NO_CMD:
		return "no cmd";
	case COMMAND_UNKNOWN_CMD:
		return "unknown cmd";
	case COMMAND_BUSY:
		return "the board is busy";
	default:
		return "not a command";
	}
}

static const char *hold_text(enum location_hold hold)
{
	switch (hold) {
	case LOCATION_NONE:
		return "this board has no Wi-Fi location";
	case LOCATION_OFF:
		return "location is off until a restart";
	case LOCATION_SCANNING:
		return "one is under way";
	case LOCATION_OFFLINE:
		return "not connected";
	case LOCATION_UPDATE:
		return "an update is under way";
	case LOCATION_BLUETOOTH:
		return "Bluetooth is open";
	case LOCATION_FLOOR:
		return "the last was less than 10 minutes ago";
	case LOCATION_RETRY:
		return "the Wi-Fi stack is busy";
	default:
		return "not now";
	}
}

static void answer_ignored(const struct command *command)
{
	const char *why = fault_text((enum command_fault)command->fault);

	if (command->id[0] != '\0') {
		console_event("CMD", "ignored: %s (%s)", why, command->id);
	} else {
		console_event("CMD", "ignored: %s", why);
	}
}

/* The main loop's. */
static void run(void)
{
	struct command command = next;
	enum location_hold hold;

	atomic_set(&waiting, 0);

	if (command.fault != COMMAND_OK) {
		answer_ignored(&command);
		return;
	}

	if (command.kind == COMMAND_IDENTIFY) {
		ui_identify(command.seconds);
		console_event("CMD", "identify for %u s (%s)", (unsigned int)command.seconds, command.id);
		return;
	}

	app_send_reports();
	hold = location_request();
	if (hold == LOCATION_GO) {
		console_event("CMD", "report: heartbeat, diagnostics and a location scan (%s)",
			      command.id);
	} else {
		console_event("CMD", "report: heartbeat and diagnostics, no location scan: %s (%s)",
			      hold_text(hold), command.id);
	}
}

void command_received(const char *payload, size_t len)
{
	static const struct app_event event = {
		.type = APP_EVENT_CALL,
		.call.function = run,
	};
	struct command parsed;

	(void)command_parse(payload, len, &parsed);

	if (!atomic_cas(&waiting, 0, 1)) {
		parsed.fault = COMMAND_BUSY;
		answer_ignored(&parsed);
		return;
	}

	next = parsed;
	if (app_event_post(&event) != 0) {
		atomic_set(&waiting, 0);
		parsed.fault = COMMAND_BUSY;
		answer_ignored(&parsed);
	}
}
