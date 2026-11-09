/*
 * The SD card for Raspberry Pi images: files on a FAT file system, on a microSD card in SPI mode,
 * through Zephyr's SD host over SPI (zephyr,sdhc-spi-slot), its disk access and FatFS
 * (docs/pi-ota.md, "The SD card").
 *
 * This is the layer that pi_dl.c and pi_ota.c use: create, write, read at an offset, seek, truncate,
 * the size of a file and the free space, each with its error mapped to a pi_err, a retry of a read
 * or a write that failed, and a time limit per operation. The SD card shares its SPI bus with the
 * Pi, so after every operation the bus gets clocks with both chip selects high (the release_bus
 * hook): a card may drive its DO (MISO) until it sees them, and it must not while the Pi is
 * selected.
 *
 * Only Zephyr's file system API: tested on the host against an in-memory file system.
 */

#ifndef PI_SD_H_
#define PI_SD_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <zephyr/fs/fs.h>

#include "pi_image.h"

#ifndef CONFIG_APP_PI_SD_TIMEOUT_MS
#define CONFIG_APP_PI_SD_TIMEOUT_MS 5000
#endif

/* Where FatFS mounts the card, and where the update keeps its files there. */
#define PI_SD_MOUNT  "/SD:"
#define PI_SD_DIR    PI_SD_MOUNT "/PIOTA"
#define PI_SD_IMAGE  PI_SD_DIR "/IMAGE.BIN"
#define PI_SD_RECORD PI_SD_DIR "/RECORD.BIN"
#define PI_SD_TEMP   PI_SD_DIR "/RECORD.TMP"

struct pi_sd_hooks {
	/* The card-detect switch: true if a card is in. NULL: assume one is. */
	bool (*present)(void);
	/* Clock the bus with every chip select high, so that the card lets go of MISO. */
	void (*release_bus)(void);
	/* Milliseconds since boot. */
	int64_t (*now_ms)(void);
};

void pi_sd_set_hooks(const struct pi_sd_hooks *hooks);

struct pi_sd_file {
	struct fs_file_t file;
	bool open;
};

/* PI_OK if a card is in. */
enum pi_err pi_sd_check(void);

/* Open path. With write, for reading and writing, and with create, made if it is missing. */
enum pi_err pi_sd_open(struct pi_sd_file *f, const char *path, bool write, bool create);
enum pi_err pi_sd_close(struct pi_sd_file *f);

/* All of len at the current position, or an error. */
enum pi_err pi_sd_write(struct pi_sd_file *f, const void *data, size_t len);
/* Exactly len bytes from offset: a file that ends before is an error (PI_ERR_SD_IO). */
enum pi_err pi_sd_read_at(struct pi_sd_file *f, uint32_t offset, void *data, size_t len);
enum pi_err pi_sd_seek(struct pi_sd_file *f, uint32_t offset);
enum pi_err pi_sd_truncate(struct pi_sd_file *f, uint32_t length);
enum pi_err pi_sd_sync(struct pi_sd_file *f);

/* The size of a file, and whether it exists at all (*size is then 0). */
enum pi_err pi_sd_size(const char *path, uint32_t *size, bool *exists);
/* Free bytes on the file system that holds path. */
enum pi_err pi_sd_free(const char *path, uint64_t *bytes);
/* Removing what does not exist is no error, and neither is making what does. */
enum pi_err pi_sd_remove(const char *path);
enum pi_err pi_sd_mkdir(const char *path);

/* Replace a small file as a whole: written to temp first, then renamed over path. */
enum pi_err pi_sd_save(const char *path, const char *temp, const void *data, size_t len);
/*
 * Read a small file of exactly len bytes, saved with pi_sd_save() and the same temp. PI_ERR_SD_IO
 * if neither is there with that size.
 */
enum pi_err pi_sd_load(const char *path, const char *temp, void *data, size_t len);

#endif /* PI_SD_H_ */
