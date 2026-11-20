#include "library/rekordbox/rekordboxmetadata.h"

#include <QFileInfo>

#include "library/rekordbox/rekordboxdatabase.h"
#include "library/rekordbox/rekordboxdevice.h"
#include "track/keyfactory.h"
#include "track/track.h"

namespace mixxx::rekordbox {
QJsonObject makeTrackSource(const DatabaseTrack& track, const DeviceSnapshot& device) {
    return {{"version", 1},
            {"provider", "rekordbox_usb"},
            {"root", device.root},
            {"db_fingerprint", QString::fromLatin1(device.fingerprint.toHex())},
            {"relative_path", track.filePath},
            {"analysis_relative_path", track.analysisPath},
            {"rekordbox_id", static_cast<double>(track.id)},
            {"metadata", track.metadata}};
}

bool applyTrackMetadata(const TrackPointer& track, const QJsonObject& source) {
    if (!track || source.value("provider") != "rekordbox_usb" ||
            source.value("version").toInt() != 1) {
        return false;
    }
    const auto location = resolvePath(source.value("root").toString(),
            source.value("relative_path").toString(), false);
    if (location.isEmpty() ||
            QFileInfo(location).absoluteFilePath() != QFileInfo(track->getLocation()).absoluteFilePath()) {
        return false;
    }
    if (track->getExternalSource() == source) {
        return false;
    }
    const auto metadata = source.value("metadata").toObject();
    if (!track->setExternalSource(source)) return false;
    for (const auto& field : std::initializer_list<std::pair<const char*, void (Track::*)(const QString&)>>{
                 {"artist", &Track::setArtist}, {"title", &Track::setTitle},
                 {"album", &Track::setAlbum}, {"composer", &Track::setComposer},
                 {"comment", &Track::setComment}}) {
        const auto value = metadata.value(field.first).toString();
        if (!value.isEmpty()) (track.get()->*field.second)(value);
    }
    const auto year = metadata.value("year").toInt();
    if (year > 0) track->setYear(QString::number(year));
    const auto number = metadata.value("track_number").toDouble();
    if (number > 0 && number <= 4294967295.0) track->setTrackNumber(QString::number(static_cast<quint32>(number)));
    const auto rating = metadata.value("rating").toInt(-1);
    if (rating >= 0 && rating <= 5) track->setRating(rating);
    const auto bpm = metadata.value("bpm").toDouble();
    if (bpm > 0 && bpm <= 500) track->trySetBpm(bpm);
    const auto keys = KeyFactory::makeBasicKeysKeepText(
            metadata.value("key").toString(), mixxx::track::io::key::FILE_METADATA);
    if (keys.getGlobalKey() != mixxx::track::io::key::INVALID) {
        track->setKeys(keys);
    }
    return true;
}
} // namespace mixxx::rekordbox
