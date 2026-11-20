#include "library/rekordbox/rekordboxperformancewriter.h"
#include "library/rekordbox/rekordboxfeature.h"

#include <algorithm>
#include <utility>

#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QGuiApplication>
#include <QMessageBox>
#include <QSet>
#include <QStorageInfo>
#include <QThread>
#include <QTimer>
#include <QVariant>
#include <QtConcurrentRun>

#include "library/dao/settingsdao.h"
#include "library/library.h"
#include "library/trackcollection.h"
#include "library/trackcollectionmanager.h"
#include "library/treeitem.h"
#include "mixer/playerinfo.h"
#include "track/track.h"
#include "moc_rekordboxfeature.cpp"
#include "util/sandbox.h"
#include "widget/wlibrary.h"

namespace {

const QString kDeviceItem = QStringLiteral("rekordbox-device");
const QString kAllTracksItem = QStringLiteral("rekordbox-runtime-all");
const QString kPlaylistItem = QStringLiteral("rekordbox-runtime-playlist");
const QString kAuthorizedUsbRootsSettingsKey =
        QStringLiteral("mixxx.rekordboxfeature.sandboxed_usb_roots");
const QString kStatusPreparing = QStringLiteral("preparing");
const QString kStatusReady = QStringLiteral("ready");
const QString kStatusError = QStringLiteral("error");

QString findRekordboxPdbPath(const QString& devicePath) {
    return mixxx::rekordbox::databasePath(devicePath);
}

QString rekordboxDeviceRootFromSelection(const QString& selectedPath) {
    QDir candidate(selectedPath);
    for (int level = 0; level < 3; ++level) {
        if (!findRekordboxPdbPath(candidate.absolutePath()).isEmpty()) {
            return candidate.absolutePath();
        }
        if (!candidate.cdUp()) {
            break;
        }
    }
    return {};
}

// Discovery performs bounded, read-only fingerprinting off the GUI thread.
QList<mixxx::rekordbox::DiscoveredDevice> findRekordboxDevices(
        const QStringList& manuallyAuthorizedDevicePaths) {
    QThread::currentThread()->setPriority(QThread::LowPriority);
    QFileInfoList devices;
#if defined(__WINDOWS__)
    devices = QDir::drives();
#elif defined(__LINUX__)
    for (const auto& base : QStringList{QStringLiteral("/media"),
                 QStringLiteral("/media/") + QString::fromLocal8Bit(qgetenv("USER")),
                 QStringLiteral("/run/media/") + QString::fromLocal8Bit(qgetenv("USER"))}) {
        devices += QDir(base).entryInfoList(QDir::AllDirs | QDir::NoDotAndDotDot);
    }
#elif !defined(Q_OS_MACOS)
    devices = QDir(QStringLiteral("/Volumes")).entryInfoList(
            QDir::AllDirs | QDir::NoDotAndDotDot);
#endif
    for (const auto& path : manuallyAuthorizedDevicePaths) {
        devices.append(QFileInfo(path));
    }

    QList<mixxx::rekordbox::DiscoveredDevice> found;
    QSet<QString> seen;
    for (const auto& device : std::as_const(devices)) {
        if (findRekordboxPdbPath(device.absoluteFilePath()).isEmpty()) {
            continue;
        }
        auto snapshot = mixxx::rekordbox::inspectDevice(device.absoluteFilePath());
        if (snapshot.root.isEmpty() || seen.contains(snapshot.root)) {
            continue;
        }
        seen.insert(snapshot.root);
        if (snapshot.state != mixxx::rekordbox::DeviceState::Readable) {
            qWarning() << "Cannot read Rekordbox source" << device.absoluteFilePath()
                       << snapshot.error;
        }
        const auto label = device.fileName().isEmpty()
                ? device.absoluteFilePath()
                : device.fileName();
        found.append({label, std::move(snapshot)});
    }
    return found;
}

std::unique_ptr<TreeItem> makeRuntimePlaylistItem(
        const QString& root,
        const mixxx::rekordbox::RuntimePlaylistNode& node) {
    auto item = std::make_unique<TreeItem>(node.name,
            QVariant(QVariantList{root,
                    kPlaylistItem,
                    static_cast<qulonglong>(node.rekordboxId)}));
    for (const auto& child : node.children) {
        item->insertChild(item->childRows(),
                makeRuntimePlaylistItem(root, child));
    }
    return item;
}

int countPlaylists(const QList<mixxx::rekordbox::RuntimePlaylistNode>& nodes) {
    int count = 0;
    for (const auto& node : nodes) {
        count += node.isFolder ? 0 : 1;
        count += countPlaylists(node.children);
    }
    return count;
}

} // namespace

RekordboxFeature::RekordboxFeature(
        Library* pLibrary,
        UserSettingsPointer pConfig)
        : LibraryFeature(pLibrary, pConfig, QStringLiteral("rekordbox")),
          m_pSidebarModel(make_parented<TreeItemModel>(this)),
          m_runtimeTrackModel(this, pLibrary->trackCollectionManager()),
          m_proxyTrackModel(&m_runtimeTrackModel, true),
          m_title(tr("Rekordbox")) {
    connect(&m_devicesFutureWatcher,
            &QFutureWatcher<QList<mixxx::rekordbox::DiscoveredDevice>>::finished,
            this,
            &RekordboxFeature::onRekordboxDevicesFound);
    connect(&m_tracksFutureWatcher,
            &QFutureWatcher<std::shared_ptr<mixxx::rekordbox::RekordboxUsbSession>>::finished,
            this,
            &RekordboxFeature::onTracksFound);
    m_pSidebarModel->setRootItem(TreeItem::newRoot(this));
    m_mountTimer.setInterval(2000);
    connect(&m_mountTimer, &QTimer::timeout, this, &RekordboxFeature::checkMountedVolumes);
    if (auto* app = qobject_cast<QGuiApplication*>(QCoreApplication::instance())) {
        connect(app, &QGuiApplication::applicationStateChanged, this,
                [this](Qt::ApplicationState state) {
                    if (state == Qt::ApplicationActive) {
                        checkMountedVolumes();
                        startDiscovery();
                    }
                });
    }
    QTimer::singleShot(0, this, [this] {
        checkMountedVolumes();
        m_mountTimer.start();
    });
}

RekordboxFeature::~RekordboxFeature() {
    m_mountTimer.stop();
    if (m_loadingSession) {
        m_loadingSession->invalidate();
    }
    try {
        m_devicesFuture.waitForFinished();
    } catch (...) {
        qWarning() << "Rekordbox discovery failed during shutdown";
    }
    try {
        m_tracksFuture.waitForFinished();
    } catch (...) {
        qWarning() << "Rekordbox session load failed during shutdown";
    }
    for (const auto& session : std::as_const(m_sessions)) {
        session->invalidate();
    }
    m_runtimeTrackModel.clearSession();
}

void RekordboxFeature::bindLibraryWidget(
        WLibrary* pLibraryWidget,
        KeyboardEventFilter* keyboard) {
    Q_UNUSED(pLibraryWidget);
    Q_UNUSED(keyboard);
}

QVariant RekordboxFeature::title() {
    return m_title;
}

bool RekordboxFeature::isSupported() {
    return true;
}

TreeItemModel* RekordboxFeature::sidebarModel() const {
    return m_pSidebarModel;
}

void RekordboxFeature::refreshLibraryModels() {
    startDiscovery();
}

void RekordboxFeature::activate() {
    startDiscovery();
}

void RekordboxFeature::checkMountedVolumes() {
    QStringList roots;
    for (const auto& volume : QStorageInfo::mountedVolumes()) {
        if (!volume.isValid() || !volume.isReady()) {
            continue;
        }
#if defined(Q_OS_MACOS)
        if (!volume.rootPath().startsWith(QStringLiteral("/Volumes/"))) {
            continue;
        }
#endif
        roots.append(QDir::cleanPath(volume.rootPath()));
    }
    roots.removeDuplicates();
    roots.sort();
    const bool firstScan = !std::exchange(m_initialMountScanDone, true);
    if (roots != m_mountedRoots) {
        const auto previous = m_mountedRoots;
        m_mountedRoots = roots;
        for (const auto& removed : previous) {
            if (!roots.contains(removed)) {
                m_askedVolumes.remove(removed);
                ++m_generations[removed];
                m_rekordboxSecurityTokens.remove(removed);
                // Revoke immediately on unmount, before asynchronous discovery.
                // Both decks observe the shared atomic token in their callback.
                const auto session=m_sessions.value(removed);
                if(session) session->invalidate();
                if (m_loadingRoot == removed && m_loadingSession) {
                    m_loadingSession->invalidate();
                }
            }
        }
        startDiscovery();
        // A freshly mounted export may still be finishing its filesystem
        // registration when the first discovery starts.
        QTimer::singleShot(3000, this, &RekordboxFeature::startDiscovery);
#if defined(Q_OS_MACOS)
        SettingsDAO settings(
                m_pLibrary->trackCollectionManager()->internalCollection()->database());
        const auto savedRoots = settings.getValue(kAuthorizedUsbRootsSettingsKey)
                                        .split(QChar(';'), Qt::SkipEmptyParts);
        const bool knownVolumeMounted = std::any_of(roots.cbegin(), roots.cend(),
                [&](const QString& root) { return savedRoots.contains(root); });
        const bool promptOnFirstScan = firstScan && !knownVolumeMounted;
        for (const auto& added : roots) {
            if ((firstScan && !promptOnFirstScan) || previous.contains(added) ||
                    savedRoots.contains(added) ||
                    m_askedVolumes.contains(added) || m_authorizationPending) {
                continue;
            }
            m_askedVolumes.insert(added);
            m_authorizationPending = true;
            QTimer::singleShot(500, this, [this, added] {
                if (m_mountedRoots.contains(added)) {
                    authorizeVolume(added);
                }
                m_authorizationPending = false;
            });
            break;
        }
#endif
    }
}

void RekordboxFeature::startDiscovery() {
    if(m_pendingRatingWrites>0) {m_refreshRequested=true;return;}
    if (m_discoveryPending || m_parsePending) {
        m_refreshRequested = true;
        return;
    }
    QStringList manuallyAuthorizedDevicePaths;
    QString rootNeedingAccess;

#if defined(Q_OS_MACOS)
    // Opening an unapproved removable volume from a worker can block forever
    // in macOS privacy enforcement, even for an ad-hoc/non-sandbox build.
    // Enumerate only roots the user selected in a native file dialog. Sandboxed
    // builds additionally keep their security-scoped bookmarks alive.
    SettingsDAO settings(
            m_pLibrary->trackCollectionManager()->internalCollection()->database());
    const auto savedRoots = settings.getValue(kAuthorizedUsbRootsSettingsKey);
    const auto storedRoots = savedRoots.isEmpty()
            ? QStringList()
            : savedRoots.split(QChar(';'), Qt::SkipEmptyParts);

    for (const auto& storedRoot : storedRoots) {
        const QDir rootDir(storedRoot);
        if (!rootDir.exists()) {
            continue;
        }
        if (Sandbox::enabled() && !m_rekordboxSecurityTokens.contains(rootDir.absolutePath())) {
            auto token = Sandbox::openSecurityTokenForDir(rootDir, false);
            if (token.isNull()) {
                if (rootNeedingAccess.isEmpty() && !m_askedVolumes.contains(storedRoot)) {
                    rootNeedingAccess = storedRoot;
                }
                continue;
            }
            m_rekordboxSecurityTokens.insert(rootDir.absolutePath(), token);
        }
        manuallyAuthorizedDevicePaths.append(rootDir.absolutePath());
    }
#endif

    m_discoveryPending = true;
    m_devicesFuture = QtConcurrent::run(
            findRekordboxDevices, manuallyAuthorizedDevicePaths);
    m_devicesFutureWatcher.setFuture(m_devicesFuture);
#if defined(Q_OS_MACOS)
    if (!rootNeedingAccess.isEmpty() && !m_authorizationPending) {
        m_askedVolumes.insert(rootNeedingAccess);
        m_authorizationPending = true;
        QTimer::singleShot(0, this, [this, rootNeedingAccess] {
            authorizeVolume(rootNeedingAccess);
            m_authorizationPending = false;
        });
    }
#endif
}

void RekordboxFeature::authorizeVolume(const QString& root) {
#if defined(Q_OS_MACOS)
    const auto selectedPath = QFileDialog::getExistingDirectory(nullptr,
            tr("Allow access to a Rekordbox USB drive"), root,
            QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks);
    if (selectedPath.isEmpty()) {
        return;
    }
    const auto deviceRoot = rekordboxDeviceRootFromSelection(selectedPath);
    if (deviceRoot.isEmpty()) {
        QMessageBox::warning(nullptr, tr("Invalid Rekordbox USB drive"),
                tr("The selected folder does not contain PIONEER/rekordbox/export.pdb."));
        return;
    }
    if (Sandbox::enabled()) {
        auto token = Sandbox::openSecurityTokenForDir(QDir(deviceRoot), true);
        if (token.isNull()) {
            QMessageBox::warning(nullptr, tr("Could not authorize Rekordbox USB drive"),
                    tr("Read access to the selected drive could not be saved."));
            return;
        }
        m_rekordboxSecurityTokens.insert(deviceRoot, token);
    }
    SettingsDAO settings(
            m_pLibrary->trackCollectionManager()->internalCollection()->database());
    auto roots = settings.getValue(kAuthorizedUsbRootsSettingsKey)
                         .split(QChar(';'), Qt::SkipEmptyParts);
    if (!roots.contains(deviceRoot)) {
        roots.append(deviceRoot);
        settings.setValue(kAuthorizedUsbRootsSettingsKey, roots.join(QChar(';')));
    }
    startDiscovery();
#else
    Q_UNUSED(root);
#endif
}

void RekordboxFeature::activateChild(const QModelIndex& index) {
    if (!index.isValid()) {
        return;
    }
    auto* item = static_cast<TreeItem*>(index.internalPointer());
    if (!item || !item->getData().isValid()) {
        return;
    }
    const auto data = item->getData().toList();
    if (data.size() < 2) {
        return;
    }
    const auto root = data[0].toString();
    const auto kind = data[1].toString();

    if (kind == kDeviceItem) {
        m_selectedRoot = root;
        enqueueLoad(root);
        return;
    }

    m_selectedRoot = root;
    const auto session = m_sessions.value(root);
    if (!session ||
            session->state() != mixxx::rekordbox::UsbSessionState::Ready) {
        enqueueLoad(root);
        return;
    }
    // Existing cover-art workers retain only a path and cannot enforce the
    // removable-session capability after asynchronous dispatch.
    emit enableCoverArtDisplay(false);
    if (kind == kAllTracksItem) {
        m_runtimeTrackModel.showAllTracks(session);
        emit showTrackModel(&m_proxyTrackModel);
        return;
    }
    if (kind != kPlaylistItem || data.size() < 3) {
        return;
    }
    const auto playlistId = static_cast<quint32>(data[2].toULongLong());
    const auto catalog = session->catalog();
    const auto playlist = catalog
            ? catalog->findPlaylist(playlistId)
            : std::nullopt;
    if (!playlist) {
        return;
    }
    m_runtimeTrackModel.showPlaylist(
            session, playlist->trackIds, playlist->rekordboxId);
    emit showTrackModel(&m_proxyTrackModel);
}

std::shared_ptr<const mixxx::rekordbox::RuntimeCatalog>
RekordboxFeature::catalogForRoot(const QString& root) const {
    const auto session = m_sessions.value(root);
    return session && session->state() == mixxx::rekordbox::UsbSessionState::Ready
            ? session->catalog() : nullptr;
}

std::optional<mixxx::rekordbox::RuntimeTrack> RekordboxFeature::infoForLocation(
        const QString& location,QString* root) const {
    if(location.isEmpty()) return {};
    for(auto it=m_sessions.cbegin();it!=m_sessions.cend();++it) {
        const auto catalog=it.value()->catalog();
        if(!catalog || !catalog->valid()) continue;
        const auto tracks=catalog->tracks();
        for(const auto& track:tracks) if(track.resolvedAudioPath==location) {
            if(root) *root=it.key();return track;
        }
    }
    return {};
}

void RekordboxFeature::saveList(const QString& root, const QString& name, const QList<quint32>& ids, bool history, std::function<void(QString)> finished) {
    const auto session = m_sessions.value(root);
    if (!session) { finished("USB is unavailable."); return; }
    ++m_pendingRatingWrites; m_discoveryOverlappedWrite |= m_discoveryPending;
    auto* watcher = new QFutureWatcher<QString>(this);
    connect(watcher, &QFutureWatcher<QString>::finished, this, [this, watcher, root, session, finished, history, name] {
        const auto error = watcher->result(); watcher->deleteLater(); --m_pendingRatingWrites;
        if (error.isEmpty() && m_sessions.value(root) == session) m_devices[root] = session->deviceSnapshot();
        if(error.isEmpty() && !history && m_sessions.value(root)==session) {
            auto* tree=m_pSidebarModel->getRootItem();
            for(int row=0;row<tree->childRows();++row) if(tree->child(row)->getData().toList().value(0).toString()==root) {
                const auto playlists=session->catalog()->playlists();
                if(!playlists.isEmpty() && playlists.last().name==name) {
                    std::vector<std::unique_ptr<TreeItem>> children;children.push_back(makeRuntimePlaylistItem(root,playlists.last()));
                    m_pSidebarModel->insertTreeItemRows(std::move(children),tree->child(row)->childRows(),m_pSidebarModel->index(row,0));
                }
            }
        }
        finished(error);
        if (m_pendingRatingWrites == 0 && std::exchange(m_refreshRequested, false)) startDiscovery();
    });
    watcher->setFuture(QtConcurrent::run([session, name, ids, history] { return session->writeList(name, ids, history); }));
}

void RekordboxFeature::savePerformance(const QString& root, TrackPointer track, std::function<void(QString)> finished) {
    const auto session = m_sessions.value(root);
    if (!session) { finished("USB is unavailable."); return; }
    const auto original=session->catalog()->findTrack(track?track->getSourceBinding().rekordboxId():0);
    const auto edit = mixxx::rekordbox::capturePerformance(track,original?&*original:nullptr);
    if (!edit.error.isEmpty()) { finished(edit.error); return; }
    ++m_pendingRatingWrites; m_discoveryOverlappedWrite |= m_discoveryPending;
    auto* watcher = new QFutureWatcher<QString>(this);
    connect(watcher, &QFutureWatcher<QString>::finished, this, [this, watcher, finished] {
        const auto error = watcher->result(); watcher->deleteLater(); --m_pendingRatingWrites;
        finished(error);
        if (m_pendingRatingWrites == 0 && std::exchange(m_refreshRequested, false)) startDiscovery();
    });
    watcher->setFuture(QtConcurrent::run([session, edit] { return session->writePerformance(edit); }));
}

void RekordboxFeature::writeRating(const QString& root,quint32 id,int rating,
        std::function<void(QString)> finished) {
    const auto session=m_sessions.value(root);
    if(!session) {finished(QStringLiteral("USB is unavailable."));return;}
    ++m_pendingRatingWrites;
    m_discoveryOverlappedWrite|=m_discoveryPending;
    auto* watcher=new QFutureWatcher<QString>(this);
    connect(watcher,&QFutureWatcher<QString>::finished,this,[this,watcher,root,id,rating,finished,session]{
        const auto error=watcher->result();watcher->deleteLater();
        if(error.isEmpty() && m_sessions.value(root)==session && session->state()==mixxx::rekordbox::UsbSessionState::Ready) {
            m_devices[root]=session->deviceSnapshot();
            if(root==m_selectedRoot) m_runtimeTrackModel.refreshRating(id,rating);
            for(int deck=1;deck<=2;++deck) {
                auto track=PlayerInfo::instance().getTrackInfo(QString("[Channel%1]").arg(deck));
                QString trackRoot;
                const auto record=track?infoForLocation(track->getLocation(),&trackRoot):std::nullopt;
                if(record && trackRoot==root && record->rekordboxId==id) track->setRating(rating);
            }
        }
        --m_pendingRatingWrites;
        finished(error);
        if(m_pendingRatingWrites==0 && std::exchange(m_refreshRequested,false)) startDiscovery();
    });
    watcher->setFuture(QtConcurrent::run([session,id,rating]{return session->writeRating(id,rating);}));
}

bool RekordboxFeature::showTrackIds(const QString& root,
        const QList<quint32>& ids,
        const QString& viewKey) {
    const auto session = m_sessions.value(root);
    if (!session || session->state() != mixxx::rekordbox::UsbSessionState::Ready) {
        return false;
    }
    m_selectedRoot = root;
    emit enableCoverArtDisplay(false);
    m_proxyTrackModel.search(QString());
    m_runtimeTrackModel.showTrackIds(session, ids, viewKey);
    emit showTrackModel(&m_proxyTrackModel);
    return true;
}

void RekordboxFeature::setDeviceStatus(
        const QString& root, const QString& status, int songs, int playlists) {
    auto* treeRoot = m_pSidebarModel->getRootItem();
    for (int row = 0; row < treeRoot->childRows(); ++row) {
        auto* item = treeRoot->child(row);
        auto data = item->getData().toList();
        if (data.value(0).toString() != root) {
            continue;
        }
        while (data.size() < 5) {
            data.append(QVariant());
        }
        data[2] = status;
        data[3] = songs;
        data[4] = playlists;
        item->setData(data);
        m_pSidebarModel->triggerRepaint(m_pSidebarModel->index(row, 0));
        break;
    }
}

void RekordboxFeature::enqueueLoad(const QString& root) {
    if (!m_devices.contains(root) ||
            m_devices.value(root).state != mixxx::rekordbox::DeviceState::Readable ||
            m_sessions.contains(root) || m_queuedRoots.contains(root) ||
            (m_parsePending && m_loadingRoot == root)) {
        return;
    }
    m_queuedRoots.insert(root);
    m_pendingRoots.append(root);
    setDeviceStatus(root, kStatusPreparing);
    startNextLoad();
}

void RekordboxFeature::startNextLoad() {
    if (m_parsePending) {
        return;
    }
    while (!m_pendingRoots.isEmpty()) {
        const auto root = m_pendingRoots.takeFirst();
        m_queuedRoots.remove(root);
        if (!m_devices.contains(root) || m_sessions.contains(root)) {
            continue;
        }
        m_parsePending = true;
        m_loadingRoot = root;
        m_loadingGeneration = m_generations.value(root);
        m_loadingSession =
                std::make_shared<mixxx::rekordbox::RekordboxUsbSession>(root);
        const auto session = m_loadingSession;
        m_tracksFuture = QtConcurrent::run([session]() {
            QThread::currentThread()->setPriority(QThread::LowPriority);
            session->load();
            return session;
        });
        m_tracksFutureWatcher.setFuture(m_tracksFuture);
        return;
    }
}

void RekordboxFeature::onRekordboxDevicesFound() {
    m_discoveryPending = false;
    // A concurrent rating commit changes the expected fingerprint. Re-discover
    // after publication, instead of invalidating a still-connected USB session.
    if(m_pendingRatingWrites>0 || m_discoveryOverlappedWrite) {
        m_discoveryOverlappedWrite=false;m_refreshRequested=true;
        if(m_pendingRatingWrites==0) {m_refreshRequested=false;startDiscovery();}
        return;
    }
    QList<mixxx::rekordbox::DiscoveredDevice> found;
    try {
        found = m_devicesFuture.result();
    } catch (...) {
        qWarning() << "Failed to discover Rekordbox devices";
        if (std::exchange(m_refreshRequested, false)) {
            startDiscovery();
        }
        return;
    }

    auto* root = m_pSidebarModel->getRootItem();
    bool removedSession = false;
    for (int row = root->childRows() - 1; row >= 0; --row) {
        const auto path = root->child(row)->getData().toList().value(0).toString();
        const auto retained = std::find_if(found.cbegin(),
                found.cend(),
                [&](const auto& device) {
                    return device.snapshot.matches(m_devices.value(path));
                });
        if (retained != found.cend()) {
            continue;
        }
        ++m_generations[path];
        m_pendingRoots.removeAll(path);
        m_queuedRoots.remove(path);
        m_loadAttempts.remove(path);
        if (m_loadingRoot == path && m_loadingSession) {
            m_loadingSession->invalidate();
        }
        const auto session = m_sessions.take(path);
        if (session) {
            session->invalidate();
            removedSession |= m_selectedRoot == path;
        }
        m_devices.remove(path);
        if (std::none_of(found.cbegin(), found.cend(), [&](const auto& device) {
                    return device.snapshot.root == path;
                })) {
            m_rekordboxSecurityTokens.remove(path);
        }
        if (m_selectedRoot == path) {
            m_selectedRoot.clear();
        }
        m_pSidebarModel->removeRows(row, 1);
    }
    if (removedSession) {
        m_runtimeTrackModel.clearSession();
    }

    std::vector<std::unique_ptr<TreeItem>> additions;
    for (const auto& device : found) {
        if (m_devices.contains(device.snapshot.root)) {
            continue;
        }
        m_devices.insert(device.snapshot.root, device.snapshot);
        additions.push_back(std::make_unique<TreeItem>(device.label,
                QVariant(QVariantList{device.snapshot.root,
                        kDeviceItem,
                        device.snapshot.state == mixxx::rekordbox::DeviceState::Readable
                                ? kStatusPreparing
                                : kStatusError,
                        -1,
                        -1})));
    }
    if (!additions.empty()) {
        m_pSidebarModel->insertTreeItemRows(
                std::move(additions), root->childRows());
    }
    for (const auto& device : found) {
        if (device.snapshot.state == mixxx::rekordbox::DeviceState::Readable) {
            enqueueLoad(device.snapshot.root);
        }
    }
    if (std::exchange(m_refreshRequested, false)) {
        startDiscovery();
    }
}

void RekordboxFeature::onTracksFound() {
    m_parsePending = false;
    std::shared_ptr<mixxx::rekordbox::RekordboxUsbSession> session;
    try {
        session = m_tracksFuture.result();
    } catch (...) {
        qWarning() << "Rekordbox runtime session worker failed";
    }
    const auto rootPath = std::exchange(m_loadingRoot, QString());
    m_loadingSession.reset();
    const bool currentGeneration =
            m_generations.value(rootPath) == m_loadingGeneration;
    if (!session ||
            session->state() != mixxx::rekordbox::UsbSessionState::Ready ||
            !m_devices.contains(rootPath) || !currentGeneration) {
        qWarning() << "Failed to load Rekordbox runtime session:"
                   << (session ? session->error()
                               : QStringLiteral("worker returned no session"));
        if (currentGeneration && m_devices.contains(rootPath)) {
            const int attempts = ++m_loadAttempts[rootPath];
            const auto error = session ? session->errorCode()
                                       : mixxx::rekordbox::UsbSessionError::ChangedDevice;
            const bool transient = error == mixxx::rekordbox::UsbSessionError::MissingDevice ||
                    error == mixxx::rekordbox::UsbSessionError::UnreadableDevice ||
                    error == mixxx::rekordbox::UsbSessionError::IncompleteExport ||
                    error == mixxx::rekordbox::UsbSessionError::ChangedDevice;
            if (transient && attempts < 4) {
                const auto generation = m_loadingGeneration;
                QTimer::singleShot(1000 * (1 << (attempts - 1)), this,
                        [this, rootPath, generation] {
                            if (m_generations.value(rootPath) == generation) {
                                enqueueLoad(rootPath);
                            }
                        });
            } else {
                setDeviceStatus(rootPath, kStatusError);
            }
        }
    } else {
        m_loadAttempts.remove(rootPath);
        const auto previous = m_sessions.value(rootPath);
        if (previous && previous != session) {
            previous->invalidate();
        }
        m_sessions.insert(rootPath, session);
        const auto catalog = session->catalog();
        auto* root = m_pSidebarModel->getRootItem();
        for (int row = 0; row < root->childRows(); ++row) {
            auto* item = root->child(row);
            auto data = item->getData().toList();
            if (data.value(0).toString() != rootPath) {
                continue;
            }
            std::vector<std::unique_ptr<TreeItem>> children;
            for (const auto& node : catalog->playlists()) {
                children.push_back(makeRuntimePlaylistItem(rootPath, node));
            }
            if (!children.empty()) {
                m_pSidebarModel->insertTreeItemRows(std::move(children),
                        0,
                        m_pSidebarModel->index(row, 0));
            }
            data[1] = kAllTracksItem;
            item->setData(data);
            if (m_selectedRoot == rootPath) {
                m_runtimeTrackModel.showAllTracks(session);
                emit showTrackModel(&m_proxyTrackModel);
            }
            setDeviceStatus(rootPath, kStatusReady,
                    catalog->tracks().size(), countPlaylists(catalog->playlists()));
            break;
        }
    }
    startNextLoad();
    if (std::exchange(m_refreshRequested, false)) {
        startDiscovery();
    }
}
