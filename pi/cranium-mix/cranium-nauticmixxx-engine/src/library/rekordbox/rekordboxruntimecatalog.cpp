#include "library/rekordbox/rekordboxruntimecatalog.h"

#include <QSet>
#include <functional>
#include <utility>

namespace mixxx::rekordbox {

bool RuntimeCatalog::appendPlaylist(RuntimePlaylistNode playlist) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid || m_playlistIndex.contains(playlist.rekordboxId)) return false;
    m_playlistIndex.insert(playlist.rekordboxId, playlist); m_playlists.append(std::move(playlist)); return true;
}
bool RuntimeCatalog::appendHistory(DatabaseHistory history) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid) return false;
    for(auto& existing:m_histories) if(existing.id==history.id) {existing=std::move(history);return true;}
    m_histories.append(std::move(history)); return true;
}

bool RuntimeCatalog::updatePerformance(const RuntimeTrack& track) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    auto it = m_tracks.find(track.rekordboxId);
    if (!m_valid || it == m_tracks.end() || it->audioRelativePath != track.audioRelativePath) return false;
    it->cues = track.cues; it->beats = track.beats;
    it->analysisFingerprints = track.analysisFingerprints; it->waveforms = track.waveforms;
    return true;
}

bool RuntimeCatalog::updateRating(quint32 id,int rating) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    auto it=m_tracks.find(id);
    if(!m_valid || it==m_tracks.end() || rating<0 || rating>5) return false;
    it->rating=quint32(rating);it->rawMetadata.insert("rating",rating);
    return true;
}

bool RuntimeCatalog::insertTrack(RuntimeTrack track) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid || m_sealed || track.rekordboxId == 0) {
        return false;
    }
    if (m_tracks.contains(track.rekordboxId)) {
        m_diagnostics.append(QStringLiteral("duplicate rekordbox track id %1")
                                     .arg(track.rekordboxId));
        return false;
    }
    if (!track.audioRelativePath.isEmpty() &&
            m_audioPaths.contains(track.audioRelativePath)) {
        m_diagnostics.append(QStringLiteral("duplicate exported audio path"));
        return false;
    }
    if (!track.audioRelativePath.isEmpty()) {
        m_audioPaths.insert(track.audioRelativePath, track.rekordboxId);
    }
    const auto id = track.rekordboxId;
    m_tracks.insert(id, std::move(track));
    return true;
}

bool RuntimeCatalog::insertPlaylist(RuntimePlaylistNode playlist) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid || m_sealed) {
        return false;
    }
    QHash<quint32, RuntimePlaylistNode> pending;
    // This is a resource bound, not a Pioneer format restriction.
    constexpr int kMaxDepth = 64;
    std::function<bool(const RuntimePlaylistNode&, int)> validate;
    validate = [&](const RuntimePlaylistNode& node, int depth) {
        if (depth > kMaxDepth || node.rekordboxId == 0 ||
                m_playlistIndex.contains(node.rekordboxId) ||
                pending.contains(node.rekordboxId) ||
                (node.isFolder && !node.trackIds.isEmpty()) ||
                (!node.isFolder && !node.children.isEmpty())) {
            return false;
        }
        for (const auto id : node.trackIds) {
            if (!m_tracks.contains(id)) {
                return false;
            }
        }
        pending.insert(node.rekordboxId, node);
        for (const auto& child : node.children) {
            if (!validate(child, depth + 1)) {
                return false;
            }
        }
        return true;
    };
    if (!validate(playlist, 0)) {
        m_diagnostics.append(QStringLiteral("invalid playlist subtree or reference"));
        return false;
    }
    m_playlistIndex.insert(pending);
    m_playlists.append(std::move(playlist));
    return true;
}

bool RuntimeCatalog::setBrowseMenu(BrowseMenu menu) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid || m_sealed) return false;
    m_browseMenu = std::move(menu);
    return true;
}

bool RuntimeCatalog::setHistories(QList<DatabaseHistory> histories) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid || m_sealed) return false;
    m_histories = std::move(histories);
    return true;
}

bool RuntimeCatalog::seal() {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_valid) {
        return false;
    }
    m_sealed = true;
    return true;
}

void RuntimeCatalog::invalidate() {
    const std::lock_guard<std::mutex> lock(m_mutex);
    m_valid = false;
    m_tracks.clear();
    m_audioPaths.clear();
    m_playlists.clear();
    m_browseMenu = {};
    m_histories.clear();
    m_playlistIndex.clear();
}

bool RuntimeCatalog::valid() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_valid;
}

bool RuntimeCatalog::sealed() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_sealed;
}

QHash<quint32, RuntimeTrack> RuntimeCatalog::tracks() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_tracks;
}

QList<RuntimePlaylistNode> RuntimeCatalog::playlists() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_playlists;
}

BrowseMenu RuntimeCatalog::browseMenu() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_browseMenu;
}

QList<DatabaseHistory> RuntimeCatalog::histories() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_histories;
}

QStringList RuntimeCatalog::diagnostics() const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    return m_diagnostics;
}

void RuntimeCatalog::appendDiagnostic(const QString& message) {
    const std::lock_guard<std::mutex> lock(m_mutex);
    if (m_valid && !m_sealed) {
        m_diagnostics.append(message);
    }
}

std::optional<RuntimeTrack> RuntimeCatalog::findTrack(quint32 id) const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    const auto it = m_tracks.constFind(id);
    return m_valid && it != m_tracks.cend()
            ? std::make_optional(it.value()) : std::nullopt;
}

std::optional<RuntimeTrack> RuntimeCatalog::findTrackByAudioPath(
        const QString& path) const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    const auto it = m_audioPaths.constFind(path);
    if (!m_valid || it == m_audioPaths.cend()) {
        return std::nullopt;
    }
    return m_tracks.value(it.value());
}

std::optional<RuntimePlaylistNode> RuntimeCatalog::findPlaylist(quint32 id) const {
    const std::lock_guard<std::mutex> lock(m_mutex);
    const auto it = m_playlistIndex.constFind(id);
    return m_valid && it != m_playlistIndex.cend()
            ? std::make_optional(it.value()) : std::nullopt;
}

} // namespace mixxx::rekordbox
