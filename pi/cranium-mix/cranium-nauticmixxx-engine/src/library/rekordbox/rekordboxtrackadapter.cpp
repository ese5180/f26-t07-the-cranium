#include "library/rekordbox/rekordboxtrackadapter.h"

#include <QFileInfo>
#include <QFile>
#include <QtEndian>
#include <algorithm>
#include <QVector>
#include <utility>

#include "library/rekordbox/rekordboxruntimecatalog.h"
#include "library/rekordbox/rekordboxdecodertiming.h"
#include "library/rekordbox/rekordboxsessionstate.h"
#include "library/rekordbox/rekordboxwaveformimporter.h"
#include "track/beats.h"
#include "track/beatsimporter.h"
#include "track/cueinfoimporter.h"
#include "track/sourcebinding.h"
#include "track/track.h"
#include "sources/soundsource.h"
#ifdef __COREAUDIO__
#include "sources/soundsourcecoreaudio.h"
#endif

namespace mixxx::rekordbox {
namespace {

// Preserve source timestamps in RuntimeTrack; transform them only after the
// opened decoder establishes the PCM timeline and native sample rate.
class RekordboxBeatsImporter final : public mixxx::BeatsImporter {
  public:
    explicit RekordboxBeatsImporter(QList<RuntimeBeat> beats)
            : m_beats(std::move(beats)) {
    }

    bool isEmpty() const override {
        // Mixxx needs two positions to construct a BeatMap without inventing
        // either a neighbor or a constant-tempo grid.
        return m_beats.size() < 2;
    }

    void setSourceTimingOffsetMillis(double offset) override {
        m_offsetMillis = offset;
    }

    mixxx::BeatsPointer importBeatsAndApplyTimingOffset(
            const QString&,
            const QString&,
            const mixxx::audio::StreamInfo& streamInfo) override {
        if (isEmpty()) {
            m_beats.clear();
            return nullptr;
        }
        const auto& signalInfo = streamInfo.getSignalInfo();
        if (!signalInfo.getSampleRate().isValid()) {
            m_beats.clear();
            return nullptr;
        }
        // PQTZ timestamps are integer milliseconds. A constant 122.00 BPM
        // export alternates 491/492 ms intervals; treating each interval as a
        // tempo change makes both the display and SYNC chase rounding noise.
        // Use the exported precise tempo only if every position agrees with
        // that constant grid within its timestamp quantization tolerance.
        const auto tempo=m_beats.first().tempoCentiBpm;
        bool constant=tempo>0;
        const double firstMillis=m_beats.first().timeMs;
        for(int i=0;constant && i<m_beats.size();++i) {
            constant=m_beats[i].tempoCentiBpm==tempo &&
                    std::abs(m_beats[i].timeMs-firstMillis-i*6000000.0/tempo)<=1.1;
        }
        if(constant) {
            const auto anchor=mixxx::audio::FramePos(
                    signalInfo.millis2frames(firstMillis+m_offsetMillis)).toNearestFrameBoundary();
            m_beats.clear();
            return mixxx::Beats::fromConstTempo(signalInfo.getSampleRate(),anchor,
                    mixxx::Bpm(tempo/100.0),QStringLiteral("Rekordbox-PQTZ"));
        }
        QVector<mixxx::audio::FramePos> positions;
        positions.reserve(m_beats.size());
        for (const auto& beat : std::as_const(m_beats)) {
            const auto position = mixxx::audio::FramePos(
                    signalInfo.millis2frames(beat.timeMs + m_offsetMillis))
                                          .toNearestFrameBoundary();
            if (!positions.isEmpty() && position <= positions.constLast()) {
                m_beats.clear();
                return nullptr;
            }
            positions.append(position);
        }
        m_beats.clear();
        return mixxx::Beats::fromBeatPositions(
                signalInfo.getSampleRate(),
                positions,
                QStringLiteral("Rekordbox-PQTZ"));
    }

  private:
    QList<RuntimeBeat> m_beats;
    double m_offsetMillis{0};
};

class RekordboxCueInfoImporter final : public mixxx::CueInfoImporter {
  public:
    using CueInfoImporter::CueInfoImporter;
    void setSourceTimingOffsetMillis(double offset) override {
        m_offsetMillis = offset;
    }
    double guessTimingOffsetMillis(const QString&, const QString&,
            const mixxx::audio::SignalInfo&) const override {
        return m_offsetMillis;
    }
    QList<mixxx::CueInfo> importCueInfosAndApplyTimingOffset(
            const QString& path, const QString& type,
            const mixxx::audio::SignalInfo& signal) override {
        auto cues = CueInfoImporter::importCueInfosAndApplyTimingOffset(path, type, signal);
        for (auto& cue : cues) {
            if (cue.getStartPositionMillis() && *cue.getStartPositionMillis() < 0) {
                cue.setStartPositionMillis(0);
            }
            if (cue.getEndPositionMillis() && *cue.getEndPositionMillis() < 0) {
                cue.setEndPositionMillis(0);
            }
        }
        cues.erase(std::remove_if(cues.begin(), cues.end(), [](const auto& cue) {
            return (cue.getType() == mixxx::CueType::Loop || cue.getType() == mixxx::CueType::MemoryLoop || cue.getType() == mixxx::CueType::ActiveLoop) &&
                    cue.getStartPositionMillis() && cue.getEndPositionMillis() &&
                    *cue.getEndPositionMillis() <= *cue.getStartPositionMillis();
        }), cues.end());
        return cues;
    }
  private:
    double m_offsetMillis{0};
};

} // namespace

std::optional<Mp3TimingInfo> readMp3TimingInfo(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return std::nullopt;
    const auto id3 = file.read(10);
    qint64 offset = 0;
    if (id3.size() == 10 && id3.startsWith("ID3")) {
        if (quint8(id3[3]) < 2 || quint8(id3[3]) > 4) return std::nullopt;
        for (int i = 6; i < 10; ++i) {
            if (quint8(id3[i]) & 0x80) return std::nullopt;
            offset = (offset << 7) | quint8(id3[i]);
        }
        offset += 10;
        if (quint8(id3[3]) == 4 && (quint8(id3[5]) & 0x10)) offset += 10;
    }
    if (offset >= file.size() || !file.seek(offset)) return std::nullopt;
    // Bounded inspection of the first MPEG frame, not a whole-track scan.
    const auto bytes = file.read(4096);
    for (int pos = 0; pos + 4 <= bytes.size(); ++pos) {
        const auto header = qFromBigEndian<quint32>(bytes.constData() + pos);
        // MPEG-1 Layer III only. Other versions remain unmodified until
        // their decoder coordinate convention has been measured.
        if ((header & 0xfffe0000u) != 0xfffa0000u) continue;
        const int rateIndex = (header >> 10) & 3;
        const int bitrateIndex = (header >> 12) & 15;
        if (rateIndex == 3 || bitrateIndex == 0 || bitrateIndex == 15) continue;
        constexpr int rates[]{44100, 48000, 32000};
        constexpr int bitrates[]{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320};
        const int rate = rates[rateIndex];
        const int frameSize = 144000 * bitrates[bitrateIndex] / rate + ((header >> 9) & 1);
        if (pos + frameSize + 4 > bytes.size()) return std::nullopt;
        const auto next = qFromBigEndian<quint32>(bytes.constData() + pos + frameSize);
        if ((next & 0xfffe0c00u) != (header & 0xfffe0c00u)) continue;
        const int sideInfo = ((header >> 6) & 3) == 3 ? 17 : 32;
        int at = pos + 4 + sideInfo;
        if (at + 8 > pos + frameSize) return std::nullopt;
        const auto tag = bytes.mid(at, 4);
        if (tag != "Xing" && tag != "Info") return std::nullopt;
        const auto flags = qFromBigEndian<quint32>(bytes.constData() + at + 4);
        if (!(flags & 1) || (flags & ~15u)) return std::nullopt;
        at += 8;
        const auto frames = qFromBigEndian<quint32>(bytes.constData() + at);
        for (const auto field : {std::pair{1u, 4}, {2u, 4}, {4u, 100}, {8u, 4}}) {
            if (flags & field.first) at += field.second;
        }
        if (at + 36 > pos + frameSize) return std::nullopt;
        const auto encoder = bytes.mid(at, 4);
        if (encoder != "LAME" && encoder != "Lavc" && encoder != "Lavf") return std::nullopt;
        const int delay = (quint8(bytes[at + 21]) << 4) | (quint8(bytes[at + 22]) >> 4);
        const int padding = ((quint8(bytes[at + 22]) & 15) << 8) | quint8(bytes[at + 23]);
        const qint64 totalFrames = qint64(frames) * 1152;
        if (delay == 0 || padding < 529 || totalFrames <= delay + padding) return std::nullopt;
        // The LAME-compatible delay excludes the decoder's 528+1 samples.
        // This is a frame count, not a fixed millisecond correction.
        return Mp3TimingInfo{rate, delay + 529, totalFrames - delay - padding};
    }
    return std::nullopt;
}

double decoderTimingOffsetMillis(const mixxx::SoundSource& source) {
    if (source.getType() != "mp3") return 0;
#ifdef __COREAUDIO__
    if (dynamic_cast<const mixxx::SoundSourceCoreAudio*>(&source)) {
        const auto timing = readMp3TimingInfo(source.getUrl().toLocalFile());
        // CoreAudio may behave differently for untagged/foreign encoders.
        // Only correct when its reported length confirms gapless trimming.
        if (timing && source.getSignalInfo().getSampleRate().value() == timing->sampleRate &&
                source.frameIndexRange().start() == 0 &&
                source.frameLength() == timing->audibleFrames) {
            return -1000.0 * timing->leadInFrames / timing->sampleRate;
        }
    }
#endif
    // libMAD retains the lead-in. Unknown providers must not inherit a
    // platform-based correction from a decoder that was not actually opened.
    return 0;
}

TrackPointer RekordboxTrackAdapter::createTemporaryTrack(
        const RuntimeTrack& runtimeTrack,
        const std::shared_ptr<const SessionState>& sessionState,
        QList<LoadedRuntimeWaveform> waveforms,
        QString* error) {
    if (error) {
        error->clear();
    }
    const auto fail = [error](const QString& message) -> TrackPointer {
        if (error) {
            *error = message;
        }
        return {};
    };
    if (!sessionState || !sessionState->isActive()) {
        return fail(QStringLiteral("Rekordbox USB session is not active"));
    }
    if (runtimeTrack.rekordboxId == 0 || runtimeTrack.resolvedAudioPath.isEmpty()) {
        return fail(QStringLiteral("Runtime track has no playable source"));
    }
    const mixxx::FileInfo fileInfo(runtimeTrack.resolvedAudioPath);
    if (!fileInfo.checkFileExists() || !QFileInfo(runtimeTrack.resolvedAudioPath).isFile()) {
        return fail(QStringLiteral("Runtime track audio file is missing"));
    }

    auto track = Track::newTemporary(
            mixxx::FileAccess(fileInfo),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),
            mixxx::SourceBinding::rekordboxUsb(
                    runtimeTrack.rekordboxId, sessionState));
    if (!track) {
        return fail(QStringLiteral("Cannot create restricted temporary track"));
    }

    const auto autoLoad=runtimeTrack.rawMetadata.value("autoload_hot_cues").toString().trimmed().toLower();
    track->setProperty("rekordboxHotcueAutoLoad",autoLoad=="on" || autoLoad=="yes" || autoLoad=="1");
    track->setTitle(runtimeTrack.title);
    track->setArtist(runtimeTrack.artist);
    track->setAlbum(runtimeTrack.album);
    track->updateGenre(runtimeTrack.genre);
    track->setComment(runtimeTrack.comment);
    track->setComposer(runtimeTrack.composer);
    if (runtimeTrack.durationSeconds && *runtimeTrack.durationSeconds > 0) {
        track->setDuration(static_cast<double>(*runtimeTrack.durationSeconds));
    }
    if (runtimeTrack.rating) {
        track->setRating(static_cast<int>(*runtimeTrack.rating));
    }
    if (!runtimeTrack.key.isEmpty()) {
        track->setKeyText(
                runtimeTrack.key,
                mixxx::track::io::key::FILE_METADATA);
    }
    if (runtimeTrack.beats.size() >= 2) {
        track->tryImportBeats(
                std::make_shared<RekordboxBeatsImporter>(runtimeTrack.beats),
                false);
    }
    QList<mixxx::CueInfo> cueInfos;
    cueInfos.reserve(runtimeTrack.cues.size());
    bool mainCueAdded = false;
    for (const auto& cue : runtimeTrack.cues) {
        if (!cue.startMs) {
            continue;
        }
        mixxx::CueType type = mixxx::CueType::Invalid;
        std::optional<int> hotCueIndex;
        switch (cue.kind) {
        case RuntimeCue::Kind::HotCue:
            type = mixxx::CueType::HotCue;
            hotCueIndex = cue.hotcueIndex - 1;
            break;
        case RuntimeCue::Kind::HotLoop:
            type = mixxx::CueType::Loop;
            hotCueIndex = cue.hotcueIndex - 1;
            break;
        case RuntimeCue::Kind::MemoryCue:
            if (!mainCueAdded) {
                cueInfos.append(mixxx::CueInfo(mixxx::CueType::MainCue, cue.startMs,
                        std::nullopt, std::nullopt, cue.label, cue.color));
                mainCueAdded = true;
            }
            type = mixxx::CueType::MemoryCue;
            break;
        case RuntimeCue::Kind::MemoryLoop:
            type = cue.activeLoop ? mixxx::CueType::ActiveLoop : mixxx::CueType::MemoryLoop;
            break;
        }
        if ((hotCueIndex && (*hotCueIndex < mixxx::kFirstHotCueIndex ||
                                    *hotCueIndex >= 8)) ||
                ((cue.kind == RuntimeCue::Kind::HotLoop ||
                         cue.kind == RuntimeCue::Kind::MemoryLoop) &&
                        (!cue.endMs || *cue.endMs <= *cue.startMs))) {
            continue;
        }
        cueInfos.append(mixxx::CueInfo(type,
                cue.startMs,
                cue.endMs,
                hotCueIndex,
                cue.label,
                cue.color));
    }
    if (!cueInfos.isEmpty()) {
        track->importCueInfos(
                std::make_unique<RekordboxCueInfoImporter>(std::move(cueInfos)));
    }
    if (!waveforms.isEmpty()) {
        track->tryImportWaveforms(
                std::make_unique<RekordboxWaveformImporter>(std::move(waveforms),
                        runtimeTrack.unmappedAnalysisSections, runtimeTrack.beats));
    }

    // PDB BPM is deliberately not converted into a Mixxx beat grid. With a
    // PQTZ grid, retain its exact tempo when positions confirm a constant
    // grid; preserve irregular/dynamic positions after decoder timing discovery.
    // Without PQTZ, RuntimeTrack remains authoritative.
    track->markClean();
    if (!track->isSourceAvailableForPlayback()) {
        return fail(QStringLiteral("Rekordbox USB session changed during projection"));
    }
    return track;
}

} // namespace mixxx::rekordbox
