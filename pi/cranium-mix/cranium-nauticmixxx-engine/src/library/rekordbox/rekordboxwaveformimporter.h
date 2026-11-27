#pragma once

#include <QByteArray>
#include <QVector>
#include <functional>
#include "sources/audiosource.h"

#include "library/rekordbox/rekordboxruntimecatalog.h"
#include "track/waveformimporter.h"
#include "waveform/rekordboxwaveform.h"

namespace mixxx::rekordbox {

// A payload is loaded explicitly from a catalog-issued lazy descriptor only
// when a temporary Track is requested. RuntimeCatalog remains descriptor-only.
struct LoadedRuntimeWaveform {
    RuntimeWaveform descriptor;
    QByteArray payload;
};

// One normalized ANLZ waveform column. These values are suitable for drawing
// a read-only preview without opening or analysing the audio file. They are
// deliberately independent from Mixxx's persisted Waveform representation.
using RuntimeWaveformColumn = WaveformColumn;

// Decode only the waveform formats whose byte layout has been validated by
// the ANLZ reader. An empty result means that the payload or dimensions are
// invalid/unsupported. maxColumns bounds memory for browser thumbnails; each
// output column keeps the maximum energy of its source interval.
QVector<RuntimeWaveformColumn> decodeRuntimeWaveformColumns(
        const LoadedRuntimeWaveform& source, int maxColumns = -1);

int previewWaveformPriority(const QByteArray& tag, WaveformMode mode);

// PSSI is retained only from PPTH-associated analysis containers. Resolve its
// 1-based beat indices against PQTZ, never against a guessed constant BPM.
QVector<Phrase> decodeRekordboxPhrases(const QList<RuntimeAnlzSection>& sections,
        const QList<RuntimeBeat>& beats, double timingOffsetSeconds = 0);

// Read PCM extrema only. Cancel on unload/new load; discard incomplete data.
std::shared_ptr<const SignedWaveform> decodeSignedWaveform(
        const mixxx::AudioSourcePointer& source,
        const std::function<bool()>& cancelled = {});

class RekordboxWaveformImporter final : public mixxx::WaveformImporter {
  public:
    explicit RekordboxWaveformImporter(LoadedRuntimeWaveform source);
    explicit RekordboxWaveformImporter(QList<LoadedRuntimeWaveform> sources,
            QList<RuntimeAnlzSection> sections = {}, QList<RuntimeBeat> beats = {});

    bool isEmpty() const override;
    void setSourceTimingOffsetMillis(double offset) override {
        m_offsetSeconds = offset / 1000.0;
    }
    mixxx::ImportedWaveforms importWaveforms(
            const mixxx::audio::StreamInfo& streamInfo) override;

  private:
    QList<LoadedRuntimeWaveform> m_sources;
    QList<RuntimeAnlzSection> m_sections;
    QList<RuntimeBeat> m_beats;
    double m_offsetSeconds{0};
};

} // namespace mixxx::rekordbox
