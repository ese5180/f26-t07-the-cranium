#pragma once

#include <QMessageBox>
#include <functional>

#include "network/startupupdatechecker.h"
#include "network/integratedupdater.h"

class DlgStartupUpdate : public QMessageBox {
  public:
    DlgStartupUpdate(const QString& installedVersion,
            const nautic::UpdateRelease& release,
            std::function<void(const QUrl&)> download,
            std::function<void(const QString&)> skip,
            QWidget* parent = nullptr);
    DlgStartupUpdate(const QString& installedVersion,
            const nautic::UpdateRelease& release,
            std::function<void(nautic::IntegratedUpdater::Mode, bool)> download,
            std::function<void(const QString&)> skip,
            QWidget* parent);
};

void showIntegratedUpdateProgress(nautic::IntegratedUpdater* updater, QWidget* parent);
