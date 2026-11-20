#include "network/startupupdatechecker.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QVersionNumber>

namespace nautic {
namespace {
constexpr int kMaxResponseBytes = 256 * 1024;

std::optional<QVersionNumber> stableVersion(QString text) {
    if (text.startsWith(QLatin1Char('v'))) {
        text.remove(0, 1);
    }
    static const QRegularExpression pattern(
            QStringLiteral("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"));
    if (!pattern.match(text).hasMatch()) {
        return std::nullopt;
    }
    const auto version = QVersionNumber::fromString(text);
    if (version.segmentCount() != 3) {
        return std::nullopt;
    }
    return version;
}
} // namespace

StartupUpdateChecker::StartupUpdateChecker(QString currentVersion,
        QString skippedVersion,
        AvailableCallback available,
        QObject* parent,
        QUrl endpoint,
        int timeoutMs)
        : QObject(parent),
          m_currentVersion(std::move(currentVersion)),
          m_skippedVersion(std::move(skippedVersion)),
          m_available(std::move(available)),
          m_endpoint(std::move(endpoint)),
          m_network(this),
          m_deadline(this) {
    m_deadline.setSingleShot(true);
    m_deadline.setInterval(qMax(1, timeoutMs));
    connect(&m_deadline, &QTimer::timeout, this, &StartupUpdateChecker::cancel);
}

StartupUpdateChecker::~StartupUpdateChecker() {
    if (m_reply) {
        disconnect(m_reply, nullptr, this, nullptr);
        m_reply->abort();
    }
}

std::optional<UpdateRelease> StartupUpdateChecker::parseRelease(
        const QByteArray& json,
        const QString& currentVersion,
        const QString& skippedVersion) {
    if (json.size() > kMaxResponseBytes) {
        return std::nullopt;
    }
    const auto document = QJsonDocument::fromJson(json);
    if (!document.isObject()) {
        return std::nullopt;
    }
    const auto object = document.object();
    // Missing or incorrectly typed release flags fail closed.
    if (!object.value("draft").isBool() || object.value("draft").toBool() ||
            !object.value("prerelease").isBool() || object.value("prerelease").toBool()) {
        return std::nullopt;
    }
    const QString tag = object.value("tag_name").toString();
    const auto latest = stableVersion(tag);
    const auto current = stableVersion(currentVersion);
    const auto skipped = stableVersion(skippedVersion);
    if (!latest || !current || *latest <= *current || (skipped && *latest == *skipped)) {
        return std::nullopt;
    }

    // Construct the destination ourselves: never open a URL supplied by the feed.
    const QUrl page(QStringLiteral("https://github.com/nauticsoftware/NauticMixxx/releases/tag/") + tag);
    return UpdateRelease{latest->toString(), page};
}

void StartupUpdateChecker::check() {
    if (m_started || m_cancelled || !stableVersion(m_currentVersion)) {
        return;
    }
    m_started = true;
    QNetworkRequest request(m_endpoint);
    request.setRawHeader("Accept", "application/vnd.github+json");
    request.setRawHeader("User-Agent", (QStringLiteral("NauticMixxx/") + m_currentVersion).toUtf8());
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
            QNetworkRequest::ManualRedirectPolicy);
    m_deadline.start();
    m_elapsed.start();
    m_reply = m_network.get(request);
    m_reply->setReadBufferSize(kMaxResponseBytes + 1);
    connect(m_reply, &QIODevice::readyRead, this, [this] {
        if (!m_reply || m_cancelled) {
            return;
        }
        m_body.append(m_reply->read(kMaxResponseBytes + 1 - m_body.size()));
        if (m_body.size() > kMaxResponseBytes) {
            cancel();
        }
    });
    connect(m_reply, &QNetworkReply::finished, this, &StartupUpdateChecker::finish);
}

void StartupUpdateChecker::cancel() {
    m_cancelled = true;
    m_deadline.stop();
    if (m_reply) {
        m_reply->abort();
    }
}

void StartupUpdateChecker::finish() {
    m_deadline.stop();
    if (!m_reply) {
        return;
    }
    auto* reply = m_reply.data();
    m_reply.clear();
    reply->deleteLater();
    if (m_cancelled || m_elapsed.elapsed() >= m_deadline.interval() ||
            reply->error() != QNetworkReply::NoError ||
            reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() != 200) {
        return;
    }
    m_body.append(reply->read(kMaxResponseBytes + 1 - m_body.size()));
    const auto release = parseRelease(m_body, m_currentVersion, m_skippedVersion);
    if (release && m_available) {
        m_available(*release);
    }
}

} // namespace nautic
