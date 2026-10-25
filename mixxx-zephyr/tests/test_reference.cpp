// The port against the original Mixxx sources in mixxx_reference/.
#include <cstdint>
#include <cstring>

#include "engine/enginexfader.h"
#include "mz/scratch.h"
#include "mz/xfader.h"
#include "test.h"
#include "util/alphabetafilter.h"

TEST(xfaderMatchesMixxxBitForBit) {
    const double transforms[] = {EngineXfader::kTransformMin, 0.8, 1.0, 2.0, 5.0, 50.0,
            EngineXfader::kTransformMax};
    int compared = 0;
    for (double transform : transforms) {
        const double calibration = EngineXfader::getPowerCalibration(transform);
        CHECK(calibration == mz::Xfader::getPowerCalibration(transform));
        for (int curve = 0; curve < 2; ++curve) {
            for (int reverse = 0; reverse < 2; ++reverse) {
                for (int step = -200; step <= 200; ++step) {
                    const double position = step / 200.0;
                    CSAMPLE_GAIN mixxx1 = -1, mixxx2 = -1;
                    float port1 = -1, port2 = -1;
                    EngineXfader::getXfadeGains(position, transform, calibration,
                            curve == 0 ? MIXXX_XFADER_ADDITIVE : MIXXX_XFADER_CONSTPWR,
                            reverse != 0, &mixxx1, &mixxx2);
                    mz::Xfader::getXfadeGains(position, transform, calibration,
                            curve == 0 ? mz::XfaderCurve::Additive
                                       : mz::XfaderCurve::ConstantPower,
                            reverse != 0, &port1, &port2);
                    CHECK(std::memcmp(&mixxx1, &port1, sizeof(float)) == 0);
                    CHECK(std::memcmp(&mixxx2, &port2, sizeof(float)) == 0);
                    ++compared;
                }
            }
        }
    }
    CHECK(compared == 7 * 2 * 2 * 401);
}

TEST(alphaBetaFilterMatchesMixxx) {
    AlphaBetaFilter mixxx;
    mz::AlphaBetaFilter port;
    mixxx.init(0.001, 0.25, 1.0 / 8, 1.0 / 256);
    port.init(0.001, 0.25, 1.0 / 8, 1.0 / 256);
    uint32_t seed = 12345;
    for (int i = 0; i < 5000; ++i) {
        seed = seed * 1664525u + 1013904223u;
        const double dx = ((seed >> 8) % 2001 - 1000) / 400000.0;
        mixxx.observation(dx);
        port.observation(dx);
        CHECK(mixxx.predictedVelocity() == port.predictedVelocity());
    }
}
