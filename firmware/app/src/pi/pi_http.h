/*
 * The few parts of HTTP/1.1 a Raspberry Pi delta update needs: a range request, and the head of its
 * answer (docs/pi-delta-update.md, "Downloads"). The firmware's downloader keeps offsets and sizes
 * in 32 bits, and a Pi image can be larger than 4 GiB, so the update has its own client
 * (pi_delta_ota.c), on one kept-alive TLS connection; these are its parts that need no network.
 *
 * Plain C: tested on the host (test_pi_delta.c).
 */

#ifndef PI_HTTP_H_
#define PI_HTTP_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct pi_http_head {
	int status;
	bool has_length;
	uint64_t content_length;
	bool has_range;
	uint64_t range_first;
	uint64_t range_last;
	uint64_t range_total;
	/* The server closes the connection after this answer. */
	bool close;
};

/* Where the head ends in buf: just past its empty line, or 0 if it has not all arrived. */
size_t pi_http_head_end(const char *buf, size_t len);

/*
 * Read a head that pi_http_head_end() found. 0, or -1 if it is not an HTTP/1.x status line with
 * headers that this reads: Content-Length and Content-Range as numbers, and Connection.
 */
int pi_http_parse_head(const char *head, size_t len, struct pi_http_head *out);

/*
 * The request's lines after its path, "GET /" and the path being sent first:
 * " HTTP/1.1\r\nHost: <host>\r\nRange: bytes=<first>-<last>\r\n...\r\n\r\n". The length, or -1 if
 * out is too small.
 */
int pi_http_request_tail(char *out, size_t size, const char *host, uint64_t first, uint64_t last);

/* The answer is the range asked for: 206, and Content-Range and Content-Length that agree. */
bool pi_http_is_range(const struct pi_http_head *head, uint64_t first, uint64_t last);

#endif /* PI_HTTP_H_ */
