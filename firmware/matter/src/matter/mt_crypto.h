/*
 * The crypto the commissioner needs, through the PSA crypto API (Oberon on this board): random bytes, SHA-256,
 * HKDF, AES-CCM for session messages, and the PASE prover (SPAKE2+, Matter's variant). Session keys stay in PSA's
 * key store; only their IDs are kept here.
 */
#ifndef MT_CRYPTO_H_
#define MT_CRYPTO_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <psa/crypto.h>

#ifdef __cplusplus
extern "C" {
#endif

int mt_random(uint8_t *out, size_t len);
int mt_sha256(const uint8_t *const *parts, const size_t *lens, size_t count, uint8_t out[32]);

/* HKDF-SHA256 from a PSA derive key into raw bytes. */
int mt_hkdf_from_key(psa_key_id_t key, const uint8_t *salt, size_t salt_len, const uint8_t *info, size_t info_len,
		     uint8_t *out, size_t out_len);

/* Imports a 128-bit AES-CCM key (16-byte tag) for one direction of a session. */
int mt_ccm_import(const uint8_t key[16], psa_key_id_t *id);
int mt_ccm_encrypt(psa_key_id_t key, const uint8_t nonce[13], const uint8_t *aad, size_t aad_len, uint8_t *data,
		   size_t len, uint8_t mic[16]);
int mt_ccm_decrypt(psa_key_id_t key, const uint8_t nonce[13], const uint8_t *aad, size_t aad_len, uint8_t *data,
		   size_t len, const uint8_t mic[16]);

/* The PASE prover: SPAKE2+ with the setup passcode, PBKDF parameters and transcript context. */
struct mt_spake {
	psa_pake_operation_t op;
	psa_key_id_t key;
};

int mt_spake_begin(struct mt_spake *s, uint32_t passcode, const uint8_t *salt, size_t salt_len, uint32_t iterations,
		   const uint8_t context[32]);
/* pA, our share (65 bytes) */
int mt_spake_round1(struct mt_spake *s, uint8_t pa[65]);
/* takes pB, gives cA (32 bytes) */
int mt_spake_round2(struct mt_spake *s, const uint8_t pb[65], uint8_t ca[32]);
/* checks cB; on success gives the shared secret as a PSA HKDF key */
int mt_spake_confirm(struct mt_spake *s, const uint8_t cb[32], psa_key_id_t *shared);
void mt_spake_abort(struct mt_spake *s);

#ifdef __cplusplus
}
#endif

#endif /* MT_CRYPTO_H_ */
