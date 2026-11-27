#pragma once

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QStringList>

#include <optional>
#include <mutex>

#include "util/color/rgbcolor.h"
#include "library/rekordbox/rekordboxdatabase.h"

namespace mixxx::rekordbox {

// Pure value data: no I/O, SQL, Track, deck or analyzer dependencies.
// Catalog lookup results are owning copies, never pointers into containers.
// See docs/rekordbox-runtimecatalog-phase1.md for the lifetime contract.

enum class RuntimeAnalysisState {
    Unknown,       // Not inspected yet.
    Missing,       // Inspected, no analysis available.
    Ready,         // Bounded analysis and owner association confirmed.
    Imported = Ready, // Compatibility name used by Phase 1 snapshots.
    Partial,       // Some sections were readable, others were not.
    Invalid,       // Analysis path or bytes were rejected by validation.
};

enum class RuntimeWaveformQuality {
    None,
    Preview,       // Legacy PWAV-style monochrome or small preview payload.
    Detailed,      // Detailed waveform; quality does not imply encoding.
};

struct RuntimeWaveform {
    RuntimeWaveformQuality quality{RuntimeWaveformQuality::None};
    // Original ANLZ section body. Interpreting it requires tag/format metadata;
    // this layer neither decodes nor synthesizes samples.
    enum class SampleFormat { Unknown, PackedMono, PackedColor, ThreeBand };
    enum class ByteOrder { Unspecified, LittleEndian, BigEndian };
    QByteArray sectionTag; // FourCC e.g. PWAV, PWV4, PWV7.
    SampleFormat sampleFormat{SampleFormat::Unknown};
    ByteOrder byteOrder{ByteOrder::Unspecified};
    std::optional<quint32> bytesPerEntry;
    std::optional<double> entriesPerSecond;
    std::optional<double> durationMs;
    // Inline reader compatibility: body after the common 12-byte header.
    // Session descriptors leave bytes empty. No field access performs I/O.
    QByteArray bytes;
    bool payloadDeferred{false};
    QString sourceAnalysisPath; // Canonical source, confined again on explicit load.
    quint64 sectionOffset{0}; // Absolute file offset of the common header.
    quint32 headerLength{0}; // Includes the common 12 bytes.
    quint32 payloadLength{0};
    QByteArray headerBytes; // Complete validated header; never sample data.
    QByteArray sourceFingerprint; // SHA-256 of the entire bounded source.
    qint64 sourceSize{0};
    qint64 sourceModifiedMs{0};
    QString sessionId; // One connection/load attempt, not an I/O capability.
    quint32 ownerTrackId{0};
    quint32 payloadOffset{0}; // Offset within bytes; header bytes are not samples.
    bool samplesDecoded{false}; // Packed export bytes, not renderer samples.
    int entryCount{0};
    QStringList diagnostics;
};

struct RuntimeCue {
    enum class Kind {
        HotCue,
        HotLoop,
        MemoryCue,
        MemoryLoop,
    };
    Kind kind{Kind::MemoryCue};
    // 1-based hot cue slot; unused (-1) for memory cues and memory loops.
    int hotcueIndex{-1};
    bool activeLoop{false};
    QString label;
    mixxx::RgbColor::optional_t color{mixxx::RgbColor::nullopt()};
    // Milliseconds relative to the start of the audio payload, without
    // decoder-specific offsets. Timing offset resolution happens later.
    std::optional<double> startMs; // Zero is a valid position, not missing.
    std::optional<double> endMs; // Loops only.
    std::optional<double> loopLengthMs() const {
        if ((kind != Kind::HotLoop && kind != Kind::MemoryLoop) ||
                !startMs || !endMs || *endMs <= *startMs) {
            return std::nullopt;
        }
        return *endMs - *startMs;
    }
    QStringList diagnostics;
};

// Original beat positions/phase, not a constant-tempo approximation.
struct RuntimeBeat {
    quint32 timeMs{0};
    quint16 beatInBar{0};
    quint16 tempoCentiBpm{0};
};

struct RuntimeAnlzSection {
    QByteArray tag;
    quint32 headerLength{0};
    QByteArray bytes; // Full section, including common header; uninterpreted.
};

struct RuntimeTrack {
    quint32 rekordboxId{0};
    QString title;
    QString artist;
    QString album;
    QString genre;
    QString comment;
    QString key;
    QString composer;
    QString isrc;
    std::optional<double> bpm; // BPM, not integer centi-BPM.
    std::optional<quint32> durationSeconds; // PDB precision, not decoder duration.
    // Export-declared paths, relative to the volume root.
    QString audioRelativePath;
    QString anlzRelativePath;
    // Paths resolved inside the session root at load time. Empty when the
    // export cannot be resolved within the volume.
    QString resolvedAudioPath;
    QString resolvedAnlzPath;
    QHash<QString, QByteArray> analysisFingerprints;
    QString artworkRelativePath;
    QString resolvedArtworkPath;
    std::optional<quint32> artworkId;
    std::optional<quint32> rating; // 0..5; zero and absent are distinct.
    std::optional<quint32> colorId;
    QList<RuntimeBeat> beats;
    QList<RuntimeCue> cues;
    QList<RuntimeWaveform> waveforms; // Preview and detail can coexist.
    QList<RuntimeAnlzSection> unmappedAnalysisSections;
    RuntimeAnalysisState analysisState{RuntimeAnalysisState::Unknown};
    // Original bounded metadata preserved verbatim from the export.
    QJsonObject rawMetadata;
    QStringList diagnostics;
};

struct RuntimePlaylistNode {
    quint32 rekordboxId{0};
    QString name;
    bool isFolder{false};
    quint32 sortOrder{0};
    QList<RuntimePlaylistNode> children;
    QList<quint32> trackIds; // Playlist entries in declared order.
};

// Mutable build phase, optional seal(), terminal invalidate(). The future USB
// session owns this object. Each public operation is serialized; returned value
// snapshots remain readable after invalidation/destruction but authorize no I/O.
class RuntimeCatalog {
  public:
    RuntimeCatalog() = default;
    RuntimeCatalog(const RuntimeCatalog&) = delete;
    RuntimeCatalog& operator=(const RuntimeCatalog&) = delete;

    bool insertTrack(RuntimeTrack track);
    // Published rating update, called only after a successful USB commit.
    bool appendPlaylist(RuntimePlaylistNode playlist);
    bool appendHistory(DatabaseHistory history);
    bool updatePerformance(const RuntimeTrack& track);
    bool updateRating(quint32 id,int rating);
    // Atomic subtree insertion. Tracks must exist before playlists reference
    // them; duplicate entries in a playlist are allowed and order is preserved.
    bool insertPlaylist(RuntimePlaylistNode playlist);
    bool setBrowseMenu(BrowseMenu menu);
    bool setHistories(QList<DatabaseHistory> histories);
    bool seal();
    void invalidate();
    bool valid() const;
    bool sealed() const;

    QHash<quint32, RuntimeTrack> tracks() const;
    QList<RuntimePlaylistNode> playlists() const;
    BrowseMenu browseMenu() const;
    QList<DatabaseHistory> histories() const;
    QStringList diagnostics() const;
    void appendDiagnostic(const QString& message);
    std::optional<RuntimeTrack> findTrack(quint32 rekordboxId) const;
    // Exact exported-path lookup; no normalization, probing, or authorization.
    std::optional<RuntimeTrack> findTrackByAudioPath(const QString& path) const;
    std::optional<RuntimePlaylistNode> findPlaylist(quint32 rekordboxId) const;

  private:
    mutable std::mutex m_mutex;
    bool m_valid{true};
    bool m_sealed{false};
    QHash<quint32, RuntimeTrack> m_tracks;
    QHash<QString, quint32> m_audioPaths;
    QList<RuntimePlaylistNode> m_playlists;
    BrowseMenu m_browseMenu;
    QList<DatabaseHistory> m_histories;
    QHash<quint32, RuntimePlaylistNode> m_playlistIndex;
    QStringList m_diagnostics;
};

} // namespace mixxx::rekordbox
