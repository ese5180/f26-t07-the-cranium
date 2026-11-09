/*
 * Host stub of Zephyr's file system API: the part that src/pi/pi_sd.c uses. The test that compiles
 * pi_sd.c (test_pi_ota.c) implements these functions on an in-memory file system.
 */

#ifndef ZEPHYR_FS_FS_H_STUB_
#define ZEPHYR_FS_FS_H_STUB_

#include <stddef.h>
#include <string.h>
#include <sys/types.h>

typedef unsigned char fs_mode_t;

#define FS_O_READ   0x01
#define FS_O_WRITE  0x02
#define FS_O_RDWR   (FS_O_READ | FS_O_WRITE)
#define FS_O_CREATE 0x10
#define FS_O_APPEND 0x20
#define FS_O_TRUNC  0x40

#define FS_SEEK_SET 0
#define FS_SEEK_CUR 1
#define FS_SEEK_END 2

struct fs_file_t {
	void *filep;
	fs_mode_t flags;
};

struct fs_dirent {
	int type;
	char name[256];
	size_t size;
};

struct fs_statvfs {
	unsigned long f_bsize;
	unsigned long f_frsize;
	unsigned long f_blocks;
	unsigned long f_bfree;
};

static inline void fs_file_t_init(struct fs_file_t *zfp)
{
	memset(zfp, 0, sizeof(*zfp));
}

int fs_open(struct fs_file_t *zfp, const char *file_name, fs_mode_t flags);
int fs_close(struct fs_file_t *zfp);
ssize_t fs_read(struct fs_file_t *zfp, void *ptr, size_t size);
ssize_t fs_write(struct fs_file_t *zfp, const void *ptr, size_t size);
int fs_seek(struct fs_file_t *zfp, off_t offset, int whence);
off_t fs_tell(struct fs_file_t *zfp);
int fs_truncate(struct fs_file_t *zfp, off_t length);
int fs_sync(struct fs_file_t *zfp);
int fs_stat(const char *path, struct fs_dirent *entry);
int fs_statvfs(const char *path, struct fs_statvfs *stat);
int fs_unlink(const char *path);
int fs_rename(const char *from, const char *to);
int fs_mkdir(const char *path);

#endif /* ZEPHYR_FS_FS_H_STUB_ */
