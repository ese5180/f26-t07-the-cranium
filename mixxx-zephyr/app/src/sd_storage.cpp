// Tracks on a FAT-formatted SD card, through Zephyr's file-system API.
#include <cstdio>
#include <cstring>

#include <ff.h>
#include <zephyr/fs/fs.h>
#include <zephyr/logging/log.h>

#include "app.h"

LOG_MODULE_REGISTER(mz_storage, LOG_LEVEL_INF);

namespace app {

namespace {

FATFS g_fat;
fs_mount_t g_mount = {
        .type = FS_FATFS,
        .mnt_point = "/SD:",
        .fs_data = &g_fat,
};

// One open file per deck plus one spare, without a heap.
class FsFile : public mz::File {
  public:
    bool open(const char* path) {
        fs_file_t_init(&m_file);
        if (fs_open(&m_file, path, FS_O_READ) != 0) {
            return false;
        }
        struct fs_dirent entry;
        m_size = fs_stat(path, &entry) == 0 ? entry.size : 0;
        m_position = 0;
        m_inUse = true;
        return true;
    }
    void close() {
        fs_close(&m_file);
        m_inUse = false;
    }
    long read(uint64_t offset, void* buffer, size_t length) override {
        if (offset != m_position) {
            if (fs_seek(&m_file, static_cast<off_t>(offset), FS_SEEK_SET) != 0) {
                return -1;
            }
            m_position = offset;
        }
        const ssize_t n = fs_read(&m_file, buffer, length);
        if (n < 0) {
            return -1;
        }
        m_position += static_cast<uint64_t>(n);
        return static_cast<long>(n);
    }
    uint64_t size() override {
        return m_size;
    }
    bool inUse() const {
        return m_inUse;
    }

  private:
    fs_file_t m_file;
    uint64_t m_size = 0;
    uint64_t m_position = 0;
    bool m_inUse = false;
};

FsFile g_files[mz::kNumDecks + 1];

bool hasWavExtension(const char* name) {
    const size_t length = std::strlen(name);
    if (length < 4) {
        return false;
    }
    const char* ext = name + length - 4;
    return ext[0] == '.' && (ext[1] == 'w' || ext[1] == 'W') && (ext[2] == 'a' || ext[2] == 'A') &&
            (ext[3] == 'v' || ext[3] == 'V');
}

} // namespace

mz::File* SdStorage::open(const char* name) {
    char path[mz::kMaxPathLength + sizeof(CONFIG_MZ_MUSIC_DIR) + 2];
    std::snprintf(path, sizeof(path), "%s/%s", CONFIG_MZ_MUSIC_DIR, name);
    for (FsFile& file : g_files) {
        if (!file.inUse()) {
            if (file.open(path)) {
                return &file;
            }
            LOG_WRN("cannot open %s", path);
            return nullptr;
        }
    }
    LOG_ERR("no free file for %s", path);
    return nullptr;
}

void SdStorage::close(mz::File* file) {
    static_cast<FsFile*>(file)->close();
}

int mountAndScan(mz::Library* library) {
    int err = fs_mount(&g_mount);
    if (err != 0) {
        LOG_ERR("cannot mount the SD card (%d)", err);
        return err;
    }
    fs_dir_t dir;
    fs_dir_t_init(&dir);
    err = fs_opendir(&dir, CONFIG_MZ_MUSIC_DIR);
    if (err != 0) {
        LOG_ERR("no folder %s on the card (%d)", CONFIG_MZ_MUSIC_DIR, err);
        return err;
    }
    struct fs_dirent entry;
    while (fs_readdir(&dir, &entry) == 0 && entry.name[0] != '\0') {
        if (entry.type == FS_DIR_ENTRY_FILE && hasWavExtension(entry.name)) {
            if (!library->add(entry.name)) {
                LOG_WRN("library full, skipping %s", entry.name);
            }
        }
    }
    fs_closedir(&dir);
    LOG_INF("%d tracks in %s", library->count(), CONFIG_MZ_MUSIC_DIR);
    return 0;
}

} // namespace app
