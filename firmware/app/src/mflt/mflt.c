/*
 * Memfault on this board: see mflt.h and docs/memfault.md.
 *
 * The SDK keeps the coredump, the reboot reasons, the events and the heartbeats. This file gives it
 * the device ID and the reset cause, counts what this firmware does, and sends the SDK's chunks
 * over AWS IoT through src/mflt/mflt_link.c. Everything that sends runs on the main loop, as the other
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
#include <hal/nrf_saadc.h>
#include <hal/nrf_usbreg.h>

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
#if defined(CONFIG_APP_CRASH_DEMO) || defined(CONFIG_APP_FAULT_DEMO)
#include <memfault/panics/assert.h>
#include <memfault/panics/coredump.h>
#include <memfault/ports/watchdog.h>
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

/* ---- the heartbeat, and the power status in it ------------------------------------------- */

/*
 * The DK has no battery: it runs from USB. So in place of a state of charge, the heartbeat says
 * whether the USB regulator sees VBUS, and the supply voltage VDD in mV, one sample of the SAADC
 * against its internal reference (gain 1/6, so 3.6 V full scale), not calibrated. Both
 * peripherals are non-secure under TF-M, and nothing else here uses the SAADC.
 */
static bool usb_power_present(void)
{
	return (nrf_usbreg_status_get(NRF_USBREGULATOR) & NRF_USBREG_STATUS_VBUSDETECT_MASK) != 0;
}

static bool saadc_wait(nrf_saadc_event_t event)
{
	for (int us = 0; us < 1000; us++) {
		if (nrf_saadc_event_check(NRF_SAADC, event)) {
			nrf_saadc_event_clear(NRF_SAADC, event);
			return true;
		}
		k_busy_wait(1);
	}
	return false;
}

/* The supply in mV, or 0 if the SAADC did not answer. */
static uint32_t supply_millivolts(void)
{
	static nrf_saadc_value_t sample;
	const nrf_saadc_channel_config_t config = {
		.resistor_p = NRF_SAADC_RESISTOR_DISABLED,
		.resistor_n = NRF_SAADC_RESISTOR_DISABLED,
		.gain = NRF_SAADC_GAIN1_6,
		.reference = NRF_SAADC_REFERENCE_INTERNAL,
		.acq_time = NRF_SAADC_ACQTIME_10US,
		.mode = NRF_SAADC_MODE_SINGLE_ENDED,
		.burst = NRF_SAADC_BURST_DISABLED,
	};
	bool ok;

	sample = 0;
	nrf_saadc_int_disable(NRF_SAADC, NRF_SAADC_INT_ALL);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_STARTED);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_END);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_STOPPED);
	nrf_saadc_resolution_set(NRF_SAADC, NRF_SAADC_RESOLUTION_12BIT);
	nrf_saadc_oversample_set(NRF_SAADC, NRF_SAADC_OVERSAMPLE_DISABLED);
	nrf_saadc_channel_init(NRF_SAADC, 0, &config);
	nrf_saadc_channel_input_set(NRF_SAADC, 0, NRF_SAADC_INPUT_VDD, NRF_SAADC_INPUT_DISABLED);
	nrf_saadc_buffer_init(NRF_SAADC, &sample, 1);
	nrf_saadc_enable(NRF_SAADC);

	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_START);
	ok = saadc_wait(NRF_SAADC_EVENT_STARTED);
	if (ok) {
		nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_SAMPLE);
		ok = saadc_wait(NRF_SAADC_EVENT_END);
	}
	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_STOP);
	(void)saadc_wait(NRF_SAADC_EVENT_STOPPED);
	nrf_saadc_channel_input_set(NRF_SAADC, 0, NRF_SAADC_INPUT_DISABLED, NRF_SAADC_INPUT_DISABLED);
	nrf_saadc_disable(NRF_SAADC);

	if (!ok || sample <= 0) {
		return 0;
	}
	/* 12 bits over 0.6 V x 6. */
	return ((uint32_t)sample * 3600U) / 4096U;
}

/* On the system work queue, every hour, or on the main loop for the memfault command. */
void memfault_metrics_heartbeat_collect_data(void)
{
	uint32_t mv = supply_millivolts();

	MEMFAULT_METRIC_SET_UNSIGNED(stuck_restart_count, stuck_count());
	MEMFAULT_METRIC_SET_UNSIGNED(power_usb_present, usb_power_present() ? 1 : 0);
	if (mv != 0) {
		MEMFAULT_METRIC_SET_UNSIGNED(supply_mv, mv);
	}
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

/* ---- the crash and fault demonstrations ------------------------------------------------------ */

#if defined(CONFIG_APP_CRASH_DEMO) || defined(CONFIG_APP_FAULT_DEMO)
#define FAULTED_MAGIC 0x464c5431 /* "FLT1" */

/* How many of the faults this version has made, kept before each one. */
struct faulted_record {
	uint32_t magic;
	struct fw_version version;
	uint32_t done;
};

enum demo_fault {
	DEMO_OOPS,
	DEMO_ASSERT,
	DEMO_BAD_WRITE,
	DEMO_UNDEFINED_INSTRUCTION,
	DEMO_STACK_OVERFLOW,
	DEMO_HANG,
};

#if defined(CONFIG_APP_FAULT_DEMO)
/* One per boot, in this order, each a different issue in Memfault. */
static const uint8_t demo_faults[] = {
	DEMO_ASSERT, DEMO_BAD_WRITE, DEMO_UNDEFINED_INSTRUCTION, DEMO_STACK_OVERFLOW, DEMO_HANG,
};
#else
static const uint8_t demo_faults[] = {DEMO_OOPS};
#endif

static const char *const demo_fault_names[] = {
	[DEMO_OOPS] = "k_oops()",
	[DEMO_ASSERT] = "a failed assert",
	[DEMO_BAD_WRITE] = "a write to flash",
	[DEMO_UNDEFINED_INSTRUCTION] = "an undefined instruction",
	[DEMO_STACK_OVERFLOW] = "a stack overflow",
	[DEMO_HANG] = "a hang of the main loop",
};

static int crash_seconds;
static bool crash_over;

/* Each fault in a function of its own, so that each backtrace, and so each issue, is its own. */
static __noinline void fault_demo_assert(void)
{
	volatile bool fine = false;

	MEMFAULT_ASSERT(fine);
}

static __noinline void fault_demo_bad_write(void)
{
	/* This function's own code, in flash, which the MPU lets nothing write: a MemManage fault. */
	volatile uint32_t *code = (volatile uint32_t *)((uintptr_t)fault_demo_bad_write & ~1UL);

	*code = 0xDEADBEEFU;
}

static __noinline void fault_demo_undefined_instruction(void)
{
	/* A permanently undefined instruction: a usage fault (UNDEFINSTR). */
	__asm__ volatile("udf #0x42");
}

static __noinline uint32_t fault_demo_recurse(uint32_t depth)
{
	/* Until the stack limit register (CONFIG_BUILTIN_STACK_GUARD) stops it: a usage fault. */
	volatile uint8_t frame[128];

	frame[0] = (uint8_t)depth;
	if (depth == UINT32_MAX) {
		return frame[0];
	}
	return fault_demo_recurse(depth + 1) + frame[0];
}

static __noinline void fault_demo_hang(void)
{
	/* Memfault's software watchdog (15 s) stops it, before the hardware watchdog (120 s). */
	(void)memfault_software_watchdog_enable();
	while (true) {
		arch_nop();
	}
}

static void fault_demo_make(enum demo_fault fault)
{
	switch (fault) {
	case DEMO_ASSERT:
		fault_demo_assert();
		break;
	case DEMO_BAD_WRITE:
		fault_demo_bad_write();
		break;
	case DEMO_UNDEFINED_INSTRUCTION:
		fault_demo_undefined_instruction();
		break;
	case DEMO_STACK_OVERFLOW:
		(void)fault_demo_recurse(0);
		break;
	case DEMO_HANG:
		fault_demo_hang();
		break;
	default:
		k_oops();
		break;
	}
}

static void crash_demo_on_tick(void)
{
	struct faulted_record record;
	enum demo_fault fault;

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

	/* The coredump of the fault before goes to Memfault first: a new one would not replace it. */
	if (memfault_coredump_has_valid_coredump(NULL)) {
		return;
	}

	crash_over = true;

	if (store_read(STORE_TEST_FAULT, &record, sizeof(record)) != 0 ||
	    record.magic != FAULTED_MAGIC ||
	    fw_version_compare(&record.version, fw_version_running()) != 0) {
		memset(&record, 0, sizeof(record));
		record.magic = FAULTED_MAGIC;
		record.version = *fw_version_running();
	}

	if (record.done >= ARRAY_SIZE(demo_faults)) {
		return;
	}

	/* First the record: a board that cannot remember must not fault at every boot. */
	fault = (enum demo_fault)demo_faults[record.done];
	record.done++;
	if (store_write(STORE_TEST_FAULT, &record, sizeof(record)) != 0) {
		LOG_ERR("Test image: nothing to remember the fault by, so there is none");
		return;
	}

	LOG_ERR("Test image: fault %u of %u on purpose, %s, for a coredump in Memfault",
		(unsigned int)record.done, (unsigned int)ARRAY_SIZE(demo_faults),
		demo_fault_names[fault]);
	LOG_PANIC();
	fault_demo_make(fault);
	LOG_ERR("Test image: the fault did not happen");
}
#endif /* CONFIG_APP_CRASH_DEMO || CONFIG_APP_FAULT_DEMO */

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

#if defined(CONFIG_APP_CRASH_DEMO) || defined(CONFIG_APP_FAULT_DEMO)
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
