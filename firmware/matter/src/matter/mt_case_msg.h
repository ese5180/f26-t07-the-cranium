/*
 * CASE message bodies (Matter specification 4.14.2), as the initiator writes and reads them: Sigma1, Sigma2 and
 * its decrypted TBEData2, the TBSData2/TBSData3 structures that get signed, TBEData3 and Sigma3, and the
 * destination ID message. The crypto around them is mt_case.c's.
 */
#ifndef MT_CASE_MSG_H_
#define MT_CASE_MSG_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_CASE_RANDOM_LEN 32
#define MT_CASE_PUBKEY_LEN 65
#define MT_CASE_SIG_LEN    64
#define MT_CASE_MIC_LEN    16

int mt_case_sigma1(uint8_t *out, size_t cap, const uint8_t random[32], uint16_t session_id,
		   const uint8_t destination_id[32], const uint8_t eph_pub[65]);

struct mt_case_sigma2 {
	const uint8_t *random;     /* 32 */
	uint16_t session_id;
	const uint8_t *eph_pub;    /* 65 */
	const uint8_t *encrypted;  /* TBEData2 followed by its 16-byte MIC */
	size_t encrypted_len;
};
bool mt_case_parse_sigma2(const uint8_t *in, size_t len, struct mt_case_sigma2 *out);

struct mt_case_tbe2 {
	const uint8_t *noc;
	size_t noc_len;
	const uint8_t *icac; /* NULL when there is none */
	size_t icac_len;
	const uint8_t *signature; /* 64 */
	const uint8_t *resumption_id; /* 16 */
};
bool mt_case_parse_tbe2(const uint8_t *in, size_t len, struct mt_case_tbe2 *out);

/* TBSData2 and TBSData3: {1 sender NOC, [2 ICAC], 3 sender's ephemeral key, 4 receiver's ephemeral key} */
int mt_case_tbs(uint8_t *out, size_t cap, const uint8_t *noc, size_t noc_len, const uint8_t *icac,
		size_t icac_len, const uint8_t sender_eph[65], const uint8_t receiver_eph[65]);

/* TBEData3: {1 initiator NOC, 3 signature}; Sigma3: {1 encrypted TBEData3 with its MIC} */
int mt_case_tbe3(uint8_t *out, size_t cap, const uint8_t *noc, size_t noc_len, const uint8_t sig[64]);
int mt_case_sigma3(uint8_t *out, size_t cap, const uint8_t *encrypted, size_t len);

/* The message the destination ID's HMAC covers: random, root public key, fabric ID and node ID (little endian). */
size_t mt_case_destination_message(uint8_t out[32 + 65 + 8 + 8], const uint8_t random[32],
				   const uint8_t root_pub[65], uint64_t fabric_id, uint64_t node_id);

#ifdef __cplusplus
}
#endif

#endif /* MT_CASE_MSG_H_ */
