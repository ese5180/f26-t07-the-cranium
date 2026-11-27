#include "dialog/dlgstartupupdate.h"

#include <QCoreApplication>
#include <QPushButton>
#include <QCheckBox>
#include <QLabel>
#include <QProgressBar>
#include <QVBoxLayout>

DlgStartupUpdate::DlgStartupUpdate(const QString& installedVersion,
        const nautic::UpdateRelease& release,
        std::function<void(const QUrl&)> download,
        std::function<void(const QString&)> skip,
        QWidget* parent)
        : QMessageBox(parent) {
    const auto translate = [](const char* text) {
        return QCoreApplication::translate("DlgStartupUpdate", text);
    };
    setIcon(QMessageBox::NoIcon);
    setWindowTitle(translate("NauticMixxx update available"));
    setWindowModality(Qt::NonModal);
    setTextFormat(Qt::PlainText);
    setText(translate("A new version of NauticMixxx is available."));
    setInformativeText(
            translate("Installed version: %1\nNew version: %2\n\nDownload the update and install it manually.")
                    .arg(installedVersion, release.version));
    auto* downloadButton = addButton(translate("Download"), QMessageBox::AcceptRole);
    auto* laterButton = addButton(translate("Later"), QMessageBox::RejectRole);
    auto* skipButton = addButton(translate("Skip this version"), QMessageBox::DestructiveRole);
    setDefaultButton(laterButton);
    setEscapeButton(laterButton);
    connect(this, &QMessageBox::buttonClicked, this,
            [release, downloadButton, skipButton, download, skip](QAbstractButton* button) {
                if (button == downloadButton && download) {
                    download(release.downloadPage);
                } else if (button == skipButton && skip) {
                    skip(release.version);
                }
            });
}

DlgStartupUpdate::DlgStartupUpdate(const QString& installedVersion,
        const nautic::UpdateRelease& release,
        std::function<void(nautic::IntegratedUpdater::Mode, bool)> download,
        std::function<void(const QString&)> skip, QWidget* parent)
        : QMessageBox(parent) {
    setWindowTitle(tr("NauticMixxx update available"));
    setWindowModality(Qt::NonModal);
    setTextFormat(Qt::PlainText);
    setText(tr("A new version of NauticMixxx is available."));
    setInformativeText(tr("Installed version: %1\nNew version: %2\n\n"
                         "Your library and settings will be preserved.\n"
                         "Installation waits until playback stops and the app closes.")
                              .arg(installedVersion, release.version));
    auto* install = addButton(tr("Download and Install"), QMessageBox::AcceptRole);
    auto* background = addButton(tr("Download in Background"), QMessageBox::ActionRole);
    auto* later = addButton(tr("Later"), QMessageBox::RejectRole);
    auto* skipButton = addButton(tr("Skip this version"), QMessageBox::DestructiveRole);
    auto* automatic = new QCheckBox(tr("Automatically download future updates"), this);
    setCheckBox(automatic); // Explicit opt-in; never enabled by default.
    setDefaultButton(later);
    setEscapeButton(later);
    connect(this, &QMessageBox::buttonClicked, this,
            [=](QAbstractButton* button) {
                if (button == install || button == background) {
                    download(button == install ? nautic::IntegratedUpdater::Mode::InstallNow
                                               : nautic::IntegratedUpdater::Mode::InstallOnQuit,
                            automatic->isChecked());
                } else if (button == skipButton && skip) {
                    skip(release.version);
                }
            });
}

void showIntegratedUpdateProgress(nautic::IntegratedUpdater* updater, QWidget* parent) {
    auto* dialog = new QDialog(parent);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->setWindowTitle(QObject::tr("NauticMixxx update"));
    auto* layout = new QVBoxLayout(dialog);
    auto* text = new QLabel(QObject::tr("Preparing the update…"), dialog);
    text->setWordWrap(true);
    text->setTextFormat(Qt::PlainText);
    layout->addWidget(text);
    auto* progress = new QProgressBar(dialog);
    progress->setRange(0, 0);
    layout->addWidget(progress);
    auto* install = new QPushButton(QObject::tr("Install and Restart"), dialog);
    install->setEnabled(false);
    layout->addWidget(install);
    auto* close = new QPushButton(QObject::tr("Continue Using NauticMixxx"), dialog);
    layout->addWidget(close);
    QObject::connect(close, &QPushButton::clicked, dialog, &QDialog::close);
    QObject::connect(install, &QPushButton::clicked, updater, &nautic::IntegratedUpdater::installNow);
    const auto updateUi = [=](nautic::IntegratedUpdater::State state, const QString& message) {
                text->setText(message);
                const bool ready = state == nautic::IntegratedUpdater::State::Ready;
                install->setEnabled(ready);
                if (ready || state == nautic::IntegratedUpdater::State::Failed) {
                    progress->setRange(0, 100);
                    progress->setValue(ready ? 100 : 0);
                }
            };
    QObject::connect(updater, &nautic::IntegratedUpdater::changed, dialog, updateUi);
    updateUi(updater->state(), updater->message().isEmpty()
                    ? QObject::tr("No update is prepared. NauticMixxx checks for updates at startup.")
                    : updater->message());
    QObject::connect(updater, &nautic::IntegratedUpdater::downloadProgress, dialog,
            [=](qint64 received, qint64 total) {
                if (total > 0) {
                    progress->setRange(0, 100);
                    progress->setValue(static_cast<int>(100.0 * received / total));
                }
            });
    dialog->resize(440, 180);
    dialog->show();
}
