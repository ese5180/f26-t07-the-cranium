#include "library/rekordbox/rekordboxanlzreader.h"

#include <QBuffer>
#include <QCryptographicHash>
#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <QTextCodec>
#include <QtEndian>
#include <stdexcept>

#include "rekordbox_anlz.h"

namespace mixxx::rekordbox {
namespace {
constexpr qint64 kMaxBytes = 64LL * 1024 * 1024;
quint32 u32(const QByteArray& bytes, qsizetype offset) {
    if (offset < 0 || offset > bytes.size() - 4) {
        throw std::runtime_error("Truncated ANLZ integer");
    }
    return qFromBigEndian<quint32>(bytes.constData() + offset);
}
quint16 u16(const QByteArray& bytes, qsizetype offset) {
    if (offset < 0 || offset > bytes.size() - 2) {
        throw std::runtime_error("Truncated ANLZ integer");
    }
    return qFromBigEndian<quint16>(bytes.constData() + offset);
}
void require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

constexpr quint16 kMaxCueEntries = 4096;

struct RekordboxCueEntry {
    quint32 listType{0};
    quint32 hotCueNumber{0};
    quint8 pointType{0};
    quint32 status{0};
    quint32 timeMs{0};
    quint32 loopEndMs{0};
    QString label;
    mixxx::RgbColor::optional_t color{mixxx::RgbColor::nullopt()};
};

QString decodeCueComment(
        const QByteArray& section, qsizetype offset, quint32 length) {
    if (length == 0) {
        return {};
    }
    require(length >= 2 && length % 2 == 0 &&
                    quint64(offset) + length <= quint64(section.size()),
            "Invalid PCO2 UTF-16 comment length");
    require(section.mid(offset, length).endsWith(QByteArray(2, '\0')),
            "PCO2 comment is not NUL terminated");
    QTextCodec::ConverterState state;
    const auto text = QTextCodec::codecForName("UTF-16BE")->toUnicode(
            section.constData() + offset, length - 2, &state);
    require(state.invalidChars == 0 && state.remainingChars == 0 &&
                    !text.contains(QChar::Null),
            "Invalid PCO2 UTF-16 comment");
    return text;
}

RuntimeCue makeRuntimeCue(const RekordboxCueEntry& entry) {
    const bool hot = entry.listType == 1;
    require(entry.listType <= 1, "Unknown cue list type");
    // Modern Rekordbox exports may mirror slots D-H into PCOB as well as
    // PCO2. This is present on the real NAUTIC_01 export, so PCOB must not be
    // restricted to the three slots supported by older players.
    require(hot ? entry.hotCueNumber >= 1 && entry.hotCueNumber <= 8u
                : entry.hotCueNumber == 0,
            "Cue slot disagrees with cue list type");
    require(entry.pointType == 1 || entry.pointType == 2,
            "Unknown cue point type");
    const bool loop = entry.pointType == 2;
    require(!loop || entry.loopEndMs > entry.timeMs,
            "Cue loop end does not follow its start");

    RuntimeCue cue;
    cue.kind = hot ? (loop ? RuntimeCue::Kind::HotLoop
                           : RuntimeCue::Kind::HotCue)
                   : (loop ? RuntimeCue::Kind::MemoryLoop
                           : RuntimeCue::Kind::MemoryCue);
    cue.hotcueIndex = hot ? static_cast<int>(entry.hotCueNumber) : -1;
    cue.activeLoop = loop && !hot && entry.status == 4;
    cue.label = entry.label;
    cue.color = entry.color;
    cue.startMs = static_cast<double>(entry.timeMs);
    if (loop) {
        cue.endMs = static_cast<double>(entry.loopEndMs);
    }
    return cue;
}

QList<RuntimeCue> decodeCueList(const QByteArray& section,
        bool extended,
        quint32 listType,
        quint16 count) {
    require(count <= kMaxCueEntries, "Cue count exceeds bounded limit");
    QList<RuntimeCue> cues;
    cues.reserve(count);
    qsizetype offset = extended ? 20 : 24;
    if (!extended) {
        require(quint64(offset) + quint64(count) * 56 ==
                        quint64(section.size()),
                "PCOB count disagrees with section length");
    }
    for (quint16 i = 0; i < count; ++i) {
        const qsizetype remaining = section.size() - offset;
        require(remaining >= (extended ? 40 : 56),
                "Truncated cue entry");
        require(section.mid(offset, 4) == (extended ? "PCP2" : "PCPT"),
                "Invalid cue entry tag");
        const auto entryHeader = u32(section, offset + 4);
        const auto entryLength = u32(section, offset + 8);
        require(entryHeader == (extended ? 16u : 28u),
                "Unexpected cue entry header length");
        require(entryLength >= (extended ? 40u : 56u) &&
                        entryLength <= quint64(remaining),
                "Cue entry exceeds section bounds");
        if (!extended) {
            require(entryLength == 56, "Unexpected PCOB entry length");
        }

        RekordboxCueEntry entry;
        entry.listType = listType;
        entry.hotCueNumber = u32(section, offset + 12);
        if (extended) {
            entry.pointType = static_cast<quint8>(section.at(offset + 16));
            entry.timeMs = u32(section, offset + 20);
            entry.loopEndMs = u32(section, offset + 24);
            quint32 commentLength = 0;
            if (entryLength >= 44) {
                commentLength = u32(section, offset + 40);
                require(quint64(44) + commentLength <= entryLength,
                        "PCO2 comment exceeds cue entry");
                entry.label = decodeCueComment(
                        section, offset + 44, commentLength);
            }
            // Early PCO2 variants may end before the optional color bytes.
            if (quint64(48) + commentLength <= entryLength) {
                const auto colorOffset = offset + 44 + commentLength;
                const auto red = static_cast<quint8>(section.at(colorOffset + 1));
                const auto green = static_cast<quint8>(section.at(colorOffset + 2));
                const auto blue = static_cast<quint8>(section.at(colorOffset + 3));
                // Rekordcrate documents 0/0/0 as "no assigned RGB color".
                if (red != 0 || green != 0 || blue != 0) {
                    entry.color = mixxx::RgbColor::optional(
                            (quint32(red) << 16) | (quint32(green) << 8) |
                            quint32(blue));
                }
            }
        } else {
            entry.status = u32(section, offset + 16);
            require(entry.status == 0 || entry.status == 1 ||
                            entry.status == 4,
                    "Unknown PCOB cue status");
            entry.pointType = static_cast<quint8>(section.at(offset + 28));
            entry.timeMs = u32(section, offset + 32);
            entry.loopEndMs = u32(section, offset + 36);
        }
        cues.append(makeRuntimeCue(entry));
        offset += entryLength;
    }
    require(offset == section.size(), "Cue list has unexplained trailing bytes");
    return cues;
}

QString decodePath(const QByteArray& section) {
    const auto length = u32(section, 12);
    require(length >= 2 && length % 2 == 0 && length == section.size() - 16,
            "Invalid PPTH UTF-16 length");
    require(section.endsWith(QByteArray(2, '\0')), "PPTH is not NUL terminated");
    QTextCodec::ConverterState state;
    const auto text = QTextCodec::codecForName("UTF-16BE")->toUnicode(
            section.constData() + 16, length - 2, &state);
    require(state.invalidChars == 0 && state.remainingChars == 0 &&
                    !text.isEmpty() && !text.contains(QChar::Null),
            "Invalid PPTH UTF-16 text");
    return text;
}

// Validate allocation-driving fields BEFORE entering the generated decoder.
// Each section is parsed in its own bounded stream, so one bad section cannot
// consume the next section or erase earlier valid data.
void decodeSection(const QByteArray& section, quint32 header, quint32 totalLength, AnlzReadResult* result) {
    const auto tag = section.left(4);
    if (tag == "PPTH") {
        require(header == 16, "Unexpected PPTH header length");
        const auto path = decodePath(section);
        require(!result->hasPathSection, "Duplicate PPTH section");
        result->exportedAudioPath = path;
        result->hasPathSection = true;
        return;
    }
    if (tag == "PQTZ") {
        require(header == 24, "Unexpected PQTZ header length");
        const auto count = u32(section, 20);
        require(count <= 1000000 && quint64(count) * 8 == quint64(section.size() - header),
                "PQTZ count exceeds bounded payload");
        require(!result->hadBeatGrid, "Duplicate PQTZ section");
        kaitai::kstream stream(section.toStdString());
        rekordbox_anlz_t::tagged_section_t decoded(&stream);
        const auto* grid = static_cast<rekordbox_anlz_t::beat_grid_tag_t*>(decoded.body());
        QList<RuntimeBeat> beats;
        for (const auto& beat : *grid->beats()) {
            require(beat->beat_number() >= 1 && beat->beat_number() <= 4 && beat->tempo() > 0,
                    "Invalid PQTZ beat/bar or tempo");
            require(beats.isEmpty() || beat->time() > beats.last().timeMs,
                    "Non-increasing PQTZ timestamps");
            beats.append({beat->time(), beat->beat_number(), beat->tempo()});
        }
        result->beats = std::move(beats);
        result->hadBeatGrid = true;
        return;
    }
    if (tag == "PCOB" || tag == "PCO2") {
        const bool extended = tag == "PCO2";
        require(header == (extended ? 20u : 24u), "Unexpected cue list header");
        const auto type = u32(section, 12);
        require(type <= 1, "Unknown cue list type");
        const auto count = u16(section, extended ? 16 : 18);
        result->hadCueSection = true;
        const auto cues = decodeCueList(section, extended, type, count);
        if (extended) {
            result->pco2Cues.append(cues);
            if (!result->pco2Cues.isEmpty()) {
                result->cues = result->pco2Cues;
            }
        } else {
            result->pcobCues.append(cues);
            if (result->pco2Cues.isEmpty()) {
                result->cues = result->pcobCues;
            }
        }
        // PCO2 omits the active-loop flag. Recover it from its matching
        // legacy entry irrespective of the section order.
        for (auto& cue : result->cues) for (const auto& legacy : result->pcobCues) {
            if (legacy.activeLoop && legacy.kind == cue.kind &&
                    legacy.startMs == cue.startMs && legacy.endMs == cue.endMs)
                cue.activeLoop = true;
        }
        return;
    }
    const bool tiny = tag == "PWAV" || tag == "PWV2";
    const bool preview = tiny || tag == "PWV4" || tag == "PWV6";
    const bool wave = tiny || tag == "PWV3" || tag == "PWV4" || tag == "PWV5" ||
            tag == "PWV6" || tag == "PWV7";
    if (wave) {
        const quint32 expectedHeader = (tiny || tag == "PWV6") ? 20 : 24;
        require(header == expectedHeader, "Unexpected waveform header length");
        const quint32 stride = tiny ? 1 : u32(section, 12);
        const quint32 count = u32(section, tiny ? 12 : 16);
        const quint32 expectedStride = tag == "PWV4" ? 6 : tag == "PWV5" ? 2 :
                (tag == "PWV6" || tag == "PWV7") ? 3 : 1;
        require(stride == expectedStride && quint64(count) * stride == quint64(totalLength - header),
                "Waveform dimensions disagree with payload");
        RuntimeWaveform value;
        value.sectionTag = tag;
        value.quality = preview ? RuntimeWaveformQuality::Preview : RuntimeWaveformQuality::Detailed;
        value.sampleFormat = (tiny || tag == "PWV3") ? RuntimeWaveform::SampleFormat::PackedMono :
                (tag == "PWV6" || tag == "PWV7") ? RuntimeWaveform::SampleFormat::ThreeBand :
                                                               RuntimeWaveform::SampleFormat::PackedColor;
        value.byteOrder = RuntimeWaveform::ByteOrder::BigEndian;
        value.bytes = section.mid(12);
        value.headerBytes = section.left(header);
        value.headerLength = header;
        value.payloadLength = totalLength - header;
        value.payloadOffset = header - 12;
        value.bytesPerEntry = stride;
        value.entryCount = count;
        // 150 entries/s documented for scroll data; no invented preview rate.
        if (!preview) {
            value.entriesPerSecond = 150.0;
            value.durationMs = count * 1000.0 / 150.0;
        }
        result->waveforms.append(std::move(value));
        result->hadWaveformSection = true;
        return;
    }
    // PQT2 is not a complete timestamp grid. PWVC is not PWV5/color scroll.
    // Preserve unknown/unsupported sections verbatim and expose Partial.
    result->unmappedSections.append({tag, header, section});
    result->partial = true;
    result->diagnostics.append(QStringLiteral("Unmapped ANLZ section %1 retained verbatim")
                                       .arg(QString::fromLatin1(tag)));
}
// Sequential bounded reads also fingerprint skipped waveform bytes. This avoids
// retaining a whole ANLZ or allocating count*stride during descriptor discovery.
QByteArray readExact(QIODevice* device, qint64 length, QCryptographicHash* hash) {
    const auto bytes = device->read(length);
    require(bytes.size() == length, "Truncated ANLZ read");
    hash->addData(bytes);
    return bytes;
}

bool knownWaveform(const QByteArray& tag) {
    return tag == "PWAV" || tag == "PWV2" || tag == "PWV3" || tag == "PWV4" ||
            tag == "PWV5" || tag == "PWV6" || tag == "PWV7";
}

AnlzReadResult readDevice(QIODevice* device, qint64 size, AnlzWaveformReadMode mode,
        QCryptographicHash* hash) {
    AnlzReadResult result;
    try {
        require(size >= 28 && size <= kMaxBytes, "Invalid or oversized PMAI size");
        const auto common = readExact(device, 28, hash);
        require(common.left(4) == "PMAI", "Invalid PMAI header");
        const auto header = u32(common, 4);
        require(header >= 28 && header <= quint64(size) && u32(common, 8) == size,
                "Truncated or inconsistent PMAI length");
        // Even extended container headers are skipped in bounded chunks.
        qint64 remainingHeader = header - 28;
        while (remainingHeader > 0) {
            const auto count = qMin<qint64>(remainingHeader, 64 * 1024);
            readExact(device, count, hash);
            remainingHeader -= count;
        }
        result.containerValid = true;
        quint64 position = header;
        int sections = 0;
        while (position < quint64(size)) {
            require(++sections <= 4096, "ANLZ section count limit exceeded");
            require(quint64(size) - position >= 12, "Truncated ANLZ section header");
            auto section = readExact(device, 12, hash);
            const auto sectionHeader = u32(section, 4);
            const auto sectionLength = u32(section, 8);
            require(sectionHeader >= 12 && sectionHeader <= sectionLength &&
                            sectionLength <= quint64(size) - position,
                    "ANLZ section exceeds container bounds");
            // Only the validated small known headers take the descriptor path.
            const auto tag = section.left(4);
            const quint32 expectedHeader = (tag == "PWAV" || tag == "PWV2" || tag == "PWV6") ? 20 : 24;
            const bool deferred = mode == AnlzWaveformReadMode::Descriptor &&
                    knownWaveform(tag) && sectionHeader == expectedHeader;
            section += readExact(device, (deferred ? sectionHeader : sectionLength) - 12, hash);
            const auto previousWaveforms = result.waveforms.size();
            try {
                decodeSection(section, sectionHeader, sectionLength, &result);
            } catch (const std::exception& error) {
                // Preserve a structurally rejected waveform just like other
                // unmapped sections. Do not publish an invalid descriptor.
                if (deferred) {
                    section += readExact(device, sectionLength - sectionHeader, hash);
                }
                result.partial = true;
                result.unmappedSections.append({tag, sectionHeader, section});
                result.diagnostics.append(QStringLiteral("%1: %2")
                                                  .arg(QString::fromLatin1(tag), QString::fromUtf8(error.what())));
                if (tag == "PPTH") {
                    result.hasPathSection = false;
                    result.exportedAudioPath.clear();
                    result.containerValid = false;
                    return result;
                }
            }
            if (result.waveforms.size() != previousWaveforms) {
                auto& waveform = result.waveforms.last();
                waveform.sectionOffset = position;
                waveform.payloadDeferred = deferred;
                if (deferred) {
                    waveform.bytes.clear();
                    qint64 remaining = waveform.payloadLength;
                    while (remaining > 0) {
                        const auto count = qMin<qint64>(remaining, 64 * 1024);
                        readExact(device, count, hash);
                        remaining -= count;
                    }
                }
            }
            position += sectionLength;
        }
    } catch (const std::exception& error) {
        result.containerValid = false;
        result.diagnostics.append(QString::fromUtf8(error.what()));
    }
    return result;
}
} // namespace

AnlzReadResult readAnlz(const QByteArray& bytes) {
    QBuffer buffer;
    buffer.setData(bytes);
    buffer.open(QIODevice::ReadOnly);
    QCryptographicHash hash(QCryptographicHash::Sha256);
    return readDevice(&buffer, bytes.size(), AnlzWaveformReadMode::InlineBody, &hash);
}

AnlzReadResult readAnlzFile(const QString& path, AnlzWaveformReadMode mode) {
    AnlzReadResult failure;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() < 0 || file.size() > kMaxBytes) {
        failure.diagnostics.append(QStringLiteral("Cannot read ANLZ or exceeds 64 MiB limit: %1").arg(path));
        return failure;
    }
    const auto expected = file.size();
    const auto modified = QFileInfo(file).lastModified();
    const auto canonical = QFileInfo(file).canonicalFilePath();
    QCryptographicHash hash(QCryptographicHash::Sha256);
    auto result = readDevice(&file, expected, mode, &hash);
    if (file.error() != QFileDevice::NoError || file.size() != expected ||
            QFileInfo(file).lastModified() != modified ||
            QFileInfo(file).canonicalFilePath() != canonical) {
        failure.diagnostics.append(QStringLiteral("ANLZ changed or failed during read"));
        return failure;
    }
    if (result.containerValid) {
        const auto fingerprint = hash.result();
        result.sourceFingerprint = fingerprint;
        for (auto& waveform : result.waveforms) {
            waveform.sourceAnalysisPath = canonical;
            waveform.sourceFingerprint = fingerprint;
            waveform.sourceSize = expected;
            waveform.sourceModifiedMs = modified.toMSecsSinceEpoch();
        }
    }
    return result;
}
} // namespace mixxx::rekordbox
