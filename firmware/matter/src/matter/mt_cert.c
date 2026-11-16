/*
 * See mt_cert.h. The TLV-to-DER rules follow the Matter specification's "conversion to X.509": DN attributes in
 * their order, Matter's 64-bit IDs as 16 upper-case hex digits in UTF8String, times before 2050 as UTCTime,
 * extensions in their order with basic constraints, key usage and extended key usage critical.
 */
#include "mt_cert.h"

#include <errno.h>
#include <string.h>

#include "mt_der.h"
#include "mt_tlv.h"

/* TLV tags of a certificate */
enum {
	T_SERIAL = 1, T_SIG_ALGO, T_ISSUER, T_NOT_BEFORE, T_NOT_AFTER, T_SUBJECT, T_PK_ALGO, T_CURVE, T_PUBKEY,
	T_EXTENSIONS, T_SIGNATURE,
};
/* DN attribute tags */
enum { DN_CN = 1, DN_NODE_ID = 17, DN_FW_SIGN_ID, DN_ICAC_ID, DN_RCAC_ID, DN_FABRIC_ID, DN_CAT };
/* extension tags */
enum { EXT_BASIC = 1, EXT_KEY_USAGE, EXT_EXT_KEY_USAGE, EXT_SKID, EXT_AKID };

static const uint8_t oid_ecdsa_sha256[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02};
static const uint8_t oid_ec_public_key[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01};
static const uint8_t oid_prime256v1[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07};
static const uint8_t oid_cn[] = {0x55, 0x04, 0x03};
/* 1.3.6.1.4.1.37244.1.x */
static const uint8_t oid_matter_prefix[] = {0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0xa2, 0x7c, 0x01};
static const uint8_t oid_basic[] = {0x55, 0x1d, 0x13};
static const uint8_t oid_key_usage[] = {0x55, 0x1d, 0x0f};
static const uint8_t oid_ext_key_usage[] = {0x55, 0x1d, 0x25};
static const uint8_t oid_skid[] = {0x55, 0x1d, 0x0e};
static const uint8_t oid_akid[] = {0x55, 0x1d, 0x23};
/* 1.3.6.1.5.5.7.3.x */
static const uint8_t oid_kp_prefix[] = {0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03};

static void put_hex_id(struct mt_der_writer *w, uint64_t v, unsigned int digits)
{
	static const char hex[] = "0123456789ABCDEF";
	uint8_t s[16];

	for (unsigned int i = 0; i < digits; i++) {
		s[i] = (uint8_t)hex[(v >> (4 * (digits - 1 - i))) & 0xF];
	}
	mt_der_put(w, DER_UTF8, s, digits);
}

/* A DN as a TLV list, read at the list's first member, to a DER Name. */
static bool convert_dn(struct mt_tlv_reader *r, struct mt_der_writer *w)
{
	struct mt_tlv_element e;

	mt_der_start(w, DER_SEQUENCE);
	while (mt_tlv_next(r, &e)) {
		if (e.type == MT_TLV_END) {
			mt_der_end(w);
			return true;
		}
		if (!e.context) {
			return false;
		}
		uint8_t oid[16];
		size_t oid_len;

		mt_der_start(w, DER_SET);
		mt_der_start(w, DER_SEQUENCE);
		if (e.tag >= DN_NODE_ID && e.tag <= DN_CAT && e.type == MT_TLV_UINT) {
			memcpy(oid, oid_matter_prefix, sizeof(oid_matter_prefix));
			oid[sizeof(oid_matter_prefix)] = (uint8_t)(e.tag - DN_NODE_ID + 1);
			oid_len = sizeof(oid_matter_prefix) + 1;
			mt_der_put_oid(w, oid, oid_len);
			put_hex_id(w, e.v.u, e.tag == DN_CAT ? 8 : 16);
		} else if (e.tag == DN_CN && e.type == MT_TLV_UTF8) {
			mt_der_put_oid(w, oid_cn, sizeof(oid_cn));
			mt_der_put(w, DER_UTF8, e.data, e.len);
		} else {
			return false;
		}
		mt_der_end(w);
		mt_der_end(w);
	}
	return false;
}

static void days_to_date(uint32_t days, unsigned int *y, unsigned int *m, unsigned int *d)
{
	/* days since 2000-01-01 to a civil date (Howard Hinnant's algorithm) */
	int64_t z = (int64_t)days + 10957 + 719468; /* 1970-01-01 to 2000-01-01 is 10957 days */
	int64_t era = z / 146097;
	int64_t doe = z - era * 146097;
	int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	int64_t mp = (5 * doy + 2) / 153;

	*d = (unsigned int)(doy - (153 * mp + 2) / 5 + 1);
	*m = (unsigned int)(mp < 10 ? mp + 3 : mp - 9);
	*y = (unsigned int)(yoe + era * 400 + (*m <= 2));
}

uint32_t mt_epoch_from_utc(unsigned int year, unsigned int month, unsigned int day, unsigned int hour,
			   unsigned int minute, unsigned int second)
{
	int64_t y = (int64_t)year - (month <= 2);
	int64_t era = y / 400;
	int64_t yoe = y - era * 400;
	int64_t doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
	int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	int64_t days = era * 146097 + doe - 719468 - 10957;

	return (uint32_t)(days * 86400 + hour * 3600 + minute * 60 + second);
}

static void put_time(struct mt_der_writer *w, uint32_t epoch, bool not_after)
{
	char s[16];
	unsigned int y;
	unsigned int mo;
	unsigned int d;

	if (not_after && epoch == 0) {
		mt_der_put(w, DER_GENTIME, (const uint8_t *)"99991231235959Z", 15);
		return;
	}
	days_to_date(epoch / 86400, &y, &mo, &d);
	unsigned int t = epoch % 86400;
	unsigned int v[6] = {y, mo, d, t / 3600, (t / 60) % 60, t % 60};
	size_t n = 0;

	if (y >= 2050) {
		s[n++] = (char)('0' + y / 1000);
		s[n++] = (char)('0' + (y / 100) % 10);
	}
	s[n++] = (char)('0' + (y / 10) % 10);
	s[n++] = (char)('0' + y % 10);
	for (int i = 1; i < 6; i++) {
		s[n++] = (char)('0' + v[i] / 10);
		s[n++] = (char)('0' + v[i] % 10);
	}
	s[n++] = 'Z';
	mt_der_put(w, y >= 2050 ? DER_GENTIME : DER_UTCTIME, (const uint8_t *)s, n);
}

static void ext_header(struct mt_der_writer *w, const uint8_t *oid, size_t oid_len, bool critical)
{
	static const uint8_t yes = 0xFF;

	mt_der_start(w, DER_SEQUENCE);
	mt_der_put_oid(w, oid, oid_len);
	if (critical) {
		mt_der_put(w, DER_BOOLEAN, &yes, 1);
	}
	mt_der_start(w, DER_OCTETS);
}

static void ext_footer(struct mt_der_writer *w)
{
	mt_der_end(w); /* OCTET STRING */
	mt_der_end(w); /* Extension */
}

static bool convert_extensions(struct mt_tlv_reader *r, struct mt_der_writer *w)
{
	struct mt_tlv_element e;

	mt_der_start(w, 0xA3);
	mt_der_start(w, DER_SEQUENCE);
	while (mt_tlv_next(r, &e)) {
		if (e.type == MT_TLV_END) {
			mt_der_end(w);
			mt_der_end(w);
			return true;
		}
		if (!e.context) {
			return false;
		}
		if (e.tag == EXT_BASIC && e.type == MT_TLV_STRUCT) {
			static const uint8_t yes = 0xFF;
			bool ca = false;
			bool has_path = false;
			uint64_t path = 0;

			while (mt_tlv_next(r, &e) && e.type != MT_TLV_END) {
				if (e.tag == 1 && e.type == MT_TLV_BOOL) {
					ca = e.v.b;
				} else if (e.tag == 2 && e.type == MT_TLV_UINT) {
					has_path = true;
					path = e.v.u;
				}
			}
			ext_header(w, oid_basic, sizeof(oid_basic), true);
			mt_der_start(w, DER_SEQUENCE);
			if (ca) {
				mt_der_put(w, DER_BOOLEAN, &yes, 1);
			}
			if (has_path) {
				mt_der_put_small_int(w, (uint32_t)path);
			}
			mt_der_end(w);
			ext_footer(w);
		} else if (e.tag == EXT_KEY_USAGE && e.type == MT_TLV_UINT) {
			uint16_t ku = (uint16_t)e.v.u;
			uint8_t bits[3] = {0, 0, 0};
			int high = -1;

			for (int i = 0; i < 9; i++) {
				if (ku & (1u << i)) {
					bits[1 + i / 8] |= (uint8_t)(0x80u >> (i % 8));
					high = i;
				}
			}
			if (high < 0) {
				return false;
			}
			bits[0] = (uint8_t)(7 - high % 8);
			ext_header(w, oid_key_usage, sizeof(oid_key_usage), true);
			mt_der_put(w, DER_BITSTRING, bits, (size_t)(2 + high / 8));
			ext_footer(w);
		} else if (e.tag == EXT_EXT_KEY_USAGE && e.type == MT_TLV_ARRAY) {
			ext_header(w, oid_ext_key_usage, sizeof(oid_ext_key_usage), true);
			mt_der_start(w, DER_SEQUENCE);
			while (mt_tlv_next(r, &e) && e.type != MT_TLV_END) {
				uint8_t oid[sizeof(oid_kp_prefix) + 1];

				memcpy(oid, oid_kp_prefix, sizeof(oid_kp_prefix));
				oid[sizeof(oid_kp_prefix)] = (uint8_t)e.v.u;
				mt_der_put_oid(w, oid, sizeof(oid));
			}
			mt_der_end(w);
			ext_footer(w);
		} else if (e.tag == EXT_SKID && e.type == MT_TLV_BYTES) {
			ext_header(w, oid_skid, sizeof(oid_skid), false);
			mt_der_put(w, DER_OCTETS, e.data, e.len);
			ext_footer(w);
		} else if (e.tag == EXT_AKID && e.type == MT_TLV_BYTES) {
			ext_header(w, oid_akid, sizeof(oid_akid), false);
			mt_der_start(w, DER_SEQUENCE);
			mt_der_put(w, 0x80, e.data, e.len);
			mt_der_end(w);
			ext_footer(w);
		} else {
			return false;
		}
	}
	return false;
}

int mt_cert_to_der(const uint8_t *tlv, size_t tlv_len, uint8_t *out, size_t cap, size_t *tbs_off, size_t *tbs_len)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	struct mt_der_writer w;
	static const uint8_t v3 = 2;
	const uint8_t *sig = NULL;
	uint32_t not_before = 0;

	mt_tlv_reader_init(&r, tlv, tlv_len);
	mt_der_init(&w, out, cap);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return -1;
	}
	mt_der_start(&w, DER_SEQUENCE); /* Certificate */
	size_t tbs_start = w.len;

	mt_der_start(&w, DER_SEQUENCE); /* TBSCertificate */
	mt_der_start(&w, 0xA0);
	mt_der_put(&w, DER_INTEGER, &v3, 1);
	mt_der_end(&w);
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (!e.context) {
			return -1;
		}
		switch (e.tag) {
		case T_SERIAL:
			if (e.type != MT_TLV_BYTES || e.len == 0 || e.len > 20) {
				return -1;
			}
			mt_der_put(&w, DER_INTEGER, e.data, e.len);
			break;
		case T_SIG_ALGO:
			if (e.type != MT_TLV_UINT || e.v.u != 1) {
				return -1;
			}
			mt_der_start(&w, DER_SEQUENCE);
			mt_der_put_oid(&w, oid_ecdsa_sha256, sizeof(oid_ecdsa_sha256));
			mt_der_end(&w);
			break;
		case T_ISSUER:
		case T_SUBJECT:
			if (e.type != MT_TLV_LIST || !convert_dn(&r, &w)) {
				return -1;
			}
			break;
		case T_NOT_BEFORE:
			if (e.type != MT_TLV_UINT) {
				return -1;
			}
			not_before = (uint32_t)e.v.u;
			break;
		case T_NOT_AFTER:
			if (e.type != MT_TLV_UINT) {
				return -1;
			}
			mt_der_start(&w, DER_SEQUENCE);
			put_time(&w, not_before, false);
			put_time(&w, (uint32_t)e.v.u, true);
			mt_der_end(&w);
			break;
		case T_PK_ALGO:
		case T_CURVE:
			if (e.type != MT_TLV_UINT || e.v.u != 1) {
				return -1;
			}
			break;
		case T_PUBKEY: {
			uint8_t bits[66];

			if (e.type != MT_TLV_BYTES || e.len != 65) {
				return -1;
			}
			bits[0] = 0;
			memcpy(&bits[1], e.data, 65);
			mt_der_start(&w, DER_SEQUENCE);
			mt_der_start(&w, DER_SEQUENCE);
			mt_der_put_oid(&w, oid_ec_public_key, sizeof(oid_ec_public_key));
			mt_der_put_oid(&w, oid_prime256v1, sizeof(oid_prime256v1));
			mt_der_end(&w);
			mt_der_put(&w, DER_BITSTRING, bits, sizeof(bits));
			mt_der_end(&w);
			break;
		}
		case T_EXTENSIONS:
			if (e.type != MT_TLV_LIST || !convert_extensions(&r, &w)) {
				return -1;
			}
			break;
		case T_SIGNATURE:
			if (e.type != MT_TLV_BYTES || e.len != 64) {
				return -1;
			}
			sig = e.data;
			break;
		default:
			return -1;
		}
	}
	if (r.error || r.depth != 0) {
		return -1;
	}
	mt_der_end(&w); /* TBSCertificate */
	if (w.error) {
		return -1;
	}
	size_t tbs_total = w.len - tbs_start;

	if (sig == NULL) {
		/* Only the to-be-signed part: move it to the start. */
		memmove(out, &out[tbs_start], tbs_total);
		if (tbs_off) {
			*tbs_off = 0;
		}
		if (tbs_len) {
			*tbs_len = tbs_total;
		}
		return (int)tbs_total;
	}
	uint8_t sig_der[80];
	uint8_t bits[81];
	int n = mt_der_sig_from_raw(sig, sig_der, sizeof(sig_der));

	if (n < 0) {
		return -1;
	}
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_put_oid(&w, oid_ecdsa_sha256, sizeof(oid_ecdsa_sha256));
	mt_der_end(&w);
	bits[0] = 0;
	memcpy(&bits[1], sig_der, (size_t)n);
	mt_der_put(&w, DER_BITSTRING, bits, (size_t)n + 1);
	mt_der_end(&w); /* Certificate */
	n = mt_der_finish(&w);
	if (n < 0) {
		return -1;
	}
	/* The outer header now sits before the TBS: find where the TBS starts. */
	struct mt_der_elem cert;
	struct mt_der_elem tbs;

	if (!mt_der_read(out, (size_t)n, &cert) || !mt_der_child(&cert, 0, &tbs)) {
		return -1;
	}
	if (tbs_off) {
		*tbs_off = (size_t)(tbs.start - out);
	}
	if (tbs_len) {
		*tbs_len = tbs.total;
	}
	return n;
}

static void put_be64(uint8_t *o, uint64_t v)
{
	for (int i = 0; i < 8; i++) {
		o[i] = (uint8_t)(v >> (56 - 8 * i));
	}
}

static int write_tlv(const struct mt_cert_params *p, const uint8_t *sig, uint8_t *out, size_t cap)
{
	struct mt_tlv_writer w;
	uint8_t serial[9];
	size_t serial_len = 8;

	put_be64(&serial[1], p->serial);
	serial[0] = 0;
	/* A positive DER integer: a leading zero byte when the top bit is set. */
	const uint8_t *s = &serial[1];

	if (serial[1] & 0x80) {
		s = serial;
		serial_len = 9;
	}
	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, T_SERIAL, s, serial_len);
	mt_tlv_put_uint(&w, T_SIG_ALGO, 1);
	mt_tlv_start(&w, T_ISSUER, MT_TLV_LIST);
	mt_tlv_put_uint(&w, DN_RCAC_ID, p->rcac_id);
	if (p->is_root && p->fabric_id != 0) {
		mt_tlv_put_uint(&w, DN_FABRIC_ID, p->fabric_id);
	}
	mt_tlv_end(&w);
	mt_tlv_put_uint(&w, T_NOT_BEFORE, p->not_before);
	mt_tlv_put_uint(&w, T_NOT_AFTER, p->not_after);
	mt_tlv_start(&w, T_SUBJECT, MT_TLV_LIST);
	if (p->is_root) {
		mt_tlv_put_uint(&w, DN_RCAC_ID, p->rcac_id);
		if (p->fabric_id != 0) {
			mt_tlv_put_uint(&w, DN_FABRIC_ID, p->fabric_id);
		}
	} else {
		mt_tlv_put_uint(&w, DN_NODE_ID, p->node_id);
		mt_tlv_put_uint(&w, DN_FABRIC_ID, p->fabric_id);
	}
	mt_tlv_end(&w);
	mt_tlv_put_uint(&w, T_PK_ALGO, 1);
	mt_tlv_put_uint(&w, T_CURVE, 1);
	mt_tlv_put_bytes(&w, T_PUBKEY, p->public_key, 65);
	mt_tlv_start(&w, T_EXTENSIONS, MT_TLV_LIST);
	mt_tlv_start(&w, EXT_BASIC, MT_TLV_STRUCT);
	mt_tlv_put_bool(&w, 1, p->is_root);
	mt_tlv_end(&w);
	if (p->is_root) {
		mt_tlv_put_uint(&w, EXT_KEY_USAGE, 0x60); /* keyCertSign, cRLSign */
	} else {
		mt_tlv_put_uint(&w, EXT_KEY_USAGE, 0x01); /* digitalSignature */
		mt_tlv_start(&w, EXT_EXT_KEY_USAGE, MT_TLV_ARRAY);
		mt_tlv_put_uint(&w, MT_TLV_ANON, 2); /* clientAuth */
		mt_tlv_put_uint(&w, MT_TLV_ANON, 1); /* serverAuth */
		mt_tlv_end(&w);
	}
	mt_tlv_put_bytes(&w, EXT_SKID, p->subject_key_id, 20);
	mt_tlv_put_bytes(&w, EXT_AKID, p->authority_key_id, 20);
	mt_tlv_end(&w);
	if (sig) {
		mt_tlv_put_bytes(&w, T_SIGNATURE, sig, 64);
	}
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

int mt_cert_make(const struct mt_cert_params *p, mt_sign_fn sign, void *sign_ctx, uint8_t *out, size_t cap)
{
	uint8_t tbs[MT_CERT_DER_MAX];
	uint8_t sig[64];
	int n = write_tlv(p, NULL, out, cap);

	if (n < 0) {
		return -ENOBUFS;
	}
	int t = mt_cert_to_der(out, (size_t)n, tbs, sizeof(tbs), NULL, NULL);

	if (t < 0) {
		return -EINVAL;
	}
	int err = sign(sign_ctx, tbs, (size_t)t, sig);

	if (err) {
		return err;
	}
	n = write_tlv(p, sig, out, cap);
	return n < 0 ? -ENOBUFS : n;
}

bool mt_cert_read(const uint8_t *tlv, size_t len, uint8_t public_key[65], uint64_t *node_id, uint64_t *fabric_id)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool have_key = false;

	*node_id = 0;
	*fabric_id = 0;
	mt_tlv_reader_init(&r, tlv, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == T_SUBJECT && e.type == MT_TLV_LIST) {
			while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
				if (e.tag == DN_NODE_ID && e.type == MT_TLV_UINT) {
					*node_id = e.v.u;
				} else if (e.tag == DN_FABRIC_ID && e.type == MT_TLV_UINT) {
					*fabric_id = e.v.u;
				}
			}
		} else if (e.context && e.tag == T_PUBKEY && e.type == MT_TLV_BYTES && e.len == 65) {
			memcpy(public_key, e.data, 65);
			have_key = true;
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
		}
	}
	return !r.error && r.depth == 0 && have_key;
}
