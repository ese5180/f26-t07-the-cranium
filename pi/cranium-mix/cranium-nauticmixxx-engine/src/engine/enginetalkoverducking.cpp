#include "engine/enginetalkoverducking.h"

#include "control/controllinpotmeter.h"
#include "control/controlproxy.h"
#include "moc_enginetalkoverducking.cpp"
#include <algorithm>
#include <cmath>

namespace {

constexpr CSAMPLE kDuckThreshold = 0.1f;

} // namespace

EngineTalkoverDucking::EngineTalkoverDucking(
        UserSettingsPointer pConfig, const QString& group)
        : EngineSideChainCompressor(group),
          m_pConfig(pConfig),
          m_group(group),
          m_rx3Enabled(ConfigKey(group, "rx3_talkover_enabled")),
          m_rx3Level(ConfigKey(group, "rx3_talkover_level"), -24, -6,
                  false, true, false, false, -24) {
    m_rx3Enabled.setButtonMode(ControlPushButton::TOGGLE);
    m_pSampleRate = new ControlProxy(QStringLiteral("[App]"), QStringLiteral("samplerate"), this);
    m_pSampleRate->connectValueChanged(this,
            &EngineTalkoverDucking::slotSampleRateChanged,
            Qt::DirectConnection);

    m_pDuckStrength = new ControlPotmeter(ConfigKey(m_group, "duckStrength"), 0.0, 1.0);
    m_pDuckStrength->set(
            m_pConfig->getValue<double>(ConfigKey(m_group, "duckStrength"), 90) / 100);
    connect(m_pDuckStrength, &ControlObject::valueChanged,
            this, &EngineTalkoverDucking::slotDuckStrengthChanged,
            Qt::DirectConnection);

    // We only allow the strength to be configurable for now.  The next most likely
    // candidate for customization is the threshold, which may be too low for
    // noisy club situations.
    setParameters(
            kDuckThreshold,
            static_cast<CSAMPLE>(m_pDuckStrength->get()),
            static_cast<unsigned int>(m_pSampleRate->get() / 2 * .1),
            static_cast<unsigned int>(m_pSampleRate->get() / 2));

    m_pTalkoverDucking = new ControlPushButton(ConfigKey(m_group, "talkoverDucking"));
    m_pTalkoverDucking->setButtonMode(ControlPushButton::TOGGLE);
    m_pTalkoverDucking->setStates(3);
    m_pTalkoverDucking->set(
            m_pConfig->getValue<double>(
                ConfigKey(m_group, "duckMode"), AUTO));
    connect(m_pTalkoverDucking, &ControlObject::valueChanged,
            this, &EngineTalkoverDucking::slotDuckModeChanged,
            Qt::DirectConnection);
}

EngineTalkoverDucking::~EngineTalkoverDucking() {
    m_pConfig->set(ConfigKey(m_group, "duckStrength"), ConfigValue(m_pDuckStrength->get() * 100));
    m_pConfig->set(ConfigKey(m_group, "duckMode"), ConfigValue(m_pTalkoverDucking->get()));

    delete m_pDuckStrength;
    delete m_pTalkoverDucking;
}

void EngineTalkoverDucking::slotSampleRateChanged(double samplerate) {
    setParameters(
            kDuckThreshold,
            static_cast<CSAMPLE>(m_pDuckStrength->get()),
            static_cast<unsigned int>(samplerate / 2 * .1),
            static_cast<unsigned int>(samplerate / 2));
}

void EngineTalkoverDucking::slotDuckStrengthChanged(double strength) {
    setParameters(kDuckThreshold,
            static_cast<CSAMPLE>(strength),
            static_cast<unsigned int>(m_pSampleRate->get() / 2 * .1),
            static_cast<unsigned int>(m_pSampleRate->get() / 2));
    m_pConfig->set(ConfigKey(m_group, "duckStrength"), ConfigValue(strength * 100));
}

void EngineTalkoverDucking::slotDuckModeChanged(double mode) {
   m_pConfig->set(ConfigKey(m_group, "duckMode"), ConfigValue(mode));
}

CSAMPLE EngineTalkoverDucking::getGain(int numFrames) {
    if (m_rx3Enabled.toBool()) {
        // Normal RX3-style broadband talkover. Software attack/release are
        // 100/500 ms; they still need physical RX3 calibration.
        if (getMode() == OFF) {
            m_rx3Gain = 1;
            return 1;
        }
        const double rate = std::max(8000.0, m_pSampleRate->get());
        const double target = m_rx3AboveThreshold ?
                std::pow(10.0, m_rx3Level.get() / 20.0) : 1.0;
        const double duration = target < m_rx3Gain ? 0.1 : 0.5;
        const double step = std::max(0, numFrames) / (rate * duration);
        m_rx3Gain += std::clamp(target - m_rx3Gain, -step, step);
        return static_cast<CSAMPLE>(m_rx3Gain);
    }
    m_rx3Gain = 1;
    // Apply microphone ducking.
    switch (getMode()) {
    case EngineTalkoverDucking::OFF:
        return 1.0f;
    case EngineTalkoverDucking::AUTO:
    case EngineTalkoverDucking::MANUAL:
        return static_cast<CSAMPLE>(calculateCompressedGain(numFrames));
    default:
        DEBUG_ASSERT("!Unknown Ducking mode");
        return 1.0f;
    }
}

void EngineTalkoverDucking::setAboveThreshold(bool above) {
    m_rx3AboveThreshold = above;
    EngineSideChainCompressor::setAboveThreshold(above);
}

void EngineTalkoverDucking::processKey(const CSAMPLE* input, int sampleCount) {
    if (!m_rx3Enabled.toBool()) {
        EngineSideChainCompressor::processKey(input, sampleCount);
        return;
    }
    // -10 dBFS, either channel and either polarity. An antiphase stereo
    // microphone must not disappear when averaged for the detector.
    constexpr double threshold = 0.31622776601683794;
    bool above = false;
    for (int sample = 0; input && sample < sampleCount; ++sample) {
        if (std::abs(input[sample]) >= threshold) { above = true; break; }
    }
    setAboveThreshold(above);
}
