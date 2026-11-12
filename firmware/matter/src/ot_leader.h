/*
 * The board's Thread network: form it if there is none (random keys and PAN ID, channel
 * CONFIG_CRANIUM_THREAD_CHANNEL), become leader, and run the SRP server that Matter devices register with, so the
 * commissioner can find them by DNS-SD. Plain OpenThread, no Matter library.
 */
#ifndef OT_LEADER_H_
#define OT_LEADER_H_

#include <stddef.h>
#include <stdint.h>

/* Forms or resumes the network and turns the SRP server on. 0, or a negative errno. */
int ot_leader_start(void);

/* The active operational dataset as TLVs, for handing to a device being commissioned. */
int ot_leader_dataset(uint8_t *out, size_t cap, size_t *len);

/* "leader", "router", "child", "detached" or "disabled". */
const char *ot_leader_role(void);

#endif /* OT_LEADER_H_ */
