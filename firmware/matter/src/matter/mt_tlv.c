/*
 * See mt_tlv.h.
 */
#include "mt_tlv.h"

#include <string.h>

#define TAG_ANON    0x00u
#define TAG_CONTEXT 0x20u

#define TYPE_INT8   0x00u
#define TYPE_UINT8  0x04u
#define TYPE_FALSE  0x08u
#define TYPE_TRUE   0x09u
#define TYPE_FLOAT  0x0Au
#define TYPE_DOUBLE 0x0Bu
#define TYPE_UTF8_1 0x0Cu
#define TYPE_BYTES1 0x10u
#define TYPE_NULL   0x14u
#define TYPE_STRUCT 0x15u
#define TYPE_ARRAY  0x16u
#define TYPE_LIST   0x17u
#define TYPE_END    0x18u

void mt_tlv_writer_init(struct mt_tlv_writer *w, uint8_t *buf, size_t cap)
{
	w->buf = buf;
	w->cap = cap;
	w->len = 0;
	w->depth = 0;
	w->overflow = false;
}

static void put_byte(struct mt_tlv_writer *w, uint8_t b)
{
	if (w->len < w->cap) {
		w->buf[w->len] = b;
	} else {
		w->overflow = true;
	}
	w->len++;
}

static void put_le(struct mt_tlv_writer *w, uint64_t v, unsigned int n)
{
	for (unsigned int i = 0; i < n; i++) {
		put_byte(w, (uint8_t)(v >> (8 * i)));
	}
}

static void put_control(struct mt_tlv_writer *w, uint32_t tag, uint8_t type)
{
	if (tag == MT_TLV_ANON) {
		put_byte(w, TAG_ANON | type);
	} else {
		put_byte(w, TAG_CONTEXT | type);
		put_byte(w, (uint8_t)tag);
	}
}

static unsigned int width_code(uint64_t v)
{
	return v <= 0xFFu ? 0 : v <= 0xFFFFu ? 1 : v <= 0xFFFFFFFFu ? 2 : 3;
}

void mt_tlv_put_uint(struct mt_tlv_writer *w, uint32_t tag, uint64_t value)
{
	unsigned int code = width_code(value);

	put_control(w, tag, (uint8_t)(TYPE_UINT8 + code));
	put_le(w, value, 1u << code);
}

void mt_tlv_put_int(struct mt_tlv_writer *w, uint32_t tag, int64_t value)
{
	unsigned int code = value >= INT8_MIN && value <= INT8_MAX     ? 0
			    : value >= INT16_MIN && value <= INT16_MAX ? 1
			    : value >= INT32_MIN && value <= INT32_MAX ? 2
								       : 3;

	put_control(w, tag, (uint8_t)(TYPE_INT8 + code));
	put_le(w, (uint64_t)value, 1u << code);
}

void mt_tlv_put_bool(struct mt_tlv_writer *w, uint32_t tag, bool value)
{
	put_control(w, tag, value ? TYPE_TRUE : TYPE_FALSE);
}

static void put_string(struct mt_tlv_writer *w, uint32_t tag, uint8_t base, const uint8_t *data, size_t len)
{
	unsigned int code = width_code(len);

	put_control(w, tag, (uint8_t)(base + code));
	put_le(w, len, 1u << code);
	for (size_t i = 0; i < len; i++) {
		put_byte(w, data[i]);
	}
}

void mt_tlv_put_bytes(struct mt_tlv_writer *w, uint32_t tag, const uint8_t *data, size_t len)
{
	put_string(w, tag, TYPE_BYTES1, data, len);
}

void mt_tlv_put_str(struct mt_tlv_writer *w, uint32_t tag, const char *str)
{
	put_string(w, tag, TYPE_UTF8_1, (const uint8_t *)str, strlen(str));
}

void mt_tlv_put_null(struct mt_tlv_writer *w, uint32_t tag)
{
	put_control(w, tag, TYPE_NULL);
}

void mt_tlv_start(struct mt_tlv_writer *w, uint32_t tag, enum mt_tlv_type container)
{
	uint8_t type = container == MT_TLV_ARRAY ? TYPE_ARRAY : container == MT_TLV_LIST ? TYPE_LIST : TYPE_STRUCT;

	put_control(w, tag, type);
	w->depth++;
}

void mt_tlv_end(struct mt_tlv_writer *w)
{
	put_byte(w, TYPE_END);
	w->depth--;
}

int mt_tlv_finish(const struct mt_tlv_writer *w)
{
	if (w->overflow || w->depth != 0 || w->len > (size_t)INT32_MAX) {
		return -1;
	}
	return (int)w->len;
}

void mt_tlv_reader_init(struct mt_tlv_reader *r, const uint8_t *buf, size_t len)
{
	r->buf = buf;
	r->len = len;
	r->pos = 0;
	r->depth = 0;
	r->error = false;
}

static bool get_le(struct mt_tlv_reader *r, unsigned int n, uint64_t *v)
{
	if (r->len - r->pos < n) {
		r->error = true;
		return false;
	}
	*v = 0;
	for (unsigned int i = 0; i < n; i++) {
		*v |= (uint64_t)r->buf[r->pos + i] << (8 * i);
	}
	r->pos += n;
	return true;
}

bool mt_tlv_next(struct mt_tlv_reader *r, struct mt_tlv_element *e)
{
	uint64_t v;

	if (r->error || r->pos >= r->len) {
		return false;
	}
	uint8_t control = r->buf[r->pos++];
	uint8_t tag_control = control >> 5;
	uint8_t type = control & 0x1Fu;
	static const uint8_t tag_len[8] = {0, 1, 2, 4, 2, 4, 6, 8};

	memset(e, 0, sizeof(*e));
	e->tag = MT_TLV_ANON;
	if (type == TYPE_END) {
		if (tag_control != 0 || r->depth == 0) {
			r->error = true;
			return false;
		}
		r->depth--;
		e->type = MT_TLV_END;
		return true;
	}
	if (tag_control != 0) {
		if (!get_le(r, tag_len[tag_control], &v)) {
			return false;
		}
		if (tag_control == 1) {
			e->context = true;
			e->tag = (uint32_t)v;
		} else {
			/* A profile tag: its number follows the vendor and profile in a fully-qualified one. */
			e->tag = (uint32_t)(tag_control >= 6 ? v >> 32 : v) & 0x7FFFFFFFu;
		}
	}
	if (type <= 0x03u) {
		unsigned int n = 1u << type;

		if (!get_le(r, n, &v)) {
			return false;
		}
		/* Sign-extend. */
		if (n < 8 && (v >> (8 * n - 1)) & 1u) {
			v |= ~0ull << (8 * n);
		}
		e->type = MT_TLV_INT;
		e->v.i = (int64_t)v;
	} else if (type <= 0x07u) {
		if (!get_le(r, 1u << (type - 4u), &v)) {
			return false;
		}
		e->type = MT_TLV_UINT;
		e->v.u = v;
	} else if (type == TYPE_FALSE || type == TYPE_TRUE) {
		e->type = MT_TLV_BOOL;
		e->v.b = type == TYPE_TRUE;
	} else if (type == TYPE_FLOAT || type == TYPE_DOUBLE) {
		if (!get_le(r, type == TYPE_FLOAT ? 4 : 8, &v)) {
			return false;
		}
		e->type = MT_TLV_FLOAT;
		e->v.u = v;
	} else if (type >= TYPE_UTF8_1 && type <= 0x13u) {
		unsigned int n = 1u << ((type - TYPE_UTF8_1) & 3u);

		if (!get_le(r, n, &v)) {
			return false;
		}
		if (v > r->len - r->pos) {
			r->error = true;
			return false;
		}
		e->type = type < TYPE_BYTES1 ? MT_TLV_UTF8 : MT_TLV_BYTES;
		e->data = &r->buf[r->pos];
		e->len = (size_t)v;
		r->pos += (size_t)v;
	} else if (type == TYPE_NULL) {
		e->type = MT_TLV_NULL;
	} else if (type >= TYPE_STRUCT && type <= TYPE_LIST) {
		e->type = type == TYPE_STRUCT ? MT_TLV_STRUCT : type == TYPE_ARRAY ? MT_TLV_ARRAY : MT_TLV_LIST;
		r->depth++;
	} else {
		r->error = true;
		return false;
	}
	return true;
}

bool mt_tlv_skip_container(struct mt_tlv_reader *r)
{
	int target = r->depth - 1;
	struct mt_tlv_element e;

	while (r->depth > target) {
		if (!mt_tlv_next(r, &e)) {
			r->error = true;
			return false;
		}
	}
	return true;
}

bool mt_tlv_find(struct mt_tlv_reader *r, uint8_t context_tag, struct mt_tlv_element *e)
{
	int level = r->depth;

	while (mt_tlv_next(r, e)) {
		if (e->type == MT_TLV_END) {
			if (r->depth < level) {
				return false;
			}
			continue;
		}
		bool here = r->depth == level ||
			    ((e->type == MT_TLV_STRUCT || e->type == MT_TLV_ARRAY || e->type == MT_TLV_LIST) &&
			     r->depth == level + 1);

		if (here && e->context && e->tag == context_tag) {
			return true;
		}
		if (here && (e->type == MT_TLV_STRUCT || e->type == MT_TLV_ARRAY || e->type == MT_TLV_LIST)) {
			if (!mt_tlv_skip_container(r)) {
				return false;
			}
		}
	}
	return false;
}

bool mt_tlv_close_all(struct mt_tlv_reader *r)
{
	struct mt_tlv_element e;

	while (r->depth > 0) {
		if (!mt_tlv_next(r, &e)) {
			return false;
		}
	}
	return !r->error;
}
