/*
 * Device attestation (Matter specification 6.2): the device proves it is a certified product with its Device
 * Attestation Certificate (DAC), issued by a Product Attestation Intermediate (PAI) under a Product Attestation
 * Authority (PAA). This board trusts only the Matter test PAAs for now, built in (mt_test_paa.c).
 *
 * Checked: the chain DAC -> PAI -> PAA (signatures, key identifiers, CA flags), vendor and product IDs agreeing
 * along it, the AttestationResponse signature over the elements and the PASE session's attestation challenge,
 * and our nonce in the elements. Not checked yet: validity dates (the board has no trusted clock), the
 * certification declaration's own signature, revocation.
 */
#ifndef MT_ATTEST_H_
#define MT_ATTEST_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct mt_x509 {
	const uint8_t *tbs;
	size_t tbs_len;
	uint8_t signature[64];
	uint8_t public_key[65];
	bool is_ca;
	bool has_skid;
	uint8_t skid[20];
	bool has_akid;
	uint8_t akid[20];
	int32_t vid; /* -1 when the subject has none */
	int32_t pid;
};

/* Reads an X.509 certificate with a P-256 key and an ECDSA-SHA256 signature. */
bool mt_x509_parse(const uint8_t *der, size_t len, struct mt_x509 *out);

/* Verifies an ECDSA-SHA256 signature (raw r||s) over data with a public key: PSA on the board. */
typedef bool (*mt_verify_fn)(const uint8_t public_key[65], const uint8_t *data, size_t len, const uint8_t sig[64]);

enum mt_attest_result {
	MT_ATTEST_OK,
	MT_ATTEST_BAD_FORMAT,
	MT_ATTEST_NO_TRUSTED_PAA,
	MT_ATTEST_CHAIN,      /* a signature, key identifier or CA flag along the chain is wrong */
	MT_ATTEST_VID_PID,    /* the IDs disagree along the chain */
	MT_ATTEST_NONCE,
	MT_ATTEST_SIGNATURE,  /* the AttestationResponse is not signed by the DAC */
};

struct mt_attest_input {
	const uint8_t *dac;
	size_t dac_len;
	const uint8_t *pai;
	size_t pai_len;
	const uint8_t *elements; /* AttestationElements TLV */
	size_t elements_len;
	const uint8_t *signature; /* AttestationSignature, raw r||s */
	const uint8_t *nonce;     /* the 32-byte nonce we sent */
	const uint8_t *challenge; /* the PASE session's 16-byte attestation challenge */
};

/* Checks a device's attestation against the trusted PAAs. Gives the DAC's public key (for its CSR) on success. */
enum mt_attest_result mt_attest_verify(const struct mt_attest_input *in, mt_verify_fn verify,
				       uint8_t dac_public_key[65], uint16_t *vid, uint16_t *pid);

/* The CSRResponse: NOCSRElements signed by the DAC; gives the device's operational public key from the CSR. */
bool mt_attest_csr(const uint8_t *elements, size_t elements_len, const uint8_t sig[64], const uint8_t *nonce,
		   const uint8_t *challenge, const uint8_t dac_public_key[65], mt_verify_fn verify,
		   uint8_t node_public_key[65]);

/* The trusted PAAs: the Matter test PAAs (vendor 0xFFF1 and no vendor). */
extern const uint8_t *const mt_trusted_paa[];
extern const size_t mt_trusted_paa_len[];
extern const size_t mt_trusted_paa_count;

#ifdef __cplusplus
}
#endif

#endif /* MT_ATTEST_H_ */
