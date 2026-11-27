/*
 * Host build: the download library and PSA, as far as ota.c uses them. Functions are only
 * declared here, and test_ota_bt.c defines them, and nothing in those does any real work.
 */
#ifndef HOST_STUB_OTA_H_
#define HOST_STUB_OTA_H_

#include <stddef.h>
#include <stdint.h>

enum fota_download_evt_id {
	FOTA_DOWNLOAD_EVT_PROGRESS,
	FOTA_DOWNLOAD_EVT_FINISHED,
	FOTA_DOWNLOAD_EVT_ERROR,
	FOTA_DOWNLOAD_EVT_CANCELLED,
};

struct fota_download_evt {
	enum fota_download_evt_id id;
	int progress;
	int cause;
};

typedef void (*fota_download_callback_t)(const struct fota_download_evt *event);

int fota_download_init(fota_download_callback_t callback);
int fota_download_start(const char *host, const char *file, int sec_tag, uint8_t pdn_id,
			size_t fragment_size);
int fota_download_cancel(void);

typedef int psa_status_t;
typedef int psa_hash_operation_t;
#define PSA_SUCCESS              0
#define PSA_HASH_OPERATION_INIT  0
#define PSA_ALG_SHA_256          1

psa_status_t psa_crypto_init(void);
psa_status_t psa_hash_setup(psa_hash_operation_t *operation, int algorithm);
psa_status_t psa_hash_update(psa_hash_operation_t *operation, const uint8_t *data, size_t length);
psa_status_t psa_hash_finish(psa_hash_operation_t *operation, uint8_t *digest, size_t size,
			     size_t *length);
psa_status_t psa_hash_abort(psa_hash_operation_t *operation);

/* The key calls src/pi/pi_delta_ota.c makes to check a Pi delta manifest's signature. */
typedef int psa_key_attributes_t;
typedef unsigned int psa_key_id_t;
#define PSA_KEY_ATTRIBUTES_INIT         0
#define PSA_ECC_FAMILY_SECP_R1          0x12
#define PSA_KEY_TYPE_ECC_PUBLIC_KEY(f)  (0x4100 | (f))
#define PSA_KEY_USAGE_VERIFY_MESSAGE    0x0800
#define PSA_ALG_ECDSA(hash)             (0x06000600 | (hash))
void psa_set_key_type(psa_key_attributes_t *attributes, int type);
void psa_set_key_bits(psa_key_attributes_t *attributes, size_t bits);
void psa_set_key_usage_flags(psa_key_attributes_t *attributes, int usage);
void psa_set_key_algorithm(psa_key_attributes_t *attributes, int algorithm);
psa_status_t psa_import_key(const psa_key_attributes_t *attributes, const uint8_t *data,
			    size_t length, psa_key_id_t *key);
psa_status_t psa_verify_message(psa_key_id_t key, int algorithm, const uint8_t *input,
				size_t input_length, const uint8_t *signature, size_t signature_length);
psa_status_t psa_destroy_key(psa_key_id_t key);

#endif
