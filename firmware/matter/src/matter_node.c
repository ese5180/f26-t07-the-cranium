/*
 * This board as a Matter device, put together: the platform hooks the device's clusters need (joining Wi-Fi
 * from the phone's credentials, the board's version), the operational DNS-SD record on Wi-Fi so the phone finds
 * the board after commissioning, and starting it all (advertising while not commissioned, finishing an update
 * after a restart).
 */
#include <stdio.h>
#include <string.h>

#include <app_version.h>
#include <openthread.h>
#include <openthread/mdns.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/net_if.h>
#if defined(CONFIG_WIFI)
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/wifi_credentials.h>
#include <zephyr/net/wifi_mgmt.h>
#endif

#include "matter_node.h"
#include "matter_policy.h"
#include "mt_controller.h"
#include "mt_dev_im.h"
#include "mt_node.h"
#include "mt_ota_req.h"
#include "mt_peripheral.h"

LOG_MODULE_REGISTER(matter_node, LOG_LEVEL_INF);

uint32_t mt_board_software_version(void)
{
	return APPVERSION; /* major << 24 | minor << 16 | patch << 8 | tweak */
}

#if defined(CONFIG_WIFI)
static char ssid[33];

static int wifi_add(const uint8_t *s, size_t sl, const uint8_t *p, size_t pl)
{
	if (sl == 0 || sl > 32) {
		return -EINVAL;
	}
	memcpy(ssid, s, sl);
	ssid[sl] = '\0';
	return wifi_credentials_set_personal(ssid, sl, pl ? WIFI_SECURITY_TYPE_PSK : WIFI_SECURITY_TYPE_NONE, NULL, 0,
					     (const char *)p, pl, 0, 0, 0);
}

static int wifi_connect(void)
{
	struct net_if *iface = net_if_get_first_wifi();

	return iface ? net_mgmt(NET_REQUEST_WIFI_CONNECT_STORED, iface, NULL, 0) : -ENODEV;
}
#endif

static int thread_add(const uint8_t *dataset, size_t len)
{
	/* This board leads its own Thread network: a phone's dataset is not taken. */
	ARG_UNUSED(dataset);
	ARG_UNUSED(len);
	return -ENOTSUP;
}

static uint64_t announced_node;
static uint16_t announced_ep;

static void start_update(struct k_work *w)
{
	ARG_UNUSED(w);
	int err = mt_ota_req_start(announced_node, announced_ep);

	if (err) {
		LOG_WRN("update over Matter could not start: %d", err);
	}
}
static K_WORK_DELAYABLE_DEFINE(update_work, start_update);

static void ota_announced(uint64_t node, uint16_t endpoint)
{
	announced_node = node;
	announced_ep = endpoint;
	/* after the answer to the announcement is out */
	k_work_reschedule(&update_work, K_SECONDS(1));
}

static const struct mt_dev_platform platform = {
#if defined(CONFIG_WIFI)
	.wifi_add = wifi_add,
	.wifi_connect = wifi_connect,
	.wifi = true,
#endif
	.thread_add = thread_add,
	.software_version = APPVERSION,
	.software_version_string = APP_VERSION_STRING,
	.ota_announced = ota_announced,
};

void matter_node_dnssd_update(void)
{
#if defined(CONFIG_OPENTHREAD_MULTICAST_DNS)
	const struct mt_node_fabric *f = mt_node_fabric();
	struct net_if *iface = net_if_get_first_wifi();
	static char host[24];
	static char instance[34];
	static otIp6Address addrs[4];
	otMdnsHost h = {0};
	otMdnsService s = {0};
	uint8_t count = 0;

	if (!f->present || iface == NULL) {
		return;
	}
	struct net_if_ipv6 *ipv6 = iface->config.ip.ipv6;

	for (int i = 0; ipv6 && i < NET_IF_MAX_IPV6_ADDR && count < ARRAY_SIZE(addrs); i++) {
		if (ipv6->unicast[i].is_used) {
			memcpy(addrs[count++].mFields.m8, &ipv6->unicast[i].address.in6_addr, 16);
		}
	}
	snprintf(host, sizeof(host), "CRANIUM%08X", (unsigned int)(f->node_id & 0xFFFFFFFFu));
	snprintf(instance, sizeof(instance), "%02X%02X%02X%02X%02X%02X%02X%02X-%016llX", f->compressed_id[0],
		 f->compressed_id[1], f->compressed_id[2], f->compressed_id[3], f->compressed_id[4],
		 f->compressed_id[5], f->compressed_id[6], f->compressed_id[7], (unsigned long long)f->node_id);
	h.mHostName = host;
	h.mAddresses = addrs;
	h.mAddressesLength = count;
	s.mHostName = host;
	s.mServiceInstance = instance;
	s.mServiceType = "_matter._tcp";
	s.mPort = 5540;
	openthread_mutex_lock();
	otInstance *ot = openthread_get_default_instance();
	otError e1 = otMdnsRegisterHost(ot, &h, 1, NULL);
	otError e2 = otMdnsRegisterService(ot, &s, 2, NULL);

	openthread_mutex_unlock();
	if (e1 == OT_ERROR_NONE && e2 == OT_ERROR_NONE) {
		LOG_INF("advertised on Wi-Fi as %s._matter._tcp", instance);
	}
#endif
}

void matter_node_start(void)
{
	char qr[23];
	char manual[12];

	if (mt_node_init() != 0) {
		LOG_ERR("the Matter device could not start");
		return;
	}
	mt_dev_im_set_platform(&platform);
	mt_ota_req_boot();
	if (mt_node_commissionable()) {
		mp_qr_payload(MT_NODE_VENDOR_ID, MT_NODE_PRODUCT_ID, 0x02, MT_NODE_DISCRIMINATOR, MT_NODE_PASSCODE, qr);
		mp_manual_code(MT_NODE_DISCRIMINATOR, MT_NODE_PASSCODE, manual);
		LOG_INF("add this board in the app: QR %s, code %s (Matter test credentials)", qr, manual);
		(void)mt_peripheral_open();
	} else {
		matter_node_dnssd_update();
	}
}
