/*
 * See mt_dev_im.h.
 */
#include "mt_dev_im.h"

#include <string.h>

#include "mt_im.h"
#include "mt_node.h"
#include "mt_ota.h"
#include "mt_tlv.h"

extern const uint8_t mt_test_dac[];
extern const size_t mt_test_dac_len;
extern const uint8_t mt_test_pai[];
extern const size_t mt_test_pai_len;
extern const uint8_t mt_test_cd[];
extern const size_t mt_test_cd_len;

/* IM opcodes and statuses */
#define OP_STATUS     0x01u
#define OP_READ       0x02u
#define OP_SUBSCRIBE  0x03u
#define OP_REPORT     0x05u
#define OP_WRITE      0x06u
#define OP_WRITE_RESP 0x07u
#define OP_INVOKE     0x08u
#define OP_INVOKE_RESP 0x09u
#define OP_TIMED      0x0Au
#define ST_SUCCESS            0x00u
#define ST_FAILURE            0x01u
#define ST_INVALID_ACTION     0x80u
#define ST_UNSUPPORTED_ATTR   0x86u
#define ST_UNSUPPORTED_WRITE  0x88u
#define ST_UNSUPPORTED_ENDPOINT 0x7Fu
#define ST_FAILSAFE_REQUIRED  0xCAu

/* clusters */
#define CL_DESCRIPTOR 0x001Du
#define CL_ACL        0x001Fu
#define CL_BASIC      0x0028u
#define CL_OTA_REQ    0x002Au
#define CL_GEN_COMM   0x0030u
#define CL_NET_COMM   0x0031u
#define CL_OP_CREDS   0x003Eu

#define ATTR_FEATURE_MAP     0xFFFCu
#define ATTR_CLUSTER_REVISION 0xFFFDu

static const uint32_t server_clusters[] = {CL_DESCRIPTOR, CL_ACL, CL_BASIC, CL_OTA_REQ, CL_GEN_COMM, CL_NET_COMM,
					   CL_OP_CREDS};
static const struct mt_dev_platform *plat;
static uint8_t regulatory_config;
static uint8_t net_status;          /* LastNetworkingStatus */
static uint8_t net_id[32];
static size_t net_id_len;
static bool net_configured;
static uint64_t ota_providers_node; /* DefaultOTAProviders (one entry) */

void mt_dev_im_set_platform(const struct mt_dev_platform *p)
{
	plat = p;
}

/* ---- attributes ---- */

static bool attr_list(uint32_t cluster, uint32_t *out, size_t *n)
{
	static const uint32_t desc[] = {0, 1, 2, 3};
	static const uint32_t acl[] = {0, 2, 3, 4};
	static const uint32_t basic[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xA, 0x12, 0x13, 0x15, 0x16};
	static const uint32_t ota[] = {0, 1, 2, 3};
	static const uint32_t gen[] = {0, 1, 2, 3, 4};
	static const uint32_t net[] = {0, 1, 2, 3, 4, 5, 6, 7};
	static const uint32_t creds[] = {0, 1, 2, 3, 4, 5};
	const uint32_t *l;
	size_t c;

	switch (cluster) {
	case CL_DESCRIPTOR: l = desc; c = 4; break;
	case CL_ACL: l = acl; c = 4; break;
	case CL_BASIC: l = basic; c = sizeof(basic) / 4; break;
	case CL_OTA_REQ: l = ota; c = 4; break;
	case CL_GEN_COMM: l = gen; c = 5; break;
	case CL_NET_COMM: l = net; c = 8; break;
	case CL_OP_CREDS: l = creds; c = 6; break;
	default: return false;
	}
	memcpy(out, l, c * 4);
	out[c++] = ATTR_FEATURE_MAP;
	out[c++] = ATTR_CLUSTER_REVISION;
	*n = c;
	return true;
}

static void put_fabric_index(struct mt_tlv_writer *w)
{
	mt_tlv_put_uint(w, 0xFE, MT_NODE_FABRIC_INDEX);
}

/* Writes the attribute's value with tag 2; false if the attribute does not exist. */
static bool encode_attr(struct mt_tlv_writer *w, const struct mt_dev_session *s, uint32_t cluster, uint32_t attr)
{
	const struct mt_node_fabric *f = mt_node_fabric();
	uint32_t revision = 1;
	uint32_t features = 0;

	switch (cluster) {
	case CL_DESCRIPTOR:
		if (attr == 0) {
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
			mt_tlv_put_uint(w, 0, 0x0016); /* Root Node */
			mt_tlv_put_uint(w, 1, 3);
			mt_tlv_end(w);
			mt_tlv_end(w);
			return true;
		}
		if (attr == 1 || attr == 2 || attr == 3) {
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (attr == 1) {
				for (size_t i = 0; i < sizeof(server_clusters) / 4; i++) {
					mt_tlv_put_uint(w, MT_TLV_ANON, server_clusters[i]);
				}
			} else if (attr == 2) {
				mt_tlv_put_uint(w, MT_TLV_ANON, MT_CL_OTA_PROVIDER);
			}
			mt_tlv_end(w);
			return true;
		}
		revision = 2;
		break;
	case CL_ACL:
		if (attr == 0) {
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (f->present) {
				mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
				mt_tlv_put_uint(w, 1, 5); /* Privilege: Administer */
				mt_tlv_put_uint(w, 2, 2); /* AuthMode: CASE */
				mt_tlv_start(w, 3, MT_TLV_ARRAY);
				mt_tlv_put_uint(w, MT_TLV_ANON, f->admin_subject);
				mt_tlv_end(w);
				mt_tlv_put_null(w, 4);
				put_fabric_index(w);
				mt_tlv_end(w);
			}
			mt_tlv_end(w);
			return true;
		}
		if (attr == 2 || attr == 3 || attr == 4) {
			mt_tlv_put_uint(w, 2, attr == 2 ? 4 : attr == 3 ? 3 : 4);
			return true;
		}
		break;
	case CL_BASIC:
		revision = 3;
		switch (attr) {
		case 0: mt_tlv_put_uint(w, 2, 17); return true;            /* DataModelRevision */
		case 1: mt_tlv_put_str(w, 2, "Cranium"); return true;      /* VendorName */
		case 2: mt_tlv_put_uint(w, 2, MT_NODE_VENDOR_ID); return true;
		case 3: mt_tlv_put_str(w, 2, "Cranium board"); return true;
		case 4: mt_tlv_put_uint(w, 2, MT_NODE_PRODUCT_ID); return true;
		case 5: mt_tlv_put_str(w, 2, f->label); return true;       /* NodeLabel */
		case 6: mt_tlv_put_str(w, 2, "XX"); return true;           /* Location */
		case 7: mt_tlv_put_uint(w, 2, 1); return true;
		case 8: mt_tlv_put_str(w, 2, "nRF7002 DK"); return true;
		case 9: mt_tlv_put_uint(w, 2, plat ? plat->software_version : 0); return true;
		case 0xA: mt_tlv_put_str(w, 2, plat ? plat->software_version_string : "0"); return true;
		case 0x12: mt_tlv_put_str(w, 2, "cranium"); return true;   /* UniqueID */
		case 0x13:
			mt_tlv_start(w, 2, MT_TLV_STRUCT);                  /* CapabilityMinima */
			mt_tlv_put_uint(w, 0, 3);
			mt_tlv_put_uint(w, 1, 3);
			mt_tlv_end(w);
			return true;
		case 0x15: mt_tlv_put_uint(w, 2, 0x01040000); return true; /* SpecificationVersion 1.4 */
		case 0x16: mt_tlv_put_uint(w, 2, 1); return true;          /* MaxPathsPerInvoke */
		}
		break;
	case CL_OTA_REQ:
		switch (attr) {
		case 0:
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (f->ota_provider_node) {
				mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
				mt_tlv_put_uint(w, 1, f->ota_provider_node);
				mt_tlv_put_uint(w, 2, f->ota_provider_endpoint);
				put_fabric_index(w);
				mt_tlv_end(w);
			}
			mt_tlv_end(w);
			return true;
		case 1: mt_tlv_put_bool(w, 2, true); return true;  /* UpdatePossible */
		case 2: mt_tlv_put_uint(w, 2, 1); return true;     /* UpdateState: Idle */
		case 3: mt_tlv_put_null(w, 2); return true;        /* UpdateStateProgress */
		}
		break;
	case CL_GEN_COMM:
		revision = 1;
		switch (attr) {
		case 0: mt_tlv_put_uint(w, 2, mt_node_breadcrumb()); return true;
		case 1:
			mt_tlv_start(w, 2, MT_TLV_STRUCT);
			mt_tlv_put_uint(w, 0, 60);  /* FailSafeExpiryLengthSeconds */
			mt_tlv_put_uint(w, 1, 900); /* MaxCumulativeFailsafeSeconds */
			mt_tlv_end(w);
			return true;
		case 2: mt_tlv_put_uint(w, 2, regulatory_config); return true;
		case 3: mt_tlv_put_uint(w, 2, 2); return true;     /* LocationCapability: indoor and outdoor */
		case 4: mt_tlv_put_bool(w, 2, true); return true;  /* SupportsConcurrentConnection */
		}
		break;
	case CL_NET_COMM:
		features = plat && plat->wifi ? 0x1 : 0x2;
		switch (attr) {
		case 0: mt_tlv_put_uint(w, 2, 1); return true;     /* MaxNetworks */
		case 1:
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (net_configured) {
				mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
				mt_tlv_put_bytes(w, 0, net_id, net_id_len);
				mt_tlv_put_bool(w, 1, net_status == 0);
				mt_tlv_end(w);
			}
			mt_tlv_end(w);
			return true;
		case 2: mt_tlv_put_uint(w, 2, 10); return true;    /* ScanMaxTimeSeconds */
		case 3: mt_tlv_put_uint(w, 2, 30); return true;    /* ConnectMaxTimeSeconds */
		case 4: mt_tlv_put_bool(w, 2, true); return true;  /* InterfaceEnabled */
		case 5:
		case 6:
		case 7: mt_tlv_put_null(w, 2); return true;
		}
		break;
	case CL_OP_CREDS:
		switch (attr) {
		case 0:
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (f->present && s->fabric_index == MT_NODE_FABRIC_INDEX) {
				mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
				mt_tlv_put_bytes(w, 1, f->noc, f->noc_len);
				if (f->icac_len) {
					mt_tlv_put_bytes(w, 2, f->icac, f->icac_len);
				} else {
					mt_tlv_put_null(w, 2);
				}
				put_fabric_index(w);
				mt_tlv_end(w);
			}
			mt_tlv_end(w);
			return true;
		case 1:
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (f->present) {
				mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
				mt_tlv_put_bytes(w, 1, f->root_public_key, 65);
				mt_tlv_put_uint(w, 2, f->vendor_id);
				mt_tlv_put_uint(w, 3, f->fabric_id);
				mt_tlv_put_uint(w, 4, f->node_id);
				mt_tlv_put_str(w, 5, f->label);
				put_fabric_index(w);
				mt_tlv_end(w);
			}
			mt_tlv_end(w);
			return true;
		case 2: mt_tlv_put_uint(w, 2, 5); return true;     /* SupportedFabrics */
		case 3: mt_tlv_put_uint(w, 2, f->present ? 1 : 0); return true;
		case 4:
			mt_tlv_start(w, 2, MT_TLV_ARRAY);
			if (f->present) {
				mt_tlv_put_bytes(w, MT_TLV_ANON, f->rcac, f->rcac_len);
			}
			mt_tlv_end(w);
			return true;
		case 5: mt_tlv_put_uint(w, 2, s->fabric_index); return true;
		}
		break;
	default:
		return false;
	}
	if (attr == ATTR_FEATURE_MAP) {
		mt_tlv_put_uint(w, 2, features);
		return true;
	}
	if (attr == ATTR_CLUSTER_REVISION) {
		mt_tlv_put_uint(w, 2, revision);
		return true;
	}
	return false;
}

static void report_one(struct mt_tlv_writer *w, const struct mt_dev_session *s, uint32_t cluster, uint32_t attr)
{
	size_t mark = w->len;
	int depth = w->depth;

	mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT); /* AttributeReportIB */
	mt_tlv_start(w, 1, MT_TLV_STRUCT);           /* AttributeDataIB */
	mt_tlv_put_uint(w, 0, 1);                    /* DataVersion */
	mt_tlv_start(w, 1, MT_TLV_LIST);
	mt_tlv_put_uint(w, 2, 0);
	mt_tlv_put_uint(w, 3, cluster);
	mt_tlv_put_uint(w, 4, attr);
	mt_tlv_end(w);
	if (!encode_attr(w, s, cluster, attr)) {
		/* rewrite as an AttributeStatusIB */
		w->len = mark;
		w->depth = depth;
		mt_tlv_start(w, MT_TLV_ANON, MT_TLV_STRUCT);
		mt_tlv_start(w, 0, MT_TLV_STRUCT);
		mt_tlv_start(w, 0, MT_TLV_LIST);
		mt_tlv_put_uint(w, 2, 0);
		mt_tlv_put_uint(w, 3, cluster);
		mt_tlv_put_uint(w, 4, attr);
		mt_tlv_end(w);
		mt_tlv_start(w, 1, MT_TLV_STRUCT);
		mt_tlv_put_uint(w, 0, ST_UNSUPPORTED_ATTR);
		mt_tlv_end(w);
		mt_tlv_end(w);
		mt_tlv_end(w);
		return;
	}
	mt_tlv_end(w);
	mt_tlv_end(w);
}

/* One path of a ReadRequest, with wildcards, into the reports. Leaves out what does not fit. */
static void report_path(struct mt_tlv_writer *w, const struct mt_dev_session *s, bool has_ep, uint32_t ep,
			bool has_cl, uint32_t cluster, bool has_attr, uint32_t attr, size_t limit)
{
	if (has_ep && ep != 0) {
		return;
	}
	for (size_t c = 0; c < sizeof(server_clusters) / 4; c++) {
		uint32_t cl = server_clusters[c];
		uint32_t attrs[24];
		size_t n;

		if (has_cl && cl != cluster) {
			continue;
		}
		if (!attr_list(cl, attrs, &n)) {
			continue;
		}
		if (has_attr) {
			attrs[0] = attr;
			n = 1;
		}
		for (size_t a = 0; a < n; a++) {
			size_t before = w->len;
			int d = w->depth;

			report_one(w, s, cl, attrs[a]);
			if (w->len > limit) {
				w->len = before;
				w->depth = d;
				w->overflow = false;
				return;
			}
		}
		if (has_cl) {
			return;
		}
	}
	if (has_cl && !has_attr) {
		return;
	}
	if (has_cl && has_attr) {
		/* a cluster this board does not have */
		bool known = false;

		for (size_t c = 0; c < sizeof(server_clusters) / 4; c++) {
			known |= server_clusters[c] == cluster;
		}
		if (!known) {
			report_one(w, s, cluster, attr);
		}
	}
}

static int handle_read(const struct mt_dev_session *s, const uint8_t *in, size_t len, uint8_t *out, size_t cap)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 1, MT_TLV_ARRAY); /* AttributeReportIBs */
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return -1;
	}
	if (mt_tlv_find(&r, 0, &e) && e.type == MT_TLV_ARRAY) {
		while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
			bool he = false;
			bool hc = false;
			bool ha = false;
			uint32_t ep = 0;
			uint32_t cl = 0;
			uint32_t at = 0;

			if (e.type != MT_TLV_LIST) {
				return -1;
			}
			while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
				if (e.context && e.type == MT_TLV_UINT) {
					if (e.tag == 2) {
						he = true;
						ep = (uint32_t)e.v.u;
					} else if (e.tag == 3) {
						hc = true;
						cl = (uint32_t)e.v.u;
					} else if (e.tag == 4) {
						ha = true;
						at = (uint32_t)e.v.u;
					}
				}
			}
			report_path(&w, s, he, ep, hc, cl, ha, at, cap - 16);
		}
	}
	if (r.error) {
		return -1;
	}
	mt_tlv_end(&w);
	mt_tlv_put_bool(&w, 4, true); /* SuppressResponse: a read needs no StatusResponse */
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

static int handle_write(const struct mt_dev_session *s, const uint8_t *in, size_t len, uint8_t *out, size_t cap)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	struct mt_tlv_writer w;

	(void)s;
	mt_tlv_writer_init(&w, out, cap);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 0, MT_TLV_ARRAY); /* WriteResponses */
	mt_tlv_reader_init(&r, in, len);
	if (!mt_tlv_next(&r, &e) || !mt_tlv_find(&r, 2, &e) || e.type != MT_TLV_ARRAY) {
		return -1;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		uint32_t cl = 0;
		uint32_t at = 0;
		uint8_t status = ST_UNSUPPORTED_WRITE;

		if (e.type != MT_TLV_STRUCT) {
			return -1;
		}
		while (mt_tlv_next(&r, &e) && r.depth >= 3) {
			if (e.context && e.tag == 1 && e.type == MT_TLV_LIST) {
				while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
					if (e.context && e.tag == 3) {
						cl = (uint32_t)e.v.u;
					} else if (e.context && e.tag == 4) {
						at = (uint32_t)e.v.u;
					}
				}
			} else if (e.context && e.tag == 2) {
				if (cl == CL_GEN_COMM && at == 0 && e.type == MT_TLV_UINT) {
					mt_node_set_breadcrumb(e.v.u);
					status = ST_SUCCESS;
				} else if (cl == CL_BASIC && at == 5 && e.type == MT_TLV_UTF8 && e.len <= 32) {
					status = mt_node_set_label((const char *)e.data, e.len) == 0 ? ST_SUCCESS : ST_FAILURE;
				} else if (cl == CL_ACL && at == 0) {
					/* Access control is one administrator per fabric here; entries are accepted. */
					status = ST_SUCCESS;
				} else if (cl == CL_OTA_REQ && at == 0) {
					status = ST_SUCCESS;
				}
				if (e.type == MT_TLV_STRUCT || e.type == MT_TLV_ARRAY || e.type == MT_TLV_LIST) {
					if (cl == CL_OTA_REQ && at == 0) {
						struct mt_tlv_element x;
						int base = r.depth;

						while (mt_tlv_next(&r, &x) && r.depth >= base) {
							if (x.context && x.tag == 1 && x.type == MT_TLV_UINT) {
								ota_providers_node = x.v.u;
								(void)mt_node_set_ota_provider(x.v.u, 0);
							}
						}
					} else if (!mt_tlv_skip_container(&r)) {
						return -1;
					}
				}
			}
		}
		mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT); /* AttributeStatusIB */
		mt_tlv_start(&w, 0, MT_TLV_LIST);
		mt_tlv_put_uint(&w, 2, 0);
		mt_tlv_put_uint(&w, 3, cl);
		mt_tlv_put_uint(&w, 4, at);
		mt_tlv_end(&w);
		mt_tlv_start(&w, 1, MT_TLV_STRUCT);
		mt_tlv_put_uint(&w, 0, status);
		mt_tlv_end(&w);
		mt_tlv_end(&w);
	}
	mt_tlv_end(&w);
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

/* ---- commands ---- */

/* Reads one field of a command by tag: uint, bytes or string. */
static bool field(const struct mt_im_invoke_request *q, uint8_t tag, struct mt_tlv_element *e)
{
	struct mt_tlv_reader r;

	if (!q->fields) {
		return false;
	}
	mt_tlv_reader_init(&r, q->fields, q->fields_len);
	return mt_tlv_next(&r, e) && mt_tlv_find(&r, tag, e);
}

static int status_only(uint8_t *out, size_t cap, const struct mt_im_invoke_request *q, uint8_t status)
{
	return mt_im_response_status(out, cap, q, status);
}

static int invoke_gen_comm(const struct mt_dev_session *s, const struct mt_im_invoke_request *q, uint8_t *out,
			   size_t cap)
{
	struct mt_tlv_writer w;
	struct mt_tlv_element e;
	uint32_t resp;
	uint8_t err = 0;

	mt_tlv_writer_init(&w, out, cap);
	switch (q->command) {
	case MT_CMD_ARM_FAIL_SAFE: {
		uint16_t secs = field(q, 0, &e) && e.type == MT_TLV_UINT ? (uint16_t)e.v.u : 0;
		uint64_t bc = field(q, 1, &e) && e.type == MT_TLV_UINT ? e.v.u : 0;

		(void)mt_node_arm_fail_safe(secs, bc);
		resp = 1;
		break;
	}
	case MT_CMD_SET_REGULATORY_CONFIG:
		if (!mt_node_fail_safe_armed()) {
			err = 3; /* NoFailSafe */
		} else {
			regulatory_config = field(q, 0, &e) && e.type == MT_TLV_UINT ? (uint8_t)e.v.u : 0;
			if (field(q, 2, &e) && e.type == MT_TLV_UINT) {
				mt_node_set_breadcrumb(e.v.u);
			}
		}
		resp = 3;
		break;
	case MT_CMD_COMMISSIONING_COMPLETE:
		if (s->pase) {
			err = 1; /* must come over CASE */
		} else if (mt_node_commissioning_complete() != 0) {
			err = 3;
		}
		resp = 5;
		break;
	default:
		return status_only(out, cap, q, MT_IM_STATUS_UNSUPPORTED_COMMAND);
	}
	mt_im_response_begin(&w, 0, CL_GEN_COMM, resp);
	mt_tlv_put_uint(&w, 0, err); /* ErrorCode */
	mt_tlv_put_str(&w, 1, "");
	return mt_im_response_end(&w);
}

static int invoke_net_comm(const struct mt_im_invoke_request *q, uint8_t *out, size_t cap)
{
	struct mt_tlv_writer w;
	struct mt_tlv_element e;
	struct mt_tlv_element p;
	uint8_t st = 0;

	mt_tlv_writer_init(&w, out, cap);
	if (!mt_node_fail_safe_armed()) {
		return status_only(out, cap, q, ST_FAILSAFE_REQUIRED);
	}
	switch (q->command) {
	case 0: /* ScanNetworks: no results; the phone gives the network itself */
		mt_im_response_begin(&w, 0, CL_NET_COMM, 1);
		mt_tlv_put_uint(&w, 0, 0);
		mt_tlv_put_str(&w, 1, "");
		return mt_im_response_end(&w);
	case 2: /* AddOrUpdateWiFiNetwork */
		if (!plat || !plat->wifi || !field(q, 0, &e) || e.type != MT_TLV_BYTES || e.len > 32 ||
		    !field(q, 1, &p) || p.type != MT_TLV_BYTES) {
			st = 1; /* OutOfRange */
		} else {
			field(q, 0, &e);
			memcpy(net_id, e.data, e.len);
			net_id_len = e.len;
			field(q, 1, &p);
			st = plat->wifi_add(net_id, net_id_len, p.data, p.len) == 0 ? 0 : 7; /* UnknownError */
			net_configured = st == 0;
		}
		break;
	case 3: /* AddOrUpdateThreadNetwork */
		if (!plat || plat->wifi || !field(q, 0, &e) || e.type != MT_TLV_BYTES) {
			st = 1;
		} else {
			st = plat->thread_add(e.data, e.len) == 0 ? 0 : 7;
			net_configured = st == 0;
			net_id_len = 0;
		}
		break;
	case 6: /* ConnectNetwork */
		st = net_configured && plat && plat->wifi_connect && plat->wifi_connect() == 0 ? 0 : 3; /* NetworkNotFound */
		net_status = st;
		mt_im_response_begin(&w, 0, CL_NET_COMM, 7);
		mt_tlv_put_uint(&w, 0, st);
		mt_tlv_put_str(&w, 1, "");
		mt_tlv_put_null(&w, 2);
		return mt_im_response_end(&w);
	default:
		return status_only(out, cap, q, MT_IM_STATUS_UNSUPPORTED_COMMAND);
	}
	if (field(q, 2, &e) && e.type == MT_TLV_UINT && st == 0) {
		mt_node_set_breadcrumb(e.v.u);
	}
	mt_im_response_begin(&w, 0, CL_NET_COMM, 5); /* NetworkConfigResponse */
	mt_tlv_put_uint(&w, 0, st);
	mt_tlv_put_str(&w, 1, "");
	if (st == 0) {
		mt_tlv_put_uint(&w, 2, 0);
	}
	return mt_im_response_end(&w);
}

static int invoke_op_creds(const struct mt_dev_session *s, const struct mt_im_invoke_request *q, uint8_t *out,
			   size_t cap)
{
	static uint8_t elements[700];
	struct mt_tlv_writer w;
	struct mt_tlv_writer ew;
	struct mt_tlv_element e;
	uint8_t sig[64];

	mt_tlv_writer_init(&w, out, cap);
	switch (q->command) {
	case MT_CMD_CERT_CHAIN_REQUEST: {
		uint64_t type = field(q, 0, &e) && e.type == MT_TLV_UINT ? e.v.u : 0;

		if (type != 1 && type != 2) {
			return status_only(out, cap, q, MT_IM_STATUS_INVALID_COMMAND);
		}
		mt_im_response_begin(&w, 0, CL_OP_CREDS, 3);
		mt_tlv_put_bytes(&w, 0, type == 1 ? mt_test_dac : mt_test_pai, type == 1 ? mt_test_dac_len : mt_test_pai_len);
		return mt_im_response_end(&w);
	}
	case MT_CMD_ATTESTATION_REQUEST:
	case MT_CMD_CSR_REQUEST: {
		static uint8_t csr[300];
		int n;

		if (!s->pase || !field(q, 0, &e) || e.type != MT_TLV_BYTES || e.len != 32) {
			return status_only(out, cap, q, MT_IM_STATUS_INVALID_COMMAND);
		}
		mt_tlv_writer_init(&ew, elements, sizeof(elements) - 16);
		mt_tlv_start(&ew, MT_TLV_ANON, MT_TLV_STRUCT);
		if (q->command == MT_CMD_ATTESTATION_REQUEST) {
			mt_tlv_put_bytes(&ew, 1, mt_test_cd, mt_test_cd_len); /* certification declaration */
			mt_tlv_put_bytes(&ew, 2, e.data, 32);                /* nonce */
			mt_tlv_put_uint(&ew, 3, 0);                          /* timestamp */
		} else {
			n = mt_node_csr(csr, sizeof(csr));
			if (n < 0) {
				return status_only(out, cap, q, ST_FAILSAFE_REQUIRED);
			}
			mt_tlv_put_bytes(&ew, 1, csr, (size_t)n);
			mt_tlv_put_bytes(&ew, 2, e.data, 32);
		}
		mt_tlv_end(&ew);
		n = mt_tlv_finish(&ew);
		if (n < 0) {
			return -1;
		}
		memcpy(&elements[n], s->challenge, 16);
		if (mt_node_sign_dac(elements, (size_t)n + 16, sig) != 0) {
			return status_only(out, cap, q, ST_FAILURE);
		}
		mt_im_response_begin(&w, 0, CL_OP_CREDS, q->command == MT_CMD_ATTESTATION_REQUEST ? 1 : 5);
		mt_tlv_put_bytes(&w, 0, elements, (size_t)n);
		mt_tlv_put_bytes(&w, 1, sig, 64);
		return mt_im_response_end(&w);
	}
	case MT_CMD_ADD_TRUSTED_ROOT:
		if (!field(q, 0, &e) || e.type != MT_TLV_BYTES) {
			return status_only(out, cap, q, MT_IM_STATUS_INVALID_COMMAND);
		}
		return status_only(out, cap, q, mt_node_add_root(e.data, e.len) == 0 ? ST_SUCCESS : ST_FAILURE);
	case MT_CMD_ADD_NOC: {
		struct mt_tlv_element noc;
		struct mt_tlv_element icac;
		struct mt_tlv_element ipk;
		struct mt_tlv_element subj;
		struct mt_tlv_element vend;
		bool has_icac = field(q, 1, &icac) && icac.type == MT_TLV_BYTES;

		if (!field(q, 0, &noc) || noc.type != MT_TLV_BYTES || !field(q, 2, &ipk) || ipk.type != MT_TLV_BYTES ||
		    ipk.len != 16 || !field(q, 3, &subj) || subj.type != MT_TLV_UINT || !field(q, 4, &vend) ||
		    vend.type != MT_TLV_UINT) {
			return status_only(out, cap, q, MT_IM_STATUS_INVALID_COMMAND);
		}
		int st = mt_node_add_noc(noc.data, noc.len, has_icac ? icac.data : NULL, has_icac ? icac.len : 0, ipk.data,
					 subj.v.u, (uint16_t)vend.v.u);

		mt_im_response_begin(&w, 0, CL_OP_CREDS, 8); /* NOCResponse */
		mt_tlv_put_uint(&w, 0, (uint64_t)st);
		if (st == 0) {
			mt_tlv_put_uint(&w, 1, MT_NODE_FABRIC_INDEX);
		}
		return mt_im_response_end(&w);
	}
	case 0x09: /* UpdateFabricLabel */
		if (!field(q, 0, &e) || e.type != MT_TLV_UTF8) {
			return status_only(out, cap, q, MT_IM_STATUS_INVALID_COMMAND);
		}
		mt_im_response_begin(&w, 0, CL_OP_CREDS, 8);
		mt_tlv_put_uint(&w, 0, mt_node_set_label((const char *)e.data, e.len) == 0 ? 0 : 1);
		mt_tlv_put_uint(&w, 1, MT_NODE_FABRIC_INDEX);
		return mt_im_response_end(&w);
	case 0x0A: /* RemoveFabric */
		(void)mt_node_remove_fabric();
		mt_im_response_begin(&w, 0, CL_OP_CREDS, 8);
		mt_tlv_put_uint(&w, 0, 0);
		mt_tlv_put_uint(&w, 1, MT_NODE_FABRIC_INDEX);
		return mt_im_response_end(&w);
	default:
		return status_only(out, cap, q, MT_IM_STATUS_UNSUPPORTED_COMMAND);
	}
}

static int invoke_ota_req(const struct mt_im_invoke_request *q, uint8_t *out, size_t cap)
{
	struct mt_tlv_element node;
	struct mt_tlv_element ep;

	if (q->command != MT_OTA_ANNOUNCE_PROVIDER || !field(q, 0, &node) || node.type != MT_TLV_UINT) {
		return status_only(out, cap, q, MT_IM_STATUS_UNSUPPORTED_COMMAND);
	}
	uint16_t endpoint = field(q, 4, &ep) && ep.type == MT_TLV_UINT ? (uint16_t)ep.v.u : 0;

	(void)mt_node_set_ota_provider(node.v.u, endpoint);
	if (plat && plat->ota_announced) {
		plat->ota_announced(node.v.u, endpoint);
	}
	return status_only(out, cap, q, ST_SUCCESS);
}

int mt_dev_im(const struct mt_dev_session *s, uint8_t opcode, const uint8_t *in, size_t len, uint8_t *out_opcode,
	      uint8_t *out, size_t cap)
{
	struct mt_im_invoke_request q;
	struct mt_tlv_writer w;

	switch (opcode) {
	case OP_READ:
		*out_opcode = OP_REPORT;
		return handle_read(s, in, len, out, cap);
	case OP_WRITE:
		*out_opcode = OP_WRITE_RESP;
		return handle_write(s, in, len, out, cap);
	case OP_TIMED:
		*out_opcode = OP_STATUS;
		return mt_im_status_response(out, cap, ST_SUCCESS);
	case OP_SUBSCRIBE:
		*out_opcode = OP_STATUS;
		return mt_im_status_response(out, cap, ST_INVALID_ACTION);
	case OP_INVOKE:
		*out_opcode = OP_INVOKE_RESP;
		if (!mt_im_parse_invoke_request(in, len, &q)) {
			*out_opcode = OP_STATUS;
			return mt_im_status_response(out, cap, ST_INVALID_ACTION);
		}
		if (q.endpoint != 0) {
			return status_only(out, cap, &q, ST_UNSUPPORTED_ENDPOINT);
		}
		switch (q.cluster) {
		case CL_GEN_COMM:
			return invoke_gen_comm(s, &q, out, cap);
		case CL_NET_COMM:
			return invoke_net_comm(&q, out, cap);
		case CL_OP_CREDS:
			return invoke_op_creds(s, &q, out, cap);
		case CL_OTA_REQ:
			return invoke_ota_req(&q, out, cap);
		default:
			return status_only(out, cap, &q, MT_IM_STATUS_UNSUPPORTED_CLUSTER);
		}
	case OP_STATUS:
		return -1;
	default:
		mt_tlv_writer_init(&w, out, cap);
		*out_opcode = OP_STATUS;
		return mt_im_status_response(out, cap, ST_INVALID_ACTION);
	}
}
