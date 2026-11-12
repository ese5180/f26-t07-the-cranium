/*
 * See mt_der.h.
 */
#include "mt_der.h"

#include <string.h>

void mt_der_init(struct mt_der_writer *w, uint8_t *buf, size_t cap)
{
	memset(w, 0, sizeof(*w));
	w->buf = buf;
	w->cap = cap;
}

static void put(struct mt_der_writer *w, const uint8_t *d, size_t n)
{
	if (w->error || w->len + n > w->cap) {
		w->error = true;
		return;
	}
	memcpy(&w->buf[w->len], d, n);
	w->len += n;
}

void mt_der_start(struct mt_der_writer *w, uint8_t tag)
{
	if (w->depth >= DER_MAX_DEPTH) {
		w->error = true;
		return;
	}
	w->tags[w->depth] = tag;
	w->open[w->depth] = w->len;
	w->depth++;
}

static size_t len_size(size_t n)
{
	return n < 0x80 ? 1 : n < 0x100 ? 2 : 3;
}

static void write_len(uint8_t *o, size_t n)
{
	if (n < 0x80) {
		o[0] = (uint8_t)n;
	} else if (n < 0x100) {
		o[0] = 0x81;
		o[1] = (uint8_t)n;
	} else {
		o[0] = 0x82;
		o[1] = (uint8_t)(n >> 8);
		o[2] = (uint8_t)n;
	}
}

void mt_der_end(struct mt_der_writer *w)
{
	if (w->error || w->depth == 0) {
		w->error = true;
		return;
	}
	w->depth--;
	size_t start = w->open[w->depth];
	size_t content = w->len - start;
	size_t hdr = 1 + len_size(content);

	if (content > 0xFFFF || w->len + hdr > w->cap) {
		w->error = true;
		return;
	}
	memmove(&w->buf[start + hdr], &w->buf[start], content);
	w->buf[start] = w->tags[w->depth];
	write_len(&w->buf[start + 1], content);
	w->len += hdr;
}

void mt_der_put(struct mt_der_writer *w, uint8_t tag, const uint8_t *data, size_t len)
{
	uint8_t hdr[4];

	if (len > 0xFFFF) {
		w->error = true;
		return;
	}
	hdr[0] = tag;
	write_len(&hdr[1], len);
	put(w, hdr, 1 + len_size(len));
	put(w, data, len);
}

void mt_der_put_uint_bytes(struct mt_der_writer *w, const uint8_t *be, size_t len)
{
	uint8_t tmp[34];

	while (len > 1 && be[0] == 0) {
		be++;
		len--;
	}
	if (len + 1 > sizeof(tmp)) {
		w->error = true;
		return;
	}
	size_t n = 0;

	if (be[0] & 0x80) {
		tmp[n++] = 0;
	}
	memcpy(&tmp[n], be, len);
	mt_der_put(w, DER_INTEGER, tmp, n + len);
}

void mt_der_put_small_int(struct mt_der_writer *w, uint32_t v)
{
	uint8_t be[4] = {(uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v};

	mt_der_put_uint_bytes(w, be, 4);
}

void mt_der_put_oid(struct mt_der_writer *w, const uint8_t *oid, size_t len)
{
	mt_der_put(w, DER_OID, oid, len);
}

int mt_der_finish(const struct mt_der_writer *w)
{
	return w->error || w->depth != 0 ? -1 : (int)w->len;
}

bool mt_der_read(const uint8_t *in, size_t len, struct mt_der_elem *e)
{
	size_t n;
	size_t vlen;

	if (len < 2) {
		return false;
	}
	e->tag = in[0];
	e->start = in;
	if (in[1] < 0x80) {
		vlen = in[1];
		n = 2;
	} else if (in[1] == 0x81 && len >= 3) {
		vlen = in[2];
		n = 3;
	} else if (in[1] == 0x82 && len >= 4) {
		vlen = ((size_t)in[2] << 8) | in[3];
		n = 4;
	} else {
		return false;
	}
	if (vlen > len - n) {
		return false;
	}
	e->value = &in[n];
	e->len = vlen;
	e->total = n + vlen;
	return true;
}

bool mt_der_child(const struct mt_der_elem *parent, unsigned int index, struct mt_der_elem *e)
{
	const uint8_t *p = parent->value;
	size_t left = parent->len;

	for (unsigned int i = 0;; i++) {
		if (!mt_der_read(p, left, e)) {
			return false;
		}
		if (i == index) {
			return true;
		}
		p += e->total;
		left -= e->total;
	}
}

int mt_der_sig_from_raw(const uint8_t raw[64], uint8_t *out, size_t cap)
{
	struct mt_der_writer w;

	mt_der_init(&w, out, cap);
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_put_uint_bytes(&w, &raw[0], 32);
	mt_der_put_uint_bytes(&w, &raw[32], 32);
	mt_der_end(&w);
	return mt_der_finish(&w);
}

static bool int_to_32(const struct mt_der_elem *e, uint8_t out[32])
{
	const uint8_t *v = e->value;
	size_t n = e->len;

	if (e->tag != DER_INTEGER || n == 0) {
		return false;
	}
	while (n > 1 && v[0] == 0) {
		v++;
		n--;
	}
	if (n > 32) {
		return false;
	}
	memset(out, 0, 32 - n);
	memcpy(&out[32 - n], v, n);
	return true;
}

bool mt_der_sig_to_raw(const uint8_t *der, size_t len, uint8_t raw[64])
{
	struct mt_der_elem seq;
	struct mt_der_elem r;
	struct mt_der_elem s;

	return mt_der_read(der, len, &seq) && seq.tag == DER_SEQUENCE && seq.total == len &&
	       mt_der_child(&seq, 0, &r) && mt_der_child(&seq, 1, &s) && int_to_32(&r, &raw[0]) &&
	       int_to_32(&s, &raw[32]);
}
