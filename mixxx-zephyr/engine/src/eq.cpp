// Ported from Mixxx's src/effects/backends/builtin/threebandbiquadeqeffect.cpp.
#include "mz/eq.h"

#include <cmath>

namespace mz {

namespace {

constexpr double kMinimumFrequency = 10.0;
constexpr double kQBoost = 0.3;
constexpr double kQKill = 0.9;
constexpr double kQKillShelve = 0.4;
constexpr double kBoostGain = 12;
constexpr double kKillGain = -26;

double getCenterFrequency(double low, double high) {
    const double scaleLow = std::log10(low);
    const double scaleHigh = std::log10(high);
    const double scaleCenter = (scaleHigh - scaleLow) / 2 + scaleLow;
    return std::pow(10, scaleCenter);
}

} // namespace

ThreeBandEq::ThreeBandEq(double sampleRate)
        : m_sampleRate(sampleRate),
          m_lowCorner(kDefaultLowCorner),
          m_highCorner(kDefaultHighCorner),
          m_lowCenter(0),
          m_midCenter(0),
          m_highCenter(0),
          m_oldLowBoost(0),
          m_oldMidBoost(0),
          m_oldHighBoost(0),
          m_oldLowCut(0),
          m_oldMidCut(0),
          m_oldHighCut(0) {
    designAll();
}

void ThreeBandEq::setSampleRate(double sampleRate) {
    m_sampleRate = sampleRate;
    designAll();
}

void ThreeBandEq::setCorners(double lowCorner, double highCorner) {
    m_lowCorner = lowCorner;
    m_highCorner = highCorner;
    designAll();
}

double ThreeBandEq::knobValueToGainDb(double value, bool kill) {
    if (kill) {
        return kKillGain;
    }
    double ret = value - 1;
    if (ret >= 0) {
        ret *= kBoostGain;
    } else {
        ret *= -kKillGain;
    }
    return ret;
}

void ThreeBandEq::designAll() {
    // Mixxx's maximum is the start-up sample rate's Nyquist (22050 Hz).
    const double maximumFrequency = 44100 / 2.0;
    m_lowCenter = getCenterFrequency(kMinimumFrequency, m_lowCorner);
    m_midCenter = getCenterFrequency(m_lowCorner, m_highCorner);
    m_highCenter = getCenterFrequency(m_highCorner, maximumFrequency);
    m_lowBoost.design(BiquadType::Peaking, m_sampleRate, m_lowCenter, kQBoost, m_oldLowBoost);
    m_midBoost.design(BiquadType::Peaking, m_sampleRate, m_midCenter, kQBoost, m_oldMidBoost);
    m_highBoost.design(BiquadType::Peaking, m_sampleRate, m_highCenter, kQBoost, m_oldHighBoost);
    m_lowCut.design(BiquadType::Peaking, m_sampleRate, m_lowCenter, kQKill, m_oldLowCut);
    m_midCut.design(BiquadType::Peaking, m_sampleRate, m_midCenter, kQKill, m_oldMidCut);
    m_highCut.design(BiquadType::HighShelf, m_sampleRate, m_highCenter / 2, kQKillShelve,
            m_oldHighCut);
}

void ThreeBandEq::process(CSAMPLE* buffer, int frames,
        double low, double mid, double high,
        bool killLow, bool killMid, bool killHigh) {
    const double lowCenter = m_lowCenter;
    const double midCenter = m_midCenter;
    const double highCenter = m_highCenter;

    const double gainLow = knobValueToGainDb(low, killLow);
    const double gainMid = knobValueToGainDb(mid, killMid);
    const double gainHigh = knobValueToGainDb(high, killHigh);

    // As in Mixxx, a filter keeps running for one more block after its gain
    // returns to 0 dB, so that its state decays instead of being cut off.
    auto stage = [&](Biquad& filter, double& oldGain, double newGain, bool active,
                         BiquadType type, double frequency, double q) {
        if (!(active || oldGain != 0.0)) {
            return;
        }
        if (newGain != oldGain) {
            filter.design(type, m_sampleRate, frequency, q, newGain);
            oldGain = newGain;
        }
        filter.process(buffer, buffer, frames);
        if (newGain == 0.0) {
            filter.reset();
        }
    };

    stage(m_lowBoost, m_oldLowBoost, gainLow > 0 ? gainLow : 0, gainLow > 0,
            BiquadType::Peaking, lowCenter, kQBoost);
    stage(m_lowCut, m_oldLowCut, gainLow < 0 ? gainLow : 0, gainLow < 0,
            BiquadType::Peaking, lowCenter, kQKill);
    stage(m_midBoost, m_oldMidBoost, gainMid > 0 ? gainMid : 0, gainMid > 0,
            BiquadType::Peaking, midCenter, kQBoost);
    stage(m_midCut, m_oldMidCut, gainMid < 0 ? gainMid : 0, gainMid < 0,
            BiquadType::Peaking, midCenter, kQKill);
    stage(m_highBoost, m_oldHighBoost, gainHigh > 0 ? gainHigh : 0, gainHigh > 0,
            BiquadType::Peaking, highCenter, kQBoost);
    stage(m_highCut, m_oldHighCut, gainHigh < 0 ? gainHigh : 0, gainHigh < 0,
            BiquadType::HighShelf, highCenter / 2, kQKillShelve);
}

} // namespace mz
