#pragma once

#include <QJsonObject>

#include "track/track_decl.h"

namespace mixxx::rekordbox {
struct DatabaseTrack;
struct DeviceSnapshot;

// This descriptor records origin and original values, not validated ANLZ
// capabilities. Its presence alone must never suppress an analyzer.
QJsonObject makeTrackSource(const DatabaseTrack& track, const DeviceSnapshot& device);

// Returns true when a new export's metadata was applied. Repeated loads of the
// same export preserve the user's local changes. Missing/invalid fields never
// clear useful native metadata. Audio stream properties come from the decoder.
bool applyTrackMetadata(const TrackPointer& track, const QJsonObject& source);
} // namespace mixxx::rekordbox
