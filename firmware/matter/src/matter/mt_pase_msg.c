/*
 * See mt_pase_msg.h.
 */
#include "mt_pase_msg.h"

#include <string.h>

#include "mt_tlv.h"

int mt_pase_pbkdf_request(uint8_t *out, size_t cap, const uint8_t random[MT_PASE_RANDOM_LEN],
			  uint16_t session_id)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, random, MT_PASE_RANDOM_LEN); /* initiatorRandom */
	mt_tlv_put_uint(&w, 2, session_id);                    /* initiatorSessionId */
	mt_tlv_put_uint(&w, 3, 0);                             /* passcodeId: the default passcode */
	mt_tlv_put_bool(&w, 4, false);                         /* hasPBKDFParameters */
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

bool mt_pase_parse_pbkdf_response(const uint8_t *in, size_t len, const uint8_t our_random[MT_PASE_RANDOM_LEN],
				  struct mt_pase_pbkdf_response *out)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool echoed = false;
	bool have_random = false;
	bool have_session = false;
	bool have_iter = false;
	bool have_salt = false;

	memset(out, 0, sizeof(*out));
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (!e.context) {
			continue;
		}
		if (e.tag == 1 && e.type == MT_TLV_BYTES) {
			echoed = e.len == MT_PASE_RANDOM_LEN && memcmp(e.data, our_random, MT_PASE_RANDOM_LEN) == 0;
		} else if (e.tag == 2 && e.type == MT_TLV_BYTES) {
			have_random = e.len == MT_PASE_RANDOM_LEN;
		} else if (e.tag == 3 && e.type == MT_TLV_UINT && e.v.u <= 0xFFFFu) {
			out->responder_session_id = (uint16_t)e.v.u;
			have_session = true;
		} else if (e.tag == 4 && e.type == MT_TLV_STRUCT) {
			while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
				if (e.context && e.tag == 1 && e.type == MT_TLV_UINT) {
					have_iter = e.v.u >= MT_PASE_ITER_MIN && e.v.u <= MT_PASE_ITER_MAX;
					out->iterations = (uint32_t)e.v.u;
				} else if (e.context && e.tag == 2 && e.type == MT_TLV_BYTES) {
					have_salt = e.len >= MT_PASE_SALT_MIN && e.len <= MT_PASE_SALT_MAX;
					if (have_salt) {
						memcpy(out->salt, e.data, e.len);
						out->salt_len = e.len;
					}
				}
			}
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
		}
	}
	return !r.error && r.depth == 0 && echoed && have_random && have_session && have_iter && have_salt;
}

static int one_field(uint8_t *out, size_t cap, uint8_t tag, const uint8_t *data, size_t len)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, tag, data, len);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

int mt_pase_pake1(uint8_t *out, size_t cap, const uint8_t pa[MT_PASE_POINT_LEN])
{
	return one_field(out, cap, 1, pa, MT_PASE_POINT_LEN);
}

int mt_pase_pake3(uint8_t *out, size_t cap, const uint8_t ca[MT_PASE_HASH_LEN])
{
	return one_field(out, cap, 1, ca, MT_PASE_HASH_LEN);
}

bool mt_pase_parse_pake2(const uint8_t *in, size_t len, uint8_t pb[MT_PASE_POINT_LEN],
			 uint8_t cb[MT_PASE_HASH_LEN])
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool have_pb = false;
	bool have_cb = false;

	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 1 && e.type == MT_TLV_BYTES && e.len == MT_PASE_POINT_LEN) {
			memcpy(pb, e.data, MT_PASE_POINT_LEN);
			have_pb = true;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_BYTES && e.len == MT_PASE_HASH_LEN) {
			memcpy(cb, e.data, MT_PASE_HASH_LEN);
			have_cb = true;
		}
	}
	return !r.error && r.depth == 0 && have_pb && have_cb;
}
