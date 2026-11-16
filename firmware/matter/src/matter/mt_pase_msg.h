/*
 * PASE message bodies (Matter specification 4.14.1): PBKDFParamRequest/Response and Pake1/2/3, as the
 * commissioner (the initiator, SPAKE2+ prover) writes and reads them. The SPAKE2+ computation is mt_pase.c's.
 */
#ifndef MT_PASE_MSG_H_
#define MT_PASE_MSG_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MT_PASE_RANDOM_LEN 32
#define MT_PASE_POINT_LEN  65 /* uncompressed P-256 point */
#define MT_PASE_HASH_LEN   32
#define MT_PASE_SALT_MIN   16
#define MT_PASE_SALT_MAX   32
#define MT_PASE_ITER_MIN   1000
#define MT_PASE_ITER_MAX   100000

int mt_pase_pbkdf_request(uint8_t *out, size_t cap, const uint8_t random[MT_PASE_RANDOM_LEN],
			  uint16_t session_id);

struct mt_pase_pbkdf_response {
	uint16_t responder_session_id;
	uint32_t iterations;
	uint8_t salt[MT_PASE_SALT_MAX];
	size_t salt_len;
};

/* Checks that the response echoes our random and gives usable PBKDF parameters (iterations, salt length). */
bool mt_pase_parse_pbkdf_response(const uint8_t *in, size_t len, const uint8_t our_random[MT_PASE_RANDOM_LEN],
				  struct mt_pase_pbkdf_response *out);

int mt_pase_pake1(uint8_t *out, size_t cap, const uint8_t pa[MT_PASE_POINT_LEN]);
bool mt_pase_parse_pake2(const uint8_t *in, size_t len, uint8_t pb[MT_PASE_POINT_LEN],
			 uint8_t cb[MT_PASE_HASH_LEN]);
int mt_pase_pake3(uint8_t *out, size_t cap, const uint8_t ca[MT_PASE_HASH_LEN]);

#ifdef __cplusplus
}
#endif

#endif /* MT_PASE_MSG_H_ */
