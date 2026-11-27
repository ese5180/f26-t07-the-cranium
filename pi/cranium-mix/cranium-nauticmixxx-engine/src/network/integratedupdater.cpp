#include "network/integratedupdater.h"

#include <QJsonDocument>
#include <QJsonObject>

#include "network/startupupdatechecker.h"
#include "moc_integratedupdater.cpp"

namespace nautic {
IntegratedUpdater::IntegratedUpdater(QString currentVersion, std::function<bool()> busy,
        std::function<void()> closeApplication, QObject* parent)
        : QObject(parent), m_currentVersion(std::move(currentVersion)),
          m_closeApplication(std::move(closeApplication)), m_busy(std::move(busy)) {
}

void IntegratedUpdater::begin(const QString& version, Mode mode) {
    if (m_state != State::Idle && m_state != State::Failed) {
        return;
    }
    const auto metadata = QJsonDocument(QJsonObject{
            {"tag_name", QStringLiteral("v%1").arg(version)}, {"draft", false}, {"prerelease", false}}).toJson();
    if (!StartupUpdateChecker::parseRelease(metadata, m_currentVersion, "")) {
        report(State::Failed, tr("The update version is invalid or is not newer."));
        return;
    }
    m_version = version;
    m_mode = mode;
    report(State::Checking, tr("Checking the signed update…"));
    startDownload();
}

void IntegratedUpdater::report(State state, const QString& message) {
    m_state = state;
    m_message = message;
    emit changed(state, message);
}

void IntegratedUpdater::progress(qint64 received, qint64 total) {
    emit downloadProgress(received, total);
}

void IntegratedUpdater::ready() {
    report(State::Ready, tr("Update ready. It will be installed when NauticMixxx closes."));
    if (m_mode == Mode::InstallNow) {
        installNow();
    }
}

void IntegratedUpdater::installNow() {
    if (m_state != State::Ready) {
        return;
    }
    if (isBusy()) {
        report(State::Ready, tr("Stop playback and Auto DJ before installing. Your update is ready."));
        return;
    }
    installAndRelaunch();
}

bool IntegratedUpdater::prepareQuit() {
    return m_state != State::Ready || armInstallOnQuit();
}

#if !defined(Q_OS_MACOS) && !defined(Q_OS_WIN)
IntegratedUpdater* createIntegratedUpdater(const QString&, const QString&,
        std::function<bool()>, std::function<void()>, QObject*) {
    return nullptr;
}
#endif
} // namespace nautic
