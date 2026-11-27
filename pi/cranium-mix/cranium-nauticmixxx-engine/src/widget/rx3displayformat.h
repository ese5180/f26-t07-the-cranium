#pragma once
#include "util/fpclassify.h"
#include <QString>
#include <algorithm>
#include <cmath>

namespace rx3 {
inline QString time(double seconds, bool transport = false) {
    const auto milliseconds = util_isfinite(seconds)
            ? static_cast<qint64>(std::floor(std::clamp(seconds, 0.0, 359999.999) * 1000.0 + 0.00001)) : 0;
    const auto whole = milliseconds / 1000;
    if (transport) {
        return QStringLiteral("%1:%2:%3").arg(whole / 3600, 2, 10, QLatin1Char('0'))
                .arg((whole / 60) % 60, 2, 10, QLatin1Char('0'))
                .arg(whole % 60, 2, 10, QLatin1Char('0'));
    }
    return QStringLiteral("%1:%2.%3").arg(whole / 60, 2, 10, QLatin1Char('0'))
            .arg(whole % 60, 2, 10, QLatin1Char('0'))
            .arg(milliseconds % 1000, 3, 10, QLatin1Char('0'));
}
inline QString bars(int zeroBasedBeat) {
    if (zeroBasedBeat < 0) return QStringLiteral("—");
    return QStringLiteral("%1.%2").arg(zeroBasedBeat / 4 + 1, 2, 10, QLatin1Char('0'))
            .arg(zeroBasedBeat % 4 + 1);
}
inline QString beatMilliseconds(double bpm) {
    return util_isfinite(bpm) && bpm >= 0.001
            ? QString::number(static_cast<qint64>(std::floor(60000.0 / bpm))) : QStringLiteral("—");
}
inline QString loop(double beats) {
    if (!util_isfinite(beats) || beats <= 0) return QString();
    if (beats < 1) {
        const double inverse = 1.0 / beats;
        if (inverse <= 1024 && std::abs(inverse - std::round(inverse)) < 0.0001)
            return QStringLiteral("1/%1").arg(qRound(inverse));
    }
    return QString::number(beats, 'g', 4);
}
inline QString smallSuffix(const QString& major, const QString& suffix, int fontPixels) {
    return major + QStringLiteral("<span style=\"font-size:%1px\">%2</span>")
            .arg(std::max(1, qRound(fontPixels * 0.43))).arg(suffix);
}
}
