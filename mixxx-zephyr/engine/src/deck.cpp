#include "mz/deck.h"

#include <algorithm>
#include <cmath>

#include "mz/math.h"

namespace mz {

namespace {

// RateControl::getJogFactor
constexpr double kJogSensitivity = 0.1;
// RateControl::kPausedJogMultiplier
constexpr double kPausedJogMultiplier = 18.0;
// Mixxx filters jog once per audio buffer. Its default buffer is 1024 frames
// at 44.1 kHz; running the filter at that period keeps a nudge as long and as
// strong as in Mixxx whatever block size this build uses.
constexpr double kJogPeriodSeconds = 1024.0 / 44100.0;
// The FLX4 script's jog constants.
constexpr double kBendScale = 0.8;
constexpr double kFastSeekScale = 150;
constexpr int kIntervalsPerRev = 720;
constexpr double kRpm = 33.0 + 1.0 / 3.0;
constexpr double kAlpha = 1.0 / 8;
constexpr double kBeta = kAlpha / 32;
// Fastest the play position may move, in track frames per output frame.
constexpr double kMaxStep = 16.0;

constexpr uint32_t kFlagLoaded = 1u << 0;
constexpr uint32_t kFlagPlaying = 1u << 1;
constexpr uint32_t kFlagCue = 1u << 2;
constexpr uint32_t kFlagPfl = 1u << 3;
constexpr uint32_t kFlagLoop = 1u << 4;
constexpr int kHotcueFlagShift = 8;

} // namespace

Deck::Deck(CachingReader* reader)
        : m_reader(reader),
          m_outputRate(48000),
          m_trackRate(0),
          m_frameCount(0),
          m_position(0),
          m_play(false),
          m_cuePreview(false),
          m_hotcuePreview(-1),
          m_cuePoint(0),
          m_hotcues{},
          m_loopStart(-1),
          m_loopEnd(-1),
          m_loopEnabled(false),
          m_rateSlider(0),
          m_rateRange(kDefaultRateRange),
          m_rateDir(kDefaultRateDir),
          m_jogInput(0),
          m_jogFactor(0),
          m_jogClock(0),
          m_scratchEnabled(false),
          m_lastStep(0),
          m_pregain(1),
          m_lastPregain(1),
          m_eqLow(1),
          m_eqMid(1),
          m_eqHigh(1),
          m_filterKnob(0.5),
          m_volume(1),
          m_pfl(false),
          m_statusFlags(0),
          m_statusPosition(0),
          m_statusFrames(0),
          m_statusUnderruns(0) {
    for (double& hotcue : m_hotcues) {
        hotcue = -1;
    }
}

void Deck::setOutputRate(double sampleRate) {
    m_outputRate = sampleRate;
    m_eq.setSampleRate(sampleRate);
    m_filter.setSampleRate(sampleRate);
}

void Deck::trackLoaded(uint32_t generation, int64_t frameCount, uint32_t sampleRate) {
    m_reader->setTrack(generation, frameCount);
    m_frameCount = frameCount;
    m_trackRate = sampleRate;
    m_position = 0;
    m_play = false;
    m_cuePreview = false;
    m_hotcuePreview = -1;
    m_cuePoint = 0;
    for (double& hotcue : m_hotcues) {
        hotcue = -1;
    }
    m_loopStart = -1;
    m_loopEnd = -1;
    m_loopEnabled = false;
    m_lastStep = 0;
}

double Deck::rateRatio() const {
    // RateControl::slotRateSliderChanged
    return 1.0 + m_rateDir * m_rateRange * m_rateSlider;
}

void Deck::seek(double position) {
    m_position = clampValue(position, 0.0, static_cast<double>(m_frameCount));
    m_reader->prefetch(static_cast<int64_t>(m_position), true);
    if (!isPlaying() && !m_scratchEnabled) {
        // A stopped deck lands exactly on the target instead of gliding on
        // with the last block's speed.
        m_lastStep = 0;
    }
}

void Deck::onPlay() {
    if (m_frameCount <= 0) {
        return;
    }
    if (m_cuePreview || m_hotcuePreview >= 0) {
        // Pressing play during a preview keeps the deck playing on release.
        m_cuePreview = false;
        m_hotcuePreview = -1;
        m_play = true;
        return;
    }
    m_play = !m_play;
}

void Deck::onCue(bool pressed) {
    if (m_frameCount <= 0) {
        return;
    }
    if (!pressed) {
        if (m_cuePreview) {
            m_cuePreview = false;
            seek(m_cuePoint);
        }
        return;
    }
    // CueControl in Mixxx cue mode.
    if (m_play) {
        m_play = false;
        seek(m_cuePoint);
    } else if (std::fabs(m_position - m_cuePoint) < 1.0) {
        m_cuePreview = true;
    } else {
        m_cuePoint = std::floor(m_position);
    }
}

void Deck::onHotcue(int index, bool pressed) {
    if (m_frameCount <= 0 || index < 0 || index >= kNumHotcues) {
        return;
    }
    if (!pressed) {
        if (m_hotcuePreview == index) {
            m_hotcuePreview = -1;
            seek(m_hotcues[index]);
        }
        return;
    }
    if (m_hotcues[index] < 0) {
        m_hotcues[index] = std::floor(m_position);
    } else if (m_play) {
        seek(m_hotcues[index]);
    } else {
        // Preview from the hotcue while the pad is held.
        seek(m_hotcues[index]);
        m_hotcuePreview = index;
    }
}

void Deck::control(const ControlEvent& event) {
    const bool pressed = event.value > 0.5f;
    const auto value = static_cast<double>(event.value);
    switch (event.target) {
    case Target::Play:
        if (pressed) {
            onPlay();
        }
        break;
    case Target::CueDefault:
        onCue(pressed);
        break;
    case Target::StartStop:
        if (pressed) {
            m_play = false;
            m_cuePreview = false;
            m_hotcuePreview = -1;
            seek(0);
        }
        break;
    case Target::Pfl:
        if (pressed) {
            m_pfl = !m_pfl;
        }
        break;
    case Target::HotcueActivate:
        onHotcue(event.index, pressed);
        break;
    case Target::HotcueClear:
        if (pressed && event.index >= 0 && event.index < kNumHotcues) {
            m_hotcues[event.index] = -1;
        }
        break;
    case Target::LoopIn:
        if (pressed && m_frameCount > 0) {
            m_loopStart = std::floor(m_position);
            if (m_loopEnd <= m_loopStart) {
                m_loopEnd = -1;
                m_loopEnabled = false;
            }
        }
        break;
    case Target::LoopOut:
        if (pressed && m_loopStart >= 0 && m_position > m_loopStart) {
            m_loopEnd = std::floor(m_position);
            m_loopEnabled = true;
        }
        break;
    case Target::ReloopToggle:
        if (pressed && m_loopStart >= 0 && m_loopEnd > m_loopStart) {
            m_loopEnabled = !m_loopEnabled;
            if (m_loopEnabled && m_position > m_loopEnd) {
                seek(m_loopStart);
            }
        }
        break;
    case Target::ReloopAndStop:
        if (pressed && m_loopStart >= 0 && m_loopEnd > m_loopStart) {
            m_loopEnabled = true;
            m_play = false;
            seek(m_loopStart);
        }
        break;
    case Target::Volume:
        m_volume = value;
        break;
    case Target::Pregain:
        m_pregain = value;
        break;
    case Target::EqLow:
        m_eqLow = value;
        break;
    case Target::EqMid:
        m_eqMid = value;
        break;
    case Target::EqHigh:
        m_eqHigh = value;
        break;
    case Target::Filter:
        m_filterKnob = value;
        break;
    case Target::Rate:
        m_rateSlider = clampValue(value, -1.0, 1.0);
        break;
    case Target::CycleTempoRange:
        if (pressed) {
            int next = 0;
            for (int i = 0; i < 4; ++i) {
                if (m_rateRange == kTempoRanges[i]) {
                    next = (i + 1) % 4;
                    break;
                }
            }
            m_rateRange = kTempoRanges[next];
        }
        break;
    case Target::JogTurn:
        if (m_scratchEnabled) {
            m_scratcher.tick(static_cast<int>(event.value));
        } else {
            m_jogInput += static_cast<double>(event.value) * kBendScale;
        }
        break;
    case Target::JogSearch:
        m_jogInput += static_cast<double>(event.value) * kFastSeekScale;
        break;
    case Target::JogTouch:
        if (pressed) {
            const double velocity = m_scratchEnabled
                    ? m_scratcher.velocity()
                    : (isPlaying() ? rateRatio() : 0.0);
            m_scratcher.enable(kIntervalsPerRev, kRpm, kAlpha, kBeta, velocity);
            m_scratchEnabled = true;
        } else {
            m_scratcher.disable(isPlaying() ? rateRatio() : 0.0);
        }
        break;
    default:
        break;
    }
}

double Deck::currentSpeed(double blockSeconds) {
    // The jog filter, at Mixxx's buffer period.
    m_jogClock += blockSeconds;
    if (m_jogClock >= kJogPeriodSeconds) {
        m_jogClock -= kJogPeriodSeconds;
        m_jogFactor = m_jogFilter.filter(m_jogInput) * kJogSensitivity;
        m_jogInput = 0;
    }

    m_scratchEnabled = m_scratcher.advance(blockSeconds);

    // RateControl::calculateSpeed, without vinyl control, sync and the
    // temporary-rate buttons.
    double rate;
    if (!isPlaying()) {
        if (m_scratchEnabled) {
            rate = m_scratcher.velocity() + m_jogFactor;
        } else {
            rate = m_jogFactor * kPausedJogMultiplier;
        }
    } else if (m_scratchEnabled) {
        rate = m_scratcher.velocity() + m_jogFactor;
    } else {
        rate = std::max(rateRatio(), 0.0) + m_jogFactor;
    }
    return rate;
}

void Deck::process(CSAMPLE* out, int frames) {
    m_reader->tick();
    const double blockSeconds = frames / m_outputRate;
    const double speed = currentSpeed(blockSeconds);

    if (m_frameCount <= 0 || m_trackRate == 0) {
        std::fill(out, out + 2 * frames, 0.0f);
        m_lastStep = 0;
        return;
    }

    // Track frames per output frame, ramped from the last block's value as
    // EngineBufferScaleLinear does, to avoid steps in pitch.
    const double baseStep = static_cast<double>(m_trackRate) / m_outputRate;
    const double step = clampValue(speed * baseStep, -kMaxStep, kMaxStep);

    m_reader->prefetch(static_cast<int64_t>(m_position), step >= 0);

    if (step == 0 && m_lastStep == 0) {
        // Stopped: silence, as EngineBuffer gives when the rate is zero.
        std::fill(out, out + 2 * frames, 0.0f);
        m_lastPregain = m_pregain;
        m_eq.process(out, frames, m_eqLow, m_eqMid, m_eqHigh, false, false, false);
        m_filter.process(out, frames, m_filterKnob);
        return;
    }

    // The play position in 32.32 fixed point for the per-sample loop: a
    // float cannot address every frame of a long track, and double would be
    // emulated on a single-precision FPU. Mixxx keeps positions in double.
    constexpr double kOne = 4294967296.0; // 2^32
    auto toFixed = [](double frames) { return static_cast<int64_t>(frames * kOne); };
    int64_t position = toFixed(m_position);
    int64_t stepFixed = toFixed(m_lastStep);
    const int64_t stepIncrement = (toFixed(step) - stepFixed) / frames;
    const int64_t end = static_cast<int64_t>(m_frameCount) << 32;
    const bool looping = m_loopEnabled && m_loopEnd > m_loopStart;
    const int64_t loopStart = toFixed(m_loopStart);
    const int64_t loopEnd = toFixed(m_loopEnd);
    const int64_t loopLength = loopEnd - loopStart;
    constexpr float kScale = 1.0f / 32768.0f;
    constexpr float kFraction = 1.0f / 4294967296.0f;

    for (int i = 0; i < frames; ++i) {
        stepFixed += stepIncrement;
        const int64_t index = position >> 32;
        const float fraction = static_cast<float>(static_cast<uint32_t>(position)) * kFraction;
        int16_t l0, r0, l1, r1;
        m_reader->frame(index, &l0, &r0);
        m_reader->frame(index + 1, &l1, &r1);
        out[2 * i] = (static_cast<float>(l0) + static_cast<float>(l1 - l0) * fraction) * kScale;
        out[2 * i + 1] =
                (static_cast<float>(r0) + static_cast<float>(r1 - r0) * fraction) * kScale;

        const int64_t previous = position;
        position += stepFixed;
        if (looping) {
            // Inside the loop and moving past one of its ends. loop_out sets
            // the end at the current position, so the first step wraps.
            if (stepFixed > 0 && previous >= loopStart && position >= loopEnd) {
                position -= loopLength;
            } else if (stepFixed < 0 && previous <= loopEnd && position < loopStart) {
                position += loopLength;
            }
        }
        if (position >= end) {
            // End of track: stop, as Mixxx does without repeat.
            position = end;
            m_play = false;
            m_cuePreview = false;
            m_hotcuePreview = -1;
            std::fill(out + 2 * (i + 1), out + 2 * frames, 0.0f);
            break;
        }
        if (position < 0) {
            position = 0;
        }
    }
    m_position = static_cast<double>(position) / kOne;
    m_lastStep = step;

    // Trim (EnginePregain), ramped across the block.
    const auto targetGain = static_cast<float>(m_pregain);
    const float gainStep = (targetGain - static_cast<float>(m_lastPregain)) / static_cast<float>(frames);
    float gain = static_cast<float>(m_lastPregain);
    for (int i = 0; i < frames; ++i) {
        gain += gainStep;
        out[2 * i] *= gain;
        out[2 * i + 1] *= gain;
    }
    m_lastPregain = m_pregain;

    // The deck's EQ and quick effect, as Mixxx's equalizer and quick-effect
    // racks do before the channel fader.
    m_eq.process(out, frames, m_eqLow, m_eqMid, m_eqHigh, false, false, false);
    m_filter.process(out, frames, m_filterKnob);
}

DeckStatus Deck::status() const {
    DeckStatus status{};
    status.trackLoaded = m_frameCount > 0;
    status.playing = isPlaying();
    status.cueIndicator = status.trackLoaded && !status.playing &&
            std::fabs(m_position - m_cuePoint) < 1.0;
    status.pfl = m_pfl;
    status.loopEnabled = m_loopEnabled;
    status.hotcuesSet = 0;
    for (int i = 0; i < kNumHotcues; ++i) {
        if (m_hotcues[i] >= 0) {
            status.hotcuesSet |= static_cast<uint8_t>(1u << i);
        }
    }
    status.position = static_cast<int64_t>(m_position);
    status.frameCount = m_frameCount;
    status.underruns = m_reader->underruns();
    return status;
}

void Deck::publishStatus() {
    const DeckStatus s = status();
    uint32_t flags = 0;
    flags |= s.trackLoaded ? kFlagLoaded : 0;
    flags |= s.playing ? kFlagPlaying : 0;
    flags |= s.cueIndicator ? kFlagCue : 0;
    flags |= s.pfl ? kFlagPfl : 0;
    flags |= s.loopEnabled ? kFlagLoop : 0;
    flags |= static_cast<uint32_t>(s.hotcuesSet) << kHotcueFlagShift;
    m_statusFlags.store(flags, std::memory_order_relaxed);
    m_statusPosition.store(static_cast<int32_t>(s.position), std::memory_order_relaxed);
    m_statusFrames.store(static_cast<int32_t>(s.frameCount), std::memory_order_relaxed);
    m_statusUnderruns.store(s.underruns, std::memory_order_relaxed);
}

DeckStatus Deck::publishedStatus() const {
    const uint32_t flags = m_statusFlags.load(std::memory_order_relaxed);
    DeckStatus s{};
    s.trackLoaded = (flags & kFlagLoaded) != 0;
    s.playing = (flags & kFlagPlaying) != 0;
    s.cueIndicator = (flags & kFlagCue) != 0;
    s.pfl = (flags & kFlagPfl) != 0;
    s.loopEnabled = (flags & kFlagLoop) != 0;
    s.hotcuesSet = static_cast<uint8_t>(flags >> kHotcueFlagShift);
    s.position = m_statusPosition.load(std::memory_order_relaxed);
    s.frameCount = m_statusFrames.load(std::memory_order_relaxed);
    s.underruns = m_statusUnderruns.load(std::memory_order_relaxed);
    return s;
}

} // namespace mz
