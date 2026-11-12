/*
 * See border_router.h.
 */
#include "border_router.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/net/wifi_credentials.h>

#include "matter_policy.h"

LOG_MODULE_REGISTER(border_router, LOG_LEVEL_INF);

static struct net_mgmt_event_callback wifi_cb;
static uint8_t wifi_channel;

static void check_channel(struct net_if *iface)
{
	struct wifi_iface_status status = {0};

	if (net_mgmt(NET_REQUEST_WIFI_IFACE_STATUS, iface, &status, sizeof(status)) != 0) {
		return;
	}
	wifi_channel = (status.band == WIFI_FREQ_BAND_2_4_GHZ && status.channel > 0 && status.channel <= 14)
			       ? (uint8_t)status.channel
			       : 0;
	LOG_INF("Wi-Fi joined, channel %d: border router backbone up", status.channel);
	if (!mp_thread_channel_clear(CONFIG_CRANIUM_THREAD_CHANNEL, wifi_channel)) {
		LOG_WRN("Thread channel %d overlaps Wi-Fi channel %u; %u would be clear (CONFIG_CRANIUM_THREAD_CHANNEL)",
			CONFIG_CRANIUM_THREAD_CHANNEL, wifi_channel, mp_pick_thread_channel(wifi_channel));
	}
}

static void wifi_event(struct net_mgmt_event_callback *cb, uint64_t event, struct net_if *iface)
{
	ARG_UNUSED(cb);

	if (event == NET_EVENT_WIFI_CONNECT_RESULT) {
		const struct wifi_status *status = (const struct wifi_status *)cb->info;

		if (status != NULL && status->status != 0) {
			LOG_WRN("Wi-Fi join failed (%d); the supplicant keeps trying", status->status);
			return;
		}
		check_channel(iface);
	} else if (event == NET_EVENT_WIFI_DISCONNECT_RESULT) {
		wifi_channel = 0;
		LOG_WRN("Wi-Fi lost: Thread keeps running, the backbone is down");
	}
}

int border_router_start(void)
{
	struct net_if *iface = net_if_get_first_wifi();

	if (iface == NULL) {
		LOG_ERR("no Wi-Fi interface");
		return -ENODEV;
	}
	net_mgmt_init_event_callback(&wifi_cb, wifi_event,
				     NET_EVENT_WIFI_CONNECT_RESULT | NET_EVENT_WIFI_DISCONNECT_RESULT);
	net_mgmt_add_event_callback(&wifi_cb);

	if (wifi_credentials_is_empty()) {
		LOG_WRN("no Wi-Fi network stored: add one with \"wifi cred add\", then restart");
		return 0;
	}
	int err = net_mgmt(NET_REQUEST_WIFI_CONNECT_STORED, iface, NULL, 0);

	if (err != 0) {
		LOG_ERR("Wi-Fi join could not start: %d", err);
	}
	return err;
}

uint8_t border_router_wifi_channel(void)
{
	return wifi_channel;
}
