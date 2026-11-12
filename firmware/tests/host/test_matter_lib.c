/*
 * Host tests of this project's Matter commissioner library (firmware/matter/src/matter): the TLV codec against the
 * specification's examples, BTP framing in both directions, the message and protocol headers, the message
 * counter window, Interaction Model requests and responses, and the PASE message bodies. Crypto is not here: it
 * runs through PSA on the board.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mt_btp.h"
#include "mt_im.h"
#include "mt_msg.h"
#include "mt_pase_msg.h"
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

static uint8_t buf[2048];

#define ENC(stmt, ...)                                                                       \
	do {                                                                                 \
		static const uint8_t want[] = {__VA_ARGS__};                                 \
		struct mt_tlv_writer w;                                                      \
		mt_tlv_writer_init(&w, buf, sizeof(buf));                                    \
		stmt;                                                                        \
		CHECK(mt_tlv_finish(&w) == (int)sizeof(want));                               \
		CHECK(memcmp(buf, want, sizeof(want)) == 0);                                 \
	} while (0)

static void test_tlv_examples(void)
{
	/* Matter specification, appendix A.12 examples. */
	ENC(mt_tlv_put_bool(&w, MT_TLV_ANON, false), 0x08);
	ENC(mt_tlv_put_bool(&w, MT_TLV_ANON, true), 0x09);
	ENC(mt_tlv_put_int(&w, MT_TLV_ANON, 42), 0x00, 0x2a);
	ENC(mt_tlv_put_int(&w, MT_TLV_ANON, -17), 0x00, 0xef);
	ENC(mt_tlv_put_uint(&w, MT_TLV_ANON, 42), 0x04, 0x2a);
	ENC(mt_tlv_put_int(&w, MT_TLV_ANON, -170000), 0x02, 0xf0, 0x67, 0xfd, 0xff);
	ENC(mt_tlv_put_int(&w, MT_TLV_ANON, 40000000000), 0x03, 0x00, 0x90, 0x2f, 0x50, 0x09, 0x00, 0x00, 0x00);
	ENC(mt_tlv_put_str(&w, MT_TLV_ANON, "Hello!"), 0x0c, 0x06, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21);
	{
		static const uint8_t bytes[] = {0, 1, 2, 3, 4};

		ENC(mt_tlv_put_bytes(&w, MT_TLV_ANON, bytes, 5), 0x10, 0x05, 0x00, 0x01, 0x02, 0x03, 0x04);
	}
	ENC(mt_tlv_put_null(&w, MT_TLV_ANON), 0x14);
	ENC((mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT), mt_tlv_end(&w)), 0x15, 0x18);
	ENC((mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_ARRAY), mt_tlv_end(&w)), 0x16, 0x18);
	ENC((mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_LIST), mt_tlv_end(&w)), 0x17, 0x18);
	ENC((mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT), mt_tlv_put_int(&w, 0, 42), mt_tlv_put_int(&w, 1, -17),
	     mt_tlv_end(&w)),
	    0x15, 0x20, 0x00, 0x2a, 0x20, 0x01, 0xef, 0x18);
	ENC(mt_tlv_put_uint(&w, 1, 42), 0x24, 0x01, 0x2a);
	ENC(mt_tlv_put_uint(&w, 1, 0x1234), 0x25, 0x01, 0x34, 0x12);

	/* An open container or an overflow is no message. */
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	CHECK(mt_tlv_finish(&w) == -1);
	mt_tlv_writer_init(&w, buf, 3);
	mt_tlv_put_str(&w, MT_TLV_ANON, "Hello!");
	CHECK(mt_tlv_finish(&w) == -1);
}

static void test_tlv_read(void)
{
	/* Every type at once, read back. */
	struct mt_tlv_writer w;
	static const uint8_t oct[300] = {7};

	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 1, 0xFFFFFFFFFFull);
	mt_tlv_put_int(&w, 2, -2);
	mt_tlv_put_bool(&w, 3, true);
	mt_tlv_put_bytes(&w, 4, oct, sizeof(oct));
	mt_tlv_start(&w, 5, MT_TLV_ARRAY);
	mt_tlv_put_uint(&w, MT_TLV_ANON, 1);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 9, 9);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_put_null(&w, 6);
	mt_tlv_put_str(&w, 7, "x");
	mt_tlv_end(&w);
	int n = mt_tlv_finish(&w);

	CHECK(n > 0);

	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e) && e.type == MT_TLV_STRUCT);
	CHECK(mt_tlv_find(&r, 4, &e) && e.type == MT_TLV_BYTES && e.len == 300 && e.data[0] == 7);
	CHECK(mt_tlv_find(&r, 7, &e) && e.type == MT_TLV_UTF8 && e.len == 1 && e.data[0] == 'x');
	/* find skipped the array, including the tag 9 inside it */
	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e));
	CHECK(!mt_tlv_find(&r, 9, &e));
	mt_tlv_reader_init(&r, buf, (size_t)n);
	CHECK(mt_tlv_next(&r, &e));
	CHECK(mt_tlv_find(&r, 1, &e) && e.type == MT_TLV_UINT && e.v.u == 0xFFFFFFFFFFull);
	CHECK(mt_tlv_find(&r, 2, &e) && e.type == MT_TLV_INT && e.v.i == -2);
	CHECK(mt_tlv_find(&r, 5, &e) && e.type == MT_TLV_ARRAY);
	CHECK(mt_tlv_skip_container(&r));
	CHECK(mt_tlv_find(&r, 6, &e) && e.type == MT_TLV_NULL);

	/* Truncated anywhere: never reads past the end, never claims success at the end. */
	for (int cut = 0; cut < n; cut++) {
		mt_tlv_reader_init(&r, buf, (size_t)cut);
		while (mt_tlv_next(&r, &e)) {
		}
		CHECK(r.depth > 0 || r.error || cut == 0);
	}
	/* Garbage: a stray end, a reserved type, a string longer than the buffer. */
	static const uint8_t stray_end[] = {0x18};
	static const uint8_t reserved[] = {0x1f};
	static const uint8_t long_str[] = {0x10, 0x09, 0x01};

	mt_tlv_reader_init(&r, stray_end, sizeof(stray_end));
	CHECK(!mt_tlv_next(&r, &e) && r.error);
	mt_tlv_reader_init(&r, reserved, sizeof(reserved));
	CHECK(!mt_tlv_next(&r, &e) && r.error);
	mt_tlv_reader_init(&r, long_str, sizeof(long_str));
	CHECK(!mt_tlv_next(&r, &e) && r.error);
	/* A fully-qualified tag is stepped over. */
	static const uint8_t fq[] = {0xc4, 0xf1, 0xff, 0x01, 0x00, 0x05, 0x00, 0x2a};

	mt_tlv_reader_init(&r, fq, sizeof(fq));
	CHECK(mt_tlv_next(&r, &e) && e.type == MT_TLV_UINT && e.v.u == 42 && !e.context && e.tag == 5);
}

static void test_btp(void)
{
	struct mt_btp c;
	uint8_t pkt[256];

	CHECK(mt_btp_handshake_request(pkt, 247, 6) == 9);
	CHECK(pkt[0] == 0x65 && pkt[1] == 0x6c && pkt[2] == 4 && pkt[6] == 247 && pkt[7] == 0 && pkt[8] == 6);

	static const uint8_t resp[] = {0x65, 0x6c, 0x04, 0xf4, 0x00, 0x05};
	static const uint8_t bad_version[] = {0x65, 0x6c, 0x03, 0xf4, 0x00, 0x05};
	static const uint8_t too_big[] = {0x65, 0x6c, 0x04, 0xf5, 0x00, 0x05};

	CHECK(!mt_btp_handshake_response(&c, bad_version, sizeof(bad_version), 247));
	CHECK(!mt_btp_handshake_response(&c, too_big, sizeof(too_big), 247));
	CHECK(mt_btp_handshake_response(&c, resp, sizeof(resp), 247));
	CHECK(c.segment_size == 244 && c.window == 5);

	/* A 600-byte message in segments: the first acknowledges the handshake and carries the length. */
	static uint8_t msg[600];

	for (size_t i = 0; i < sizeof(msg); i++) {
		msg[i] = (uint8_t)(i * 7);
	}
	size_t off = 0;
	size_t n = mt_btp_segment(&c, msg, sizeof(msg), &off, pkt);

	CHECK(pkt[0] == (0x01 | 0x08) && pkt[1] == 0 && pkt[2] == 0 && pkt[3] == (600 & 0xff) && pkt[4] == 2);
	CHECK(n == 244 && off == 239);

	/* The peer side reassembles: a second instance in the peripheral's position. */
	struct mt_btp p;

	memset(&p, 0, sizeof(p));
	p.segment_size = 244;
	p.rx_seq = 0xff; /* expects our first packet, number 0 */
	p.tx_seq = 1;
	p.tx_unacked = 1; /* its handshake response, packet 0 */
	CHECK(mt_btp_receive(&p, pkt, n) == MT_BTP_RX_MORE);
	CHECK(p.tx_unacked == 0);
	n = mt_btp_segment(&c, msg, sizeof(msg), &off, pkt);
	CHECK(pkt[0] == 0x02 && pkt[1] == 1);
	CHECK(mt_btp_receive(&p, pkt, n) == MT_BTP_RX_MORE);
	n = mt_btp_segment(&c, msg, sizeof(msg), &off, pkt);
	CHECK(pkt[0] == (0x02 | 0x04) && off == 600);
	CHECK(mt_btp_receive(&p, pkt, n) == MT_BTP_RX_MESSAGE);
	CHECK(p.rx_len == 600 && memcmp(p.rx_buf, msg, 600) == 0);

	/* The peer acknowledges our three packets (0, 1, 2) with a reply. */
	struct mt_btp pr = p;

	pr.segment_size = 244;
	off = 0;
	static const uint8_t reply[] = {1, 2, 3};

	n = mt_btp_segment(&pr, reply, sizeof(reply), &off, pkt);
	CHECK(pkt[0] == (0x01 | 0x04 | 0x08) && pkt[1] == 2);
	CHECK(c.tx_unacked == 3);
	CHECK(mt_btp_receive(&c, pkt, n) == MT_BTP_RX_MESSAGE);
	CHECK(c.tx_unacked == 0 && c.rx_len == 3 && memcmp(c.rx_buf, reply, 3) == 0);

	/* An acknowledgement of a packet we never sent, a repeated sequence number, a stand-alone ack. */
	uint8_t ack[3];

	struct mt_btp saved = c;

	n = mt_btp_ack(&pr, ack);
	CHECK(n == 3 && ack[0] == 0x08);
	CHECK(mt_btp_receive(&c, ack, n) == MT_BTP_RX_ERROR); /* acknowledges 2 again: nothing outstanding */
	c = saved;
	uint8_t data_ack[] = {0x08, 0x05, (uint8_t)(c.rx_seq + 1)};

	CHECK(mt_btp_receive(&c, data_ack, 3) == MT_BTP_RX_ERROR);
	c = saved;
	uint8_t dup[] = {0x05, c.rx_seq, 1, 0, 9};

	CHECK(mt_btp_receive(&c, dup, sizeof(dup)) == MT_BTP_RX_ERROR);
	c = saved;
	uint8_t plain_ack_ok[] = {0x00, (uint8_t)(c.rx_seq + 1)};

	CHECK(mt_btp_receive(&c, plain_ack_ok, 2) == MT_BTP_RX_ACK_ONLY);
	/* A message that claims more than fits, and one that ends short. */
	c = saved;
	uint8_t huge[] = {0x01, (uint8_t)(c.rx_seq + 1), 0xff, 0xff, 1};

	CHECK(mt_btp_receive(&c, huge, sizeof(huge)) == MT_BTP_RX_ERROR);
	c = saved;
	uint8_t short_end[] = {0x05, (uint8_t)(c.rx_seq + 1), 9, 0, 1, 2};

	CHECK(mt_btp_receive(&c, short_end, sizeof(short_end)) == MT_BTP_RX_ERROR);
}

static void test_msg(void)
{
	struct mt_msg_header h = {
		.session_id = 0x1234, .security_flags = 0, .counter = 0x01020304,
		.has_source = true, .source_node = 0x1122334455667788ull,
	};
	struct mt_msg_header g;
	uint8_t out[64];
	size_t n = mt_msg_encode_header(&h, out, sizeof(out));

	CHECK(n == 16);
	CHECK(out[0] == 0x04 && out[1] == 0x34 && out[2] == 0x12 && out[4] == 0x04 && out[8] == 0x88);
	CHECK(mt_msg_decode_header(out, n, &g) == 16);
	CHECK(g.session_id == 0x1234 && g.counter == 0x01020304 && g.has_source && g.source_node == h.source_node);
	CHECK(!g.has_dest);
	CHECK(mt_msg_decode_header(out, 15, &g) == 0);
	CHECK(mt_msg_encode_header(&h, out, 15) == 0);
	out[0] = 0x10;
	CHECK(mt_msg_decode_header(out, n, &g) == 0); /* version 1 */

	uint8_t nonce[MT_NONCE_LEN];

	mt_msg_nonce(&h, h.source_node, nonce);
	CHECK(nonce[0] == 0 && nonce[1] == 0x04 && nonce[4] == 0x01 && nonce[5] == 0x88 && nonce[12] == 0x11);

	struct mt_proto_header p = {
		.exchange_flags = MT_EX_INITIATOR | MT_EX_RELIABLE, .opcode = MT_SC_PBKDF_REQ,
		.exchange_id = 0xabcd, .protocol_id = MT_PROTO_SECURE_CHANNEL, .has_ack = true, .ack_counter = 7,
	};
	struct mt_proto_header q;

	n = mt_msg_encode_proto(&p, out, sizeof(out));
	CHECK(n == 10 && out[0] == 0x07 && out[1] == 0x20 && out[2] == 0xcd && out[6] == 7);
	CHECK(mt_msg_decode_proto(out, n, &q) == 10);
	CHECK(q.opcode == MT_SC_PBKDF_REQ && q.exchange_id == 0xabcd && q.has_ack && q.ack_counter == 7);
	CHECK(mt_msg_decode_proto(out, 9, &q) == 0);

	uint16_t general = 0;
	uint32_t proto = 9;
	uint16_t code = 0;

	n = mt_status_report(out, 1, 0, 2);
	CHECK(n == 8 && mt_status_report_parse(out, n, &general, &proto, &code));
	CHECK(general == 1 && proto == 0 && code == 2);
}

static void test_counter(void)
{
	struct mt_counter_window w = {0};

	CHECK(mt_counter_accept(&w, 100));
	CHECK(!mt_counter_accept(&w, 100));
	CHECK(mt_counter_accept(&w, 99));
	CHECK(!mt_counter_accept(&w, 99));
	CHECK(mt_counter_accept(&w, 105));
	CHECK(mt_counter_accept(&w, 101));
	CHECK(!mt_counter_accept(&w, 101));
	CHECK(!mt_counter_accept(&w, 100));
	CHECK(mt_counter_accept(&w, 105 - 32));
	CHECK(!mt_counter_accept(&w, 105 - 33));
	CHECK(mt_counter_accept(&w, 200));
	CHECK(!mt_counter_accept(&w, 105));
	CHECK(mt_counter_accept(&w, 232));
	CHECK(!mt_counter_accept(&w, 200)); /* exactly 32 behind, seen */
	/* Wrapping past 2^32. */
	struct mt_counter_window x = {0};

	CHECK(mt_counter_accept(&x, 0xFFFFFFFEu));
	CHECK(mt_counter_accept(&x, 1));
	CHECK(!mt_counter_accept(&x, 0xFFFFFFFEu));
	CHECK(mt_counter_accept(&x, 0xFFFFFFFFu));
}

static void test_im(void)
{
	struct mt_tlv_writer w;

	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_im_invoke_begin(&w, 0, MT_CL_GENERAL_COMMISSIONING, MT_CMD_ARM_FAIL_SAFE, false);
	mt_tlv_put_uint(&w, 0, 60);
	mt_tlv_put_uint(&w, 1, 1);
	int n = mt_im_invoke_end(&w);

	static const uint8_t want[] = {
		0x15, 0x28, 0x00, 0x28, 0x01, 0x36, 0x02, 0x15, 0x37, 0x00, 0x24, 0x00, 0x00, 0x24, 0x01, 0x30,
		0x24, 0x02, 0x00, 0x18, 0x35, 0x01, 0x24, 0x00, 0x3c, 0x24, 0x01, 0x01, 0x18, 0x18, 0x18, 0x24,
		0xff, 0x0c, 0x18,
	};
	CHECK(n == (int)sizeof(want) && memcmp(buf, want, sizeof(want)) == 0);

	/* An InvokeResponse with ArmFailSafeResponse {0: errorCode 0, 1: debugText ""} */
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bool(&w, 0, false);
	mt_tlv_start(&w, 1, MT_TLV_ARRAY);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 0, MT_TLV_STRUCT);
	mt_tlv_start(&w, 0, MT_TLV_LIST);
	mt_tlv_put_uint(&w, 0, 0);
	mt_tlv_put_uint(&w, 1, MT_CL_GENERAL_COMMISSIONING);
	mt_tlv_put_uint(&w, 2, 1);
	mt_tlv_end(&w);
	mt_tlv_start(&w, 1, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 0, 0);
	mt_tlv_put_str(&w, 1, "");
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_put_uint(&w, 0xFF, MT_IM_REVISION);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);

	struct mt_im_invoke_result res;

	CHECK(mt_im_parse_invoke_response(buf, (size_t)n, &res));
	CHECK(res.has_fields && res.cluster == MT_CL_GENERAL_COMMISSIONING && res.command == 1);
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	mt_tlv_reader_init(&r, res.fields, res.fields_len);
	CHECK(mt_tlv_next(&r, &e) && e.type == MT_TLV_STRUCT && e.context && e.tag == 1);
	CHECK(mt_tlv_find(&r, 0, &e) && e.type == MT_TLV_UINT && e.v.u == 0);

	/* A CommandStatusIB with a failure */
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bool(&w, 0, false);
	mt_tlv_start(&w, 1, MT_TLV_ARRAY);
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_start(&w, 1, MT_TLV_STRUCT);
	mt_tlv_start(&w, 0, MT_TLV_LIST);
	mt_tlv_put_uint(&w, 0, 1);
	mt_tlv_put_uint(&w, 1, MT_CL_ONOFF);
	mt_tlv_put_uint(&w, 2, MT_CMD_ONOFF_TOGGLE);
	mt_tlv_end(&w);
	mt_tlv_start(&w, 1, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 0, 0x81); /* UnsupportedCommand */
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	CHECK(mt_im_parse_invoke_response(buf, (size_t)n, &res));
	CHECK(!res.has_fields && res.status == 0x81 && res.cluster == MT_CL_ONOFF);
	for (int cut = 0; cut < n; cut++) {
		CHECK(!mt_im_parse_invoke_response(buf, (size_t)cut, &res));
	}

	struct mt_attr_path paths[] = {{0, MT_CL_GENERAL_COMMISSIONING, 0}, {0, 0x0028, 2}};

	n = mt_im_read_request(buf, sizeof(buf), paths, 2);
	CHECK(n > 0 && buf[0] == 0x15 && buf[1] == 0x36 && buf[2] == 0x00);
	n = mt_im_status_response(buf, sizeof(buf), 0);
	CHECK(n == 8);
}

static void test_pase_messages(void)
{
	uint8_t rnd[MT_PASE_RANDOM_LEN];
	uint8_t other[MT_PASE_RANDOM_LEN];

	memset(rnd, 0xa5, sizeof(rnd));
	memset(other, 0x5a, sizeof(other));
	int n = mt_pase_pbkdf_request(buf, sizeof(buf), rnd, 0x4321);

	CHECK(n == 2 + 2 + 32 + 4 + 3 + 2 + 1);
	CHECK(buf[0] == 0x15 && buf[1] == 0x30 && buf[2] == 0x01 && buf[3] == 32);

	/* The response */
	struct mt_tlv_writer w;
	uint8_t salt[32];

	memset(salt, 0x33, sizeof(salt));
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, rnd, 32);
	mt_tlv_put_bytes(&w, 2, other, 32);
	mt_tlv_put_uint(&w, 3, 0x9988);
	mt_tlv_start(&w, 4, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 1, 1000);
	mt_tlv_put_bytes(&w, 2, salt, 32);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);

	struct mt_pase_pbkdf_response resp;

	CHECK(mt_pase_parse_pbkdf_response(buf, (size_t)n, rnd, &resp));
	CHECK(resp.responder_session_id == 0x9988 && resp.iterations == 1000 && resp.salt_len == 32);
	CHECK(!mt_pase_parse_pbkdf_response(buf, (size_t)n, other, &resp)); /* not our random */
	for (int cut = 0; cut < n; cut++) {
		CHECK(!mt_pase_parse_pbkdf_response(buf, (size_t)cut, rnd, &resp));
	}
	/* Too few iterations */
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, rnd, 32);
	mt_tlv_put_bytes(&w, 2, other, 32);
	mt_tlv_put_uint(&w, 3, 1);
	mt_tlv_start(&w, 4, MT_TLV_STRUCT);
	mt_tlv_put_uint(&w, 1, 999);
	mt_tlv_put_bytes(&w, 2, salt, 32);
	mt_tlv_end(&w);
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	CHECK(!mt_pase_parse_pbkdf_response(buf, (size_t)n, rnd, &resp));

	uint8_t pt[MT_PASE_POINT_LEN];
	uint8_t mac[MT_PASE_HASH_LEN];
	uint8_t pb[MT_PASE_POINT_LEN];
	uint8_t cb[MT_PASE_HASH_LEN];

	memset(pt, 4, sizeof(pt));
	memset(mac, 9, sizeof(mac));
	n = mt_pase_pake1(buf, sizeof(buf), pt);
	CHECK(n == 1 + 3 + 65 + 1 && buf[3] == 65);
	mt_tlv_writer_init(&w, buf, sizeof(buf));
	mt_tlv_start(&w, MT_TLV_ANON, MT_TLV_STRUCT);
	mt_tlv_put_bytes(&w, 1, pt, sizeof(pt));
	mt_tlv_put_bytes(&w, 2, mac, sizeof(mac));
	mt_tlv_end(&w);
	n = mt_tlv_finish(&w);
	CHECK(mt_pase_parse_pake2(buf, (size_t)n, pb, cb));
	CHECK(memcmp(pb, pt, sizeof(pt)) == 0 && memcmp(cb, mac, sizeof(mac)) == 0);
	CHECK(!mt_pase_parse_pake2(buf, (size_t)n - 3, pb, cb));
	n = mt_pase_pake3(buf, sizeof(buf), mac);
	CHECK(n == 2 + 2 + 32 + 1);
}

int main(void)
{
	test_tlv_examples();
	test_tlv_read();
	test_btp();
	test_msg();
	test_counter();
	test_im();
	test_pase_messages();
	printf("matter library: %d checks, %d failures\n", checks, failures);
	return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
