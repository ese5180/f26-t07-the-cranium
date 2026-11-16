/*
 * The Bluetooth LE central side of commissioning: find the device advertising the CHIPoBLE service (0xFFF6) with
 * the right discriminator, connect, raise the MTU, find the C1 (write) and C2 (indicate) characteristics,
 * subscribe to C2, and then carry BTP packets both ways. The BTP framing is mt_btp.c's; what the packets mean is
 * the caller's.
 */
#ifndef MT_BLE_H_
#define MT_BLE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct mt_ble_callbacks {
	/* The link is ready for BTP: subscribed to C2. att_mtu is the agreed ATT MTU. */
	void (*ready)(uint16_t att_mtu);
	/* A packet indicated on C2. */
	void (*received)(const uint8_t *pkt, size_t len);
	/* A write to C1 completed (err 0) or failed. */
	void (*written)(int err);
	/* No device found, the connection failed or was lost. */
	void (*closed)(int reason);
};

/*
 * Scans for a commissionable device. With is_short, only the top 4 bits of the 12-bit discriminator are compared
 * (a manual pairing code carries no more). Gives up after timeout_ms with closed(-ETIMEDOUT).
 */
int mt_ble_connect(uint16_t discriminator, bool is_short, uint32_t timeout_ms, const struct mt_ble_callbacks *cb);
/* Writes one BTP packet to C1. One write at a time: wait for written(). */
int mt_ble_write(const uint8_t *pkt, size_t len);
void mt_ble_close(void);

/* Parses CHIPoBLE service data (after the 0xFFF6 UUID): opcode, 12-bit discriminator, vendor and product. */
bool mt_ble_parse_service_data(const uint8_t *data, size_t len, uint16_t *discriminator, uint16_t *vendor,
			       uint16_t *product);

#ifdef __cplusplus
}
#endif

#endif /* MT_BLE_H_ */
