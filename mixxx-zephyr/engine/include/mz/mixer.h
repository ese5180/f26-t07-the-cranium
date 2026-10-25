// Main and headphone mix, from Mixxx's src/engine/enginemixer.cpp.
//
// Each deck goes through its channel fader and the crossfader into the main
// bus. Decks with PFL on go, before their fader, to the cue bus, which the
// headMix knob blends with the main bus for the headphones.
#pragma once

#include "mz/config.h"
#include "mz/controls.h"
#include "mz/xfader.h"

namespace mz {

enum class OutputMode : uint8_t {
    Main, // stereo main mix
    Headphones, // stereo headphone mix
    // One stereo output for both: left is the cue mix in mono, right the main
    // mix in mono (Mixxx's "split cue").
    SplitCue,
};

class Mixer {
  public:
    Mixer();

    void control(const ControlEvent& event);

    // decks[d] holds the rendered block of deck d; volumes and pfl come from
    // the decks. Writes stereo main and headphone mixes.
    void process(const CSAMPLE* const* decks, const double* volumes, const bool* pfl,
            int frames, CSAMPLE* main, CSAMPLE* headphones);

    double crossfader() const {
        return m_crossfader;
    }

  private:
    double m_crossfader;
    double m_headMix;
    double m_mainGain;
    double m_headGain;
    double m_transform;
    XfaderCurve m_curve;

    // Gains at the end of the last block, for ramping.
    double m_lastChannelGain[kNumDecks];
    double m_lastMainGain;
    double m_lastHeadGain;
};

} // namespace mz
