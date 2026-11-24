/*
 * HTTP/1.1 range requests for Raspberry Pi delta updates: see pi_http.h.
 */

#include "pi_http.h"

#include <stdio.h>
#include <string.h>

size_t pi_http_head_end(const char *buf, size_t len)
{
	for (size_t i = 3; i < len; i++) {
		if (buf[i - 3] == '\r' && buf[i - 2] == '\n' && buf[i - 1] == '\r' && buf[i] == '\n') {
			return i + 1;
		}
	}
	return 0;
}

static char lower(char c)
{
	return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

/* The line starts with name (any case) and a colon: its value, past the spaces, or NULL. */
static const char *header_value(const char *line, const char *end, const char *name)
{
	size_t n = strlen(name);

	if ((size_t)(end - line) <= n || line[n] != ':') {
		return NULL;
	}
	for (size_t i = 0; i < n; i++) {
		if (lower(line[i]) != name[i]) {
			return NULL;
		}
	}
	line += n + 1;
	while (line < end && (*line == ' ' || *line == '\t')) {
		line++;
	}
	return line;
}

/* A decimal number of up to 19 digits; where it ends, or NULL. */
static const char *number(const char *at, const char *end, uint64_t *out)
{
	uint64_t value = 0;
	int digits = 0;

	while (at < end && *at >= '0' && *at <= '9' && digits < 19) {
		value = value * 10u + (uint64_t)(*at - '0');
		at++;
		digits++;
	}
	if (digits == 0 || (at < end && *at >= '0' && *at <= '9')) {
		return NULL;
	}
	*out = value;
	return at;
}

/* Only spaces from at to the end of the line. */
static bool rest_blank(const char *at, const char *end)
{
	while (at < end && (*at == ' ' || *at == '\t')) {
		at++;
	}
	return at == end;
}

int pi_http_parse_head(const char *head, size_t len, struct pi_http_head *out)
{
	const char *end = head + len;
	const char *line = head;
	const char *eol;
	uint64_t status;

	memset(out, 0, sizeof(*out));
	if (len < 12 || memcmp(head, "HTTP/1.", 7) != 0 || head[8] != ' ') {
		return -1;
	}
	if (number(head + 9, end, &status) != head + 12 || status < 100 || status > 599) {
		return -1;
	}
	out->status = (int)status;
	out->close = head[7] == '0';

	for (;;) {
		const char *value;

		eol = line;
		while (eol + 1 < end && !(eol[0] == '\r' && eol[1] == '\n')) {
			eol++;
		}
		if (eol + 1 >= end) {
			return -1;
		}
		if (eol == line) {
			break;
		}
		if ((value = header_value(line, eol, "content-length")) != NULL) {
			const char *at = number(value, eol, &out->content_length);

			if (at == NULL || !rest_blank(at, eol)) {
				return -1;
			}
			out->has_length = true;
		} else if ((value = header_value(line, eol, "content-range")) != NULL) {
			const char *at = value;

			if (eol - at < 6 || memcmp(at, "bytes ", 6) != 0) {
				return -1;
			}
			at = number(at + 6, eol, &out->range_first);
			if (at == NULL || *at != '-') {
				return -1;
			}
			at = number(at + 1, eol, &out->range_last);
			if (at == NULL || *at != '/') {
				return -1;
			}
			at = number(at + 1, eol, &out->range_total);
			if (at == NULL || !rest_blank(at, eol)) {
				return -1;
			}
			out->has_range = true;
		} else if ((value = header_value(line, eol, "connection")) != NULL) {
			out->close = (eol - value) >= 5 && lower(value[0]) == 'c' && lower(value[1]) == 'l' &&
				     lower(value[2]) == 'o' && lower(value[3]) == 's' && lower(value[4]) == 'e';
		}
		line = eol + 2;
	}
	return 0;
}

int pi_http_request_tail(char *out, size_t size, const char *host, uint64_t first, uint64_t last)
{
	int n = snprintf(out, size,
			 " HTTP/1.1\r\nHost: %s\r\nRange: bytes=%llu-%llu\r\nUser-Agent: cranium-board\r\n"
			 "Connection: keep-alive\r\n\r\n",
			 host, (unsigned long long)first, (unsigned long long)last);

	return n < 0 || (size_t)n >= size ? -1 : n;
}

bool pi_http_is_range(const struct pi_http_head *head, uint64_t first, uint64_t last)
{
	return head->status == 206 && head->has_range && head->range_first == first &&
	       head->range_last == last && head->range_last < head->range_total &&
	       (!head->has_length || head->content_length == last - first + 1);
}
