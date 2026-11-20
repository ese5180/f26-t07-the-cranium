#include "library/rekordbox/rekordboxusbsession.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QFile>
#include <QDateTime>
#include <QUuid>
#include <QSet>
#include <algorithm>
#include <functional>

#include "library/rekordbox/rekordboxanlzreader.h"
#include "library/rekordbox/rekordboxdatabase.h"
#include "library/rekordbox/rekordboxratingwriter.h"
#include "library/rekordbox/rekordboxperformancewriter.h"
#include "library/rekordbox/rekordboxplaylistwriter.h"
#include "library/rekordbox/rekordboxtrackadapter.h"

namespace mixxx::rekordbox {
namespace {
QString resolveTrackPath(const QString& root, const QString& path, RuntimeTrack* track) {
    if (path.isEmpty()) {
        return {};
    }
    const auto resolved = resolvePath(root, path, false);
    if (resolved.isEmpty()) {
        track->diagnostics.append(QStringLiteral("Unsafe or unresolvable export path: %1").arg(path));
    } else if (!QFileInfo::exists(resolved)) {
        track->diagnostics.append(QStringLiteral("Export file is missing: %1").arg(path));
    }
    return resolved;
}

// Candidate paths come only from this owner's PDB analysis_path. Each sibling
// must independently confirm ownership with PPTH; a shared filename is no proof.
void applyAnlz(const QString& root, const QString& sessionId, RuntimeTrack* track) {
    track->analysisState = RuntimeAnalysisState::Missing;
    if (track->anlzRelativePath.isEmpty() || track->rekordboxId == 0) {
        return;
    }
    const QString declared = resolvePath(root, track->anlzRelativePath, false);
    if (declared.isEmpty()) {
        track->diagnostics.append(QStringLiteral("Unsafe ANLZ locator rejected"));
        return;
    }
    const QFileInfo locator(declared);
    const QString suffix = locator.suffix().toUpper();
    if (suffix != "DAT" && suffix != "EXT" && suffix != "2EX") {
        track->diagnostics.append(QStringLiteral("Unsupported ANLZ locator suffix"));
        return;
    }
    QStringList candidates{track->anlzRelativePath};
    for (const auto& extension : {QStringLiteral("DAT"), QStringLiteral("EXT"), QStringLiteral("2EX")}) {
        candidates.append(QDir(root).relativeFilePath(QDir(locator.absolutePath()).filePath(
                locator.completeBaseName() + '.' + extension)));
    }
    QSet<QString> visited;
    bool associated = false;
    bool corrupt = false;
    bool partial = false;
    QList<RuntimeCue> pcobCues;
    QList<RuntimeCue> pco2Cues;
    const auto cueEqual = [](const RuntimeCue& lhs, const RuntimeCue& rhs) {
        return lhs.kind == rhs.kind && lhs.hotcueIndex == rhs.hotcueIndex &&
                lhs.label == rhs.label && lhs.color == rhs.color &&
                lhs.startMs == rhs.startMs && lhs.endMs == rhs.endMs;
    };
    const auto mergeCues = [&](const QList<RuntimeCue>& source,
                                   QList<RuntimeCue>* destination,
                                   const QString& format) {
        for (const auto& cue : source) {
            const bool hot = cue.kind == RuntimeCue::Kind::HotCue ||
                    cue.kind == RuntimeCue::Kind::HotLoop;
            const auto duplicate = std::find_if(destination->cbegin(),
                    destination->cend(),
                    [&](const RuntimeCue& candidate) { return cueEqual(candidate, cue); });
            if (duplicate != destination->cend()) {
                continue;
            }
            const auto conflictingHot = hot
                    ? std::find_if(destination->cbegin(),
                              destination->cend(),
                              [&](const RuntimeCue& candidate) {
                                  return candidate.hotcueIndex == cue.hotcueIndex;
                              })
                    : destination->cend();
            if (conflictingHot == destination->cend()) {
                destination->append(cue);
            } else {
                partial = true;
                track->diagnostics.append(QStringLiteral(
                        "%1 has conflicting cue entries; first associated entry retained")
                                                   .arg(format));
            }
        }
    };
    for (const auto& candidate : candidates) {
        const auto path = resolvePath(root, candidate, true);
        if (path.isEmpty()) {
            continue;
        }
        const auto canonical = QFileInfo(path).canonicalFilePath();
        if (visited.contains(canonical)) {
            continue;
        }
        visited.insert(canonical);
        auto read = readAnlzFile(path, AnlzWaveformReadMode::Descriptor);
        track->diagnostics.append(read.diagnostics);
        if (!read.containerValid) {
            // The PDB locator is candidate provenance, not confirmed PPTH.
            // Invalid means that candidate cannot establish a valid association.
            corrupt = true;
            continue;
        }
        if (!read.hasPathSection || read.exportedAudioPath != track->audioRelativePath ||
                resolvePath(root, read.exportedAudioPath, false).isEmpty()) {
            partial = true;
            track->diagnostics.append(QStringLiteral("ANLZ PPTH does not match owner %1: %2")
                                              .arg(track->rekordboxId).arg(path));
            continue;
        }
        track->analysisFingerprints.insert(QDir(root).relativeFilePath(canonical), read.sourceFingerprint);
        associated = true;
        partial |= read.partial;
        if (read.hadBeatGrid) {
            if (track->beats.isEmpty()) {
                track->beats = read.beats;
            } else {
                partial = true;
                track->diagnostics.append(QStringLiteral("Additional PQTZ not substituted for first grid"));
            }
        }
        for (auto& waveform : read.waveforms) {
            waveform.sessionId = sessionId;
            waveform.ownerTrackId = track->rekordboxId;
        }
        track->waveforms.append(read.waveforms);
        track->unmappedAnalysisSections.append(read.unmappedSections);
        mergeCues(read.pcobCues, &pcobCues, QStringLiteral("PCOB"));
        mergeCues(read.pco2Cues, &pco2Cues, QStringLiteral("PCO2"));
    }
    // Extended cue lists carry the complete modern representation. Empty PCO2
    // lists do not suppress the legacy PCOB fallback.
    track->cues = pco2Cues.isEmpty() ? pcobCues : pco2Cues;
    for (auto& cue : track->cues) for (const auto& legacy : pcobCues) {
        if (legacy.activeLoop && legacy.kind == cue.kind && legacy.startMs == cue.startMs && legacy.endMs == cue.endMs) cue.activeLoop = true;
    }
    track->analysisState = associated
            ? ((partial || corrupt) ? RuntimeAnalysisState::Partial : RuntimeAnalysisState::Ready)
            : (corrupt ? RuntimeAnalysisState::Invalid : RuntimeAnalysisState::Missing);
}

bool populate(const QString& root, const QString& sessionId, const DatabaseDocument& document,
        RuntimeCatalog* catalog, QString* error) {
    const auto tracks = readTrackIndex(document);
    const auto playlists = readPlaylistIndex(document);
    catalog->setBrowseMenu(readBrowseMenu(document));
    const auto historyIndex = readHistoryIndex(document);
    catalog->setHistories(historyIndex.histories);
    for (const auto& diagnostic : historyIndex.diagnostics) catalog->appendDiagnostic(diagnostic);
    if (!tracks.error.isEmpty() || !playlists.error.isEmpty()) {
        *error = tracks.error + playlists.error;
        return false;
    }
    for (const auto& diagnostics : {document.diagnostics, tracks.diagnostics, playlists.diagnostics}) {
        for (const auto& message : diagnostics) {
            catalog->appendDiagnostic(message);
        }
    }
    for (const auto& source : tracks.tracks) {
        RuntimeTrack track;
        track.rekordboxId = source.id;
        const auto& metadata = source.metadata;
        track.rawMetadata = metadata;
        track.title = metadata.value("title").toString();
        track.artist = metadata.value("artist").toString();
        track.album = metadata.value("album").toString();
        track.genre = metadata.value("genre").toString();
        track.comment = metadata.value("comment").toString();
        track.key = metadata.value("key").toString();
        track.composer = metadata.value("composer").toString();
        track.isrc = metadata.value("isrc").toString();
        if (metadata.contains("bpm")) {
            track.bpm = metadata.value("bpm").toDouble();
        }
        track.durationSeconds = metadata.value("duration").toInt();
        track.colorId = metadata.value("color_id").toInt();
        track.artworkId = static_cast<quint32>(metadata.value("artwork_id").toDouble());
        const auto rating = metadata.value("rating").toInt();
        if (rating >= 0 && rating <= 5) {
            track.rating = rating;
        } else {
            track.diagnostics.append(QStringLiteral("Rating outside 0..5 retained only in raw metadata"));
        }
        track.audioRelativePath = source.filePath;
        track.anlzRelativePath = source.analysisPath;
        track.artworkRelativePath = metadata.value("artwork_path").toString();
        track.resolvedAudioPath = resolveTrackPath(root, track.audioRelativePath, &track);
        track.resolvedAnlzPath = resolveTrackPath(root, track.anlzRelativePath, &track);
        track.resolvedArtworkPath = resolveTrackPath(root, track.artworkRelativePath, &track);
        applyAnlz(root, sessionId, &track);
        if (!catalog->insertTrack(std::move(track))) {
            catalog->appendDiagnostic(QStringLiteral("Track %1 omitted: catalog identity/path conflict").arg(source.id));
        }
    }

    QMap<quint32, QList<quint32>> children;
    for (const auto& playlist : playlists.playlists) {
        auto parent = playlist.parentId;
        if (parent != 0 && (!playlists.playlists.contains(parent) ||
                                  !playlists.playlists.value(parent).folder)) {
            catalog->appendDiagnostic(QStringLiteral("Playlist %1 promoted to root: invalid folder parent %2")
                                              .arg(playlist.id).arg(parent));
            parent = 0;
        }
        children[parent].append(playlist.id);
    }
    for (auto& siblings : children) {
        std::sort(siblings.begin(), siblings.end(), [&](quint32 a, quint32 b) {
            const auto orderA = playlists.playlists.value(a).sortOrder;
            const auto orderB = playlists.playlists.value(b).sortOrder;
            return orderA == orderB ? a < b : orderA < orderB;
        });
    }
    std::function<bool(quint32, int, RuntimePlaylistNode*)> buildNode;
    buildNode = [&](quint32 id, int depth, RuntimePlaylistNode* node) {
        if (depth > 64) {
            *error = QStringLiteral("Playlist tree exceeds runtime depth limit 64");
            return false;
        }
        const auto source = playlists.playlists.value(id);
        node->rekordboxId = id;
        node->name = source.name;
        node->isFolder = source.folder;
        node->sortOrder = source.sortOrder;
        const auto entries = playlists.tracks.value(id);
        if (source.folder) {
            if (!entries.isEmpty()) {
                catalog->appendDiagnostic(QStringLiteral("Ignoring track entries attached to folder %1").arg(id));
            }
            for (auto childId : children.value(id)) {
                RuntimePlaylistNode child;
                if (!buildNode(childId, depth + 1, &child)) {
                    return false;
                }
                node->children.append(std::move(child));
            }
        } else {
            for (auto trackId : entries) {
                if (catalog->findTrack(trackId)) {
                    node->trackIds.append(trackId);
                } else {
                    catalog->appendDiagnostic(QStringLiteral("Playlist %1: missing track %2 omitted").arg(id).arg(trackId));
                }
            }
        }
        return true;
    };
    for (auto id : children.value(0)) {
        RuntimePlaylistNode node;
        if (!buildNode(id, 0, &node) || !catalog->insertPlaylist(std::move(node))) {
            if (error->isEmpty()) {
                *error = QStringLiteral("Cannot construct consistent runtime playlist tree");
            }
            return false;
        }
    }
    return catalog->seal();
}
} // namespace

RekordboxUsbSession::RekordboxUsbSession(const QString& root)
        : m_root(root.isEmpty() ? QString() : QFileInfo(root).absoluteFilePath()),
          m_sessionState(std::make_shared<SessionState>()),
          m_sessionId(m_sessionState->identifier().uuid().toString(QUuid::WithoutBraces)) {
}

RekordboxUsbSession::~RekordboxUsbSession() {
    invalidate();
}

QString RekordboxUsbSession::writeList(const QString& name, const QList<quint32>& ids, bool history) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_state != UsbSessionState::Ready || !m_catalog || !m_sessionState->isActive()) return "USB session is unavailable.";
    quint32 id = 0; const auto error = writeUsbList(&m_snapshot, name, ids, history, &id);
    if (error.isEmpty()) {
        if (history) m_catalog->appendHistory({id, name.trimmed(), ids});
        else { RuntimePlaylistNode playlist; playlist.rekordboxId = id; playlist.name = name.trimmed(); playlist.trackIds = ids; m_catalog->appendPlaylist(playlist); }
    }
    return error;
}

QString RekordboxUsbSession::writePerformance(const PerformanceEdit& edit) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_state != UsbSessionState::Ready || !m_catalog || !m_sessionState->isActive()) return "USB session is unavailable.";
    auto track = m_catalog->findTrack(edit.trackId);
    if (!track) return "Unknown USB track.";
    const auto error = writeUsbPerformance(m_snapshot, &*track, edit, m_sessionState);
    if (error.isEmpty()) {
        for (auto& waveform : track->waveforms) waveform.sessionId = m_sessionId;
        m_catalog->updatePerformance(*track);
    }
    return error;
}

QString RekordboxUsbSession::writeRating(quint32 trackId,int rating) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if(m_state!=UsbSessionState::Ready || !m_catalog || !m_sessionState->isActive())
        return QStringLiteral("USB session is unavailable.");
    const auto track=m_catalog->findTrack(trackId);
    if(!track) return QStringLiteral("Unknown USB track.");
    QByteArray fingerprint;
    const auto error=writeUsbRating(m_snapshot,trackId,track->audioRelativePath,rating,&fingerprint);
    if(!error.isEmpty()) return error;
    m_snapshot.fingerprint=fingerprint;
    m_catalog->updateRating(trackId,rating);
    return {};
}

bool RekordboxUsbSession::load() {
    QString root;
    {
        const std::lock_guard<std::mutex> lock(m_mutex);
        if (m_attempted || m_state == UsbSessionState::Invalidated) {
            return false;
        }
        m_attempted = true;
        m_state = UsbSessionState::Parsing;
        root = m_root;
    }
    const auto fail = [&](UsbSessionState state, UsbSessionError code, const QString& error) {
        const std::lock_guard<std::mutex> lock(m_mutex);
        if (m_state != UsbSessionState::Invalidated) {
            m_state = state;
            m_errorCode = code;
            m_error = error;
        }
        return false;
    };
    const QFileInfo volume(root);
    if (root.isEmpty() || !volume.exists()) {
        return fail(UsbSessionState::Missing, UsbSessionError::MissingDevice, QStringLiteral("Volume is missing"));
    }
    if (!volume.isDir() || !volume.isReadable() || !volume.isExecutable()) {
        return fail(UsbSessionState::Unreadable, UsbSessionError::UnreadableDevice, QStringLiteral("Volume is inaccessible"));
    }
    bool recognized = false;
    for (const auto& name : {QStringLiteral("PIONEER"), QStringLiteral(".PIONEER")}) {
        recognized |= QFileInfo::exists(QDir(root).filePath(name));
    }
    if (!recognized) {
        return fail(UsbSessionState::Error, UsbSessionError::NotRekordbox, QStringLiteral("No Rekordbox structure"));
    }
    protectRoot(root);
    // Distinguish an inaccessible export directory from an absent database.
    // Do not probe through out-of-volume symlinks (databasePath rejects them).
    const auto canonicalRoot = volume.canonicalFilePath();
    for (const auto& relative : {QStringLiteral("PIONEER"), QStringLiteral(".PIONEER"),
                 QStringLiteral("PIONEER/rekordbox"), QStringLiteral(".PIONEER/rekordbox")}) {
        const QFileInfo directory(QDir(root).filePath(relative));
        const auto canonical = directory.canonicalFilePath();
        if (directory.isDir() && canonical.startsWith(canonicalRoot + '/') &&
                (!directory.isReadable() || !directory.isExecutable())) {
            return fail(UsbSessionState::Unreadable, UsbSessionError::UnreadableDevice,
                    QStringLiteral("Rekordbox directory is inaccessible"));
        }
    }
    const auto path = databasePath(root);
    if (path.isEmpty()) {
        return fail(UsbSessionState::Error, UsbSessionError::IncompleteExport, QStringLiteral("Main export.pdb missing or unsafe"));
    }
    if (!QFileInfo(path).isReadable()) {
        return fail(UsbSessionState::Unreadable, UsbSessionError::UnreadableDevice, QStringLiteral("Main export.pdb is unreadable"));
    }
    const auto snapshot = inspectDevice(root);
    if (snapshot.state != DeviceState::Readable) {
        return fail(snapshot.state == DeviceState::TooLarge ? UsbSessionState::Error : UsbSessionState::Unreadable,
                snapshot.state == DeviceState::TooLarge ? UsbSessionError::CorruptExport : UsbSessionError::UnreadableDevice,
                snapshot.error);
    }
    const auto document = readDatabaseFile(path, DatabaseKind::Main);
    if (!document.valid()) {
        return fail(UsbSessionState::Error, UsbSessionError::CorruptExport, document.error);
    }
    auto catalog = std::make_shared<RuntimeCatalog>();
    QString error;
    if (!populate(root, m_sessionId, document, catalog.get(), &error)) {
        return fail(UsbSessionState::Error, UsbSessionError::CorruptExport, error);
    }
    const auto extended = resolvePath(root, QDir(root).relativeFilePath(
            QDir(QFileInfo(path).absolutePath()).filePath(QStringLiteral("exportExt.pdb"))));
    const auto current = inspectDevice(root);
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_state == UsbSessionState::Invalidated) {
        catalog->invalidate();
        return false;
    }
    if (!snapshot.matches(current) || snapshot.databasePath != current.databasePath ||
            snapshot.fingerprint != QCryptographicHash::hash(document.bytes, QCryptographicHash::Sha256)) {
        m_errorCode = UsbSessionError::ChangedDevice;
        m_error = QStringLiteral("Volume/export changed during parsing");
        invalidateLocked();
        catalog->invalidate();
        return false;
    }
    m_snapshot = snapshot;
    m_catalog = std::move(catalog);
    m_extendedDatabasePath = extended;
    m_state = UsbSessionState::Ready;
    return true;
}

bool RekordboxUsbSession::refresh() {
    DeviceSnapshot expected;
    QString root;
    {
        const std::lock_guard<std::mutex> lock(m_mutex);
        if (m_state != UsbSessionState::Ready) {
            return false;
        }
        root = m_root;
        expected = m_snapshot;
    }
    const auto current = inspectDevice(root);
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_state != UsbSessionState::Ready) {
        return false;
    }
    if (!expected.matches(current) || expected.databasePath != current.databasePath) {
        m_errorCode = UsbSessionError::ChangedDevice;
        m_error = QStringLiteral("Volume/export removed, inaccessible or changed");
        invalidateLocked();
        return false;
    }
    return true;
}

std::optional<QByteArray> RekordboxUsbSession::loadWaveformPayload(
        const RuntimeWaveform& descriptor, QString* error) {
    if (error) {
        error->clear();
    }
    const auto fail = [error](const QString& message) -> std::optional<QByteArray> {
        if (error) {
            *error = message;
        }
        return std::nullopt;
    };
    if (!refresh()) {
        return fail(QStringLiteral("Session or PDB source is no longer valid"));
    }
    QString root;
    RuntimeWaveform expected;
    {
        const std::lock_guard<std::mutex> lock(m_mutex);
        if (m_state != UsbSessionState::Ready || !m_catalog ||
                descriptor.sessionId != m_sessionId || !descriptor.payloadDeferred) {
            return fail(QStringLiteral("Waveform descriptor belongs to no active session"));
        }
        const auto owner = m_catalog->findTrack(descriptor.ownerTrackId);
        if (!owner) {
            return fail(QStringLiteral("Unknown waveform owner"));
        }
        const auto found = std::find_if(owner->waveforms.cbegin(), owner->waveforms.cend(),
                [&](const RuntimeWaveform& w) {
                    return w.sessionId == descriptor.sessionId &&
                            w.sourceAnalysisPath == descriptor.sourceAnalysisPath &&
                            w.sectionOffset == descriptor.sectionOffset &&
                            w.headerLength == descriptor.headerLength &&
                            w.payloadOffset == descriptor.payloadOffset &&
                            w.payloadLength == descriptor.payloadLength &&
                            w.headerBytes == descriptor.headerBytes &&
                            w.sectionTag == descriptor.sectionTag &&
                            w.entryCount == descriptor.entryCount &&
                            w.bytesPerEntry == descriptor.bytesPerEntry &&
                            w.sourceFingerprint == descriptor.sourceFingerprint &&
                            w.sourceSize == descriptor.sourceSize &&
                            w.sourceModifiedMs == descriptor.sourceModifiedMs;
                });
        if (found == owner->waveforms.cend()) {
            return fail(QStringLiteral("Descriptor was not issued for this owner/session"));
        }
        expected = *found; // Only catalog-issued values drive I/O.
        root = m_root;
    }
    const auto confinedSource = [&]() {
        const auto resolved = resolvePath(root,
                QDir(root).relativeFilePath(expected.sourceAnalysisPath), true);
        return !resolved.isEmpty() && QFileInfo(resolved).canonicalFilePath() ==
                expected.sourceAnalysisPath;
    };
    constexpr qint64 maxBytes = 64LL * 1024 * 1024;
    if (!confinedSource() || expected.sourceSize < 28 || expected.sourceSize > maxBytes ||
            expected.headerLength < 12 || expected.payloadOffset != expected.headerLength - 12 ||
            expected.headerBytes.size() != expected.headerLength ||
            expected.sectionOffset > quint64(expected.sourceSize) ||
            expected.headerLength > quint64(expected.sourceSize) - expected.sectionOffset ||
            expected.payloadLength > quint64(expected.sourceSize) - expected.sectionOffset - expected.headerLength) {
        return fail(QStringLiteral("Unsafe waveform source or bounds"));
    }
    QFile file(expected.sourceAnalysisPath);
    if (!file.open(QIODevice::ReadOnly)) {
        return fail(QStringLiteral("Cannot open waveform source read-only"));
    }
    const auto unchanged = [&]() {
        return confinedSource() && file.size() == expected.sourceSize &&
                QFileInfo(file).lastModified().toMSecsSinceEpoch() == expected.sourceModifiedMs;
    };
    const auto verifyFingerprint = [&]() {
        if (!unchanged() || !file.seek(0)) {
            return false;
        }
        QCryptographicHash hash(QCryptographicHash::Sha256);
        qint64 remaining = expected.sourceSize;
        while (remaining > 0) {
            const auto count = qMin<qint64>(remaining, 64 * 1024);
            const auto block = file.read(count);
            if (block.size() != count) {
                return false;
            }
            hash.addData(block);
            remaining -= count;
        }
        return file.error() == QFileDevice::NoError && unchanged() &&
                hash.result() == expected.sourceFingerprint;
    };
    // The full fingerprint also revalidates the PPTH bytes accepted at mounting.
    if (!verifyFingerprint() || !file.seek(expected.sectionOffset) ||
            file.read(expected.headerLength) != expected.headerBytes ||
            !file.seek(expected.sectionOffset + expected.headerLength)) {
        return fail(QStringLiteral("Waveform source/header changed"));
    }
    const auto payload = file.read(expected.payloadLength);
    if (payload.size() != expected.payloadLength || file.error() != QFileDevice::NoError ||
            !verifyFingerprint()) {
        return fail(QStringLiteral("Waveform truncated or changed during payload read"));
    }
    if (!refresh()) {
        return fail(QStringLiteral("Session source changed during payload read"));
    }
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_state != UsbSessionState::Ready || !m_catalog || expected.sessionId != m_sessionId) {
        return fail(QStringLiteral("Session invalidated during payload read"));
    }
    return payload;
}

void RekordboxUsbSession::invalidateLocked() {
    m_sessionState->invalidate();
    if (m_catalog) {
        m_catalog->invalidate();
        m_catalog.reset();
    }
    m_root.clear();
    m_snapshot = {};
    m_extendedDatabasePath.clear();
    m_state = UsbSessionState::Invalidated;
}

void RekordboxUsbSession::invalidate() {
    const std::lock_guard<std::mutex> lock(m_mutex);
    invalidateLocked();
}

DeviceSnapshot RekordboxUsbSession::deviceSnapshot() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_snapshot;
}
UsbSessionState RekordboxUsbSession::state() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_state;
}
UsbSessionError RekordboxUsbSession::errorCode() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_errorCode;
}
QString RekordboxUsbSession::error() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_error;
}
std::shared_ptr<const RuntimeCatalog> RekordboxUsbSession::catalog() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_catalog;
}
std::shared_ptr<const SessionState> RekordboxUsbSession::sessionState() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_state != UsbSessionState::Ready || !m_sessionState->isActive()) {
        return {};
    }
    return m_sessionState;
}
TrackPointer RekordboxUsbSession::createTemporaryTrack(
        quint32 rekordboxId, QString* error) {
    if (error) {
        error->clear();
    }
    // A path alone is not an identity. Revalidate the PDB fingerprint before
    // every projection so a different volume mounted at the same path cannot
    // inherit the old session's authority.
    if (!refresh()) {
        if (error) {
            *error = QStringLiteral("Rekordbox USB source changed or disappeared");
        }
        return {};
    }
    std::optional<RuntimeTrack> runtimeTrack;
    std::shared_ptr<const SessionState> sessionState;
    {
        const std::lock_guard<std::mutex> lock(m_mutex);
        if (m_state != UsbSessionState::Ready || !m_catalog ||
                !m_sessionState->isActive()) {
            if (error) {
                *error = QStringLiteral("Rekordbox USB session is not ready");
            }
            return {};
        }
        runtimeTrack = m_catalog->findTrack(rekordboxId);
        sessionState = m_sessionState;
    }
    if (!runtimeTrack) {
        if (error) {
            *error = QStringLiteral("Unknown Rekordbox track identifier");
        }
        return {};
    }
    // Load each native style and preview on demand; mounting stays descriptor-only.
    const auto waveformPriority = [](const RuntimeWaveform& waveform) {
        const auto& tag = waveform.sectionTag;
        if (tag == "PWV7")
            return 0;
        if (tag == "PWV5")
            return 1;
        if (tag == "PWV3")
            return 2;
        if (tag == "PWV6")
            return 3;
        if (tag == "PWV4")
            return 4;
        if (tag == "PWAV")
            return 5;
        if (tag == "PWV2")
            return 6;
        return 100;
    };
    QList<RuntimeWaveform> waveformCandidates = runtimeTrack->waveforms;
    std::stable_sort(waveformCandidates.begin(),
            waveformCandidates.end(),
            [&](const RuntimeWaveform& lhs, const RuntimeWaveform& rhs) {
                return waveformPriority(lhs) < waveformPriority(rhs);
            });
    QList<LoadedRuntimeWaveform> loadedWaveforms;
    QSet<QByteArray> loadedTags;
    for (const auto& candidate : std::as_const(waveformCandidates)) {
        if (waveformPriority(candidate) >= 100) {
            break;
        }
        if (loadedTags.contains(candidate.sectionTag)) continue;
        QString waveformError;
        auto payload = loadWaveformPayload(candidate, &waveformError);
        if (payload && !payload->isEmpty()) {
            loadedWaveforms.append(LoadedRuntimeWaveform{candidate, std::move(*payload)});
            loadedTags.insert(candidate.sectionTag);
        } else if (!waveformError.isEmpty()) {
            qWarning() << "Cannot load Rekordbox waveform for track"
                       << rekordboxId << waveformError;
        }
    }
    return RekordboxTrackAdapter::createTemporaryTrack(
            *runtimeTrack, sessionState, std::move(loadedWaveforms), error);
}
QString RekordboxUsbSession::extendedDatabasePath() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_extendedDatabasePath;
}
} // namespace mixxx::rekordbox
