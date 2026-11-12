/*
 * This board's Matter fabric: its root CA (key in PSA's persistent key store, certificate in settings), the
 * board's own operational identity (node ID, key and NOC, for CASE), the identity protection key (IPK), and the
 * devices commissioned onto it. Created on first use, kept across restarts.
 */
#ifndef MT_FABRIC_H_
#define MT_FABRIC_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mt_cert.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MT_MAX_NODES 8

struct mt_node {
	uint64_t node_id;
	uint16_t vendor_id;
	uint16_t product_id;
	bool in_use;
};

struct mt_fabric {
	uint64_t fabric_id;
	uint64_t rcac_id;
	uint64_t own_node_id;
	uint64_t next_node_id;
	uint8_t epoch_key[16];        /* the IPK epoch key, sent to devices in AddNOC */
	uint8_t root_public_key[65];
	uint8_t compressed_id[8];
	uint8_t operational_ipk[16];  /* derived from the epoch key and the compressed fabric ID */
	uint8_t rcac[MT_CERT_TLV_MAX];
	size_t rcac_len;
	uint8_t own_noc[MT_CERT_TLV_MAX];
	size_t own_noc_len;
	struct mt_node nodes[MT_MAX_NODES];
};

/* Loads the fabric, or creates it (keys, RCAC, own NOC) the first time. 0 or a negative errno. */
int mt_fabric_init(void);
const struct mt_fabric *mt_fabric(void);

/* Issues a NOC for a device's operational public key, under a new node ID. */
int mt_fabric_issue_noc(const uint8_t public_key[65], uint64_t *node_id, uint8_t *out, size_t cap);
/* Signs with the board's own operational key (CASE Sigma3). */
int mt_fabric_sign_own(const uint8_t *data, size_t len, uint8_t sig[64]);
/* Records a commissioned device; forgets one. */
int mt_fabric_add_node(uint64_t node_id, uint16_t vid, uint16_t pid);
int mt_fabric_remove_node(uint64_t node_id);
const struct mt_node *mt_fabric_node(uint64_t node_id);

/* PSA ECDSA-SHA256 verification with a raw public key, for attestation and CASE. */
bool mt_verify(const uint8_t public_key[65], const uint8_t *data, size_t len, const uint8_t sig[64]);

#ifdef __cplusplus
}
#endif

#endif /* MT_FABRIC_H_ */
