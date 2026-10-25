#include "mz/mixer.h"

#include <algorithm>

#include "mz/math.h"

namespace mz {

Mixer::Mixer()
        : m_crossfader(0),
          m_headMix(-1), // EngineMixer: headMix defaults to cue only
          m_mainGain(1),
          m_headGain(1),
          m_transform(Xfader::kTransformDefault),
          m_curve(XfaderCurve::Additive),
          m_lastChannelGain{},
          m_lastMainGain(1),
          m_lastHeadGain(1) {
    for (int d = 0; d < kNumDecks; ++d) {
        m_lastChannelGain[d] = 1;
    }
}

void Mixer::control(const ControlEvent& event) {
    switch (event.target) {
    case Target::Crossfader:
        m_crossfader = clampValue(static_cast<double>(event.value), -1.0, 1.0);
        break;
    case Target::HeadMix:
        m_headMix = clampValue(static_cast<double>(event.value), -1.0, 1.0);
        break;
    case Target::MainGain:
        m_mainGain = static_cast<double>(event.value);
        break;
    case Target::HeadGain:
        m_headGain = static_cast<double>(event.value);
        break;
    default:
        break;
    }
}

void Mixer::process(const CSAMPLE* const* decks, const double* volumes, const bool* pfl,
        int frames, CSAMPLE* main, CSAMPLE* headphones) {
    CSAMPLE xfaderGain[kNumDecks];
    // Deck 1 is on the left of the crossfader, deck 2 on the right.
    Xfader::getXfadeGains(m_crossfader,
            m_transform,
            Xfader::getPowerCalibration(m_transform),
            m_curve,
            false,
            &xfaderGain[0],
            &xfaderGain[1]);

    std::fill(main, main + 2 * frames, 0.0f);
    std::fill(headphones, headphones + 2 * frames, 0.0f);

    // The cue bus is pre-fader; it is built in the headphone buffer first.
    const auto n = static_cast<float>(frames);
    for (int d = 0; d < kNumDecks; ++d) {
        const double target = volumes[d] * static_cast<double>(xfaderGain[d]);
        const auto step = static_cast<float>(target - m_lastChannelGain[d]) / n;
        auto gain = static_cast<float>(m_lastChannelGain[d]);
        const CSAMPLE* in = decks[d];
        for (int i = 0; i < frames; ++i) {
            gain += step;
            main[2 * i] += in[2 * i] * gain;
            main[2 * i + 1] += in[2 * i + 1] * gain;
            if (pfl[d]) {
                headphones[2 * i] += in[2 * i];
                headphones[2 * i + 1] += in[2 * i + 1];
            }
        }
        m_lastChannelGain[d] = target;
    }

    // EngineMixer: headMix -1 is cue only, +1 main only.
    const auto pflGain = static_cast<CSAMPLE>(0.5 * (-m_headMix + 1.0));
    const auto mainInHeadphones = static_cast<CSAMPLE>(0.5 * (m_headMix + 1.0));

    const auto mainStep = static_cast<float>(m_mainGain - m_lastMainGain) / n;
    const auto headStep = static_cast<float>(m_headGain - m_lastHeadGain) / n;
    auto mainGain = static_cast<float>(m_lastMainGain);
    auto headGain = static_cast<float>(m_lastHeadGain);
    for (int i = 0; i < frames; ++i) {
        mainGain += mainStep;
        headGain += headStep;
        for (int ch = 0; ch < 2; ++ch) {
            const CSAMPLE mainSample = main[2 * i + ch];
            headphones[2 * i + ch] =
                    (headphones[2 * i + ch] * pflGain + mainSample * mainInHeadphones) * headGain;
            main[2 * i + ch] = mainSample * mainGain;
        }
    }
    m_lastMainGain = m_mainGain;
    m_lastHeadGain = m_headGain;
}

} // namespace mz
