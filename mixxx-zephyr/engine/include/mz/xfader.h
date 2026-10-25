// Crossfader gains, ported unchanged from Mixxx's src/engine/enginexfader.cpp.
#pragma once

#include "mz/config.h"

namespace mz {

enum class XfaderCurve {
    Additive = 0, // MIXXX_XFADER_ADDITIVE
    ConstantPower = 1, // MIXXX_XFADER_CONSTPWR
};

struct Xfader {
    static constexpr double kTransformDefault = 1.0;
    static constexpr double kTransformMax = 1000.0;
    static constexpr double kTransformMin = 0.6;

    static double getPowerCalibration(double transform);

    // xfadePosition is in [-1, 1]: -1 is fully left (deck 1), 1 fully right.
    static void getXfadeGains(double xfadePosition,
            double transform,
            double powerCalibration,
            XfaderCurve curve,
            bool reverse,
            CSAMPLE* gain1,
            CSAMPLE* gain2);
};

} // namespace mz
