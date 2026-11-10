#include "pi_sd.h"

#include <errno.h>
#include <string.h>

/* One more attempt at a read or a write that failed: an SD card in SPI mode drops the odd command. */
#define RETRIES 1

static const struct pi_sd_hooks *hooks;

void pi_sd_set_hooks(const struct pi_sd_hooks *new_hooks)
{
	hooks = new_hooks;
}

static int64_t now_ms(void)
{
	return (hooks != NULL && hooks->now_ms != NULL) ? hooks->now_ms() : 0;
}

static bool present(void)
{
	return hooks == NULL || hooks->present == NULL || hooks->present();
}

static void release_bus(void)
{
	if (hooks != NULL && hooks->release_bus != NULL) {
		hooks->release_bus();
	}
}

/*
 * What an error of the file system means here. A card that is gone explains any error. An
 * operation that took longer than the limit is a timeout even if it ended well: the SD host's own
 * time limits are per command, and a card that is that slow is not one to go on with.
 */
static enum pi_err map(int err, int64_t started)
{
	release_bus();

	if (!present()) {
		return PI_ERR_SD_ABSENT;
	}

	if (now_ms() - started > CONFIG_APP_PI_SD_TIMEOUT_MS) {
		return PI_ERR_SD_TIMEOUT;
	}

	if (err >= 0) {
		return PI_OK;
	}

	if (err == -ENOSPC) {
		return PI_ERR_SD_FULL;
	}

	if (err == -ETIMEDOUT || err == -EAGAIN) {
		return PI_ERR_SD_TIMEOUT;
	}

	return PI_ERR_SD_IO;
}

enum pi_err pi_sd_check(void)
{
	return present() ? PI_OK : PI_ERR_SD_ABSENT;
}

enum pi_err pi_sd_open(struct pi_sd_file *f, const char *path, bool write, bool create)
{
	int64_t started = now_ms();
	fs_mode_t mode = write ? FS_O_RDWR : FS_O_READ;
	int err;

	if (!present()) {
		return PI_ERR_SD_ABSENT;
	}

	if (create) {
		mode |= FS_O_CREATE;
	}

	fs_file_t_init(&f->file);
	err = fs_open(&f->file, path, mode);
	f->open = (err == 0);
	return map(err, started);
}

enum pi_err pi_sd_close(struct pi_sd_file *f)
{
	int64_t started = now_ms();
	int err;

	if (!f->open) {
		return PI_OK;
	}

	err = fs_close(&f->file);
	f->open = false;
	return map(err, started);
}

enum pi_err pi_sd_write(struct pi_sd_file *f, const void *data, size_t len)
{
	int64_t started = now_ms();
	off_t position;
	ssize_t written = -EIO;

	if (!f->open) {
		return PI_ERR_SD_IO;
	}

	position = fs_tell(&f->file);
	if (position < 0) {
		return map((int)position, started);
	}

	for (int attempt = 0; attempt <= RETRIES; attempt++) {
		if (attempt > 0 && fs_seek(&f->file, position, FS_SEEK_SET) != 0) {
			break;
		}

		written = fs_write(&f->file, data, len);
		if (written == (ssize_t)len) {
			return map(0, started);
		}

		/* FatFS writes less than asked when the volume is full: no retry fixes that. */
		if (written >= 0) {
			return map(-ENOSPC, started);
		}

		if (written == -ENOSPC || !present()) {
			break;
		}
	}

	return map(written < 0 ? (int)written : -EIO, started);
}

enum pi_err pi_sd_read_at(struct pi_sd_file *f, uint32_t offset, void *data, size_t len)
{
	int64_t started = now_ms();
	ssize_t got = -EIO;

	if (!f->open) {
		return PI_ERR_SD_IO;
	}

	for (int attempt = 0; attempt <= RETRIES; attempt++) {
		int err = fs_seek(&f->file, (off_t)offset, FS_SEEK_SET);

		if (err != 0) {
			got = err;
			continue;
		}

		got = fs_read(&f->file, data, len);
		if (got == (ssize_t)len) {
			return map(0, started);
		}

		if (got >= 0) {
			/* The file ends before: that is what the file is, not a read that failed. */
			return map(-EIO, started);
		}

		if (!present()) {
			break;
		}
	}

	return map((int)got, started);
}

enum pi_err pi_sd_seek(struct pi_sd_file *f, uint32_t offset)
{
	int64_t started = now_ms();

	if (!f->open) {
		return PI_ERR_SD_IO;
	}

	return map(fs_seek(&f->file, (off_t)offset, FS_SEEK_SET), started);
}

enum pi_err pi_sd_truncate(struct pi_sd_file *f, uint32_t length)
{
	int64_t started = now_ms();

	if (!f->open) {
		return PI_ERR_SD_IO;
	}

	return map(fs_truncate(&f->file, (off_t)length), started);
}

enum pi_err pi_sd_sync(struct pi_sd_file *f)
{
	int64_t started = now_ms();

	if (!f->open) {
		return PI_ERR_SD_IO;
	}

	return map(fs_sync(&f->file), started);
}

enum pi_err pi_sd_size(const char *path, uint32_t *size, bool *exists)
{
	int64_t started = now_ms();
	struct fs_dirent entry;
	int err = fs_stat(path, &entry);

	*size = 0;
	*exists = false;

	if (err == -ENOENT) {
		return map(0, started);
	}

	if (err == 0) {
		if (entry.size > UINT32_MAX) {
			return map(-EFBIG, started);
		}
		*size = (uint32_t)entry.size;
		*exists = true;
	}

	return map(err, started);
}

enum pi_err pi_sd_free(const char *path, uint64_t *bytes)
{
	int64_t started = now_ms();
	struct fs_statvfs stats;
	int err = fs_statvfs(path, &stats);

	*bytes = 0;
	if (err == 0) {
		*bytes = (uint64_t)stats.f_frsize * (uint64_t)stats.f_bfree;
	}

	return map(err, started);
}

enum pi_err pi_sd_remove(const char *path)
{
	int64_t started = now_ms();
	int err = fs_unlink(path);

	return map(err == -ENOENT ? 0 : err, started);
}

enum pi_err pi_sd_mkdir(const char *path)
{
	int64_t started = now_ms();
	int err = fs_mkdir(path);

	return map(err == -EEXIST ? 0 : err, started);
}

enum pi_err pi_sd_save(const char *path, const char *temp, const void *data, size_t len)
{
	struct pi_sd_file f;
	enum pi_err err;
	int64_t started;

	err = pi_sd_remove(temp);
	if (err == PI_OK) {
		err = pi_sd_open(&f, temp, true, true);
	}
	if (err != PI_OK) {
		return err;
	}

	err = pi_sd_write(&f, data, len);
	if (err == PI_OK) {
		err = pi_sd_sync(&f);
	}
	if (pi_sd_close(&f) != PI_OK && err == PI_OK) {
		err = PI_ERR_SD_IO;
	}
	if (err != PI_OK) {
		return err;
	}

	/* FatFS does not rename over a file. Between these two a reset leaves only the new copy. */
	err = pi_sd_remove(path);
	if (err != PI_OK) {
		return err;
	}

	started = now_ms();
	return map(fs_rename(temp, path), started);
}

static enum pi_err load_one(const char *path, void *data, size_t len)
{
	struct pi_sd_file f;
	uint32_t size;
	bool exists;
	enum pi_err err;

	err = pi_sd_size(path, &size, &exists);
	if (err != PI_OK) {
		return err;
	}

	if (!exists || size != len) {
		return PI_ERR_SD_IO;
	}

	err = pi_sd_open(&f, path, false, false);
	if (err != PI_OK) {
		return err;
	}

	err = pi_sd_read_at(&f, 0, data, len);
	(void)pi_sd_close(&f);
	return err;
}

enum pi_err pi_sd_load(const char *path, const char *temp, void *data, size_t len)
{
	enum pi_err err = load_one(path, data, len);

	/* A reset between the two steps of pi_sd_save() leaves only the new copy, under temp. */
	if (err == PI_ERR_SD_IO) {
		err = load_one(temp, data, len);
	}

	return err;
}
