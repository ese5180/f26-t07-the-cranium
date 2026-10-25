// The deck's quick-effect filter (the FLX4's CFX knob), ported from Mixxx's
// src/effects/backends/builtin/filtereffect.cpp.
//
// One "super" knob drives it: left of centre lowers the low-pass corner,
// right of centre raises the high-pass corner, centre bypasses both. Mixxx
// links the knob to the two corners with LinkedLeft / LinkedRight and maps
// each corner logarithmically from 13 Hz to 22050 Hz.
#pragma once

#include "mz/biquad.h"
#include "mz/config.h"

namespace mz {

class FilterEffect {
  public:
    static constexpr double kMinCorner = 13; // Hz
    static constexpr double kMaxCorner = 22050; // Hz
    static constexpr double kDefaultQ = 0.707106781; // Butterworth

    explicit FilterEffect(double sampleRate = 48000);

    void setSampleRate(double sampleRate);

    // superKnob in [0, 1], 0.5 is neutral.
    void process(CSAMPLE* buffer, int frames, double superKnob, double q = kDefaultQ);

    // Corner frequencies for a super-knob position, for tests.
    static double lowPassCorner(double superKnob);
    static double highPassCorner(double superKnob);

  private:
    double m_sampleRate;
    double m_knob; // the super-knob position the corners below belong to
    double m_lpfCorner;
    double m_hpfCorner;
    double m_loFreq;
    double m_q;
    double m_hiFreq;
    Biquad m_lowFilter;
    Biquad m_highFilter;
};

} // namespace mz
