/*
 * The Wi-Fi side of the Thread border router (nRF7002 DK): joins the stored Wi-Fi network, and says when the
 * Thread channel is too close to the Wi-Fi channel. Zephyr's OpenThread border router starts by itself once the
 * Wi-Fi interface is up and takes it as the backbone.
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Starts joining the Wi-Fi network stored with "wifi cred add". 0, or a negative errno. */
int border_router_start(void);

/* The 2.4 GHz Wi-Fi channel in use, 0 when there is none (not joined, or 5 GHz). */
uint8_t border_router_wifi_channel(void);

#ifdef __cplusplus
}
#endif
