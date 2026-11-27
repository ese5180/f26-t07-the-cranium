#pragma once

#include <QNetworkAccessManager>
#include <QElapsedTimer>
#include <QPointer>
#include <QTimer>
#include <QUrl>
#include <functional>
#include <optional>

namespace nautic {

struct UpdateRelease {
    QString version;
    QUrl downloadPage;
};

// One asynchronous request, with a hard startup deadline. No retries or polling.
class StartupUpdateChecker : public QObject {
  public:
    using AvailableCallback = std::function<void(const UpdateRelease&)>;
    StartupUpdateChecker(QString currentVersion,
            QString skippedVersion,
            AvailableCallback available,
            QObject* parent = nullptr,
            QUrl endpoint = QUrl(QStringLiteral(
                    "https://api.github.com/repos/nauticsoftware/NauticMixxx/releases/latest")),
            int timeoutMs = 5000);
    ~StartupUpdateChecker() override;

    void check();
    void cancel();
    static std::optional<UpdateRelease> parseRelease(const QByteArray& json,
            const QString& currentVersion,
            const QString& skippedVersion);

  private:
    void finish();

    const QString m_currentVersion;
    const QString m_skippedVersion;
    const AvailableCallback m_available;
    const QUrl m_endpoint;
    QNetworkAccessManager m_network;
    QTimer m_deadline;
    QElapsedTimer m_elapsed;
    QPointer<QNetworkReply> m_reply;
    QByteArray m_body;
    bool m_started = false;
    bool m_cancelled = false;
};

} // namespace nautic
