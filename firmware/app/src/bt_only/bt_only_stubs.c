/*
 * What the code that every board shares asks of Wi-Fi, the cloud, the device key and the stuck timers,
 * answered on a board with Bluetooth only (CONFIG_APP_BT_ONLY), which has none of them: there is no
 * network stored, no link, no connection and no key, and nothing can be stored there.
 *
 * Only questions and things that do nothing. Nothing here can send anything anywhere: the device
 * shadow, the jobs and the events have no function on this board at all, so code that tried to use
 * them would not link. bt_only_check.py checks the linked image for them as well.
 *
 * The console's Wi-Fi, cloud and certificate commands are still in its table, and say "not on this
 * board" (console_cmd.c) before they could get here.
 */

#include <errno.h>
#include <string.h>

#include <zephyr/sys/util.h>

#include "cloud.h"
#include "console_port.h"
#include "net.h"
#include "stuck.h"

/* ---- net.h: no Wi-Fi chip ------------------------------------------------------------ */

bool net_is_up(void)
{
	return false;
}

bool net_has_credentials(void)
{
	return false;
}

int net_credentials_set(const char *ssid, size_t ssid_len, enum net_security security,
			const char *passphrase, size_t passphrase_len)
{
	ARG_UNUSED(ssid);
	ARG_UNUSED(ssid_len);
	ARG_UNUSED(security);
	ARG_UNUSED(passphrase);
	ARG_UNUSED(passphrase_len);
	return -ENOTSUP;
}

int net_credentials_clear(void)
{
	return 0;
}

void net_status_get(struct net_status *status)
{
	memset(status, 0, sizeof(*status));
}

/* ---- cloud.h: no connection, ever ------------------------------------------------------ */

void cloud_disconnect(void)
{
}

bool cloud_is_connected(void)
{
	return false;
}

bool cloud_is_connecting(void)
{
	return false;
}

void cloud_stats_get(struct cloud_stats *out)
{
	memset(out, 0, sizeof(*out));
	out->state = CLOUD_STATE_IDLE;
	out->connected_at_ms = -1;
	out->last_error_ms = -1;
	out->last_publish_ms = -1;
	out->last_receive_ms = -1;
}

const char *cloud_subscription(size_t index)
{
	ARG_UNUSED(index);
	return NULL;
}

/* ---- console_port.h: no key or certificate for AWS IoT --------------------------------- */

int console_port_keygen_create(const char **reason)
{
	*reason = "no AWS IoT on this board";
	return -ENOTSUP;
}

int console_port_keygen_store(void)
{
	return -ENOTSUP;
}

int console_port_keygen_print(void)
{
	return -ENOTSUP;
}

void console_port_keygen_end(void)
{
}

int console_port_store_certificate(enum console_stream_kind kind, const uint8_t *der,
				   size_t length)
{
	ARG_UNUSED(kind);
	ARG_UNUSED(der);
	ARG_UNUSED(length);
	return -ENOTSUP;
}

/* ---- stuck.h: none of its timers has anything to watch here ---------------------------- */

/*
 * wifi_silent and no_cloud watch Wi-Fi and the cloud, and update_stall a cloud update, none of which
 * this board has. A window over Bluetooth has limits of its own, the trial its deadline, and a main
 * loop that hangs the watchdog. So nothing restarts this board for being stuck, and nothing is counted.
 */
uint8_t stuck_count(void)
{
	return 0;
}

const char *stuck_reason_name(void)
{
	return "none";
}
