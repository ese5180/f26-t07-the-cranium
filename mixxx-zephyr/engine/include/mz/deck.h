// One deck: play position, transport, cue points, loops, tempo and jog.
//
// The parts of Mixxx's EngineBuffer, CueControl, LoopingControl and
// RateControl that the DDJ-FLX4 mapping uses, without keylock, sync, beat
// grids or slip mode. All methods run on the audio thread.
#pragma once

#include <atomic>
#include <cstdint>

#include "mz/caching_reader.h"
#include "mz/config.h"
#include "mz/controls.h"
#include "mz/eq.h"
#include "mz/filter_effect.h"
#include "mz/scratch.h"

namespace mz {

// What the LEDs and a display may show; readable from any thread.
struct DeckStatus {
    bool trackLoaded;
    bool playing;
    bool cueIndicator;
    bool pfl;
    bool loopEnabled;
    uint8_t hotcuesSet; // bit n: hotcue n + 1 is set
    int64_t position; // frames in the track
    int64_t frameCount;
    uint32_t underruns;
};

class Deck {
  public:
    // Mixxx's defaults (DlgPrefDeck): 8 % range, slider down speeds up.
    static constexpr double kDefaultRateRange = 0.08;
    static constexpr double kDefaultRateDir = -1;
    // The FLX4 script's tempo ranges (PioneerDDJFLX4.tempoRanges).
    static constexpr double kTempoRanges[4] = {0.06, 0.10, 0.16, 0.25};

    explicit Deck(CachingReader* reader);

    void setOutputRate(double sampleRate);
    void trackLoaded(uint32_t generation, int64_t frameCount, uint32_t sampleRate);

    void control(const ControlEvent& event);

    // Renders frames of interleaved stereo after trim, EQ and filter.
    void process(CSAMPLE* out, int frames);

    // Fader-side values for the mixer.
    double volume() const {
        return m_volume;
    }
    bool pfl() const {
        return m_pfl;
    }

    DeckStatus status() const;
    void publishStatus();
    // The status last published, for other threads.
    DeckStatus publishedStatus() const;

    // For tests.
    double position() const {
        return m_position;
    }
    bool isPlaying() const {
        return m_play || m_cuePreview || m_hotcuePreview >= 0;
    }
    double rateRatio() const;
    double cuePoint() const {
        return m_cuePoint;
    }
    double hotcue(int index) const {
        return m_hotcues[index];
    }
    bool loopEnabled() const {
        return m_loopEnabled;
    }
    bool scratching() const {
        return m_scratchEnabled;
    }

  private:
    void seek(double position);
    void onCue(bool pressed);
    void onHotcue(int index, bool pressed);
    void onPlay();
    double currentSpeed(double blockSeconds);

    CachingReader* m_reader;
    double m_outputRate;
    uint32_t m_trackRate;
    int64_t m_frameCount;

    // Transport.
    double m_position; // in track frames
    bool m_play;
    bool m_cuePreview;
    int m_hotcuePreview; // index, or -1
    double m_cuePoint;
    double m_hotcues[kNumHotcues]; // -1 when unset
    double m_loopStart;
    double m_loopEnd;
    bool m_loopEnabled;

    // Tempo and jog.
    double m_rateSlider;
    double m_rateRange;
    double m_rateDir;
    double m_jogInput; // jog ticks since the last jog-filter period
    double m_jogFactor;
    double m_jogClock;
    Rotary m_jogFilter;
    Scratcher m_scratcher;
    bool m_scratchEnabled;
    double m_lastStep; // frames of track per output frame, last block

    // Channel strip.
    double m_pregain;
    double m_lastPregain;
    double m_eqLow, m_eqMid, m_eqHigh;
    double m_filterKnob;
    double m_volume;
    bool m_pfl;
    ThreeBandEq m_eq;
    FilterEffect m_filter;

    // Published status.
    std::atomic<uint32_t> m_statusFlags;
    std::atomic<int32_t> m_statusPosition;
    std::atomic<int32_t> m_statusFrames;
    std::atomic<uint32_t> m_statusUnderruns;
};

} // namespace mz
