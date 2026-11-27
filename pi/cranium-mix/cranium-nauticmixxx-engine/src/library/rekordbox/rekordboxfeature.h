// Browser for removable Rekordbox exports; only explicit INFO rating edits write USB.
// Runtime rows are never
// copied into Mixxx's collection or represented by Mixxx TrackIds.
#pragma once

#include <QFuture>
#include <QFutureWatcher>
#include <QHash>
#include <QSet>
#include <QTimer>
#include <QtConcurrentRun>

#include <memory>
#include <functional>

#include "library/libraryfeature.h"
#include "library/proxytrackmodel.h"
#include "library/rekordbox/rekordboxdevice.h"
#include "library/rekordbox/rekordboxruntimetrackmodel.h"
#include "library/rekordbox/rekordboxusbsession.h"
#include "library/treeitemmodel.h"
#include "util/parented_ptr.h"
#include "util/sandbox.h"

class RekordboxFeature final : public LibraryFeature {
    Q_OBJECT

  public:
    RekordboxFeature(Library* pLibrary, UserSettingsPointer pConfig);
    ~RekordboxFeature() override;

    QVariant title() override;
    static bool isSupported();
    void bindLibraryWidget(WLibrary* libraryWidget,
            KeyboardEventFilter* keyboard) override;
    TreeItemModel* sidebarModel() const override;
    std::shared_ptr<const mixxx::rekordbox::RuntimeCatalog> catalogForRoot(
            const QString& root) const;
    std::optional<mixxx::rekordbox::RuntimeTrack> infoForLocation(const QString& location,QString* root) const;
    TrackPointer temporaryTrackForRoot(const QString& root,quint32 id,QString* error=nullptr) const {
        const auto session=m_sessions.value(root);return session?session->createTemporaryTrack(id,error):TrackPointer();
    }
    QString sessionIdentityForRoot(const QString& root) const {
        const auto session=m_sessions.value(root);const auto state=session?session->sessionState():nullptr;
        return state?state->identifier().uuid().toString():QString();
    }
    void saveList(const QString& root, const QString& name, const QList<quint32>& ids, bool history, std::function<void(QString)> finished);
    void savePerformance(const QString& root, TrackPointer track, std::function<void(QString)> finished);
    void writeRating(const QString& root,quint32 id,int rating,std::function<void(QString)> finished);
    bool showTrackIds(const QString& root,
            const QList<quint32>& ids,
            const QString& viewKey);

  public slots:
    void activate() override;
    void activateChild(const QModelIndex& index) override;
    void refreshLibraryModels();
    void onRekordboxDevicesFound();
    void onTracksFound();

  private:
    int m_pendingRatingWrites=0;
    bool m_discoveryOverlappedWrite=false;
    void checkMountedVolumes();
    void startDiscovery();
    void enqueueLoad(const QString& root);
    void startNextLoad();
    void setDeviceStatus(const QString& root, const QString& status,
            int songs = -1, int playlists = -1);
    void authorizeVolume(const QString& root);

    parented_ptr<TreeItemModel> m_pSidebarModel;
    mixxx::rekordbox::RekordboxRuntimeTrackModel m_runtimeTrackModel;
    ProxyTrackModel m_proxyTrackModel;

    QFutureWatcher<QList<mixxx::rekordbox::DiscoveredDevice>> m_devicesFutureWatcher;
    QFuture<QList<mixxx::rekordbox::DiscoveredDevice>> m_devicesFuture;
    QFutureWatcher<std::shared_ptr<mixxx::rekordbox::RekordboxUsbSession>>
            m_tracksFutureWatcher;
    QFuture<std::shared_ptr<mixxx::rekordbox::RekordboxUsbSession>> m_tracksFuture;
    QHash<QString, mixxx::rekordbox::DeviceSnapshot> m_devices;
    QHash<QString, std::shared_ptr<mixxx::rekordbox::RekordboxUsbSession>> m_sessions;
    QStringList m_pendingRoots;
    QSet<QString> m_queuedRoots;
    QHash<QString, quint64> m_generations;
    QHash<QString, int> m_loadAttempts;
    QSet<QString> m_askedVolumes;
    QStringList m_mountedRoots;
    QTimer m_mountTimer;
    std::shared_ptr<mixxx::rekordbox::RekordboxUsbSession> m_loadingSession;
    QString m_loadingRoot;
    QString m_selectedRoot;
    quint64 m_loadingGeneration{0};
    bool m_discoveryPending{false};
    bool m_parsePending{false};
    bool m_refreshRequested{false};
    bool m_authorizationPending{false};
    bool m_initialMountScanDone{false};
    QString m_title;

    // Keep security-scoped bookmarks active while metadata and audio are read
    // from a removable volume on sandboxed macOS.
    QHash<QString, SecurityTokenPointer> m_rekordboxSecurityTokens;
};
