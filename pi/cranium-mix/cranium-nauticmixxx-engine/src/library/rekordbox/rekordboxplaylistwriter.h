#pragma once
#include <QDateTime>
#include "library/rekordbox/rekordboxperformancewriter.h"
#include "library/rekordbox/rekordboxdatabase.h"

namespace mixxx::rekordbox {
namespace playlistwriter {
inline void put32(QByteArray& bytes, int offset, quint32 value) { qToLittleEndian(value, bytes.data() + offset); }
inline void put16(QByteArray& bytes, int offset, quint16 value) { qToLittleEndian(value, bytes.data() + offset); }
inline quint32 get32(const QByteArray& bytes, int offset) { return qFromLittleEndian<quint32>(bytes.constData() + offset); }
inline QByteArray nameBytes(const QString& name) {
    const auto utf16 = QTextCodec::codecForName("UTF-16LE")->fromUnicode(name);
    QByteArray bytes(4, '\0'); bytes[0] = char(0x90); put16(bytes, 1, utf16.size() + 4); bytes.append(utf16); return bytes;
}
// Append bounded data pages. Existing rows, including unknown table types,
// keep their exact addresses and bytes. Table links/header counters change.
inline QString appendRows(QByteArray& bytes, quint32 type, const QList<QByteArray>& rows) {
    if (rows.isEmpty()) return {};
    const int pageSize = get32(bytes, 4); int tableCount = get32(bytes, 8), table = -1;
    for (int i = 0; i < tableCount; ++i) if (get32(bytes, 28 + 16 * i) == type) {
        if (table != -1) return "Ambiguous USB table."; table = 28 + 16 * i;
    }
    if (table < 0) {
        table = 28 + 16 * tableCount;
        if (table + 16 > pageSize || bytes.mid(table, 16) != QByteArray(16, '\0')) return "USB header has no room for this table.";
        put32(bytes, table, type); put32(bytes, 8, ++tableCount);
    }
    int next=std::max(int(bytes.size()/pageSize),int(get32(bytes,12)));
    const int previousLast=get32(bytes,table+12);
    const int indexPage=previousLast?0:next++;
    const int first=next, emptyCandidate=first+rows.size();
    if(qint64(emptyCandidate)*pageSize>128*1024*1024) return "USB database would exceed its size limit.";
    if(indexPage) {
        QByteArray page(pageSize,'\0');put32(page,4,indexPage);put32(page,8,type);put32(page,12,first);
        put32(page,16,get32(bytes,20));page[27]=char(0x64);put16(page,32,0x1fff);put16(page,34,0x1fff);put16(page,36,1004);
        put32(page,44,first);bytes.resize((indexPage+1)*pageSize);bytes.replace(indexPage*pageSize,pageSize,page);
        put32(bytes,table+8,indexPage);
    }
    for(int i=0;i<rows.size();++i) {
        const auto& row=rows[i];const int used=(row.size()+3)&~3;
        if(used>pageSize-46) return "USB row is too large.";
        QByteArray page(pageSize,'\0');const int index=first+i;
        put32(page,4,index);put32(page,8,type);put32(page,12,index+1);put32(page,16,get32(bytes,20));
        put32(page,24,1|(1<<13)|(0x24<<24));
        put16(page,28,pageSize-46-used);put16(page,30,used);put16(page,32,1);if(type==8 || type==12) put16(page,38,1);
        page.replace(40,row.size(),row);put16(page,pageSize-4,1);put16(page,pageSize-2,1);
        bytes.resize((index+1)*pageSize);bytes.replace(index*pageSize,pageSize,page);
    }
    if(previousLast) put32(bytes,previousLast*pageSize+12,first);
    put32(bytes,table+12,emptyCandidate-1);put32(bytes,table+4,emptyCandidate);
    put32(bytes,12,emptyCandidate+1);
    return {};
}
inline QString addList(QByteArray& bytes, const QString& name, const QList<quint32>& ids, bool history, quint32* newId) {
    if (name.trimmed().isEmpty() || name.size() > 100 || name.contains(QChar::Null) || ids.isEmpty() || ids.size() > 1000)
        return "Invalid playlist name or track count.";
    const auto document = readDatabase(bytes, DatabaseKind::Main);
    if (!document.valid()) return document.error;
    const auto tracks = readTrackIndex(document);
    quint32 id = 1, order = 0;
    for (const auto trackId : ids) if (!tracks.tracks.contains(trackId)) return "A track is no longer available on this USB.";
    for (const auto& row : document.rows) {
        if (row.tableType == (history ? 11u : 7u)) {
            const int offset = row.offset + (history ? 0 : 12);
            if (row.size < (history ? 5 : 21)) return "Invalid existing playlist row.";
            const auto previous = get32(bytes, offset);
            if (previous == 0xffffffffu) return "USB playlist identifiers exhausted.";
            id = std::max(id, previous + 1);
            if (!history && get32(bytes, row.offset) == 0) order = std::max(order, get32(bytes, row.offset + 8) + 1);
        }
    }
    bool existingHistory=false;int retainedEntries=0;
    if(history) for(const auto& item:readHistoryIndex(document).histories) if(item.name==name.trimmed()) {
        if(existingHistory) return "Ambiguous session history.";
        id=item.id;existingHistory=true;
        if(ids.mid(0,item.trackIds.size())==item.trackIds) retainedEntries=item.trackIds.size();
    }
    // Retire only rows owned by this history, retaining their bytes for recovery.
    if(existingHistory && retainedEntries==0) for(const auto& row:document.rows) if(row.tableType==12 && row.size>=12 && get32(bytes,row.offset+4)==id) {
        const int page=row.pageIndex*document.pageSize;
        const int group=row.rowIndex/16,slot=row.rowIndex%16;
        const int flags=page+document.pageSize-36*group-4;
        put16(bytes,flags,qFromLittleEndian<quint16>(bytes.constData()+flags)&~(1u<<slot));
        const quint32 packed=get32(bytes,page+24),valid=(packed>>13)&0x7ff;
        if(valid) put32(bytes,page+24,(packed&~(0x7ffu<<13))|((valid-1)<<13));
        bytes[page+27]=char(quint8(bytes[page+27])|0x10);put16(bytes,page+32,0x1fff);
        put16(bytes,flags+2,0);put32(bytes,page+16,document.sequence);
    }
    QByteArray listRow(history ? 4 : 20, '\0'); put32(listRow, history ? 0 : 12, id);
    if (!history) put32(listRow, 8, order); listRow.append(nameBytes(name.trimmed()));
    auto error = existingHistory ? QString() : appendRows(bytes, history ? 11 : 7, {listRow}); if (!error.isEmpty()) return error;
    QList<QByteArray> entries;
    for (int i = retainedEntries; i < ids.size(); ++i) {
        QByteArray row(12, '\0');
        put32(row, history ? 0 : 4, ids[i]); put32(row, history ? 4 : 8, id); put32(row, history ? 8 : 0, i + 1);
        entries.append(row);
    }
    error = appendRows(bytes, history ? 12 : 8, entries); if (!error.isEmpty()) return error;
    put32(bytes, 20, document.sequence + 1);
    const auto checked = readDatabase(bytes, DatabaseKind::Main); if (!checked.valid()) return checked.error;
    if (history) {
        const auto historyIndex = readHistoryIndex(checked);
        bool found = false;
        for (const auto& item : historyIndex.histories) if (item.id == id && item.trackIds == ids && item.name == name.trimmed()) found = true;
        if (!found) return "Updated history failed verification.";
    } else {
        const auto playlists = readPlaylistIndex(checked);
        if (!playlists.error.isEmpty() || !playlists.playlists.contains(id) || playlists.playlists[id].name != name.trimmed() ||
                playlists.tracks[id].values() != ids) return "Updated playlist failed verification.";
    }
    *newId = id; return {};
}
} // namespace playlistwriter
inline QString writeUsbList(DeviceSnapshot* expected, const QString& name, const QList<quint32>& ids,
        bool history, quint32* newId) {
    const auto path = resolvePath(expected->root, "PIONEER/rekordbox/export.pdb");
    if (path.isEmpty() || path != expected->databasePath || !inspectDevice(expected->root).matches(*expected)) return "USB is unavailable or changed.";
    QLockFile lock(path + ".nauticmixxx.lock"); if (!lock.tryLock(0)) return "Another USB update is in progress.";
    const auto document = readDatabaseFile(path, DatabaseKind::Main);
    if (!document.valid() || QCryptographicHash::hash(document.bytes, QCryptographicHash::Sha256) != expected->fingerprint) return "USB database changed.";
    QByteArray modified = document.bytes;
    auto error = playlistwriter::addList(modified, name, ids, history, newId); if (!error.isEmpty()) return error;
    error = performance::atomicWrite(path + ".nauticmixxx-playlist-backup", document.bytes);
    if (!error.isEmpty()) return "Could not save USB recovery copy: " + error;
    if (!inspectDevice(expected->root).matches(*expected) || resolvePath(expected->root, "PIONEER/rekordbox/export.pdb") != path) return "USB changed before committing.";
    error = performance::atomicWrite(path, modified);
    if (!error.isEmpty()) return "Could not save USB playlist: " + error;
    expected->fingerprint = QCryptographicHash::hash(modified, QCryptographicHash::Sha256); return {};
}
} // namespace mixxx::rekordbox
