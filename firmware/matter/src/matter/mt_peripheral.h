/*
 * This board as a commissionable Matter device over Bluetooth LE: it advertises the CHIPoBLE service with its
 * discriminator and test vendor/product, serves C1/C2, runs BTP as the peripheral and PASE as the verifier, and
 * hands the commissioning session's Interaction Model requests to mt_dev_im.c.
 */
#ifndef MT_PERIPHERAL_H_
#define MT_PERIPHERAL_H_

#include <stdbool.h>

/* Starts advertising (15 minutes, as the specification asks of a device that is not commissioned). */
int mt_peripheral_open(void);
void mt_peripheral_close(void);
bool mt_peripheral_advertising(void);

#endif /* MT_PERIPHERAL_H_ */
