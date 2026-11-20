#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>

#include "control/controlobject.h"
#include "track/cue.h"
#include "track/track.h"
#include "waveform/rekordboxwaveform.h"

namespace mixxx::beatgrid {

struct EdgeTicks {
    float topStart;
    float topEnd;
    float bottomStart;
    float bottomEnd;
};

// Keep the ticks in the margins around the signal. Downbeats extend two skin
// pixels farther away from the waveform, as on the supplied XDJ references.
inline EdgeTicks edgeTicks(float breadth, float scale, float length, bool downbeat) {
    const float tick = std::min(length * scale, breadth / 2.f);
    const float extension = downbeat ? std::min(2.f * scale, tick / 4.f) : 0.f;
    // Leave two pixels outside a downbeat for the HOT CUE badge. Its inner
    // end remains visible underneath the badge at both edges.
    const float topStart = std::max(0.f, 4.f * scale - extension);
    const float bottomStart = std::max(0.f, breadth - 4.f * scale - tick);
    return {topStart,
            std::min(breadth, 4.f * scale + tick),
            bottomStart,
            std::min(breadth, bottomStart + tick + extension)};
}

inline bool editingDeck(const QString& group) {
    return ControlObject::exists(ConfigKey("[RX3Controller]","grid_mode")) &&
            ControlObject::get(ConfigKey("[RX3Controller]","grid_mode"))>0 &&
            group==QString("[Channel%1]").arg(qRound(ControlObject::get(ConfigKey("[RX3Controller]","active_deck"))));
}
inline EdgeTicks displayTicks(float breadth,float scale,float length,bool downbeat,bool editing) {
    return downbeat && editing ? EdgeTicks{0,breadth,0,0} : edgeTicks(breadth,scale,length,downbeat);
}

// The exported beat grid can begin during silence. Prefer the decoded audio
// onset; ANLZ and the existing first-sound cue remain read-only fallbacks.
inline double firstAudibleEngineSample(const TrackPointer& track, double trackSamples) {
    const auto waveform = track->getWaveform();
    if (waveform && waveform->rekordbox) {
        const auto& native = *waveform->rekordbox;
        if (native.durationSeconds > 0) {
            const auto audio = std::atomic_load(&native.signedAudio);
            if (audio && audio->firstAudibleSecond >= 0) {
                return audio->firstAudibleSecond / native.durationSeconds * trackSamples;
            }
            for (const auto& series : native.detail) {
                for (int i = 0; i < series.columns.size(); ++i) {
                    if (series.columns[i].all > 0 && series.columnsPerSecond > 0) {
                        return (i / series.columnsPerSecond) /
                                native.durationSeconds * trackSamples;
                    }
                }
            }
        }
    }
    const auto cue = track->findCueByType(CueType::N60dBSound);
    if (cue && cue->getPosition().isValid()) {
        return cue->getPosition().toEngineSamplePos();
    }
    return 0;
}

} // namespace mixxx::beatgrid
