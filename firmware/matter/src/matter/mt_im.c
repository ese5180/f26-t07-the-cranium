/*
 * See mt_im.h.
 */
#include "mt_im.h"

#include <string.h>

void mt_im_invoke_begin(struct mt_tlv_writer *w, uint16_t endpoint, uint32_t cluster, uint32_t command,
			bool timed)
{
	mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bool(w, 0, false); /* SuppressResponse */
	mt_tlv_put_bool(w, 1, timed); /* TimedRequest */
	mt_tlv_start(w, 2, MT_TLV_ARRAY); /* InvokeRequests */
	mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT); /* CommandDataIB */
	mt_tlv_start(w, 0, MT_TLV_LIST); /* CommandPathIB */
	mt_tlv_put_uint(w, 0, endpoint);
	mt_tlv_put_uint(w, 1, cluster);
	mt_tlv_put_uint(w, 2, command);
	mt_tlv_end(w);
	mt_tlv_start(w, 1, MT_TLV_STRUCT); /* CommandFields */
}

int mt_im_invoke_end(struct mt_tlv_writer *w)
{
	mt_tlv_end(w); /* CommandFields */
	mt_tlv_end(w); /* CommandDataIB */
	mt_tlv_end(w); /* InvokeRequests */
	mt_tlv_put_uint(w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(w);
	return mt_tlv_finish(w);
}

int mt_im_read_request(uint8_t *out, size_t cap, const struct mt_attr_path *paths, size_t count)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 0, MT_TLV_ARRAY); /* AttributeRequests */
	for (size_t i = 0; i < count; i++) {
		mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_LIST); /* AttributePathIB */
		mt_tlv_put_uint(&w, 2, paths[i].endpoint);
		mt_tlv_put_uint(&w, 3, paths[i].cluster);
		mt_tlv_put_uint(&w, 4, paths[i].attribute);
		mt_tlv_end(&w);
	}
	mt_tlv_end(&w);
	mt_tlv_put_bool(&w, 3, false); /* FabricFiltered */
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

int mt_im_status_response(uint8_t *out, size_t cap, uint8_t status)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 0, status);
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

/* Reads a CommandPathIB list: cluster (1) and command (2). */
static bool read_path(struct mt_tlv_reader *r, uint32_t *cluster, uint32_t *command)
{
	struct mt_tlv_element e;
	bool got_cluster = false;
	bool got_command = false;

	while (mt_tlv_next(r, &e) && e.type != MT_TLV_END) {
		if (e.type == MT_TLV_UINT && e.context && e.tag == 1) {
			*cluster = (uint32_t)e.v.u;
			got_cluster = true;
		} else if (e.type == MT_TLV_UINT && e.context && e.tag == 2) {
			*command = (uint32_t)e.v.u;
			got_command = true;
		}
	}
	return !r->error && got_cluster && got_command;
}

bool mt_im_parse_invoke_response(const uint8_t *in, size_t len, struct mt_im_invoke_result *res)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	memset(res, 0, sizeof(*res));
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	/* InvokeResponses (1): an array of InvokeResponseIB; the first one counts. */
	if (!mt_tlv_find(&r, 1, &e) || e.type != MT_TLV_ARRAY) {
		return false;
	}
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	if (!mt_tlv_next(&r, &e) || !e.context || e.type != MT_TLV_STRUCT) {
		return false;
	}
	if (e.tag == 0) {
		/* CommandDataIB: path (0), fields (1) */
		while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
			if (e.context && e.tag == 0 && e.type == MT_TLV_LIST) {
				if (!read_path(&r, &res->cluster, &res->command)) {
					return false;
				}
			} else if (e.context && e.tag == 1 && e.type == MT_TLV_STRUCT) {
				size_t start = r.pos - 2; /* control byte and tag of the structure */

				if (!mt_tlv_skip_container(&r)) {
					return false;
				}
				res->has_fields = true;
				res->fields = &in[start];
				res->fields_len = r.pos - start;
			} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
				if (!mt_tlv_skip_container(&r)) {
					return false;
				}
			}
		}
		return !r.error && res->has_fields && mt_tlv_close_all(&r);
	}
	if (e.tag == 1) {
		/* CommandStatusIB: path (0), status (1: StatusIB with status 0 and cluster status 1) */
		bool got_status = false;

		while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
			if (e.context && e.tag == 0 && e.type == MT_TLV_LIST) {
				if (!read_path(&r, &res->cluster, &res->command)) {
					return false;
				}
			} else if (e.context && e.tag == 1 && e.type == MT_TLV_STRUCT) {
				while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
					if (e.context && e.tag == 0 && e.type == MT_TLV_UINT) {
						res->status = (uint8_t)e.v.u;
						got_status = true;
					} else if (e.context && e.tag == 1 && e.type == MT_TLV_UINT) {
						res->has_cluster_status = true;
						res->cluster_status = (uint8_t)e.v.u;
					}
				}
			} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
				if (!mt_tlv_skip_container(&r)) {
					return false;
				}
			}
		}
		return !r.error && got_status && mt_tlv_close_all(&r);
	}
	return false;
}

bool mt_im_parse_invoke_request(const uint8_t *in, size_t len, struct mt_im_invoke_request *out)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool got_path = false;

	memset(out, 0, sizeof(*out));
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	/* InvokeRequests (2): the first CommandDataIB */
	if (!mt_tlv_find(&r, 2, &e) || e.type != MT_TLV_ARRAY) {
		return false;
	}
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 0 && e.type == MT_TLV_LIST) {
			while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
				if (e.context && e.tag == 0 && e.type == MT_TLV_UINT) {
					out->endpoint = (uint16_t)e.v.u;
				} else if (e.context && e.tag == 1 && e.type == MT_TLV_UINT) {
					out->cluster = (uint32_t)e.v.u;
					got_path = true;
				} else if (e.context && e.tag == 2 && e.type == MT_TLV_UINT) {
					out->command = (uint32_t)e.v.u;
				}
			}
		} else if (e.context && e.tag == 1 && e.type == MT_TLV_STRUCT) {
			size_t start = r.pos - 2;

			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
			out->fields = &in[start];
			out->fields_len = r.pos - start;
		} else if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
			if (!mt_tlv_skip_container(&r)) {
				return false;
			}
		}
	}
	return !r.error && got_path && mt_tlv_close_all(&r);
}

void mt_im_response_begin(struct mt_tlv_writer *w, uint16_t endpoint, uint32_t cluster, uint32_t command)
{
	mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bool(w, 0, false); /* SuppressResponse */
	mt_tlv_start(w, 1, MT_TLV_ARRAY); /* InvokeResponses */
	mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT); /* InvokeResponseIB */
	mt_tlv_start(w, 0, MT_TLV_STRUCT); /* CommandDataIB */
	mt_tlv_start(w, 0, MT_TLV_LIST);
	mt_tlv_put_uint(w, 0, endpoint);
	mt_tlv_put_uint(w, 1, cluster);
	mt_tlv_put_uint(w, 2, command);
	mt_tlv_end(w);
	mt_tlv_start(w, 1, MT_TLV_STRUCT);
}

int mt_im_response_status(uint8_t *out, size_t cap, const struct mt_im_invoke_request *req, uint8_t status)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bool(&w, 0, false);
	mt_tlv_start(&w, 1, MT_TLV_ARRAY);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 1, MT_TLV_STRUCT); /* CommandStatusIB */
	mt_tlv_start(&w, 0, MT_TLV_LIST);
	mt_tlv_put_uint(&w, 0, req->endpoint);
	mt_tlv_put_uint(&w, 1, req->cluster);
	mt_tlv_put_uint(&w, 2, req->command);
	mt_tlv_end(&w);
	mt_tlv_start(&w, 1, MT_TLV_STRUCT); /* StatusIB */
	mt_tlv_put_uint(&w, 0, status);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}
