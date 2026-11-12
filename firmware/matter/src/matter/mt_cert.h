/*
 * Matter operational certificates (Matter specification 6.5): the compact TLV form devices store, its X.509 DER
 * form (whose to-be-signed part the signature covers), and making this fabric's certificates: the root (RCAC)
 * and each device's node certificate (NOC). No intermediate CA.
 */
#ifndef MT_CERT_H_
#define MT_CERT_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_CERT_TLV_MAX 400
#define MT_CERT_DER_MAX 600

/*
 * Converts a Matter TLV certificate to X.509 DER. With a signature in the TLV, out holds the whole certificate;
 * without one, only the to-be-signed part. tbs_off and tbs_len (either may be NULL) give where that part is.
 * Returns the DER length, or -1 for anything it does not understand.
 */
int mt_cert_to_der(const uint8_t *tlv, size_t tlv_len, uint8_t *out, size_t cap, size_t *tbs_off, size_t *tbs_len);

/* Signs the SHA-256 of data with P-256 ECDSA, raw r||s: PSA on the board, a stand-in in host tests. */
typedef int (*mt_sign_fn)(void *ctx, const uint8_t *data, size_t len, uint8_t sig[64]);

struct mt_cert_params {
	bool is_root;           /* RCAC: subject = issuer = the RCAC ID; else NOC */
	uint64_t serial;
	uint64_t rcac_id;       /* the issuer's RCAC ID (and the subject for a root) */
	uint64_t node_id;       /* NOC only */
	uint64_t fabric_id;     /* NOC subject; 0 leaves it out of a root */
	uint32_t not_before;    /* Matter epoch seconds (since 2000-01-01) */
	uint32_t not_after;     /* 0: no well-defined expiry */
	uint8_t public_key[65]; /* the subject's */
	uint8_t subject_key_id[20];
	uint8_t authority_key_id[20];
};

/* Makes a certificate in Matter TLV, signed by sign(). Returns its length or a negative errno. */
int mt_cert_make(const struct mt_cert_params *p, mt_sign_fn sign, void *sign_ctx, uint8_t *out, size_t cap);

/* Reads the subject public key, and for a NOC the node and fabric IDs, out of a TLV certificate. */
bool mt_cert_read(const uint8_t *tlv, size_t len, uint8_t public_key[65], uint64_t *node_id, uint64_t *fabric_id);

/* Matter epoch seconds from a UTC calendar date, and back. */
uint32_t mt_epoch_from_utc(unsigned int year, unsigned int month, unsigned int day, unsigned int hour,
			   unsigned int minute, unsigned int second);

#ifdef __cplusplus
}
#endif

#endif /* MT_CERT_H_ */
