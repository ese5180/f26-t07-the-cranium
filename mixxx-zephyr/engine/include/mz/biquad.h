// Stereo biquad filters.
//
// Mixxx's EngineFilterBiquad1* classes design their coefficients with fidlib
// ("PkBq", "LsBq", "HsBq", "LpBq", "HpBq"), which implements Robert
// Bristow-Johnson's Audio EQ Cookbook. This file uses the cookbook formulas
// directly, so no fidlib is needed, and runs them in transposed direct form II.
//
// Mixxx filters in double. Here coefficients are designed in double but the
// filter runs in float: Cortex-M33 and M4 FPUs are single precision, and
// double arithmetic would be done in software for every sample.
#pragma once

#include "mz/config.h"

namespace mz {

enum class BiquadType {
    Peaking,
    LowShelf,
    HighShelf,
    LowPass,
    HighPass,
};

class Biquad {
  public:
    Biquad();

    // gainDb is ignored by LowPass and HighPass.
    void design(BiquadType type, double sampleRate, double frequency, double q, double gainDb = 0);
    void reset();

    // In-place or out-of-place on interleaved stereo.
    void process(const CSAMPLE* in, CSAMPLE* out, int frames);

    // Gain magnitude at a frequency, for tests.
    double magnitudeAt(double frequency, double sampleRate) const;

  private:
    // Normalised coefficients (a0 == 1).
    float m_b0, m_b1, m_b2, m_a1, m_a2;
    // State per channel.
    float m_z1[2];
    float m_z2[2];
};

} // namespace mz
