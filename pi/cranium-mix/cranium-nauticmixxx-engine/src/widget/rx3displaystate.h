#pragma once
#include <QObject>
#include <QHash>
#include <QEvent>
#include <QPointer>
#include <QStackedLayout>
#include <QTimer>
#include <QWidget>
#include <array>
#include <memory>
#include "control/controlobject.h"
#include "control/controlproxy.h"
#include "widget/rx3performancestate.h"

// Playback MASTER presentation and independent user-selected performance deck.
class Rx3DisplayState : public QObject {
  public:
    explicit Rx3DisplayState(QObject* parent = nullptr)
            : QObject(parent) {
        new Rx3PerformanceState(this);
        for(const auto& name:{"autocue","hotcueautoload"}) {
            auto* control=new ControlObject(ConfigKey("[RX3Display]",name),false,false,false,1);
            m_settingsIndicators.push_back(std::unique_ptr<ControlObject>(control));
        }
        // These controls are part of the RX3 presentation contract. Create
        // them here when the skin has not declared them yet, so controller
        // mappings can use the same contract independently of parse order.
        ensureControl(ConfigKey(QStringLiteral("[Tab]"), QStringLiteral("current")),
                0.0,
                &m_tabCurrentOwner);
        ensureControl(ConfigKey(QStringLiteral("[RX3Browser]"),
                              QStringLiteral("auto_close_on_load")),
                1.0,
                &m_autoCloseOwner);
        m_tabCurrent = std::make_unique<ControlProxy>(
                QStringLiteral("[Tab]"), QStringLiteral("current"), this);
        m_autoClose = std::make_unique<ControlProxy>(QStringLiteral("[RX3Browser]"),
                QStringLiteral("auto_close_on_load"),
                this);

        for (int i = 0; i < 2; ++i) {
            const QString group = QStringLiteral("[Channel%1]").arg(i + 1);
            const ConfigKey timeKey(group,"rx3_time_remaining");
            if(!ControlObject::exists(timeKey)) m_settingsIndicators.push_back(
                    std::make_unique<ControlObject>(timeKey,false,false,false,
                            ControlObject::get(ConfigKey("[Controls]","ShowDurationRemaining"))));
            m_master[i] = std::make_unique<ControlObject>(ConfigKey(
                    QStringLiteral("[RX3Display]"), QStringLiteral("master%1").arg(i + 1)));
            for (const auto& name : {QStringLiteral("play"), QStringLiteral("track_loaded"),
                         QStringLiteral("sync_leader"), QStringLiteral("visual_bpm")}) {
                auto* input = new ControlProxy(group, name, this, ControlFlag::NoAssertIfMissing);
                m_inputs[i][name] = input;
                input->connectValueChanged(this, [this, i, name](double value) {
                    if (name == QStringLiteral("track_loaded")) {
                        const bool loaded = value > 0;
                        if (loaded && !m_wasLoaded[i]) {
                            closeBrowserAfterSuccessfulLoad();
                        }
                        m_wasLoaded[i] = loaded;
                    }
                    refresh();
                });
            }
            m_wasLoaded[i] =
                    m_inputs[i][QStringLiteral("track_loaded")]->get() > 0;
        }
        m_bpm = std::make_unique<ControlObject>(ConfigKey(
                QStringLiteral("[RX3Display]"), QStringLiteral("master_bpm")));
        refresh();
    }

    ~Rx3DisplayState() override {if(ControlObject::exists(ConfigKey("[RX3BeatFx]","auto_deck"))) ControlObject::set(ConfigKey("[RX3BeatFx]","auto_deck"),0);}

    int masterDeck() const { return m_selected + 1; }

    void bindCanvas(QWidget* canvas) {
        m_waveforms = canvas->findChild<QWidget*>("Waveforms");
        m_emptyLogo = canvas->findChild<QWidget*>("NauticBgLogoContainer");
        m_logoLabel = canvas->findChild<QWidget*>("NauticBgLogo");
        m_waveformsContent = canvas->findChild<QWidget*>("WaveformsContent");
        m_signals = canvas->findChild<QWidget*>("WaveformSignals");
        m_signalContent = canvas->findChild<QWidget*>("WaveformSignalContent");
        if (m_waveforms) m_waveforms->installEventFilter(this);
        if (m_emptyLogo) m_emptyLogo->setAttribute(Qt::WA_TransparentForMouseEvents);
        refreshEmptyLogo();
    }


    // track_loaded is a level: it stays at 1 when one loaded track replaces
    // another. LegacySkinParser calls this for BaseTrackPlayer::newTrackLoaded,
    // which is the authoritative successful-load event for both cases.
    void trackLoadSucceeded() {
        closeBrowserAfterSuccessfulLoad();
    }

  protected:
    bool eventFilter(QObject* object, QEvent* event) override {
        if (object == m_waveforms &&
                (event->type() == QEvent::Show || event->type() == QEvent::LayoutRequest) &&
                !m_logoRefreshQueued) {
            // Timer/INFO/page changes can restore the stacked layout later.
            // Refresh after Qt completes that layout without showing a new page.
            m_logoRefreshQueued = true;
            QTimer::singleShot(0, this, [this] {
                m_logoRefreshQueued = false;
                refreshEmptyLogo();
            });
        }
        return QObject::eventFilter(object, event);
    }

  private:
    void refreshEmptyLogo() {
        if (!m_waveforms || !m_emptyLogo || !m_logoLabel || !m_waveformsContent ||
                !m_signals || !m_signalContent) return;
        auto* stack = qobject_cast<QStackedLayout*>(m_waveforms->layout());
        if (!stack || stack->stackingMode() != QStackedLayout::StackAll) return;
        auto* signalStack = qobject_cast<QStackedLayout*>(m_signals->layout());
        if (!signalStack) return;
        const bool empty = m_inputs[0][QStringLiteral("track_loaded")]->get() == 0 &&
                m_inputs[1][QStringLiteral("track_loaded")]->get() == 0;
        // Hiding the complete signal page also hides its native OpenGL window
        // ancestors. Raising an alien logo over them alone cannot prevent
        // clipping on macOS. Deck cards live outside this exclusive stack.
        signalStack->setStackingMode(QStackedLayout::StackOne);
        QWidget* foreground = empty ? m_emptyLogo.data() : m_signalContent.data();
        if (signalStack->currentWidget() != foreground) signalStack->setCurrentWidget(foreground);
        if (stack->currentWidget() != m_waveformsContent) stack->setCurrentWidget(m_waveformsContent);
        m_emptyLogo->setVisible(empty);
        m_logoLabel->setVisible(empty);
    }

    static void ensureControl(const ConfigKey& key,
            double defaultValue,
            std::unique_ptr<ControlObject>* owner) {
        if (!ControlObject::exists(key)) {
            *owner = std::make_unique<ControlObject>(
                    key, false, false, false, defaultValue);
        }
    }

    void closeBrowserAfterSuccessfulLoad() {
        if (m_autoClose && m_autoClose->get() > 0 && m_tabCurrent &&
                qRound(m_tabCurrent->get()) == 1) {
            // Page 0 is PERFORMANCE/Overview; page 1 is the RX3 browser.
            // Preserve WRx3Browser's logical focus while only changing the
            // presentation page.
            m_tabCurrent->set(0.0);
        }
    }

    void refresh() {
        refreshEmptyLogo();
        // Connections are established before all output controls exist.
        if (!m_bpm) return;
        std::array<bool, 2> loaded, playing;
        int explicitLeader = -1;
        for (int i = 0; i < 2; ++i) {
            loaded[i] = m_inputs[i][QStringLiteral("track_loaded")]->get() > 0;
            playing[i] = loaded[i] && m_inputs[i][QStringLiteral("play")]->get() > 0;
            if (playing[i] && m_inputs[i][QStringLiteral("sync_leader")]->get() > 0 && explicitLeader < 0)
                explicitLeader = i;
        }
        int next = m_selected;
        if (explicitLeader >= 0) next = explicitLeader;
        else if (next < 0 || !playing[next]) {
            if (playing[0]) next = 0;
            else if (playing[1]) next = 1;
            else if (next < 0 || !loaded[next]) next = loaded[0] ? 0 : (loaded[1] ? 1 : -1);
        }
        // Clear the previous master before enabling the next: observers never
        // see both decks marked MASTER, even between value-change signals.
        if (next != m_selected) {
            for (auto& output : m_master) output->set(0);
            m_selected = next;
        }
        for (int i = 0; i < 2; ++i) m_master[i]->set(i == next ? 1 : 0);
        if(ControlObject::exists(ConfigKey("[RX3BeatFx]","auto_deck"))) ControlObject::set(ConfigKey("[RX3BeatFx]","auto_deck"),next+1);
        m_bpm->set(next >= 0 ? m_inputs[next][QStringLiteral("visual_bpm")]->get() : 0);
    }
    std::array<QHash<QString, ControlProxy*>, 2> m_inputs;
    std::array<std::unique_ptr<ControlObject>, 2> m_master;
    std::array<bool, 2> m_wasLoaded{{false, false}};
    std::unique_ptr<ControlObject> m_bpm;
    std::unique_ptr<ControlObject> m_tabCurrentOwner;
    std::unique_ptr<ControlObject> m_autoCloseOwner;
    std::unique_ptr<ControlProxy> m_tabCurrent;
    std::unique_ptr<ControlProxy> m_autoClose;
    std::vector<std::unique_ptr<ControlObject>> m_settingsIndicators;
    QPointer<QWidget> m_waveforms;
    QPointer<QWidget> m_emptyLogo;
    QPointer<QWidget> m_logoLabel;
    QPointer<QWidget> m_waveformsContent;
    QPointer<QWidget> m_signals;
    QPointer<QWidget> m_signalContent;
    bool m_logoRefreshQueued = false;
    int m_selected = -1;
};
