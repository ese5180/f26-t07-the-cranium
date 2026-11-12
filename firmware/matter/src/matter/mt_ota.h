/*
 * The OTA provider's side of the OTA Software Update clusters (Matter specification 11.20): what this board
 * answers a device that asks for an update, and the image it serves from its store. The image lives in the
 * board's external flash with a small header naming the vendor, product and version it is for.
 */
#ifndef MT_OTA_H_
#define MT_OTA_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mt_tlv.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MT_OTA_QUERY_IMAGE           0x00u
#define MT_OTA_QUERY_IMAGE_RESPONSE  0x01u
#define MT_OTA_APPLY_UPDATE          0x02u
#define MT_OTA_APPLY_UPDATE_RESPONSE 0x03u
#define MT_OTA_NOTIFY_APPLIED        0x04u
#define MT_OTA_ANNOUNCE_PROVIDER     0x00u /* OTA Requestor cluster */

#define MT_OTA_STATUS_AVAILABLE     0
#define MT_OTA_STATUS_BUSY          1
#define MT_OTA_STATUS_NOT_AVAILABLE 2

#define MT_OTA_MAGIC 0x494f544du /* "MTOI" */
#define MT_OTA_HEADER_LEN 32
#define MT_OTA_NAME_LEN 16

/* The store's header, before the image itself. */
struct mt_ota_image {
	uint16_t vendor_id;
	uint16_t product_id;
	uint32_t version;
	uint32_t length;
	char name[MT_OTA_NAME_LEN + 1]; /* the BDX file designator, also the version string */
};

bool mt_ota_parse_header(const uint8_t hdr[MT_OTA_HEADER_LEN], struct mt_ota_image *out);
void mt_ota_make_header(const struct mt_ota_image *img, uint8_t hdr[MT_OTA_HEADER_LEN]);

struct mt_ota_query {
	uint16_t vendor_id;
	uint16_t product_id;
	uint32_t software_version;
	bool bdx_supported;
};
bool mt_ota_parse_query(const uint8_t *fields, size_t len, struct mt_ota_query *out);

/* The answer to a query: an update when the stored image is for this device and newer. */
int mt_ota_decide(const struct mt_ota_query *q, const struct mt_ota_image *img, bool have_image, bool busy);

/* QueryImageResponse fields */
void mt_ota_query_response(struct mt_tlv_writer *w, int status, uint64_t provider_node,
			   const struct mt_ota_image *img, const uint8_t token[8]);
/* ApplyUpdateRequest: the token must be ours */
bool mt_ota_parse_apply(const uint8_t *fields, size_t len, const uint8_t token[8], uint32_t *new_version);
/* ApplyUpdateResponse fields: proceed now */
void mt_ota_apply_response(struct mt_tlv_writer *w);
/* AnnounceOTAProvider fields */
void mt_ota_announce(struct mt_tlv_writer *w, uint64_t provider_node, uint16_t vendor_id, uint16_t endpoint);

#ifdef __cplusplus
}
#endif

#endif /* MT_OTA_H_ */
