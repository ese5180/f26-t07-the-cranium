/*
 * Host tests of CASE's message bodies (firmware/matter/src/matter/mt_case_msg.c) and of the key derivations the
 * board runs through PSA, checked here against the Matter specification's examples with a host SHA-256: the
 * destination ID, the compressed fabric ID and the operational group key (IPK).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mt_case_msg.h"
#include "mt_tlv.h"
#include "sha256_host.h"

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

static const uint8_t root_pub[65] = {
	0x04, 0x4a, 0x9f, 0x42, 0xb1, 0xca, 0x48, 0x40, 0xd3, 0x72, 0x92, 0xbb, 0xc7, 0xf6, 0xa7, 0xe1, 0x1e,
	0x22, 0x20, 0x0c, 0x97, 0x6f, 0xc9, 0x00, 0xdb, 0xc9, 0x8a, 0x7a, 0x38, 0x3a, 0x64, 0x1c, 0xb8, 0x25,
	0x4a, 0x2e, 0x56, 0xd4, 0xe2, 0x95, 0xa8, 0x47, 0x94, 0x3b, 0x4e, 0x38, 0x97, 0xc4, 0xa7, 0x73, 0xe9,
	0x30, 0x27, 0x7b, 0x4d, 0x9f, 0xbe, 0xde, 0x8a, 0x05, 0x26, 0x86, 0xbf, 0xac, 0xfa,
};

static void test_sha(void)
{
	static const uint8_t abc_hash[32] = {
		0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
		0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
	};
	struct sha256 s;
	uint8_t h[32];

	sha256_init(&s);
	sha256_update(&s, (const uint8_t *)"abc", 3);
	sha256_final(&s, h);
	CHECK(memcmp(h, abc_hash, 32) == 0);
}

static void test_destination_id(void)
{
	static const uint8_t ipk[16] = {0x9b, 0xc6, 0x1c, 0xd9, 0xc6, 0x2a, 0x2d, 0xf6,
					0xd6, 0x4d, 0xfc, 0xaa, 0x9d, 0xc4, 0x72, 0xd4};
	static const uint8_t random[32] = {
		0x7e, 0x17, 0x12, 0x31, 0x56, 0x8d, 0xfa, 0x17, 0x20, 0x6b, 0x3a, 0xcc, 0xf8, 0xfa, 0xec, 0x2f,
		0x4d, 0x21, 0xb5, 0x80, 0x11, 0x31, 0x96, 0xf4, 0x7c, 0x7c, 0x4d, 0xeb, 0x81, 0x0a, 0x73, 0xdc,
	};
	static const uint8_t want[32] = {
		0xdc, 0x35, 0xdd, 0x5f, 0xc9, 0x13, 0x4c, 0xc5, 0x54, 0x45, 0x38, 0xc9, 0xc3, 0xfc, 0x42, 0x97,
		0xc1, 0xec, 0x33, 0x70, 0xc8, 0x39, 0x13, 0x6a, 0x80, 0xe1, 0x07, 0x96, 0x45, 0x1d, 0x4c, 0x53,
	};
	uint8_t msg[113];
	uint8_t got[32];
	size_t n = mt_case_destination_message(msg, random, root_pub, 0x2906C908D115D362ull, 0xCD5544AA7B13EF14ull);

	CHECK(n == 113);
	hmac_sha256(ipk, 16, msg, n, got);
	CHECK(memcmp(got, want, 32) == 0);
}

/* What mt_fabric.c derives through PSA: the same inputs here. */
static void test_fabric_ids(void)
{
	static const uint8_t want_cfid[8] = {0x87, 0xe1, 0xb0, 0x04, 0xe2, 0x35, 0xa1, 0x30};
	static const uint8_t want_ipk0[16] = {0xc5, 0xf2, 0x69, 0x01, 0x87, 0x11, 0x51, 0x50,
					      0xc3, 0x56, 0xad, 0x93, 0xb3, 0x85, 0xbb, 0x0f};
	uint64_t fabric_id = 0x2906C908D115D362ull;
	uint8_t salt[8];
	uint8_t cfid[8];
	uint8_t ipk[16];
	uint8_t epoch[16] = {0};

	for (int i = 0; i < 8; i++) {
		salt[i] = (uint8_t)(fabric_id >> (56 - 8 * i));
	}
	hkdf_sha256(salt, 8, &root_pub[1], 64, (const uint8_t *)"CompressedFabric", 16, cfid, 8);
	CHECK(memcmp(cfid, want_cfid, 8) == 0);
	hkdf_sha256(cfid, 8, epoch, 16, (const uint8_t *)"GroupKey v1.0", 13, ipk, 16);
	CHECK(memcmp(ipk, want_ipk0, 16) == 0);
}

static void test_messages(void)
{
	uint8_t buf[600];
	uint8_t rnd[32];
	uint8_t dest[32];
	uint8_t eph[65];
	uint8_t eph2[65];
	uint8_t sig[64];
	uint8_t noc[200];

	memset(rnd, 1, sizeof(rnd));
	memset(dest, 2, sizeof(dest));
	memset(eph, 4, sizeof(eph));
	memset(eph2, 5, sizeof(eph2));
	memset(sig, 6, sizeof(sig));
	memset(noc, 7, sizeof(noc));

	int n = mt_case_sigma1(buf, sizeof(buf), rnd, 0x1234, dest, eph);

	CHECK(n == 1 + 35 + 4 + 35 + 68 + 1);
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e) && mt_tlv_find(&r, 2, &e) && e.v.u == 0x1234);
	CHECK(mt_tlv_find(&r, 4, &e) && e.len == 65);

	/* A Sigma2 as a device sends it */
	struct mt_tlv_writer w;
	uint8_t enc[100];

	memset(enc, 9, sizeof(enc));
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, rnd, 32);
	mt_tlv_put_uint(&w, 2, 0x4321);
	mt_tlv_put_bytes(&w, 3, eph2, 65);
	mt_tlv_put_bytes(&w, 4, enc, sizeof(enc));
	mt_tlv_start(&w, 5, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 1, 500);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);

	struct mt_case_sigma2 s2;

	CHECK(mt_case_parse_sigma2(buf, (size_t)n, &s2));
	CHECK(s2.session_id == 0x4321 && s2.encrypted_len == 100 && s2.eph_pub[0] == 5);
	for (int cut = 0; cut < n; cut++) {
		CHECK(!mt_case_parse_sigma2(buf, (size_t)cut, &s2));
	}

	/* TBEData2 */
	uint8_t resume[16] = {3};

	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, noc, sizeof(noc));
	mt_tlv_put_bytes(&w, 3, sig, 64);
	mt_tlv_put_bytes(&w, 4, resume, 16);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);

	struct mt_case_tbe2 t2;

	CHECK(mt_case_parse_tbe2(buf, (size_t)n, &t2));
	CHECK(t2.noc_len == sizeof(noc) && t2.icac == NULL && t2.signature[0] == 6 && t2.resumption_id[0] == 3);
	CHECK(!mt_case_parse_tbe2(buf, (size_t)n - 1, &t2));

	/* TBSData: tags 1, 3, 4 without an ICAC; 1, 2, 3, 4 with one */
	n = mt_case_tbs(buf, sizeof(buf), noc, sizeof(noc), NULL, 0, eph, eph2);
	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e));
	CHECK(mt_tlv_next(&r, &e) && e.tag == 1 && e.len == sizeof(noc));
	CHECK(mt_tlv_next(&r, &e) && e.tag == 3 && e.data[0] == 4);
	CHECK(mt_tlv_next(&r, &e) && e.tag == 4 && e.data[0] == 5);
	n = mt_case_tbs(buf, sizeof(buf), noc, sizeof(noc), noc, 10, eph, eph2);
	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e) && mt_tlv_find(&r, 2, &e) && e.len == 10);

	n = mt_case_tbe3(buf, sizeof(buf), noc, sizeof(noc), NULL, 0, sig);
	CHECK(n > 0);
	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e) && mt_tlv_find(&r, 3, &e) && e.len == 64);
	n = mt_case_sigma3(buf, sizeof(buf), enc, sizeof(enc));
	CHECK(n == 1 + 3 + 100 + 1);
}

int main(void)
{
	test_sha();
	test_destination_id();
	test_fabric_ids();
	test_messages();
	printf("matter CASE: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
