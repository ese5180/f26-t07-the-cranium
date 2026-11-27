#include "library/rekordbox/rekordboxruntimetrackmodel.h"

#include <QFileInfo>
#include <QFutureWatcher>
#include <QUrlQuery>
#include <QtConcurrentRun>

#include <algorithm>
#include <utility>

#include "library/dao/trackschema.h"
#include "library/rekordbox/rekordboxsessionstate.h"
#include "library/rekordbox/rekordboxusbsession.h"
#include "mixer/playerinfo.h"
#include "moc_rekordboxruntimetrackmodel.cpp"
#include "track/track.h"

namespace mixxx::rekordbox {
namespace {

const QStringList kColumns{
        LIBRARYTABLE_ID,
        LIBRARYTABLE_PREVIEW,
        LIBRARYTABLE_ARTIST,
        LIBRARYTABLE_TITLE,
        LIBRARYTABLE_ALBUM,
        LIBRARYTABLE_GENRE,
        LIBRARYTABLE_COMPOSER,
        TRACKLOCATIONSTABLE_LOCATION,
        LIBRARYTABLE_COMMENT,
        LIBRARYTABLE_RATING,
        LIBRARYTABLE_DURATION,
        LIBRARYTABLE_BPM,
        LIBRARYTABLE_KEY,
        LIBRARYTABLE_FILETYPE,
};

} // namespace

RekordboxRuntimeTrackModel::RekordboxRuntimeTrackModel(
        QObject* parent,
        TrackCollectionManager* pTrackCollectionManager)
        : BaseTrackTableModel(
                  parent,
                  pTrackCollectionManager,
                  "mixxx.db.model.rekordbox_usb_runtime") {
    initTableColumnsAndHeaderProperties(kColumns);
    const auto addSortColumn = [this](SortColumnId sortColumn, ColumnCache::Column column) {
        const auto index = fieldIndex(column);
        if (index >= 0) {
            m_columnIndexes.insert(static_cast<int>(sortColumn), index);
            m_sortColumnIds.insert(index, sortColumn);
        }
    };
    addSortColumn(SortColumnId::Artist, ColumnCache::COLUMN_LIBRARYTABLE_ARTIST);
    addSortColumn(SortColumnId::Title, ColumnCache::COLUMN_LIBRARYTABLE_TITLE);
    addSortColumn(SortColumnId::Album, ColumnCache::COLUMN_LIBRARYTABLE_ALBUM);
    addSortColumn(SortColumnId::Genre, ColumnCache::COLUMN_LIBRARYTABLE_GENRE);
    addSortColumn(SortColumnId::Composer, ColumnCache::COLUMN_LIBRARYTABLE_COMPOSER);
    addSortColumn(SortColumnId::NativeLocation,
            ColumnCache::COLUMN_TRACKLOCATIONSTABLE_LOCATION);
    addSortColumn(SortColumnId::Comment, ColumnCache::COLUMN_LIBRARYTABLE_COMMENT);
    addSortColumn(SortColumnId::Rating, ColumnCache::COLUMN_LIBRARYTABLE_RATING);
    addSortColumn(SortColumnId::Duration, ColumnCache::COLUMN_LIBRARYTABLE_DURATION);
    addSortColumn(SortColumnId::Bpm, ColumnCache::COLUMN_LIBRARYTABLE_BPM);
    addSortColumn(SortColumnId::Key, ColumnCache::COLUMN_LIBRARYTABLE_KEY);
    addSortColumn(SortColumnId::FileType, ColumnCache::COLUMN_LIBRARYTABLE_FILETYPE);
    addSortColumn(SortColumnId::Preview, ColumnCache::COLUMN_LIBRARYTABLE_PREVIEW);

    m_searchColumns = {
            fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_ARTIST),
            fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_TITLE),
            fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_ALBUM),
            fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_GENRE),
            fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_COMPOSER),
            fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_COMMENT),
            fieldIndex(ColumnCache::COLUMN_TRACKLOCATIONSTABLE_LOCATION),
    };
    m_searchColumns.removeAll(-1);
    setDefaultSort(fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_ARTIST),
            Qt::AscendingOrder);
}

void RekordboxRuntimeTrackModel::showAllTracks(
        std::shared_ptr<RekordboxUsbSession> session) {
    QList<RuntimeTrack> rows;
    auto catalog = session ? session->catalog() : nullptr;
    auto tracks = catalog ? catalog->tracks() : QHash<quint32, RuntimeTrack>{};
    auto ids = tracks.keys();
    std::sort(ids.begin(), ids.end());
    rows.reserve(ids.size());
    for (const auto id : std::as_const(ids)) {
        rows.append(tracks.value(id));
    }
    setRows(std::move(session), std::move(rows), QStringLiteral("all"));
}

void RekordboxRuntimeTrackModel::showPlaylist(
        std::shared_ptr<RekordboxUsbSession> session,
        const QList<quint32>& trackIds,
        quint32 playlistId) {
    QList<RuntimeTrack> rows;
    auto catalog = session ? session->catalog() : nullptr;
    if (catalog) {
        rows.reserve(trackIds.size());
        for (const auto trackId : trackIds) {
            auto track = catalog->findTrack(trackId);
            if (track) {
                rows.append(std::move(*track));
            }
        }
    }
    setRows(std::move(session),
            std::move(rows),
            QStringLiteral("playlist:%1").arg(playlistId));
}

void RekordboxRuntimeTrackModel::showTrackIds(
        std::shared_ptr<RekordboxUsbSession> session,
        const QList<quint32>& trackIds,
        const QString& viewKey) {
    QList<RuntimeTrack> rows;
    auto catalog = session ? session->catalog() : nullptr;
    if (catalog) {
        rows.reserve(trackIds.size());
        for (const auto id : trackIds) {
            if (auto track = catalog->findTrack(id)) rows.append(std::move(*track));
        }
    }
    setRows(std::move(session), std::move(rows), viewKey);
}

void RekordboxRuntimeTrackModel::refreshRating(quint32 id,int rating) {
    for(int row=0;row<m_rows.size();++row) if(m_rows[row].rekordboxId==id) {
        m_rows[row].rating=quint32(rating);
        const int col=fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_RATING);
        emit dataChanged(index(row,col),index(row,col));
    }
}

void RekordboxRuntimeTrackModel::clearSession() {
    setRows({}, {}, QStringLiteral("empty"));
}

std::shared_ptr<const SessionState> RekordboxRuntimeTrackModel::sessionState() const {
    return m_session ? m_session->sessionState() : nullptr;
}

void RekordboxRuntimeTrackModel::setRows(
        std::shared_ptr<RekordboxUsbSession> session,
        QList<RuntimeTrack> rows,
        QString viewKey) {
    beginResetModel();
    ++m_previewGeneration;
    m_waveformPreviewCache.clear();
    m_pendingWaveformPreviews.clear();
    m_session = std::move(session);
    m_rows = std::move(rows);
    const auto state = m_session ? m_session->sessionState() : nullptr;
    const auto sessionId = state
            ? state->identifier().uuid().toString(QUuid::WithoutBraces)
            : QStringLiteral("none");
    m_viewKey = QStringLiteral("rekordbox-usb:%1:%2")
                        .arg(sessionId, std::move(viewKey));
    endResetModel();
}

int RekordboxRuntimeTrackModel::rowCount(const QModelIndex& parent) const {
    return parent.isValid() ? 0 : m_rows.size();
}

const RuntimeTrack* RekordboxRuntimeTrackModel::trackAt(
        const QModelIndex& index) const {
    if (!index.isValid() || index.row() < 0 || index.row() >= m_rows.size()) {
        return nullptr;
    }
    return &m_rows[index.row()];
}

TrackPointer RekordboxRuntimeTrackModel::getTrack(const QModelIndex& index) const {
    const auto* runtimeTrack = trackAt(index);
    if (!runtimeTrack || !m_session) {
        return {};
    }
    QString error;
    const auto track = m_session->createTemporaryTrack(
            runtimeTrack->rekordboxId, &error);
    if (!track) {
        qWarning() << "Cannot project Rekordbox USB track" << error;
    }
    return track;
}

TrackPointer RekordboxRuntimeTrackModel::getTrackByRef(
        const TrackRef& trackRef) const {
    if (!m_session || !trackRef.isValid()) {
        return {};
    }
    const auto location = QDir::cleanPath(trackRef.getLocation());
    for (int row = 0; row < m_rows.size(); ++row) {
        if (QDir::cleanPath(m_rows[row].resolvedAudioPath) == location) {
            return getTrack(index(row, 0));
        }
    }
    return {};
}

QUrl RekordboxRuntimeTrackModel::getTrackUrl(const QModelIndex& index) const {
    const auto* runtimeTrack = trackAt(index);
    const auto state = m_session ? m_session->sessionState() : nullptr;
    if (!runtimeTrack || !state) {
        return {};
    }
    QUrl url;
    url.setScheme(QStringLiteral("rekordbox-usb"));
    url.setHost(state->identifier().uuid().toString(QUuid::WithoutBraces));
    url.setPath(QStringLiteral("/track/%1").arg(runtimeTrack->rekordboxId));
    return url;
}

QString RekordboxRuntimeTrackModel::getTrackLocation(
        const QModelIndex& index) const {
    const auto* runtimeTrack = trackAt(index);
    return runtimeTrack ? runtimeTrack->resolvedAudioPath : QString();
}

TrackId RekordboxRuntimeTrackModel::getTrackId(const QModelIndex&) const {
    return {};
}

CoverInfo RekordboxRuntimeTrackModel::getCoverInfo(
        const QModelIndex&) const {
    // Cover loaders retain plain paths and may run after the removable session
    // has been revoked. Keep artwork metadata in RuntimeTrack, but do not hand
    // an unguarded USB path to the existing asynchronous cover pipeline.
    return {};
}

const QVector<int> RekordboxRuntimeTrackModel::getTrackRows(TrackId) const {
    // Provider identities deliberately never masquerade as Mixxx TrackIds.
    return {};
}

void RekordboxRuntimeTrackModel::search(const QString&) {
    // Search and sorting are provided by ProxyTrackModel without mutating rows.
}

const QString RekordboxRuntimeTrackModel::currentSearch() const {
    return {};
}

bool RekordboxRuntimeTrackModel::isColumnInternal(int column) {
    return column == fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_ID) ||
            (PlayerInfo::instance().numPreviewDecks() == 0 &&
                    column == fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_PREVIEW));
}

Qt::ItemFlags RekordboxRuntimeTrackModel::flags(const QModelIndex& index) const {
    if (!index.isValid()) {
        return Qt::ItemIsEnabled;
    }
    // Omitting ItemIsDragEnabled is intentional: a file URL drag would erase
    // the capability/session context and re-enter Mixxx's normal import path.
    return Qt::ItemIsEnabled | Qt::ItemIsSelectable;
}

void RekordboxRuntimeTrackModel::copyTracks(const QModelIndexList&) const {
    // Clipboard file URLs would likewise degrade the source contract.
}

const QList<int>& RekordboxRuntimeTrackModel::searchColumns() const {
    return m_searchColumns;
}

TrackModel::Capabilities RekordboxRuntimeTrackModel::getCapabilities() const {
    return Capability::LoadToDeck |
            Capability::LoadToPreviewDeck |
            Capability::LoadToSampler |
            Capability::Sorting;
}

TrackModel::SortColumnId RekordboxRuntimeTrackModel::sortColumnIdFromColumnIndex(
        int index) const {
    return m_sortColumnIds.value(index, SortColumnId::Invalid);
}

int RekordboxRuntimeTrackModel::columnIndexFromSortColumnId(
        SortColumnId sortColumn) const {
    return m_columnIndexes.value(static_cast<int>(sortColumn), -1);
}

QString RekordboxRuntimeTrackModel::modelKey(bool) const {
    return m_viewKey;
}

bool RekordboxRuntimeTrackModel::updateTrackGenre(Track*, const QString&) const {
    return false;
}

const WaveformSeries* RekordboxRuntimeTrackModel::waveformPreview(
        const QModelIndex& index, WaveformMode mode) const {
    const auto* track = trackAt(index);
    return track ? m_waveformPreviewCache.object(quint64(track->rekordboxId) * 3 + int(mode)) : nullptr;
}

void RekordboxRuntimeTrackModel::requestWaveformPreview(
        const QModelIndex& index, WaveformMode mode) {
    const auto* track = trackAt(index);
    if (!track || !m_session) return;
    const quint32 rekordboxId = track->rekordboxId;
    const quint64 key = quint64(rekordboxId) * 3 + int(mode);
    if (m_waveformPreviewCache.contains(key) || m_pendingWaveformPreviews.contains(key)) return;

    auto descriptors = track->waveforms;
    std::stable_sort(descriptors.begin(), descriptors.end(), [mode](const auto& a, const auto& b) {
        return previewWaveformPriority(a.sectionTag, mode) < previewWaveformPriority(b.sectionTag, mode);
    });
    const auto session = m_session;
    const auto generation = m_previewGeneration;
    m_pendingWaveformPreviews.insert(key);
    auto* watcher = new QFutureWatcher<WaveformSeries>(this);
    connect(watcher, &QFutureWatcher<WaveformSeries>::finished, this,
            [this, watcher, rekordboxId, key, generation] {
                auto preview = watcher->result();
                watcher->deleteLater();
                if (generation != m_previewGeneration) return;
                m_pendingWaveformPreviews.remove(key);
                m_waveformPreviewCache.insert(key, new WaveformSeries(std::move(preview)));
                const int previewColumn = fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_PREVIEW);
                for (int row = 0; row < m_rows.size(); ++row) {
                    if (m_rows[row].rekordboxId == rekordboxId && previewColumn >= 0) {
                        emit dataChanged(this->index(row, previewColumn), this->index(row, previewColumn));
                    }
                }
            });
    watcher->setFuture(QtConcurrent::run([session, descriptors] {
        for (const auto& descriptor : descriptors) {
            QString error;
            auto payload = session->loadWaveformPayload(descriptor, &error);
            if (!payload || payload->isEmpty()) continue;
            WaveformSeries preview;
            preview.tag = descriptor.sectionTag;
            preview.columns = decodeRuntimeWaveformColumns(
                    LoadedRuntimeWaveform{descriptor, std::move(*payload)}, 1024);
            if (!preview.columns.isEmpty()) return preview;
        }
        return WaveformSeries{};
    }));
}

#if defined(__EXTRA_METADATA__)
bool RekordboxRuntimeTrackModel::updateTrackMood(Track*, const QString&) const {
    return false;
}
#endif

QVariant RekordboxRuntimeTrackModel::rawValue(const QModelIndex& index) const {
    const auto* track = trackAt(index);
    if (!track) {
        return {};
    }
    switch (mapColumn(index.column())) {
    case ColumnCache::COLUMN_LIBRARYTABLE_ID:
        return static_cast<qulonglong>(track->rekordboxId);
    case ColumnCache::COLUMN_LIBRARYTABLE_PREVIEW:
        return false;
    case ColumnCache::COLUMN_LIBRARYTABLE_ARTIST:
        return track->artist;
    case ColumnCache::COLUMN_LIBRARYTABLE_TITLE:
        return track->title;
    case ColumnCache::COLUMN_LIBRARYTABLE_ALBUM:
        return track->album;
    case ColumnCache::COLUMN_LIBRARYTABLE_GENRE:
        return track->genre;
    case ColumnCache::COLUMN_LIBRARYTABLE_COMPOSER:
        return track->composer;
    case ColumnCache::COLUMN_TRACKLOCATIONSTABLE_LOCATION:
        return track->resolvedAudioPath;
    case ColumnCache::COLUMN_LIBRARYTABLE_COMMENT:
        return track->comment;
    case ColumnCache::COLUMN_LIBRARYTABLE_RATING:
        return track->rating ? QVariant::fromValue(static_cast<int>(*track->rating))
                             : QVariant();
    case ColumnCache::COLUMN_LIBRARYTABLE_DURATION:
        return track->durationSeconds
                ? QVariant::fromValue(static_cast<double>(*track->durationSeconds))
                : QVariant();
    case ColumnCache::COLUMN_LIBRARYTABLE_BPM:
        return track->bpm ? QVariant::fromValue(*track->bpm) : QVariant();
    case ColumnCache::COLUMN_LIBRARYTABLE_KEY:
        return track->key;
    case ColumnCache::COLUMN_LIBRARYTABLE_FILETYPE:
        return QFileInfo(track->resolvedAudioPath).suffix();
    default:
        return {};
    }
}

} // namespace mixxx::rekordbox
