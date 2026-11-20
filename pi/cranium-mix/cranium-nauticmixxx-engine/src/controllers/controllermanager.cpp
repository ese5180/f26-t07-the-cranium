#include "controllers/controllermanager.h"

#include <QSet>
#include <QThread>
#include <QDomDocument>
#include <QFile>

#include "controllers/controller.h"
#include "controllers/controllerlearningeventfilter.h"
#include "controllers/controllermappinginfo.h"
#include "controllers/controllermappinginfoenumerator.h"
#include "controllers/defs_controllers.h"
#include "moc_controllermanager.cpp"
#include "util/cmdlineargs.h"
#include "util/compatibility/qmutex.h"
#include "util/duration.h"
#include "util/thread_affinity.h"
#include "util/time.h"

#ifdef __PORTMIDI__
#include "controllers/midi/portmidienumerator.h"
#include "controllers/midi/portmidicontroller.h"
#endif

#ifdef __HSS1394__
#include "controllers/midi/hss1394enumerator.h"
#endif

#ifdef __HID__
#include "controllers/hid/hidenumerator.h"
#endif

#ifdef __BULK__
#include "controllers/bulk/bulkenumerator.h"
#endif

// http://developer.qt.nokia.com/wiki/Threads_Events_QObjects

// Poll every 1ms (where possible) for good controller response
#ifdef __LINUX__
// Many Linux distros ship with the system tick set to 250Hz so 1ms timer
// reportedly causes CPU hosage. See Bug #990992 rryan 6/2012
const mixxx::Duration ControllerManager::kPollInterval = mixxx::Duration::fromMillis(5);
#else
const mixxx::Duration ControllerManager::kPollInterval = mixxx::Duration::fromMillis(1);
#endif

namespace {
/// Strip slashes and spaces from device name, so that it can be used as config
/// key or a filename.
QString sanitizeDeviceName(QString name) {
    return name.replace(" ", "_").replace("/", "_").replace("\\", "_");
}

constexpr auto kInpulse500Rx3Mapping =
        "Hercules_DJControl_Inpulse_500_RX3.midi.xml";

QString nauticRx3MappingForDevice(const QString& deviceName) {
    // Match the model inside the USB MIDI port name. Pioneer and Roland prepend
    // their vendor names on some platforms, so the XML id alone is insufficient.
    if (deviceName.contains(QStringLiteral("DJControl Inpulse 500"), Qt::CaseInsensitive)) {
        return QString::fromLatin1(kInpulse500Rx3Mapping);
    }
    struct ModelMapping {
        const char* model;
        const char* filename;
    };
    static constexpr ModelMapping mappings[] = {
            {"DDJ-SX3", "DDJ-SX3-Nautic-RX3.midi.xml"},
            {"DDJ-SX2", "DDJ-SX2-Nautic-RX3.midi.xml"},
            {"DDJ-SX", "DDJ-SX-Nautic-RX3.midi.xml"},
            {"DDJ-400", "DDJ-400-Nautic-RX3.midi.xml"},
            {"DDJ-WeGO3", "DDJ-WeGO3-Nautic-RX3.midi.xml"},
            {"DDJ-FLX4", "Pioneer-DDJ-FLX4-RX3.midi.xml"},
            {"DJ-505", "DJ-505-Nautic-RX3.midi.xml"},
    };
    for (const auto& mapping : mappings) {
        if (deviceName.contains(QString::fromLatin1(mapping.model), Qt::CaseInsensitive)) {
            return QString::fromLatin1(mapping.filename);
        }
    }
    return {};
}

bool mappingHasExactMidiId(const QString& path, const QString& deviceName) {
    QFile file(path);
    QDomDocument document;
    if (!file.open(QIODevice::ReadOnly) || !document.setContent(&file)) {
        return false;
    }
    const QString id = document.documentElement()
                               .firstChildElement(QStringLiteral("controller"))
                               .attribute(QStringLiteral("id"));
    return !id.isEmpty() && id.compare(deviceName, Qt::CaseInsensitive) == 0;
}

QFileInfo findMappingFile(const QString& pathOrFilename, const QStringList& paths) {
    QFileInfo fileInfo(pathOrFilename);
    if (fileInfo.isAbsolute()) {
        return fileInfo;
    }

    for (const QString& path : paths) {
        fileInfo = QFileInfo(QDir(path).absoluteFilePath(pathOrFilename));
        if (fileInfo.exists()) {
            return fileInfo;
        }
    }

    return QFileInfo();
}

// Legacy code referred to mappings as "presets", so "[ControllerPreset]" must be
// kept for backwards compatibility.
const QString kSettingsGroup = QLatin1String("[ControllerPreset]");

} // anonymous namespace

QString firstAvailableFilename(QSet<QString>& filenames,
        const QString& originalFilename) {
    QString filename = originalFilename;
    int i = 1;
    while (filenames.contains(filename)) {
        i++;
        filename = QString("%1--%2").arg(originalFilename, QString::number(i));
    }
    filenames.insert(filename);
    return filename;
}

bool controllerCompare(Controller *a,Controller *b) {
    return a->getName() < b->getName();
}

ControllerManager::ControllerManager(UserSettingsPointer pConfig)
        : QObject(),
          m_pConfig(pConfig),
          // WARNING: Do not parent m_pControllerLearningEventFilter to
          // ControllerManager because the CM is moved to its own thread and runs
          // its own event loop.
          m_pControllerLearningEventFilter(new ControllerLearningEventFilter()),
          m_pollTimer(this),
          m_discoveryTimer(this),
          m_skipPoll(false) {
    qRegisterMetaType<std::shared_ptr<LegacyControllerMapping>>(
            "std::shared_ptr<LegacyControllerMapping>");

    // Create controller mapping paths in the user's home directory.
    QString userMappings = userMappingsPath(m_pConfig);
    if (!QDir(userMappings).exists()) {
        qDebug() << "Creating user controller mappings directory:" << userMappings;
        QDir().mkpath(userMappings);
    }

    m_pollTimer.setInterval(kPollInterval.toIntegerMillis());
    connect(&m_pollTimer, &QTimer::timeout, this, &ControllerManager::slotPollDevices);
    m_discoveryTimer.setInterval(1000);
    connect(this, &ControllerManager::requestCraniumRefresh, this, &ControllerManager::slotDiscoverFirstController);
    connect(this, &ControllerManager::requestCraniumControllerEnabled, this, &ControllerManager::slotSetCraniumControllerEnabled);

    connect(&m_discoveryTimer, &QTimer::timeout,
            this, &ControllerManager::slotDiscoverFirstController);

    m_pThread = new QThread;
    m_pThread->setObjectName("Controller");

    // Moves all children (including the poll timer) to m_pThread
    moveToThread(m_pThread);

    // Controller processing needs to be prioritized since it can affect the
    // audio directly, like when scratching
    m_pThread->start(QThread::HighPriority);

    connect(this, &ControllerManager::requestInitialize, this, &ControllerManager::slotInitialize);
    connect(this,
            &ControllerManager::requestSetUpDevices,
            this,
            &ControllerManager::slotSetUpDevices);
    connect(this, &ControllerManager::requestShutdown, this, &ControllerManager::slotShutdown);

    // Signal that we should run slotInitialize once our event loop has started
    // up.
    emit requestInitialize(); // clazy:exclude=incorrect-emit
}

ControllerManager::~ControllerManager() {
    emit requestShutdown();
    m_pThread->wait();
    delete m_pThread;
    delete m_pControllerLearningEventFilter;
}

ControllerLearningEventFilter* ControllerManager::getControllerLearningEventFilter() const {
    return m_pControllerLearningEventFilter;
}

void ControllerManager::slotInitialize() {
    qDebug() << "ControllerManager:slotInitialize";

    // Initialize mapping info parsers. This object is only for use in the main
    // thread. Do not touch it from within ControllerManager.
    m_pMainThreadUserMappingEnumerator = QSharedPointer<MappingInfoEnumerator>(
            new MappingInfoEnumerator(userMappingsPath(m_pConfig)));
    m_pMainThreadSystemMappingEnumerator = QSharedPointer<MappingInfoEnumerator>(
            new MappingInfoEnumerator(resourceMappingsPath(m_pConfig)));

    // Instantiate all enumerators. Enumerators can take a long time to
    // construct since they interact with host MIDI APIs.
#ifdef __PORTMIDI__
    m_enumerators.append(new PortMidiEnumerator());
#endif
#ifdef __HSS1394__
    m_enumerators.append(new Hss1394Enumerator(m_pConfig));
#endif
#ifdef __BULK__
    m_enumerators.append(new BulkEnumerator(m_pConfig));
#endif
#ifdef __HID__
    m_enumerators.append(new HidEnumerator());
#endif
    m_discoveryTimer.start();
}

void ControllerManager::slotShutdown() {
    stopPolling();
    m_discoveryTimer.stop();

    // Clear m_enumerators before deleting the enumerators to prevent other code
    // paths from accessing them.
    auto locker = lockMutex(&m_mutex);
    QList<ControllerEnumerator*> enumerators = m_enumerators;
    m_enumerators.clear();
    // Enumerators own the devices. Do not expose their dead pointers to a
    // deferred preferences-window deletion after shutdown.
    m_controllers.clear();
    locker.unlock();

    // Delete enumerators and they'll delete their Devices
    for (ControllerEnumerator* pEnumerator : enumerators) {
        delete pEnumerator;
    }

    // Stop the processor after the enumerators since the engines live in it
    m_pThread->quit();
}

void ControllerManager::slotDiscoverFirstController() {
#if defined(__LINUX__) && defined(__PORTMIDI__)
    for (auto* enumerator : std::as_const(m_enumerators)) {
        auto* midi = qobject_cast<PortMidiEnumerator*>(enumerator);
        if (!midi || !midi->needsRefresh()) continue;
        // Refresh only MIDI. Other backends may delete objects during a query.
        // PortMidi keeps detached objects alive for queued UI calls and reuses
        // them on reconnect, avoiding dangling preferences/learning pointers.
        const auto devices = midi->queryDevices();
        bool hadMidiDevices = false;
        {
            const auto locker = lockMutex(&m_mutex);
            for (auto i = m_controllers.begin(); i != m_controllers.end();) {
                if (qobject_cast<PortMidiController*>(*i)) {
                    hadMidiDevices = true;
                    i = m_controllers.erase(i);
                } else ++i;
            }
            m_controllers.append(devices);
        }
        const auto paths = getMappingPaths(m_pConfig);
        for (auto* device : devices) setUpController(device, paths);
        pollIfAnyControllersOpen();
        if (hadMidiDevices || !devices.isEmpty()) emit devicesChanged();
    }
#else
    if (getControllers().isEmpty()) slotSetUpDevices();
#endif
    updateCraniumStatus();
}

QVariantList ControllerManager::craniumControllerStatus() const {
    const auto locker = lockMutex(&m_mutex);
    return m_craniumStatus;
}

void ControllerManager::updateCraniumStatus() {
    QVariantList status;
    for (auto* controller : getControllers()) {
        if (!controller->isInputDevice()) continue;
        const auto mapping = controller->getMapping();
        const QString filename = mapping ? QFileInfo(mapping->filePath()).fileName() : QString();
        QString label = filename;
        if (filename == "Pioneer-DDJ-FLX4-RX3.midi.xml") label = "Cranium FLX4 mapping";
        else label.replace("NauticMixxx", "Cranium").replace("Nautic", "Cranium");
        status << QVariantMap{{"name", controller->getName()}, {"enabled", controller->isOpen()},
                {"output", controller->isOutputDevice()}, {"mapping", label}};
    }
    const auto locker = lockMutex(&m_mutex);
    m_craniumStatus = status;
}

void ControllerManager::slotSetCraniumControllerEnabled(QString name, bool enabled) {
    for (auto* controller : getControllers()) {
        if (controller->getName() != name) continue;
        if (enabled) setUpController(controller, getMappingPaths(m_pConfig));
        else closeController(controller);
        pollIfAnyControllersOpen();
        updateCraniumStatus();
        m_pConfig->save();
        break;
    }
}

void ControllerManager::updateControllerList() {
    // Initial scan of every backend. Linux runtime refreshes only PortMidi,
    // which retains Controller objects until shutdown for preference UI safety.
    auto locker = lockMutex(&m_mutex);
    if (m_enumerators.isEmpty()) {
        qWarning() << "updateControllerList called but no enumerators have been added!";
        return;
    }
    QList<ControllerEnumerator*> enumerators = m_enumerators;
    locker.unlock();

    QList<Controller*> newDeviceList;
    for (ControllerEnumerator* pEnumerator : enumerators) {
        newDeviceList.append(pEnumerator->queryDevices());
    }

    locker.relock();
    if (newDeviceList != m_controllers) {
        m_controllers = newDeviceList;
        locker.unlock();
        emit devicesChanged();
    }
}

QList<Controller*> ControllerManager::getControllers() const {
    const auto locker = lockMutex(&m_mutex);
    return m_controllers;
}

QList<Controller*> ControllerManager::getControllerList(bool bOutputDevices, bool bInputDevices) {
    qDebug() << "ControllerManager::getControllerList";

    auto locker = lockMutex(&m_mutex);
    QList<Controller*> controllers = m_controllers;
    locker.unlock();

    // Create a list of controllers filtered to match the given input/output
    // options.
    QList<Controller*> filteredDeviceList;

    for (Controller* device : controllers) {
        if ((bOutputDevices == device->isOutputDevice()) ||
            (bInputDevices == device->isInputDevice())) {
            filteredDeviceList.push_back(device);
        }
    }
    return filteredDeviceList;
}

QString ControllerManager::getConfiguredMappingFileForDevice(const QString& name) {
    return m_pConfig->getValueString(ConfigKey(kSettingsGroup, sanitizeDeviceName(name)));
}

void ControllerManager::slotSetUpDevices() {
    qDebug() << "ControllerManager: Setting up devices";

    updateControllerList();
    const QList<Controller*> deviceList = getControllerList(false, true);
    QStringList mappingPaths(getMappingPaths(m_pConfig));

    for (Controller* controller : deviceList) {
        setUpController(controller, mappingPaths);
    }

    pollIfAnyControllersOpen();
    updateCraniumStatus();
}

void ControllerManager::setUpController(Controller* pController, const QStringList& mappingPaths) {
    QString name = pController->getName();

    if (pController->isOpen()) {
        pController->close();
    }

    // The filename for this device name.
    QString deviceName = sanitizeDeviceName(name);

    QString automaticMapping;
    const QString rx3Mapping = nauticRx3MappingForDevice(name);
    const bool isInpulse500 =
            rx3Mapping == QString::fromLatin1(kInpulse500Rx3Mapping);
    if (!rx3Mapping.isEmpty()) {
        QFileInfo customMapping = findMappingFile(rx3Mapping, mappingPaths);
        if (customMapping.exists()) {
            automaticMapping = customMapping.absoluteFilePath();
        }
    }
    if (automaticMapping.isEmpty() && !isInpulse500) {
        for (const QString& path : mappingPaths) {
            const QDir mappingDir(path);
            for (const QString& fileName : mappingDir.entryList(
                         {QStringLiteral("*.midi.xml"),
                                 QStringLiteral("*.hid.xml"),
                                 QStringLiteral("*.bulk.xml")},
                         QDir::Files, QDir::Name)) {
                const QFileInfo candidate(mappingDir.filePath(fileName));
                const MappingInfo info(candidate.absoluteFilePath());
                if (info.isValid() &&
                        (pController->matchMapping(info) ||
                                (fileName.endsWith(QStringLiteral(".midi.xml")) &&
                                        mappingHasExactMidiId(
                                                candidate.absoluteFilePath(), name)))) {
                    automaticMapping = candidate.absoluteFilePath();
                    break;
                }
            }
            if (!automaticMapping.isEmpty()) {
                break;
            }
        }
    }
    if (!automaticMapping.isEmpty()) {
        m_pConfig->setValue(ConfigKey(kSettingsGroup, deviceName), automaticMapping);
        m_pConfig->setValue(ConfigKey("[Controller]", deviceName), 1);
    } else if (isInpulse500) {
        qWarning() << "NauticMixxx RX3 mapping for Inpulse 500 is missing";
        return;
    }

    // Check if device is enabled
    if (!m_pConfig->getValue(ConfigKey("[Controller]", deviceName), 0)) {
        return;
    }

    // Check if device has a configured mapping
    QString mappingFilePath = getConfiguredMappingFileForDevice(deviceName);
    if (mappingFilePath.isEmpty()) {
        return;
    }

    qDebug() << "Searching for controller mapping" << mappingFilePath
             << "in paths:" << mappingPaths.join(",");
    QFileInfo mappingFile = findMappingFile(mappingFilePath, mappingPaths);
    if (!mappingFile.exists()) {
        qDebug() << "Could not find" << mappingFilePath << "in any mapping path.";
        return;
    }

    std::shared_ptr<LegacyControllerMapping> pMapping =
            LegacyControllerMappingFileHandler::loadMapping(
                    mappingFile, resourceMappingsPath(m_pConfig));

    if (!pMapping) {
        return;
    }
    pMapping->loadSettings(m_pConfig, pController->getName());

    // This runs on the main thread but LegacyControllerMapping is not thread safe, so clone it.
    pController->setMapping(std::move(pMapping));

    // If we are in safe mode, skip opening controllers.
    if (CmdlineArgs::Instance().getSafeMode()) {
        qDebug() << "We are in safe mode -- skipping opening controller.";
        return;
    }

    qDebug() << "Opening controller:" << name;

    int value = pController->open();
    if (value != 0) {
        qWarning() << "There was a problem opening" << name;
        return;
    }
}

void ControllerManager::pollIfAnyControllersOpen() {
    auto locker = lockMutex(&m_mutex);
    QList<Controller*> controllers = m_controllers;
    locker.unlock();

    bool shouldPoll = false;
    for (Controller* pController : controllers) {
        if (pController->isOpen() && pController->isPolling()) {
            shouldPoll = true;
        }
    }
    if (shouldPoll) {
        startPolling();
    } else {
        stopPolling();
    }
}

void ControllerManager::startPolling() {
    // Start the polling timer.
    if (!m_pollTimer.isActive()) {
        m_pollTimer.start();
        qDebug() << "Controller polling started.";
    }
}

void ControllerManager::stopPolling() {
    m_pollTimer.stop();
    qDebug() << "Controller polling stopped.";
}

void ControllerManager::slotPollDevices() {
    // Note: this function is called from a high priority thread which
    // may stall the GUI or may reduce the available CPU time for other
    // High Priority threads like caching reader or broadcasting more
    // then desired, if it is called endless loop like.
    //
    // This especially happens if a controller like the 3x Speed
    // Stanton SCS.1D emits more massages than Mixxx is able to handle
    // or a controller like Hercules RMX2 goes wild. In such a case the
    // receive buffer is stacked up every call to insane values > 500 messages.
    //
    // To avoid this we pick here a strategies similar like the audio
    // thread. In case pollDevice() takes longer than a call cycle
    // we are cooperative a skip the next cycle to free at least some
    // CPU time
    //
    // Some random test data form a i5-3317U CPU @ 1.70GHz Running
    // Ubuntu Trusty:
    // * Idle poll: ~5 µs.
    // * 5 messages burst (full midi bandwidth): ~872 µs.

    if (m_skipPoll) {
        // skip poll in overload situation
        m_skipPoll = false;
        //qDebug() << "ControllerManager::pollDevices() skip";
        return;
    }

    mixxx::Duration start = mixxx::Time::elapsed();
    for (Controller* pDevice : std::as_const(m_controllers)) {
        if (pDevice->isOpen() && pDevice->isPolling()) {
            pDevice->poll();
        }
    }

    mixxx::Duration duration = mixxx::Time::elapsed() - start;
    if (duration > kPollInterval) {
        m_skipPoll = true;
    }
    //qDebug() << "ControllerManager::pollDevices()" << duration << start;
}

void ControllerManager::openController(Controller* pController) {
    DEBUG_ASSERT_QOBJECT_THREAD_AFFINITY(this);
    if (!pController) {
        return;
    }
    if (pController->isOpen()) {
        pController->close();
    }
    int result = pController->open();
    pollIfAnyControllersOpen();

    // If successfully opened the device, apply the mapping and save the
    // preference setting.
    if (result == 0) {
        // Update configuration to reflect controller is enabled.
        m_pConfig->setValue(
                ConfigKey("[Controller]", sanitizeDeviceName(pController->getName())), 1);
    }
}

void ControllerManager::closeController(Controller* pController) {
    DEBUG_ASSERT_QOBJECT_THREAD_AFFINITY(this);
    if (!pController) {
        return;
    }
    pController->close();
    pollIfAnyControllersOpen();
    // Update configuration to reflect controller is disabled.
    m_pConfig->setValue(
            ConfigKey("[Controller]", sanitizeDeviceName(pController->getName())), 0);
}

void ControllerManager::slotApplyMapping(Controller* pController,
        std::shared_ptr<LegacyControllerMapping> pMapping,
        bool bEnabled) {
    VERIFY_OR_DEBUG_ASSERT(pController) {
        qWarning() << "slotApplyMapping got invalid controller!";
        return;
    }
    if (!getControllers().contains(pController)) {
        qWarning() << "Ignoring mapping Apply for a disconnected controller";
        return;
    }

    closeController(pController);
    ConfigKey key(kSettingsGroup, sanitizeDeviceName(pController->getName()));
    if (!pMapping) {
        // Unset the controller mapping for this controller
        pController->setMapping(nullptr);
        m_pConfig->remove(key);
        emit mappingApplied(false);
        return;
    }

    VERIFY_OR_DEBUG_ASSERT(!pMapping->isDirty()) {
        qWarning() << "Mapping is dirty, changes might be lost on restart!";
    }


    // Save the file path/name in the config so it can be auto-loaded at
    // startup next time
    m_pConfig->set(key, pMapping->filePath());

    pController->setMapping(std::move(pMapping));

    if (bEnabled) {
        openController(pController);
        emit mappingApplied(pController->isMappable());
    } else {
        emit mappingApplied(false);
    }
}

// static
QList<QString> ControllerManager::getMappingPaths(UserSettingsPointer pConfig) {
    QList<QString> scriptPaths;
    scriptPaths.append(userMappingsPath(pConfig));
    scriptPaths.append(resourceMappingsPath(pConfig));
    return scriptPaths;
}
