// Tapers, biquads, the EQ and the filter.
#include <vector>

#include "mz/biquad.h"
#include "mz/control_behavior.h"
#include "mz/eq.h"
#include "mz/filter_effect.h"
#include "mz/math.h"
#include "test.h"

namespace {

std::vector<float> sine(double frequency, double rate, int frames) {
    std::vector<float> buffer(static_cast<size_t>(frames) * 2);
    for (int i = 0; i < frames; ++i) {
        const auto v = static_cast<float>(0.5 * std::sin(2 * mz::kPi * frequency * i / rate));
        buffer[2 * i] = v;
        buffer[2 * i + 1] = v;
    }
    return buffer;
}

double rmsOfTail(const std::vector<float>& buffer, int skipFrames) {
    double sum = 0;
    size_t n = 0;
    for (size_t i = static_cast<size_t>(skipFrames) * 2; i < buffer.size(); ++i) {
        sum += buffer[i] * buffer[i];
        ++n;
    }
    return std::sqrt(sum / n);
}

// Gain in dB that a processor applies to a sine, measured after it settles.
template<typename Process>
double measuredGainDb(double frequency, Process process) {
    const double rate = 48000;
    const int frames = 256;
    std::vector<float> input = sine(frequency, rate, frames * 64);
    std::vector<float> output = input;
    for (int block = 0; block < 64; ++block) {
        process(output.data() + block * frames * 2, frames);
    }
    return mz::ratio2db(rmsOfTail(output, frames * 32) / rmsOfTail(input, frames * 32));
}

} // namespace

TEST(potmeterMidiCentreIsHalf) {
    CHECK(mz::potmeterMidiToParameter(0) == 0.0);
    CHECK(mz::potmeterMidiToParameter(64) == 0.5);
    CHECK(mz::potmeterMidiToParameter(127) == 1.0);
}

TEST(volumeTaperMatchesMixxx) {
    const mz::AudioTaper volume(-20, 0, 1);
    CHECK(volume.parameterToValue(volume.midiToParameter(0)) == 0.0);
    CHECK(volume.parameterToValue(volume.midiToParameter(127)) == 1.0);
    // Half way: -10 dB with the linear overlay that reaches 0 at the bottom.
    const double offset = mz::db2ratio(-20);
    CHECK_NEAR(volume.parameterToValue(0.5), (mz::db2ratio(-10) - offset) / (1 - offset), 1e-12);
}

TEST(gainTaperHitsUnityAtMidiCentre) {
    const mz::AudioTaper pregain(-12, 12, 0.5);
    CHECK(pregain.parameterToValue(pregain.midiToParameter(64)) == 1.0);
    CHECK_NEAR(pregain.parameterToValue(pregain.midiToParameter(127)), mz::db2ratio(12), 1e-12);
    CHECK(pregain.parameterToValue(pregain.midiToParameter(0)) == 0.0);
    for (double p = 0.05; p < 1.0; p += 0.05) {
        CHECK_NEAR(pregain.valueToParameter(pregain.parameterToValue(p)), p, 1e-9);
    }
}

TEST(logTaperSpansFilterRange) {
    const mz::LogTaper corner(13, 22050, -40);
    CHECK(corner.parameterToValue(0) == 13);
    CHECK(corner.parameterToValue(1) == 22050);
    for (double p = 0.1; p < 1.0; p += 0.1) {
        CHECK_NEAR(corner.valueToParameter(corner.parameterToValue(p)), p, 1e-9);
    }
}

TEST(peakingBiquadHasItsGainAtCentre) {
    mz::Biquad bell;
    bell.design(mz::BiquadType::Peaking, 48000, 1000, 0.9, -26);
    // Coefficients are stored as float, so the centre gain is exact to 1e-3 dB.
    CHECK_NEAR(mz::ratio2db(bell.magnitudeAt(1000, 48000)), -26, 1e-3);
    CHECK_NEAR(mz::ratio2db(bell.magnitudeAt(20, 48000)), 0, 0.5);
    mz::Biquad shelf;
    shelf.design(mz::BiquadType::HighShelf, 48000, 3000, 0.4, -26);
    CHECK_NEAR(mz::ratio2db(shelf.magnitudeAt(20000, 48000)), -26, 1.0);
    CHECK_NEAR(mz::ratio2db(shelf.magnitudeAt(50, 48000)), 0, 0.5);
}

TEST(lowAndHighPassCorners) {
    mz::Biquad lp;
    lp.design(mz::BiquadType::LowPass, 48000, 1000, 0.707106781);
    CHECK_NEAR(mz::ratio2db(lp.magnitudeAt(1000, 48000)), -3.0103, 0.01);
    CHECK(mz::ratio2db(lp.magnitudeAt(10000, 48000)) < -35);
    mz::Biquad hp;
    hp.design(mz::BiquadType::HighPass, 48000, 1000, 0.707106781);
    CHECK_NEAR(mz::ratio2db(hp.magnitudeAt(1000, 48000)), -3.0103, 0.01);
    CHECK(mz::ratio2db(hp.magnitudeAt(100, 48000)) < -35);
}

TEST(neutralEqPassesAudioUnchanged) {
    mz::ThreeBandEq eq(48000);
    std::vector<float> input = sine(440, 48000, 1024);
    std::vector<float> output = input;
    eq.process(output.data(), 1024, 1, 1, 1, false, false, false);
    CHECK(output == input);
}

TEST(eqKnobsMapToMixxxGains) {
    CHECK(mz::ThreeBandEq::knobValueToGainDb(1, false) == 0);
    CHECK(mz::ThreeBandEq::knobValueToGainDb(2, false) == 12);
    CHECK(mz::ThreeBandEq::knobValueToGainDb(0, false) == -26);
    CHECK(mz::ThreeBandEq::knobValueToGainDb(1.5, true) == -26);
}

TEST(eqLowKillCutsBassNotMids) {
    mz::ThreeBandEq eq(48000);
    auto lowKilled = [&](float* buffer, int frames) {
        eq.process(buffer, frames, 0, 1, 1, false, false, false);
    };
    // The low band's bell sits at the log centre of 10 and 250 Hz (50 Hz).
    CHECK(measuredGainDb(50, lowKilled) < -20);
    mz::ThreeBandEq eq2(48000);
    auto lowKilled2 = [&](float* buffer, int frames) {
        eq2.process(buffer, frames, 0, 1, 1, false, false, false);
    };
    CHECK_NEAR(measuredGainDb(5000, lowKilled2), 0, 0.5);
}

TEST(eqHighBoostRaisesTreble) {
    mz::ThreeBandEq eq(48000);
    auto boosted = [&](float* buffer, int frames) {
        eq.process(buffer, frames, 1, 1, 2, false, false, false);
    };
    CHECK(measuredGainDb(7000, boosted) > 9);
}

TEST(filterKnobCentreIsBypass) {
    CHECK(mz::FilterEffect::lowPassCorner(0.5) == mz::FilterEffect::kMaxCorner);
    CHECK(mz::FilterEffect::highPassCorner(0.5) == mz::FilterEffect::kMinCorner);
    mz::FilterEffect filter(48000);
    std::vector<float> input = sine(440, 48000, 1024);
    std::vector<float> output = input;
    filter.process(output.data(), 1024, 0.5);
    CHECK(output == input);
}

TEST(filterKnobSweepsLowAndHighPass) {
    CHECK(mz::FilterEffect::lowPassCorner(0) == mz::FilterEffect::kMinCorner);
    CHECK(mz::FilterEffect::highPassCorner(1) == mz::FilterEffect::kMaxCorner);
    CHECK(mz::FilterEffect::lowPassCorner(0.25) < mz::FilterEffect::lowPassCorner(0.4));
    CHECK(mz::FilterEffect::highPassCorner(0.75) < mz::FilterEffect::highPassCorner(0.9));

    mz::FilterEffect lowPass(48000);
    auto darker = [&](float* buffer, int frames) { lowPass.process(buffer, frames, 0.2); };
    // Mixxx's -40 dB log taper puts knob 0.2 (parameter 0.4) at
    // 13 + 22037 * (10^(-24/20) - 0.01) / 0.99, about 1.19 kHz.
    CHECK_NEAR(mz::FilterEffect::lowPassCorner(0.2),
            13 + 22037 * (mz::db2ratio(-24) - 0.01) / 0.99, 1e-6);
    CHECK(measuredGainDb(5000, darker) < -20);

    mz::FilterEffect highPass(48000);
    auto thinner = [&](float* buffer, int frames) { highPass.process(buffer, frames, 0.8); };
    CHECK_NEAR(mz::FilterEffect::highPassCorner(0.8),
            13 + 22037 * (mz::db2ratio(-16) - 0.01) / 0.99, 1e-6);
    CHECK(measuredGainDb(100, thinner) < -20);
}
