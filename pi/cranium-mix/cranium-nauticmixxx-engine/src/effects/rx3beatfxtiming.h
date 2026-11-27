#pragma once

#include <algorithm>
#include <cmath>

#include "effects/backends/effectmanifest.h"

namespace rx3 {
// X-PAD cells specify exact periods. Keep the legacy knob quantization available
// when this switch is off; the same functions drive DSP and RX3 readouts.
inline void addExactBeatTiming(const EffectManifestPointer& manifest) {
    auto parameter = manifest->addParameter();
    parameter->setId("rx3_exact_time");
    parameter->setName(QObject::tr("Exact X-PAD timing"));
    parameter->setShortName(QObject::tr("Exact"));
    parameter->setValueScaler(EffectManifestParameter::ValueScaler::Toggle);
    parameter->setRange(0, 0, 1);
}
inline double echoPeriod(double value, bool beats, bool quantize, bool triplet, bool exact) {
    if (exact) return std::max(1.0 / 16, value);
    if (beats && quantize) {
        value = std::max(1.0 / 8, std::round(value * 4) / 4);
        if (triplet) value /= 3;
        return value;
    }
    return std::max(1.0 / 8, value);
}
inline double phaserPeriod(double value, bool beats, bool triplet, bool exact) {
    if (exact) return std::max(1.0 / 16, value);
    value = std::max(1.0 / 4, beats ? std::round(value * 2) / 2 : value);
    return beats && triplet ? value / 3 : value;
}
inline double tremoloRate(double value, bool beats, bool quantize, bool triplet, bool exact) {
    if (beats && quantize && !exact) {
        value = std::pow(2.0, static_cast<int>(std::log2(value)));
        if (triplet) value *= 3;
    }
    return value;
}
}
