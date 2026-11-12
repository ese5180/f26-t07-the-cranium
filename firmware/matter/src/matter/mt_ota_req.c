/*
 * See mt_ota_req.h.
 */
#include "mt_ota_req.h"

#include <errno.h>
#include <string.h>

#include <zephyr/dfu/flash_img.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/reboot.h>

#include "mt_bdx.h"
#include "mt_controller.h"
#include "mt_im.h"
#include "mt_msg.h"
#include "mt_node.h"
#include "mt_ota.h"
#include "mt_server.h"
#include "mt_tlv.h"

LOG_MODULE_REGISTER(mt_ota_req, LOG_LEVEL_INF);

#define BLOCK 1024

extern uint32_t mt_board_software_version(void);

static enum { R_IDLE, R_QUERY, R_DOWNLOAD, R_APPLY, R_RESTART } state;
static uint64_t provider;
static uint16_t provider_ep;
static uint8_t token[32];
static size_t token_len;
static uint32_t new_version;
static char file[64];
static size_t file_len;
static int query_status;
static struct flash_img_context img;
static uint32_t block;
static uint64_t total;
static uint64_t received;

struct pending {
	uint8_t token[32];
	uint8_t token_len;
	uint32_t version;
	uint64_t provider;
	uint16_t endpoint;
};

static void query_fields(struct mt_tlv_writer *w, void *ctx)
{
	ARG_UNUSED(ctx);
	mt_tlv_put_uint(w, 0, MT_NODE_VENDOR_ID);
	mt_tlv_put_uint(w, 1, MT_NODE_PRODUCT_ID);
	mt_tlv_put_uint(w, 2, mt_board_software_version());
	mt_tlv_start(w, 3, MT_TLV_ARRAY);
	mt_tlv_put_uint(w, MT_TLV_ANON, 0); /* BDXSynchronous */
	mt_tlv_end(w);
	mt_tlv_put_bool(w, 6, false); /* RequestorCanConsent */
}

static void query_response(const uint8_t *fields, size_t len)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	query_status = -1;
	mt_tlv_reader_init(&r, fields, len);
	if (!mt_tlv_next(&r, &e)) {
		return;
	}
	while (mt_tlv_next(&r, &e) && r.depth > 0) {
		if (!e.context) {
			continue;
		}
		if (e.tag == 0 && e.type == MT_TLV_UINT) {
			query_status = (int)e.v.u;
		} else if (e.tag == 2 && e.type == MT_TLV_UTF8) {
			uint64_t node;
			const char *f;
			size_t fl;

			if (mt_bdx_parse_uri((const char *)e.data, e.len, &node, &f, &fl) && fl < sizeof(file)) {
				memcpy(file, f, fl);
				file_len = fl;
			}
		} else if (e.tag == 3 && e.type == MT_TLV_UINT) {
			new_version = (uint32_t)e.v.u;
		} else if (e.tag == 5 && e.type == MT_TLV_BYTES && e.len <= sizeof(token)) {
			memcpy(token, e.data, e.len);
			token_len = e.len;
		}
	}
}

static void fail(const char *why, int err)
{
	LOG_WRN("update over Matter stopped: %s (%d)", why, err);
	state = R_IDLE;
}

static void send_query(uint8_t opcode, const uint8_t *body, size_t len)
{
	int err = mt_ctl_exchange_send(MT_PROTO_BDX, opcode, body, len, false);

	if (err) {
		mt_ctl_exchange_end(err);
	}
}

static void bdx_rx(uint8_t opcode, uint16_t protocol, const uint8_t *body, size_t len)
{
	uint8_t c[4];

	if (protocol != MT_PROTO_BDX) {
		mt_ctl_exchange_end(-EPROTO);
		return;
	}
	if (opcode == MT_BDX_RECEIVE_ACCEPT) {
		uint16_t bs;

		if (!mt_bdx_parse_accept(body, len, &bs, &total) || bs > BLOCK || flash_img_init(&img) != 0) {
			mt_ctl_exchange_end(-EINVAL);
			return;
		}
		LOG_INF("downloading %llu bytes in blocks of %u", (unsigned long long)total, bs);
		block = 0;
		received = 0;
		send_query(MT_BDX_BLOCK_QUERY, c, mt_bdx_counter(c, block));
	} else if (opcode == MT_BDX_BLOCK || opcode == MT_BDX_BLOCK_EOF) {
		uint32_t got;
		bool last = opcode == MT_BDX_BLOCK_EOF;

		if (len < 4 || !mt_bdx_parse_counter(body, 4, &got) || got != block ||
		    flash_img_buffered_write(&img, &body[4], len - 4, last) != 0) {
			mt_ctl_exchange_end(-EIO);
			return;
		}
		received += len - 4;
		block++;
		if (!last) {
			send_query(MT_BDX_BLOCK_QUERY, c, mt_bdx_counter(c, block));
			return;
		}
		/* BlockAckEOF closes the transfer; then ApplyUpdate. */
		(void)mt_ctl_exchange_send(MT_PROTO_BDX, MT_BDX_BLOCK_ACK_EOF, c, mt_bdx_counter(c, got), false);
		mt_ctl_exchange_end(0);
	} else {
		mt_ctl_exchange_end(-EPROTO);
	}
}

static void apply_fields(struct mt_tlv_writer *w, void *ctx)
{
	ARG_UNUSED(ctx);
	mt_tlv_put_bytes(w, 0, token, token_len);
	mt_tlv_put_uint(w, 1, new_version);
}

static int apply_action;

static void apply_response(const uint8_t *fields, size_t len)
{
	struct mt_tlv_reader r;
	struct mt_tlv_element e;

	apply_action = -1;
	mt_tlv_reader_init(&r, fields, len);
	if (mt_tlv_next(&r, &e) && mt_tlv_find(&r, 0, &e) && e.type == MT_TLV_UINT) {
		apply_action = (int)e.v.u;
	}
}

static void restart_work_fn(struct k_work *w)
{
	ARG_UNUSED(w);
	sys_reboot(SYS_REBOOT_WARM);
}
static K_WORK_DELAYABLE_DEFINE(restart_work, restart_work_fn);

static void applied(uint64_t node, int result)
{
	ARG_UNUSED(node);
	if (result != 0 || apply_action != 0) {
		fail("ApplyUpdate", result ? result : apply_action);
		return;
	}
	struct pending p = {.token_len = (uint8_t)token_len, .version = new_version, .provider = provider,
			    .endpoint = provider_ep};

	memcpy(p.token, token, token_len);
	(void)settings_save_one("mtota/pending", &p, sizeof(p));
	if (boot_request_upgrade(BOOT_UPGRADE_TEST) != 0) {
		fail("could not mark the image for MCUboot", -EIO);
		return;
	}
	state = R_RESTART;
	LOG_INF("new image %u in place: restarting into it", new_version);
	k_work_reschedule(&restart_work, K_SECONDS(2));
}

static struct sockaddr_in6 provider_addr;
static bool have_provider_addr;

static void downloaded(uint64_t node, int result)
{
	ARG_UNUSED(node);
	if (result != 0) {
		fail("download", result);
		return;
	}
	state = R_APPLY;
	int err = mt_ctl_invoke_phone(provider, have_provider_addr ? &provider_addr : NULL, provider_ep,
				      MT_CL_OTA_PROVIDER, MT_OTA_APPLY_UPDATE, apply_fields, NULL, apply_response, applied);

	if (err) {
		fail("ApplyUpdate", err);
	}
}

static void queried(uint64_t node, int result)
{
	uint8_t init[80];

	ARG_UNUSED(node);
	if (result != 0) {
		fail("QueryImage", result);
		return;
	}
	if (query_status != MT_OTA_STATUS_AVAILABLE || file_len == 0 || token_len == 0) {
		LOG_INF("the phone has no newer image (%d)", query_status);
		state = R_IDLE;
		return;
	}
	LOG_INF("the phone offers version %u (%.*s)", new_version, (int)file_len, file);
	state = R_DOWNLOAD;
	size_t n = mt_bdx_receive_init(init, sizeof(init), BLOCK, file, file_len);
	int err = mt_ctl_exchange_begin(bdx_rx, downloaded);

	if (!err) {
		err = mt_ctl_exchange_send(MT_PROTO_BDX, MT_BDX_RECEIVE_INIT, init, n, true);
	}
	if (err) {
		fail("BDX", err);
	}
}

int mt_ota_req_start(uint64_t provider_node, uint16_t endpoint)
{
	if (state != R_IDLE) {
		return -EBUSY;
	}
	provider = provider_node;
	provider_ep = endpoint;
	token_len = 0;
	file_len = 0;
	have_provider_addr = mt_server_phone_address(&provider_addr);
	state = R_QUERY;
	int err = mt_ctl_invoke_phone(provider, have_provider_addr ? &provider_addr : NULL, provider_ep,
				      MT_CL_OTA_PROVIDER, MT_OTA_QUERY_IMAGE, query_fields, NULL, query_response, queried);

	if (err) {
		state = R_IDLE;
	}
	return err;
}

static struct pending boot_pending;
static bool boot_has_pending;

static int ota_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	if (strcmp(name, "pending") == 0 && len == sizeof(boot_pending)) {
		boot_has_pending = read_cb(cb_arg, &boot_pending, sizeof(boot_pending)) == sizeof(boot_pending);
	}
	return 0;
}
SETTINGS_STATIC_HANDLER_DEFINE(mt_ota_req, "mtota", NULL, ota_set, NULL, NULL);

static void notify_fields(struct mt_tlv_writer *w, void *ctx)
{
	ARG_UNUSED(ctx);
	mt_tlv_put_bytes(w, 0, boot_pending.token, boot_pending.token_len);
	mt_tlv_put_uint(w, 1, boot_pending.version);
}

static void notified(uint64_t node, int result)
{
	ARG_UNUSED(node);
	LOG_INF("NotifyUpdateApplied: %d", result);
}

void mt_ota_req_boot(void)
{
	(void)settings_load_subtree("mtota");
	if (!boot_is_img_confirmed()) {
		/* running a new image under test: it got this far, so keep it */
		if (boot_write_img_confirmed() == 0) {
			LOG_INF("new image confirmed");
		}
	}
	if (boot_has_pending) {
		(void)settings_delete("mtota/pending");
		boot_has_pending = false;
		if (boot_pending.version == mt_board_software_version()) {
			(void)mt_ctl_invoke_phone(boot_pending.provider, NULL, boot_pending.endpoint, MT_CL_OTA_PROVIDER,
						  MT_OTA_NOTIFY_APPLIED, notify_fields, NULL, NULL, notified);
		}
	}
}

const char *mt_ota_req_state(void)
{
	static const char *const names[] = {"idle", "asking the phone", "downloading", "applying", "restarting"};

	return names[state];
}
