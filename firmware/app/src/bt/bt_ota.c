#include "bt_ota.h"

#include <errno.h>
#include <string.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/crypto.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/dfu/mcuboot.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/mgmt/mcumgr/grp/img_mgmt/img_mgmt.h>
#include <zephyr/mgmt/mcumgr/mgmt/callbacks.h>
#include <zephyr/mgmt/mcumgr/mgmt/mgmt_defines.h>
#include <zephyr/mgmt/mcumgr/transport/smp_bt.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/reboot.h>

#include "app_events.h"
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
#include "bt_passkey.h"
#endif
#include "bt_status.h"
#include "cloud.h"
#include "console.h"
#include "device.h"
#include "identity.h"
#include "image_compat.h"
#include "mflt.h"
#include "net.h"
#include "ota.h"
#include "ota_job.h"
#include "store.h"
#include "version.h"

LOG_MODULE_REGISTER(bt_ota, CONFIG_APP_LOG_LEVEL);

/*
 * What the security of this rests on, all of it from bt_ota.conf. These are not choices: if one
 * changes, by a stray -D or by a new default in the SDK, the build stops here.
 */
#if !defined(CONFIG_MCUMGR_TRANSPORT_BT_PERM_RW_AUTHEN)
#error "The SMP characteristic must require an authenticated link"
#endif
#if !defined(CONFIG_BT_SMP_SC_ONLY) || !defined(CONFIG_BT_SMP_ENFORCE_MITM) || \
	CONFIG_BT_SMP_MIN_ENC_KEY_SIZE != 16
#error "Pairing must be LE Secure Connections, MITM protected, with a 16-byte key"
#endif
#if defined(CONFIG_BT_BONDABLE) || defined(CONFIG_BT_SETTINGS)
#error "A pairing must last as long as the link: no bonds"
#endif
#if defined(CONFIG_BT_FIXED_PASSKEY) || defined(CONFIG_BT_USE_DEBUG_KEYS) || \
	defined(CONFIG_BT_CONN_DISABLE_SECURITY)
#error "The Bluetooth host must pair with real keys, and with no passkey fixed in the image"
#endif
/*
 * A board with a cloud gets a new passkey for every attempt, drawn by the host. One with Bluetooth only
 * hands the host its own, from protected storage, which src/bt/bt_passkey.h explains: only then may the
 * application provide one.
 */
#if defined(CONFIG_BT_APP_PASSKEY) != defined(CONFIG_APP_BT_STATIC_PASSKEY)
#error "Only a board's own stored passkey may replace the one the host draws: see bt_passkey.h"
#endif
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
BUILD_ASSERT(BT_PASSKEY_NONE == BT_PASSKEY_RAND, "bt_passkey.h's none is the host's draw-one-yourself");
#endif
#if defined(CONFIG_MCUMGR_GRP_OS) || defined(CONFIG_MCUMGR_GRP_FS) || \
	defined(CONFIG_MCUMGR_GRP_SHELL) || defined(CONFIG_MCUMGR_GRP_STAT) || \
	defined(CONFIG_MCUMGR_GRP_SETTINGS) || defined(CONFIG_MCUMGR_GRP_ZBASIC) || \
	defined(CONFIG_MCUMGR_GRP_ENUM) || defined(CONFIG_MEMFAULT_MCUMGR_GRP)
/* The Memfault SDK's group, on by default with MCUmgr, would read out its project key. */
#error "MCUmgr must have the image group and no other"
#endif
#if defined(CONFIG_MCUMGR_TRANSPORT_UART) || defined(CONFIG_MCUMGR_TRANSPORT_RAW_UART) || \
	defined(CONFIG_MCUMGR_TRANSPORT_SHELL) || defined(CONFIG_MCUMGR_TRANSPORT_UDP) || \
	defined(CONFIG_MCUMGR_TRANSPORT_LORAWAN) || defined(CONFIG_MCUMGR_TRANSPORT_DUMMY) || \
	defined(CONFIG_MCUMGR_TRANSPORT_RAW_DUMMY)
#error "MCUmgr must have the Bluetooth transport and no other"
#endif
#if defined(CONFIG_MCUMGR_GRP_IMG_ALLOW_CONFIRM_NON_ACTIVE_SLOT) || \
	defined(CONFIG_MCUMGR_GRP_IMG_ALLOW_ERASE_PENDING) || \
	defined(CONFIG_MCUMGR_GRP_IMG_DIRECT_UPLOAD)
#error "MCUmgr must not be able to make a swap permanent, erase what is pending, or pick a slot"
#endif
#if !defined(CONFIG_MCUMGR_GRP_IMG_MUTEX)
#error "Closing a window relies on img_mgmt's lock: see close_window()"
#endif
#if defined(CONFIG_BT_GAP_AUTO_UPDATE_CONN_PARAMS)
#error "The board must not ask a phone for other connection timing while it pairs: see bt_ota.conf"
#endif

BUILD_ASSERT(BT_OTA_SMP_OP_READ == MGMT_OP_READ && BT_OTA_SMP_OP_WRITE == MGMT_OP_WRITE);
BUILD_ASSERT(BT_OTA_SMP_GROUP_IMAGE == MGMT_GROUP_ID_IMAGE);
BUILD_ASSERT(BT_OTA_SMP_ID_STATE == IMG_MGMT_ID_STATE);
BUILD_ASSERT(BT_OTA_SMP_ID_UPLOAD == IMG_MGMT_ID_UPLOAD);
BUILD_ASSERT(BT_OTA_IMAGE_MAGIC == IMAGE_MAGIC);
BUILD_ASSERT(BT_OTA_IMAGE_HEADER_LEN == IMAGE_HEADER_SIZE);

#define SECONDARY_SLOT_ID PARTITION_ID(slot1_partition)
/* img_mgmt's number for the secondary slot. */
#define SECONDARY_SLOT    1
/* SHA-256: what img_mgmt_read_info() gives. */
#define IMAGE_SHA_LEN     32
/* An upload must stop short of the trailer. See bt_ota_check_upload(). */
#define MAX_UPLOAD        (PARTITION_SIZE(slot1_partition) - CONFIG_MCUBOOT_UPDATE_FOOTER_SIZE)

#define KEY_SIZE_REQUIRED 16
#define ADV_NAME_SIZE     (sizeof(CONFIG_BT_DEVICE_NAME) + 5)

/* The status goes to a phone again after this long, if nothing but its counts has changed. */
#define STATUS_REFRESH_MS 10000
/* How long the main loop waits for a status to go out before it closes the link or restarts. */
#define STATUS_SENT_MS    500

#if !defined(CONFIG_APP_BT_ONLY)
/*
 * P1.10 picks the antenna of the network core's radio: low for its own, high for the one it
 * would share with Wi-Fi. It starts undriven, so it is driven low before anything is sent. A board
 * with Bluetooth only has no Wi-Fi chip, and its radio has an antenna of its own.
 */
static const struct gpio_dt_spec antenna_switch =
	GPIO_DT_SPEC_GET(DT_NODELABEL(nrf70), srrf_switch_gpios);
#endif

/* The main loop's. The Bluetooth and MCUmgr threads see only the atomics below. */
static struct bt_ota_window window;
static struct bt_ota_record record;
static bool have_record;
/* What has arrived, while it waits for a button. */
static struct bt_ota_record offered;
static bool bluetooth_trial;
static bool enabled;
static bool controller_failed;
static bool report_waiting;
static enum bt_ota_proof_result last_proof = BT_OTA_PROVED;
static char name[ADV_NAME_SIZE];
#if !defined(CONFIG_APP_BT_ONLY)
/* A passkey went into the device shadow, and has not been taken out again. */
static bool pairing_reported;
#endif
#if defined(CONFIG_APP_BT_ONLY)
/* For the LEDs of a board with Bluetooth only: see bt_ota_link_view(). */
static uint32_t commands_last_tick;
static enum bt_ota_link_view link_view;
#endif

/*
 * What the status characteristic says of this window (bt_status.h), as the main loop has seen it.
 * A new window starts with none of it.
 */
static struct {
	enum bt_status_image image;
	enum bt_status_refusal refusal;
	uint32_t bytes;
	struct fw_version version;
	enum bt_status_result result;
	uint8_t closed;
} track;

/* After the restart that an update over Bluetooth asked for: see bt_ota_status_due(). */
static struct bt_ota_status_window status_window;
static bool status_due;

/*
 * The status as a phone reads it, which the Bluetooth host's thread copies under the lock, and as it
 * was last told to a phone that asked for notifications.
 */
static struct k_spinlock status_lock;
static uint8_t status_payload[BT_STATUS_LEN];
static uint8_t status_told[BT_STATUS_LEN];
static int64_t status_told_at;
static K_SEM_DEFINE(status_sent, 0, 1);

/*
 * Set by the main loop, read by the threads that serve a phone. GATE_STATUS: a phone may connect
 * to read the status, and do nothing else: no pairing, so no SMP.
 */
#define GATE_OPEN    BIT(0)
#define GATE_UPLOADS BIT(1)
#define GATE_STATUS  BIT(2)
static atomic_t gate;

/* Set by those threads, and read by the main loop once a second. */
static atomic_t ready;
static atomic_t start_failed;
static atomic_t connected;
static atomic_t secure;
static atomic_t failed_pairings;
static atomic_t commands;
static atomic_t list_reads;
static atomic_t upload_done;
/* The link that is up was made for the status alone: it can never pair. */
static atomic_t status_link;

/*
 * What the upload under way has done, for the status: the image state and the refusal
 * (state | refusal << 8), the bytes so far and in all, and the version from its header
 * (major | minor << 8 | revision << 16, and the build number).
 */
static atomic_t upload_state;
static atomic_t upload_bytes;
static atomic_t upload_total;
static atomic_t upload_version;
static atomic_t upload_build;
#if defined(CONFIG_APP_BT_ONLY)
/* Something went wrong that a person should see, for LED4: see bt_ota_take_trouble(). */
static atomic_t trouble;
#define NOTE_TROUBLE() ((void)atomic_set(&trouble, 1))
#else
/* LED4 is a board with Bluetooth only's: an nRF7002 DK says all of this on its console and in the cloud. */
#define NOTE_TROUBLE() ((void)0)
#endif
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
/* The pairing under way was handed the board's own passkey, and not one the host drew. */
static atomic_t own_passkey;
#endif

/*
 * What a phone did, for the main loop to say. A line takes more stack than the Bluetooth threads
 * have to spare, and the passkey can come from the small one that works out the keys.
 */
#define SAY_CONNECTED BIT(0)
#define SAY_PAIRED    BIT(1)
#define SAY_CANCELLED BIT(2)
#define SAY_FAILED    BIT(3)
#define SAY_GONE      BIT(4)
#define SAY_REFUSED   BIT(5)
#define SAY_PARAMS    BIT(6)
#define SAY_PHY       BIT(7)
#define SAY_DATA_LEN  BIT(8)
#define SAY_STATUS    BIT(9)
/* A phone asked for notifications of the status: it gets the status at once. */
#define SAY_SUBSCRIBED BIT(10)
/* The board's own passkey is being used: that is said, and the passkey never. */
#define SAY_OWN_KEY    BIT(11)
static atomic_t to_say;
/* The passkey plus one, because 0 is a passkey too. */
static atomic_t passkey_to_say;
static atomic_t failure_reason;
static atomic_t gone_reason;
/* What the link negotiated, and a security level that was not enough: for the console only. */
static atomic_t refused_security; /* level << 8 | error */
static atomic_t link_params;      /* interval (1.25 ms units) << 16 | timeout (10 ms units) */
static atomic_t link_latency;
static atomic_t link_phy;         /* tx << 8 | rx */
static atomic_t link_data_len;    /* tx bytes << 16 | rx bytes */

/*
 * What the upload under way says it is for, from its protected TLVs as their bytes go by
 * (image_compat.h). An image for another board type or flash layout is refused at the piece that
 * completes that area, before the piece is written, with an SMP error that the tool shows. MCUmgr's
 * thread alone, under img_mgmt's lock. The main loop reads the slot again before anything is
 * offered, and again before it is marked (offer_image(), install_image()).
 */
static struct {
	struct image_compat_reader reader;
	uint64_t protected_at;
	bool judged;
	enum image_compat_verdict verdict;
} upload_compat;

/* ---- the threads that serve a phone: only what the atomics hold ---------------------- */

static void say_what_happened(void);

/* If the queue is full the next tick says it. */
static void tell_main_loop(atomic_val_t what)
{
	const struct app_event event = {
		.type = APP_EVENT_CALL,
		.call.function = say_what_happened,
	};

	(void)atomic_or(&to_say, what);
	(void)app_event_post(&event);
}

static enum mgmt_cb_return on_command(uint32_t event, enum mgmt_cb_return prev_status, int32_t *rc,
				      uint16_t *group, bool *abort_more, void *data,
				      size_t data_size)
{
	const struct mgmt_evt_op_cmd_arg *command = data;
	atomic_val_t now = atomic_get(&gate);

	ARG_UNUSED(prev_status);
	ARG_UNUSED(group);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data_size);

	if (event == MGMT_EVT_OP_CMD_DONE) {
		/* Read back from flash, and sent over the same link: this path works. */
		if (command->group == MGMT_GROUP_ID_IMAGE && command->id == IMG_MGMT_ID_STATE &&
		    command->err == MGMT_ERR_EOK) {
			(void)atomic_inc(&list_reads);
		}
		return MGMT_CB_OK;
	}

	if (!bt_ota_command_allowed(command->group, command->id, command->op,
				    (now & GATE_OPEN) != 0 && atomic_get(&secure) != 0,
				    (now & GATE_UPLOADS) != 0)) {
		console_event("BT", "refused a command: group %u, id %u, op %u", command->group,
			      command->id, command->op);
		NOTE_TROUBLE();
		*rc = MGMT_ERR_EACCESSDENIED;
		return MGMT_CB_ERROR_RC;
	}

	(void)atomic_inc(&commands);
	return MGMT_CB_OK;
}

static void upload_refused(enum bt_status_refusal refusal)
{
	(void)atomic_set(&upload_state,
			 (atomic_val_t)(BT_STATUS_IMAGE_REFUSED | ((uint32_t)refusal << 8)));
}

/* The version in an image header, for the status, from a first piece that has one. */
static void upload_header_seen(const uint8_t *data, size_t len, uint64_t total)
{
	uint16_t revision;
	uint32_t build;

	(void)atomic_set(&upload_total, (atomic_val_t)total);
	if (data == NULL || len < BT_OTA_IMAGE_HEADER_LEN) {
		return;
	}

	memcpy(&revision, data + 22, sizeof(revision));
	memcpy(&build, data + 24, sizeof(build));
	(void)atomic_set(&upload_version,
			 (atomic_val_t)(data[20] | ((uint32_t)data[21] << 8) | ((uint32_t)revision << 16)));
	(void)atomic_set(&upload_build, (atomic_val_t)build);
}

/* The bytes of this piece that are of the protected area, and the verdict once it is all there. */
static bool upload_compat_ok(uint64_t off, const uint8_t *data, size_t len)
{
	struct image_compat_reader *reader = &upload_compat.reader;
	uint64_t next = upload_compat.protected_at + reader->at;
	uint64_t end = upload_compat.protected_at + reader->total;
	struct image_compat found;

	if (upload_compat.judged) {
		return upload_compat.verdict == IMAGE_COMPAT_OK;
	}

	if (next < end && off + len > next) {
		/* MCUmgr takes pieces in order only: a gap would be bytes of the area never read. */
		if (off > next) {
			reader->bad = true;
		} else {
			size_t from = (size_t)(next - off);

			image_compat_feed(reader, data + from, (size_t)(MIN(off + len, end) - next));
		}
	}

	if (!image_compat_complete(reader)) {
		return true;
	}

	upload_compat.judged = true;
	upload_compat.verdict =
		image_compat_finish(reader, CONFIG_APP_BOARD_TYPE, CONFIG_APP_IMAGE_LAYOUT, &found);

	switch (upload_compat.verdict) {
	case IMAGE_COMPAT_OK:
		return true;
	case IMAGE_COMPAT_OTHER_BOARD:
		console_event("BT", "refused an upload: it is for %s, and this board is %s", found.board,
			      CONFIG_APP_BOARD_TYPE);
		upload_refused(BT_STATUS_REFUSAL_INCOMPATIBLE_BOARD);
		break;
	case IMAGE_COMPAT_OTHER_LAYOUT:
		console_event("BT", "refused an upload: it is for flash layout %u, and this board has %u",
			      (unsigned int)found.layout, (unsigned int)CONFIG_APP_IMAGE_LAYOUT);
		upload_refused(BT_STATUS_REFUSAL_INCOMPATIBLE_LAYOUT);
		break;
	default:
		console_event("BT", "refused an upload: its signed metadata is malformed");
		upload_refused(BT_STATUS_REFUSAL_MALFORMED);
		break;
	}
	NOTE_TROUBLE();
	return false;
}

static enum mgmt_cb_return on_upload(uint32_t event, enum mgmt_cb_return prev_status, int32_t *rc,
				     uint16_t *group, bool *abort_more, void *data,
				     size_t data_size)
{
	ARG_UNUSED(prev_status);
	ARG_UNUSED(group);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data_size);

	if (event == MGMT_EVT_OP_IMG_MGMT_DFU_PENDING) {
		/* Nothing more goes in from here on, ahead of the main loop's next look. */
		(void)atomic_and(&gate, ~GATE_UPLOADS);
		(void)atomic_set(&upload_done, 1);
		return MGMT_CB_OK;
	}

	const struct img_mgmt_upload_check *check = data;

	/*
	 * Again, with img_mgmt's lock held this time. A piece that got past on_command() as a
	 * window shut stops here, and close_window() waits for that lock.
	 */
	if ((atomic_get(&gate) & GATE_UPLOADS) == 0) {
		*rc = MGMT_ERR_EACCESSDENIED;
		return MGMT_CB_ERROR_RC;
	}

	if (check->req->off == 0) {
		enum bt_ota_upload verdict = bt_ota_check_upload(
			check->req->img_data.value, check->req->img_data.len, check->action->size,
			check->req->image, fw_version_running(), MAX_UPLOAD);
		struct image_compat_header header;

		if (verdict == BT_OTA_UPLOAD_OK &&
		    image_compat_parse_header(check->req->img_data.value, check->req->img_data.len,
					      &header) != 0) {
			verdict = BT_OTA_UPLOAD_NO_HEADER;
		}

		upload_header_seen(check->req->img_data.value, check->req->img_data.len,
				   check->action->size);
		(void)atomic_set(&upload_bytes, 0);

		if (verdict != BT_OTA_UPLOAD_OK) {
			console_event("BT", "refused an upload: %s", bt_ota_upload_text(verdict));
			upload_refused(bt_ota_status_refusal(verdict));
			NOTE_TROUBLE();
			*rc = MGMT_ERR_EBADSTATE;
			return MGMT_CB_ERROR_RC;
		}

		upload_compat.protected_at = (uint64_t)header.header_size + header.image_size;
		upload_compat.judged = false;
		image_compat_begin(&upload_compat.reader, header.protected_size);
		(void)atomic_set(&upload_state, BT_STATUS_IMAGE_RECEIVING);
		console_event("BT", "upload started, %u bytes", (unsigned int)check->action->size);
	}

	if (!upload_compat_ok(check->req->off, check->req->img_data.value,
			      check->req->img_data.len)) {
		*rc = MGMT_ERR_EBADSTATE;
		return MGMT_CB_ERROR_RC;
	}

	(void)atomic_set(&upload_bytes, (atomic_val_t)(check->req->off + check->req->img_data.len));
	return MGMT_CB_OK;
}

static struct mgmt_callback command_hook = {
	.callback = on_command,
	.event_id = MGMT_EVT_OP_CMD_RECV | MGMT_EVT_OP_CMD_DONE,
};

static struct mgmt_callback upload_hook = {
	.callback = on_upload,
	.event_id = MGMT_EVT_OP_IMG_MGMT_DFU_CHUNK | MGMT_EVT_OP_IMG_MGMT_DFU_PENDING,
};

/* From before anything can connect, so that nothing ever goes through MCUmgr without them. */
static int register_hooks(void)
{
	mgmt_callback_register(&command_hook);
	mgmt_callback_register(&upload_hook);
	return 0;
}

SYS_INIT(register_hooks, APPLICATION, CONFIG_APPLICATION_INIT_PRIORITY);

static void on_connected(struct bt_conn *conn, uint8_t err)
{
	atomic_val_t now = atomic_get(&gate);

	if (err != 0) {
		return;
	}

	/* After a restart: the status, and nothing else. No security is asked for, and none given. */
	if ((now & GATE_OPEN) == 0 && (now & GATE_STATUS) != 0) {
		(void)atomic_set(&secure, 0);
		(void)atomic_set(&status_link, 1);
		(void)atomic_set(&connected, 1);
		tell_main_loop(SAY_STATUS);
		return;
	}

	if ((now & GATE_OPEN) == 0) {
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		return;
	}

	(void)atomic_set(&secure, 0);
	(void)atomic_set(&status_link, 0);
	(void)atomic_set(&connected, 1);
	tell_main_loop(SAY_CONNECTED);

	/* Ask for pairing at once: nothing else on this link works without it. */
	if (bt_conn_set_security(conn, BT_SECURITY_L4) != 0) {
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
	}
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(conn);

	(void)atomic_set(&secure, 0);
	(void)atomic_set(&connected, 0);
	(void)atomic_set(&status_link, 0);
	/* A proof takes one link from start to finish. */
	(void)atomic_set(&list_reads, 0);
	(void)atomic_set(&gone_reason, reason);
	tell_main_loop(SAY_GONE);
}

static void on_security_changed(struct bt_conn *conn, bt_security_t level, enum bt_security_err err)
{
	struct bt_conn_info info;

	if (err == BT_SECURITY_ERR_SUCCESS && level >= BT_SECURITY_L4 &&
	    (atomic_get(&gate) & GATE_OPEN) != 0 && atomic_get(&status_link) == 0 &&
	    bt_conn_get_info(conn, &info) == 0 &&
	    (info.security.flags & BT_SECURITY_FLAG_SC) != 0 &&
	    info.security.enc_key_size == KEY_SIZE_REQUIRED) {
		(void)atomic_set(&secure, 1);
		tell_main_loop(SAY_PAIRED);
		return;
	}

	/* What the host would not allow anyway. Refused here too, because this is the point. */
	(void)atomic_set(&secure, 0);
	(void)atomic_set(&refused_security, (atomic_val_t)(((uint32_t)level << 8) | (uint8_t)err));
	tell_main_loop(SAY_REFUSED);
	(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
}

static void on_le_param_updated(struct bt_conn *conn, uint16_t interval, uint16_t latency,
				uint16_t timeout)
{
	ARG_UNUSED(conn);

	(void)atomic_set(&link_params, (atomic_val_t)(((uint32_t)interval << 16) | timeout));
	(void)atomic_set(&link_latency, latency);
	tell_main_loop(SAY_PARAMS);
}

static void on_le_phy_updated(struct bt_conn *conn, struct bt_conn_le_phy_info *param)
{
	ARG_UNUSED(conn);

	(void)atomic_set(&link_phy, (atomic_val_t)(((uint32_t)param->tx_phy << 8) | param->rx_phy));
	tell_main_loop(SAY_PHY);
}

static void on_le_data_len_updated(struct bt_conn *conn, struct bt_conn_le_data_len_info *info)
{
	ARG_UNUSED(conn);

	(void)atomic_set(&link_data_len,
			 (atomic_val_t)(((uint32_t)info->tx_max_len << 16) | info->rx_max_len));
	tell_main_loop(SAY_DATA_LEN);
}

BT_CONN_CB_DEFINE(connection_callbacks) = {
	.connected = on_connected,
	.disconnected = on_disconnected,
	.security_changed = on_security_changed,
	.le_param_updated = on_le_param_updated,
	.le_phy_updated = on_le_phy_updated,
	.le_data_len_updated = on_le_data_len_updated,
};

static enum bt_security_err on_pairing_accept(struct bt_conn *conn,
					      const struct bt_conn_pairing_feat *const feat)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(feat);

	/* A link made for the status alone never pairs, also in a window that opened meanwhile. */
	return (atomic_get(&gate) & GATE_OPEN) != 0 && atomic_get(&status_link) == 0
		       ? BT_SECURITY_ERR_SUCCESS
		       : BT_SECURITY_ERR_PAIR_NOT_ALLOWED;
}

#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
/*
 * The board's own passkey, from protected storage, while it may be used: see bt_passkey.h. Otherwise
 * the host draws a new one, as it does on a board with a cloud. Called before on_passkey_display().
 */
static uint32_t on_app_passkey(struct bt_conn *conn)
{
	uint32_t passkey = bt_passkey_for_pairing((uint32_t)atomic_get(&failed_pairings));

	ARG_UNUSED(conn);

	(void)atomic_set(&own_passkey, passkey != BT_PASSKEY_NONE);
	return passkey;
}
#endif

/* A new one for every attempt, which the host draws, unless it is the board's own. */
static void on_passkey_display(struct bt_conn *conn, unsigned int passkey)
{
	ARG_UNUSED(conn);

#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	/* The board's own passkey is a secret that lasts: it is never printed, nor kept to be printed. */
	if (atomic_get(&own_passkey) != 0) {
		tell_main_loop(SAY_OWN_KEY);
		return;
	}
#endif

	(void)atomic_set(&passkey_to_say, (atomic_val_t)passkey + 1);
	tell_main_loop(0);
}

static void on_auth_cancel(struct bt_conn *conn)
{
	ARG_UNUSED(conn);

	tell_main_loop(SAY_CANCELLED);
}

static void on_pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
{
	ARG_UNUSED(conn);

#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	/* A wrong passkey: the one failure that gives bits of a passkey away. Counted at once. */
	if (reason == BT_SECURITY_ERR_AUTH_FAIL && atomic_get(&own_passkey) != 0) {
		bt_passkey_count_failure();
	}
#endif
	NOTE_TROUBLE();
	(void)atomic_inc(&failed_pairings);
	(void)atomic_set(&failure_reason, (atomic_val_t)reason);
	tell_main_loop(SAY_FAILED);
}

static const struct bt_conn_auth_cb auth_callbacks = {
	.pairing_accept = on_pairing_accept,
	.passkey_display = on_passkey_display,
	.cancel = on_auth_cancel,
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	.app_passkey = on_app_passkey,
#endif
};

static struct bt_conn_auth_info_cb auth_info_callbacks = {
	.pairing_failed = on_pairing_failed,
};

/* On the system work queue, when the controller has answered. */
static void on_bt_ready(int err)
{
	(void)atomic_set(err != 0 ? &start_failed : &ready, 1);
}

/* ---- the status characteristic ---------------------------------------------------------- */

/* On the Bluetooth host's thread. Any phone that is connected may read it: nothing in it is secret. */
static ssize_t read_status(struct bt_conn *conn, const struct bt_gatt_attr *attr, void *buf,
			   uint16_t len, uint16_t offset)
{
	uint8_t copy[BT_STATUS_LEN];
	k_spinlock_key_t key = k_spin_lock(&status_lock);

	memcpy(copy, status_payload, sizeof(copy));
	k_spin_unlock(&status_lock, key);
	return bt_gatt_attr_read(conn, attr, buf, len, offset, copy, sizeof(copy));
}

static void on_status_subscribed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	if (value == BT_GATT_CCC_NOTIFY) {
		tell_main_loop(SAY_SUBSCRIBED);
	}
}

/*
 * A service of its own: the SMP service is MCUmgr's, and its one characteristic needs an
 * authenticated link. Reading this one, and asking for its notifications, needs none.
 */
BT_GATT_SERVICE_DEFINE(status_service,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_DECLARE_128(BT_STATUS_SERVICE_UUID_VAL)),
	BT_GATT_CHARACTERISTIC(BT_UUID_DECLARE_128(BT_STATUS_CHAR_UUID_VAL),
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY, BT_GATT_PERM_READ, read_status,
			       NULL, NULL),
	BT_GATT_CCC(on_status_subscribed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

#define STATUS_VALUE (&status_service.attrs[2])

static void on_status_sent(struct bt_conn *conn, void *user_data)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(user_data);

	k_sem_give(&status_sent);
}

/* ---- the main loop's side ---------------------------------------------------------- */

static void apply(uint32_t actions);

/*
 * The passkey also goes into the device shadow while the board is online, with the name it
 * advertises, so that a release manager's phone app can show it (docs/mobile-apps.md). The cloud
 * hands it only to release managers, records each time it does, and only within 150 s of the
 * report. Nothing more goes on the air than before: the name already does, and the passkey never.
 * An offline board has the console only, as before.
 */
#if !defined(CONFIG_APP_BT_ONLY)
static void report_pairing(unsigned int passkey)
{
	char json[80];

	if (!cloud_is_connected()) {
		return;
	}

	if (snprintk(json, sizeof(json), "{\"btpair\":{\"name\":\"%s\",\"passkey\":\"%06u\"}}", name,
		     passkey) >= (int)sizeof(json)) {
		return;
	}

	if (cloud_shadow_report(json) == 0) {
		pairing_reported = true;
	}
}

/* A passkey is good for one attempt: once that is over, it comes out of the shadow. */
static void unreport_pairing(void)
{
	if (pairing_reported && cloud_is_connected() &&
	    cloud_shadow_report("{\"btpair\":null}") == 0) {
		pairing_reported = false;
	}
}
#else
/* No cloud and no shadow: the passkey is the board's own, and the console has it already. */
static void report_pairing(unsigned int passkey)
{
	ARG_UNUSED(passkey);
}

static void unreport_pairing(void)
{
}
#endif

static const char *phy_name(uint32_t phy)
{
	switch (phy) {
	case BT_GAP_LE_PHY_1M:
		return "1M";
	case BT_GAP_LE_PHY_2M:
		return "2M";
	case BT_GAP_LE_PHY_CODED:
		return "coded";
	default:
		return "unknown";
	}
}

/* The reasons a link ends that a person can act on, in words. */
static const char *gone_reason_text(uint8_t reason)
{
	switch (reason) {
	case BT_HCI_ERR_AUTH_FAIL:
		return " (pairing or security failed)";
	case BT_HCI_ERR_CONN_TIMEOUT:
		return " (the phone went out of range)";
	case BT_HCI_ERR_REMOTE_USER_TERM_CONN:
		return " (the phone closed the link)";
	case BT_HCI_ERR_LOCALHOST_TERM_CONN:
		return " (this board closed the link)";
	case BT_HCI_ERR_LL_RESP_TIMEOUT:
		return " (a link-layer exchange got no answer within 40 s)";
	case BT_HCI_ERR_TERM_DUE_TO_MIC_FAIL:
		return " (an encrypted packet failed its check)";
	default:
		return "";
	}
}

/* A phone asked for the status's notifications since the last one went out. */
static bool status_subscriber_new;

static void say_what_happened(void)
{
	atomic_val_t what = atomic_set(&to_say, 0);
	atomic_val_t passkey = atomic_set(&passkey_to_say, 0);

	if (what & SAY_CONNECTED) {
		console_event("BT", "a phone connected");
	}

	if (what & SAY_STATUS) {
		console_event("BT", "a phone connected to read the status, with no pairing");
	}

	if (what & SAY_SUBSCRIBED) {
		status_subscriber_new = true;
	}

	if (passkey != 0) {
		console_event("BT", "passkey %06u", (unsigned int)(passkey - 1));
		report_pairing((unsigned int)(passkey - 1));
	}

#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	if (what & SAY_OWN_KEY) {
		console_event("BT", "pairing with the board's own passkey, which the console has: it is "
				    "never shown here");
	}
#endif

	if (what & SAY_PAIRED) {
		console_event("BT", "paired: LE Secure Connections, authenticated");
	}

	if (what & SAY_CANCELLED) {
		console_event("BT", "pairing cancelled");
	}

	if (what & SAY_FAILED) {
		console_event("BT", "pairing failed: %d", (int)atomic_get(&failure_reason));
	}

	if (what & (SAY_PAIRED | SAY_CANCELLED | SAY_FAILED | SAY_GONE)) {
		unreport_pairing();
	}

	if (what & SAY_REFUSED) {
		uint32_t refused = (uint32_t)atomic_get(&refused_security);

		console_event("BT", "security not accepted: level %u, error %u", refused >> 8,
			      refused & 0xffU);
	}

	if (what & SAY_PARAMS) {
		uint32_t params = (uint32_t)atomic_get(&link_params);
		uint32_t interval_us = (params >> 16) * 1250U;

		console_event("BT", "link: interval %u.%02u ms, latency %u, timeout %u ms",
			      interval_us / 1000U, (interval_us % 1000U) / 10U,
			      (unsigned int)atomic_get(&link_latency), (params & 0xffffU) * 10U);
	}

	if (what & SAY_PHY) {
		uint32_t phy = (uint32_t)atomic_get(&link_phy);

		console_event("BT", "link: PHY %s out, %s in", phy_name(phy >> 8), phy_name(phy & 0xffU));
	}

	if (what & SAY_DATA_LEN) {
		uint32_t len = (uint32_t)atomic_get(&link_data_len);

		console_event("BT", "link: packets up to %u bytes out, %u in", len >> 16, len & 0xffffU);
	}

	if (what & SAY_GONE) {
		uint8_t reason = (uint8_t)atomic_get(&gone_reason);

		console_event("BT", "the phone is gone: reason 0x%02x%s", (unsigned int)reason,
			      gone_reason_text(reason));
	}
}

static void save_record(void)
{
	report_waiting = true;
	if (store_write(STORE_BT_OTA_RECORD, &record, sizeof(record)) != 0) {
		LOG_ERR("The record of this update could not be stored");
	}
}

static void say_record(const char *what)
{
	char from[FW_VERSION_STRING_MAX];
	char target[FW_VERSION_STRING_MAX];

	(void)fw_version_to_string(&record.from, from, sizeof(from));
	(void)fw_version_to_string(&record.target, target, sizeof(target));
	console_event("BT", "%s: %s from %s, %s, proof %s, update %u of this board", what, target,
		      from, bt_ota_result_text((enum bt_ota_result)record.result),
		      bt_ota_proof_by_text((enum bt_ota_proof_by)record.proof),
		      (unsigned int)record.count);
}

static void finish_record(enum bt_ota_result result, enum bt_ota_proof_by proof)
{
	/* What a person at the board should know about: an image that did not stay. */
	if (result != BT_OTA_RESULT_SUCCEEDED && result != BT_OTA_RESULT_SUPERSEDED) {
		NOTE_TROUBLE();
	}

	record.phase = BT_OTA_RECORD_DONE;
	record.result = result;
	record.proof = proof;
	save_record();
	say_record("update over Bluetooth");
}

static void decide_on_boot(bool on_trial, bool has_trailer, bool job_record);

void bt_ota_on_boot(bool on_trial, bool has_trailer, bool job_record)
{
	uint8_t phase_found;

	if (store_read(STORE_BT_OTA_RECORD, &record, sizeof(record)) != 0 ||
	    record.magic != BT_OTA_RECORD_MAGIC) {
		memset(&record, 0, sizeof(record));
		return;
	}

	phase_found = record.phase;
	decide_on_boot(on_trial, has_trailer, job_record);

	/* Bluetooth starts on a tick, once Wi-Fi and TLS have what they need: see bt_ota_on_tick(). */
	status_due = bt_ota_status_due(phase_found, record.result);
}

/* What became of the update that the record was about, if it was still under way. */
static void decide_on_boot(bool on_trial, bool has_trailer, bool job_record)
{
	have_record = true;
	report_waiting = true;

	if (record.phase == BT_OTA_RECORD_DONE) {
		say_record("last update over Bluetooth");
		return;
	}

	if (job_record) {
		finish_record(BT_OTA_RESULT_SUPERSEDED, BT_OTA_PROOF_BY_NONE);
		return;
	}

	switch (ota_restart_outcome(fw_version_compare(&record.target, fw_version_running()) == 0,
				    on_trial, has_trailer, record.phase == BT_OTA_RECORD_TESTING)) {
	case OTA_RESTART_ON_TRIAL:
		record.phase = BT_OTA_RECORD_TESTING;
		save_record();
		bluetooth_trial = true;
		say_record("on trial");
#if defined(CONFIG_APP_BT_ONLY)
		console_event("BT", "to keep it, once it has run %d s, hold Button 1, pair, and read the "
				    "image list: otherwise it reverts at %d s",
			      CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS, CONFIG_APP_OTA_SELF_TEST_TIMEOUT_SECONDS);
#else
		console_event("BT", "kept when it reaches the cloud; with no Wi-Fi in reach, hold "
				    "Button 1, pair, and read the image list");
#endif
		break;
	case OTA_RESTART_CONFIRMED:
		/* Confirmed, and restarted before this could be written. By whom is not known. */
		finish_record(BT_OTA_RESULT_SUCCEEDED, BT_OTA_PROOF_BY_NONE);
		break;
	case OTA_RESTART_TRIAL_LOST:
		finish_record(BT_OTA_RESULT_TRIAL_LOST, BT_OTA_PROOF_BY_NONE);
		break;
	case OTA_RESTART_ROLLED_BACK:
		finish_record(BT_OTA_RESULT_ROLLED_BACK, BT_OTA_PROOF_BY_NONE);
		break;
	default:
		finish_record(BT_OTA_RESULT_NOT_INSTALLED, BT_OTA_PROOF_BY_NONE);
		break;
	}
}

static bool provisioned(void)
{
#if defined(CONFIG_APP_BT_ONLY)
	/* Nothing of the cloud to set up on a board with Bluetooth only: out of factory mode, it has its ID. */
	return !device_is_factory();
#else
	return identity_settings_get() != NULL && net_has_credentials();
#endif
}

/* For a proof: the image can read what TF-M keeps for it. On a board with a cloud, provisioned() says. */
static bool storage_readable(void)
{
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	return bt_passkey_state() != BT_PASSKEY_STATE_UNREADABLE;
#else
	return true;
#endif
}

/* Bluetooth stays off until the first window. A controller that is not there costs two seconds. */
static int start_bluetooth(void)
{
	int err;

	if (enabled) {
		return 0;
	}

#if !defined(CONFIG_APP_BT_ONLY)
	if (!gpio_is_ready_dt(&antenna_switch) ||
	    gpio_pin_configure_dt(&antenna_switch, GPIO_OUTPUT_INACTIVE) != 0) {
		LOG_WRN("The antenna switch could not be set");
	}
#endif

	err = bt_conn_auth_cb_register(&auth_callbacks);
	if (err == 0) {
		err = bt_conn_auth_info_cb_register(&auth_info_callbacks);
	}
	if (err == 0) {
		err = bt_enable(on_bt_ready);
	}

	if (err != 0) {
		/* bt_enable() cannot be called again after this. */
		console_event("BT", "Bluetooth could not start: %d", err);
		controller_failed = true;
		return err;
	}

	enabled = true;
	return 0;
}

static void reset_link_state(void)
{
	(void)atomic_set(&failed_pairings, 0);
	(void)atomic_set(&commands, 0);
	(void)atomic_set(&list_reads, 0);
	(void)atomic_set(&upload_done, 0);
	(void)atomic_set(&upload_state, 0);
	(void)atomic_set(&upload_bytes, 0);
	(void)atomic_set(&upload_total, 0);
	(void)atomic_set(&upload_version, 0);
	(void)atomic_set(&upload_build, 0);
}

/* ---- the status, on the main loop -------------------------------------------------------- */

static enum bt_status_swap swap_now(void)
{
	switch (mcuboot_swap_type_multi(0)) {
	case BOOT_SWAP_TYPE_TEST:
		return BT_STATUS_SWAP_TEST;
	case BOOT_SWAP_TYPE_PERM:
		return BT_STATUS_SWAP_PERMANENT;
	case BOOT_SWAP_TYPE_REVERT:
		return BT_STATUS_SWAP_REVERT;
	case BOOT_SWAP_TYPE_FAIL:
		return BT_STATUS_SWAP_FAIL;
	default:
		return BT_STATUS_SWAP_NONE;
	}
}

/* What the threads that serve a phone have seen of the upload, while there can be one. */
static void take_upload(void)
{
	atomic_val_t state = atomic_get(&upload_state);
	uint32_t version = (uint32_t)atomic_get(&upload_version);

	if (state == 0) {
		return;
	}

	track.image = (enum bt_status_image)(state & 0xff);
	track.refusal = (enum bt_status_refusal)((uint32_t)state >> 8);
	if (track.image == BT_STATUS_IMAGE_RECEIVING && atomic_get(&upload_done) != 0) {
		track.image = BT_STATUS_IMAGE_RECEIVED;
	}
	track.bytes = (uint32_t)(track.image == BT_STATUS_IMAGE_RECEIVING ? atomic_get(&upload_bytes)
									    : atomic_get(&upload_total));
	track.version = (struct fw_version){
		.major = (uint8_t)version,
		.minor = (uint8_t)(version >> 8),
		.revision = (uint16_t)(version >> 16),
		.build = (uint32_t)atomic_get(&upload_build),
	};
}

static void collect_last_update(struct bt_status *status)
{
	struct fw_version cloud_target;
	enum bt_status_outcome cloud = ota_bt_cloud_update(&cloud_target);

	/* A cloud update that this boot knows of came after any update over Bluetooth. */
	if (cloud != BT_STATUS_OUTCOME_NONE) {
		status->last_via = BT_STATUS_VIA_WIFI;
		status->last_outcome = cloud;
		status->last_target = cloud_target;
		return;
	}

	if (!have_record) {
		return;
	}

	status->last_via = BT_STATUS_VIA_BLUETOOTH;
	status->last_outcome = bt_ota_status_outcome((enum bt_ota_result)record.result);
	status->last_proof = (enum bt_status_proof)record.proof;
	status->last_target = record.target;
	status->last_from = record.from;
	memcpy(status->last_hash, record.hash, sizeof(status->last_hash));
	status->last_count = (uint16_t)MIN(record.count, UINT16_MAX);
}

static void collect_status(struct bt_status *status)
{
	memset(status, 0, sizeof(*status));

	switch (window.phase) {
	case BT_OTA_OPEN:
		status->window = BT_STATUS_WINDOW_OPEN;
		status->seconds_left = window.window_left;
		take_upload();
		break;
	case BT_OTA_LINKED:
		status->window = BT_STATUS_WINDOW_LINKED;
		status->seconds_left = window.window_left;
		take_upload();
		break;
	case BT_OTA_READY:
		status->window = BT_STATUS_WINDOW_OFFER;
		status->seconds_left = window.offer_left;
		break;
	default:
		if (status_window.open) {
			status->window = BT_STATUS_WINDOW_STATUS;
			status->seconds_left = status_window.left;
		}
		break;
	}

	status->image = track.image;
	status->refusal = track.refusal;
	status->image_bytes = track.bytes;
	status->image_version = track.version;
	status->result = track.result;
	status->closed = track.closed;
	status->running = *fw_version_running();
	status->on_trial = ota_state() == OTA_TESTING;
	status->swap = swap_now();
	collect_last_update(status);
	status->uptime_seconds = (uint32_t)(k_uptime_get() / MSEC_PER_SEC);
}

struct status_notification {
	const uint8_t *payload;
	int sent;
	int failed;
};

/* A phone that asked for it, on a link that can carry all of it. One that cannot reads it instead. */
static void notify_one(struct bt_conn *conn, void *data)
{
	struct status_notification *notification = data;
	struct bt_gatt_notify_params params = {
		.attr = STATUS_VALUE,
		.data = notification->payload,
		.len = BT_STATUS_LEN,
		.func = on_status_sent,
	};

	if (!bt_gatt_is_subscribed(conn, STATUS_VALUE, BT_GATT_CCC_NOTIFY) ||
	    bt_gatt_get_mtu(conn) < BT_STATUS_LEN + 3) {
		return;
	}

	if (bt_gatt_notify_cb(conn, &params) == 0) {
		notification->sent++;
	} else {
		notification->failed++;
	}
}

/*
 * The status as it is now, for the next phone that reads it, and to the phone that asked for
 * notifications whenever something in it has changed, or every STATUS_REFRESH_MS for what counts
 * by itself. wait: until it has gone out, for STATUS_SENT_MS at most, before the link closes.
 */
static void refresh_status(bool wait)
{
	struct status_notification notification = { 0 };
	uint8_t now[BT_STATUS_LEN];
	struct bt_status status;
	k_spinlock_key_t key;

	/* Nothing can read it before Bluetooth has started. */
	if (!enabled) {
		return;
	}

	collect_status(&status);
	bt_status_encode(&status, now);

	key = k_spin_lock(&status_lock);
	memcpy(status_payload, now, sizeof(now));
	k_spin_unlock(&status_lock, key);

	if (!wait && !status_subscriber_new && !bt_status_news(now, status_told) &&
	    k_uptime_get() - status_told_at < STATUS_REFRESH_MS) {
		return;
	}

	(void)k_sem_take(&status_sent, K_NO_WAIT);
	notification.payload = now;
	if (atomic_get(&connected) != 0) {
		bt_conn_foreach(BT_CONN_TYPE_LE, notify_one, &notification);
	}

	/* Out of buffers for now: the next tick tries again. */
	if (notification.failed > 0) {
		return;
	}

	status_subscriber_new = false;
	memcpy(status_told, now, sizeof(now));
	status_told_at = k_uptime_get();

	if (wait && notification.sent > 0) {
		(void)k_sem_take(&status_sent, K_MSEC(STATUS_SENT_MS));
	}
}

static void disconnect_one(struct bt_conn *conn, void *data)
{
	ARG_UNUSED(data);

	(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
}

/* Whether the policy closed it or a window is about to open. The gate says that it was open. */
static void close_status_window(void)
{
	if ((atomic_get(&gate) & GATE_STATUS) == 0) {
		return;
	}

	status_window.open = false;
	(void)atomic_and(&gate, ~GATE_STATUS);
	if (atomic_get(&ready)) {
		(void)bt_le_adv_stop();
	}
	if (atomic_get(&status_link) != 0) {
		bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);
	}
	console_event("BT", "status no longer advertised");
}

static void open_window(bool proof_only)
{
	if (start_bluetooth() != 0) {
		console_event("BT", "%s", bt_ota_open_text(BT_OTA_REFUSED_NO_CONTROLLER));
		return;
	}

	/*
	 * A phone that came for the status goes, and cannot pair in this window: see status_link. A
	 * person who opened one before the status was advertised has no need of it any more.
	 */
	status_due = false;
	close_status_window();
	reset_link_state();
	memset(&track, 0, sizeof(track));
	name[0] = '\0';
	last_proof = BT_OTA_PROVED;
	bt_ota_window_open(&window, proof_only, CONFIG_APP_BT_OTA_WINDOW_SECONDS);
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	/* Before the gate opens: a pairing may come as soon as it has. */
	bt_passkey_window_open();
#endif

	if (proof_only) {
		atomic_set(&gate, GATE_OPEN);
	} else {
		ota_bt_enter();
		atomic_set(&gate, GATE_OPEN | GATE_UPLOADS);
	}

	console_event("BT", "open for %d s%s", CONFIG_APP_BT_OTA_WINDOW_SECONDS,
		      proof_only ? ", to prove the image on trial" : "");
	refresh_status(false);
}

/*
 * The restart that an update over Bluetooth asked for is over, one way or the other: the board is
 * connectable for BT_OTA_STATUS_SECONDS, for the status alone.
 */
static void open_status_window(void)
{
	if (start_bluetooth() != 0) {
		return;
	}

	reset_link_state();
	memset(&track, 0, sizeof(track));
	name[0] = '\0';
	bt_ota_status_open(&status_window);
	(void)atomic_or(&gate, GATE_STATUS);
	console_event("BT", "status advertised for %d s after the update over Bluetooth: a phone can "
			    "read how it went, with no pairing, and do nothing else",
		      BT_OTA_STATUS_SECONDS);
	refresh_status(false);
}

static const struct bt_data advertised[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, SMP_BT_SVC_UUID_VAL),
};

/* After a restart: the status service, so that the phones' scan for boards to update leaves it out. */
static const struct bt_data advertised_status[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_STATUS_SERVICE_UUID_VAL),
};

static void advertise(void)
{
	bool status_only = window.phase == BT_OTA_CLOSED;
	struct bt_data sd[1];
	uint16_t tag = 0;
	int err;

	if (!atomic_get(&ready) || atomic_get(&connected)) {
		return;
	}

	/*
	 * Not the board's name in the cloud: nothing that identifies it there goes on the air. A board
	 * with a passkey of its own has a name of its own as well, the one the console knows its passkey
	 * by, so that a phone knows which passkey to ask for: see bt_passkey.h.
	 */
	if (name[0] == '\0') {
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
		if (bt_passkey_tag(&tag)) {
			(void)bt_passkey_name(tag, CONFIG_BT_DEVICE_NAME, name, sizeof(name));
		} else
#endif
		{
			(void)bt_rand(&tag, sizeof(tag));
			(void)snprintk(name, sizeof(name), "%s-%04X", CONFIG_BT_DEVICE_NAME, tag);
		}
		console_event("BT", "advertising as %s", name);
	}

	sd[0].type = BT_DATA_NAME_COMPLETE;
	sd[0].data_len = (uint8_t)strlen(name);
	sd[0].data = (const uint8_t *)name;

	/* Already running, or the last link's connection object is not free yet: next tick. */
	err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, status_only ? advertised_status : advertised,
			      status_only ? ARRAY_SIZE(advertised_status) : ARRAY_SIZE(advertised), sd,
			      ARRAY_SIZE(sd));
	if (err != 0 && err != -EALREADY && err != -ENOMEM) {
		LOG_WRN("Advertising did not start: %d", err);
	}
}

static void discard_image(void)
{
	int err = boot_erase_img_bank(SECONDARY_SLOT_ID);

	if (err != 0) {
		LOG_WRN("The secondary slot could not be erased: %d", err);
	}
}

static void close_window(bool discard)
{
	/* The gate first: nothing new gets in from here on. */
	atomic_set(&gate, 0);
	atomic_set(&secure, 0);
	if (atomic_get(&ready)) {
		(void)bt_le_adv_stop();
	}

	/*
	 * Or a later upload of the same file would carry on where this one stopped. This takes
	 * img_mgmt's lock, so it waits for a piece that is being written: after it nothing more
	 * arrives, and upload_done is the last word on whether the whole image got there. In a
	 * proof window nothing can have arrived, and the slot holds the image to go back to.
	 */
	img_mgmt_reset_upload();

	if (discard || (atomic_get(&upload_done) && !window.proof_only)) {
		discard_image();
		atomic_set(&upload_done, 0);
	}

	/* After the gate has shut: nothing can pair from here on. */
#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	bt_passkey_window_close();
#endif

	console_event("BT", "closed: %s", bt_ota_closed_text(window.closed));

	/* The phone hears how it ended before its link goes. */
	track.result = bt_ota_status_result(window.closed, discard,
					    track.image == BT_STATUS_IMAGE_REFUSED);
	track.closed = (uint8_t)(window.closed + 1);
	refresh_status(true);
	bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);

	unreport_pairing();
	ota_bt_leave();
}

/* What arrived is refused, for the status. */
static void refuse(enum bt_status_refusal refusal)
{
	track.image = BT_STATUS_IMAGE_REFUSED;
	track.refusal = refusal;
}

/*
 * The image in the slot against this board, from flash (image_compat.h), right before it is
 * offered and right before it is marked. One for another board type or flash layout ends the
 * update with that as its result, in the record, and the window closes, which erases it.
 */
static bool slot_compatible(const struct fw_version *target, const uint8_t *hash)
{
	struct image_compat found;
	enum image_compat_verdict verdict = image_compat_check_slot(SECONDARY_SLOT_ID, &found);

	if (verdict == IMAGE_COMPAT_OK) {
		return true;
	}

	if (verdict != IMAGE_COMPAT_OTHER_BOARD && verdict != IMAGE_COMPAT_OTHER_LAYOUT) {
		console_event("BT", "what arrived cannot be installed");
		NOTE_TROUBLE();
		refuse(BT_STATUS_REFUSAL_MALFORMED);
		apply(bt_ota_window_offer_failed(&window));
		return false;
	}

	refuse(verdict == IMAGE_COMPAT_OTHER_BOARD ? BT_STATUS_REFUSAL_INCOMPATIBLE_BOARD
						   : BT_STATUS_REFUSAL_INCOMPATIBLE_LAYOUT);
	if (verdict == IMAGE_COMPAT_OTHER_BOARD) {
		console_event("BT", "refused the image: it is for %s, and this board is %s", found.board,
			      CONFIG_APP_BOARD_TYPE);
	} else {
		console_event("BT", "refused the image: it is for flash layout %u, and this board has %u",
			      (unsigned int)found.layout, (unsigned int)CONFIG_APP_IMAGE_LAYOUT);
	}
	LOG_ERR("Update over Bluetooth refused: %s", image_compat_reason(verdict));

	record.magic = BT_OTA_RECORD_MAGIC;
	record.count++;
	record.from = *fw_version_running();
	record.target = *target;
	memcpy(record.hash, hash, sizeof(record.hash));
	have_record = true;
	finish_record(verdict == IMAGE_COMPAT_OTHER_BOARD ? BT_OTA_RESULT_INCOMPATIBLE_BOARD
							  : BT_OTA_RESULT_INCOMPATIBLE_LAYOUT,
		      BT_OTA_PROOF_BY_NONE);
	apply(bt_ota_window_offer_failed(&window));
	return false;
}

static void offer_image(void)
{
	struct mcuboot_img_header header;
	uint8_t hash[IMAGE_SHA_LEN] = { 0 };
	struct image_version version;
	struct fw_version target = { 0 };
	bool header_read = boot_read_bank_header(SECONDARY_SLOT_ID, &header, sizeof(header)) == 0 &&
			   header.mcuboot_version == 1 &&
			   img_mgmt_read_info(SECONDARY_SLOT, &version, hash, NULL) == 0;
	char text[FW_VERSION_STRING_MAX];

	(void)bt_le_adv_stop();

	if (header_read) {
		target.major = header.h.v1.sem_ver.major;
		target.minor = header.h.v1.sem_ver.minor;
		target.revision = header.h.v1.sem_ver.revision;
		target.build = header.h.v1.sem_ver.build_num;
	}

	track.image = BT_STATUS_IMAGE_RECEIVED;
	track.bytes = (uint32_t)atomic_get(&upload_total);
	if (header_read) {
		track.version = target;
	}

	if (!bt_ota_offer_ok(header_read, &target, fw_version_running(),
			     mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE)) {
		console_event("BT", "what arrived cannot be installed");
		NOTE_TROUBLE();
		refuse(!header_read ? BT_STATUS_REFUSAL_MALFORMED
		       : mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE ? BT_STATUS_REFUSAL_SWAP_PENDING
									    : BT_STATUS_REFUSAL_OLDER);
		apply(bt_ota_window_offer_failed(&window));
		return;
	}

	if (!slot_compatible(&target, hash)) {
		return;
	}

	track.image = BT_STATUS_IMAGE_VERIFIED;

	memset(&offered, 0, sizeof(offered));
	offered.magic = BT_OTA_RECORD_MAGIC;
	offered.phase = BT_OTA_RECORD_ARMED;
	offered.result = BT_OTA_RESULT_PENDING;
	offered.proof = BT_OTA_PROOF_BY_NONE;
	offered.count = record.count + 1;
	offered.from = *fw_version_running();
	offered.target = target;
	memcpy(offered.hash, hash, sizeof(offered.hash));

	(void)fw_version_to_string(&target, text, sizeof(text));
	console_event("BT",
		      "firmware %s has arrived, hash %02x%02x%02x%02x%02x%02x%02x%02x: press Button 1 "
		      "to install it, Button 2 to erase it",
		      text, hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]);
}

/* The way a cloud update ends: the record, then the swap, for a trial, then the restart. */
static void install_image(void)
{
	if (!slot_compatible(&offered.target, offered.hash)) {
		return;
	}

	/* A file long enough to bring a swap request of its own: see verify_download(). */
	if (mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE ||
	    store_write(STORE_BT_OTA_RECORD, &offered, sizeof(offered)) != 0) {
		console_event("BT", "the image could not be installed");
		NOTE_TROUBLE();
		refuse(mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE ? BT_STATUS_REFUSAL_SWAP_PENDING
									 : BT_STATUS_REFUSAL_CANNOT_INSTALL);
		apply(bt_ota_window_offer_failed(&window));
		return;
	}

	record = offered;
	have_record = true;

	if (boot_request_upgrade_multi(0, BOOT_UPGRADE_TEST) != 0) {
		finish_record(BT_OTA_RESULT_FLASH_ERROR, BT_OTA_PROOF_BY_NONE);
		refuse(BT_STATUS_REFUSAL_CANNOT_INSTALL);
		apply(bt_ota_window_offer_failed(&window));
		return;
	}

	/*
	 * Nothing more comes in. The phone hears that Button 1 was pressed, and the console gets the
	 * line and the board's last report before the restart: app_restart() waits for AWS IoT.
	 */
	atomic_set(&gate, 0);
	say_record("restarting into the bootloader");
	track.result = BT_STATUS_RESULT_INSTALLING;
	refresh_status(true);
	app_restart(MFLT_REBOOT_UPDATE);
}

static void close_proof_window(void)
{
	if (window.phase != BT_OTA_CLOSED) {
		window.phase = BT_OTA_CLOSED;
		window.closed = BT_OTA_CLOSED_TRIAL_OVER;
		close_window(false);
	}
}

void bt_ota_on_cloud_proof(void)
{
	if (bluetooth_trial) {
		bluetooth_trial = false;
		finish_record(BT_OTA_RESULT_SUCCEEDED, BT_OTA_PROOF_BY_CLOUD);
		close_proof_window();
	}
}

static void try_proof(void)
{
	const struct bt_ota_proof proof = {
		.uptime_seconds = (uint32_t)(k_uptime_get() / MSEC_PER_SEC),
		.min_seconds = CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS,
		.provisioned = provisioned() && storage_readable(),
#if defined(CONFIG_APP_BT_ONLY)
		/* No Wi-Fi to answer and no cloud to wait for: the person, the link and the time decide. */
		.no_wifi = true,
#else
		.wifi_up = net_is_up() || net_wifi_associated(),
		.wifi_answered = net_wifi_answered(),
#endif
		.link_secure = atomic_get(&secure) != 0,
		.list_reads = (uint32_t)atomic_get(&list_reads),
	};
	enum bt_ota_proof_result result = bt_ota_proof_check(&proof);

	if (result != last_proof && result != BT_OTA_PROVED) {
		console_event("BT", "trial: %s", bt_ota_proof_text(result));
	}
	last_proof = result;

	if (result == BT_OTA_PROVED && bluetooth_trial && ota_bt_confirm() == 0) {
		bluetooth_trial = false;
		finish_record(BT_OTA_RESULT_SUCCEEDED, BT_OTA_PROOF_BY_PERSON);
		close_proof_window();
	}
}

static void apply(uint32_t actions)
{
	if (actions & BT_OTA_DO_ADVERTISE) {
		advertise();
	}

	if (actions & BT_OTA_DO_DISCONNECT) {
		bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);
	}

	if (actions & BT_OTA_DO_OFFER) {
		offer_image();
	}

	if (actions & BT_OTA_DO_TRY_PROOF) {
		try_proof();
	}

	if (actions & BT_OTA_DO_INSTALL) {
		install_image();
	}

	if (actions & BT_OTA_DO_CLOSE) {
		close_window((actions & BT_OTA_DO_DISCARD) != 0);
	}
}

bool bt_ota_on_button(uint8_t button, bool long_press, bool physical)
{
	struct bt_ota_board board;
	enum bt_ota_open open;

	/* A command on the console is not a person. It stays out of this altogether. */
	if (!physical) {
		return false;
	}

	if (window.phase != BT_OTA_CLOSED) {
		apply(bt_ota_window_press(&window, button));
		refresh_status(false);
		return true;
	}

	/*
	 * Button 1 still does what it did for a cloud update on offer, however long it is held. Only
	 * a build with CONFIG_APP_OTA_REQUIRE_USER_CONSENT has offers.
	 */
	if (button != APP_BUTTON_1 || !long_press || ota_state() == OTA_AWAITING_USER) {
		return false;
	}

	board = (struct bt_ota_board){
		.controller_failed = controller_failed,
		.factory = device_is_factory(),
		.provisioned = provisioned(),
		.idle = ota_state() == OTA_IDLE,
		.testing = ota_state() == OTA_TESTING,
		.bluetooth_trial = bluetooth_trial,
		.job_record = ota_bt_has_job(),
		.swap_pending = mcuboot_swap_type_multi(0) != BOOT_SWAP_TYPE_NONE,
		/* A phone that came for the status never paired: open_window() lets it go. */
		.link_up = atomic_get(&connected) != 0 && atomic_get(&status_link) == 0,
#if defined(CONFIG_APP_BT_ONLY)
		.no_cloud = true,
#endif
	};
	open = bt_ota_may_open(&board);

	switch (open) {
	case BT_OTA_OPEN_UPLOAD:
		open_window(false);
		return true;
	case BT_OTA_OPEN_PROOF:
		open_window(true);
		return true;
	default:
		console_event("BT", "not opening: %s", bt_ota_open_text(open));
		return true;
	}
}

static void tick_status_window(void)
{
	uint32_t actions;

	/* Its time counts from the restart, also while the controller starts. */
	actions = bt_ota_status_tick(&status_window, atomic_get(&connected) != 0, bluetooth_trial);

	if ((actions & BT_OTA_STATUS_DO_ADVERTISE) && atomic_get(&ready)) {
		advertise();
	}

	if ((actions & BT_OTA_STATUS_DO_STOP) && atomic_get(&ready)) {
		(void)bt_le_adv_stop();
	}

	if (actions & BT_OTA_STATUS_DO_CLOSE) {
		/* Its last word first, as for a window: that it is closed. */
		refresh_status(true);
		close_status_window();
	}
}

void bt_ota_on_tick(void)
{
	struct bt_ota_link link;

	say_what_happened();

#if !defined(CONFIG_APP_BT_ONLY)
	if (report_waiting && have_record && cloud_is_connected()) {
		bt_ota_on_cloud_up();
	}
#endif

#if defined(CONFIG_APP_BT_STATIC_PASSKEY)
	/* A count of failures that has changed goes into storage, and the passkey may be locked by it. */
	if (bt_passkey_persist()) {
		NOTE_TROUBLE();
	}
#endif

	/* bt_enable() cannot be called again, so this stands until the next restart. */
	if (atomic_get(&start_failed) != 0 && !controller_failed) {
		controller_failed = true;
		NOTE_TROUBLE();
		console_event("BT", "%s", bt_ota_open_text(BT_OTA_REFUSED_NO_CONTROLLER));
		if (window.phase != BT_OTA_CLOSED) {
			apply(bt_ota_window_abort(&window));
		}
	}

	/* A board with Bluetooth only has no Wi-Fi or TLS to leave the heap to first: it starts at once. */
	if (status_due && window.phase == BT_OTA_CLOSED &&
	    bt_ota_status_may_start((uint32_t)(k_uptime_get() / MSEC_PER_SEC),
				    IS_ENABLED(CONFIG_APP_BT_ONLY) || cloud_is_connected())) {
		status_due = false;
		open_status_window();
	}

	if (window.phase == BT_OTA_CLOSED) {
#if defined(CONFIG_APP_BT_ONLY)
		/* A phone that came to read the status is on a link, though it never pairs. */
		link_view = status_window.open && atomic_get(&connected) != 0 ? BT_OTA_LINK_CONNECTED
									      : BT_OTA_LINK_NONE;
#endif
		if (status_window.open) {
			tick_status_window();
			refresh_status(false);
		} else if (atomic_get(&connected) != 0) {
			/* A disconnection can fail: a phone from a closed window does not get to stay. */
			bt_conn_foreach(BT_CONN_TYPE_LE, disconnect_one, NULL);
		}
		/* Otherwise nobody can read the status, and the slots' trailers are not read for it. */
		return;
	}

	link = (struct bt_ota_link){
		.connected = atomic_get(&connected) != 0,
		.secure = atomic_get(&secure) != 0,
		.failed_pairings = (uint32_t)atomic_get(&failed_pairings),
		.commands = (uint32_t)atomic_get(&commands),
		.list_reads = (uint32_t)atomic_get(&list_reads),
		.upload_done = atomic_get(&upload_done) != 0,
	};

#if defined(CONFIG_APP_BT_ONLY)
	/* Commands in the last second, in a window that takes an image: it is arriving. */
	if (!link.connected) {
		link_view = BT_OTA_LINK_NONE;
	} else if (link.secure && link.commands != commands_last_tick &&
		   (atomic_get(&gate) & GATE_UPLOADS) != 0) {
		link_view = BT_OTA_LINK_RECEIVING;
	} else {
		link_view = BT_OTA_LINK_CONNECTED;
	}
	commands_last_tick = link.commands;
#endif

	apply(bt_ota_window_tick(&window, &link));
	refresh_status(false);
}

#if !defined(CONFIG_APP_BT_ONLY)
void bt_ota_on_cloud_up(void)
{
	char json[192];

	if (!have_record || bt_ota_record_json(&record, json, sizeof(json)) < 0) {
		return;
	}

	if (cloud_shadow_report(json) == 0) {
		report_waiting = false;
	}
}
#endif

bool bt_ota_is_open(void)
{
	return window.phase != BT_OTA_CLOSED;
}

#if defined(CONFIG_APP_BT_ONLY)
enum bt_ota_link_view bt_ota_link_view(void)
{
	return link_view;
}

bool bt_ota_take_trouble(void)
{
	return atomic_set(&trouble, 0) != 0;
}
#endif

enum ui_state bt_ota_ui_state(void)
{
	switch (window.phase) {
	case BT_OTA_READY:
		return UI_UPDATE_OFFERED;
	case BT_OTA_LINKED:
		return UI_UPDATE_IN_PROGRESS;
	default:
		return UI_BT_WINDOW;
	}
}
