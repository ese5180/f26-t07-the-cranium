/*
 * Talking to commissioned devices over Thread: finding a device's address through this board's SRP server,
 * CASE (Sigma1 to Sigma3) to open a secure session with it, and Interaction Model commands on that session, with
 * MRP (acknowledgements and retransmissions) over UDP. One operation at a time; sessions are kept for reuse.
 */
#ifndef MT_CONTROLLER_H_
#define MT_CONTROLLER_H_

#include <stdbool.h>
#include <stdint.h>

#include <zephyr/kernel.h>

#include "mt_tlv.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Called with 0 on success, or a negative errno, or a positive IM status. */
typedef void (*mt_ctl_done)(uint64_t node_id, int result);

int mt_ctl_init(void);

/* Opens (or reuses) a CASE session with a node. */
int mt_ctl_connect(uint64_t node_id, mt_ctl_done done);

/* Sends a command on the node's session (opening one first if needed). fields may be NULL. */
int mt_ctl_invoke(uint64_t node_id, uint16_t endpoint, uint32_t cluster, uint32_t command,
		  void (*fields)(struct mt_tlv_writer *w, void *ctx), void *ctx, mt_ctl_done done);

/* Forgets a node's session (after it was removed, or to force a new CASE). */
void mt_ctl_drop(uint64_t node_id);

/* After a restart: opens sessions to every stored node, retrying with a growing delay until each answers. */
void mt_ctl_reconnect_all(void);

bool mt_ctl_busy(void);

/*
 * The same on the phone's fabric, as a device: a command to the phone (an OTA provider), at a known address
 * (NULL: resolve through SRP), with the response's fields handed to response().
 */
#include <zephyr/net/socket.h>
int mt_ctl_invoke_phone(uint64_t node_id, const struct sockaddr_in6 *addr, uint16_t endpoint, uint32_t cluster,
			uint32_t command, void (*fields)(struct mt_tlv_writer *w, void *ctx), void *ctx,
			void (*response)(const uint8_t *fields, size_t len), mt_ctl_done done);

/*
 * A non-IM exchange (BDX) on the session the last operation opened: rx() gets each message, send() sends one,
 * end() closes it and calls done.
 */
int mt_ctl_exchange_begin(void (*rx)(uint8_t opcode, uint16_t protocol, const uint8_t *body, size_t len),
			  mt_ctl_done done);
int mt_ctl_exchange_send(uint16_t protocol, uint8_t opcode, const uint8_t *body, size_t len, bool new_exchange);
void mt_ctl_exchange_end(int result);
/* Runs fn on the controller's work queue. */
void mt_ctl_submit(struct k_work *work);

#ifdef __cplusplus
}
#endif

#endif /* MT_CONTROLLER_H_ */
