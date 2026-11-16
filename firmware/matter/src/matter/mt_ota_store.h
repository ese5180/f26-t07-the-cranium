/*
 * The image this board offers to its devices as OTA provider, in an external-flash partition (ota_store): a
 * 32-byte header (mt_ota.h) and the image after it. Written over the serial console in chunks
 * (tools/matter_ota_upload.py), read by BDX.
 */
#ifndef MT_OTA_STORE_H_
#define MT_OTA_STORE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mt_ota.h"

int mt_ota_store_begin(const struct mt_ota_image *img);
int mt_ota_store_write(uint32_t offset, const uint8_t *data, size_t len);
/* Marks the image complete by writing its header last. */
int mt_ota_store_finish(void);
bool mt_ota_store_image(struct mt_ota_image *out);
int mt_ota_store_read(uint32_t offset, uint8_t *out, size_t len);

#endif /* MT_OTA_STORE_H_ */
