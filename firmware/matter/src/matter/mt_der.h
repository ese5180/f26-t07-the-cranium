/*
 * Just enough ASN.1 DER for Matter's certificates: a writer that builds nested structures in place, and a reader
 * that walks tag-length-value elements. Lengths up to 65535.
 */
#ifndef MT_DER_H_
#define MT_DER_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DER_BOOLEAN   0x01u
#define DER_INTEGER   0x02u
#define DER_BITSTRING 0x03u
#define DER_OCTETS    0x04u
#define DER_OID       0x06u
#define DER_UTF8      0x0Cu
#define DER_PRINTABLE 0x13u
#define DER_UTCTIME   0x17u
#define DER_GENTIME   0x18u
#define DER_SEQUENCE  0x30u
#define DER_SET       0x31u

#define DER_MAX_DEPTH 8

struct mt_der_writer {
	uint8_t *buf;
	size_t cap;
	size_t len;
	size_t open[DER_MAX_DEPTH]; /* where each open element's content starts */
	uint8_t tags[DER_MAX_DEPTH];
	int depth;
	bool error;
};

void mt_der_init(struct mt_der_writer *w, uint8_t *buf, size_t cap);
void mt_der_start(struct mt_der_writer *w, uint8_t tag);
void mt_der_end(struct mt_der_writer *w);
void mt_der_put(struct mt_der_writer *w, uint8_t tag, const uint8_t *data, size_t len);
/* An INTEGER from a big-endian unsigned value: leading zeros dropped, a zero added if the top bit is set. */
void mt_der_put_uint_bytes(struct mt_der_writer *w, const uint8_t *be, size_t len);
void mt_der_put_small_int(struct mt_der_writer *w, uint32_t v);
/* An OID from its encoded bytes. */
void mt_der_put_oid(struct mt_der_writer *w, const uint8_t *oid, size_t len);
int mt_der_finish(const struct mt_der_writer *w);

struct mt_der_elem {
	uint8_t tag;
	const uint8_t *start; /* the tag byte */
	const uint8_t *value;
	size_t len;           /* of the value */
	size_t total;         /* tag, length and value */
};

/* Reads one element at in (len bytes available). */
bool mt_der_read(const uint8_t *in, size_t len, struct mt_der_elem *e);
/* The n-th element (0-based) inside a constructed element. */
bool mt_der_child(const struct mt_der_elem *parent, unsigned int n, struct mt_der_elem *e);

/* ECDSA signatures: raw r||s (64 bytes) to DER and back. */
int mt_der_sig_from_raw(const uint8_t raw[64], uint8_t *out, size_t cap);
bool mt_der_sig_to_raw(const uint8_t *der, size_t len, uint8_t raw[64]);

#ifdef __cplusplus
}
#endif

#endif /* MT_DER_H_ */
