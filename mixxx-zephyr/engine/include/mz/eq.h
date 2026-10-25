// Three-band mixing EQ: Mixxx's "Biquad Equalizer"
// (src/effects/backends/builtin/threebandbiquadeqeffect.cpp).
//
// Two bell filters and a shelf per band direction: a boost filter used when a
// knob is above its centre, a cut filter used when it is below. It is the
// cheapest of Mixxx's mixing EQs, which suits a microcontroller.
#pragma once

#include "mz/biquad.h"
#include "mz/config.h"

namespace mz {

class ThreeBandEq {
  public:
    // Defaults of Mixxx's mixer preferences (DlgPrefMixer::setDefaultShelves).
    static constexpr double kDefaultLowCorner = 250;
    static constexpr double kDefaultHighCorner = 2500;

    explicit ThreeBandEq(double sampleRate = 48000);

    void setSampleRate(double sampleRate);
    void setCorners(double lowCorner, double highCorner);

    // Knob values as in Mixxx: 0..2 with 1 neutral (linear scale).
    // kill forces the band to the kill gain.
    void process(CSAMPLE* buffer, int frames,
            double low, double mid, double high,
            bool killLow, bool killMid, bool killHigh);

    // Gain in dB for a knob value, as knobValueToBiquadGainDb() in Mixxx.
    static double knobValueToGainDb(double value, bool kill);

  private:
    void designAll();

    double m_sampleRate;
    double m_lowCorner;
    double m_highCorner;
    // Bell centres, derived from the corners in designAll().
    double m_lowCenter;
    double m_midCenter;
    double m_highCenter;

    Biquad m_lowBoost, m_midBoost, m_highBoost;
    Biquad m_lowCut, m_midCut, m_highCut;
    double m_oldLowBoost, m_oldMidBoost, m_oldHighBoost;
    double m_oldLowCut, m_oldMidCut, m_oldHighCut;
};

} // namespace mz
