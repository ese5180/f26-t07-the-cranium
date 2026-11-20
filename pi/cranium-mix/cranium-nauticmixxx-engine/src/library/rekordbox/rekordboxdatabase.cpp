#include "library/rekordbox/rekordboxdatabase.h"

#include <QFile>
#include <QSet>
#include <QtEndian>
#include <QTextCodec>
#include <algorithm>
#include <stdexcept>

namespace mixxx::rekordbox {
namespace {
constexpr qint64 kMaxDatabaseBytes = 512LL * 1024 * 1024;
constexpr quint32 kPageHeaderBytes = 40;
constexpr quint32 kRowGroupBytes = 36;

quint32 u32(const QByteArray& bytes, qint64 offset) {
    if (offset < 0 || offset > bytes.size() - 4) {
        throw std::runtime_error("Truncated DeviceSQL integer");
    }
    return qFromLittleEndian<quint32>(bytes.constData() + offset);
}
quint16 u16(const QByteArray& bytes, qint64 offset) {
    if (offset < 0 || offset > bytes.size() - 2) {
        throw std::runtime_error("Truncated DeviceSQL integer");
    }
    return qFromLittleEndian<quint16>(bytes.constData() + offset);
}

QString readString(const QByteArray& bytes, qint64 offset, qint64 end) {
    if (offset < 0 || offset >= end || end > bytes.size()) {
        throw std::runtime_error("DeviceSQL string offset is outside its row");
    }
    const quint8 kind = static_cast<quint8>(bytes.at(offset));
    qint64 start = offset + 1;
    qint64 length = (kind >> 1) - 1;
    bool utf16 = false;
    if (kind == 0x40 || kind == 0x90) {
        if (end - offset < 4) {
            throw std::runtime_error("Truncated DeviceSQL long-string header");
        }
        start = offset + 4;
        length = static_cast<qint64>(u16(bytes, offset + 1)) - 4;
        utf16 = kind == 0x90;
    } else if ((kind & 1) == 0) {
        throw std::runtime_error("Unsupported DeviceSQL string encoding");
    }
    if (length < 0 || length > end - start || (utf16 && length % 2 != 0)) {
        throw std::runtime_error("DeviceSQL string exceeds its row");
    }
    QTextCodec::ConverterState state;
    auto* codec = QTextCodec::codecForName(utf16 ? "UTF-16LE" : "UTF-8");
    QString result = codec->toUnicode(bytes.constData() + start, length, &state);
    if (state.invalidChars != 0 || state.remainingChars != 0) {
        throw std::runtime_error("Invalid DeviceSQL string data");
    }
    while (result.endsWith(QChar::Null)) {
        result.chop(1);
    }
    if (result.contains(QChar::Null)) {
        throw std::runtime_error("Embedded null in DeviceSQL string");
    }
    return result;
}

void validate(DatabaseDocument* document) {
    const auto& bytes = document->bytes;
    if (bytes.size() < 28 || bytes.size() > kMaxDatabaseBytes) {
        throw std::runtime_error("Missing, truncated or oversized DeviceSQL header");
    }
    const quint32 pageSize = u32(bytes, 4);
    const quint32 tableCount = u32(bytes, 8);
    if (pageSize < kPageHeaderBytes + kRowGroupBytes || pageSize > 65536 ||
            bytes.size() % pageSize != 0 || tableCount > (pageSize - 28) / 16) {
        throw std::runtime_error("Invalid DeviceSQL page size or table count");
    }
    if (u32(bytes, 24) != 0) {
        throw std::runtime_error("Unsupported DeviceSQL header variant");
    }
    const quint32 pageCount = bytes.size() / pageSize;
    document->sequence = u32(bytes, 20);
    QSet<quint32> visitedPages;
    for (quint32 table = 0; table < tableCount; ++table) {
        const qint64 entry = 28 + table * 16;
        const quint32 type = u32(bytes, entry);
        quint32 page = u32(bytes, entry + 8);
        const quint32 last = u32(bytes, entry + 12);
        if (page == 0 && last == 0) {
            continue;
        }
        if (last == 0 || last >= pageCount) {
            throw std::runtime_error("DeviceSQL last-page reference is outside the file");
        }
        for (;;) {
            if (page == 0 || page >= pageCount) {
                throw std::runtime_error("DeviceSQL page reference is outside the file");
            }
            const qint64 base = static_cast<qint64>(page) * pageSize;
            if (u32(bytes, base) != 0 || u32(bytes, base + 4) != page) {
                throw std::runtime_error("Invalid DeviceSQL page identity");
            }
            if (u32(bytes, base + 8) != type) {
                document->diagnostics.append(QStringLiteral(
                        "Table %1 ends at a page belonging to another table").arg(type));
                break;
            }
            if (visitedPages.contains(page)) {
                throw std::runtime_error("Cyclic or shared DeviceSQL page chain");
            }
            visitedPages.insert(page);
            const auto flags = static_cast<quint8>(bytes.at(base + 27));
            if ((flags & 0x40) == 0) {
                const quint32 rowCount = u16(bytes, base + 24) & 0x1fff;
                const quint32 groups = (rowCount + 15) / 16;
                if (groups > (pageSize - kPageHeaderBytes) / kRowGroupBytes) {
                    throw std::runtime_error("DeviceSQL row index overlaps page header");
                }
                const quint32 heapEnd = pageSize - groups * kRowGroupBytes;
                QList<DatabaseRow> rows;
                for (quint32 group = 0; group < groups; ++group) {
                    const quint32 end = pageSize - group * kRowGroupBytes;
                    const quint16 present = u16(bytes, base + end - 4);
                    for (quint32 slot = 0; slot < 16; ++slot) {
                        if ((present & (1 << slot)) == 0) {
                            continue;
                        }
                        const quint32 row = group * 16 + slot;
                        const quint32 offset = kPageHeaderBytes +
                                u16(bytes, base + end - 6 - 2 * slot);
                        if (row >= rowCount || offset >= heapEnd) {
                            throw std::runtime_error("Invalid live DeviceSQL row offset");
                        }
                        rows.append({type, page, row, base + offset, 0});
                    }
                }
                // Variable strings may not spill into the next live row/index.
                std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
                    return a.offset < b.offset;
                });
                for (qsizetype i = 0; i < rows.size(); ++i) {
                    const qint64 end = i + 1 < rows.size()
                            ? rows.at(i + 1).offset : base + heapEnd;
                    rows[i].size = end - rows[i].offset;
                    if (rows[i].size <= 0) {
                        throw std::runtime_error("Duplicate DeviceSQL row offsets");
                    }
                    document->rows.append(rows.at(i));
                }
            }
            if (page == last) {
                break;
            }
            page = u32(bytes, base + 12);
        }
    }
    document->pageSize = pageSize;
}
} // namespace

DatabaseDocument readDatabase(QByteArray bytes, DatabaseKind kind) {
    DatabaseDocument result;
    result.kind = kind;
    result.bytes = std::move(bytes);
    try {
        validate(&result);
    } catch (const std::exception& e) {
        result.error = QString::fromUtf8(e.what());
        result.pageSize = 0;
        result.rows.clear();
    }
    return result;
}

BrowseMenu readBrowseMenu(const DatabaseDocument& document) {
    BrowseMenu result;
    if (!document.valid() || document.kind != DatabaseKind::Main) {
        result.diagnostics.append(QStringLiteral("Browse menu requires a valid main export"));
        return result;
    }
    QMap<quint16, QString> labels;
    const auto& bytes = document.bytes;
    for (const auto& row : document.rows) {
        if (row.tableType != 16) continue;
        try {
            if (row.size < 5) throw std::runtime_error("Truncated category descriptor");
            const auto id = u16(bytes, row.offset);
            QString label = readString(bytes, row.offset + 4, row.offset + row.size);
            if (label.startsWith(QChar(0xfffa)) && label.endsWith(QChar(0xfffb))) {
                label = label.mid(1, label.size() - 2);
            }
            if (id == 0 || label.isEmpty() || labels.contains(id)) {
                throw std::runtime_error("Invalid category descriptor");
            }
            labels.insert(id, label);
        } catch (const std::exception& e) {
            result.diagnostics.append(QStringLiteral("Category page %1 row %2: %3")
                    .arg(row.pageIndex).arg(row.rowIndex).arg(QString::fromUtf8(e.what())));
        }
    }
    QSet<quint16> positions;
    for (const auto& row : document.rows) {
        if (row.tableType != 17) continue;
        result.fromExport = true;
        if (row.size < 8) {
            result.diagnostics.append(QStringLiteral("Truncated browse menu row"));
            continue;
        }
        const auto id = u16(bytes, row.offset);
        const auto marker = static_cast<quint8>(bytes.at(row.offset + 4));
        const auto visibility = static_cast<quint8>(bytes.at(row.offset + 5));
        const auto position = u16(bytes, row.offset + 6);
        // The mounted RX3 export uses 0 for ordinary visible entries and 2
        // for MATCHING. Position zero and visibility 1/3 are hidden entries.
        if (position == 0 || (visibility != 0 && visibility != 2)) continue;
        if (!labels.contains(id) || positions.contains(position)) {
            result.diagnostics.append(QStringLiteral("Browse menu has an unknown category or duplicate position"));
            continue;
        }
        positions.insert(position);
        result.categories.append({id, labels.value(id), position, marker, visibility});
    }
    std::sort(result.categories.begin(), result.categories.end(),
            [](const auto& a, const auto& b) { return a.position < b.position; });
    if (!result.fromExport) {
        result.categories = {{4, QStringLiteral("TRACK"), 1, 0, 0},
                {17, QStringLiteral("PLAYLIST"), 2, 0, 0}};
        result.diagnostics.append(QStringLiteral("Browse menu absent; using TRACK and PLAYLIST fallback"));
    }
    return result;
}

HistoryIndex readHistoryIndex(const DatabaseDocument& document) {
    HistoryIndex result;
    if (!document.valid() || document.kind != DatabaseKind::Main) return result;
    QMap<quint32, DatabaseHistory> histories;
    QMap<quint32, QMap<quint32, quint32>> entries;
    const auto& bytes = document.bytes;
    for (const auto& row : document.rows) {
        try {
            if (row.tableType == 11) {
                if (row.size < 5) throw std::runtime_error("Truncated history name");
                const auto id = u32(bytes, row.offset);
                if (id == 0 || histories.contains(id))
                    throw std::runtime_error("Invalid or duplicate history identity");
                histories.insert(id, {id,
                        readString(bytes, row.offset + 4, row.offset + row.size), {}});
            } else if (row.tableType == 12) {
                if (row.size < 12) throw std::runtime_error("Truncated history entry");
                const auto trackId = u32(bytes, row.offset);
                const auto historyId = u32(bytes, row.offset + 4);
                const auto position = u32(bytes, row.offset + 8);
                if (entries[historyId].contains(position))
                    throw std::runtime_error("Duplicate history position");
                entries[historyId].insert(position, trackId);
            }
        } catch (const std::exception& e) {
            result.diagnostics.append(QStringLiteral("History page %1 row %2: %3")
                    .arg(row.pageIndex).arg(row.rowIndex).arg(QString::fromUtf8(e.what())));
        }
    }
    for (auto it = histories.begin(); it != histories.end(); ++it) {
        const auto ordered = entries.take(it.key());
        for (const auto trackId : ordered) it->trackIds.append(trackId);
        result.histories.append(*it);
    }
    for (auto it = entries.cbegin(); it != entries.cend(); ++it) {
        result.diagnostics.append(QStringLiteral("History entries reference missing history %1")
                .arg(it.key()));
    }
    return result;
}

PlaylistIndex readPlaylistIndex(const DatabaseDocument& document) {
    PlaylistIndex result;
    try {
        if (!document.valid() || document.kind != DatabaseKind::Main) {
            throw std::runtime_error("Playlist index requires a valid main DeviceSQL database");
        }
        for (const auto& row : document.rows) {
            const auto& bytes = document.bytes;
            if (row.tableType == 7) {
                if (row.size < 21) {
                    throw std::runtime_error("Truncated DeviceSQL playlist row");
                }
                DatabasePlaylist playlist{u32(bytes, row.offset + 12),
                        u32(bytes, row.offset), u32(bytes, row.offset + 8),
                        u32(bytes, row.offset + 16) != 0,
                        readString(bytes, row.offset + 20, row.offset + row.size)};
                if (playlist.id == 0 || result.playlists.contains(playlist.id)) {
                    throw std::runtime_error("Invalid or duplicate DeviceSQL playlist identity");
                }
                result.playlists.insert(playlist.id, std::move(playlist));
            } else if (row.tableType == 8) {
                if (row.size < 12) {
                    throw std::runtime_error("Truncated DeviceSQL playlist entry");
                }
                const auto position = u32(bytes, row.offset);
                const auto track = u32(bytes, row.offset + 4);
                const auto playlist = u32(bytes, row.offset + 8);
                if (result.tracks[playlist].contains(position)) {
                    result.diagnostics.append(QStringLiteral("Playlist %1 has tied track positions")
                                                      .arg(playlist));
                }
                result.tracks[playlist].insert(position, track);
            }
        }
        QMap<quint32, QSet<quint32>> siblingPositions;
        for (const auto& playlist : result.playlists) {
            if (siblingPositions[playlist.parentId].contains(playlist.sortOrder)) {
                result.diagnostics.append(QStringLiteral("Folder %1 has tied sort positions")
                                                  .arg(playlist.parentId));
            }
            siblingPositions[playlist.parentId].insert(playlist.sortOrder);
            QSet<quint32> ancestors;
            auto parent = playlist.id;
            while (parent != 0 && result.playlists.contains(parent)) {
                if (ancestors.contains(parent) || ancestors.size() >= 256) {
                    throw std::runtime_error("Cyclic or excessively nested DeviceSQL playlist tree");
                }
                ancestors.insert(parent);
                parent = result.playlists.value(parent).parentId;
            }
            if (parent != 0) {
                result.diagnostics.append(QStringLiteral("Playlist %1 has missing parent %2")
                                                  .arg(playlist.id).arg(parent));
            }
        }
        for (auto entries = result.tracks.cbegin(); entries != result.tracks.cend(); ++entries) {
            if (!result.playlists.contains(entries.key())) {
                result.diagnostics.append(QStringLiteral("Entries refer to missing playlist %1")
                                                  .arg(entries.key()));
            }
        }
    } catch (const std::exception& e) {
        result.error = QString::fromUtf8(e.what());
        result.playlists.clear();
        result.tracks.clear();
    }
    return result;
}

TrackIndex readTrackIndex(const DatabaseDocument& document) {
    TrackIndex result;
    if (!document.valid() || document.kind != DatabaseKind::Main) {
        result.error = QStringLiteral("Track index requires a valid main DeviceSQL database");
        return result;
    }
    QMap<quint32, QMap<quint32, QString>> names;
    QMap<quint32, quint32> albumArtists;
    const auto& bytes = document.bytes;
    for (const auto& row : document.rows) {
        if (row.tableType == 0 || row.tableType == 7 || row.tableType == 8) {
            continue;
        }
        try {
            quint32 id;
            qint64 textOffset;
            qint64 minimumTextOffset = 0;
            const auto at = row.offset;
            switch (row.tableType) {
            case 1: // Genres
            case 4: // Labels
            case 13: // Artwork paths
                if (row.size < 5) throw std::runtime_error("Truncated named metadata row");
                id = u32(bytes, at);
                textOffset = 4;
                break;
            case 5: // Keys
                if (row.size < 9) throw std::runtime_error("Truncated key row");
                id = u32(bytes, at);
                textOffset = 8;
                break;
            case 2: // Artist names may have near or far offsets.
                if (row.size < 10) throw std::runtime_error("Truncated artist row");
                id = u32(bytes, at + 4);
                if (u16(bytes, at) == 100) {
                    if (row.size < 12) throw std::runtime_error("Truncated far artist name");
                    textOffset = u16(bytes, at + 10);
                    minimumTextOffset = 12;
                } else {
                    textOffset = static_cast<quint8>(bytes.at(at + 9));
                    minimumTextOffset = 10;
                }
                break;
            case 3: // Albums
                if (row.size < 22) throw std::runtime_error("Truncated album row");
                id = u32(bytes, at + 12);
                albumArtists.insert(id, u32(bytes, at + 8));
                textOffset = static_cast<quint8>(bytes.at(at + 21));
                minimumTextOffset = 22;
                break;
            case 6: // Device color names, not RGB samples.
                if (row.size < 9) throw std::runtime_error("Truncated color row");
                id = u16(bytes, at + 5);
                textOffset = 8;
                break;
            default:
                result.diagnostics.append(QStringLiteral("Metadata table %1 retained as raw DeviceSQL rows")
                                                  .arg(row.tableType));
                continue;
            }
            if (textOffset < minimumTextOffset || textOffset >= row.size) {
                throw std::runtime_error("Named metadata offset is outside its payload");
            }
            if (names[row.tableType].contains(id)) {
                throw std::runtime_error("Duplicate named metadata identity");
            }
            names[row.tableType].insert(id, readString(bytes, at + textOffset, at + row.size));
        } catch (const std::exception& e) {
            result.diagnostics.append(QStringLiteral("Metadata page %1 row %2: %3")
                                              .arg(row.pageIndex).arg(row.rowIndex).arg(QString::fromUtf8(e.what())));
        }
    }
    for (const auto& row : document.rows) {
        if (row.tableType != 0) continue;
        try {
            if (row.size < 136) throw std::runtime_error("Truncated track row");
            const auto at = row.offset;
            DatabaseTrack track;
            track.id = u32(bytes, at + 72);
            if (track.id == 0 || result.tracks.contains(track.id)) {
                throw std::runtime_error("Invalid or duplicate track identity");
            }
            auto& metadata = track.metadata;
            metadata.insert("rekordbox_id", static_cast<double>(track.id));
            metadata.insert("pdb_fixed_header_raw", QString::fromLatin1(bytes.mid(at, 136).toBase64()));
            for (const auto& field : std::initializer_list<std::pair<const char*, int>>{
                         {"sample_rate", 8}, {"composer_id", 12}, {"file_size", 16},
                         {"artwork_id", 28}, {"key_id", 32}, {"original_artist_id", 36},
                         {"label_id", 40}, {"remixer_id", 44}, {"bitrate", 48},
                         {"track_number", 52}, {"tempo_hundredths", 56}, {"genre_id", 60},
                         {"album_id", 64}, {"artist_id", 68}}) {
                metadata.insert(field.first, static_cast<double>(u32(bytes, at + field.second)));
            }
            for (const auto& field : std::initializer_list<std::pair<const char*, int>>{
                         {"disc_number", 76}, {"play_count", 78}, {"year", 80},
                         {"sample_depth", 82}, {"duration", 84}}) {
                metadata.insert(field.first, u16(bytes, at + field.second));
            }
            metadata.insert("color_id", static_cast<quint8>(bytes.at(at + 88)));
            metadata.insert("rating", static_cast<quint8>(bytes.at(at + 89)));
            const auto tempo = u32(bytes, at + 56);
            if (tempo > 0 && tempo <= 50000) {
                metadata.insert("bpm", tempo / 100.0);
            } else {
                result.diagnostics.append(QStringLiteral("Track %1 BPM is absent or outside the import range (0, 500]")
                                                  .arg(track.id));
            }
            const auto reference = [&](const char* field, quint32 table, quint32 id) {
                metadata.insert(field, names.value(table).value(id));
                if (id != 0 && !names.value(table).contains(id)) {
                    result.diagnostics.append(QStringLiteral("Track %1 has missing %2 reference %3")
                                                      .arg(track.id).arg(QString::fromLatin1(field)).arg(id));
                }
            };
            reference("artist", 2, u32(bytes, at + 68));
            reference("album", 3, u32(bytes, at + 64));
            reference("genre", 1, u32(bytes, at + 60));
            reference("key", 5, u32(bytes, at + 32));
            reference("color_name", 6, static_cast<quint8>(bytes.at(at + 88)));
            reference("composer", 2, u32(bytes, at + 12));
            reference("original_artist", 2, u32(bytes, at + 36));
            reference("remixer", 2, u32(bytes, at + 44));
            reference("label", 4, u32(bytes, at + 40));
            reference("artwork_path", 13, u32(bytes, at + 28));
            metadata.insert("album_artist_id", static_cast<double>(albumArtists.value(u32(bytes, at + 64))));
            constexpr const char* stringNames[] = {"isrc", "texter", "unknown_string_2",
                    "unknown_string_3", "unknown_string_4", "message", "kuvo_public",
                    "autoload_hot_cues", "unknown_string_8", "unknown_string_9",
                    "date_added", "release_date", "mix_name", "unknown_string_13",
                    "analysis_path", "analysis_date", "comment", "title", "unknown_string_18",
                    "file_name", "file_path"};
            QList<quint16> offsets;
            for (int i = 0; i < 21; ++i) offsets.append(u16(bytes, at + 94 + 2 * i));
            for (int i = 0; i < 21; ++i) {
                const auto offset = offsets.at(i);
                if (offset == 0) continue;
                qint64 end = at + row.size;
                for (const auto next : offsets) {
                    if (next > offset) end = std::min(end, at + next);
                }
                try {
                    if (offset < 136 || offset >= row.size) {
                        throw std::runtime_error("Track string offset is outside its payload");
                    }
                    QString text;
                    const auto field = at + offset;
                    if (i == 0 && end - field >= 5 &&
                            static_cast<quint8>(bytes.at(field)) == 0x90 &&
                            bytes.at(field + 4) == 3) {
                        // ISRC: long 0x90 header, then 0x03, ASCII and NUL.
                        // The declared length still bounds the special payload.
                        const auto length = u16(bytes, field + 1);
                        if (length < 6 || length > end - field) {
                            throw std::runtime_error("Invalid ISRC length");
                        }
                        const auto start = field + 5;
                        const auto nul = bytes.indexOf('\0', start);
                        if (nul < start || nul >= field + length) {
                            throw std::runtime_error("Unterminated ISRC");
                        }
                        for (auto pos = start; pos < nul; ++pos) {
                            if (static_cast<quint8>(bytes.at(pos)) > 0x7f) {
                                throw std::runtime_error("Non-ASCII ISRC");
                            }
                        }
                        text = QString::fromLatin1(bytes.constData() + start, nul - start);
                    } else {
                        text = readString(bytes, at + offset, end);
                    }
                    metadata.insert(stringNames[i], text);
                } catch (const std::exception& e) {
                    result.diagnostics.append(QStringLiteral("Track %1 %2: %3")
                                                      .arg(track.id).arg(stringNames[i]).arg(QString::fromUtf8(e.what())));
                    if (offset >= 136 && at + offset < end) {
                        metadata.insert(QString::fromLatin1(stringNames[i]) + "_raw",
                                QString::fromLatin1(bytes.mid(at + offset, end - at - offset).toBase64()));
                    }
                }
            }
            track.filePath = metadata.value("file_path").toString();
            track.analysisPath = metadata.value("analysis_path").toString();
            if (track.filePath.isEmpty()) throw std::runtime_error("Track has no usable audio path");
            result.tracks.insert(track.id, std::move(track));
        } catch (const std::exception& e) {
            result.diagnostics.append(QStringLiteral("Track page %1 row %2: %3")
                                              .arg(row.pageIndex).arg(row.rowIndex).arg(QString::fromUtf8(e.what())));
        }
    }
    result.diagnostics.removeDuplicates();
    return result;
}

DatabaseDocument readDatabaseFile(const QString& path, DatabaseKind kind) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() > kMaxDatabaseBytes) {
        DatabaseDocument result;
        result.kind = kind;
        result.error = QStringLiteral("Cannot read DeviceSQL database: %1").arg(path);
        return result;
    }
    const auto expectedSize = file.size();
    const auto bytes = file.read(expectedSize + 1);
    if (bytes.size() != expectedSize || file.size() != expectedSize) {
        DatabaseDocument result;
        result.kind = kind;
        result.error = QStringLiteral("DeviceSQL database changed while reading");
        return result;
    }
    if (file.error() != QFileDevice::NoError) {
        DatabaseDocument result;
        result.kind = kind;
        result.error = file.errorString();
        return result;
    }
    return readDatabase(bytes, kind);
}
} // namespace mixxx::rekordbox
