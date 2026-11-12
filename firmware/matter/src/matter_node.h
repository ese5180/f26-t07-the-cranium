/* This board as a Matter device: see matter_node.c. */
#ifndef MATTER_NODE_H_
#define MATTER_NODE_H_

void matter_node_start(void);
/* Advertises the operational record on Wi-Fi (after Wi-Fi comes up or the phone adds the board). */
void matter_node_dnssd_update(void);

#endif /* MATTER_NODE_H_ */
