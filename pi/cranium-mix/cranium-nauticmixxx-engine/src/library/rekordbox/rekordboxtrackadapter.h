#pragma once

#include <memory>
#include <optional>

#include "library/rekordbox/rekordboxwaveformimporter.h"
#include "track/track_decl.h"

namespace mixxx::rekordbox {

class RekordboxUsbSession;
class SessionState;
struct RuntimeTrack;

// Internal projection boundary. Only RekordboxUsbSession may project a
// catalog-issued RuntimeTrack into Mixxx's temporary Track model.
class RekordboxTrackAdapter final {
  private:
    friend class RekordboxUsbSession;

    static TrackPointer createTemporaryTrack(
            const RuntimeTrack& runtimeTrack,
            const std::shared_ptr<const SessionState>& sessionState,
            QList<LoadedRuntimeWaveform> waveforms,
            QString* error);
};

} // namespace mixxx::rekordbox
