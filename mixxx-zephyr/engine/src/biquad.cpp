#include "mz/biquad.h"

#include <cmath>

#include "mz/math.h"

namespace mz {

Biquad::Biquad()
        : m_b0(1), m_b1(0), m_b2(0), m_a1(0), m_a2(0), m_z1{0, 0}, m_z2{0, 0} {
}

void Biquad::design(BiquadType type, double sampleRate, double frequency, double q, double gainDb) {
    // Keep the corner below Nyquist; at Nyquist the formulas degenerate.
    frequency = clampValue(frequency, 1.0, sampleRate * 0.49);
    const double w0 = 2 * kPi * frequency / sampleRate;
    const double cosW0 = std::cos(w0);
    const double alpha = std::sin(w0) / (2 * q);
    const double a = std::pow(10.0, gainDb / 40.0);
    const double sqrtA2Alpha = 2 * std::sqrt(a) * alpha;

    double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
    case BiquadType::Peaking:
        b0 = 1 + alpha * a;
        b1 = -2 * cosW0;
        b2 = 1 - alpha * a;
        a0 = 1 + alpha / a;
        a1 = -2 * cosW0;
        a2 = 1 - alpha / a;
        break;
    case BiquadType::LowShelf:
        b0 = a * ((a + 1) - (a - 1) * cosW0 + sqrtA2Alpha);
        b1 = 2 * a * ((a - 1) - (a + 1) * cosW0);
        b2 = a * ((a + 1) - (a - 1) * cosW0 - sqrtA2Alpha);
        a0 = (a + 1) + (a - 1) * cosW0 + sqrtA2Alpha;
        a1 = -2 * ((a - 1) + (a + 1) * cosW0);
        a2 = (a + 1) + (a - 1) * cosW0 - sqrtA2Alpha;
        break;
    case BiquadType::HighShelf:
        b0 = a * ((a + 1) + (a - 1) * cosW0 + sqrtA2Alpha);
        b1 = -2 * a * ((a - 1) + (a + 1) * cosW0);
        b2 = a * ((a + 1) + (a - 1) * cosW0 - sqrtA2Alpha);
        a0 = (a + 1) - (a - 1) * cosW0 + sqrtA2Alpha;
        a1 = 2 * ((a - 1) - (a + 1) * cosW0);
        a2 = (a + 1) - (a - 1) * cosW0 - sqrtA2Alpha;
        break;
    case BiquadType::LowPass:
        b0 = (1 - cosW0) / 2;
        b1 = 1 - cosW0;
        b2 = (1 - cosW0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
        break;
    case BiquadType::HighPass:
        b0 = (1 + cosW0) / 2;
        b1 = -(1 + cosW0);
        b2 = (1 + cosW0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosW0;
        a2 = 1 - alpha;
        break;
    }
    m_b0 = static_cast<float>(b0 / a0);
    m_b1 = static_cast<float>(b1 / a0);
    m_b2 = static_cast<float>(b2 / a0);
    m_a1 = static_cast<float>(a1 / a0);
    m_a2 = static_cast<float>(a2 / a0);
}

void Biquad::reset() {
    m_z1[0] = m_z1[1] = 0;
    m_z2[0] = m_z2[1] = 0;
}

void Biquad::process(const CSAMPLE* in, CSAMPLE* out, int frames) {
    const float b0 = m_b0, b1 = m_b1, b2 = m_b2, a1 = m_a1, a2 = m_a2;
    float z1l = m_z1[0], z2l = m_z2[0], z1r = m_z1[1], z2r = m_z2[1];
    for (int i = 0; i < frames; ++i) {
        const float xl = in[2 * i];
        const float yl = b0 * xl + z1l;
        z1l = b1 * xl - a1 * yl + z2l;
        z2l = b2 * xl - a2 * yl;
        const float xr = in[2 * i + 1];
        const float yr = b0 * xr + z1r;
        z1r = b1 * xr - a1 * yr + z2r;
        z2r = b2 * xr - a2 * yr;
        out[2 * i] = yl;
        out[2 * i + 1] = yr;
    }
    // Flush tiny states so a decaying filter never reaches denormals, which
    // are slow on FPUs without flush-to-zero.
    auto flush = [](float v) { return std::fabs(v) < 1e-20f ? 0.0f : v; };
    m_z1[0] = flush(z1l);
    m_z2[0] = flush(z2l);
    m_z1[1] = flush(z1r);
    m_z2[1] = flush(z2r);
}

double Biquad::magnitudeAt(double frequency, double sampleRate) const {
    const double w = 2 * kPi * frequency / sampleRate;
    // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
    const double cos1 = std::cos(w), sin1 = std::sin(w);
    const double cos2 = std::cos(2 * w), sin2 = std::sin(2 * w);
    const auto b0 = static_cast<double>(m_b0), b1 = static_cast<double>(m_b1),
               b2 = static_cast<double>(m_b2), a1 = static_cast<double>(m_a1),
               a2 = static_cast<double>(m_a2);
    const double numRe = b0 + b1 * cos1 + b2 * cos2;
    const double numIm = -(b1 * sin1 + b2 * sin2);
    const double denRe = 1 + a1 * cos1 + a2 * cos2;
    const double denIm = -(a1 * sin1 + a2 * sin2);
    return std::sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
}

} // namespace mz
