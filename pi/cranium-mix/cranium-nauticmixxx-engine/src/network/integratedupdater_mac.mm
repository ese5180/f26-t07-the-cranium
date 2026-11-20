#include "network/integratedupdater.h"
#include <QTimer>
#import <Sparkle/Sparkle.h>

class MacUpdater;
@interface NauticUpdateDriver : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(nonatomic, assign) MacUpdater* owner;
@property(nonatomic, strong) SPUUpdater* updater;
@property(nonatomic, copy) void (^installHandler)(void);
@property(nonatomic) uint64_t expected;
@property(nonatomic) uint64_t received;
@property(nonatomic) BOOL relaunch;
@end

class MacUpdater final : public nautic::IntegratedUpdater {
  public:
    using State = nautic::IntegratedUpdater::State;
    MacUpdater(QString currentVersion, std::function<bool()> busy,
            std::function<void()> closeApplication, QObject* parent)
            : IntegratedUpdater(std::move(currentVersion), std::move(busy),
                      std::move(closeApplication), parent) {
        m_driver = [NauticUpdateDriver new];
        m_driver.owner = this;
        m_driver.updater = [[SPUUpdater alloc] initWithHostBundle:NSBundle.mainBundle
                applicationBundle:NSBundle.mainBundle userDriver:m_driver delegate:m_driver];
    }
    ~MacUpdater() override { m_driver.owner = nullptr; m_driver.updater = nil; }
  protected:
    void startDownload() override {
        NSError* error = nil;
        if (![m_driver.updater startUpdater:&error]) {
            report(State::Failed, QString::fromUtf8(error.localizedDescription.UTF8String));
            return;
        }
        // Sparkle handles extraction, signature verification and atomic replacement.
        // Scheduling is controlled by NauticMixxx, so it never opens its own UI.
        m_driver.updater.automaticallyChecksForUpdates = NO;
        m_driver.updater.automaticallyDownloadsUpdates = YES;
        m_driver.relaunch = NO;
        [m_driver.updater checkForUpdatesInBackground];
    }
    void installAndRelaunch() override {
        if (m_driver.installHandler) {
            m_driver.relaunch = YES;
            // Preserve the ready state if the user cancels the application's quit.
            m_driver.installHandler();
        }
    }
    bool armInstallOnQuit() override {
        // Sparkle's installer waits for process termination and leaves the profile alone.
        return YES;
    }
  private:
    NauticUpdateDriver* __strong m_driver;
};

@implementation NauticUpdateDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest*)request
        reply:(void (^)(SUUpdatePermissionResponse*))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancel {}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem*)item state:(SPUUserUpdateState*)state
        reply:(void (^)(SPUUserUpdateChoice))reply {
    reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData*)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError*)error {}
- (void)showUpdateNotFoundWithError:(NSError*)error acknowledgement:(void (^)(void))ack {
    [self showUpdaterError:error acknowledgement:ack];
}
- (void)showUpdaterError:(NSError*)error acknowledgement:(void (^)(void))ack {
    if (_owner) _owner->report(MacUpdater::State::Failed,
            QString::fromUtf8(error.localizedDescription.UTF8String));
    ack();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancel {
    _received = 0;
    _expected = 0;
    if (_owner) _owner->report(MacUpdater::State::Downloading, QObject::tr("Downloading the update…"));
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { _expected = length; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
    _received += length;
    if (_owner) _owner->progress(_received, _expected);
}
- (void)showDownloadDidStartExtractingUpdate {
    if (_owner) _owner->report(MacUpdater::State::Verifying, QObject::tr("Verifying and preparing the update…"));
}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    self.installHandler = ^{ reply(SPUUserUpdateChoiceInstall); };
    if (_owner) _owner->ready();
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated
        retryTerminatingApplication:(void (^)(void))retry {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack { ack(); }
- (void)dismissUpdateInstallation {}
- (void)showUpdateInFocus {}
- (BOOL)updater:(SPUUpdater*)updater shouldProceedWithUpdate:(SUAppcastItem*)item
        updateCheck:(SPUUpdateCheck)check error:(NSError**)error {
    return _owner && _owner->version() == QString::fromUtf8(item.versionString.UTF8String);
}
- (BOOL)updater:(SPUUpdater*)updater willInstallUpdateOnQuit:(SUAppcastItem*)item
        immediateInstallationBlock:(void (^)(void))handler {
    self.installHandler = handler;
    if (_owner) _owner->ready();
    return YES; // No impatient-update popup while a mixing session is running.
}
- (BOOL)updater:(SPUUpdater*)updater shouldPostponeRelaunchForUpdate:(SUAppcastItem*)item
        untilInvokingBlock:(void (^)(void))handler {
    if (_owner && _owner->isBusy()) {
        self.installHandler = handler;
        _owner->report(MacUpdater::State::Ready, QObject::tr("Stop playback before installing."));
        return YES;
    }
    return NO;
}
- (BOOL)updaterShouldRelaunchApplication:(SPUUpdater*)updater { return _relaunch; }
- (void)updater:(SPUUpdater*)updater willDownloadUpdate:(SUAppcastItem*)item
        withRequest:(NSMutableURLRequest*)request {
    if (_owner) _owner->report(MacUpdater::State::Downloading, QObject::tr("Downloading the update…"));
}
- (void)updater:(SPUUpdater*)updater willExtractUpdate:(SUAppcastItem*)item {
    if (_owner) _owner->report(MacUpdater::State::Verifying, QObject::tr("Verifying and preparing the update…"));
}
- (void)updater:(SPUUpdater*)updater didAbortWithError:(NSError*)error {
    if (_owner) _owner->report(MacUpdater::State::Failed,
            QString::fromUtf8(error.localizedDescription.UTF8String));
}
@end

namespace nautic {
IntegratedUpdater* createIntegratedUpdater(const QString& currentVersion, const QString&,
        std::function<bool()> busy, std::function<void()> closeApplication, QObject* parent) {
    return new MacUpdater(currentVersion, std::move(busy), std::move(closeApplication), parent);
}
} // namespace nautic
