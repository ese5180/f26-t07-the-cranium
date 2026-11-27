#pragma once

#include <QByteArray>
#include <QList>
#include <QString>

namespace mixxx::rekordbox {

enum class DeviceState { Missing, Unreadable, Readable, TooLarge };

// A discovery result, not a declaration that the analysis inside is valid.
// root + fingerprint disambiguates simultaneous copies of the same export.
struct DeviceSnapshot {
    QString root;
    QString databasePath;
    QByteArray fingerprint;
    DeviceState state{DeviceState::Missing};
    QString error;
    QByteArray mountIdentity; // Mounted filesystem/device, independently of PDB contents.

    bool matches(const DeviceSnapshot& other) const;
};

struct DiscoveredDevice {
    QString label;
    DeviceSnapshot snapshot;
};

struct PlaylistNode {
    QString label;
    QString path;
    QList<PlaylistNode> children;
};

struct ParsedDevice {
    DeviceSnapshot snapshot;
    QList<PlaylistNode> playlists;
    QString error;
};

QString databasePath(const QString& root);
DeviceSnapshot inspectDevice(const QString& root);

// PDB paths beginning with '/' are relative to the volume, not the host.
// Missing files may be represented, but traversal and symlink escapes may not.
QString resolvePath(const QString& root, const QString& exportedPath,
        bool requireExisting = true);

// Positive recognition is retained for this process, including after unplug.
// The write boundary also checks ancestors, so loading from the normal library
// before asynchronous SOURCE discovery cannot bypass protection.
void protectRoot(const QString& root);
bool isReadOnlyPath(const QString& path);

} // namespace mixxx::rekordbox
