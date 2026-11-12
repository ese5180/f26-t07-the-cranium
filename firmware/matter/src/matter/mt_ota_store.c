/*
 * See mt_ota_store.h. The header is written last, so a half-written image is never offered.
 */
#include "mt_ota_store.h"

#include <errno.h>
#include <string.h>

#include <zephyr/storage/flash_map.h>

#define STORE_ID PARTITION_ID(ota_store_partition)

static struct mt_ota_image pending;
static bool writing;

static int open_area(const struct flash_area **fa)
{
	return flash_area_open(STORE_ID, fa);
}

int mt_ota_store_begin(const struct mt_ota_image *img)
{
	const struct flash_area *fa;
	int err = open_area(&fa);

	if (err) {
		return err;
	}
	if (img->length == 0 || img->length > fa->fa_size - MT_OTA_HEADER_LEN) {
		flash_area_close(fa);
		return -EFBIG;
	}
	/* Erase what the image needs, header first so the old one is gone at once. */
	size_t erase = MT_OTA_HEADER_LEN + img->length;

	erase = (erase + 4095) & ~(size_t)4095;
	err = flash_area_erase(fa, 0, erase);
	flash_area_close(fa);
	if (!err) {
		pending = *img;
		writing = true;
	}
	return err;
}

int mt_ota_store_write(uint32_t offset, const uint8_t *data, size_t len)
{
	const struct flash_area *fa;
	int err;

	if (!writing || offset + len > pending.length) {
		return -EINVAL;
	}
	err = open_area(&fa);
	if (err) {
		return err;
	}
	err = flash_area_write(fa, MT_OTA_HEADER_LEN + offset, data, len);
	flash_area_close(fa);
	return err;
}

int mt_ota_store_finish(void)
{
	const struct flash_area *fa;
	uint8_t hdr[MT_OTA_HEADER_LEN];
	int err;

	if (!writing) {
		return -EINVAL;
	}
	mt_ota_make_header(&pending, hdr);
	err = open_area(&fa);
	if (err) {
		return err;
	}
	err = flash_area_write(fa, 0, hdr, sizeof(hdr));
	flash_area_close(fa);
	writing = false;
	return err;
}

bool mt_ota_store_image(struct mt_ota_image *out)
{
	const struct flash_area *fa;
	uint8_t hdr[MT_OTA_HEADER_LEN];
	bool ok;

	if (writing || open_area(&fa) != 0) {
		return false;
	}
	ok = flash_area_read(fa, 0, hdr, sizeof(hdr)) == 0 && mt_ota_parse_header(hdr, out) &&
	     out->length <= fa->fa_size - MT_OTA_HEADER_LEN;
	flash_area_close(fa);
	return ok;
}

int mt_ota_store_read(uint32_t offset, uint8_t *out, size_t len)
{
	const struct flash_area *fa;
	int err = open_area(&fa);

	if (err) {
		return err;
	}
	err = flash_area_read(fa, MT_OTA_HEADER_LEN + offset, out, len);
	flash_area_close(fa);
	return err;
}
