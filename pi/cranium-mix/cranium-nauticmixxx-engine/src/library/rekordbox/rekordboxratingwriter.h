#pragma once

#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QLockFile>
#include <QSaveFile>
#include <QtEndian>
#include "library/rekordbox/rekordboxdatabase.h"
#include "library/rekordbox/rekordboxdevice.h"

namespace mixxx::rekordbox {
// Explicit fixed-field edit. Generic tag/collection writers still treat USB
// exports as read-only. No table rebuilding, track IDs or ANLZ bytes change.
inline QString writeUsbRating(const DeviceSnapshot& expected,quint32 trackId,
        const QString& expectedAudioPath,int rating,QByteArray* newFingerprint) {
    if(rating<0 || rating>5 || !trackId) return QStringLiteral("Invalid rating.");
    const auto path=resolvePath(expected.root,"PIONEER/rekordbox/export.pdb");
    if(path.isEmpty() || path!=expected.databasePath)
        return QStringLiteral("USB database is unavailable.");
    QLockFile lock(path+".nauticmixxx.lock");
    if(!lock.tryLock(0)) return QStringLiteral("Another rating update is in progress.");
    const auto document=readDatabaseFile(path,DatabaseKind::Main);
    if(!document.valid()) return QStringLiteral("Invalid USB database: ")+document.error;
    if(QCryptographicHash::hash(document.bytes,QCryptographicHash::Sha256)!=expected.fingerprint)
        return QStringLiteral("USB export changed. Reconnect the device before editing.");
    const auto tracks=readTrackIndex(document);
    if(!tracks.error.isEmpty() || !tracks.tracks.contains(trackId) ||
            tracks.tracks.value(trackId).filePath!=expectedAudioPath)
        return QStringLiteral("USB track identity changed.");
    qint64 offset=-1;
    for(const auto& row:document.rows) if(row.tableType==0 && row.size>=136 &&
            qFromLittleEndian<quint32>(document.bytes.constData()+row.offset+72)==trackId) {
        if(offset>=0) return QStringLiteral("Ambiguous USB track identity.");
        offset=row.offset+89;
    }
    if(offset<0) return QStringLiteral("USB track was not found.");
    QByteArray modified=document.bytes;modified[int(offset)]=char(rating);
    if(modified==document.bytes) {if(newFingerprint) *newFingerprint=expected.fingerprint;return {};}
    // Keep one bounded recovery copy, replacing it only before a validated edit.
    QSaveFile backup(path+".nauticmixxx-rating-backup");
    backup.setDirectWriteFallback(false);
    if(!backup.open(QIODevice::WriteOnly) || backup.write(document.bytes)!=document.bytes.size() || !backup.commit())
        return QStringLiteral("Could not save the USB rating backup: ")+backup.errorString();
    QSaveFile output(path);output.setDirectWriteFallback(false);
    if(!output.open(QIODevice::WriteOnly) || output.write(modified)!=modified.size())
        return QStringLiteral("Could not write the USB rating: ")+output.errorString();
    const auto current=inspectDevice(expected.root);
    if(!current.matches(expected) || current.databasePath!=path ||
            resolvePath(expected.root,"PIONEER/rekordbox/export.pdb")!=path)
        return QStringLiteral("USB changed during rating update. Original export retained.");
    if(!output.commit()) return QStringLiteral("Could not commit the USB rating: ")+output.errorString();
    if(newFingerprint) *newFingerprint=QCryptographicHash::hash(modified,QCryptographicHash::Sha256);
    return {};
}
} // namespace mixxx::rekordbox
