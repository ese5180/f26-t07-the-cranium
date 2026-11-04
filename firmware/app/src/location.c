/*
 * Location by Wi-Fi: see location.h.
 *
 * Who does what: the main loop decides when to scan, asks the Wi-Fi stack for one, and sends what
 * came of it. The results arrive one by one on the network management thread, which keeps the
 * strongest few in heard, under a lock, and nothing else of them: not the driver's list, and
 * never a network's name. When the scan is done, that thread hands it back to the main loop.
 */

#include "location.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/sys/util.h>

#include "app_events.h"
#if defined(CONFIG_APP_BOOT_DIARY)
#include "boot_diary.h"
#endif
#if defined(CONFIG_APP_BT_OTA)
#include "bt_ota.h"
#endif
#include "cloud.h"
#include "ota.h"

LOG_MODULE_REGISTER(location, CONFIG_APP_LOG_LEVEL);

#define SCAN_EVENTS (NET_EVENT_WIFI_SCAN_RESULT | NET_EVENT_WIFI_SCAN_DONE)

/* ---- what is kept, and what is sent ------------------------------------------------- */

/*
 * An address that says where the board is: globally administered (bit 1 of the first byte clear),
 * and an individual one (bit 0 clear), which every access point's is. Nor all zeros.
 */
static bool says_where(const uint8_t mac[6])
{
	return (mac[0] & 0x03) == 0 && (mac[0] | mac[1] | mac[2] | mac[3] | mac[4] | mac[5]) != 0;
}

void location_keep(struct location_aps *aps, const uint8_t mac[6], int rss)
{
	size_t at;

	/* 0 is what the driver gives for a signal it does not know. */
	if (!says_where(mac) || rss >= 0 || rss < -127 || aps->count > LOCATION_APS_MAX) {
		return;
	}

	/* Heard before: it keeps its stronger signal, and moves if this one is. */
	for (at = 0; at < aps->count; at++) {
		if (memcmp(aps->ap[at].mac, mac, sizeof(aps->ap[at].mac)) == 0) {
			if (rss <= aps->ap[at].rss) {
				return;
			}
			memmove(&aps->ap[at], &aps->ap[at + 1],
				(aps->count - at - 1) * sizeof(aps->ap[0]));
			aps->count--;
			break;
		}
	}

	/* After those as strong: of two the same, the one heard first stays first. */
	for (at = 0; at < aps->count && aps->ap[at].rss >= rss; at++) {
	}

	if (at == LOCATION_APS_MAX) {
		return;
	}

	/* Full: the weakest goes. */
	if (aps->count == LOCATION_APS_MAX) {
		aps->count--;
	}

	memmove(&aps->ap[at + 1], &aps->ap[at], (aps->count - at) * sizeof(aps->ap[0]));
	memcpy(aps->ap[at].mac, mac, sizeof(aps->ap[at].mac));
	aps->ap[at].rss = (int8_t)rss;
	aps->count++;
}

int location_format(const struct location_aps *aps, uint32_t boot, int64_t t, char *buf,
		    size_t len)
{
	int used;

	if (aps->count < LOCATION_APS_MIN) {
		return -ENODATA;
	}

	used = snprintk(buf, len, "{\"aps\":[");

	for (size_t i = 0; i < MIN(aps->count, LOCATION_APS_MAX) && used >= 0 && (size_t)used < len;
	     i++) {
		const uint8_t *mac = aps->ap[i].mac;

		used += snprintk(buf + used, len - (size_t)used,
				 "%s{\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"rss\":%d}",
				 i > 0 ? "," : "", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
				 aps->ap[i].rss);
	}

	if (used >= 0 && (size_t)used < len) {
		used += snprintk(buf + used, len - (size_t)used, "],\"boot\":%u,\"t\":%lld}",
				 (unsigned int)boot, (long long)t);
	}

	return (used < 0 || (size_t)used >= len) ? -ENOSPC : used;
}

/* ---- the scan ----------------------------------------------------------------------- */

/* The network management thread's, while collecting, and the main loop's otherwise. */
static struct k_spinlock lock;
static struct location_aps heard;
static bool collecting;

static struct net_mgmt_event_callback scan_callback;

/* The main loop's alone. */
static struct {
	/* The boot's first location went out, or its scan found too few to send. */
	bool first_done;
	bool scanning;
	/* When the last scan began, or -1. */
	int64_t scanned_at;
	/* The Wi-Fi stack refused a scan: none before this. */
	int64_t retry_at;
	/* When the last location went out, or -1, and whether a connection has outlived one. */
	int64_t probe_at;
	bool proven;
	uint8_t refusals;
	bool off;
} plan = { .scanned_at = -1, .probe_at = -1 };

static uint32_t boot_number(void)
{
#if defined(CONFIG_APP_BOOT_DIARY)
	return boot_diary_boots();
#else
	return 0;
#endif
}

static enum location_hold hold(bool asked, int64_t now)
{
	struct cloud_stats stats;

	if (plan.off) {
		return LOCATION_OFF;
	}

	if (plan.scanning) {
		return LOCATION_SCANNING;
	}

	cloud_stats_get(&stats);
	if (stats.state != CLOUD_STATE_CONNECTED || stats.connected_at_ms < 0) {
		return LOCATION_OFFLINE;
	}

	/* Any state but idle: a download, an install, a trial, a Bluetooth update or one on offer. */
	if (ota_state() != OTA_IDLE) {
		return LOCATION_UPDATE;
	}

#if defined(CONFIG_APP_BT_OTA)
	if (bt_ota_is_open()) {
		return LOCATION_BLUETOOTH;
	}
#endif

	if (plan.scanned_at >= 0 && now - plan.scanned_at < LOCATION_FLOOR_MS) {
		return LOCATION_FLOOR;
	}

	if (now < plan.retry_at) {
		return LOCATION_RETRY;
	}

	if (!asked && now - stats.connected_at_ms < LOCATION_SETTLE_MS) {
		return LOCATION_SETTLING;
	}

	if (!asked && plan.first_done && now - plan.scanned_at < LOCATION_PERIOD_MS) {
		return LOCATION_NOT_DUE;
	}

	return LOCATION_GO;
}

static void set_collecting(bool on)
{
	k_spinlock_key_t key = k_spin_lock(&lock);

	if (on) {
		memset(&heard, 0, sizeof(heard));
	}
	collecting = on;
	k_spin_unlock(&lock, key);
}

/*
 * The 2.4 GHz band, actively where the rules allow it, with the driver's own dwell times. Every
 * result comes, and location_keep() takes the strongest: the driver's max_bss_cnt keeps the first
 * ones it reports, which need not be those.
 */
static enum location_hold start_scan(int64_t now)
{
	struct wifi_scan_params params = {
		.scan_type = WIFI_SCAN_TYPE_ACTIVE,
		.bands = BIT(WIFI_FREQ_BAND_2_4_GHZ),
	};
	struct net_if *iface = net_if_get_first_wifi();
	int err;

	set_collecting(true);
	err = iface != NULL ? net_mgmt(NET_REQUEST_WIFI_SCAN, iface, &params, sizeof(params))
			    : -ENODEV;
	if (err != 0) {
		set_collecting(false);
		plan.retry_at = now + LOCATION_RETRY_MS;
		LOG_WRN("Location: the Wi-Fi stack did not start a scan: %d", err);
		return LOCATION_RETRY;
	}

	plan.scanning = true;
	plan.scanned_at = now;
	return LOCATION_GO;
}

static void finish_scan(int64_t now)
{
	static char json[LOCATION_JSON_MAX];
	int length;

	/* From here on nothing else writes heard. */
	set_collecting(false);

	if (!plan.scanning) {
		return;
	}
	plan.scanning = false;

	length = location_format(&heard, boot_number(), now, json, sizeof(json));
	if (length == -ENODATA) {
		LOG_INF("Location: %u access points that say where the board is, too few to send",
			(unsigned int)heard.count);
		plan.first_done = true;
		return;
	}

	if (length < 0 || cloud_location_publish(json) != 0) {
		LOG_WRN("Location: %u access points, not sent: not connected",
			(unsigned int)heard.count);
		return;
	}

	plan.first_done = true;
	plan.probe_at = now;
	LOG_INF("Location: %u access points sent", (unsigned int)heard.count);
}

static void scan_done(void)
{
	finish_scan(k_uptime_get());
}

/* The network management thread: one result of a scan, or its end. */
static void on_scan_event(struct net_mgmt_event_callback *callback, uint64_t event,
			  struct net_if *iface)
{
	static const struct app_event done = {
		.type = APP_EVENT_CALL,
		.call.function = scan_done,
	};
	const struct wifi_scan_result *result = callback->info;
	k_spinlock_key_t key;
	bool ours;

	ARG_UNUSED(iface);

	key = k_spin_lock(&lock);
	ours = collecting;
	if (ours && event == NET_EVENT_WIFI_SCAN_RESULT && result != NULL &&
	    result->mac_length == sizeof(heard.ap[0].mac)) {
		location_keep(&heard, result->mac, result->rssi);
	}
	k_spin_unlock(&lock, key);

	/* If the main loop's queue is full, it ends the scan after LOCATION_SCAN_LIMIT_MS. */
	if (ours && event == NET_EVENT_WIFI_SCAN_DONE) {
		(void)app_event_post(&done);
	}
}

/* A connection has lived LOCATION_PROOF_MS past a location: AWS IoT took it. */
static void judge_probe(int64_t now)
{
	if (!plan.proven && plan.probe_at >= 0 && now - plan.probe_at >= LOCATION_PROOF_MS) {
		plan.proven = true;
	}
}

void location_init(void)
{
	net_mgmt_init_event_callback(&scan_callback, on_scan_event, SCAN_EVENTS);
	net_mgmt_add_event_callback(&scan_callback);
}

void location_on_tick(void)
{
	int64_t now = k_uptime_get();

	judge_probe(now);

	if (plan.scanning && now - plan.scanned_at >= LOCATION_SCAN_LIMIT_MS) {
		LOG_WRN("Location: the scan had not ended after %d s", LOCATION_SCAN_LIMIT_MS / 1000);
		finish_scan(now);
	}

	if (hold(false, now) == LOCATION_GO) {
		(void)start_scan(now);
	}
}

void location_on_cloud_down(void)
{
	judge_probe(k_uptime_get());

	/* The connection ended soon after a location, and AWS IoT may have closed it for that. */
	if (!plan.proven && plan.probe_at >= 0 && !plan.off &&
	    ++plan.refusals >= LOCATION_REFUSALS_MAX) {
		plan.off = true;
		LOG_WRN("AWS IoT closed the connection right after a location, %d times: no location "
			"until a restart. Its device policy must allow cranium/<thing>/location",
			LOCATION_REFUSALS_MAX);
	}

	plan.probe_at = -1;
}

enum location_hold location_request(void)
{
	int64_t now = k_uptime_get();
	enum location_hold why = hold(true, now);

	return why == LOCATION_GO ? start_scan(now) : why;
}
