#pragma once

#include <QString>
#include <optional>

namespace mixxx {
class SoundSource;
namespace rekordbox {

// Frame counts belong to the encoded file's native sample rate, never the
// sound card's rate. Only validated Xing/Info + LAME-compatible tags qualify.
struct Mp3TimingInfo {
    int sampleRate;
    int leadInFrames;
    qint64 audibleFrames;
};

std::optional<Mp3TimingInfo> readMp3TimingInfo(const QString& path);

// Translate Rekordbox's untrimmed MP3 coordinates to the opened decoder's
// timeline. Unknown/untrimmed decoders and untagged files return zero.
double decoderTimingOffsetMillis(const SoundSource& source);

} // namespace rekordbox
} // namespace mixxx
