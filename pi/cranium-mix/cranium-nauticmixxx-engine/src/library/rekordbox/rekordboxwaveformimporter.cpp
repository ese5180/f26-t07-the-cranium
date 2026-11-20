#include "library/rekordbox/rekordboxwaveformimporter.h"

#include <QtGlobal>
#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>
#include <QtEndian>

#include "analyzer/constants.h"
#include "sources/audiosourcestereoproxy.h"

namespace mixxx::rekordbox {
namespace {

quint8 scaleToByte(quint32 value, quint32 maximum) {
    if (maximum == 0) {
        return 0;
    }
    return static_cast<quint8>(qMin<quint32>(255, (value * 255 + maximum / 2) / maximum));
}

QVector<RuntimeWaveformColumn> decodeColumns(const LoadedRuntimeWaveform& source) {
    const auto& descriptor = source.descriptor;
    const auto& payload = source.payload;
    if (!descriptor.bytesPerEntry || descriptor.entryCount <= 0 ||
            *descriptor.bytesPerEntry == 0 ||
            quint64(descriptor.entryCount) * *descriptor.bytesPerEntry !=
                    quint64(payload.size())) {
        return {};
    }

    const quint32 stride = descriptor.sectionTag == "PWV4" ? 6 :
            descriptor.sectionTag == "PWV5" ? 2 :
            (descriptor.sectionTag == "PWV6" || descriptor.sectionTag == "PWV7") ? 3 : 1;
    if (*descriptor.bytesPerEntry != stride) return {};
    QVector<RuntimeWaveformColumn> result;
    result.reserve(descriptor.entryCount);
    const auto byte = [&payload](int offset) {
        return static_cast<quint8>(payload.at(offset));
    };
    const auto appendBands = [&result](quint8 low, quint8 mid, quint8 high) {
        result.push_back({low, mid, high, std::max({low, mid, high})});
    };

    if (descriptor.sectionTag == "PWV7" || descriptor.sectionTag == "PWV6") {
        for (int i = 0; i < descriptor.entryCount; ++i) {
            const int offset = i * 3;
            // Calibration tones 60 Hz / 1 kHz / 10 kHz establish L/M/H
            // for these exported PWV6/PWV7 bytes (see calibration-v2 report).
            appendBands(byte(offset), byte(offset + 1), byte(offset + 2));
        }
    } else if (descriptor.sectionTag == "PWV4") {
        // Rekordcrate's frequency-sweep fixture confirms bytes 3, 4 and 5 as
        // bottom-, middle- and top-third energy. The first three bytes are not
        // needed by Mixxx's filtered waveform representation.
        for (int i = 0; i < descriptor.entryCount; ++i) {
            const int offset = i * 6;
            appendBands(byte(offset + 3), byte(offset + 4), byte(offset + 5));
            // Extended Blue preview: relative lower-half energy, distinct
            // from the intensity flags in legacy PWAV. Calibrated on sweeps.
            const int full=byte(offset);
            result.last().whiteness=full>0 ? scaleToByte(
                    std::max(0,full-int(byte(offset+2))),full) : 0;
        }
    } else if (descriptor.sectionTag == "PWV5") {
        for (int i = 0; i < descriptor.entryCount; ++i) {
            const int offset = i * 2;
            // PWV5 is a big-endian word: RRR GGG BBB HHHHH xx.
            const quint16 packed = (quint16(byte(offset)) << 8) | byte(offset + 1);
            const quint8 red = (packed >> 13) & 7;
            const quint8 green = (packed >> 10) & 7;
            const quint8 blue = (packed >> 7) & 7;
            const quint8 height = scaleToByte((packed >> 2) & 31, 31);
            result.push_back({scaleToByte(red, 7),
                    scaleToByte(green, 7),
                    scaleToByte(blue, 7),
                    height});
        }
    } else if (descriptor.sectionTag == "PWAV" ||
            descriptor.sectionTag == "PWV3" || descriptor.sectionTag == "PWV2") {
        const bool tiny = descriptor.sectionTag == "PWV2";
        const quint8 mask = tiny ? 0x0f : 0x1f;
        const quint8 maximum = tiny ? 15 : 31;
        for (int i = 0; i < descriptor.entryCount; ++i) {
            const quint8 height = scaleToByte(byte(i) & mask, maximum);
            result.push_back({height, height, height, height, scaleToByte(byte(i) >> 5, 7)});
        }
    }
    return result;
}

WaveformPointer createWaveform(const WaveformSeries& source,
        const mixxx::audio::StreamInfo& streamInfo,
        int desiredVisualSampleRate,
        int maxVisualSamples) {
    const auto sampleRate = streamInfo.getSignalInfo().getSampleRate();
    const double durationSeconds = streamInfo.getDuration().toDoubleSeconds();
    if (source.columns.empty() || !sampleRate.isValid() || durationSeconds <= 0 ||
            desiredVisualSampleRate <= 0 ||
            durationSeconds * sampleRate.value() >=
                    static_cast<double>(std::numeric_limits<SINT>::max())) {
        return {};
    }
    const auto frameLength = static_cast<SINT>(
            std::llround(durationSeconds * sampleRate.value()));
    auto waveform = WaveformPointer(new Waveform(sampleRate.value(),
            frameLength,
            desiredVisualSampleRate,
            maxVisualSamples));
    const int dataSize = waveform->getDataSize();
    const int outputFrames = dataSize / mixxx::kAnalysisChannels;
    if (outputFrames <= 0 || !waveform->data()) {
        return {};
    }
    auto* output = waveform->data();
    for (int frame = 0; frame < outputFrames; ++frame) {
        const auto column = peakColumn(source,
                (double(frame) * durationSeconds / outputFrames - source.originSeconds) * source.columnsPerSecond,
                (double(frame + 1) * durationSeconds / outputFrames - source.originSeconds) * source.columnsPerSecond);
        for (int channel = 0; channel < mixxx::kAnalysisChannels; ++channel) {
            auto& destination = output[frame * mixxx::kAnalysisChannels + channel];
            destination.filtered.low = column.low;
            destination.filtered.mid = column.mid;
            destination.filtered.high = column.high;
            destination.filtered.all = column.all;
        }
    }
    waveform->setCompletion(dataSize);
    waveform->setSaveState(Waveform::SaveState::Saved);
    waveform->setDescription(QStringLiteral("Decoded from Rekordbox ANLZ; not analyzed by Mixxx"));
    return waveform;
}

} // namespace

QVector<RuntimeWaveformColumn> decodeRuntimeWaveformColumns(
        const LoadedRuntimeWaveform& source,
        int maxColumns) {
    auto decoded = decodeColumns(source);
    if (maxColumns <= 0 || decoded.size() <= maxColumns) {
        return decoded;
    }

    WaveformSeries series;
    series.columns = std::move(decoded);
    const bool preserveColor = source.descriptor.sectionTag == "PWV4" || source.descriptor.sectionTag == "PWV5";
    QVector<RuntimeWaveformColumn> reduced;
    reduced.reserve(maxColumns);
    for (int column = 0; column < maxColumns; ++column) {
        reduced.push_back(peakColumn(series, double(column) * series.columns.size() / maxColumns,
                double(column + 1) * series.columns.size() / maxColumns, preserveColor));
    }
    return reduced;
}

int previewWaveformPriority(const QByteArray& tag, WaveformMode mode) {
    const QList<QByteArray> tags = mode == WaveformMode::ThreeBand
            ? QList<QByteArray>{"PWV6", "PWV7", "PWV4", "PWV5", "PWAV", "PWV2", "PWV3"}
            : mode == WaveformMode::RGB
            ? QList<QByteArray>{"PWV4", "PWV5", "PWV6", "PWV7", "PWAV", "PWV2", "PWV3"}
            : QList<QByteArray>{"PWV4", "PWAV", "PWV2", "PWV3", "PWV5", "PWV6", "PWV7"};
    const int index = tags.indexOf(tag);
    return index < 0 ? 100 : index;
}

QVector<Phrase> decodeRekordboxPhrases(const QList<RuntimeAnlzSection>& sections,
        const QList<RuntimeBeat>& beats, double timingOffsetSeconds) {
    if (beats.size() < 2 || !std::isfinite(timingOffsetSeconds)) return {};
    for (int i = 1; i < beats.size(); ++i) {
        if (beats[i].timeMs <= beats[i-1].timeMs) return {};
    }
    // Layout/masking: Deep Symmetry's rekordbox_anlz.ksy song_structure_tag.
    // All lengths are checked before touching either the header or entries.
    for (const auto& section : sections) {
        if (section.tag != "PSSI") continue;
        auto bytes = section.bytes;
        if (bytes.size() < 32 || bytes.left(4) != "PSSI") continue;
        const auto u16 = [&bytes](int at) { return qFromBigEndian<quint16>(bytes.constData()+at); };
        const auto u32 = [&bytes](int at) { return qFromBigEndian<quint32>(bytes.constData()+at); };
        const int count = u16(16);
        if (u32(4) != 32 || u32(8) != quint32(bytes.size()) || u32(12) != 24 ||
                count == 0 || count > 4096 || bytes.size() != 32 + count*24) continue;
        if (u16(18) > 20) {
            constexpr quint8 mask[]{0xcb,0xe1,0xee,0xfa,0xe5,0xee,0xad,0xee,0xe9,
                    0xd2,0xe9,0xeb,0xe1,0xe9,0xf3,0xe8,0xe9,0xf4,0xe1};
            for (int i = 18; i < bytes.size(); ++i) {
                bytes[i] = char(quint8(bytes[i]) ^ quint8(mask[(i-18)%19] + count));
            }
        }
        const quint16 mood = u16(18);
        const int endBeat = u16(26);
        if (mood < 1 || mood > 3 || endBeat < 2 || endBeat > beats.size()+1) continue;
        const auto secondsAtBeat = [&](int beat) {
            if (beat <= beats.size()) return beats[beat-1].timeMs / 1000.0 + timingOffsetSeconds;
            return (2.0*beats.last().timeMs-beats[beats.size()-2].timeMs)/1000.0 + timingOffsetSeconds;
        };
        QVector<Phrase> result;
        bool valid = true;
        int previousBeat = 0;
        for (int i = 0; i < count; ++i) {
            const int at = 32+i*24;
            const int beat = u16(at+2);
            const int nextBeat = i+1<count ? u16(at+24+2) : endBeat;
            if (u16(at) != i+1 || beat <= previousBeat || nextBeat <= beat ||
                    nextBeat > endBeat || beat > beats.size()) { valid=false; break; }
            const quint16 kind = u16(at+4);
            PhraseKind category = PhraseKind::Unknown;
            if (kind == 1) category=PhraseKind::Intro;
            else if (mood == 1) {
                if (kind == 2) category=PhraseKind::Up;
                else if (kind == 3) category=PhraseKind::Down;
                else if (kind == 5) category=PhraseKind::Chorus;
                else if (kind == 6) category=PhraseKind::Outro;
            } else {
                if (kind >= 2 && kind <= 7) category=PhraseKind::Verse;
                else if (kind == 8) category=PhraseKind::Bridge;
                else if (kind == 9) category=PhraseKind::Chorus;
                else if (kind == 10) category=PhraseKind::Outro;
            }
            result.push_back({secondsAtBeat(beat),secondsAtBeat(nextBeat),category,kind,mood,
                    quint8(bytes[at+7]),quint8(bytes[at+9]),quint8(bytes[at+19])});
            previousBeat=beat;
        }
        if (valid) return result;
    }
    return {};
}

std::shared_ptr<const SignedWaveform> decodeSignedWaveform(
        const mixxx::AudioSourcePointer& source, const std::function<bool()>& cancelled) {
    if (!source || source->frameIndexRange().empty()) return {};
    constexpr int chunkFrames=16384;
    auto result=std::make_shared<SignedWaveform>();
    const double rate=source->getSignalInfo().getSampleRate();
    const auto frameRange=source->frameIndexRange();
    if (rate<=0 || frameRange.start()<0) return {};
    const double bins=std::ceil(frameRange.end()/rate*result->columnsPerSecond);
    // Bounded 2-hour display buffer, about 86 MB; longer sources retain ANLZ.
    if (bins<=0 || bins>2*3600*result->columnsPerSecond) return {};
    result->columns.resize(static_cast<int>(bins));
    mixxx::AudioSourceStereoProxy stereo(source,chunkFrames);
    mixxx::SampleBuffer buffer(chunkFrames*2);
    auto remaining=frameRange;
    while (!remaining.empty()) {
        if (cancelled && cancelled()) return {};
        const auto range=remaining.splitAndShrinkFront(std::min<SINT>(chunkFrames,remaining.length()));
        const auto read=stereo.readSampleFrames(mixxx::WritableSampleFrames(range,
                mixxx::SampleBuffer::WritableSlice(buffer)));
        if (read.frameIndexRange()!=range || read.readableLength()<range.length()*2) return {};
        const auto* samples=read.readableData();
        for (SINT i=0;i<read.frameLength();++i) {
            const int bin=static_cast<int>((range.start()+i)*result->columnsPerSecond/rate);
            if (bin>=result->columns.size()) break;
            // Stereo downmix matches the supplied L=R calibration. Antiphase
            // material may cancel; this is documented, not silently rectified.
            const float value=std::clamp((samples[2*i]+samples[2*i+1])*.5f,-1.f,1.f);
            if (result->firstAudibleSecond < 0 && std::fabs(value) >= 0.001f) {
                result->firstAudibleSecond = (range.start() + i) / rate;
            }
            auto& column=result->columns[bin];
            column.minimum=std::min(column.minimum,value);
            column.maximum=std::max(column.maximum,value);
        }
    }
    return result;
}

RekordboxWaveformImporter::RekordboxWaveformImporter(LoadedRuntimeWaveform source)
        : m_sources{std::move(source)} {
}

RekordboxWaveformImporter::RekordboxWaveformImporter(QList<LoadedRuntimeWaveform> sources,
        QList<RuntimeAnlzSection> sections, QList<RuntimeBeat> beats)
        : m_sources(std::move(sources)), m_sections(std::move(sections)), m_beats(std::move(beats)) {
}

bool RekordboxWaveformImporter::isEmpty() const {
    return m_sources.isEmpty();
}

mixxx::ImportedWaveforms RekordboxWaveformImporter::importWaveforms(
        const mixxx::audio::StreamInfo& streamInfo) {
    auto sources = std::exchange(m_sources, {});
    auto native = std::make_shared<WaveformSet>();
    native->durationSeconds = streamInfo.getDuration().toDoubleSeconds();
    if (native->durationSeconds <= 0) return {};
    native->phrases = decodeRekordboxPhrases(m_sections, m_beats, m_offsetSeconds);
    m_sections.clear();
    m_beats.clear();
    // Detail tags carry a fixed 150-column/s clock. Use that clock for the
    // source duration instead of squeezing encoder padding into decoded PCM.
    double sourceDuration = native->durationSeconds - m_offsetSeconds;
    for (const auto& source : sources) {
        const auto tag = source.descriptor.sectionTag;
        const bool detail = tag == "PWV3" || tag == "PWV5" || tag == "PWV7";
        const int mode = tag == "PWV7" || tag == "PWV6" ? 2 :
                tag == "PWV5" || tag == "PWV4" ? 1 : 0;
        auto& series = detail ? native->detail[mode] : native->overview[mode];
        if (!series.columns.isEmpty()) continue;
        series.columns = decodeColumns(source);
        series.tag = tag;
        series.originSeconds = m_offsetSeconds;
        series.columnsPerSecond = detail ? 150.0 :
                series.columns.size() / sourceDuration;
    }
    for (const auto& series : native->detail) {
        if (!series.columns.isEmpty()) {
            sourceDuration = series.columns.size() / series.columnsPerSecond;
            break;
        }
    }
    for (auto& series : native->overview) {
        series.columnsPerSecond = series.columns.size() / sourceDuration;
    }
    const WaveformSeries* primary = nullptr;
    for (int mode = 2; mode >= 0; --mode) {
        if (!native->detail[mode].columns.isEmpty()) {
            primary = &native->detail[mode];
            break;
        }
    }
    if (!primary) {
        for (int mode = 2; mode >= 0; --mode) {
            if (!native->overview[mode].columns.isEmpty()) {
                primary = &native->overview[mode];
                break;
            }
        }
    }
    if (!primary) return {};
    auto waveform = createWaveform(*primary, streamInfo, 150, -1);
    auto summary = createWaveform(*primary, streamInfo, 150, 2 * 1920);
    for (auto target : {waveform, summary}) {
        if (target) {
            target->rekordbox = native;
            target->setVersion(QStringLiteral("Rekordbox-ANLZ-%1%2")
                    .arg(QString::fromLatin1(primary->tag),
                            target == summary ? QStringLiteral("-summary") : QString()));
        }
    }
    return {waveform, summary};
}

} // namespace mixxx::rekordbox
