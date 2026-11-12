/*
 * This board's own firmware update over Matter: the OTA Software Update Requestor. When the phone announces
 * itself as OTA provider (or later, on request), the board opens CASE to the phone, asks QueryImage, downloads
 * the image over BDX straight into MCUboot's second slot, asks ApplyUpdate and restarts into the new image as a
 * test; after the restart it confirms the image and reports NotifyUpdateApplied.
 */
#ifndef MT_OTA_REQ_H_
#define MT_OTA_REQ_H_

#include <stdint.h>

int mt_ota_req_start(uint64_t provider_node, uint16_t endpoint);
/* After a restart: confirms a new image and tells the provider. */
void mt_ota_req_boot(void);
const char *mt_ota_req_state(void);

#endif /* MT_OTA_REQ_H_ */
