/*
 * A PKCS#10 certificate signing request for this board's operational key, as a phone commissioning the board
 * asks for it (CSRRequest): subject O=CSR, the P-256 public key, signed with the key itself.
 */
#ifndef MT_CSR_H_
#define MT_CSR_H_

#include <stddef.h>
#include <stdint.h>

#include "mt_cert.h"

int mt_csr_make(const uint8_t public_key[65], mt_sign_fn sign, void *ctx, uint8_t *out, size_t cap);

#endif /* MT_CSR_H_ */
