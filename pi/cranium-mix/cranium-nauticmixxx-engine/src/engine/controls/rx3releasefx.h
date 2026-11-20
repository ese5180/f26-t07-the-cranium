#pragma once

#include <atomic>
#include <cmath>
#include <memory>
#include <vector>

#include "control/controlobject.h"
#include "control/controlpushbutton.h"
#include "engine/controls/loopingcontrol.h"

// Release FX have their own per-deck lifecycle. They never load/replace a
// Beat FX or QuickEffect. All envelopes and loop changes run on the audio clock.
class Rx3ReleaseFx : public QObject {
  public:
    Rx3ReleaseFx(const QString& group, LoopingControl* loops, ControlPushButton* play)
            : m_loops(loops), m_play(play),
              m_status(std::make_unique<ControlObject>(ConfigKey(group, "rx3_release_fx_active"))),
              m_cancel(std::make_unique<ControlPushButton>(ConfigKey(group, "rx3_release_fx_cancel"))) {
        connect(m_cancel.get(), &ControlObject::valueChanged, this,
                [this](double value) { if (value > 0) { m_request.store(0); m_held.store(0); } }, Qt::DirectConnection);
        for (int pad = 1; pad <= 8; ++pad) {
            for (bool latch : {false, true}) {
                auto control = std::make_unique<ControlPushButton>(ConfigKey(group,
                        QString("rx3_release_fx_%1%2").arg(pad).arg(latch ? "_latch" : "")));
                connect(control.get(), &ControlObject::valueChanged, this,
                        [this, pad, latch](double value) {
                            if (latch) {
                                if (value > 0) m_request.store(m_request.load() == -pad ? 0 : -pad);
                            } else if (value > 0) {
                                m_held.fetch_or(1 << pad); m_request.store(pad);
                            } else {
                                const int remaining = m_held.fetch_and(~(1 << pad)) & ~(1 << pad);
                                int requested = pad;
                                int next = 0;
                                for (int i = 1; i <= 8; ++i) if (remaining & (1 << i)) next = i;
                                m_request.compare_exchange_strong(requested, next);
                            }
                        }, Qt::DirectConnection);
                m_controls.push_back(std::move(control));
            }
        }
    }

    void reset() {
        m_request.store(0); m_held.store(0); m_selected = 0; m_loopOwned = false;
        m_elapsed = 0; m_stopped = false; m_gain = 1; m_status->setAndConfirm(0);
        for (const auto& control : m_controls) control->setAndConfirm(0);
    }

    void prepare(int frames, double sampleRate, double bpm) {
        const int requested = m_request.load();
        if (std::abs(requested) != m_selected) {
            restoreLoop();
            m_selected = std::abs(requested); m_elapsed = 0; m_stopped = false;
            // Pads do not start an empty/paused deck.
            if (m_selected && !m_play->toBool()) { m_request.store(0); m_selected = 0; }
            if (m_selected == 3 || m_selected == 7) {
                m_savedLoop = m_loops->getLoopInfo(); m_savedEnabled = m_loops->isLoopingEnabled();
                m_loopOwned = true; m_loopSize = m_selected == 3 ? 1 : 4;
                m_loops->slotBeatLoop(m_loopSize, false, true);
            }
            m_status->setAndConfirm(m_selected);
        }
        m_sampleStep = sampleRate > 0 ? 1.0 / sampleRate : 0;
        m_secondsPerBeat = std::isfinite(bpm) && bpm > 0 ? 60.0 / bpm : 0.5;
        m_blockStart = m_elapsed;
        if (m_selected && sampleRate > 0) m_elapsed += frames / sampleRate / m_secondsPerBeat;
        if (m_selected == 7) {
            const double size = std::max(1.0 / 16, 4.0 / std::pow(2.0, std::floor(m_elapsed / 2)));
            if (size != m_loopSize) { m_loopSize = size; m_loops->slotBeatLoop(size, true, true); }
        }
        if (rateFxActive() && m_elapsed >= durationBeats() && !m_stopped) {
            m_play->set(0); m_stopped = true;
        }
    }

    bool rateFxActive() const { return m_selected == 1 || m_selected == 2 || m_selected == 5 || m_selected == 6; }
    double applyRate(double rate) const {
        if (!rateFxActive()) return rate;
        const double envelope = std::max(0.0, 1.0 - m_elapsed / durationBeats());
        return (m_selected == 2 || m_selected == 6) ? -std::abs(rate) * 4 * envelope : rate * envelope;
    }
    void processAudio(CSAMPLE* samples, int count) {
        const int frames = count / 2;
        for (int frame = 0; frame < frames; ++frame) {
            const double age = m_blockStart + (m_elapsed - m_blockStart) * frame / std::max(1, frames);
            double target = 1;
            if (m_selected == 4) target = 0;
            else if (m_selected == 3) target = std::max(0.0, 1.0 - age / 4);
            else if (m_selected == 8) {
                const double phase = age - std::floor(age);
                target = std::pow(phase, 2) * std::max(0.0, 1.0 - age / 8);
            }
            // Five-millisecond smoothing at any output sample rate.
            const double alpha = std::min(1.0, m_sampleStep / 0.005);
            m_gain += (target - m_gain) * alpha;
            samples[2 * frame] *= m_gain; samples[2 * frame + 1] *= m_gain;
        }
    }
    int activePad() const { return m_selected; }

  private:
    double durationBeats() const { return m_selected == 5 || m_selected == 6 ? 4 : 1; }
    void restoreLoop() {
        if (!m_loopOwned) return;
        if (m_savedLoop.startPosition.isValid() && m_savedLoop.endPosition.isValid())
            m_loops->setLoop(m_savedLoop.startPosition, m_savedLoop.endPosition, m_savedEnabled);
        else m_loops->slotLoopRemove();
        m_loopOwned = false;
    }
    LoopingControl* m_loops;
    ControlPushButton* m_play;
    std::unique_ptr<ControlObject> m_status;
    std::unique_ptr<ControlPushButton> m_cancel;
    std::vector<std::unique_ptr<ControlPushButton>> m_controls;
    std::atomic<int> m_request{0}, m_held{0};
    int m_selected = 0;
    double m_elapsed = 0, m_blockStart = 0, m_secondsPerBeat = 0.5, m_loopSize = 0, m_gain = 1, m_sampleStep = 0;
    bool m_loopOwned = false, m_savedEnabled = false, m_stopped = false;
    LoopingControl::LoopInfo m_savedLoop;
};
