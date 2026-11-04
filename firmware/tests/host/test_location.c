/*
 * Host-side tests of location.c: which access points are kept and in what order, the JSON they go
 * out in, when the board scans, and what holds a scan: the floor, an update, the Bluetooth window, a
 * connection that is new or gone, a Wi-Fi stack that is busy, and a cloud that refuses the topic.
 * The real file is compiled here, against fakes of the Wi-Fi stack's scan, the cloud connection, the
 * update's state and the main loop's queue. Every message that goes out is parsed with cJSON, as the
 * cloud would. Built twice: the second time with CONFIG_APP_BT_OTA, for the Bluetooth window.
 *
 * What this cannot show is what a real scan does to the link: see "Location" in firmware/README.md.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <cJSON.h>

#include "location.c"

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

#define BOOT     42
#define SECOND   1000LL
#define MINUTE   (60 * SECOND)
#define HOUR     (60 * MINUTE)

static struct {
	long long now_ms;

	/* The connection, as cloud.c says it is. */
	bool connected;
	long long connected_at;

	enum ota_state ota;
	bool bluetooth_open;

	/* The Wi-Fi stack. */
	struct net_mgmt_event_callback *callback;
	int scans;
	int scan_result;
	struct wifi_scan_params last_params;

	/* The main loop's queue. */
	void (*posted[8])(void);
	int posts;
	bool queue_full;

	/* What went to the cloud. */
	int published;
	int publish_result;
	char json[LOCATION_JSON_MAX + 64];
} fake;

/* ---- what location.c calls ------------------------------------------------------------ */

long long k_uptime_get(void)
{
	return fake.now_ms;
}

void net_mgmt_init_event_callback(struct net_mgmt_event_callback *callback,
				  void (*handler)(struct net_mgmt_event_callback *callback,
						  uint64_t event, struct net_if *iface),
				  uint64_t mask)
{
	callback->handler = handler;
	callback->mask = mask;
}

void net_mgmt_add_event_callback(struct net_mgmt_event_callback *callback)
{
	fake.callback = callback;
}

int net_mgmt(enum net_request request, struct net_if *iface, void *data, size_t length)
{
	CHECK(request == NET_REQUEST_WIFI_SCAN);
	CHECK(iface != NULL);
	CHECK(length == sizeof(struct wifi_scan_params));
	fake.scans++;
	memcpy(&fake.last_params, data, sizeof(fake.last_params));
	return fake.scan_result;
}

struct net_if *net_if_get_first_wifi(void)
{
	static struct net_if iface;

	return &iface;
}

int app_event_post(const struct app_event *event)
{
	CHECK(event->type == APP_EVENT_CALL);
	if (fake.queue_full || fake.posts >= (int)ARRAY_SIZE(fake.posted)) {
		return -ENOMSG;
	}
	fake.posted[fake.posts++] = event->call.function;
	return 0;
}

void cloud_stats_get(struct cloud_stats *out)
{
	memset(out, 0, sizeof(*out));
	out->state = fake.connected ? CLOUD_STATE_CONNECTED : CLOUD_STATE_IDLE;
	out->connected_at_ms = fake.connected ? fake.connected_at : -1;
}

enum ota_state ota_state(void)
{
	return fake.ota;
}

#if defined(CONFIG_APP_BT_OTA)
bool bt_ota_is_open(void)
{
	return fake.bluetooth_open;
}
#endif

uint32_t boot_diary_boots(void)
{
	return BOOT;
}

int cloud_location_publish(const char *json)
{
	if (!fake.connected) {
		return -ENOTCONN;
	}
	if (fake.publish_result != 0) {
		return fake.publish_result;
	}
	CHECK(strlen(json) < sizeof(fake.json));
	snprintf(fake.json, sizeof(fake.json), "%s", json);
	fake.published++;
	return 0;
}

/* ---- helpers --------------------------------------------------------------------------- */

static void start_over(void)
{
	memset(&fake, 0, sizeof(fake));
	memset(&plan, 0, sizeof(plan));
	plan.scanned_at = -1;
	plan.probe_at = -1;
	memset(&heard, 0, sizeof(heard));
	collecting = false;
	fake.now_ms = 10 * SECOND;
	location_init();
	CHECK(fake.callback != NULL);
	CHECK(fake.callback->mask == (NET_EVENT_WIFI_SCAN_RESULT | NET_EVENT_WIFI_SCAN_DONE));
}

static void run_loop(void)
{
	for (int i = 0; i < fake.posts; i++) {
		fake.posted[i]();
	}
	fake.posts = 0;
}

static void ticks_for(long long ms)
{
	for (long long end = fake.now_ms + ms; fake.now_ms < end;) {
		fake.now_ms += SECOND;
		location_on_tick();
		run_loop();
	}
}

static void connect_cloud(void)
{
	fake.connected = true;
	fake.connected_at = fake.now_ms;
}

static void disconnect_cloud(void)
{
	fake.connected = false;
	location_on_cloud_down();
}

/* One result, as the network management thread hands it over. */
static void heard_ap(const uint8_t mac[6], int rssi, const char *ssid)
{
	struct wifi_scan_result result = { .mac_length = 6, .rssi = (int8_t)rssi };

	memcpy(result.mac, mac, 6);
	snprintf((char *)result.ssid, sizeof(result.ssid), "%s", ssid);
	result.ssid_length = (uint8_t)strlen(ssid);
	fake.callback->info = &result;
	fake.callback->handler(fake.callback, NET_EVENT_WIFI_SCAN_RESULT, NULL);
	fake.callback->info = NULL;
}

static void scan_ends(void)
{
	struct wifi_status status = { .status = 0 };

	fake.callback->info = &status;
	fake.callback->handler(fake.callback, NET_EVENT_WIFI_SCAN_DONE, NULL);
	fake.callback->info = NULL;
	run_loop();
}

/* What a scan hears here: three that count, and what is to be left out. */
static void the_scan_hears_the_room(void)
{
	static const uint8_t office[6] = { 0xa4, 0x2b, 0xb0, 0x12, 0x34, 0x56 };
	static const uint8_t hall[6] = { 0xf0, 0x9f, 0xc2, 0x65, 0x43, 0x21 };
	static const uint8_t lab[6] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55 };
	static const uint8_t hotspot[6] = { 0x7a, 0x11, 0x22, 0x33, 0x44, 0x55 };

	heard_ap(hall, -70, "MyNetwork");
	heard_ap(office, -51, "MyNetwork");
	heard_ap(hotspot, -30, "Tester's iPhone");
	heard_ap(lab, -80, "eduroam");
	heard_ap(office, -60, "MyNetwork");
	scan_ends();
}

static int sent_aps(cJSON **out)
{
	cJSON *parsed = cJSON_Parse(fake.json);
	const cJSON *aps = cJSON_GetObjectItemCaseSensitive(parsed, "aps");

	*out = parsed;
	return cJSON_IsArray(aps) ? cJSON_GetArraySize(aps) : -1;
}

/* ---- what is kept ---------------------------------------------------------------------- */

static void mac_of(uint8_t mac[6], uint8_t first, int n)
{
	mac[0] = first;
	mac[1] = 0x10;
	mac[2] = 0x20;
	mac[3] = 0x30;
	mac[4] = (uint8_t)(n >> 8);
	mac[5] = (uint8_t)n;
}

static void test_only_addresses_that_stay_put(void)
{
	struct location_aps aps = { 0 };
	uint8_t mac[6];

	/* The second-lowest bit of the first byte: locally administered, a phone's or a virtual one. */
	for (unsigned int first = 0; first < 256; first++) {
		memset(&aps, 0, sizeof(aps));
		mac_of(mac, (uint8_t)first, 1);
		location_keep(&aps, mac, -50);
		CHECK(aps.count == (((first & 0x03) == 0) ? 1 : 0));
	}

	/* No address at all, and signals that are not one. */
	memset(&aps, 0, sizeof(aps));
	memset(mac, 0, sizeof(mac));
	location_keep(&aps, mac, -50);
	CHECK(aps.count == 0);
	mac_of(mac, 0xa4, 1);
	location_keep(&aps, mac, 0);
	location_keep(&aps, mac, 5);
	location_keep(&aps, mac, -128);
	location_keep(&aps, mac, -1000);
	CHECK(aps.count == 0);
	location_keep(&aps, mac, -127);
	location_keep(&aps, mac, -1);
	CHECK(aps.count == 1 && aps.ap[0].rss == -1);
}

static void test_each_once_strongest_first_and_ten_at_most(void)
{
	struct location_aps aps = { 0 };
	uint8_t mac[6];

	/* The same one again: its strongest signal counts, and it moves to its place. */
	mac_of(mac, 0xa4, 1);
	location_keep(&aps, mac, -70);
	mac_of(mac, 0xa4, 2);
	location_keep(&aps, mac, -60);
	mac_of(mac, 0xa4, 1);
	location_keep(&aps, mac, -80);
	CHECK(aps.count == 2 && aps.ap[0].mac[5] == 2 && aps.ap[1].rss == -70);
	location_keep(&aps, mac, -50);
	CHECK(aps.count == 2 && aps.ap[0].mac[5] == 1 && aps.ap[0].rss == -50);
	CHECK(aps.ap[1].mac[5] == 2 && aps.ap[1].rss == -60);

	/* Two the same: the one heard first stays first. */
	mac_of(mac, 0xa4, 3);
	location_keep(&aps, mac, -60);
	CHECK(aps.count == 3 && aps.ap[1].mac[5] == 2 && aps.ap[2].mac[5] == 3);

	/* Twenty more, weakest first: the ten strongest stay, in order. */
	memset(&aps, 0, sizeof(aps));
	for (int n = 0; n < 20; n++) {
		mac_of(mac, 0x00, n);
		location_keep(&aps, mac, -90 + n);
	}
	CHECK(aps.count == LOCATION_APS_MAX);
	for (int i = 0; i < LOCATION_APS_MAX; i++) {
		CHECK(aps.ap[i].rss == -71 - i);
		CHECK(aps.ap[i].mac[5] == 19 - i);
	}

	/* One no stronger than the weakest kept does not get in; one stronger does, and that one goes. */
	mac_of(mac, 0x00, 99);
	location_keep(&aps, mac, -80);
	CHECK(aps.count == LOCATION_APS_MAX && aps.ap[9].rss == -80 && aps.ap[9].mac[5] == 10);
	location_keep(&aps, mac, -79);
	CHECK(aps.count == LOCATION_APS_MAX && aps.ap[8].rss == -79 && aps.ap[9].mac[5] == 99);
	CHECK(aps.ap[9].rss == -79 || aps.ap[9].mac[5] == 99);
}

/* Against the plain way of doing it, for many random scans: each address's best, the best ten. */
static void test_what_is_kept_is_the_best_ten_whatever_comes(void)
{
	unsigned int seed = 777;

	for (int round = 0; round < 20000; round++) {
		struct location_aps aps = { 0 };
		int best[40];
		int sightings;
		int kept_best[LOCATION_APS_MAX];
		int expected = 0;

		for (int n = 0; n < 40; n++) {
			best[n] = 1;
		}

		seed = seed * 1103515245U + 12345U;
		sightings = (int)((seed >> 8) % 80);
		for (int i = 0; i < sightings; i++) {
			uint8_t mac[6];
			int n;
			int rss;

			seed = seed * 1103515245U + 12345U;
			n = (int)((seed >> 8) % 40);
			rss = -(int)((seed >> 16) % 140);
			/* Every fourth address is a phone's. */
			mac_of(mac, (n % 4 == 0) ? 0x02 : 0x00, n);
			location_keep(&aps, mac, rss);
			if (n % 4 != 0 && rss < 0 && rss >= -127 && (best[n] > 0 || rss > best[n])) {
				best[n] = rss;
			}
		}

		/* The best of each address that counts, strongest first. */
		for (int n = 0; n < 40; n++) {
			if (best[n] <= 0) {
				expected++;
			}
		}
		for (int i = 0; i < LOCATION_APS_MAX; i++) {
			int pick = -1;

			for (int n = 0; n < 40; n++) {
				if (best[n] <= 0 && (pick < 0 || best[n] > best[pick])) {
					pick = n;
				}
			}
			kept_best[i] = pick >= 0 ? best[pick] : 1;
			if (pick >= 0) {
				best[pick] = 1;
			}
		}
		expected = MIN(expected, LOCATION_APS_MAX);

		CHECK(aps.count == expected);
		for (int i = 0; i < aps.count; i++) {
			CHECK((aps.ap[i].mac[0] & 0x03) == 0);
			CHECK(aps.ap[i].rss == kept_best[i]);
			CHECK(i == 0 || aps.ap[i - 1].rss >= aps.ap[i].rss);
			for (int j = 0; j < i; j++) {
				CHECK(memcmp(aps.ap[i].mac, aps.ap[j].mac, 6) != 0);
			}
		}
	}
}

/* ---- what is sent ---------------------------------------------------------------------- */

static void test_the_message(void)
{
	struct location_aps aps = { 0 };
	char json[LOCATION_JSON_MAX];
	uint8_t mac[6] = { 0xa4, 0x2b, 0xb0, 0x12, 0x34, 0x56 };

	/* One is not enough. */
	location_keep(&aps, mac, -51);
	CHECK(location_format(&aps, BOOT, 61234, json, sizeof(json)) == -ENODATA);

	mac[0] = 0xf0;
	mac[5] = 0x21;
	location_keep(&aps, mac, -70);
	CHECK(location_format(&aps, BOOT, 61234, json, sizeof(json)) > 0);
	CHECK(strcmp(json, "{\"aps\":[{\"mac\":\"a4:2b:b0:12:34:56\",\"rss\":-51},"
			   "{\"mac\":\"f0:2b:b0:12:34:21\",\"rss\":-70}],\"boot\":42,\"t\":61234}") == 0);

	/* A buffer too short for it is never overrun. */
	for (size_t length = 0; length < strlen(json) + 1; length++) {
		char small[LOCATION_JSON_MAX];

		memset(small, '#', sizeof(small));
		CHECK(location_format(&aps, BOOT, 61234, small, length) == -ENOSPC);
		CHECK(length == 0 || memchr(small, '\0', length) != NULL);
		CHECK(length >= sizeof(small) || small[length] == '#');
	}
}

static void test_the_longest_message_fits(void)
{
	struct location_aps aps = { 0 };
	char json[LOCATION_JSON_MAX];
	cJSON *parsed;
	int length;

	for (int n = 0; n < LOCATION_APS_MAX; n++) {
		uint8_t mac[6] = { 0xfc, 0xff, 0xff, 0xff, 0xff, (uint8_t)(0xff - n) };

		location_keep(&aps, mac, -127);
	}
	CHECK(aps.count == LOCATION_APS_MAX);

	CHECK(location_format(&aps, UINT32_MAX, INT64_MAX, json, sizeof(json) - 1) == -ENOSPC);
	length = location_format(&aps, UINT32_MAX, INT64_MAX, json, sizeof(json));
	CHECK(length == LOCATION_JSON_MAX - 1);

	parsed = cJSON_Parse(json);
	CHECK(parsed != NULL);
	CHECK(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(parsed, "aps")) == LOCATION_APS_MAX);
	cJSON_Delete(parsed);
}

/* ---- when, and what holds it ---------------------------------------------------------- */

static void test_the_first_comes_a_minute_into_the_first_connection(void)
{
	cJSON *parsed;
	const cJSON *item;

	start_over();

	/* Not connected: never. */
	ticks_for(3 * HOUR);
	CHECK(fake.scans == 0);

	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS - SECOND);
	CHECK(fake.scans == 0);
	ticks_for(SECOND);
	CHECK(fake.scans == 1);

	/* The 2.4 GHz band, actively, every network, every result. */
	CHECK(fake.last_params.bands == BIT(WIFI_FREQ_BAND_2_4_GHZ));
	CHECK(fake.last_params.scan_type == WIFI_SCAN_TYPE_ACTIVE);
	CHECK(fake.last_params.ssids[0] == NULL);
	CHECK(fake.last_params.max_bss_cnt == 0);
	CHECK(fake.last_params.dwell_time_active == 0 && fake.last_params.dwell_time_passive == 0);

	/* Nothing goes before the scan has ended. */
	ticks_for(2 * SECOND);
	CHECK(fake.published == 0);
	the_scan_hears_the_room();
	CHECK(fake.published == 1);

	/* The two that say where the board is, strongest first, office with its best signal. */
	CHECK(sent_aps(&parsed) == 3);
	item = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(parsed, "aps"), 0);
	CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(item, "mac")->valuestring, "a4:2b:b0:12:34:56") == 0);
	CHECK(cJSON_GetObjectItemCaseSensitive(item, "rss")->valuedouble == -51);
	item = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(parsed, "aps"), 2);
	CHECK(strcmp(cJSON_GetObjectItemCaseSensitive(item, "mac")->valuestring, "00:11:22:33:44:55") == 0);
	CHECK(cJSON_GetObjectItemCaseSensitive(parsed, "boot")->valuedouble == BOOT);
	CHECK(cJSON_GetObjectItemCaseSensitive(parsed, "t")->valuedouble == (double)fake.now_ms);
	/* Nothing else in it, and never a network's name. */
	CHECK(cJSON_GetArraySize(parsed) == 3);
	CHECK(strstr(fake.json, "MyNetwork") == NULL && strstr(fake.json, "iPhone") == NULL);
	CHECK(strstr(fake.json, "eduroam") == NULL && strstr(fake.json, "ssid") == NULL);
	CHECK(strstr(fake.json, "7a:11") == NULL);
	cJSON_Delete(parsed);

	/* Results that come when no scan of this module's is on are not taken. */
	{
		static const uint8_t other[6] = { 0x00, 0x99, 0x99, 0x99, 0x99, 0x99 };

		struct wifi_status status = { .status = 0 };

		heard_ap(other, -20, "x");
		CHECK(heard.count == 3);
		fake.callback->info = &status;
		fake.callback->handler(fake.callback, NET_EVENT_WIFI_SCAN_DONE, NULL);
		CHECK(fake.posts == 0);
		CHECK(fake.published == 1);
	}
}

static void test_then_every_six_hours(void)
{
	long long first;

	start_over();
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS);
	CHECK(fake.scans == 1);
	first = plan.scanned_at;
	the_scan_hears_the_room();

	ticks_for(LOCATION_PERIOD_MS - (fake.now_ms - first) - SECOND);
	CHECK(fake.scans == 1);
	ticks_for(SECOND);
	CHECK(fake.scans == 2);
	CHECK(plan.scanned_at - first == LOCATION_PERIOD_MS);
	the_scan_hears_the_room();
	CHECK(fake.published == 2);

	ticks_for(LOCATION_PERIOD_MS);
	CHECK(fake.scans == 3);

	/* A new connection is no reason for another: the period holds across them. */
	scan_ends();
	disconnect_cloud();
	ticks_for(10 * SECOND);
	connect_cloud();
	ticks_for(2 * HOUR);
	CHECK(fake.scans == 3);
}

static void test_a_new_connection_waits_its_minute(void)
{
	start_over();
	connect_cloud();
	ticks_for(30 * SECOND);
	disconnect_cloud();
	ticks_for(5 * SECOND);
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS - SECOND);
	CHECK(fake.scans == 0);
	ticks_for(SECOND);
	CHECK(fake.scans == 1);
}

static void test_report_asks_at_once_and_the_floor_holds(void)
{
	start_over();
	connect_cloud();

	/* Asked for: no minute's wait. */
	ticks_for(5 * SECOND);
	CHECK(location_request() == LOCATION_GO);
	CHECK(fake.scans == 1);
	CHECK(location_request() == LOCATION_SCANNING);
	the_scan_hears_the_room();
	CHECK(fake.published == 1);

	/* That was the boot's first: the minute brings none. */
	ticks_for(2 * MINUTE);
	CHECK(fake.scans == 1);

	/* Ten minutes from the start of the last, and not a second sooner. */
	CHECK(location_request() == LOCATION_FLOOR);
	fake.now_ms = plan.scanned_at + LOCATION_FLOOR_MS - 1;
	CHECK(location_request() == LOCATION_FLOOR);
	fake.now_ms++;
	CHECK(location_request() == LOCATION_GO);
	CHECK(fake.scans == 2);
	scan_ends();

	/* Asked every second for two hours: one scan every ten minutes. */
	for (int i = 0; i < 2 * 3600; i++) {
		fake.now_ms += SECOND;
		(void)location_request();
		location_on_tick();
		scan_ends();
	}
	CHECK(fake.scans == 2 + 12);

	/* A report starts the six hours again. */
	{
		long long asked = plan.scanned_at;

		ticks_for(LOCATION_PERIOD_MS - (fake.now_ms - asked) - SECOND);
		CHECK(fake.scans == 14);
		ticks_for(SECOND);
		CHECK(fake.scans == 15);
	}
}

static void test_never_during_an_update(void)
{
	static const enum ota_state busy[] = {
		OTA_AWAITING_USER, OTA_RETRY_WAIT, OTA_REFRESHING, OTA_STARTING, OTA_DOWNLOADING,
		OTA_VERIFYING, OTA_COMMITTING, OTA_REBOOTING, OTA_TESTING,
#if defined(CONFIG_APP_BT_OTA)
		OTA_BLUETOOTH,
#endif
	};

	for (size_t i = 0; i < ARRAY_SIZE(busy); i++) {
		start_over();
		connect_cloud();
		fake.ota = busy[i];
		ticks_for(LOCATION_PERIOD_MS * 2);
		CHECK(fake.scans == 0);
		CHECK(location_request() == LOCATION_UPDATE);
		CHECK(fake.scans == 0);

		/* As soon as it is over, the one that was due. */
		fake.ota = OTA_IDLE;
		ticks_for(SECOND);
		CHECK(fake.scans == 1);
	}

	/* The floor and an update both: the update is what the answer says. */
	start_over();
	connect_cloud();
	CHECK(location_request() == LOCATION_GO);
	scan_ends();
	fake.ota = OTA_DOWNLOADING;
	CHECK(location_request() == LOCATION_UPDATE);
}

#if defined(CONFIG_APP_BT_OTA)
static void test_never_while_bluetooth_is_open(void)
{
	start_over();
	connect_cloud();
	fake.bluetooth_open = true;
	ticks_for(3 * MINUTE);
	CHECK(fake.scans == 0);
	CHECK(location_request() == LOCATION_BLUETOOTH);
	fake.bluetooth_open = false;
	ticks_for(SECOND);
	CHECK(fake.scans == 1);
}
#endif

static void test_what_does_not_get_sent(void)
{
	static const uint8_t one[6] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55 };
	static const uint8_t phone[6] = { 0x7a, 0x11, 0x22, 0x33, 0x44, 0x55 };

	/* Fewer than two that count: nothing, and the boot's first is done all the same. */
	start_over();
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS);
	CHECK(fake.scans == 1);
	heard_ap(one, -40, "a");
	heard_ap(one, -30, "a");
	heard_ap(phone, -20, "b");
	scan_ends();
	CHECK(fake.published == 0);
	ticks_for(LOCATION_FLOOR_MS * 3);
	CHECK(fake.scans == 1);

	/* The connection went during the scan: nothing, and the first is still to do, after the floor. */
	start_over();
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS);
	CHECK(fake.scans == 1);
	disconnect_cloud();
	the_scan_hears_the_room();
	CHECK(fake.published == 0);
	connect_cloud();
	ticks_for(LOCATION_FLOOR_MS - LOCATION_SETTLE_MS - SECOND);
	CHECK(fake.scans == 1);
	ticks_for(LOCATION_SETTLE_MS + SECOND);
	CHECK(fake.scans == 2);
	the_scan_hears_the_room();
	CHECK(fake.published == 1);

	/* The library did not take it: the same. */
	start_over();
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS);
	fake.publish_result = -EAGAIN;
	the_scan_hears_the_room();
	CHECK(fake.published == 0);
	CHECK(!plan.first_done);
}

static void test_a_busy_or_silent_wifi_stack(void)
{
	start_over();
	connect_cloud();

	/* The supplicant is scanning for itself: a minute later, and that is no scan for the floor. */
	fake.scan_result = -EBUSY;
	ticks_for(LOCATION_SETTLE_MS);
	CHECK(fake.scans == 1);
	CHECK(!collecting && !plan.scanning);
	CHECK(location_request() == LOCATION_RETRY);
	ticks_for(LOCATION_RETRY_MS - SECOND);
	CHECK(fake.scans == 1);
	fake.scan_result = 0;
	ticks_for(SECOND);
	CHECK(fake.scans == 2);

	/* Its end never comes, or the main loop's queue was full for it: what came goes after 40 s. */
	fake.queue_full = true;
	{
		static const uint8_t a[6] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55 };
		static const uint8_t b[6] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x56 };

		heard_ap(a, -40, "a");
		heard_ap(b, -50, "b");
	}
	scan_ends();
	fake.queue_full = false;
	ticks_for(LOCATION_SCAN_LIMIT_MS - 2 * SECOND);
	CHECK(fake.published == 0 && plan.scanning);
	ticks_for(2 * SECOND);
	CHECK(fake.published == 1 && !plan.scanning && !collecting);
}

static void test_a_cloud_that_refuses_the_topic(void)
{
	start_over();
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS);
	the_scan_hears_the_room();
	CHECK(fake.published == 1);

	/* AWS IoT closes the connection at once: once is not enough to tell. */
	fake.now_ms += 2 * SECOND;
	disconnect_cloud();
	CHECK(plan.refusals == 1 && !plan.off);

	/* The next, after the six hours, the same: no more until a restart. */
	connect_cloud();
	ticks_for(LOCATION_PERIOD_MS);
	CHECK(fake.scans == 2);
	the_scan_hears_the_room();
	CHECK(fake.published == 2);
	fake.now_ms += LOCATION_PROOF_MS - 1;
	disconnect_cloud();
	CHECK(plan.refusals == 2 && plan.off);

	connect_cloud();
	ticks_for(2 * LOCATION_PERIOD_MS);
	CHECK(fake.scans == 2);
	CHECK(location_request() == LOCATION_OFF);
	CHECK(fake.scans == 2);

	/* A connection that outlived one is proof: later ends say nothing. */
	start_over();
	connect_cloud();
	ticks_for(LOCATION_SETTLE_MS);
	the_scan_hears_the_room();
	ticks_for(LOCATION_PROOF_MS / SECOND * SECOND);
	disconnect_cloud();
	CHECK(plan.refusals == 0 && plan.proven);
	connect_cloud();
	ticks_for(LOCATION_PERIOD_MS);
	the_scan_hears_the_room();
	fake.now_ms += SECOND;
	disconnect_cloud();
	CHECK(plan.refusals == 0 && !plan.off);

	/* An end with no location just before it is nothing either. */
	start_over();
	connect_cloud();
	ticks_for(30 * SECOND);
	disconnect_cloud();
	CHECK(plan.refusals == 0);
}

int main(void)
{
	test_only_addresses_that_stay_put();
	test_each_once_strongest_first_and_ten_at_most();
	test_what_is_kept_is_the_best_ten_whatever_comes();
	test_the_message();
	test_the_longest_message_fits();
	test_the_first_comes_a_minute_into_the_first_connection();
	test_then_every_six_hours();
	test_a_new_connection_waits_its_minute();
	test_report_asks_at_once_and_the_floor_holds();
	test_never_during_an_update();
#if defined(CONFIG_APP_BT_OTA)
	test_never_while_bluetooth_is_open();
#endif
	test_what_does_not_get_sent();
	test_a_busy_or_silent_wifi_stack();
	test_a_cloud_that_refuses_the_topic();

	printf("%d location checks, %d failed\n", checks, failures);
	return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
