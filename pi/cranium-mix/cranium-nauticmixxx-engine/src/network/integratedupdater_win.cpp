#include "network/integratedupdater.h"
#include "network/updatepayload.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFutureWatcher>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QProcess>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <QtConcurrent>

namespace nautic {
class WindowsUpdater final : public IntegratedUpdater {
  public:
    WindowsUpdater(QString currentVersion, QString profilePath, std::function<bool()> busy,
            std::function<void()> closeApplication, QObject* parent)
            : IntegratedUpdater(std::move(currentVersion), std::move(busy),
                      std::move(closeApplication), parent), m_profilePath(std::move(profilePath)) {
    }
  protected:
    void startDownload() override {
        m_directory = QStandardPaths::writableLocation(QStandardPaths::CacheLocation) + "/nautic-updates/" + version();
        if (!QDir().mkpath(m_directory)) { fail(tr("Cannot create the update cache.")); return; }
        m_manifest.clear();
        m_payload.reset();
        request(QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/download/v" +
                        version() + "/UPDATE_WINDOWS.json"), false);
    }
    void installAndRelaunch() override {
        m_restart = true;
        m_closeApplication(); // prepareQuit only runs after the user accepts closing.
    }
    bool armInstallOnQuit() override {
        const auto runtime = QCoreApplication::applicationDirPath();
        const auto helperDirectory = m_directory + "/helper";
        if (!QDir().mkpath(helperDirectory)) { fail(tr("Cannot prepare the update installer.")); return false; }
        // The helper runs outside the installation directory, which NSIS replaces.
        auto files = QDir(runtime).entryList({"*.dll", "NauticUpdateHelper.exe"}, QDir::Files);
        if (!files.contains("NauticUpdateHelper.exe")) { fail(tr("The update helper is missing.")); return false; }
        for (const auto& name : files) {
            const auto target = helperDirectory + "/" + name;
            QFile::remove(target);
            if (!QFile::copy(runtime + "/" + name, target)) { fail(tr("Cannot copy the update helper.")); return false; }
        }
        const QStringList arguments{QString::number(QCoreApplication::applicationPid()),
                QCoreApplication::applicationFilePath(), m_profilePath, m_directory,
                m_currentVersion, version(), m_restart ? "restart" : "quit"};
        if (!QProcess::startDetached(helperDirectory + "/NauticUpdateHelper.exe", arguments, helperDirectory)) {
            fail(tr("Cannot start the update installer."));
            return false;
        }
        report(State::Installing, tr("Closing NauticMixxx to install the verified update…"));
        return true;
    }
  private:
    void fail(const QString& error) { report(State::Failed, error); }
    void request(const QUrl& url, bool artifact) {
        QNetworkRequest request(url);
        request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
        request.setMaximumRedirectsAllowed(5);
        request.setTransferTimeout(30000);
        request.setRawHeader("User-Agent", "NauticMixxx/" + m_currentVersion.toUtf8());
        auto* reply = m_network.get(request);
        reply->setReadBufferSize(65536);
        auto* deadline = new QTimer(reply);
        deadline->setSingleShot(true);
        connect(deadline, &QTimer::timeout, reply, &QNetworkReply::abort);
        deadline->start(artifact ? 15 * 60 * 1000 : 30000);
        if (artifact) {
            m_file = std::make_unique<QSaveFile>(m_directory + "/" + m_payload->filename);
            if (!m_file->open(QIODevice::WriteOnly)) { reply->abort(); fail(tr("Cannot save the update.")); return; }
            m_received = 0;
            report(State::Downloading, tr("Downloading the update…"));
        }
        connect(reply, &QNetworkReply::readyRead, this, [this, reply, artifact] {
            const auto bytes = reply->readAll();
            if (artifact) {
                m_received += bytes.size();
                if (m_received > m_payload->size || m_file->write(bytes) != bytes.size()) {
                    reply->abort(); return;
                }
                progress(m_received, m_payload->size);
            } else {
                m_manifest += bytes;
                if (m_manifest.size() > 16384) reply->abort();
            }
        });
        connect(reply, &QNetworkReply::finished, this, [this, reply, artifact] {
            reply->deleteLater();
            if (reply->error() != QNetworkReply::NoError ||
                    reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() != 200) {
                m_file.reset(); fail(tr("The update download failed. Your installed version is unchanged.")); return;
            }
            if (!artifact) {
                m_payload = parseUpdateManifest(m_manifest, m_currentVersion, version());
                if (!m_payload) { fail(tr("The update manifest signature is invalid.")); return; }
                QSaveFile manifest(m_directory + "/UPDATE_WINDOWS.json");
                if (!manifest.open(QIODevice::WriteOnly) || manifest.write(m_manifest) != m_manifest.size() || !manifest.commit()) {
                    fail(tr("Cannot save the signed update manifest.")); return;
                }
                this->request(m_payload->url(), true);
                return;
            }
            if (m_received != m_payload->size || !m_file->commit()) {
                fail(tr("The update file is incomplete.")); return;
            }
            m_file.reset();
            report(State::Verifying, tr("Verifying the update signature…"));
            auto* watcher = new QFutureWatcher<bool>(this);
            connect(watcher, &QFutureWatcher<bool>::finished, this, [this, watcher] {
                const bool valid = watcher->result();
                watcher->deleteLater();
                if (valid) ready();
                else fail(tr("The update signature is invalid. Installation was canceled."));
            });
            const auto payload = *m_payload;
            const auto path = m_directory + "/" + payload.filename;
            watcher->setFuture(QtConcurrent::run([path, payload] { return verifyUpdateFile(path, payload); }));
        });
    }
    QNetworkAccessManager m_network;
    QString m_profilePath;
    QString m_directory;
    QByteArray m_manifest;
    std::optional<UpdatePayload> m_payload;
    std::unique_ptr<QSaveFile> m_file;
    qint64 m_received = 0;
    bool m_restart = false;
};

IntegratedUpdater* createIntegratedUpdater(const QString& currentVersion, const QString& profilePath,
        std::function<bool()> busy, std::function<void()> closeApplication, QObject* parent) {
    return new WindowsUpdater(currentVersion, profilePath, std::move(busy), std::move(closeApplication), parent);
}
} // namespace nautic
