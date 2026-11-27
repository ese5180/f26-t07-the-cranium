#pragma once
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>
#include <QLockFile>
#include "util/rx3usbstorage.h"
#include <QDir>
#include "library/rekordbox/rekordboxdevice.h"
#include "widget/rx3mysettings.h"

namespace rx3 {
// Blocking USB I/O belongs on a worker. Controls are snapshotted by the caller.
inline QString saveUsbMySettings(const QString& root,const QMap<QString,double>& values) {
    rx3::UsbStorageInfo storage(root);storage.refresh();
    if(root.isEmpty() || !storage.isReady() || storage.isReadOnly()) return QString("Select a writable USB in SOURCE first.");
    const auto canonicalRoot=QFileInfo(root).canonicalFilePath();
    const auto volumeDevice=storage.device();
    const auto snapshot=mixxx::rekordbox::inspectDevice(root);
    if(snapshot.state!=mixxx::rekordbox::DeviceState::Readable) return QString("The selected rekordbox USB is unavailable.");
    const auto directory=QDir(root).filePath("PIONEER");
    auto sameUsb=[&] {
        rx3::UsbStorageInfo current(root);current.refresh();
        return current.isReady() && !current.isReadOnly() && current.device()==volumeDevice &&
                QFileInfo(root).canonicalFilePath()==canonicalRoot &&
                !QFileInfo(directory).isSymLink() && QFileInfo(directory).canonicalFilePath()==canonicalRoot+"/PIONEER" &&
                mixxx::rekordbox::inspectDevice(root).matches(snapshot);
    };
    if(QFileInfo(directory).isSymLink() || !QFileInfo(directory).canonicalFilePath().startsWith(QFileInfo(root).canonicalFilePath()+"/")) return QString("Invalid USB settings directory.");
    QLockFile lock(QDir(directory).filePath("nauticmixxx-settings.lock"));
    if(!lock.tryLock(0)) return QString("Another MY SETTINGS update is in progress.");
    QMap<QString,QByteArray> originals,updated;
    for(const auto& name:{"MYSETTING.DAT","MYSETTING2.DAT","DJMMYSETTING.DAT","DEVSETTING.DAT"}) {
        const auto path=QDir(directory).filePath(name);QFile file(path);if(!file.exists()) continue;
        if(QFileInfo(path).isSymLink() || !file.open(QIODevice::ReadOnly) || file.size()>4096) return QString(QString("Cannot read ")+name);
        originals[path]=file.readAll();QString error;
        updated[path]=rx3::writeMySettings(name,originals[path],values,&error);
        if(!error.isEmpty()) return QString(QString(name)+": "+error+". No settings saved.");
    }
    if(updated.isEmpty()) return QString("Export MY SETTINGS from rekordbox to this USB before saving.");
    auto write=[](const QString& path,const QByteArray& bytes) {if(QFileInfo(path).isSymLink()) return false;QSaveFile file(path);file.setDirectWriteFallback(false);return file.open(QIODevice::WriteOnly) && file.write(bytes)==bytes.size() && file.commit();};
    // Release the read handle before atomic replacement, including rollback.
    // Windows does not allow replacing a destination that remains open here.
    auto matches=[](const QString& path,const QByteArray& bytes) {QFile file(path);return !QFileInfo(path).isSymLink() && file.open(QIODevice::ReadOnly) && file.readAll()==bytes;};
    for(auto it=originals.cbegin();it!=originals.cend();++it) if(!sameUsb() || !write(it.key()+".nauticmixxx-settings-backup",it.value())) return QString("Unable to save the USB recovery copy.");
    QStringList committed;
    for(auto it=updated.cbegin();it!=updated.cend();++it) {
        if(!sameUsb() || !matches(it.key(),originals[it.key()]) || !sameUsb() || !write(it.key(),it.value())) {
            for(const auto& path:committed) {
                if(sameUsb() && matches(path,updated[path])) write(path,originals[path]);
            }
            return QString("USB settings changed or could not be saved. Recovery copies retained.");
        }
        committed.append(it.key());
    }
    return QString("MY SETTINGS saved to USB. Device deck defaults use DECK 1 settings.");
}
} // namespace rx3
