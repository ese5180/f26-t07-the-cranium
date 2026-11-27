#pragma once

#include <QMap>
#include <QStringList>
#include <cmath>

#include "library/rekordbox/rekordboxruntimecatalog.h"

namespace rx3 {
// Browse the exported positions directly; inspecting a row must not decode,
// analyze or load the track into a player just to discover its saved cues.
inline QString exportedHotCueSummary(const QList<mixxx::rekordbox::RuntimeCue>& cues) {
    QMap<int, QString> cueSlots;
    for (const auto& cue : cues) {
        using Kind = mixxx::rekordbox::RuntimeCue::Kind;
        if ((cue.kind != Kind::HotCue && cue.kind != Kind::HotLoop) ||
                cue.hotcueIndex < 1 || cue.hotcueIndex > 8 || !cue.startMs ||
                !std::isfinite(*cue.startMs) || *cue.startMs < 0) continue;
        const auto seconds = qint64(*cue.startMs / 1000.0);
        cueSlots.insert(cue.hotcueIndex, QString("%1 %2:%3%4")
                .arg(QChar('A' + cue.hotcueIndex - 1)).arg(seconds / 60)
                .arg(seconds % 60, 2, 10, QChar('0'))
                .arg(cue.kind == Kind::HotLoop ? QStringLiteral(" ↻") : QString()));
    }
    return cueSlots.isEmpty() ? QStringLiteral("HOT CUES   None in export")
                          : QStringLiteral("HOT CUES   ") + cueSlots.values().join(QStringLiteral("    "));
}
} // namespace rx3
