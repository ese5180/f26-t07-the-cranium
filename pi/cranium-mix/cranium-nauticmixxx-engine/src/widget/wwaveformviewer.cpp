#include "widget/wwaveformviewer.h"

#include <QDragEnterEvent>
#include <QEvent>
#include <QApplication>
#include <QLineF>
#include <QMap>
#include <QPointer>
#include <QTouchEvent>
#include <QTimer>
#include <QSet>
#include <QPainter>
#include <QPaintEvent>
#include <array>
#include <QWheelEvent>
#include <cmath>

#include "control/controlproxy.h"
#include "moc_wwaveformviewer.cpp"
#include "util/dnd.h"
#include "util/math.h"
#include "waveform/waveformwidgetfactory.h"
#include "waveform/widgets/waveformwidgetabstract.h"
#include "widget/wcuemenupopup.h"
#include "widget/wglwidget.h"
#ifdef MIXXX_USE_QOPENGL
#include <QOpenGLWindow>
#endif

// Native GL waveforms each have their own QWindow. Intercept touch before
// those windows synthesize/forward mouse drags, and combine contacts across
// both deck surfaces so a pinch can straddle the two waveforms.
class CraniumWaveformTouchRouter final : public QObject {
  public:
    static CraniumWaveformTouchRouter* instance() {
        static QPointer<CraniumWaveformTouchRouter> router;
        if (!router) router = new CraniumWaveformTouchRouter(qApp);
        return router;
    }
    void addViewer(WWaveformViewer* viewer) {
        for (const auto& existing : m_viewers) if (existing == viewer) return;
        m_viewers.append(viewer);
    }
    void forgetViewer(WWaveformViewer* viewer) {
        if (m_owner == viewer) reset();
    }

  protected:
    bool eventFilter(QObject* watched, QEvent* event) override {
        const auto type = event->type();
        const bool touch = type == QEvent::TouchBegin || type == QEvent::TouchUpdate ||
                type == QEvent::TouchEnd || type == QEvent::TouchCancel;
        const bool mouse = type == QEvent::MouseButtonPress || type == QEvent::MouseMove ||
                type == QEvent::MouseButtonRelease || type == QEvent::MouseButtonDblClick;
        if (!touch && !mouse) return false;
        auto* viewer = viewerFor(watched);
        if (!viewer) return false;
        if (mouse) {
            // Touch is handled below, never a second time as an emulated mouse.
            if (static_cast<QMouseEvent*>(event)->source() != Qt::MouseEventNotSynthesized) {
                event->accept(); return true;
            }
            return false;
        }
        auto* input = static_cast<QTouchEvent*>(event);
        event->accept();
        if (type == QEvent::TouchCancel) { reset(); return true; }
        // A fresh gesture can arrive before the final coalesced frame fires.
        if (type == QEvent::TouchBegin && m_finishingPinch && m_down.isEmpty()) {
            evaluatePinch(); reset();
        }
        if (m_owner && (m_device != input->device() || m_owner->window() != viewer->window()))
            reset();
        if (!m_owner && type != QEvent::TouchBegin) return true;
        if (!m_owner) { m_owner = viewer; m_device = input->device(); }
        const auto updatePoint = [this](int id, QPointF position, bool released, bool stationary) {
            if (released && !m_points.contains(id)) return;
            // Stationary contacts can be snapshots from another native
            // waveform window. Never overwrite their latest moving position.
            if (!stationary || !m_points.contains(id)) m_points.insert(id, position);
            if (released) m_down.remove(id);
            else if (!m_finishingPinch) m_down.insert(id);
        };
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
        for (const auto& point : input->points()) {
            updatePoint(point.id(), point.globalPosition(),
                    point.state() == QEventPoint::State::Released,
                    point.state() == QEventPoint::State::Stationary);
        }
#else
        for (const auto& point : input->touchPoints()) {
            updatePoint(point.id(), point.screenPos(), point.state() == Qt::TouchPointReleased,
                    point.state() == Qt::TouchPointStationary);
        }
#endif
        if (!m_multiTouch) {
            for (auto point = m_points.begin(); point != m_points.end();) {
                if (!m_down.contains(point.key())) point = m_points.erase(point);
                else ++point;
            }
        }
        if (m_down.isEmpty()) {
            if (m_multiTouch && !m_pinchFinished) { m_finishingPinch = true; queuePinch(); }
            else reset();
            return true;
        }
        if (m_multiTouch && m_down.size() < 2) {
            releaseScrub(); m_finishingPinch = true;
            if (!m_pinchFinished) queuePinch();
            return true;
        }
        if (m_down.size() >= 2) {
            releaseScrub();
            m_multiTouch = true;
            if (m_down.size() != 2) { m_pinchFinished = true; m_frame.stop(); return true; }
            if (m_pinchFinished || m_finishingPinch) return true;
            if (m_initialSpan <= 0) {
                m_initialSpan = QLineF(m_points.first(), m_points.last()).length();
                m_initialZoom = m_lastZoom = ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom"));
            }
            queuePinch();
            return true;
        }
        // After a pinch, the remaining finger must never become a scrub.
        if (m_multiTouch || !m_owner) return true;
        const auto position = m_points.first();
        if (!m_hasOrigin) { m_origin = position; m_hasOrigin = true; return true; }
        if (m_owner->isPlaying()) { releaseScrub(); return true; }
        if (!m_scrubbing && QLineF(m_origin, position).length() >= 10) {
            sendMouse(QEvent::MouseButtonPress, m_origin);
            m_scrubbing = true;
        }
        if (m_scrubbing) sendMouse(QEvent::MouseMove, position);
        return true;
    }

  private:
    explicit CraniumWaveformTouchRouter(QObject* parent) : QObject(parent) {
        m_frame.setSingleShot(true);m_frame.setInterval(12);
        connect(&m_frame, &QTimer::timeout, this, [this] { evaluatePinch(); });
        qApp->installEventFilter(this);
    }
    WWaveformViewer* viewerFor(QObject* target) const {
        for (const auto& viewer : m_viewers) {
            if (!viewer || !viewer->m_craniumTouchZoom) continue;
            if (target == viewer) return viewer;
            auto* waveform = viewer->m_waveformWidget;
            if (!waveform) continue;
            if (auto* widget = qobject_cast<QWidget*>(target)) {
                if (widget == waveform->getWidget() || waveform->getWidget()->isAncestorOf(widget))
                    return viewer;
            }
#ifdef MIXXX_USE_QOPENGL
            if (auto* gl = waveform->getGLWidget(); gl && gl->getOpenGLWindow() == target)
                return viewer;
#endif
        }
        return nullptr;
    }
    void queuePinch() {
        if (!m_frame.isActive()) m_frame.start();
    }
    static double zoomLevel(double current, double desired) {
        // Coarse far-out levels provide useful magnification changes. Keep
        // the original single levels close up, with hysteresis at boundaries.
        constexpr std::array<double, 8> levels{1, 2, 3, 4, 5, 6, 8, 10};
        desired = qBound(1.0, desired, 10.0);
        for (int pass = 0; pass < 10; ++pass) {
            double lower = current, upper = current;
            for (const auto level : levels) {
                if (level < current) lower = level;
                else if (level > current) { upper = level; break; }
            }
            if (lower < current && desired < (lower + current) / 2 - (current - lower) * 0.08) {
                current = lower;
            } else if (upper > current && desired > (upper + current) / 2 + (upper - current) * 0.08) {
                current = upper;
            } else break;
        }
        return current;
    }
    void evaluatePinch() {
        if (!m_owner || !m_multiTouch || m_pinchFinished || m_points.size() != 2 || m_initialSpan <= 0)
            return;
        const double span = QLineF(m_points.first(), m_points.last()).length();
        if (span > 1 && std::isfinite(span)) {
            const auto current = ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom"));
            if (current != m_lastZoom) {
                // Respect a wheel/controller zoom change during a gesture.
                m_initialZoom = m_lastZoom = current; m_initialSpan = span;
            } else if (m_anyZoom || std::abs(span - m_initialSpan) >= 4) {
                const auto target = zoomLevel(current, m_initialZoom * m_initialSpan / span);
                if (target != current) {
                    m_owner->setSharedWaveformZoom(target);
                    m_lastZoom = target; m_anyZoom = true;
                }
            }
        }
        if (m_finishingPinch) {
            m_pinchFinished = true;
            if (m_down.isEmpty()) reset();
        }
    }
    void sendMouse(QEvent::Type type, QPointF global) {
        if (!m_owner) return;
        const QPointF local = m_owner->mapFromGlobal(global.toPoint());
        QMouseEvent mouse(type, local, global,
                type == QEvent::MouseMove ? Qt::NoButton : Qt::LeftButton,
                type == QEvent::MouseButtonRelease ? Qt::NoButton : Qt::LeftButton,
                Qt::NoModifier);
        // Call the handlers directly so these deliberate paused scrubs do not
        // pass through the filter that rejects synthetic touch/mouse duplicates.
        if (type == QEvent::MouseButtonPress) m_owner->mousePressEvent(&mouse);
        else if (type == QEvent::MouseMove) m_owner->mouseMoveEvent(&mouse);
        else m_owner->mouseReleaseEvent(&mouse);
    }
    void releaseScrub() {
        if (m_scrubbing && m_owner) sendMouse(QEvent::MouseButtonRelease, m_points.isEmpty() ? m_origin : m_points.first());
        m_scrubbing = false;
    }
    void reset() {
        releaseScrub(); m_frame.stop(); m_owner.clear(); m_points.clear(); m_down.clear(); m_device = nullptr;
        m_initialSpan = 0; m_initialZoom = m_lastZoom = 0; m_hasOrigin = false; m_multiTouch = false;
        m_anyZoom = false; m_finishingPinch = false; m_pinchFinished = false;
    }
    QList<QPointer<WWaveformViewer>> m_viewers;
    QPointer<WWaveformViewer> m_owner;
    const void* m_device = nullptr;
    QMap<int, QPointF> m_points;
    QSet<int> m_down;
    QTimer m_frame;
    QPointF m_origin;
    double m_initialSpan = 0, m_initialZoom = 0, m_lastZoom = 0;
    bool m_hasOrigin = false, m_multiTouch = false, m_scrubbing = false;
    bool m_anyZoom = false, m_finishingPinch = false, m_pinchFinished = false;
};

WWaveformViewer::WWaveformViewer(
        const QString& group,
        UserSettingsPointer pConfig,
        QWidget* parent)
        : WWidget(parent),
          m_group(group),
          m_pConfig(pConfig),
          m_zoomZoneWidth(20),
          m_bScratching(false),
          m_bBending(false),
          m_pCueMenuPopup(make_parented<WCueMenuPopup>(pConfig, this)),
          m_waveformWidget(nullptr) {
    setMouseTracking(true);
    setAcceptDrops(true);
    m_pZoom = new ControlProxy(group, "waveform_zoom", this, ControlFlag::NoAssertIfMissing);
    m_pZoom->setObjectName("WaveformZoomControl");
    m_pZoom->connectValueChanged(this, &WWaveformViewer::onZoomChange);

    m_pScratchPositionEnable = new ControlProxy(
            group, "scratch_position_enable", this, ControlFlag::NoAssertIfMissing);
    m_pScratchPosition = new ControlProxy(
            group, "scratch_position", this, ControlFlag::NoAssertIfMissing);
    m_pWheel = new ControlProxy(
            group, "wheel", this, ControlFlag::NoAssertIfMissing);
    m_pPlayEnabled = new ControlProxy(group, "play", this, ControlFlag::NoAssertIfMissing);
    m_pPlayEnabled->setObjectName("WaveformPlayControl");
    m_pPlayEnabled->connectValueChanged(this, [this](double value) {
        if (m_craniumTouchZoom && value > 0 && (m_bScratching || m_bBending))
            mouseReleaseEvent(nullptr);
    });
    m_pPassthroughEnabled = make_parented<ControlProxy>(group, "passthrough", this);
    m_pPassthroughEnabled->connectValueChanged(this, &WWaveformViewer::passthroughChanged);

    setAttribute(Qt::WA_OpaquePaintEvent);
    setFocusPolicy(Qt::NoFocus);
}

void WWaveformViewer::paintEvent(QPaintEvent* event) {
    if(m_craniumTouchZoom && qEnvironmentVariableIsSet("CRANIUM_APPLIANCE")) {
        QPainter painter(this);painter.fillRect(event->rect(),Qt::black);
    } else WWidget::paintEvent(event);
}

WWaveformViewer::~WWaveformViewer() {
    if (m_craniumTouchZoom) CraniumWaveformTouchRouter::instance()->forgetViewer(this);
    //qDebug() << "~WWaveformViewer";
}

void WWaveformViewer::setup(const QDomNode& node, const SkinContext& context) {
    m_rx3SharedWheelZoom = context.selectBool(node, "Rx3SharedWheelZoom", false);
    m_craniumTouchZoom = m_rx3SharedWheelZoom && context.selectBool(node, "CraniumPinchZoom", false);
    if (m_craniumTouchZoom) {
        setAttribute(Qt::WA_AcceptTouchEvents);
        CraniumWaveformTouchRouter::instance()->addViewer(this);
    }
    if (m_waveformWidget) {
        m_waveformWidget->setup(node, context);
        if (m_referenceScale > 0) m_waveformWidget->setReferenceScale(m_referenceScale);
        m_dimBrightThreshold = m_waveformWidget->getDimBrightThreshold();
    }
}

void WWaveformViewer::resizeEvent(QResizeEvent* event) {
    Q_UNUSED(event);
    if (m_waveformWidget) {
        // Note m_waveformWidget is a WaveformWidgetAbstract,
        // so this calls the method of WaveformWidgetAbstract,
        // note of the derived waveform widgets which are also
        // a QWidget, though that will be called directly.
        m_waveformWidget->resize(width(), height());
    }
}

void WWaveformViewer::showEvent(QShowEvent* event) {
    Q_UNUSED(event);
    if (m_waveformWidget) {
        // We leave it up to Qt to set the size of the derived
        // waveform widget, but we still need to set the size
        // of the renderer.
        m_waveformWidget->resizeRenderer(
                width(), height(), static_cast<float>(devicePixelRatioF()));
    }
}

void WWaveformViewer::hideEvent(QHideEvent* event) {
    if (m_craniumTouchZoom) {
        CraniumWaveformTouchRouter::instance()->forgetViewer(this);
        mouseReleaseEvent(nullptr);
    }
    WWidget::hideEvent(event);
}

void WWaveformViewer::mousePressEvent(QMouseEvent* event) {
    if (m_craniumTouchZoom && isPlaying()) { event->accept(); return; }
    if (!m_waveformWidget || m_waveformWidget->getType() == WaveformWidgetType::EmptyWaveform) {
        return;
    }

    m_mouseAnchor = event->pos();

    if (event->button() == Qt::LeftButton) {
        // If we are pitch-bending then disable and reset because the two
        // shouldn't be used at once.
        if (m_bBending) {
            m_pWheel->setParameter(0.5);
            m_bBending = false;
        }
        m_bScratching = true;
        int eventPosValue = m_waveformWidget->getOrientation() == Qt::Horizontal ?
                    event->pos().x() : event->pos().y();
        double audioSamplePerPixel = m_waveformWidget->getAudioSamplePerPixel();
        double targetPosition = -1.0 * eventPosValue * audioSamplePerPixel * 2;
        m_pScratchPosition->set(targetPosition);
        m_pScratchPositionEnable->set(1.0);
    } else if (event->button() == Qt::RightButton) {
        const auto currentTrack = m_waveformWidget->getTrackInfo();
        if (!isPlaying() && m_pHoveredMark) {
            auto cueAtClickPos = getCuePointerFromCueMark(m_pHoveredMark);
            if (cueAtClickPos) {
                m_pCueMenuPopup->setTrackCueGroup(currentTrack, cueAtClickPos, m_group);
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
                m_pCueMenuPopup->popup(event->globalPosition().toPoint());
#else
                m_pCueMenuPopup->popup(event->globalPos());
#endif
            }
        } else {
            // If we are scratching then disable and reset because the two shouldn't
            // be used at once.
            if (m_bScratching) {
                m_pScratchPositionEnable->set(0.0);
                m_bScratching = false;
            }
            m_pWheel->setParameter(0.5);
            m_bBending = true;
        }
    }

    // Set the cursor to a hand while the mouse is down (when cue menu is not open).
    if (!m_pCueMenuPopup->isVisible()) {
        setCursor(Qt::ClosedHandCursor);
    }
}

void WWaveformViewer::mouseMoveEvent(QMouseEvent* event) {
    if (m_craniumTouchZoom && isPlaying()) {
        mouseReleaseEvent(nullptr);
        event->accept(); return;
    }
    if (!m_waveformWidget || m_waveformWidget->getType() == WaveformWidgetType::EmptyWaveform) {
        return;
    }

    // Only send signals for mouse moving if the left button is pressed
    if (m_bScratching) {
        int eventPosValue = m_waveformWidget->getOrientation() == Qt::Horizontal ?
                    event->pos().x() : event->pos().y();
        // Adjusts for one-to-one movement.
        double audioSamplePerPixel = m_waveformWidget->getAudioSamplePerPixel();
        double targetPosition = -1.0 * eventPosValue * audioSamplePerPixel * 2;
        //qDebug() << "Target:" << targetPosition;
        m_pScratchPosition->set(targetPosition);
    } else if (m_bBending) {
        QPoint diff = event->pos() - m_mouseAnchor;
        int diffValue = m_waveformWidget->getOrientation() == Qt::Horizontal ?
                    diff.x() : diff.y();
        // Start at the middle of [0.0, 1.0], and emit values based on how far
        // the mouse has traveled horizontally. Note, for legacy (MIDI) reasons,
        // this is tuned to 127.
        // NOTE(rryan): This is basically a direct connection to the "wheel"
        // control since we manually connect it in LegacySkinParser regardless
        // of whether the skin specifies it. See ControlTTRotaryBehavior to see
        // where this value is handled.
        double v = 0.5 + (diffValue / 1270.0);
        // clamp to [0.0, 1.0]
        v = math_clamp(v, 0.0, 1.0);
        m_pWheel->setParameter(v);
    } else if (!isPlaying()) {
        WaveformMarkPointer pMark;
        pMark = m_waveformWidget->getCueMarkAtPoint(event->pos());
        if (pMark && getCuePointerFromCueMark(pMark)) {
            if (!m_pHoveredMark) {
                m_pHoveredMark = pMark;
                highlightMark(pMark);
            } else if (pMark != m_pHoveredMark) {
                unhighlightMark(m_pHoveredMark);
                m_pHoveredMark = pMark;
                highlightMark(pMark);
            }
        } else {
            if (m_pHoveredMark) {
                unhighlightMark(m_pHoveredMark);
                m_pHoveredMark = nullptr;
            }
        }
    }
}

void WWaveformViewer::mouseReleaseEvent(QMouseEvent* /*event*/) {
    if (m_bScratching) {
        m_pScratchPositionEnable->set(0.0);
        m_bScratching = false;
    }
    if (m_bBending) {
        m_pWheel->setParameter(0.5);
        m_bBending = false;
    }
    m_mouseAnchor = QPoint();

    // Set the cursor back to an arrow.
    setCursor(Qt::ArrowCursor);
}

void WWaveformViewer::setSharedWaveformZoom(double zoom) {
    zoom = qBound(WaveformWidgetRenderer::s_waveformMinZoom, zoom,
            WaveformWidgetRenderer::s_waveformMaxZoom);
    ControlObject::set(ConfigKey("[Channel1]", "waveform_zoom"), zoom);
    ControlObject::set(ConfigKey("[Channel2]", "waveform_zoom"), zoom);
}

void WWaveformViewer::wheelEvent(QWheelEvent* event) {
    if (m_rx3SharedWheelZoom) {
        // Wheel gestures have one function on the RX3: shared waveform zoom.
        // Consume modifiers/horizontal gestures too, without forwarding them
        // to another widget or touching playback, pitch or the selected grid.
        const int delta = event->angleDelta().y() != 0 ? event->angleDelta().y()
                                                     : event->pixelDelta().y();
        if (delta != 0) {
            const auto reference = ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom"));
            setSharedWaveformZoom(reference + (delta > 0 ? -1.0 : 1.0));
        }
        event->accept();
        return;
    }
    if (m_waveformWidget) {
        if (event->angleDelta().y() > 0) {
            onZoomChange(m_waveformWidget->getZoomFactor() / 1.05);
        } else if (event->angleDelta().y() < 0) {
            onZoomChange(m_waveformWidget->getZoomFactor() * 1.05);
        }
    }
}

void WWaveformViewer::dragEnterEvent(QDragEnterEvent* pEvent) {
    DragAndDropHelper::handleTrackDragEnterEvent(pEvent, m_group, m_pConfig);
}

void WWaveformViewer::dropEvent(QDropEvent* pEvent) {
    DragAndDropHelper::handleTrackDropEvent(pEvent, *this, m_group, m_pConfig);
}

bool WWaveformViewer::handleDragAndDropEventFromWindow(QEvent* pEvent) {
    return event(pEvent);
}

void WWaveformViewer::leaveEvent(QEvent*) {
    if (m_pHoveredMark) {
        unhighlightMark(m_pHoveredMark);
        m_pHoveredMark = nullptr;
    }
}

void WWaveformViewer::slotTrackLoaded(TrackPointer track) {
    if (m_waveformWidget) {
        m_waveformWidget->setTrack(track);
    }
}

void WWaveformViewer::slotLoadingTrack(TrackPointer pNewTrack, TrackPointer pOldTrack) {
    Q_UNUSED(pNewTrack);
    Q_UNUSED(pOldTrack);
    if (m_waveformWidget) {
        m_waveformWidget->setTrack(TrackPointer());
    }
}

void WWaveformViewer::onZoomChange(double zoom) {
    //qDebug() << "WaveformWidgetRenderer::onZoomChange" << this << zoom;
    setZoom(zoom);
    // notify back the factory to sync zoom if needed
    WaveformWidgetFactory::instance()->notifyZoomChange(this);
}

void WWaveformViewer::setZoom(double zoom) {
    //qDebug() << "WaveformWidgetRenderer::setZoom" << zoom;
    if (m_waveformWidget) {
        m_waveformWidget->setZoom(zoom);
    }

    // If multiple waveform widgets for the same group are created then it's
    // possible that this setZoom() is coming from another waveform with the
    // same group. That means that if we set the zoom control here, that
    // waveform will receive the update as a call to onZoomChange which will in
    // turn notify the WaveformWidgetFactory that zoom changed which will
    // infinite loop because we will receive another setZoom() from
    // WaveformWidgetFactory. To prevent this recursion, check for no-ops.
    if (m_pZoom->get() != zoom) {
        m_pZoom->set(zoom);
    }
}

void WWaveformViewer::setDisplayBeatGridAlpha(int alpha) {
    if (m_waveformWidget) {
        m_waveformWidget->setDisplayBeatGridAlpha(alpha);
    }
}

void WWaveformViewer::setPlayMarkerPosition(double position) {
    if (m_waveformWidget) {
        m_waveformWidget->setPlayMarkerPosition(position);
    }
}

void WWaveformViewer::setWaveformWidget(WaveformWidgetAbstract* waveformWidget) {
    if (m_craniumTouchZoom) CraniumWaveformTouchRouter::instance()->forgetViewer(this);
    if (m_waveformWidget) {
        QWidget* pWidget = m_waveformWidget->getWidget();
        disconnect(pWidget);
    }
    m_waveformWidget = waveformWidget;
    if (m_waveformWidget) {
        QWidget* pWidget = m_waveformWidget->getWidget();
        DEBUG_ASSERT(pWidget);
        connect(pWidget,
                &QWidget::destroyed,
                this,
                [this]() {
                    // The pointer must be considered as dangling!
                    m_waveformWidget = nullptr;
                });
        m_waveformWidget->getWidget()->setMouseTracking(true);
#ifdef MIXXX_USE_QOPENGL
        if (m_waveformWidget->getGLWidget()) {
            // The OpenGLWindow used to display the waveform widget interferes with the
            // normal Qt tooltip mechanism and uses it's own mechanism. We set the tooltip
            // of the waveform widget to the tooltip of its parent WWaveformViewer so the
            // OpenGLWindow will display it.
            m_waveformWidget->getGLWidget()->setToolTip(toolTip());

            // Tell the WGLWidget that this is its drag&drop target
            m_waveformWidget->getGLWidget()->setTrackDropTarget(this);
        }
#endif
        // Make connection to show "Passthrough" label on the waveform, except for
        // "Empty" waveform type
        if (m_waveformWidget->getType() == WaveformWidgetType::EmptyWaveform) {
            return;
        }
        connect(this,
                &WWaveformViewer::passthroughChanged,
                this,
                [this](double value) {
                    m_waveformWidget->setPassThroughEnabled(value > 0);
                });
        // Make sure the label is shown after the waveform type was changed
        emit passthroughChanged(m_pPassthroughEnabled->toBool());
    }
}

CuePointer WWaveformViewer::getCuePointerFromCueMark(WaveformMarkPointer pMark) const {
    if (m_waveformWidget && pMark) {
        return m_waveformWidget->getCuePointerFromIndex(pMark->getHotCue());
    }
    return {};
}

void WWaveformViewer::highlightMark(WaveformMarkPointer pMark) {
    QColor highlightColor = Color::chooseContrastColor(pMark->fillColor(),
            m_dimBrightThreshold);
    pMark->setBaseColor(highlightColor, m_dimBrightThreshold);
}

void WWaveformViewer::unhighlightMark(WaveformMarkPointer pMark) {
    auto pCue = getCuePointerFromCueMark(pMark);
    if (pCue) {
        QColor originalColor = mixxx::RgbColor::toQColor(pCue->getColor());
        pMark->setBaseColor(originalColor, m_dimBrightThreshold);
    }
}

bool WWaveformViewer::isPlaying() const {
    return m_pPlayEnabled->toBool();
}

void WWaveformViewer::setReferenceScale(double scale) {
    m_referenceScale = scale;
    if (m_waveformWidget) m_waveformWidget->setReferenceScale(scale);
}
