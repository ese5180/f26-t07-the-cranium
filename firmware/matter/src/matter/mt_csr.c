/*
 * See mt_csr.h.
 */
#include "mt_csr.h"

#include <errno.h>
#include <string.h>

#include "mt_der.h"

static const uint8_t oid_org[] = {0x55, 0x04, 0x0a};
static const uint8_t oid_ec_public_key[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01};
static const uint8_t oid_prime256v1[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07};
static const uint8_t oid_ecdsa_sha256[] = {0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02};

int mt_csr_make(const uint8_t public_key[65], mt_sign_fn sign, void *ctx, uint8_t *out, size_t cap)
{
	struct mt_der_writer w;
	uint8_t info[200];
	uint8_t bits[81];
	uint8_t sig[64];
	static const uint8_t zero = 0;

	/* CertificationRequestInfo */
	mt_der_init(&w, info, sizeof(info));
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_put(&w, DER_INTEGER, &zero, 1);
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_start(&w, DER_SET);
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_put_oid(&w, oid_org, sizeof(oid_org));
	mt_der_put(&w, DER_UTF8, (const uint8_t *)"CSR", 3);
	mt_der_end(&w);
	mt_der_end(&w);
	mt_der_end(&w);
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_put_oid(&w, oid_ec_public_key, sizeof(oid_ec_public_key));
	mt_der_put_oid(&w, oid_prime256v1, sizeof(oid_prime256v1));
	mt_der_end(&w);
	bits[0] = 0;
	memcpy(&bits[1], public_key, 65);
	mt_der_put(&w, DER_BITSTRING, bits, 66);
	mt_der_end(&w);
	mt_der_put(&w, 0xA0, NULL, 0); /* no attributes */
	mt_der_end(&w);
	int info_len = mt_der_finish(&w);

	if (info_len < 0) {
		return -ENOBUFS;
	}
	int err = sign(ctx, info, (size_t)info_len, sig);

	if (err) {
		return err;
	}
	int n = mt_der_sig_from_raw(sig, &bits[1], sizeof(bits) - 1);

	if (n < 0) {
		return -ENOBUFS;
	}
	mt_der_init(&w, out, cap);
	mt_der_start(&w, DER_SEQUENCE);
	if (!w.error && w.len + (size_t)info_len <= cap) {
		memcpy(&out[w.len], info, (size_t)info_len);
		w.len += (size_t)info_len;
	} else {
		return -ENOBUFS;
	}
	mt_der_start(&w, DER_SEQUENCE);
	mt_der_put_oid(&w, oid_ecdsa_sha256, sizeof(oid_ecdsa_sha256));
	mt_der_end(&w);
	bits[0] = 0;
	mt_der_put(&w, DER_BITSTRING, bits, (size_t)n + 1);
	mt_der_end(&w);
	n = mt_der_finish(&w);
	return n < 0 ? -ENOBUFS : n;
}
