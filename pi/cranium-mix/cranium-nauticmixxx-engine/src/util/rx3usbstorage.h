#pragma once

#include <QByteArray>
#include <QFile>
#include <QFileInfo>
#include <QStorageInfo>
#include <QString>
#include <algorithm>
#include <limits>
#include <utility>

#ifdef Q_OS_MAC
#include <sys/mount.h>
#endif

namespace rx3 {
// Older bundled Qt versions can report macOS's sealed system volume for
// writable APFS firmlinks and external mounts. Inspect the actual path with
// statfs on macOS; retain Qt's volume inspection on Windows and Linux.
class UsbStorageInfo {
  public:
    explicit UsbStorageInfo(QString path) : m_path(std::move(path)) { refresh(); }
    void refresh() {
        m_ready=false;m_readOnly=true;m_available=0;m_device.clear();m_root.clear();
        const auto canonical=QFileInfo(m_path).canonicalFilePath();
        if(canonical.isEmpty()) return;
#ifdef Q_OS_MAC
        struct statfs filesystem{};
        if(statfs(QFile::encodeName(canonical).constData(),&filesystem)!=0) return;
        m_ready=true;m_readOnly=(filesystem.f_flags&MNT_RDONLY)!=0;
        const auto blocks=quint64(std::max<qint64>(0,filesystem.f_bavail));
        const auto blockSize=quint64(filesystem.f_bsize);
        const auto maximum=quint64(std::numeric_limits<qint64>::max());
        m_available=blockSize>0?qint64(std::min(blocks,maximum/blockSize)*blockSize):0;
        m_device=QByteArray(filesystem.f_mntfromname);
        // A device path can be reassigned after unplug; include the volume fsid.
        m_device.append(':').append(QByteArray::number(filesystem.f_fsid.val[0])).append(':').append(QByteArray::number(filesystem.f_fsid.val[1]));
        m_root=QString::fromLocal8Bit(filesystem.f_mntonname);
#else
        QStorageInfo storage(canonical);storage.refresh();
        m_ready=storage.isReady();m_readOnly=storage.isReadOnly();
        m_available=std::max<qint64>(0,storage.bytesAvailable());
        m_device=storage.device();m_root=storage.rootPath();
#endif
    }
    bool isReady() const {return m_ready;}
    bool isReadOnly() const {return m_readOnly;}
    qint64 bytesAvailable() const {return m_available;}
    QByteArray device() const {return m_device;}
    QString rootPath() const {return m_root;}
  private:
    QString m_path,m_root;
    QByteArray m_device;
    qint64 m_available=0;
    bool m_ready=false,m_readOnly=true;
};
} // namespace rx3
