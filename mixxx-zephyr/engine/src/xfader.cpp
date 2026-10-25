// Ported from Mixxx's src/engine/enginexfader.cpp; tests/test_xfader.cpp
// checks it against the original file.
#include "mz/xfader.h"

#include <cmath>

namespace mz {

double Xfader::getPowerCalibration(double transform) {
    // The transform root of -3 dB (0.5).
    return std::pow(0.5, 1.0 / transform);
}

void Xfader::getXfadeGains(double xfadePosition,
        double transform,
        double powerCalibration,
        XfaderCurve curve,
        bool reverse,
        CSAMPLE* gain1,
        CSAMPLE* gain2) {
    if (gain1 == nullptr || gain2 == nullptr) {
        return;
    }

    // Slow fade, fast cut.
    double xfadePositionLeft = xfadePosition;
    double xfadePositionRight = xfadePosition;

    if (curve == XfaderCurve::ConstantPower) {
        xfadePosition *= powerCalibration;
        xfadePositionLeft = xfadePosition - powerCalibration;
        xfadePositionRight = xfadePosition + powerCalibration;
    }

    if (xfadePositionLeft < 0) {
        xfadePositionLeft *= -1;
        *gain2 = static_cast<CSAMPLE>(1.0 - (1.0 * std::pow(xfadePositionLeft, transform)));
    } else {
        *gain2 = 1.0f;
    }

    if (xfadePositionRight > 0) {
        *gain1 = static_cast<CSAMPLE>(1.0 - (1.0 * std::pow(xfadePositionRight, transform)));
    } else {
        *gain1 = 1.0f;
    }

    // Prevent phase reversal.
    if (*gain1 < 0.0f) {
        *gain1 = 0.0f;
    }
    if (*gain2 < 0.0f) {
        *gain2 = 0.0f;
    }

    if (curve == XfaderCurve::ConstantPower) {
        if (*gain1 > *gain2) {
            *gain2 = 1 - *gain1;
        } else {
            *gain1 = 1 - *gain2;
        }
        // Normalise as if the signals were uncorrelated: gain1^2 + gain2^2 == 1.
        const auto gain = static_cast<CSAMPLE>(std::sqrt(*gain1 * *gain1 + *gain2 * *gain2));
        *gain1 = *gain1 / gain;
        *gain2 = *gain2 / gain;
    }

    if (reverse) {
        const CSAMPLE gainTemp = *gain1;
        *gain1 = *gain2;
        *gain2 = gainTemp;
    }
}

} // namespace mz
