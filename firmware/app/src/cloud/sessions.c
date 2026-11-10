/*
 * Listening sessions and now playing as JSON for the cloud: see sessions.h. No hardware here, so
 * firmware/tests/host runs it. The writer below needs nothing from the C library but string.h.
 */

#include "sessions.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>

#include "cloud.h"

#define MAX_DURATION_S 14400
#define MAX_SESSION_S  (24LL * 3600)

struct writer {
	char *buf;
	size_t size;
	size_t len;
	bool overflow;
};

static void put_char(struct writer *w, char c)
{
	if (w->len + 1 < w->size) {
		w->buf[w->len] = c;
	} else {
		w->overflow = true;
	}
	w->len++;
}

static void put_text(struct writer *w, const char *text)
{
	for (; *text != '\0'; text++) {
		put_char(w, *text);
	}
}

static void put_number(struct writer *w, uint32_t value)
{
	char digits[10];
	size_t count = 0;

	do {
		digits[count++] = (char)('0' + value % 10);
		value /= 10;
	} while (value > 0);

	while (count > 0) {
		put_char(w, digits[--count]);
	}
}

/* A string in quotes: printable ASCII only, a quote and a backslash escaped, cut to SESSION_TEXT_MAX. */
static void put_string(struct writer *w, const char *text)
{
	put_char(w, '"');
	for (size_t i = 0; text[i] != '\0' && i < SESSION_TEXT_MAX; i++) {
		unsigned char c = (unsigned char)text[i];

		if (c == '"' || c == '\\') {
			put_char(w, '\\');
			put_char(w, (char)c);
		} else {
			put_char(w, (c >= 0x20 && c <= 0x7e) ? (char)c : '?');
		}
	}
	put_char(w, '"');
}

static void put_time(struct writer *w, int64_t unix_s)
{
	char text[SESSION_TIME_MAX];

	session_time_format(unix_s, text);
	put_char(w, '"');
	put_text(w, text);
	put_char(w, '"');
}

static int finish(struct writer *w)
{
	if (w->overflow) {
		return -ENOSPC;
	}
	w->buf[w->len] = '\0';
	return (int)w->len;
}

/* Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm), and back. */
static int64_t days_from_civil(int64_t y, unsigned int m, unsigned int d)
{
	int64_t era;
	unsigned int yoe;
	unsigned int doy;
	unsigned int doe;

	y -= m <= 2;
	era = (y >= 0 ? y : y - 399) / 400;
	yoe = (unsigned int)(y - era * 400);
	doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
	doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	return era * 146097 + (int64_t)doe - 719468;
}

static void civil_from_days(int64_t z, int64_t *y, unsigned int *m, unsigned int *d)
{
	int64_t era;
	unsigned int doe;
	unsigned int yoe;
	unsigned int doy;
	unsigned int mp;

	z += 719468;
	era = (z >= 0 ? z : z - 146096) / 146097;
	doe = (unsigned int)(z - era * 146097);
	yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	mp = (5 * doy + 2) / 153;
	*d = doy - (153 * mp + 2) / 5 + 1;
	*m = mp < 10 ? mp + 3 : mp - 9;
	*y = (int64_t)yoe + era * 400 + (*m <= 2);
}

static bool digits_at(const char *text, size_t at, size_t count, unsigned int *value)
{
	*value = 0;
	for (size_t i = 0; i < count; i++) {
		char c = text[at + i];

		if (c < '0' || c > '9') {
			return false;
		}
		*value = *value * 10 + (unsigned int)(c - '0');
	}
	return true;
}

int session_time_parse(const char *iso, int64_t *unix_s)
{
	static const unsigned char month_days[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
	unsigned int year, month, day, hour, minute, second;
	unsigned int in_month;

	if (iso == NULL || strlen(iso) != SESSION_TIME_MAX - 1 || iso[4] != '-' || iso[7] != '-' ||
	    iso[10] != 'T' || iso[13] != ':' || iso[16] != ':' || iso[19] != 'Z') {
		return -EINVAL;
	}

	if (!digits_at(iso, 0, 4, &year) || !digits_at(iso, 5, 2, &month) ||
	    !digits_at(iso, 8, 2, &day) || !digits_at(iso, 11, 2, &hour) ||
	    !digits_at(iso, 14, 2, &minute) || !digits_at(iso, 17, 2, &second)) {
		return -EINVAL;
	}

	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || day < 1) {
		return -EINVAL;
	}

	in_month = month_days[month - 1];
	if (month == 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))) {
		in_month = 29;
	}
	if (day > in_month) {
		return -EINVAL;
	}

	*unix_s = days_from_civil(year, month, day) * 86400 + (int64_t)hour * 3600 + minute * 60 + second;
	return 0;
}

void session_time_format(int64_t unix_s, char *out)
{
	int64_t days = unix_s >= 0 ? unix_s / 86400 : -((-unix_s + 86399) / 86400);
	unsigned int rest = (unsigned int)(unix_s - days * 86400);
	int64_t year;
	unsigned int month, day;
	struct writer w = { .buf = out, .size = SESSION_TIME_MAX };

	civil_from_days(days, &year, &month, &day);
	if (year < 0 || year > 9999) {
		year = 0;
	}

	put_char(&w, (char)('0' + year / 1000 % 10));
	put_char(&w, (char)('0' + year / 100 % 10));
	put_char(&w, (char)('0' + year / 10 % 10));
	put_char(&w, (char)('0' + year % 10));
	put_char(&w, '-');
	put_char(&w, (char)('0' + month / 10));
	put_char(&w, (char)('0' + month % 10));
	put_char(&w, '-');
	put_char(&w, (char)('0' + day / 10));
	put_char(&w, (char)('0' + day % 10));
	put_char(&w, 'T');
	put_char(&w, (char)('0' + rest / 36000));
	put_char(&w, (char)('0' + rest / 3600 % 10));
	put_char(&w, ':');
	put_char(&w, (char)('0' + rest % 3600 / 600));
	put_char(&w, (char)('0' + rest % 600 / 60));
	put_char(&w, ':');
	put_char(&w, (char)('0' + rest % 60 / 10));
	put_char(&w, (char)('0' + rest % 10));
	put_char(&w, 'Z');
	out[SESSION_TIME_MAX - 1] = '\0';
}

static bool valid_id(const char *id)
{
	size_t length;

	if (id == NULL) {
		return false;
	}
	length = strlen(id);
	if (length < 1 || length > SESSION_ID_MAX) {
		return false;
	}
	for (size_t i = 0; i < length; i++) {
		char c = id[i];

		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      c == '-' || c == '_')) {
			return false;
		}
	}
	return true;
}

static bool valid_text(const char *text)
{
	if (text == NULL) {
		return false;
	}
	for (size_t i = 0; text[i] != '\0' && i < SESSION_TEXT_MAX; i++) {
		if ((unsigned char)text[i] > 0x20 && (unsigned char)text[i] < 0x7f) {
			return true;
		}
	}
	return false;
}

static bool valid_track(const struct session_track *track)
{
	return valid_text(track->title) && track->artist != NULL &&
	       track->played_at >= SESSION_EARLIEST_S && track->duration_s >= 1 &&
	       track->duration_s <= MAX_DURATION_S;
}

static void put_track_fields(struct writer *w, const struct session_track *track)
{
	put_text(w, "\"title\":");
	put_string(w, track->title);
	put_text(w, ",\"artist\":");
	put_string(w, track->artist);
	put_text(w, ",\"playedAt\":");
	put_time(w, track->played_at);
	put_text(w, ",\"durationS\":");
	put_number(w, track->duration_s);
}

int session_format_session(char *buf, size_t size, const char *id, int64_t started_s, int64_t ended_s,
			   const char *title, const struct session_track *tracks, size_t count)
{
	struct writer w = { .buf = buf, .size = size };
	int64_t last = ended_s >= 0 ? ended_s : started_s + MAX_SESSION_S;

	if (buf == NULL || size == 0) {
		return -ENOSPC;
	}
	if (!valid_id(id) || started_s < SESSION_EARLIEST_S || count > SESSION_TRACKS_MAX ||
	    (count > 0 && tracks == NULL) || (title != NULL && !valid_text(title)) ||
	    (ended_s >= 0 && (ended_s < started_s || ended_s - started_s > MAX_SESSION_S))) {
		return -EINVAL;
	}
	for (size_t i = 0; i < count; i++) {
		/* The cloud drops a message with a track outside its session. */
		if (!valid_track(&tracks[i]) || tracks[i].played_at < started_s ||
		    tracks[i].played_at > last) {
			return -EINVAL;
		}
	}

	put_text(&w, "{\"v\":1,\"type\":\"session\",\"id\":\"");
	put_text(&w, id);
	put_text(&w, "\",\"startedAt\":");
	put_time(&w, started_s);
	if (ended_s >= 0) {
		put_text(&w, ",\"endedAt\":");
		put_time(&w, ended_s);
	}
	if (title != NULL) {
		put_text(&w, ",\"title\":");
		put_string(&w, title);
	}
	if (count > 0) {
		put_text(&w, ",\"tracks\":[");
		for (size_t i = 0; i < count; i++) {
			put_text(&w, i > 0 ? ",{" : "{");
			put_track_fields(&w, &tracks[i]);
			put_char(&w, '}');
		}
		put_char(&w, ']');
	}
	put_char(&w, '}');
	return finish(&w);
}

int session_format_now(char *buf, size_t size, const struct session_track *track)
{
	struct writer w = { .buf = buf, .size = size };

	if (buf == NULL || size == 0) {
		return -ENOSPC;
	}
	if (track != NULL && !valid_track(track)) {
		return -EINVAL;
	}

	put_text(&w, "{\"v\":1,\"type\":\"now\",\"playing\":");
	if (track == NULL) {
		put_text(&w, "false");
	} else {
		put_text(&w, "true,");
		put_track_fields(&w, track);
	}
	put_char(&w, '}');
	return finish(&w);
}

int session_send_session(char *scratch, size_t size, const char *id, int64_t started_s, int64_t ended_s,
			 const char *title, const struct session_track *tracks, size_t count)
{
	int length = session_format_session(scratch, size, id, started_s, ended_s, title, tracks, count);

	return length < 0 ? length : cloud_session_publish(scratch);
}

int session_send_now(char *scratch, size_t size, const struct session_track *track)
{
	int length = session_format_now(scratch, size, track);

	return length < 0 ? length : cloud_session_publish(scratch);
}

int session_test_send(int64_t started_s)
{
	char scratch[SESSION_JSON_MAX];
	struct session_track first = {
		.title = "Test track one", .artist = "Cranium", .played_at = started_s + 10, .duration_s = 60,
	};
	struct session_track second = {
		.title = "Test track two", .artist = "Cranium", .played_at = started_s + 70, .duration_s = 60,
	};
	int err;

	err = session_send_session(scratch, sizeof(scratch), "test", started_s, -1, "Test set", &first, 1);
	if (err == 0) {
		err = session_send_now(scratch, sizeof(scratch), &second);
	}
	if (err == 0) {
		err = session_send_session(scratch, sizeof(scratch), "test", started_s, started_s + 130,
					   "Test set", &second, 1);
	}
	return err;
}
