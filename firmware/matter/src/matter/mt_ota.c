/*
 * See mt_ota.h.
 */
#include "mt_ota.h"

#include <stdio.h>
#include <string.h>

static uint32_t rd32(const uint8_t *p)
{
	return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void wr32(uint8_t *p, uint32_t v)
{
	for (int i = 0; i < 4; i++) {
		p[i] = (uint8_t)(v >> (8 * i));
	}
}

bool mt_ota_parse_header(const uint8_t hdr[MT_OTA_HEADER_LEN], struct mt_ota_image *out)
{
	if (rd32(hdr) != MT_OTA_MAGIC) {
		return false;
	}
	out->vendor_id = (uint16_t)(hdr[4] | hdr[5] << 8);
	out->product_id = (uint16_t)(hdr[6] | hdr[7] << 8);
	out->version = rd32(&hdr[8]);
	out->length = rd32(&hdr[12]);
	memcpy(out->name, &hdr[16], MT_OTA_NAME_LEN);
	out->name[MT_OTA_NAME_LEN] = '\0';
	for (size_t i = 0; out->name[i]; i++) {
		char c = out->name[i];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
		      c == '-' || c == '_')) {
			return false;
		}
	}
	return out->length > 0 && out->name[0] != '\0';
}

void mt_ota_make_header(const struct mt_ota_image *img, uint8_t hdr[MT_OTA_HEADER_LEN])
{
	memset(hdr, 0, MT_OTA_HEADER_LEN);
	wr32(hdr, MT_OTA_MAGIC);
	hdr[4] = (uint8_t)img->vendor_id;
	hdr[5] = (uint8_t)(img->vendor_id >> 8);
	hdr[6] = (uint8_t)img->product_id;
	hdr[7] = (uint8_t)(img->product_id >> 8);
	wr32(&hdr[8], img->version);
	wr32(&hdr[12], img->length);
	strncpy((char *)&hdr[16], img->name, MT_OTA_NAME_LEN);
}

bool mt_ota_parse_query(const uint8_t *fields, size_t len, struct mt_ota_query *out)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool v = false;
	bool p = false;
	bool s = false;

	memset(out, 0, sizeof(*out));
	mt_tlv_reader_init(&r, fields, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && r.depth > 0) {
		if (e.context && e.tag == 0 && e.type == MT_TLV_UINT && r.depth == 1) {
			out->vendor_id = (uint16_t)e.v.u;
			v = true;
		} else if (e.context && e.tag == 1 && e.type == MT_TLV_UINT && r.depth == 1) {
			out->product_id = (uint16_t)e.v.u;
			p = true;
		} else if (e.context && e.tag == 2 && e.type == MT_TLV_UINT && r.depth == 1) {
			out->software_version = (uint32_t)e.v.u;
			s = true;
		} else if (!e.context && e.type == MT_TLV_UINT && r.depth == 2 && e.v.u == 0) {
			out->bdx_supported = true; /* ProtocolsSupported has BDXSynchronous (0) */
		}
	}
	return !r.error && r.depth == 0 && v && p && s;
}

int mt_ota_decide(const struct mt_ota_query *q, const struct mt_ota_image *img, bool have_image, bool busy)
{
	if (busy) {
		return MT_OTA_STATUS_BUSY;
	}
	if (!have_image || !q->bdx_supported || img->vendor_id != q->vendor_id || img->product_id != q->product_id ||
	    img->version <= q->software_version) {
		return MT_OTA_STATUS_NOT_AVAILABLE;
	}
	return MT_OTA_STATUS_AVAILABLE;
}

void mt_ota_query_response(struct mt_tlv_writer *w, int status, uint64_t provider_node,
			   const struct mt_ota_image *img, const uint8_t token[8])
{
	mt_tlv_put_uint(w, 0, (uint64_t)status);
	if (status == MT_OTA_STATUS_BUSY) {
		mt_tlv_put_uint(w, 1, 60); /* DelayedActionTime: ask again in a minute */
	}
	if (status != MT_OTA_STATUS_AVAILABLE) {
		return;
	}
	char uri[64];

	snprintf(uri, sizeof(uri), "bdx://%016llX/%s", (unsigned long long)provider_node, img->name);
	mt_tlv_put_str(w, 2, uri);                 /* ImageURI */
	mt_tlv_put_uint(w, 3, img->version);       /* SoftwareVersion */
	mt_tlv_put_str(w, 4, img->name);           /* SoftwareVersionString */
	mt_tlv_put_bytes(w, 5, token, 8);          /* UpdateToken */
	mt_tlv_put_bool(w, 6, false);              /* UserConsentNeeded */
}

bool mt_ota_parse_apply(const uint8_t *fields, size_t len, const uint8_t token[8], uint32_t *new_version)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	bool token_ok = false;
	bool version = false;

	mt_tlv_reader_init(&r, fields, len);
	if (!mt_tlv_next(&r, &e) || e.type != MT_TLV_STRUCT) {
		return false;
	}
	while (mt_tlv_next(&r, &e) && e.type != MT_TLV_END) {
		if (e.context && e.tag == 0 && e.type == MT_TLV_BYTES) {
			token_ok = e.len == 8 && memcmp(e.data, token, 8) == 0;
		} else if (e.context && e.tag == 1 && e.type == MT_TLV_UINT) {
			*new_version = (uint32_t)e.v.u;
			version = true;
		}
	}
	return !r.error && r.depth == 0 && token_ok && version;
}

void mt_ota_apply_response(struct mt_tlv_writer *w)
{
	mt_tlv_put_uint(w, 0, 0); /* Action: Proceed */
	mt_tlv_put_uint(w, 1, 0); /* DelayedActionTime */
}

void mt_ota_announce(struct mt_tlv_writer *w, uint64_t provider_node, uint16_t vendor_id, uint16_t endpoint)
{
	mt_tlv_put_uint(w, 0, provider_node); /* ProviderNodeID */
	mt_tlv_put_uint(w, 1, vendor_id);     /* VendorID */
	mt_tlv_put_uint(w, 2, 1);             /* AnnouncementReason: UpdateAvailable */
	mt_tlv_put_uint(w, 4, endpoint);      /* Endpoint: the provider cluster's */
}
