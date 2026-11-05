/*
 * Memfault on this board: see mflt.h and docs/memfault.md.
 *
 * The SDK keeps the coredump, the reboot reasons, the events and the heartbeats. This file gives it
 * the device ID and the reset cause, counts what this firmware does, and sends the SDK's chunks
 * over AWS IoT through src/mflt_link.c. Everything that sends runs on the main loop, as the other
 * reports do. The SDK's own heartbeat runs on the system work queue, every hour.
 */

#include "mflt.h"

#include <string.h>

#include <memfault/core/data_packetizer.h>
#include <memfault/core/reboot_tracking.h>
#include <memfault/core/trace_event.h>
#include <memfault/metrics/connectivity.h>
#include <memfault/metrics/metrics.h>
#include <memfault/metrics/platform/overrides.h>
#include <memfault/ports/reboot_reason.h>
#include <memfault_ncs.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/random/random.h>
#include <zephyr/sys/atomic.h>

#include "app_events.h"
#if defined(CONFIG_APP_BT_OTA)
#include "bt_ota.h"
#endif
#include "cloud.h"
#include "identity.h"
#include "mflt_link.h"
#include "net.h"
#include "ota.h"
#include "reset_cause.h"
#if defined(CONFIG_APP_CRASH_DEMO)
#include "store.h"
#include "version.h"
#endif
#include "stuck.h"

/* Not "mflt": the SDK has a log module of that name. */
LOG_MODULE_REGISTER(memfault_link, CONFIG_APP_LOG_LEVEL);

/* What the SDK keeps across a reset is at the same address in every image: the board's overlay. */
BUILD_ASSERT(DT_REG_SIZE(DT_NODELABEL(sram0_ns_mflt_coredump)) ==
		     CONFIG_MEMFAULT_RAM_BACKED_COREDUMP_SIZE,
	     "the coredump must fill its region, MFLT_COREDUMP");
BUILD_ASSERT(DT_REG_SIZE(DT_NODELABEL(sram0_ns_mflt_reboot)) >= MEMFAULT_REBOOT_TRACKING_REGION_SIZE,
	     "the reboot reason must fit its region, MFLT_REBOOT");
BUILD_ASSERT(CONFIG_APP_MEMFAULT_CHUNK_MAX <= MFLT_LINK_CHUNK_LIMIT);

/* How often the Wi-Fi metrics are read from the network stack, while the link is up. */
#define WIFI_METRICS_SECONDS 60

static int publish_frame(void *context, const uint8_t *frame, size_t len)
{
	ARG_UNUSED(context);
	return cloud_memfault_publish(frame, len);
}

static bool next_chunk(void *context, uint8_t *buf, size_t *len)
{
	ARG_UNUSED(context);
	return memfault_packetizer_get_chunk(buf, len);
}

static const struct mflt_link_io link_io = {
	.next_chunk = next_chunk,
	.publish = publish_frame,
};

static struct mflt_link link;
/* An answer from the MQTT library's thread, for the main loop: ANSWER_FLAG and the number. */
#define ANSWER_FLAG 0x10000
static atomic_t answer;
/* The main loop has seen this connection come up: its own messages go first on it. */
static bool ready;
static int wifi_seconds;

/* ---- the reset cause, for the SDK ------------------------------------------------------- */

/*
 * CONFIG_MEMFAULT_REBOOT_REASON_GET_CUSTOM: the SDK takes the cause from here, at its start, and
 * src/reset_cause.c has read and cleared it already. What a reason was marked with before the
 * restart, the SDK keeps itself, and it takes that before this.
 */
void memfault_reboot_reason_get(sResetBootupInfo *info)
{
	static const eMemfaultRebootReason reasons[] = {
		[RESET_KIND_BROWNOUT] = kMfltRebootReason_BrownOutReset,
		[RESET_KIND_POWER_ON] = kMfltRebootReason_PowerOnReset,
		[RESET_KIND_WATCHDOG] = kMfltRebootReason_HardwareWatchdog,
		[RESET_KIND_DEBUG] = kMfltRebootReason_DebuggerHalted,
		[RESET_KIND_SECURITY] = kMfltRebootReason_SecurityViolation,
		[RESET_KIND_LOW_POWER_WAKE] = kMfltRebootReason_LowPower,
		[RESET_KIND_LOCKUP] = kMfltRebootReason_Lockup,
		[RESET_KIND_PARITY] = kMfltRebootReason_ParityError,
		[RESET_KIND_CLOCK] = kMfltRebootReason_ClockFailure,
		[RESET_KIND_HARDWARE] = kMfltRebootReason_Hardware,
		[RESET_KIND_USER] = kMfltRebootReason_UserReset,
		[RESET_KIND_TEMPERATURE] = kMfltRebootReason_Temperature,
		[RESET_KIND_SOFTWARE] = kMfltRebootReason_SoftwareReset,
		[RESET_KIND_PIN] = kMfltRebootReason_PinReset,
		[RESET_KIND_UNKNOWN] = kMfltRebootReason_Unknown,
	};
	uint32_t bits = reset_cause_get();

	*info = (sResetBootupInfo){
		.reset_reason_reg = bits,
		.reset_reason = reasons[reset_cause_kind(bits)],
	};
}

/* ---- the heartbeat ------------------------------------------------------------------------ */

/* On the system work queue, every hour, or on the main loop for the memfault command. */
void memfault_metrics_heartbeat_collect_data(void)
{
	MEMFAULT_METRIC_SET_UNSIGNED(stuck_restart_count, stuck_count());
}

static void read_wifi_metrics(void)
{
	/* What the access point is called, or its address, is never read here. */
	MEMFAULT_METRIC_SET_SIGNED(wifi_sta_rssi, net_rssi());
	MEMFAULT_METRIC_SET_UNSIGNED(wifi_primary_channel, net_channel());
}

/* ---- the chunks ----------------------------------------------------------------------------- */

/* Not while an update downloads or installs, and not while Bluetooth is open. */
static bool may_send(void)
{
	if (!ready || !cloud_is_connected()) {
		return false;
	}

#if defined(CONFIG_APP_BT_OTA)
	if (bt_ota_is_open()) {
		return false;
	}
#endif

	switch (ota_state()) {
	case OTA_IDLE:
	case OTA_AWAITING_USER:
	case OTA_TESTING:
		return true;
	default:
		return false;
	}
}

static void send(bool force)
{
	if (may_send()) {
		(void)mflt_link_poll(&link, k_uptime_get(), force);
	}
}

static void take_answer(void)
{
	atomic_val_t got = atomic_clear(&answer);

	/* The next chunk goes at once, if there is one. */
	if ((got & ANSWER_FLAG) && mflt_link_answer(&link, (uint16_t)got)) {
		send(false);
	}
}

void mflt_on_answer(uint16_t seq)
{
	static const struct app_event event = {
		.type = APP_EVENT_CALL,
		.call.function = take_answer,
	};

	atomic_set(&answer, ANSWER_FLAG | seq);
	/* If the queue is full, the next tick takes it. */
	(void)app_event_post(&event);
}

/* ---- the crash demonstration ---------------------------------------------------------------- */

#if defined(CONFIG_APP_CRASH_DEMO)
#define CRASHED_MAGIC 0x43525348 /* "CRSH" */

struct crashed_record {
	uint32_t magic;
	struct fw_version version;
};

static int crash_seconds;
static bool crash_over;

static void crash_demo_on_tick(void)
{
	struct crashed_record record;

	if (crash_over) {
		return;
	}

	/* On trial this says OTA_TESTING, so the count starts at the confirmation. */
	if (ota_state() != OTA_IDLE || !cloud_is_connected()) {
		crash_seconds = 0;
		return;
	}

	if (++crash_seconds < CONFIG_APP_CRASH_DEMO_AFTER_SECONDS) {
		return;
	}

	crash_over = true;

	if (store_read(STORE_TEST_FAULT, &record, sizeof(record)) == 0 &&
	    record.magic == CRASHED_MAGIC &&
	    fw_version_compare(&record.version, fw_version_running()) == 0) {
		return;
	}

	/* First the record: a board that cannot remember must not crash at every boot. */
	memset(&record, 0, sizeof(record));
	record.magic = CRASHED_MAGIC;
	record.version = *fw_version_running();
	if (store_write(STORE_TEST_FAULT, &record, sizeof(record)) != 0) {
		LOG_ERR("Test image: nothing to remember the crash by, so there is none");
		return;
	}

	LOG_ERR("Test image: crashing once on purpose, for a coredump in Memfault");
	LOG_PANIC();
	k_oops();
}
#endif /* CONFIG_APP_CRASH_DEMO */

/* ---- what the rest of the firmware calls ------------------------------------------------------ */

void mflt_init(void)
{
	const char *thing = identity_thing_name();

	if (memfault_ncs_device_id_set(thing, strlen(thing)) != 0) {
		LOG_WRN("Memfault has no device ID");
	}

	mflt_link_init(&link, &link_io, CONFIG_APP_MEMFAULT_CHUNK_MAX,
		       CONFIG_APP_MEMFAULT_ACK_SECONDS * MSEC_PER_SEC, (uint16_t)sys_rand32_get());
	memfault_metrics_connectivity_connected_state_change(kMemfaultMetricsConnectivityState_Started);
}

void mflt_on_cloud_up(void)
{
	ready = true;
	/* After the boot, what the SDK kept: the reboot, and a coredump if there is one. */
	send(false);
}

void mflt_on_cloud_down(void)
{
	bool was_off = mflt_link_off(&link);

	ready = false;
	mflt_link_disconnected(&link, k_uptime_get());
	if (!was_off && mflt_link_off(&link)) {
		LOG_WRN("AWS IoT closed the connection right after a Memfault chunk, %d times: no "
			"Memfault data until a restart. Its device policy must allow "
			"cranium/<thing>/memfault",
			MFLT_LINK_REFUSALS_MAX);
	}
}

void mflt_on_net_up(void)
{
	MEMFAULT_METRIC_TIMER_START(wifi_connected_time_ms);
	wifi_seconds = WIFI_METRICS_SECONDS;
}

void mflt_on_net_down(void)
{
	MEMFAULT_METRIC_TIMER_STOP(wifi_connected_time_ms);
	MEMFAULT_METRIC_ADD(wifi_disconnect_count, 1);
}

void mflt_on_tick(void)
{
	uint32_t late = link.late;

	take_answer();

	if (net_is_up() && ++wifi_seconds >= WIFI_METRICS_SECONDS) {
		wifi_seconds = 0;
		read_wifi_metrics();
	}

#if defined(CONFIG_APP_CRASH_DEMO)
	crash_demo_on_tick();
#endif

	/* A heartbeat, a trace event or a reboot: whatever the SDK has, as soon as it has it. */
	send(false);

	if (link.late != late) {
		MEMFAULT_METRIC_ADD(memfault_chunk_retry_count, 1);
		LOG_WRN("No answer for Memfault chunk %u: it goes again", (unsigned int)link.seq);
	}
}

void mflt_drain_now(void)
{
	send(true);
}

void mflt_heartbeat_now(void)
{
	memfault_metrics_heartbeat_debug_trigger();
	send(true);
}

void mflt_reboot_mark(enum mflt_reboot why)
{
	switch (why) {
	case MFLT_REBOOT_UPDATE:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT(kMfltRebootReason_FirmwareUpdate);
		break;
	case MFLT_REBOOT_TRIAL_FAILED:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT(kMfltRebootReason_FirmwareUpdateError);
		break;
	case MFLT_REBOOT_USER:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT(kMfltRebootReason_UserReset);
		break;
	case MFLT_REBOOT_FACTORY_RESET:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT_CUSTOM(FactoryReset);
		break;
	case MFLT_REBOOT_STUCK_WIFI_SILENT:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT_CUSTOM(StuckWifiSilent);
		break;
	case MFLT_REBOOT_STUCK_NO_CLOUD:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT_CUSTOM(StuckNoCloud);
		break;
	case MFLT_REBOOT_STUCK_UPDATE_STALL:
		MEMFAULT_REBOOT_MARK_RESET_IMMINENT_CUSTOM(StuckUpdateStall);
		break;
	default:
		break;
	}
}

void mflt_note_cloud_connected(void)
{
	static atomic_t connects;

	if (atomic_inc(&connects) > 0) {
		MEMFAULT_METRIC_ADD(mqtt_reconnect_count, 1);
	}
	memfault_metrics_connectivity_connected_state_change(
		kMemfaultMetricsConnectivityState_Connected);
}

void mflt_note_cloud_lost(void)
{
	memfault_metrics_connectivity_connected_state_change(
		kMemfaultMetricsConnectivityState_ConnectionLost);
}

void mflt_note_report(bool sent)
{
	if (sent) {
		memfault_metrics_connectivity_record_sync_success();
	} else {
		memfault_metrics_connectivity_record_sync_failure();
	}
}

void mflt_note_update_started(void)
{
	MEMFAULT_METRIC_ADD(ota_attempt_count, 1);
}

void mflt_note_update_end(enum mflt_update_end end, const char *reason, const char *detail)
{
	const char *what = detail != NULL ? detail : "";

	if (reason == NULL) {
		reason = "";
	}

	switch (end) {
	case MFLT_UPDATE_SUCCEEDED:
		MEMFAULT_TRACE_EVENT_WITH_LOG(update_succeeded, "%s", what);
		break;
	case MFLT_UPDATE_REFUSED:
		MEMFAULT_METRIC_ADD(ota_refusal_count, 1);
		MEMFAULT_TRACE_EVENT_WITH_LOG(update_refused, "%s: %s", reason, what);
		break;
	case MFLT_UPDATE_ROLLED_BACK:
		MEMFAULT_METRIC_ADD(ota_failure_count, 1);
		MEMFAULT_TRACE_EVENT_WITH_LOG(update_rolled_back, "%s: %s", reason, what);
		break;
	default:
		MEMFAULT_METRIC_ADD(ota_failure_count, 1);
		if (strcmp(reason, "digest_mismatch") == 0) {
			MEMFAULT_TRACE_EVENT_WITH_LOG(update_digest_mismatch, "%s: %s", reason, what);
		} else if (strncmp(reason, "incompatible_", strlen("incompatible_")) == 0) {
			MEMFAULT_TRACE_EVENT_WITH_LOG(update_incompatible, "%s: %s", reason, what);
		} else {
			MEMFAULT_TRACE_EVENT_WITH_LOG(update_failed, "%s: %s", reason, what);
		}
		break;
	}
}
