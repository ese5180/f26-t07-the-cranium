// End-to-end updater fixture. Never installed or included in a public package.
#include <QApplication>
#include <QFile>
#include <QStandardPaths>
#include <QDir>
#include <QTimer>
#include <cstdio>
#import <Foundation/Foundation.h>
#include "network/integratedupdater.h"

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setApplicationName("NauticMixxx Updater Probe");
    app.setOrganizationName("NauticMixxx");
    NSString* nativeVersion = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    const auto version = QString::fromUtf8(nativeVersion.UTF8String);
    const auto directory = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(directory);
    QFile profile(directory + "/profile.txt");
    if (version == "1.9.1") {
        const bool preserved = profile.open(QIODevice::ReadOnly) && profile.readAll() == "preserve my settings\n";
        QFile marker(directory + "/installed.txt");
        if (marker.open(QIODevice::WriteOnly)) marker.write(preserved ? "1.9.1 profile preserved\n" : "PROFILE LOST\n");
        return preserved ? 0 : 2;
    }
    if (profile.open(QIODevice::WriteOnly)) profile.write("preserve my settings\n");
    profile.close();
    const bool background = app.arguments().contains("--background");
    auto* updater = nautic::createIntegratedUpdater(version, directory, [] { return false; }, [&app] { app.quit(); }, &app);
    QObject::connect(updater, &nautic::IntegratedUpdater::changed, &app,
            [&](auto state, const QString& message) {
                std::fprintf(stdout, "%d %s\n", int(state), message.toUtf8().constData());
                std::fflush(stdout);
                if (state == nautic::IntegratedUpdater::State::Ready && background) {
                    QTimer::singleShot(300, &app, &QCoreApplication::quit);
                }
                if (state == nautic::IntegratedUpdater::State::Failed) app.exit(3);
            });
    QTimer::singleShot(0, updater, [&] {
        updater->begin("1.9.1", background ? nautic::IntegratedUpdater::Mode::InstallOnQuit
                                         : nautic::IntegratedUpdater::Mode::InstallNow);
    });
    QTimer::singleShot(120000, &app, [&] { app.exit(4); });
    return app.exec();
}
