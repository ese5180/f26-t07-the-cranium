/*
 * This board as a Matter server to its own devices, for one purpose: the OTA provider. A device opens CASE to
 * the board (the board is the responder), asks QueryImage, downloads the image over BDX, and asks ApplyUpdate.
 */
#ifndef MT_SERVER_H_
#define MT_SERVER_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <zephyr/net/socket.h>

/* Takes a received datagram if it belongs to the server; false leaves it to the controller. */
bool mt_server_rx(uint8_t *msg, size_t len, const struct sockaddr_in6 *from);

/* Tells a device that this board has an update for it (AnnounceOTAProvider), through the controller. */
int mt_server_announce(uint64_t node_id, void (*done)(uint64_t node, int result));

const char *mt_server_state(void);

#endif /* MT_SERVER_H_ */
