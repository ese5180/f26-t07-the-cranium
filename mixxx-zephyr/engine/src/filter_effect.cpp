// Ported from Mixxx's filtereffect.cpp and the LinkedLeft / LinkedRight
// arithmetic in src/effects/effectknobparameterslot.cpp.
#include "mz/filter_effect.h"

#include <algorithm>

#include "mz/control_behavior.h"

namespace mz {

namespace {

// ControlEffectKnob::setBehaviour: Logarithmic with a minimum above 0 is
// ControlLogPotmeterBehavior(min, max, -40). Built on the stack rather than as
// a global so that the engine needs no static constructors.
double cornerForParameter(double parameter) {
    const LogTaper taper(FilterEffect::kMinCorner, FilterEffect::kMaxCorner, -40);
    return taper.parameterToValue(parameter);
}

} // namespace

FilterEffect::FilterEffect(double sampleRate)
        : m_sampleRate(sampleRate),
          m_knob(0.5),
          m_lpfCorner(kMaxCorner),
          m_hpfCorner(kMinCorner),
          m_loFreq(kMaxCorner),
          m_q(kDefaultQ),
          m_hiFreq(kMinCorner) {
    m_lowFilter.design(BiquadType::LowPass, m_sampleRate, m_loFreq, m_q);
    m_highFilter.design(BiquadType::HighPass, m_sampleRate, m_hiFreq, m_q);
}

void FilterEffect::setSampleRate(double sampleRate) {
    m_sampleRate = sampleRate;
    m_lowFilter.design(BiquadType::LowPass, m_sampleRate, m_loFreq, m_q);
    m_highFilter.design(BiquadType::HighPass, m_sampleRate, m_hiFreq, m_q);
}

double FilterEffect::lowPassCorner(double superKnob) {
    // LinkedLeft: the right half holds the parameter at 1.
    const double parameter = superKnob >= 0.5 ? 1.0 : superKnob * 2;
    return cornerForParameter(parameter);
}

double FilterEffect::highPassCorner(double superKnob) {
    // LinkedRight: the left half holds the parameter at 0.
    const double parameter = superKnob >= 0.5 ? (superKnob - 0.5) * 2 : 0.0;
    return cornerForParameter(parameter);
}

void FilterEffect::process(CSAMPLE* buffer, int frames, double superKnob, double q) {
    if (superKnob != m_knob) {
        m_knob = superKnob;
        m_lpfCorner = lowPassCorner(superKnob);
        m_hpfCorner = highPassCorner(superKnob);
    }
    const double lpf = m_lpfCorner;
    const double hpf = m_hpfCorner;

    if (m_loFreq != lpf || m_q != q || m_hiFreq != hpf) {
        double ratio = hpf / lpf;
        double clampedQ = q;
        if (ratio < 1.414 && ratio >= 1) {
            ratio -= 1;
            const double qmax = 2 + ratio * ratio * ratio * 29;
            clampedQ = std::min(clampedQ, qmax);
        } else if (ratio < 1 && ratio >= 0.7) {
            clampedQ = std::min(clampedQ, 2.0);
        } else if (ratio < 0.7 && ratio > 0.1) {
            ratio -= 0.1;
            const double qmax = 4 - 2 / 0.6 * ratio;
            clampedQ = std::min(clampedQ, qmax);
        }
        m_lowFilter.design(BiquadType::LowPass, m_sampleRate, lpf, clampedQ);
        m_highFilter.design(BiquadType::HighPass, m_sampleRate, hpf, clampedQ);
    }

    // Each filter runs while it is engaged, and for one more block after it is
    // released so that its state decays (Mixxx's processAndPauseFilter).
    if (hpf > kMinCorner || m_hiFreq > kMinCorner) {
        m_highFilter.process(buffer, buffer, frames);
        if (hpf <= kMinCorner) {
            m_highFilter.reset();
        }
    }
    if (lpf < kMaxCorner || m_loFreq < kMaxCorner) {
        m_lowFilter.process(buffer, buffer, frames);
        if (lpf >= kMaxCorner) {
            m_lowFilter.reset();
        }
    }

    m_loFreq = lpf;
    m_q = q;
    m_hiFreq = hpf;
}

} // namespace mz
