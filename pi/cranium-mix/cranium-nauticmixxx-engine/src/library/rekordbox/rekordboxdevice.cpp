#include "library/rekordbox/rekordboxdevice.h"
#include "util/rx3usbstorage.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QMutex>
#include <QMutexLocker>
#include <QSet>

namespace mixxx::rekordbox {
namespace {
QMutex rootsMutex;
QSet<QString> protectedRoots;

QString absolutePath(const QString& path) {
    return QDir::cleanPath(QFileInfo(path).absoluteFilePath());
}

// Resolve existing ancestors too: the destination file may not exist yet.
QString resolvedPath(const QString& path) {
    QFileInfo ancestor(path);
    QStringList suffix;
    while (!ancestor.exists()) {
        if (ancestor.isSymLink()) {
            return {};
        }
        suffix.prepend(ancestor.fileName());
        const QFileInfo parent(ancestor.absolutePath());
        if (parent.absoluteFilePath() == ancestor.absoluteFilePath()) {
            return {};
        }
        ancestor = parent;
    }
    const auto canonical = ancestor.canonicalFilePath();
    return canonical.isEmpty() ? QString() :
            QDir::cleanPath(QDir(canonical).filePath(suffix.join('/')));
}

bool inside(const QString& root, const QString& path) {
#ifdef Q_OS_WIN
    constexpr auto sensitivity = Qt::CaseInsensitive;
#else
    constexpr auto sensitivity = Qt::CaseSensitive;
#endif
    const QString prefix = root.endsWith('/') ? root : root + '/';
    return path.compare(root, sensitivity) == 0 ||
            path.startsWith(prefix, sensitivity);
}
} // namespace

QString resolvePath(const QString& root, const QString& exportedPath,
        bool requireExisting) {
    const QString canonicalRoot = QFileInfo(root).canonicalFilePath();
    if (canonicalRoot.isEmpty() || !QFileInfo(canonicalRoot).isDir() ||
            exportedPath.isEmpty() || exportedPath.contains(QChar::Null)) {
        return {};
    }
    QString relative = exportedPath;
    relative.replace('\\', '/');
    if (relative.startsWith("//") || relative.contains(':')) {
        return {};
    }
    if (relative.startsWith('/')) {
        relative.remove(0, 1);
    }
    if (relative.split('/').contains(QStringLiteral(".."))) {
        return {};
    }
    const QString candidate = QDir::cleanPath(QDir(canonicalRoot).filePath(relative));
    if (!inside(canonicalRoot, candidate) || candidate == canonicalRoot) {
        return {};
    }
    const QFileInfo file(candidate);
    if (file.exists()) {
        return inside(canonicalRoot, file.canonicalFilePath()) && file.isFile()
                ? candidate : QString();
    }
    if (requireExisting || file.isSymLink()) {
        return {};
    }
    // For a missing track, still verify its nearest existing parent.
    QFileInfo ancestor(file.absolutePath());
    while (!ancestor.exists()) {
        if (ancestor.isSymLink()) {
            return {};
        }
        const QFileInfo parent(ancestor.absolutePath());
        if (parent.absoluteFilePath() == ancestor.absoluteFilePath()) {
            return {};
        }
        ancestor = parent;
    }
    return inside(canonicalRoot, ancestor.canonicalFilePath()) ? candidate : QString();
}

QString databasePath(const QString& root) {
    for (const QString& relative : {QStringLiteral("PIONEER/rekordbox/export.pdb"),
                 QStringLiteral(".PIONEER/rekordbox/export.pdb")}) {
        const auto path = resolvePath(root, relative);
        if (!path.isEmpty()) {
            return path;
        }
    }
    return {};
}

void protectRoot(const QString& root) {
    if (root.isEmpty()) {
        return;
    }
    const auto absolute = absolutePath(root);
    const auto canonical = QFileInfo(root).canonicalFilePath();
    QMutexLocker lock(&rootsMutex);
    protectedRoots.insert(absolute);
    if (!canonical.isEmpty()) {
        protectedRoots.insert(canonical);
    }
}

bool isReadOnlyPath(const QString& path) {
    if (path.isEmpty()) {
        return false;
    }
    const auto absolute = absolutePath(path);
    const auto canonical = resolvedPath(path);
    {
        QMutexLocker lock(&rootsMutex);
        for (const auto& root : protectedRoots) {
            if (inside(root, absolute) || (!canonical.isEmpty() && inside(root, canonical))) {
                return true;
            }
        }
    }
    // No metadata bytes are read here. An unreadable export is protected too;
    // the separate analysis policy decides which of its data can be trusted.
    for (const auto& candidate : {absolute, canonical}) {
        if (candidate.isEmpty()) {
            continue;
        }
        QString parent = QFileInfo(candidate).absolutePath();
        for (;;) {
            if (!databasePath(parent).isEmpty()) {
                protectRoot(parent);
                return true;
            }
            const QString next = QFileInfo(parent).absolutePath();
            if (next == parent) {
                break;
            }
            parent = next;
        }
    }
    return false;
}

DeviceSnapshot inspectDevice(const QString& root) {
    DeviceSnapshot result;
    result.root = QFileInfo(root).canonicalFilePath();
    result.databasePath = databasePath(root);
    if (result.root.isEmpty() || result.databasePath.isEmpty()) {
        result.error = QStringLiteral("Rekordbox database is missing");
        return result;
    }
    const rx3::UsbStorageInfo storage(root);
    if(!storage.isReady() || storage.device().isEmpty()) {
        result.state=DeviceState::Unreadable;result.error=QStringLiteral("USB mount is unavailable");return result;
    }
    result.mountIdentity=storage.device();
    protectRoot(root);
    QFile file(result.databasePath);
    if (!file.open(QIODevice::ReadOnly)) {
        result.state = DeviceState::Unreadable;
        result.error = file.errorString();
        return result;
    }
    // Bound discovery work even for damaged/unexpected database sizes.
    constexpr qint64 maxDatabaseBytes = 512LL * 1024 * 1024;
    if (file.size() > maxDatabaseBytes) {
        result.state = DeviceState::TooLarge;
        result.error = QStringLiteral("Rekordbox database exceeds the 512 MiB read limit");
        return result;
    }
    const auto initialSize = file.size();
    const auto initialModified = QFileInfo(file).lastModified();
    QCryptographicHash hash(QCryptographicHash::Sha256);
    qint64 total = 0;
    char buffer[64 * 1024];
    for (;;) {
        const auto bytes = file.read(buffer, sizeof(buffer));
        if (bytes < 0 || total + bytes > maxDatabaseBytes) {
            result.state = bytes < 0 ? DeviceState::Unreadable : DeviceState::TooLarge;
            result.error = QStringLiteral("Failed or oversized Rekordbox database read");
            return result;
        }
        if (bytes == 0) {
            break;
        }
        total += bytes;
        hash.addData(QByteArray::fromRawData(buffer, static_cast<int>(bytes)));
    }
    if (total != initialSize || QFileInfo(file).lastModified() != initialModified) {
        result.state = DeviceState::Unreadable;
        result.error = QStringLiteral("Rekordbox database changed while reading");
        return result;
    }
    result.fingerprint = hash.result();
    result.state = DeviceState::Readable;
    return result;
}

bool DeviceSnapshot::matches(const DeviceSnapshot& other) const {
    return state == DeviceState::Readable && other.state == DeviceState::Readable &&
            root == other.root && mountIdentity == other.mountIdentity && fingerprint == other.fingerprint;
}
} // namespace mixxx::rekordbox
