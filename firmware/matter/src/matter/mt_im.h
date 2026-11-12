/*
 * The Interaction Model client (Matter specification 8): the requests a commissioner sends and the answers it
 * reads. Invoke (commands), Read (attributes), and the status in their responses. Message bodies only; the
 * opcodes go in the protocol header (protocol MT_PROTO_IM).
 */
#ifndef MT_IM_H_
#define MT_IM_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mt_tlv.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MT_IM_STATUS_RESPONSE 0x01u
#define MT_IM_READ_REQUEST    0x02u
#define MT_IM_REPORT_DATA     0x05u
#define MT_IM_INVOKE_REQUEST  0x08u
#define MT_IM_INVOKE_RESPONSE 0x09u

#define MT_IM_REVISION 12

/* Clusters and commands commissioning and the first test use. */
#define MT_CL_ONOFF                 0x0006u
#define MT_CL_GENERAL_COMMISSIONING 0x0030u
#define MT_CL_NETWORK_COMMISSIONING 0x0031u
#define MT_CL_OPERATIONAL_CREDS     0x003Eu
#define MT_CL_OTA_PROVIDER          0x0029u
#define MT_CL_OTA_REQUESTOR         0x002Au

#define MT_CMD_ARM_FAIL_SAFE          0x00u /* General Commissioning */
#define MT_CMD_SET_REGULATORY_CONFIG  0x02u
#define MT_CMD_COMMISSIONING_COMPLETE 0x04u
#define MT_CMD_ADD_OR_UPDATE_THREAD   0x03u /* Network Commissioning */
#define MT_CMD_CONNECT_NETWORK        0x06u
#define MT_CMD_ATTESTATION_REQUEST    0x00u /* Operational Credentials */
#define MT_CMD_CERT_CHAIN_REQUEST     0x02u
#define MT_CMD_CSR_REQUEST            0x04u
#define MT_CMD_ADD_NOC                0x06u
#define MT_CMD_ADD_TRUSTED_ROOT       0x0Bu
#define MT_CMD_ONOFF_OFF              0x00u
#define MT_CMD_ONOFF_ON               0x01u
#define MT_CMD_ONOFF_TOGGLE           0x02u

/*
 * Starts an InvokeRequest for one command and returns with the writer inside its CommandFields structure: the
 * caller puts the fields (context tags) and calls mt_im_invoke_end().
 */
void mt_im_invoke_begin(struct mt_tlv_writer *w, uint16_t endpoint, uint32_t cluster, uint32_t command,
			bool timed);
int mt_im_invoke_end(struct mt_tlv_writer *w);

/* A ReadRequest for attribute paths (endpoint, cluster, attribute), not fabric-filtered. */
struct mt_attr_path {
	uint16_t endpoint;
	uint32_t cluster;
	uint32_t attribute;
};
int mt_im_read_request(uint8_t *out, size_t cap, const struct mt_attr_path *paths, size_t count);

/*
 * Reads an InvokeResponse for one command. Either the response command's fields (data/len, a TLV structure to
 * read with mt_tlv) or a status (status 0 is success).
 */
struct mt_im_invoke_result {
	uint32_t cluster;
	uint32_t command;
	bool has_fields;
	const uint8_t *fields;
	size_t fields_len;
	uint8_t status;
	bool has_cluster_status;
	uint8_t cluster_status;
};
bool mt_im_parse_invoke_response(const uint8_t *in, size_t len, struct mt_im_invoke_result *res);

/* A StatusResponse body; status 0 is success. */
int mt_im_status_response(uint8_t *out, size_t cap, uint8_t status);

#ifdef __cplusplus
}
#endif

#endif /* MT_IM_H_ */
