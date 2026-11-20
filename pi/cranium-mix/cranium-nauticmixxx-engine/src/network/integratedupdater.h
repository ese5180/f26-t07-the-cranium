#pragma once

#include <QObject>
#include <functional>

namespace nautic {
// The platform installer owns replacement only after the audio process exits.
class IntegratedUpdater : public QObject {
    Q_OBJECT
  public:
    enum class Mode { InstallNow, InstallOnQuit };
    enum class State { Idle, Checking, Downloading, Verifying, Ready, Installing, Failed };
    IntegratedUpdater(QString currentVersion, std::function<bool()> busy,
            std::function<void()> closeApplication, QObject* parent = nullptr);
    void begin(const QString& version, Mode mode);
    void installNow();
    bool prepareQuit();
    State state() const { return m_state; }
    Mode mode() const { return m_mode; }
    QString version() const { return m_version; }
    QString message() const { return m_message; }
    bool isBusy() const { return m_busy(); }
    void report(State state, const QString& message);
    void ready();
    void progress(qint64 received, qint64 total);
  signals:
    void changed(nautic::IntegratedUpdater::State state, const QString& message);
    void downloadProgress(qint64 received, qint64 total);
  protected:
    virtual void startDownload() = 0;
    virtual void installAndRelaunch() = 0;
    virtual bool armInstallOnQuit() = 0;
    const QString m_currentVersion;
    std::function<void()> m_closeApplication;
  private:
    std::function<bool()> m_busy;
    QString m_version;
    QString m_message;
    Mode m_mode = Mode::InstallOnQuit;
    State m_state = State::Idle;
};

IntegratedUpdater* createIntegratedUpdater(const QString& currentVersion,
        const QString& profilePath, std::function<bool()> busy,
        std::function<void()> closeApplication, QObject* parent);
} // namespace nautic
