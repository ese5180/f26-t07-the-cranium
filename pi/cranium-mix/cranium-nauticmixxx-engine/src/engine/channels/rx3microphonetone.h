#pragma once

#include <algorithm>
#include <array>
#include <cmath>

#include "util/types.h"

namespace rx3 {
// Stereo microphone processing independent of the controller and effects rack.
// RBJ shelving filters, +/-12 dB, plus an optional 80 Hz high-pass. The
// software curves are not a measured model of the RX3 analog microphone EQ.
// Coefficients and state have fixed storage; no allocation in the audio callback.
class MicrophoneTone {
  public:
    void reset() {
        *this = MicrophoneTone{};
    }

    void process(CSAMPLE* samples, int sampleCount, double sampleRate,
            double lowDb, double highDb, bool lowCut) {
        if (!samples || sampleCount <= 0 || !std::isfinite(sampleRate) || sampleRate < 8000) {
            return;
        }
        if (sampleRate != m_sampleRate) {
            reset();
            m_sampleRate = sampleRate;
            m_highPass = highPass(sampleRate, 80);
        }
        lowDb = boundedGain(lowDb);
        highDb = boundedGain(highDb);
        const double slew = 1 - std::exp(-32.0 / (0.005 * sampleRate));
        for (int frame = 0; frame < sampleCount / 2; ++frame) {
            if (m_coefficientFrame == 0) {
                m_lowDb += slew * (lowDb - m_lowDb);
                m_highDb += slew * (highDb - m_highDb);
                m_cutWet += slew * ((lowCut ? 1.0 : 0.0) - m_cutWet);
                if (std::abs(m_lowDb) < 1e-10) m_lowDb = 0;
                if (std::abs(m_highDb) < 1e-10) m_highDb = 0;
                m_low = shelf(sampleRate, 300, m_lowDb, false);
                m_high = shelf(sampleRate, std::min(3000.0, sampleRate * 0.25), m_highDb, true);
            }
            m_coefficientFrame = (m_coefficientFrame + 1) % 32;
            for (int channel = 0; channel < 2; ++channel) {
                const int index = frame * 2 + channel;
                double value = m_low.apply(samples[index], m_lowState[channel]);
                value = m_high.apply(value, m_highState[channel]);
                const double cut = m_highPass.apply(value, m_cutState[channel]);
                samples[index] = static_cast<CSAMPLE>(value + m_cutWet * (cut - value));
            }
        }
    }

  private:
    struct State { double z1 = 0, z2 = 0; };
    struct Biquad {
        double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
        double apply(double input, State& state) const {
            const double output = b0 * input + state.z1;
            state.z1 = b1 * input - a1 * output + state.z2;
            state.z2 = b2 * input - a2 * output;
            // Avoid denormals after a silent input without changing audible tails.
            if (std::abs(state.z1) < 1e-30) state.z1 = 0;
            if (std::abs(state.z2) < 1e-30) state.z2 = 0;
            return output;
        }
    };
    static double boundedGain(double gain) {
        return std::isfinite(gain) ? std::clamp(gain, -12.0, 12.0) : 0;
    }
    static Biquad shelf(double rate, double frequency, double gain, bool high) {
        if (gain == 0) return {};
        constexpr double pi = 3.14159265358979323846;
        const double a = std::pow(10, gain / 40);
        const double c = std::cos(2 * pi * frequency / rate);
        const double beta = std::sin(2 * pi * frequency / rate) * std::sqrt(2 * a);
        if (high) {
            const double a0 = (a + 1) - (a - 1) * c + beta;
            return {a * ((a + 1) + (a - 1) * c + beta) / a0,
                    -2 * a * ((a - 1) + (a + 1) * c) / a0,
                    a * ((a + 1) + (a - 1) * c - beta) / a0,
                    2 * ((a - 1) - (a + 1) * c) / a0,
                    ((a + 1) - (a - 1) * c - beta) / a0};
        }
        const double a0 = (a + 1) + (a - 1) * c + beta;
        return {a * ((a + 1) - (a - 1) * c + beta) / a0,
                2 * a * ((a - 1) - (a + 1) * c) / a0,
                a * ((a + 1) - (a - 1) * c - beta) / a0,
                -2 * ((a - 1) + (a + 1) * c) / a0,
                ((a + 1) + (a - 1) * c - beta) / a0};
    }
    static Biquad highPass(double rate, double frequency) {
        constexpr double pi = 3.14159265358979323846;
        const double c = std::cos(2 * pi * frequency / rate);
        const double alpha = std::sin(2 * pi * frequency / rate) / std::sqrt(2.0);
        const double a0 = 1 + alpha;
        return {(1 + c) / (2 * a0), -(1 + c) / a0, (1 + c) / (2 * a0),
                -2 * c / a0, (1 - alpha) / a0};
    }
    double m_sampleRate = 0, m_lowDb = 0, m_highDb = 0, m_cutWet = 0;
    int m_coefficientFrame = 0;
    Biquad m_low, m_high, m_highPass;
    std::array<State, 2> m_lowState{}, m_highState{}, m_cutState{};
};
} // namespace rx3
