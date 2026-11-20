#pragma once

#include "library/rekordbox/rekordboxruntimecatalog.h"

#include <QString>
#include <QStringList>

namespace mixxx::rekordbox {

// Neutral, bounded view over the existing Kaitai ANLZ parser. This is not a
// Track/Deck adapter. Decodes PPTH/PQTZ and the documented PCOB/PCO2 cue
// fields, but not waveform samples.
struct AnlzReadResult {
    QByteArray sourceFingerprint;
    bool containerValid{false};
    bool partial{false};
    bool hasPathSection{false};
    bool hadBeatGrid{false};
    bool hadCueSection{false};
    bool hadWaveformSection{false};
    QString exportedAudioPath;
    QList<RuntimeBeat> beats;
    // cues applies the per-container preference: nonempty PCO2, else PCOB.
    // The format-specific lists let the session apply the same preference
    // across associated DAT/EXT/2EX siblings without duplicating cues.
    QList<RuntimeCue> cues;
    QList<RuntimeCue> pcobCues;
    QList<RuntimeCue> pco2Cues;
    QList<RuntimeWaveform> waveforms;
    QList<RuntimeAnlzSection> unmappedSections;
    QStringList diagnostics;
};

enum class AnlzWaveformReadMode { InlineBody, Descriptor };

AnlzReadResult readAnlz(const QByteArray& bytes);
// Descriptor mode streams waveform payloads through a bounded hash buffer, never
// retaining them. Unmapped sections keep their existing bounded raw behavior.
AnlzReadResult readAnlzFile(const QString& path,
        AnlzWaveformReadMode mode = AnlzWaveformReadMode::InlineBody);

} // namespace mixxx::rekordbox
