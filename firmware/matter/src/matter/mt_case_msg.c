/*
 * See mt_case_msg.h.
 */
#include "mt_case_msg.h"

#include <string.h>

#include "mt_tlv.h"

int mt_case_sigma1(uint8_t *out, size_t cap, const uint8_t random[32], uint16_t session_id,
		   const uint8_t destination_id[32], const uint8_t eph_pub[65])
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, random, 32);
	mt_tlv_put_uint(&w, 2, session_id);
	mt_tlv_put_bytes(&w, 3, destination_id, 32);
	mt_tlv_put_bytes(&w, 4, eph_pub, 65);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

bool mt_case_parse_sigma2(const uint8_t *in, size_t len, struct mt_case_sigma2 *out)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool have_sid = false;

	memset(out, 0, sizeof(*out));
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES && e.len == 32) {
			out->random = e.data;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_UINT && e.v.u <= 0xFFFF) {
			out->session_id = (uint16_t)e.v.u;
			have_sid = true;
		} else if (e.context && e.tag == 3 && e.type == MT_TLV_BYTES && e.len == 65) {
			out->eph_pub = e.data;
		} else if (e.context && e.tag == 4 && e.type == MT_TLV_BYTES && e.len > MT_CASE_MIC_LEN) {
			out->encrypted = e.data;
			out->encrypted_len = e.len;
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
		}
	}
	return !r.error && r.depth == 0 && out->random && have_sid && out->eph_pub && out->encrypted;
}

bool mt_case_parse_tbe2(const uint8_t *in, size_t len, struct mt_case_tbe2 *out)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	memset(out, 0, sizeof(*out));
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES) {
			out->noc = e.data;
			out->noc_len = e.len;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_BYTES) {
			out->icac = e.data;
			out->icac_len = e.len;
		} else if (e.context && e.tag == 3 && e.type == MT_TLV_BYTES && e.len == 64) {
			out->signature = e.data;
		} else if (e.context && e.tag == 4 && e.type == MT_TLV_BYTES && e.len == 16) {
			out->resumption_id = e.data;
		}
	}
	return !r.error && r.depth == 0 && out->noc && out->signature && out->resumption_id;
}

int mt_case_tbs(uint8_t *out, size_t cap, const uint8_t *noc, size_t noc_len, const uint8_t *icac,
		size_t icac_len, const uint8_t sender_eph[65], const uint8_t receiver_eph[65])
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, noc, noc_len);
	if (icac) {
		mt_tlv_put_bytes(&w, 2, icac, icac_len);
	}
	mt_tlv_put_bytes(&w, 3, sender_eph, 65);
	mt_tlv_put_bytes(&w, 4, receiver_eph, 65);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

int mt_case_tbe3(uint8_t *out, size_t cap, const uint8_t *noc, size_t noc_len, const uint8_t sig[64])
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, noc, noc_len);
	mt_tlv_put_bytes(&w, 3, sig, 64);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

int mt_case_sigma3(uint8_t *out, size_t cap, const uint8_t *encrypted, size_t len)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, encrypted, len);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

size_t mt_case_destination_message(uint8_t out[32 + 65 + 8 + 8], const uint8_t random[32],
				   const uint8_t root_pub[65], uint64_t fabric_id, uint64_t node_id)
{
	memcpy(out, random, 32);
	memcpy(&out[32], root_pub, 65);
	for (int i = 0; i < 8; i++) {
		out[97 + i] = (uint8_t)(fabric_id >> (8 * i));
		out[105 + i] = (uint8_t)(node_id >> (8 * i));
	}
	return 113;
}

bool mt_case_parse_sigma1(const uint8_t *in, size_t len, struct mt_case_sigma1 *out)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool have_sid = false;

	memset(out, 0, sizeof(*out));
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES && e.len == 32) {
			out->random = e.data;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_UINT && e.v.u <= 0xFFFF) {
			out->session_id = (uint16_t)e.v.u;
			have_sid = true;
		} else if (e.context && e.tag == 3 && e.type == MT_TLV_BYTES && e.len == 32) {
			out->destination_id = e.data;
		} else if (e.context && e.tag == 4 && e.type == MT_TLV_BYTES && e.len == 65) {
			out->eph_pub = e.data;
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
		}
	}
	return !r.error && r.depth == 0 && out->random && have_sid && out->destination_id && out->eph_pub;
}

int mt_case_tbe2(uint8_t *out, size_t cap, const uint8_t *noc, size_t noc_len, const uint8_t sig[64],
		 const uint8_t resumption_id[16])
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, noc, noc_len);
	mt_tlv_put_bytes(&w, 3, sig, 64);
	mt_tlv_put_bytes(&w, 4, resumption_id, 16);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

int mt_case_sigma2(uint8_t *out, size_t cap, const uint8_t random[32], uint16_t session_id,
		   const uint8_t eph_pub[65], const uint8_t *encrypted, size_t encrypted_len)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, random, 32);
	mt_tlv_put_uint(&w, 2, session_id);
	mt_tlv_put_bytes(&w, 3, eph_pub, 65);
	mt_tlv_put_bytes(&w, 4, encrypted, encrypted_len);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

bool mt_case_parse_sigma3(const uint8_t *in, size_t len, const uint8_t **encrypted, size_t *encrypted_len)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	*encrypted = NULL;
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES && e.len > MT_CASE_MIC_LEN) {
			*encrypted = e.data;
			*encrypted_len = e.len;
		}
	}
	return !r.error && r.depth == 0 && *encrypted != NULL;
}

bool mt_case_parse_tbe3(const uint8_t *in, size_t len, const uint8_t **noc, size_t *noc_len, const uint8_t **sig)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	*noc = NULL;
	*sig = NULL;
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES) {
			*noc = e.data;
			*noc_len = e.len;
		} else if (e.context && e.tag == 3 && e.type == MT_TLV_BYTES && e.len == 64) {
			*sig = e.data;
		} else if (e.context && e.tag == 2) {
			return false; /* an ICAC: this fabric has none */
		}
	}
	return !r.error && r.depth == 0 && *noc && *sig;
}
