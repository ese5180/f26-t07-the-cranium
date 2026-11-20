#pragma once

#include <algorithm>
#include <cmath>
#include <functional>
#include "control/controlproxy.h"
#include "track/track_decl.h"

namespace rx3 {
// The loader reports completion only after the audio engine has accepted the
// track. A released or superseded gesture cannot start a delayed preview.
class TouchPreview {
  public:
    using Loader = std::function<void(TrackPointer)>;
    explicit TouchPreview(Loader loader)
            : m_load(std::move(loader)), m_play("[PreviewDeck1]", "play"),
              m_position("[PreviewDeck1]", "playposition"),
              m_main("[PreviewDeck1]", "main_mix"), m_pfl("[PreviewDeck1]", "pfl") {}
    void begin(TrackPointer track, TrackPointer loaded, double fraction) {
        cancel();
        if (!track || !std::isfinite(fraction)) return;
        m_track = track; m_fraction = std::clamp(fraction, 0.0, 1.0); m_held = true;
        m_main.set(0); m_pfl.set(1);
        if (track == loaded) completed(track);
        else m_load(track);
    }
    void completed(TrackPointer track) {
        if (!m_held || track != m_track) return;
        m_ready = true; m_position.set(m_fraction); m_play.set(1);
    }
    void move(double fraction) {
        if (!m_held || !std::isfinite(fraction)) return;
        m_fraction = std::clamp(fraction, 0.0, 1.0);
        if (m_ready) m_position.set(m_fraction);
    }
    void cancel() {
        if (m_held) m_play.set(0);
        m_held = m_ready = false; m_track.reset();
    }
    bool held() const { return m_held; }
    double fraction() const { return m_fraction; }
  private:
    Loader m_load;
    ControlProxy m_play, m_position, m_main, m_pfl;
    TrackPointer m_track;
    bool m_held = false, m_ready = false;
    double m_fraction = 0;
};
} // namespace rx3
