/*
 * The Bluetooth relay, behind CONFIG_APP_BLE_RELAY (from 1.21.0, nRF7002 DK, opt-in): when the board has
 * had no Wi-Fi for a minute, a phone running the Cranium app can carry its connection to AWS IoT over
 * Bluetooth LE. docs/ble-relay.md has the design and the security argument.
 *
 * The board keeps its own TLS and MQTT session with its own certificate. The phone only moves bytes
 * between an L2CAP channel and a TCP connection to the AWS IoT endpoint, like a router: it never sees
 * them in plain text and holds no credential of the board's. Below the TLS layer, nothing in cloud.c
 * changes: while ble_relay_route_begin() is in force, the TCP socket that the TLS socket asks for is this
 * file's relay socket, and the endpoint's name resolves to an address that only the relay socket takes.
 *
 * On the air: a GATT service with the channel's PSM (read with no pairing, as Apple's L2CAP guidance has
 * it), and an L2CAP channel that needs no pairing either, because TLS protects what it carries.
 * policy/ble_relay_proto.h has the frames, policy/ble_relay_policy.h the decisions.
 */

#ifndef BLE_RELAY_H_
#define BLE_RELAY_H_

#include <stdbool.h>

#include <zephyr/bluetooth/uuid.h>

/* D38F3C14-34A8-4CDD-8E9A-BDB7FE83A2F0 the service, ...3C15... its PSM characteristic. */
#define BLE_RELAY_SERVICE_UUID_VAL BT_UUID_128_ENCODE(0xd38f3c14, 0x34a8, 0x4cdd, 0x8e9a, 0xbdb7fe83a2f0)
#define BLE_RELAY_PSM_UUID_VAL     BT_UUID_128_ENCODE(0xd38f3c15, 0x34a8, 0x4cdd, 0x8e9a, 0xbdb7fe83a2f0)

/* At start, on the main loop. */
int ble_relay_init(void);

/*
 * Once a second, on the main loop: offer the relay or stop, end a stream whose OPENED never came, and say
 * what changed on the console. True when the relayed cloud connection should end now, because Wi-Fi has
 * been back for BLE_RELAY_HANDBACK_SECONDS: the caller disconnects, and connects again over Wi-Fi.
 */
bool ble_relay_on_tick(void);

/* A phone's relay channel is open. Any thread. */
bool ble_relay_is_ready(void);

/*
 * On the connection thread, around aws_iot_connect(): the TCP socket made in between, and the resolution
 * of host, go over the relay. host is copied.
 */
void ble_relay_route_begin(const char *host);
void ble_relay_route_end(void);

#endif /* BLE_RELAY_H_ */
