// Small helpers from Mixxx's src/util/math.h, without Qt.
#pragma once

#include <cmath>

namespace mz {

constexpr double kPi = 3.14159265358979323846;

inline double db2ratio(double db) {
    return std::pow(10.0, db / 20.0);
}

inline double ratio2db(double ratio) {
    return 20.0 * std::log10(ratio);
}

template<typename T>
constexpr T clampValue(T value, T low, T high) {
    return value < low ? low : (value > high ? high : value);
}

} // namespace mz
