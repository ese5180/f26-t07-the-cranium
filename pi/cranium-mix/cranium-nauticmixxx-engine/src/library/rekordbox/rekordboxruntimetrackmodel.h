#pragma once

#include <QCache>
#include <QHash>
#include <QList>
#include <QSet>

#include <memory>

#include "library/basetracktablemodel.h"
#include "library/rekordbox/rekordboxruntimecatalog.h"
#include "library/rekordbox/rekordboxwaveformimporter.h"

namespace mixxx::rekordbox {

class RekordboxUsbSession;
class SessionState;

// Read-only, non-SQL rows for one live Rekordbox USB session. Rekordbox IDs
// remain provider identities and are never exposed as Mixxx TrackIds.
class RekordboxRuntimeTrackModel final : public BaseTrackTableModel {
    Q_OBJECT

  public:
    RekordboxRuntimeTrackModel(
            QObject* parent,
            TrackCollectionManager* pTrackCollectionManager);

    void showAllTracks(std::shared_ptr<RekordboxUsbSession> session);
    void showPlaylist(std::shared_ptr<RekordboxUsbSession> session,
            const QList<quint32>& trackIds,
            quint32 playlistId);
    void showTrackIds(std::shared_ptr<RekordboxUsbSession> session,
            const QList<quint32>& trackIds,
            const QString& viewKey);
    void clearSession();
    void refreshRating(quint32 id,int rating);

    int rowCount(const QModelIndex& parent = QModelIndex()) const override;
    TrackPointer getTrack(const QModelIndex& index) const override;
    TrackPointer getTrackByRef(const TrackRef& trackRef) const override;
    QUrl getTrackUrl(const QModelIndex& index) const override;
    QString getTrackLocation(const QModelIndex& index) const override;
    TrackId getTrackId(const QModelIndex& index) const override;
    CoverInfo getCoverInfo(const QModelIndex& index) const override;
    const QVector<int> getTrackRows(TrackId trackId) const override;
    void search(const QString& searchText) override;
    const QString currentSearch() const override;
    bool isColumnInternal(int column) override;
    Qt::ItemFlags flags(const QModelIndex& index) const override;
    void copyTracks(const QModelIndexList& indices) const override;
    const QList<int>& searchColumns() const override;
    Capabilities getCapabilities() const override;
    SortColumnId sortColumnIdFromColumnIndex(int index) const override;
    int columnIndexFromSortColumnId(SortColumnId sortColumn) const override;
    QString modelKey(bool noSearch) const override;
    bool updateTrackGenre(Track* pTrack, const QString& genre) const override;
#if defined(__EXTRA_METADATA__)
    bool updateTrackMood(Track* pTrack, const QString& mood) const override;
#endif

    // Browser waveform previews are loaded lazily and asynchronously from the
    // session. nullptr means not ready yet; an empty vector means that no
    // supported/valid preview is available. The cache is session-scoped and
    // never enters SQL or the persistent Track model.
    const WaveformSeries* waveformPreview(
            const QModelIndex& index, WaveformMode mode) const;
    void requestWaveformPreview(const QModelIndex& index, WaveformMode mode);
    std::shared_ptr<const SessionState> sessionState() const;

  protected:
    QVariant rawValue(const QModelIndex& index) const override;

  private:
    void setRows(std::shared_ptr<RekordboxUsbSession> session,
            QList<RuntimeTrack> rows,
            QString viewKey);
    const RuntimeTrack* trackAt(const QModelIndex& index) const;

    std::shared_ptr<RekordboxUsbSession> m_session;
    QList<RuntimeTrack> m_rows;
    QList<int> m_searchColumns;
    QHash<int, SortColumnId> m_sortColumnIds;
    QHash<int, int> m_columnIndexes;
    QString m_viewKey{QStringLiteral("rekordbox-usb:empty")};
    QCache<quint64, WaveformSeries> m_waveformPreviewCache{128};
    QSet<quint64> m_pendingWaveformPreviews;
    quint64 m_previewGeneration{0};
};

} // namespace mixxx::rekordbox
