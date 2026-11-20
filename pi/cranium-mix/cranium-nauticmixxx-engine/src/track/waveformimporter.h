#pragma once

#include <memory>

#include "audio/streaminfo.h"
#include "waveform/waveform.h"

namespace mixxx {

struct ImportedWaveforms {
    ConstWaveformPointer waveform;
    ConstWaveformPointer summary;
};

// Converts source-provided waveform information only after the decoder has
// supplied authoritative stream properties. Implementations must not persist
// data or schedule audio analysis.
class WaveformImporter {
  public:
    virtual ~WaveformImporter() = default;

    virtual bool isEmpty() const = 0;

    virtual void setSourceTimingOffsetMillis(double) {
    }
    virtual ImportedWaveforms importWaveforms(
            const audio::StreamInfo& streamInfo) = 0;
};

using WaveformImporterPointer = std::unique_ptr<WaveformImporter>;

} // namespace mixxx
