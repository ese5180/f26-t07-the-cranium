/*
 * Host build: TF-M's protected storage, as far as bt_passkey.c uses it. Functions are only declared
 * here: test_bt_passkey.c defines them, and decides what is stored and what fails.
 */
#ifndef HOST_STUB_PSA_PROTECTED_STORAGE_H_
#define HOST_STUB_PSA_PROTECTED_STORAGE_H_

#include <stddef.h>
#include <stdint.h>

/* As stubs/host_ota.h has it, so that the two can meet in one file. */
typedef int psa_status_t;
typedef uint64_t psa_storage_uid_t;
typedef uint32_t psa_storage_create_flags_t;

#ifndef PSA_SUCCESS
#define PSA_SUCCESS                0
#endif
#define PSA_ERROR_GENERIC_ERROR    ((psa_status_t)-132)
#define PSA_ERROR_DOES_NOT_EXIST   ((psa_status_t)-140)
#define PSA_ERROR_STORAGE_FAILURE  ((psa_status_t)-146)
#define PSA_STORAGE_FLAG_NONE      0U

psa_status_t psa_ps_set(psa_storage_uid_t uid, size_t data_length, const void *p_data,
			psa_storage_create_flags_t create_flags);
psa_status_t psa_ps_get(psa_storage_uid_t uid, size_t data_offset, size_t data_size, void *p_data,
			size_t *p_data_length);
psa_status_t psa_ps_remove(psa_storage_uid_t uid);

#endif
