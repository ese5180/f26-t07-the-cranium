/*
 * Host tests of Matter certificates (firmware/matter/src/matter/mt_cert.c, mt_der.c): the Matter SDK's test
 * certificates converted from TLV must give exactly their DER form; certificates this library makes must convert
 * the same way, and carry the signature over that DER form.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "matter_cert_vectors.h"
#include "mt_cert.h"
#include "mt_der.h"

static int failures;
static int checks;

#define CHECK(condition)                                                                     \
	do {                                                                                 \
		checks++;                                                                    \
		if (!(condition)) {                                                          \
			failures++;                                                          \
			printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);         \
		}                                                                            \
	} while (0)

static void dump_diff(const uint8_t *a, size_t al, const uint8_t *b, size_t bl)
{
	for (size_t i = 0; i < al && i < bl; i++) {
		if (a[i] != b[i]) {
			printf("  first difference at %zu: 0x%02x, want 0x%02x\n", i, a[i], b[i]);
			return;
		}
	}
	printf("  lengths %zu, want %zu\n", al, bl);
}

static void same_der(const char *name, const uint8_t *tlv, size_t tlv_len, const uint8_t *der, size_t der_len)
{
	uint8_t out[MT_CERT_DER_MAX];
	size_t off;
	size_t len;
	int n = mt_cert_to_der(tlv, tlv_len, out, sizeof(out), &off, &len);

	CHECK(n == (int)der_len);
	CHECK(n > 0 && memcmp(out, der, der_len) == 0);
	if (n != (int)der_len || memcmp(out, der, der_len) != 0) {
		printf("  %s:\n", name);
		dump_diff(out, n > 0 ? (size_t)n : 0, der, der_len);
	}
	/* The TBS is the certificate's first element. */
	struct mt_der_elem cert;
	struct mt_der_elem tbs;

	CHECK(mt_der_read(der, der_len, &cert) && mt_der_child(&cert, 0, &tbs));
	CHECK(off == (size_t)(tbs.start - der) && len == tbs.total);
	/* Truncated TLV never converts. */
	for (size_t cut = 0; cut < tlv_len; cut += 7) {
		CHECK(mt_cert_to_der(tlv, cut, out, sizeof(out), NULL, NULL) < 0);
	}
	/* Too small an output never converts. */
	CHECK(mt_cert_to_der(tlv, tlv_len, out, der_len - 1, NULL, NULL) < 0);
}

static int sign_calls;
static uint8_t signed_data[MT_CERT_DER_MAX];
static size_t signed_len;

static int fake_sign(void *ctx, const uint8_t *data, size_t len, uint8_t sig[64])
{
	(void)ctx;
	sign_calls++;
	memcpy(signed_data, data, len);
	signed_len = len;
	for (int i = 0; i < 64; i++) {
		sig[i] = (uint8_t)(0x80 + i); /* top bits set: DER needs leading zeros */
	}
	return 0;
}

static void test_make(void)
{
	struct mt_cert_params p;
	uint8_t tlv[MT_CERT_TLV_MAX];
	uint8_t der[MT_CERT_DER_MAX];
	uint8_t key[65];
	uint64_t node;
	uint64_t fabric;
	size_t off;
	size_t len;

	memset(&p, 0, sizeof(p));
	p.is_root = true;
	p.serial = 0x8000000000000001ull;
	p.rcac_id = 0xCACACACA00000001ull;
	p.not_before = mt_epoch_from_utc(2026, 1, 1, 0, 0, 0);
	p.not_after = 0;
	p.public_key[0] = 4;
	memset(&p.public_key[1], 0x11, 64);
	memset(p.subject_key_id, 0x22, 20);
	memset(p.authority_key_id, 0x22, 20);
	int n = mt_cert_make(&p, fake_sign, NULL, tlv, sizeof(tlv));

	CHECK(n > 0 && sign_calls == 1);
	int d = mt_cert_to_der(tlv, (size_t)n, der, sizeof(der), &off, &len);

	CHECK(d > 0);
	/* What was signed is exactly the TBS of the final certificate. */
	CHECK(len == signed_len && memcmp(&der[off], signed_data, len) == 0);
	/* And the signature is in it, as DER. */
	uint8_t raw[64];
	struct mt_der_elem cert;
	struct mt_der_elem bits;

	CHECK(mt_der_read(der, (size_t)d, &cert) && mt_der_child(&cert, 2, &bits) && bits.tag == DER_BITSTRING);
	CHECK(mt_der_sig_to_raw(bits.value + 1, bits.len - 1, raw));
	CHECK(raw[0] == 0x80 && raw[63] == 0x80 + 63);
	CHECK(mt_cert_read(tlv, (size_t)n, key, &node, &fabric) && key[1] == 0x11 && node == 0);
	/* 2026-01-01 is before 2050: UTCTime; no expiry: GeneralizedTime 9999 */
	CHECK(memmem(der, (size_t)d, "260101000000Z", 13) != NULL);
	CHECK(memmem(der, (size_t)d, "99991231235959Z", 15) != NULL);
	/* The serial's top bit is set: a leading zero in TLV and DER. */
	static const uint8_t serial_der[] = {0x02, 0x09, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0x01};

	CHECK(memmem(der, (size_t)d, serial_der, sizeof(serial_der)) != NULL);

	/* A NOC */
	p.is_root = false;
	p.serial = 2;
	p.node_id = 0xDEDEDEDE00010001ull;
	p.fabric_id = 0xFAB000000000001Dull;
	memset(p.subject_key_id, 0x33, 20);
	n = mt_cert_make(&p, fake_sign, NULL, tlv, sizeof(tlv));
	CHECK(n > 0);
	d = mt_cert_to_der(tlv, (size_t)n, der, sizeof(der), &off, &len);
	CHECK(d > 0 && len == signed_len && memcmp(&der[off], signed_data, len) == 0);
	CHECK(mt_cert_read(tlv, (size_t)n, key, &node, &fabric));
	CHECK(node == 0xDEDEDEDE00010001ull && fabric == 0xFAB000000000001Dull);
	CHECK(memmem(der, (size_t)d, "DEDEDEDE00010001", 16) != NULL);
	CHECK(memmem(der, (size_t)d, "FAB000000000001D", 16) != NULL);
	/* NOC key usage digitalSignature: 03 02 07 80; root: 03 02 01 06 */
	static const uint8_t ku_noc[] = {0x03, 0x02, 0x07, 0x80};

	CHECK(memmem(der, (size_t)d, ku_noc, sizeof(ku_noc)) != NULL);
	/* Too small a buffer: no certificate. */
	CHECK(mt_cert_make(&p, fake_sign, NULL, tlv, 50) < 0);
}

static void test_epoch(void)
{
	CHECK(mt_epoch_from_utc(2000, 1, 1, 0, 0, 0) == 0);
	CHECK(mt_epoch_from_utc(2000, 1, 2, 0, 0, 1) == 86401);
	CHECK(mt_epoch_from_utc(2020, 10, 15, 14, 23, 43) == 0x271b17ef);
	CHECK(mt_epoch_from_utc(2040, 10, 15, 14, 23, 42) == 0x4cb9b56e);
	CHECK(mt_epoch_from_utc(2024, 2, 29, 12, 0, 0) == mt_epoch_from_utc(2024, 2, 28, 12, 0, 0) + 86400);
}

static void test_sig(void)
{
	uint8_t raw[64];
	uint8_t back[64];
	uint8_t der[80];

	memset(raw, 0, sizeof(raw));
	raw[31] = 1;
	raw[32] = 0xff;
	int n = mt_der_sig_from_raw(raw, der, sizeof(der));

	CHECK(n == 2 + 3 + 2 + 33);
	CHECK(mt_der_sig_to_raw(der, (size_t)n, back) && memcmp(raw, back, 64) == 0);
	CHECK(!mt_der_sig_to_raw(der, (size_t)n - 1, back));
}

int main(void)
{
	same_der("Root01", vec_root01_chip, sizeof(vec_root01_chip), vec_root01_der, sizeof(vec_root01_der));
	same_der("ICA01", vec_ica01_chip, sizeof(vec_ica01_chip), vec_ica01_der, sizeof(vec_ica01_der));
	same_der("Node01_01", vec_node01_01_chip, sizeof(vec_node01_01_chip), vec_node01_01_der,
		 sizeof(vec_node01_01_der));
	same_der("Node01_02", vec_node01_02_chip, sizeof(vec_node01_02_chip), vec_node01_02_der,
		 sizeof(vec_node01_02_der));
	test_make();
	test_epoch();
	test_sig();
	printf("matter certificates: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
