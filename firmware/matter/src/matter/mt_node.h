/*
 * This board as a Matter device that a phone commissions: its test identity (DAC, PAI, certification declaration
 * from the Matter SDK's test credentials, vendor 0xFFF1, product 0x8000), its setup passcode and discriminator,
 * the fail-safe, its operational key (a persistent PSA key) and the phone's fabric once added. The commissioner
 * role (mt_fabric.h) is separate: there the board owns the fabric; here it is a node on the phone's.
 */
#ifndef MT_NODE_H_
#define MT_NODE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mt_cert.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MT_NODE_VENDOR_ID     0xFFF1u /* Matter test vendor */
#define MT_NODE_PRODUCT_ID    0x8000u
#define MT_NODE_PASSCODE      20202021u /* the Matter SDK's test passcode */
#define MT_NODE_DISCRIMINATOR 3840u
#define MT_NODE_PBKDF_ITER    1000u
#define MT_NODE_FABRIC_INDEX  1u

struct mt_node_fabric {
	bool committed;          /* CommissioningComplete received */
	bool present;            /* AddNOC done (maybe still under the fail-safe) */
	uint64_t fabric_id;
	uint64_t node_id;
	uint16_t vendor_id;
	uint64_t admin_subject;
	uint8_t root_public_key[65];
	uint8_t compressed_id[8];
	uint8_t ipk[16];         /* operational group key, derived */
	uint8_t rcac[MT_CERT_TLV_MAX];
	size_t rcac_len;
	uint8_t icac[MT_CERT_TLV_MAX];
	size_t icac_len;
	uint8_t noc[MT_CERT_TLV_MAX];
	size_t noc_len;
	char label[33];
	/* OTA requestor: the provider the phone announced or wrote */
	uint64_t ota_provider_node;
	uint16_t ota_provider_endpoint;
};

int mt_node_init(void);
const struct mt_node_fabric *mt_node_fabric(void);
bool mt_node_commissionable(void);

/* The SPAKE2+ verifier (w0 || L) for the passcode, and the PBKDF salt. */
const uint8_t *mt_node_verifier(void);
const uint8_t *mt_node_salt(void);

/* Signs with the test DAC's key; with the operational key. */
int mt_node_sign_dac(const uint8_t *data, size_t len, uint8_t sig[64]);
int mt_node_sign_operational(const uint8_t *data, size_t len, uint8_t sig[64]);

/* Fail-safe */
int mt_node_arm_fail_safe(uint16_t seconds, uint64_t breadcrumb);
bool mt_node_fail_safe_armed(void);
uint64_t mt_node_breadcrumb(void);
void mt_node_set_breadcrumb(uint64_t v);

/* Operational credentials as the phone hands them over */
int mt_node_csr(uint8_t *csr, size_t cap);
int mt_node_add_root(const uint8_t *rcac, size_t len);
/* 0, or an OperationalCertStatus (1 InvalidPublicKey, 2 InvalidNodeOpId, 3 InvalidNOC, 7 TableFull, ...) */
int mt_node_add_noc(const uint8_t *noc, size_t noc_len, const uint8_t *icac, size_t icac_len, const uint8_t ipk[16],
		    uint64_t admin_subject, uint16_t admin_vendor);
int mt_node_commissioning_complete(void);
int mt_node_set_label(const char *label, size_t len);
int mt_node_remove_fabric(void);
int mt_node_set_ota_provider(uint64_t node, uint16_t endpoint);

#ifdef __cplusplus
}
#endif

#endif /* MT_NODE_H_ */
