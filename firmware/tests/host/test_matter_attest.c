/*
 * Host tests of device attestation (firmware/matter/src/matter/mt_attest.c): the Matter SDK's test DAC and PAI
 * chain to the built-in test PAAs, each signature is checked with the issuer's key over the right bytes, and
 * every way of getting it wrong is refused. The ECDSA check itself is PSA's on the board; here a stand-in
 * records what it was asked and answers from a table.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "matter_attest_vectors.h"
#include "mt_attest.h"
#include "mt_tlv.h"

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

static struct mt_x509 dac, pai, paa;
static bool reject_all;
static int verify_calls;
static const uint8_t *fail_key; /* a key whose every signature fails */

/* Accepts a signature when the key is the right issuer for those bytes. */
static bool fake_verify(const uint8_t key[65], const uint8_t *data, size_t len, const uint8_t sig[64])
{
	verify_calls++;
	if (reject_all || (fail_key && memcmp(key, fail_key, 65) == 0)) {
		return false;
	}
	if (data == dac.tbs || (len == dac.tbs_len && memcmp(data, dac.tbs, len) == 0)) {
		return memcmp(key, pai.public_key, 65) == 0 && memcmp(sig, dac.signature, 64) == 0;
	}
	if (len == pai.tbs_len && memcmp(data, pai.tbs, len) == 0) {
		return memcmp(key, paa.public_key, 65) == 0 && memcmp(sig, pai.signature, 64) == 0;
	}
	/* the attestation response: signed by the DAC, ending with the challenge */
	return memcmp(key, dac.public_key, 65) == 0 && len > 16 && data[len - 1] == 0xC5;
}

static uint8_t nonce[32];
static uint8_t challenge[16];
static uint8_t elements[200];
static size_t elements_len;
static uint8_t sig[64];

static void make_elements(const uint8_t *n)
{
	struct mt_tlv_writer w;
	static const uint8_t cd[] = {0x30, 0x01, 0x00};

	mt_tlv_writer_init(&w, elements, sizeof(elements));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, cd, sizeof(cd));
	mt_tlv_put_bytes(&w, 2, n, 32);
	mt_tlv_put_uint(&w, 3, 0);
	mt_tlv_end(&w);
	elements_len = (size_t)mt_tlv_finish(&w);
}

static enum mt_attest_result run(const uint8_t *d, size_t dl, const uint8_t *p, size_t pl)
{
	struct mt_attest_input in = {
		.dac = d, .dac_len = dl, .pai = p, .pai_len = pl, .elements = elements, .elements_len = elements_len,
		.signature = sig, .nonce = nonce, .challenge = challenge,
	};
	uint8_t key[65];
	uint16_t vid = 0;
	uint16_t pid = 0;
	enum mt_attest_result r = mt_attest_verify(&in, fake_verify, key, &vid, &pid);

	if (r == MT_ATTEST_OK) {
		CHECK(memcmp(key, dac.public_key, 65) == 0);
	}
	return r;
}

int main(void)
{
	memset(nonce, 0x4e, sizeof(nonce));
	memset(challenge, 0xC5, sizeof(challenge));
	make_elements(nonce);

	CHECK(mt_x509_parse(vec_dac, sizeof(vec_dac), &dac));
	CHECK(mt_x509_parse(vec_pai, sizeof(vec_pai), &pai));
	CHECK(mt_x509_parse(mt_trusted_paa[0], mt_trusted_paa_len[0], &paa));
	CHECK(dac.vid == 0xFFF1 && dac.pid == 0x8000 && !dac.is_ca && dac.has_akid);
	CHECK(pai.vid == 0xFFF1 && pai.pid == 0x8000 && pai.is_ca && pai.has_skid);
	CHECK(paa.vid == 0xFFF1 && paa.pid == -1 && paa.is_ca);
	CHECK(memcmp(dac.akid, pai.skid, 20) == 0 && memcmp(pai.akid, paa.skid, 20) == 0);
	CHECK(dac.public_key[0] == 0x04);

	CHECK(run(vec_dac, sizeof(vec_dac), vec_pai, sizeof(vec_pai)) == MT_ATTEST_OK);
	CHECK(verify_calls == 3);

	/* The FFF2 chain under the no-vendor test PAA. */
	struct mt_x509 dac2;
	struct mt_x509 pai2;

	CHECK(mt_x509_parse(vec_dac_fff2, sizeof(vec_dac_fff2), &dac2) && dac2.vid == 0xFFF2 && dac2.pid == 0x8001);
	CHECK(mt_x509_parse(vec_pai_fff2, sizeof(vec_pai_fff2), &pai2) && pai2.vid == 0xFFF2);
	struct mt_x509 saved_dac = dac;
	struct mt_x509 saved_pai = pai;
	struct mt_x509 saved_paa = paa;

	dac = dac2;
	pai = pai2;
	CHECK(mt_x509_parse(mt_trusted_paa[1], mt_trusted_paa_len[1], &paa) && paa.vid == -1);
	CHECK(run(vec_dac_fff2, sizeof(vec_dac_fff2), vec_pai_fff2, sizeof(vec_pai_fff2)) == MT_ATTEST_OK);
	dac = saved_dac;
	pai = saved_pai;
	paa = saved_paa;

	/* Swapped: the PAI as DAC (a CA) and the other way round */
	CHECK(run(vec_pai, sizeof(vec_pai), vec_dac, sizeof(vec_dac)) != MT_ATTEST_OK);
	/* A DAC from the other chain with this PAI: key identifiers do not match */
	CHECK(run(vec_dac_fff2, sizeof(vec_dac_fff2), vec_pai, sizeof(vec_pai)) == MT_ATTEST_CHAIN);
	/* Any signature failing along the chain */
	fail_key = pai.public_key;
	CHECK(run(vec_dac, sizeof(vec_dac), vec_pai, sizeof(vec_pai)) == MT_ATTEST_CHAIN);
	fail_key = paa.public_key;
	CHECK(run(vec_dac, sizeof(vec_dac), vec_pai, sizeof(vec_pai)) == MT_ATTEST_CHAIN);
	fail_key = dac.public_key;
	CHECK(run(vec_dac, sizeof(vec_dac), vec_pai, sizeof(vec_pai)) == MT_ATTEST_SIGNATURE);
	fail_key = NULL;
	/* Someone else's nonce */
	uint8_t other[32];

	memset(other, 1, sizeof(other));
	make_elements(other);
	CHECK(run(vec_dac, sizeof(vec_dac), vec_pai, sizeof(vec_pai)) == MT_ATTEST_NONCE);
	make_elements(nonce);
	/* A broken certificate: one byte changed in the structure, or truncated */
	uint8_t bad[sizeof(vec_dac)];

	for (size_t cut = 1; cut < sizeof(vec_dac); cut += 13) {
		CHECK(run(vec_dac, cut, vec_pai, sizeof(vec_pai)) == MT_ATTEST_BAD_FORMAT);
	}
	memcpy(bad, vec_dac, sizeof(bad));
	bad[0] = 0x31;
	CHECK(run(bad, sizeof(bad), vec_pai, sizeof(vec_pai)) == MT_ATTEST_BAD_FORMAT);
	/* No trusted PAA: forget the PAI's issuer */
	uint8_t pai_bad[sizeof(vec_pai)];
	struct mt_x509 tmp;

	memcpy(pai_bad, vec_pai, sizeof(pai_bad));
	/* change the authority key identifier's last byte (it is the PAA's SKID) */
	for (size_t i = 0; i + 20 <= sizeof(pai_bad); i++) {
		if (memcmp(&pai_bad[i], pai.akid, 20) == 0) {
			pai_bad[i + 19] ^= 1;
			break;
		}
	}
	CHECK(mt_x509_parse(pai_bad, sizeof(pai_bad), &tmp));
	CHECK(run(vec_dac, sizeof(vec_dac), pai_bad, sizeof(pai_bad)) == MT_ATTEST_NO_TRUSTED_PAA);
	reject_all = true;
	CHECK(run(vec_dac, sizeof(vec_dac), vec_pai, sizeof(vec_pai)) == MT_ATTEST_CHAIN);
	reject_all = false;

	printf("matter attestation: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
