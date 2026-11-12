/*
 * See mt_crypto.h. The SPAKE2+ calls follow the sequence the Matter SDK's PSA backend uses on Nordic chips; the
 * prover's two confirmation steps in the order PASE needs them rely on firmware/matter/sdk/patch_sdk.py, patches
 * 1 and 2.
 */
#include "mt_crypto.h"

#include <errno.h>
#include <string.h>

/* In the Oberon library: reduces a 40-byte PBKDF output modulo the P-256 group order. */
extern void ocrypto_spake2p_p256_reduce(uint8_t x[32], const uint8_t *xs, size_t xs_len);

#define WS_LEN 40

static int map(psa_status_t s)
{
	return s == PSA_SUCCESS ? 0 : (s == PSA_ERROR_INVALID_SIGNATURE ? -EACCES : -EIO);
}

int mt_random(uint8_t *out, size_t len)
{
	return map(psa_generate_random(out, len));
}

int mt_sha256(const uint8_t *const *parts, const size_t *lens, size_t count, uint8_t out[32])
{
	psa_hash_operation_t op = PSA_HASH_OPERATION_INIT;
	size_t n;
	psa_status_t s = psa_hash_setup(&op, PSA_ALG_SHA_256);

	for (size_t i = 0; s == PSA_SUCCESS && i < count; i++) {
		s = psa_hash_update(&op, parts[i], lens[i]);
	}
	if (s == PSA_SUCCESS) {
		s = psa_hash_finish(&op, out, 32, &n);
	}
	if (s != PSA_SUCCESS) {
		psa_hash_abort(&op);
	}
	return map(s);
}

int mt_hkdf_from_key(psa_key_id_t key, const uint8_t *salt, size_t salt_len, const uint8_t *info, size_t info_len,
		     uint8_t *out, size_t out_len)
{
	psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
	psa_status_t s = psa_key_derivation_setup(&op, PSA_ALG_HKDF(PSA_ALG_SHA_256));

	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, salt_len);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_SECRET, key);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO, info, info_len);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_output_bytes(&op, out, out_len);
	}
	psa_key_derivation_abort(&op);
	return map(s);
}

int mt_hkdf(const uint8_t *secret, size_t secret_len, const uint8_t *salt, size_t salt_len, const uint8_t *info,
	    size_t info_len, uint8_t *out, size_t out_len)
{
	psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
	psa_status_t s = psa_key_derivation_setup(&op, PSA_ALG_HKDF(PSA_ALG_SHA_256));

	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, salt_len);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SECRET, secret, secret_len);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO, info, info_len);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_output_bytes(&op, out, out_len);
	}
	psa_key_derivation_abort(&op);
	return map(s);
}

int mt_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *msg, size_t len, uint8_t out[32])
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t id;
	size_t n;

	psa_set_key_type(&a, PSA_KEY_TYPE_HMAC);
	psa_set_key_algorithm(&a, PSA_ALG_HMAC(PSA_ALG_SHA_256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_SIGN_MESSAGE);
	if (psa_import_key(&a, key, key_len, &id) != PSA_SUCCESS) {
		return -EIO;
	}
	psa_status_t s = psa_mac_compute(id, PSA_ALG_HMAC(PSA_ALG_SHA_256), msg, len, out, 32, &n);

	psa_destroy_key(id);
	return map(s);
}

int mt_ecdh_new(psa_key_id_t *key, uint8_t pub[65])
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	size_t n;

	psa_set_key_type(&a, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_set_key_bits(&a, 256);
	psa_set_key_algorithm(&a, PSA_ALG_ECDH);
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
	psa_status_t s = psa_generate_key(&a, key);

	if (s == PSA_SUCCESS) {
		s = psa_export_public_key(*key, pub, 65, &n);
	}
	return map(s);
}

int mt_ecdh_shared(psa_key_id_t key, const uint8_t peer_pub[65], uint8_t shared[32])
{
	size_t n;

	return map(psa_raw_key_agreement(PSA_ALG_ECDH, key, peer_pub, 65, shared, 32, &n));
}

#define CCM_ALG PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, 16)

int mt_ccm_once(bool encrypt, const uint8_t key[16], const uint8_t nonce[13], uint8_t *data, size_t len,
		uint8_t mic[16])
{
	psa_key_id_t id;
	int err = mt_ccm_import(key, &id);

	if (err) {
		return err;
	}
	err = encrypt ? mt_ccm_encrypt(id, nonce, NULL, 0, data, len, mic) : mt_ccm_decrypt(id, nonce, NULL, 0, data, len, mic);
	psa_destroy_key(id);
	return err;
}

int mt_ccm_import(const uint8_t key[16], psa_key_id_t *id)
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;

	psa_set_key_type(&a, PSA_KEY_TYPE_AES);
	psa_set_key_bits(&a, 128);
	psa_set_key_algorithm(&a, CCM_ALG);
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT);
	return map(psa_import_key(&a, key, 16, id));
}

int mt_ccm_encrypt(psa_key_id_t key, const uint8_t nonce[13], const uint8_t *aad, size_t aad_len, uint8_t *data,
		   size_t len, uint8_t mic[16])
{
	/* PSA writes ciphertext and tag together; data has room only for the text, so the tag goes to mic. */
	uint8_t out[1280 + 16];
	size_t n;

	if (len > 1280) {
		return -EMSGSIZE;
	}
	psa_status_t s = psa_aead_encrypt(key, CCM_ALG, nonce, 13, aad, aad_len, data, len, out, sizeof(out), &n);

	if (s != PSA_SUCCESS || n != len + 16) {
		return -EIO;
	}
	memcpy(data, out, len);
	memcpy(mic, &out[len], 16);
	return 0;
}

int mt_ccm_decrypt(psa_key_id_t key, const uint8_t nonce[13], const uint8_t *aad, size_t aad_len, uint8_t *data,
		   size_t len, const uint8_t mic[16])
{
	uint8_t in[1280 + 16];
	size_t n;

	if (len > 1280) {
		return -EMSGSIZE;
	}
	memcpy(in, data, len);
	memcpy(&in[len], mic, 16);
	return map(psa_aead_decrypt(key, CCM_ALG, nonce, 13, aad, aad_len, in, len + 16, data, len, &n));
}

static int pbkdf2(uint32_t passcode, const uint8_t *salt, size_t salt_len, uint32_t iterations,
		  uint8_t ws[2 * WS_LEN])
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
	psa_key_id_t pw = PSA_KEY_ID_NULL;
	uint8_t pin[4] = {(uint8_t)passcode, (uint8_t)(passcode >> 8), (uint8_t)(passcode >> 16),
			  (uint8_t)(passcode >> 24)};

	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&a, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
	psa_set_key_type(&a, PSA_KEY_TYPE_PASSWORD);
	psa_status_t s = psa_import_key(&a, pin, sizeof(pin), &pw);

	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_setup(&op, PSA_ALG_PBKDF2_HMAC(PSA_ALG_SHA_256));
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_integer(&op, PSA_KEY_DERIVATION_INPUT_COST, iterations);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, salt, salt_len);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_PASSWORD, pw);
	}
	if (s == PSA_SUCCESS) {
		s = psa_key_derivation_output_bytes(&op, ws, 2 * WS_LEN);
	}
	psa_key_derivation_abort(&op);
	psa_destroy_key(pw);
	memset(pin, 0, sizeof(pin));
	return map(s);
}

int mt_spake_begin(struct mt_spake *sp, uint32_t passcode, const uint8_t *salt, size_t salt_len, uint32_t iterations,
		   const uint8_t context[32])
{
	uint8_t ws[2 * WS_LEN];
	uint8_t w[64];
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_pake_cipher_suite_t cs = PSA_PAKE_CIPHER_SUITE_INIT;
	int err;

	memset(sp, 0, sizeof(*sp));
	sp->op = psa_pake_operation_init();
	err = pbkdf2(passcode, salt, salt_len, iterations, ws);
	if (err) {
		return err;
	}
	ocrypto_spake2p_p256_reduce(&w[0], &ws[0], WS_LEN);
	ocrypto_spake2p_p256_reduce(&w[32], &ws[WS_LEN], WS_LEN);
	memset(ws, 0, sizeof(ws));

	psa_pake_cs_set_algorithm(&cs, PSA_ALG_SPAKE2P_MATTER);
	psa_pake_cs_set_primitive(&cs, PSA_PAKE_PRIMITIVE(PSA_PAKE_PRIMITIVE_TYPE_ECC, PSA_ECC_FAMILY_SECP_R1, 256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&a, PSA_ALG_SPAKE2P_MATTER);
	psa_set_key_type(&a, PSA_KEY_TYPE_SPAKE2P_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
	psa_status_t s = psa_import_key(&a, w, sizeof(w), &sp->key);

	memset(w, 0, sizeof(w));
	if (s == PSA_SUCCESS) {
		s = psa_pake_setup(&sp->op, sp->key, &cs);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_role(&sp->op, PSA_PAKE_ROLE_CLIENT);
	}
	/* PASE uses empty identities. */
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_user(&sp->op, NULL, 0);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_peer(&sp->op, NULL, 0);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_context(&sp->op, context, 32);
	}
	if (s != PSA_SUCCESS) {
		mt_spake_abort(sp);
	}
	return map(s);
}

int mt_spake_begin_verifier(struct mt_spake *sp, const uint8_t verifier[97], const uint8_t context[32])
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_pake_cipher_suite_t cs = PSA_PAKE_CIPHER_SUITE_INIT;

	memset(sp, 0, sizeof(*sp));
	sp->op = psa_pake_operation_init();
	psa_pake_cs_set_algorithm(&cs, PSA_ALG_SPAKE2P_MATTER);
	psa_pake_cs_set_primitive(&cs, PSA_PAKE_PRIMITIVE(PSA_PAKE_PRIMITIVE_TYPE_ECC, PSA_ECC_FAMILY_SECP_R1, 256));
	psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&a, PSA_ALG_SPAKE2P_MATTER);
	psa_set_key_type(&a, PSA_KEY_TYPE_SPAKE2P_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
	psa_status_t s = psa_import_key(&a, verifier, 97, &sp->key);

	if (s == PSA_SUCCESS) {
		s = psa_pake_setup(&sp->op, sp->key, &cs);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_role(&sp->op, PSA_PAKE_ROLE_SERVER);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_user(&sp->op, NULL, 0);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_peer(&sp->op, NULL, 0);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_set_context(&sp->op, context, 32);
	}
	if (s != PSA_SUCCESS) {
		mt_spake_abort(sp);
	}
	return map(s);
}

int mt_spake_verifier_round(struct mt_spake *sp, const uint8_t pa[65], uint8_t pb[65], uint8_t cb[32])
{
	size_t n;
	psa_status_t s = psa_pake_input(&sp->op, PSA_PAKE_STEP_KEY_SHARE, pa, 65);

	if (s == PSA_SUCCESS) {
		s = psa_pake_output(&sp->op, PSA_PAKE_STEP_KEY_SHARE, pb, 65, &n);
	}
	if (s == PSA_SUCCESS) {
		s = psa_pake_output(&sp->op, PSA_PAKE_STEP_CONFIRM, cb, 32, &n);
	}
	return map(s);
}

int mt_spake_verifier_confirm(struct mt_spake *sp, const uint8_t ca[32], psa_key_id_t *shared)
{
	return mt_spake_confirm(sp, ca, shared);
}

int mt_spake_round1(struct mt_spake *sp, uint8_t pa[65])
{
	size_t n;

	return map(psa_pake_output(&sp->op, PSA_PAKE_STEP_KEY_SHARE, pa, 65, &n));
}

int mt_spake_round2(struct mt_spake *sp, const uint8_t pb[65], uint8_t ca[32])
{
	size_t n;
	psa_status_t s = psa_pake_input(&sp->op, PSA_PAKE_STEP_KEY_SHARE, pb, 65);

	if (s == PSA_SUCCESS) {
		s = psa_pake_output(&sp->op, PSA_PAKE_STEP_CONFIRM, ca, 32, &n);
	}
	return map(s);
}

int mt_spake_confirm(struct mt_spake *sp, const uint8_t cb[32], psa_key_id_t *shared)
{
	psa_key_attributes_t a = PSA_KEY_ATTRIBUTES_INIT;
	psa_status_t s = psa_pake_input(&sp->op, PSA_PAKE_STEP_CONFIRM, cb, 32);

	if (s == PSA_SUCCESS) {
		psa_set_key_type(&a, PSA_KEY_TYPE_DERIVE);
		psa_set_key_usage_flags(&a, PSA_KEY_USAGE_DERIVE);
		psa_set_key_algorithm(&a, PSA_ALG_HKDF(PSA_ALG_SHA_256));
		s = psa_pake_get_shared_key(&sp->op, &a, shared);
	}
	mt_spake_abort(sp);
	return map(s);
}

void mt_spake_abort(struct mt_spake *sp)
{
	psa_pake_abort(&sp->op);
	if (sp->key != PSA_KEY_ID_NULL) {
		psa_destroy_key(sp->key);
		sp->key = PSA_KEY_ID_NULL;
	}
}
