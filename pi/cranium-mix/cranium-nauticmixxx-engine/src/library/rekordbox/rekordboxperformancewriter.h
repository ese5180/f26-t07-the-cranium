#pragma once

#include <QCryptographicHash>
#include <QFile>
#include <QLockFile>
#include <QSaveFile>
#include <QTextCodec>
#include <QtEndian>
#include <algorithm>
#include <cmath>
#include "library/rekordbox/rekordboxanlzreader.h"
#include "library/rekordbox/rekordboxdevice.h"
#include "track/track.h"

namespace mixxx::rekordbox {
namespace performance {
inline void put32(QByteArray& data, int offset, quint32 value) {
    qToBigEndian(value, reinterpret_cast<uchar*>(data.data() + offset));
}
inline void put16(QByteArray& data, int offset, quint16 value) {
    qToBigEndian(value, reinterpret_cast<uchar*>(data.data() + offset));
}
inline quint32 get32(const QByteArray& data, int offset) {
    return qFromBigEndian<quint32>(data.constData() + offset);
}
inline QByteArray cueList(const QByteArray& original, bool extended, bool hot,
        const QList<RuntimeCue>& cues) {
    const int headerSize = extended ? 20 : 24;
    QByteArray header = original.isEmpty() ? QByteArray(headerSize, '\0') : original.left(headerSize);
    header.replace(0, 4, extended ? "PCO2" : "PCOB"); put32(header, 4, headerSize); put32(header, 12, hot ? 1 : 0);
    // Existing entries preserve their undocumented bytes, including the
    // extension after color/comment. Only explicitly owned fields change.
    QList<QByteArray> entries;
    for (int offset = headerSize; offset + 12 <= original.size();) {
        const int size = int(get32(original, offset + 8));
        if (size < (extended ? 40 : 56) || size > original.size() - offset) return {};
        entries.append(original.mid(offset, size)); offset += size;
    }
    int count = 0;
    for (const auto& cue : cues) {
        const bool cueHot = cue.kind == RuntimeCue::Kind::HotCue || cue.kind == RuntimeCue::Kind::HotLoop;
        if (cueHot != hot || !cue.startMs) continue;
        const bool loop = cue.endMs.has_value();
        QByteArray entry;
        for (const auto& candidate : entries) {
            const quint32 slot = get32(candidate, 12);
            if ((hot && slot == quint32(cue.hotcueIndex)) ||
                    (!hot && slot == 0 && get32(candidate, extended ? 20 : 32) == quint32(qRound64(*cue.startMs)))) {
                entry = candidate; break;
            }
        }
        if (entry.isEmpty()) {
            entry = QByteArray(extended ? 48 : 56, '\0');
            entry.replace(0, 4, extended ? "PCP2" : "PCPT"); put32(entry, 4, extended ? 16 : 28);
            if (!extended) { put32(entry, 20, 0x10000); entry[30] = 3; entry[31] = char(0xe8); }
            else { entry[18] = 3; entry[19] = char(0xe8); }
        }
        const bool loopChanged=extended && (quint8(entry[16])!=(loop?2:1) ||
                get32(entry,20)!=quint32(qRound64(*cue.startMs)) ||
                get32(entry,24)!=(loop?quint32(qRound64(*cue.endMs)):0xffffffffu));
        if(loopChanged) {put16(entry,36,0);put16(entry,38,0);} // Clear stale quantized-loop fractions.
        put32(entry, 12, hot ? cue.hotcueIndex : 0);
        entry[extended ? 16 : 28] = loop ? 2 : 1;
        put32(entry, extended ? 20 : 32, quint32(qRound64(*cue.startMs)));
        put32(entry, extended ? 24 : 36, loop ? quint32(qRound64(*cue.endMs)) : 0xffffffffu);
        if (!extended) {
            put32(entry, 16, cue.activeLoop ? 4 : 0);
            put16(entry, 24, count ? count - 1 : 0xffff);
            put16(entry, 26, count + 1); // Last sentinel fixed below.
        } else {
            const int oldComment = entry.size() >= 44 ? int(get32(entry, 40)) : 0;
            const QByteArray tail = entry.size() >= 44 + oldComment ? entry.mid(44 + oldComment) : QByteArray(4, '\0');
            entry.resize(44);
            const auto comment = QTextCodec::codecForName("UTF-16BE")->fromUnicode(cue.label + QChar::Null);
            put32(entry, 40, comment.size()); entry.append(comment); entry.append(tail);
            if (cue.color && entry.size() >= 48 + comment.size()) {
                const auto color = mixxx::RgbColor::toQColor(*cue.color); const int offset = 44 + comment.size();
                entry[offset + 1] = char(color.red()); entry[offset + 2] = char(color.green()); entry[offset + 3] = char(color.blue());
            }
        }
        put32(entry, 8, entry.size()); header.append(entry); ++count;
    }
    if (!extended && count) put16(header, header.size() - 56 + 26, 0xffff);
    put16(header, extended ? 16 : 18, count);
    if (!extended) put32(header, 20, hot ? 0 : count);
    put32(header, 8, header.size()); return header;
}
inline QByteArray beatGrid(const QByteArray& original, const QList<RuntimeBeat>& beats) {
    QByteArray section = original.isEmpty() ? QByteArray(24, '\0') : original.left(24);
    section.replace(0, 4, "PQTZ"); put32(section, 4, 24); put32(section, 16, 0x80000); put32(section, 20, beats.size());
    for (const auto& beat : beats) {
        QByteArray entry(8, '\0'); put16(entry, 0, beat.beatInBar); put16(entry, 2, beat.tempoCentiBpm); put32(entry, 4, beat.timeMs);
        section.append(entry);
    }
    put32(section, 8, section.size()); return section;
}
inline QByteArray extendedBeatGrid(const QByteArray& original,const QList<RuntimeBeat>& previous,
        const QList<RuntimeBeat>& beats,QString* error) {
    if(original.size()<56 || get32(original,4)!=56 || get32(original,40)!=quint32(previous.size()) ||
            original.size()!=56+2*previous.size() || previous.isEmpty() || beats.isEmpty()) {
        *error="Unsupported extended beatgrid. Original analysis retained.";return {};
    }
    QByteArray result=original.left(56);
    for(int reference=24;reference<=32;reference+=8) {
        const auto time=get32(original,reference+4);
        int index=-1;for(int i=0;i<previous.size();++i) if(previous[i].timeMs==time) {index=i;break;}
        if(index<0 || index>=beats.size()) {*error="Extended beatgrid reference cannot be mapped safely.";return {};}
        const auto& beat=beats[index];put16(result,reference,beat.beatInBar);put16(result,reference+2,beat.tempoCentiBpm);put32(result,reference+4,beat.timeMs);
    }
    put32(result,40,beats.size());
    for(int i=0;i<beats.size();++i) {result.append(char(beats[i].beatInBar));result.append(i<previous.size()?original[57+2*i]:char(0));}
    put32(result,8,result.size());return result;
}
inline QByteArray rewrite(const QByteArray& original, const QString& audioPath,
        const QList<RuntimeCue>& cues, const QList<RuntimeBeat>& beats, bool addMissing, QString* error, const QList<RuntimeBeat>* previousGrid = nullptr) {
    const auto parsed = readAnlz(original);
    if (!parsed.containerValid || !parsed.hasPathSection || parsed.exportedAudioPath != audioPath) {
        *error = "Invalid or mismatched ANLZ file."; return {};
    }
    for (const auto& diagnostic : parsed.diagnostics) if (!diagnostic.startsWith("Unmapped ANLZ section ")) {
        *error = "Unsupported or malformed ANLZ section: " + diagnostic; return {};
    }
    QByteArray result = original.left(get32(original, 4));
    bool found[2][2]{{false,false},{false,false}}; bool grid = false;
    for (int offset = result.size(); offset < original.size();) {
        const int length = int(get32(original, offset + 8));
        auto section = original.mid(offset, length); const auto tag = section.left(4);
        if (tag == "PCOB" || tag == "PCO2") {
            const bool extended = tag == "PCO2", hot = get32(section, 12) == 1;
            found[extended][hot] = true; section = cueList(section, extended, hot, cues);
            if (section.isEmpty()) { *error = "Unsupported cue entry."; return {}; }
        } else if (tag == "PQTZ" && !beats.isEmpty()) { grid = true; section = beatGrid(section, beats); }
        else if(tag=="PQT2" && !beats.isEmpty()) {
            section=extendedBeatGrid(section,previousGrid?*previousGrid:parsed.beats,beats,error);
            if(!error->isEmpty()) return {};
        }
        result.append(section); offset += length;
    }
    if (addMissing) {
        for (bool extended : {false,true}) for (bool hot : {false,true})
            if (!found[extended][hot]) result.append(cueList({}, extended, hot, cues));
        if (!grid && !beats.isEmpty()) result.append(beatGrid({}, beats));
    }
    put32(result, 8, result.size());
    const auto checked = readAnlz(result);
    if (!checked.containerValid || checked.exportedAudioPath != audioPath) {
        *error = "Updated ANLZ did not pass verification."; return {};
    }
    return result;
}
inline QString atomicWrite(const QString& path, const QByteArray& bytes) {
    if(QFileInfo(path).isSymLink()) return "Refusing a symbolic link at the USB write destination.";
    QSaveFile output(path); output.setDirectWriteFallback(false);
    if (!output.open(QIODevice::WriteOnly) || output.write(bytes) != bytes.size() || !output.commit()) return output.errorString();
    return {};
}
} // namespace performance

// Snapshot before dispatching I/O: edits made after SAVE are a later revision.
struct PerformanceEdit {
    quint32 trackId = 0;
    SourceBinding binding;
    QList<RuntimeCue> cues;
    QList<RuntimeBeat> beats;
    QString error;
};
inline PerformanceEdit capturePerformance(const TrackPointer& track, const RuntimeTrack* original = nullptr) {
    PerformanceEdit edit;
    if (!track) { edit.error = "Load a USB track before saving."; return edit; }
    edit.binding = track->getSourceBinding(); edit.trackId = edit.binding.rekordboxId();
    const double rate = track->getSampleRate().value();
    if (!edit.binding.isSessionLive() || rate <= 0 || track->getCueImportStatus() != Track::ImportStatus::Complete) {
        edit.error = "USB track is unavailable or still loading."; return edit;
    }
    const double offset = track->property("rekordboxTimingOffsetMillis").toDouble();
    for (const auto& cue : track->getCuePoints()) {
        RuntimeCue value; const auto type = cue->getType(); const int slot = cue->getHotCue();
        if (slot >= 0 && slot < 8 && (type == CueType::HotCue || type == CueType::Loop)) {
            value.kind = type == CueType::Loop ? RuntimeCue::Kind::HotLoop : RuntimeCue::Kind::HotCue; value.hotcueIndex = slot + 1;
        } else if (type == CueType::MemoryCue) value.kind = RuntimeCue::Kind::MemoryCue;
        else if (type == CueType::MemoryLoop || type == CueType::ActiveLoop) {
            value.kind = RuntimeCue::Kind::MemoryLoop; value.activeLoop = type == CueType::ActiveLoop;
        } else continue;
        value.startMs = cue->getPosition().value() * 1000 / rate - offset;
        if (value.kind == RuntimeCue::Kind::HotLoop || value.kind == RuntimeCue::Kind::MemoryLoop)
            value.endMs = cue->getEndPosition().value() * 1000 / rate - offset;
        if(original) for(const auto& imported:original->cues) {
            if(imported.kind!=value.kind || imported.hotcueIndex!=value.hotcueIndex || !imported.startMs) continue;
            const double projectedStart=std::max((*imported.startMs+offset)*rate/1000,0.0);
            const bool sameStart=std::abs(projectedStart-cue->getPosition().value())<0.5;
            const bool sameEnd=!imported.endMs || (value.endMs && std::abs(std::max((*imported.endMs+offset)*rate/1000,0.0)-cue->getEndPosition().value())<0.5);
            if(sameStart && sameEnd) {value.startMs=imported.startMs;value.endMs=imported.endMs;break;}
        }
        value.label = cue->getLabel(); value.color = cue->getColor();
        if (!std::isfinite(*value.startMs) || *value.startMs < 0 || *value.startMs > 0xfffffffeu ||
                (value.endMs && (!std::isfinite(*value.endMs) || *value.endMs <= *value.startMs || *value.endMs > 0xfffffffeu))) {
            edit.error = "Cue position cannot be represented in the USB export."; return edit;
        }
        edit.cues.append(value);
    }
    if(original) for(const auto& imported:original->cues) {
        if(!imported.startMs || !imported.endMs) continue;
        const auto start=std::max((*imported.startMs+offset)*rate/1000,0.0);
        const auto end=std::max((*imported.endMs+offset)*rate/1000,0.0);
        if(end<=start) edit.cues.append(imported); // Unprojectable source data cannot be deleted from a pad.
    }
    if (const auto beats = track->getBeats()) {
        // An unchanged imported grid retains its original millisecond rounding,
        // tempo fields and boundary beats, including points outside decoded audio.
        // Import may reconstruct constant tempo from PQTZ's rounded timestamps.
        bool sameGrid=original && original->beats.size()>=2;
        auto importedBeat=beats->cfirstmarker();
        for(int index=0;sameGrid && index<original->beats.size();++index,++importedBeat) {
            const auto& sourceBeat=original->beats[index];
            const double expected=(sourceBeat.timeMs+offset)*rate/1000;
            sameGrid=std::abs(importedBeat->value()-expected)<=1.1*rate/1000;
        }
        if(sameGrid) {edit.beats=original->beats;return edit;}
        auto beat = original && original->beats.size()>=2?beats->cfirstmarker():beats->iteratorFrom(audio::FramePos(0));
        const auto end = track->getDuration() * rate;
        const int sourceCount=original?original->beats.size():0;
        for (int count = 0; (sourceCount>=2?count<sourceCount:beat->value()<end) && count < 200000; ++beat, ++count) {
            const double time = beat->value() * 1000 / rate - offset;
            if (time < 0) {edit.error="The edited beatgrid starts before the USB timeline.";return edit;}
            const auto next = beat + 1; const double duration = (*next - *beat) / rate;
            if (duration <= 0 || !std::isfinite(time) || time > 0xfffffffeu) break;
            const int bar = sourceCount>=2?original->beats[count].beatInBar:((beat - beats->cfirstmarker()) % 4 + 4) % 4 + 1;
            edit.beats.append({quint32(qRound64(time)), quint16(bar), quint16(std::clamp(qRound(6000 / duration), 1, 65535))});
        }
    }
    return edit;
}

inline QString writeUsbPerformance(const DeviceSnapshot& expected, RuntimeTrack* track,
        const PerformanceEdit& edit, const std::shared_ptr<const SessionState>& session) {
    if (!edit.error.isEmpty()) return edit.error;
    if (!session || !session->isActive() || edit.binding.sessionIdentifier() != session->identifier() || edit.trackId != track->rekordboxId)
        return "USB track belongs to a different connection.";
    if (track->analysisFingerprints.isEmpty()) return "No associated ANLZ file is available.";
    QLockFile lock(expected.databasePath + ".nauticmixxx.lock");
    if (!lock.tryLock(0)) return "Another USB update is in progress.";
    struct FileEdit { QString path, relative; QByteArray oldBytes, newBytes; };
    QList<FileEdit> files;
    qint64 total = 0;
    for (auto it = track->analysisFingerprints.cbegin(); it != track->analysisFingerprints.cend(); ++it) {
        const auto path = resolvePath(expected.root, it.key(), true); QFile input(path);
        if (path.isEmpty() || !input.open(QIODevice::ReadOnly) || input.size() > 64 * 1024 * 1024 || input.size() < 28)
            return "ANLZ file is unavailable.";
        const auto original = input.readAll(); total += original.size();
        if (total > 128 * 1024 * 1024 || QCryptographicHash::hash(original, QCryptographicHash::Sha256) != it.value())
            return "ANLZ changed. Reconnect the USB before saving.";
        QString error;
        const auto updated = performance::rewrite(original, track->audioRelativePath, edit.cues, edit.beats,
                path.endsWith(".DAT", Qt::CaseInsensitive) || path.endsWith(".EXT", Qt::CaseInsensitive), &error, &track->beats);
        if (!error.isEmpty()) return error;
        files.append({path, it.key(), original, updated});
    }
    if (!inspectDevice(expected.root).matches(expected) || !session->isActive()) return "USB changed before saving.";
    for (const auto& file : files) {
        const auto error = performance::atomicWrite(file.path + ".nauticmixxx-performance-backup", file.oldBytes);
        if (!error.isEmpty()) return "Could not save recovery copy: " + error;
    }
    int committed = 0;
    for (const auto& file : files) {
        QFile current(file.path);
        const bool valid = session->isActive() && inspectDevice(expected.root).matches(expected) &&
                resolvePath(expected.root, file.relative, true) == file.path && current.open(QIODevice::ReadOnly) &&
                QCryptographicHash::hash(current.readAll(), QCryptographicHash::Sha256) == QCryptographicHash::hash(file.oldBytes, QCryptographicHash::Sha256);
        const auto error = valid ? performance::atomicWrite(file.path, file.newBytes) : QString("USB changed during saving.");
        if (!error.isEmpty()) {
            // Roll back only while the original device identity remains valid.
            for (int i = 0; i < committed && session->isActive() && inspectDevice(expected.root).matches(expected); ++i)
                performance::atomicWrite(files[i].path, files[i].oldBytes);
            return error + " Recovery copies retained beside the ANLZ files.";
        }
        ++committed;
    }
    track->cues = edit.cues; if (!edit.beats.isEmpty()) track->beats = edit.beats;
    const QString sessionId = track->waveforms.isEmpty() ? QString() : track->waveforms.front().sessionId;
    track->waveforms.clear();
    for (const auto& file : files) {
        const auto parsed = readAnlzFile(file.path, AnlzWaveformReadMode::Descriptor);
        track->analysisFingerprints[file.relative] = parsed.sourceFingerprint;
        for (auto waveform : parsed.waveforms) {
            waveform.sessionId = sessionId;
            waveform.ownerTrackId = track->rekordboxId; track->waveforms.append(waveform);
        }
    }
    return {};
}
} // namespace mixxx::rekordbox
