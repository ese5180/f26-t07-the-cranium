#pragma once

#include <QByteArray>
#include <QList>
#include <QMap>
#include <QJsonObject>
#include <QStringList>

namespace mixxx::rekordbox {

enum class DatabaseKind { Main, Extended };

// Byte ranges refer to the immutable, validated bytes below. Types in
// exportExt.pdb have a different meaning from those in export.pdb.
struct DatabaseRow {
    quint32 tableType;
    quint32 pageIndex;
    quint32 rowIndex;
    qint64 offset;
    qint64 size;
};

struct DatabaseDocument {
    DatabaseKind kind{DatabaseKind::Main};
    QByteArray bytes;
    quint32 pageSize{0};
    quint32 sequence{0};
    QList<DatabaseRow> rows;
    QStringList diagnostics;
    QString error;
    bool valid() const { return error.isEmpty() && pageSize != 0; }
};

struct DatabasePlaylist {
    quint32 id;
    quint32 parentId;
    quint32 sortOrder;
    bool folder;
    QString name;
};

struct PlaylistIndex {
    QMap<quint32, DatabasePlaylist> playlists;
    QMap<quint32, QMultiMap<quint32, quint32>> tracks; // playlist -> position -> track
    QStringList diagnostics;
    QString error;
};

struct DatabaseTrack {
    quint32 id;
    QString filePath;
    QString analysisPath;
    QJsonObject metadata;
};

struct TrackIndex {
    QMap<quint32, DatabaseTrack> tracks;
    QStringList diagnostics;
    QString error;
};

struct BrowseCategory {
    quint16 id{0};
    QString label;
    quint16 position{0};
    quint8 marker{0};
    quint8 visibility{0};
};

struct BrowseMenu {
    QList<BrowseCategory> categories;
    QStringList diagnostics;
    bool fromExport{false};
};

struct DatabaseHistory {
    quint32 id{0};
    QString name;
    QList<quint32> trackIds;
};

struct HistoryIndex {
    QList<DatabaseHistory> histories;
    QStringList diagnostics;
};

HistoryIndex readHistoryIndex(const DatabaseDocument& document);

// Category descriptors (table 16) and the ordered menu (table 17) in
// export.pdb. Invalid menu entries are ignored without discarding tracks.
BrowseMenu readBrowseMenu(const DatabaseDocument& document);

TrackIndex readTrackIndex(const DatabaseDocument& document);

PlaylistIndex readPlaylistIndex(const DatabaseDocument& document);

// Structural validation precedes all generated row decoders and SQL writes.
// Unknown table types remain available as bounded rows instead of being cast
// to an unrelated main-database type.
DatabaseDocument readDatabase(QByteArray bytes, DatabaseKind kind);
DatabaseDocument readDatabaseFile(const QString& path, DatabaseKind kind);

} // namespace mixxx::rekordbox
