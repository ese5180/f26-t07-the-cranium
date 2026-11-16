/*
 * Host tests of the OTA provider's pieces (firmware/matter/src/matter): BDX messages, the OTA cluster commands
 * and their answers, the image store's header, the Interaction Model server side and CASE as responder.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mt_bdx.h"
#include "mt_case_msg.h"
#include "mt_im.h"
#include "mt_ota.h"
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

static uint8_t buf[1024];

static void test_bdx(void)
{
	/* A ReceiveInit as an OTA requestor sends it: receiver drive, block 1024, no offset or length,
	 * designator "light-2.0" */
	static const uint8_t init[] = {0x20, 0x00, 0x00, 0x04, 0x09, 0x00, 'l', 'i', 'g', 'h', 't', '-', '2', '.', '0'};
	struct mt_bdx_init in;

	CHECK(mt_bdx_parse_init(init, sizeof(init), &in));
	CHECK(in.transfer_control == 0x20 && in.max_block_size == 1024 && in.file_designator_len == 9);
	CHECK(memcmp(in.file_designator, "light-2.0", 9) == 0);
	CHECK(!mt_bdx_parse_init(init, sizeof(init) - 1, &in));
	/* with a start offset and a length */
	static const uint8_t init2[] = {0x20, 0x03, 0x00, 0x02, 0x10, 0, 0, 0, 0x00, 0x10, 0, 0, 0x01, 0x00, 'x'};

	CHECK(mt_bdx_parse_init(init2, sizeof(init2), &in));
	CHECK(in.start_offset == 16 && in.max_length == 4096 && in.max_block_size == 512);

	CHECK(mt_bdx_receive_accept(buf, 512, 300000) == 8);
	CHECK(buf[0] == 0x20 && buf[1] == 0x01 && buf[2] == 0x00 && buf[3] == 0x02);
	CHECK(buf[4] == (300000 & 0xff) && buf[6] == (300000 >> 16));

	uint32_t c;
	uint64_t skip;
	static const uint8_t q[] = {5, 0, 0, 0};
	static const uint8_t qs[] = {5, 0, 0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0};

	CHECK(mt_bdx_parse_counter(q, 4, &c) && c == 5);
	CHECK(!mt_bdx_parse_counter(q, 3, &c));
	CHECK(mt_bdx_parse_query_skip(qs, 12, &c, &skip) && c == 5 && skip == 16);
	CHECK(mt_bdx_block_header(buf, 0x01020304) == 4 && buf[0] == 4 && buf[3] == 1);
}

static void test_store_header(void)
{
	struct mt_ota_image img = {.vendor_id = 0xFFF1, .product_id = 0x8000, .version = 2, .length = 1234};
	struct mt_ota_image back;
	uint8_t hdr[MT_OTA_HEADER_LEN];

	strcpy(img.name, "light-2.0");
	mt_ota_make_header(&img, hdr);
	CHECK(mt_ota_parse_header(hdr, &back));
	CHECK(back.vendor_id == 0xFFF1 && back.product_id == 0x8000 && back.version == 2 && back.length == 1234);
	CHECK(strcmp(back.name, "light-2.0") == 0);
	hdr[0] ^= 1;
	CHECK(!mt_ota_parse_header(hdr, &back));
	hdr[0] ^= 1;
	hdr[16] = '/'; /* not a safe designator */
	CHECK(!mt_ota_parse_header(hdr, &back));
	memset(hdr, 0xff, sizeof(hdr)); /* erased flash */
	CHECK(!mt_ota_parse_header(hdr, &back));
}

static int query_fields(uint8_t *out, uint16_t vid, uint16_t pid, uint32_t version, bool bdx)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, out, 200);
	mt_tlv_start(&w, 1, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 0, vid);
	mt_tlv_put_uint(&w, 1, pid);
	mt_tlv_put_uint(&w, 2, version);
	mt_tlv_start(&w, 3, MT_TLV_ARRAY);
	if (bdx) {
		mt_tlv_put_uint(&w, MT_TLV_ANON, 0);
	}
	mt_tlv_put_uint(&w, MT_TLV_ANON, 2);
	mt_tlv_end(&w);
	mt_tlv_put_bool(&w, 6, true);
	mt_tlv_end(&w);
	return mt_tlv_finish(&w);
}

static void test_ota_commands(void)
{
	struct mt_ota_query q;
	struct mt_ota_image img = {.vendor_id = 0xFFF1, .product_id = 0x8000, .version = 2, .length = 100};
	uint8_t f[200];
	int n;

	strcpy(img.name, "light-2.0");
	n = query_fields(f, 0xFFF1, 0x8000, 1, true);
	CHECK(mt_ota_parse_query(f, (size_t)n, &q));
	CHECK(q.vendor_id == 0xFFF1 && q.product_id == 0x8000 && q.software_version == 1 && q.bdx_supported);
	CHECK(mt_ota_decide(&q, &img, true, false) == MT_OTA_STATUS_AVAILABLE);
	CHECK(mt_ota_decide(&q, &img, true, true) == MT_OTA_STATUS_BUSY);
	CHECK(mt_ota_decide(&q, &img, false, false) == MT_OTA_STATUS_NOT_AVAILABLE);
	n = query_fields(f, 0xFFF1, 0x8000, 2, true);
	CHECK(mt_ota_parse_query(f, (size_t)n, &q));
	CHECK(mt_ota_decide(&q, &img, true, false) == MT_OTA_STATUS_NOT_AVAILABLE); /* not newer */
	n = query_fields(f, 0xFFF1, 0x8001, 1, true);
	CHECK(mt_ota_parse_query(f, (size_t)n, &q));
	CHECK(mt_ota_decide(&q, &img, true, false) == MT_OTA_STATUS_NOT_AVAILABLE); /* another product */
	n = query_fields(f, 0xFFF1, 0x8000, 1, false);
	CHECK(mt_ota_parse_query(f, (size_t)n, &q) && !q.bdx_supported);
	CHECK(mt_ota_decide(&q, &img, true, false) == MT_OTA_STATUS_NOT_AVAILABLE); /* no BDX */
	CHECK(!mt_ota_parse_query(f, (size_t)n - 1, &q));

	/* The response */
	struct mt_tlv_writer w;
	struct mt_tlv_reader r;
	struct mt_tlv_element e;
	uint8_t token[8] = {1, 2, 3, 4, 5, 6, 7, 8};

	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_ota_query_response(&w, MT_OTA_STATUS_AVAILABLE, 1, &img, token);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e) && mt_tlv_find(&r, 0, &e) && e.v.u == 0);
	CHECK(mt_tlv_find(&r, 2, &e) && e.len == strlen("bdx://0000000000000001/light-2.0") &&
	      memcmp(e.data, "bdx://0000000000000001/light-2.0", e.len) == 0);
	CHECK(mt_tlv_find(&r, 3, &e) && e.v.u == 2);
	CHECK(mt_tlv_find(&r, 5, &e) && e.len == 8);

	/* ApplyUpdateRequest */
	mt_tlv_writer_init(&w, f, sizeof(f));
	mt_tlv_start(&w, 1, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 0, token, 8);
	mt_tlv_put_uint(&w, 1, 2);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	uint32_t v = 0;

	CHECK(mt_ota_parse_apply(f, (size_t)n, token, &v) && v == 2);
	uint8_t other[8] = {0};

	CHECK(!mt_ota_parse_apply(f, (size_t)n, other, &v));
}

static void test_im_server(void)
{
	struct mt_tlv_writer w;
	struct mt_im_invoke_request req;
	uint8_t f[200];

	/* the device's QueryImage InvokeRequest */
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_im_invoke_begin(&w, 0, 0x0029, MT_OTA_QUERY_IMAGE, false);
	mt_tlv_put_uint(&w, 0, 0xFFF1);
	mt_tlv_put_uint(&w, 1, 0x8000);
	mt_tlv_put_uint(&w, 2, 1);
	mt_tlv_start(&w, 3, MT_TLV_ARRAY);
	mt_tlv_put_uint(&w, MT_TLV_ANON, 0);
	mt_tlv_end(&w);
	int n = mt_im_invoke_end(&w);

	CHECK(mt_im_parse_invoke_request(buf, (size_t)n, &req));
	CHECK(req.cluster == 0x29 && req.command == 0 && req.endpoint == 0 && req.fields_len > 0);
	struct mt_ota_query q;

	CHECK(mt_ota_parse_query(req.fields, req.fields_len, &q) && q.bdx_supported && q.software_version == 1);
	for (int cut = 0; cut < n; cut++) {
		CHECK(!mt_im_parse_invoke_request(buf, (size_t)cut, &req));
	}
	CHECK(mt_im_parse_invoke_request(buf, (size_t)n, &req));
	/* a response with fields reads back with the client's parser */
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_im_response_begin(&w, 0, 0x29, MT_OTA_APPLY_UPDATE_RESPONSE);
	mt_ota_apply_response(&w);
	n = mt_im_response_end(&w);
	CHECK(n > 0);
	struct mt_im_invoke_result res;

	CHECK(mt_im_parse_invoke_response(buf, (size_t)n, &res));
	CHECK(res.has_fields && res.cluster == 0x29 && res.command == MT_OTA_APPLY_UPDATE_RESPONSE);
	/* a status response */
	n = mt_im_response_status(buf, sizeof(buf), &req, MT_IM_STATUS_UNSUPPORTED_CLUSTER);
	CHECK(mt_im_parse_invoke_response(buf, (size_t)n, &res));
	CHECK(!res.has_fields && res.status == MT_IM_STATUS_UNSUPPORTED_CLUSTER);
	(void)f;
}

static void test_case_responder(void)
{
	uint8_t rnd[32];
	uint8_t dest[32];
	uint8_t eph[65];
	uint8_t sig[64];
	uint8_t noc[150];
	uint8_t resume[16];
	struct mt_case_sigma1 s1;

	memset(rnd, 1, 32);
	memset(dest, 2, 32);
	memset(eph, 4, 65);
	memset(sig, 6, 64);
	memset(noc, 7, sizeof(noc));
	memset(resume, 8, 16);
	int n = mt_case_sigma1(buf, sizeof(buf), rnd, 0x777, dest, eph);

	CHECK(mt_case_parse_sigma1(buf, (size_t)n, &s1));
	CHECK(s1.session_id == 0x777 && s1.destination_id[0] == 2 && s1.eph_pub[0] == 4);
	CHECK(!mt_case_parse_sigma1(buf, (size_t)n - 1, &s1));

	uint8_t tbe[300];

	n = mt_case_tbe2(tbe, sizeof(tbe), noc, sizeof(noc), NULL, 0, sig, resume);
	struct mt_case_tbe2 t2;

	CHECK(n > 0 && mt_case_parse_tbe2(tbe, (size_t)n, &t2) && t2.resumption_id[0] == 8);
	n = mt_case_sigma2(buf, sizeof(buf), rnd, 0x888, eph, tbe, 100);
	struct mt_case_sigma2 s2;

	CHECK(mt_case_parse_sigma2(buf, (size_t)n, &s2) && s2.session_id == 0x888 && s2.encrypted_len == 100);

	const uint8_t *enc;
	size_t enc_len;

	n = mt_case_sigma3(buf, sizeof(buf), tbe, 50);
	CHECK(mt_case_parse_sigma3(buf, (size_t)n, &enc, &enc_len) && enc_len == 50);
	const uint8_t *noc_out;
	size_t noc_len;
	const uint8_t *icac_out;
	size_t icac_len;
	const uint8_t *sig_out;

	n = mt_case_tbe3(tbe, sizeof(tbe), noc, sizeof(noc), noc, 9, sig);
	CHECK(mt_case_parse_tbe3(tbe, (size_t)n, &noc_out, &noc_len, &icac_out, &icac_len, &sig_out) &&
	      noc_len == sizeof(noc) && icac_len == 9);
	CHECK(!mt_case_parse_tbe3(tbe, (size_t)n - 1, &noc_out, &noc_len, &icac_out, &icac_len, &sig_out));
}

int main(void)
{
	test_bdx();
	test_store_header();
	test_ota_commands();
	test_im_server();
	test_case_responder();
	printf("matter OTA provider: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
