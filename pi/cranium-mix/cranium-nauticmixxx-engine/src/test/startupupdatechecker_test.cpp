#include <gtest/gtest.h>

#include <QCoreApplication>
#include <QEventLoop>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QPushButton>
#include <memory>

#include "dialog/dlgstartupupdate.h"
#include "network/startupupdatechecker.h"
#include "test/mixxxtest.h"

namespace {
QByteArray releaseJson(const QString& tag = QStringLiteral("v1.7.0")) {
    return QJsonDocument(QJsonObject{
            {"tag_name", tag}, {"draft", false}, {"prerelease", false},
            {"html_url", "https://untrusted.example/download"}}).toJson();
}

void runEvents(int milliseconds) {
    QEventLoop loop;
    QTimer::singleShot(milliseconds, &loop, &QEventLoop::quit);
    loop.exec();
}

// Real local HTTP transport, with no GitHub or internet dependency.
class ReleaseServer : public QTcpServer {
  public:
    QByteArray body = releaseJson();
    QByteArray status = "200 OK";
    QByteArray headers;
    QByteArray lastRequest;
    int delayMs = 0;
    int requests = 0;

    ReleaseServer() {
        connect(this, &QTcpServer::newConnection, this, [this] {
            while (hasPendingConnections()) {
                auto* socket = nextPendingConnection();
                auto request = std::make_shared<QByteArray>();
                connect(socket, &QTcpSocket::readyRead, this, [this, socket, request] {
                    request->append(socket->readAll());
                    if (!request->contains("\r\n\r\n")) {
                        return;
                    }
                    disconnect(socket, &QTcpSocket::readyRead, this, nullptr);
                    lastRequest = *request;
                    ++requests;
                    QTimer::singleShot(delayMs, socket, [this, socket] {
                        socket->write("HTTP/1.1 " + status + "\r\n" + headers +
                                "Content-Type: application/json\r\nConnection: close\r\nContent-Length: " +
                                QByteArray::number(body.size()) + "\r\n\r\n" + body);
                        socket->disconnectFromHost();
                    });
                });
                connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            }
        });
    }

    QUrl endpoint() const {
        return QUrl(QStringLiteral("http://127.0.0.1:%1/latest").arg(serverPort()));
    }
};
} // namespace

TEST(StartupUpdateCheckerTest, ComparesProductVersionsNumericallyAndPinsDownloadPage) {
    const auto result = nautic::StartupUpdateChecker::parseRelease(
            releaseJson("v1.10.0"), "1.9.0", "");
    ASSERT_TRUE(result);
    EXPECT_EQ(QStringLiteral("1.10.0"), result->version);
    EXPECT_EQ(QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/tag/v1.10.0"),
            result->downloadPage);
    EXPECT_TRUE(nautic::StartupUpdateChecker::parseRelease(releaseJson("1.7.0"), "1.6.0", ""));
}

TEST(StartupUpdateCheckerTest, EqualOlderAndSkippedVersionsAreSilent) {
    for (const auto& tag : {"v1.6.0", "v1.5.1", "v1.7.0"}) {
        EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(releaseJson(tag), "1.6.0", "1.7.0"));
    }
    EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(releaseJson(), "1.6.0", "v1.7.0"));
    EXPECT_TRUE(nautic::StartupUpdateChecker::parseRelease(releaseJson("v1.8.0"), "1.6.0", "1.7.0"));
}

TEST(StartupUpdateCheckerTest, RejectsDraftsPrereleasesAndInvalidFlags) {
    for (const auto& flag : {"draft", "prerelease"}) {
        auto object = QJsonDocument::fromJson(releaseJson()).object();
        object[flag] = true;
        EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(QJsonDocument(object).toJson(), "1.6.0", ""));
        object.remove(flag);
        EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(QJsonDocument(object).toJson(), "1.6.0", ""));
        object[flag] = "false";
        EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(QJsonDocument(object).toJson(), "1.6.0", ""));
    }
}

TEST(StartupUpdateCheckerTest, RejectsMalformedOrAmbiguousVersionsAndResponses) {
    for (const auto& tag : {"v1.7.0-beta.1", "v1.7", "v1.7.0.1", "v01.7.0", "v1.7.0/../../evil",
                 "v999999999999999999999.7.0", "v1.7.999999999999999999999", "", " v1.7.0"}) {
        EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(releaseJson(tag), "1.6.0", "")) << tag;
    }
    for (const auto& json : {"not json", "[]", "{}", "null"}) {
        EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(json, "1.6.0", ""));
    }
    EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(releaseJson(), "2.5.6", ""));
    EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(releaseJson(), "1.6.0-beta.1", ""));
    EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(QByteArray(262145, ' '), "1.6.0", ""));
}

TEST(StartupUpdateCheckerTest, AsynchronousRequestRunsOnlyOnceWithoutCredentials) {
    ReleaseServer server;
    ASSERT_TRUE(server.listen(QHostAddress::LocalHost));
    QEventLoop loop;
    int notifications = 0;
    nautic::StartupUpdateChecker checker("1.6.0", "",
            [&](const nautic::UpdateRelease&) { ++notifications; loop.quit(); },
            nullptr, server.endpoint(), 1000);
    QTimer::singleShot(1500, &loop, &QEventLoop::quit);
    checker.check();
    checker.check();
    EXPECT_EQ(0, notifications); // check() never blocks for the network.
    loop.exec();
    EXPECT_EQ(1, notifications);
    checker.check();
    runEvents(50);
    EXPECT_EQ(1, server.requests);
    EXPECT_TRUE(server.lastRequest.contains("User-Agent: NauticMixxx/1.6.0"));
    EXPECT_FALSE(server.lastRequest.toLower().contains("authorization:"));
}

TEST(StartupUpdateCheckerTest, DeadlineDiscardsLateResponsesAndNeverRetries) {
    ReleaseServer server;
    server.delayMs = 200;
    ASSERT_TRUE(server.listen(QHostAddress::LocalHost));
    int notifications = 0;
    nautic::StartupUpdateChecker checker("1.6.0", "",
            [&](const nautic::UpdateRelease&) { ++notifications; },
            nullptr, server.endpoint(), 40);
    checker.check();
    runEvents(350);
    checker.check();
    runEvents(50);
    EXPECT_EQ(0, notifications);
    EXPECT_EQ(1, server.requests);
}

TEST(StartupUpdateCheckerTest, CancellationDiscardsResponseEvenIfPlaybackStopsAgain) {
    ReleaseServer server;
    server.delayMs = 150;
    ASSERT_TRUE(server.listen(QHostAddress::LocalHost));
    int notifications = 0;
    nautic::StartupUpdateChecker checker("1.6.0", "",
            [&](const nautic::UpdateRelease&) { ++notifications; },
            nullptr, server.endpoint(), 1000);
    checker.check();
    QTimer::singleShot(30, &checker, &nautic::StartupUpdateChecker::cancel);
    runEvents(250);
    checker.check();
    runEvents(50);
    EXPECT_EQ(0, notifications);
    EXPECT_EQ(1, server.requests);
}

TEST(StartupUpdateCheckerTest, ErrorsRedirectsAndOversizedResponsesAreSilent) {
    for (const auto& status : {"403 Forbidden", "404 Not Found", "429 Too Many Requests",
                 "500 Internal Server Error", "302 Found", "200 OK"}) {
        ReleaseServer server;
        server.status = status;
        if (server.status.startsWith("302")) {
            server.headers = "Location: https://untrusted.example/redirect\r\n";
        } else if (server.status.startsWith("200")) {
            server.body = QByteArray(300000, ' ');
        }
        ASSERT_TRUE(server.listen(QHostAddress::LocalHost));
        int notifications = 0;
        nautic::StartupUpdateChecker checker("1.6.0", "",
                [&](const nautic::UpdateRelease&) { ++notifications; },
                nullptr, server.endpoint(), 100);
        checker.check();
        runEvents(200);
        EXPECT_EQ(0, notifications) << status;
        EXPECT_EQ(1, server.requests) << status;
    }
}

TEST(StartupUpdateCheckerTest, ClosedConnectionAndShutdownAreSafe) {
    ReleaseServer server;
    ASSERT_TRUE(server.listen(QHostAddress::LocalHost));
    const auto endpoint = server.endpoint();
    server.close();
    int notifications = 0;
    nautic::StartupUpdateChecker checker("1.6.0", "",
            [&](const nautic::UpdateRelease&) { ++notifications; }, nullptr, endpoint, 100);
    checker.check();
    runEvents(150);
    EXPECT_EQ(0, notifications);

    ASSERT_TRUE(server.listen(QHostAddress::LocalHost));
    server.delayMs = 100;
    {
        nautic::StartupUpdateChecker pending("1.6.0", "",
                [&](const nautic::UpdateRelease&) { ++notifications; }, nullptr, server.endpoint(), 500);
        pending.check();
        runEvents(20);
    }
    runEvents(150);
    EXPECT_EQ(0, notifications);
}

class StartupUpdateDialogTest : public MixxxTest {};

TEST_F(StartupUpdateDialogTest, SkipPersistsAcrossProfileRestartAndAllowsNextVersion) {
    int downloads = 0;
    const nautic::UpdateRelease release{"1.7.0", QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/tag/v1.7.0")};
    DlgStartupUpdate dialog("1.6.0", release,
            [&](const QUrl&) { ++downloads; },
            [this](const QString& version) {
                config()->setValue(ConfigKey("[NauticUpdates]", "SkippedVersion"), version);
                config()->save();
            });
    dialog.show();
    for (auto* button : dialog.buttons()) {
        if (dialog.buttonRole(button) == QMessageBox::DestructiveRole) {
            button->click();
        }
    }
    EXPECT_EQ(0, downloads);
    EXPECT_FALSE(dialog.isVisible());
    saveAndReloadConfig();
    const auto skipped = config()->getValueString(ConfigKey("[NauticUpdates]", "SkippedVersion"));
    EXPECT_EQ(QStringLiteral("1.7.0"), skipped);
    EXPECT_FALSE(nautic::StartupUpdateChecker::parseRelease(releaseJson(), "1.6.0", skipped));
    EXPECT_TRUE(nautic::StartupUpdateChecker::parseRelease(releaseJson("v1.8.0"), "1.6.0", skipped));
}

TEST_F(StartupUpdateDialogTest, LaterAndWindowCloseLeaveVersionEligible) {
    const nautic::UpdateRelease release{"1.7.0", QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/tag/v1.7.0")};
    int actions = 0;
    DlgStartupUpdate dialog("1.6.0", release,
            [&](const QUrl&) { ++actions; }, [&](const QString&) { ++actions; });
    dialog.show();
    EXPECT_EQ(Qt::NonModal, dialog.windowModality());
    EXPECT_EQ(QStringLiteral("Later"), dialog.defaultButton()->text());
    for (auto* button : dialog.buttons()) {
        if (dialog.buttonRole(button) == QMessageBox::RejectRole) {
            button->click();
        }
    }
    EXPECT_FALSE(dialog.isVisible());
    dialog.show();
    dialog.close();
    EXPECT_EQ(0, actions);
}

TEST_F(StartupUpdateDialogTest, DownloadUsesTheReleasePageWithoutSkipping) {
    const nautic::UpdateRelease release{"1.7.0", QUrl("https://github.com/nauticsoftware/NauticMixxx/releases/tag/v1.7.0")};
    QUrl destination;
    int skipped = 0;
    DlgStartupUpdate dialog("1.6.0", release,
            [&](const QUrl& page) { destination = page; },
            [&](const QString&) { ++skipped; });
    dialog.show();
    for (auto* button : dialog.buttons()) {
        if (dialog.buttonRole(button) == QMessageBox::AcceptRole) {
            button->click();
        }
    }
    EXPECT_EQ(release.downloadPage, destination);
    EXPECT_EQ(0, skipped);
    EXPECT_FALSE(dialog.isVisible());
}
