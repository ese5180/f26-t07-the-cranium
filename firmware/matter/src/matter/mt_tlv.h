/*
 * Matter TLV (Matter specification, appendix A): the encoding of every Matter message body and certificate.
 * Only what a commissioner needs: anonymous and context-specific tags; integers, booleans, UTF-8 and octet
 * strings, null, structures, arrays and lists. A reader also steps over common-profile and fully-qualified tags.
 * No allocation: the writer fills a caller's buffer, the reader points into one.
 */
#ifndef MT_TLV_H_
#define MT_TLV_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* An anonymous tag; context-specific tags are 0 to 255. */
#define MT_TLV_ANON 0xFFFFFFFFu

enum mt_tlv_type {
	MT_TLV_INT,
	MT_TLV_UINT,
	MT_TLV_BOOL,
	MT_TLV_UTF8,
	MT_TLV_BYTES,
	MT_TLV_NULL,
	MT_TLV_FLOAT,
	MT_TLV_STRUCT,
	MT_TLV_ARRAY,
	MT_TLV_LIST,
	MT_TLV_END,
};

struct mt_tlv_writer {
	uint8_t *buf;
	size_t cap;
	size_t len;
	int depth;
	bool overflow;
};

void mt_tlv_writer_init(struct mt_tlv_writer *w, uint8_t *buf, size_t cap);
void mt_tlv_put_uint(struct mt_tlv_writer *w, uint32_t tag, uint64_t value);
void mt_tlv_put_int(struct mt_tlv_writer *w, uint32_t tag, int64_t value);
void mt_tlv_put_bool(struct mt_tlv_writer *w, uint32_t tag, bool value);
void mt_tlv_put_bytes(struct mt_tlv_writer *w, uint32_t tag, const uint8_t *data, size_t len);
void mt_tlv_put_str(struct mt_tlv_writer *w, uint32_t tag, const char *str);
void mt_tlv_put_null(struct mt_tlv_writer *w, uint32_t tag);
void mt_tlv_start(struct mt_tlv_writer *w, uint32_t tag, enum mt_tlv_type container);
void mt_tlv_end(struct mt_tlv_writer *w);
/* The encoded length, or -1 if the buffer overflowed or a container is still open. */
int mt_tlv_finish(const struct mt_tlv_writer *w);

struct mt_tlv_element {
	enum mt_tlv_type type;
	uint32_t tag; /* MT_TLV_ANON, 0..255, or for a profile tag its tag number with bit 31 clear */
	bool context; /* a context-specific tag */
	union {
		uint64_t u;
		int64_t i;
		bool b;
	} v;
	const uint8_t *data; /* strings */
	size_t len;
};

struct mt_tlv_reader {
	const uint8_t *buf;
	size_t len;
	size_t pos;
	int depth;
	bool error;
};

void mt_tlv_reader_init(struct mt_tlv_reader *r, const uint8_t *buf, size_t len);
/*
 * Reads the next element. Containers are entered: their members follow, then an MT_TLV_END element. Returns
 * false at the end of the buffer or on malformed input (r->error is then set).
 */
bool mt_tlv_next(struct mt_tlv_reader *r, struct mt_tlv_element *e);
/* After a container element: skips its members and its end. */
bool mt_tlv_skip_container(struct mt_tlv_reader *r);
/*
 * In the container just entered: finds the member with this context tag at this level, leaving the reader
 * after it (and inside it if it is a container). Members at deeper levels are skipped.
 */
bool mt_tlv_find(struct mt_tlv_reader *r, uint8_t context_tag, struct mt_tlv_element *e);
/* Reads whatever is left of the open containers. True if they all close and nothing is malformed. */
bool mt_tlv_close_all(struct mt_tlv_reader *r);

#ifdef __cplusplus
}
#endif

#endif /* MT_TLV_H_ */
