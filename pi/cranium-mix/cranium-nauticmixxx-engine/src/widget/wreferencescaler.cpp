#include "widget/wreferencescaler.h"

#include <QLayout>
#include <QMouseEvent>
#include <QRegularExpression>
#include <QResizeEvent>
#include <QTimer>
#include <QWindow>
#include <algorithm>
#include <cmath>

#include "widget/wwaveformviewer.h"
#include "widget/woverview.h"
#include "widget/whotcuebutton.h"

namespace {
QString scaleStyle(const QString& original, double scale) {
    // Only lengths are transformed: never colors, control values, or selectors.
    static const QRegularExpression pixels(QStringLiteral("(-?\\d+(?:\\.\\d+)?)px"));
    static const QRegularExpression spacing(
            QStringLiteral("(qproperty-layoutSpacing:\\s*)(-?\\d+)"));
    auto replace = [scale](const QString& text, const QRegularExpression& expression,
                           bool isSpacing) -> QString {
        QString result;
        qsizetype cursor = 0;
        auto matches = expression.globalMatch(text);
        while (matches.hasNext()) {
            const auto match = matches.next();
            result += text.mid(cursor, match.capturedStart() - cursor);
            if (isSpacing) result += match.captured(1);
            const double value = match.captured(isSpacing ? 2 : 1).toDouble();
            result += QString::number(value == QWIDGETSIZE_MAX ? QWIDGETSIZE_MAX : qRound(value * scale));
            if (!isSpacing) result += QStringLiteral("px");
            cursor = match.capturedEnd();
        }
        return result + text.mid(cursor);
    };
    return replace(replace(original, pixels, false), spacing, true);
}
QSize scaledConstraint(QSize size, double scale) {
    auto dimension = [scale](int value) {
        return value == QWIDGETSIZE_MAX ? value : qRound(value * scale);
    };
    return QSize(dimension(size.width()), dimension(size.height()));
}
}

WReferenceScaler::WReferenceScaler(QWidget* canvas, QSize referenceSize, QWidget* parent,
        bool fillWindow)
        : QWidget(parent), m_canvas(canvas), m_referenceSize(referenceSize),
          m_fillWindow(fillWindow) {
    setObjectName(QStringLiteral("RX3ReferenceViewport"));
    setAutoFillBackground(true);
    QPalette colors = palette();
    colors.setColor(QPalette::Window, Qt::black);
    setPalette(colors);
    setMinimumSize(referenceSize / 2);
    canvas->setParent(this);
    canvas->installEventFilter(this);
    m_skinContainer = canvas->findChild<QWidget*>(QStringLiteral("SkinContainer"));
    if (m_skinContainer) m_skinContainer->installEventFilter(this);
    canvas->resize(referenceSize);
    canvas->ensurePolished();
    auto widgets = canvas->findChildren<QWidget*>();
    widgets.prepend(canvas);
    for (QWidget* widget : widgets) {
        if (widget->isWindow()) continue;
        widget->ensurePolished();
        m_metrics.push_back({widget, widget->minimumSize(), widget->maximumSize(),
                widget->font(), qobject_cast<WHotcueButton*>(widget) ? QString() : widget->styleSheet()});
    }
    resize(referenceSize);
    applyScale();
}

bool WReferenceScaler::startWindowMove() {
    auto* handle = window()->windowHandle();
    return handle && handle->startSystemMove();
}

void WReferenceScaler::finishWindowDrag() {
    if (!m_dragging) return;
    m_dragging = false;
    releaseMouse();
}

bool WReferenceScaler::handleWindowDrag(QEvent* event) {
    auto* topLevel = window();
    const bool movable = topLevel->windowFlags().testFlag(Qt::FramelessWindowHint) &&
            !topLevel->isFullScreen() && !topLevel->isMaximized();
    if (!movable || event->type() == QEvent::Hide ||
            event->type() == QEvent::UngrabMouse) {
        finishWindowDrag();
        return false;
    }
    if (event->type() != QEvent::MouseButtonPress &&
            event->type() != QEvent::MouseMove &&
            event->type() != QEvent::MouseButtonRelease) return false;
    auto* mouse = static_cast<QMouseEvent*>(event);
    const QPoint global = mouse->globalPosition().toPoint();
    if (event->type() == QEvent::MouseButtonPress) {
        const QPoint local = topLevel->mapFromGlobal(global);
        const auto* child = m_canvas->childAt(m_canvas->mapFromGlobal(global));
        // Only the existing empty top margin is draggable. Never intercept a
        // child control, even if scaling brings REMAIN into the first 10 px.
        if (mouse->button() != Qt::LeftButton || local.y() < 0 || local.y() >= 10 ||
                local.x() < 10 || local.x() >= topLevel->width() - 10 ||
                (child && child != m_skinContainer)) return false;
        if (!startWindowMove()) {
            m_dragOffset = global - topLevel->pos();
            m_dragging = true;
            grabMouse();
        }
    } else {
        if (!m_dragging) return false;
        if (event->type() == QEvent::MouseButtonRelease ||
                !mouse->buttons().testFlag(Qt::LeftButton)) {
            finishWindowDrag();
        } else {
            topLevel->move(global - m_dragOffset);
        }
    }
    mouse->accept();
    return true;
}

bool WReferenceScaler::event(QEvent* event) {
    if (handleWindowDrag(event)) return true;
    return QWidget::event(event);
}

bool WReferenceScaler::eventFilter(QObject* watched, QEvent* event) {
    if ((watched == m_canvas || watched == m_skinContainer) &&
            handleWindowDrag(event)) return true;
    return QWidget::eventFilter(watched, event);
}

void WReferenceScaler::resizeEvent(QResizeEvent* event) {
    QWidget::resizeEvent(event);
    if (m_pending) return;
    m_pending = true;
    QTimer::singleShot(0, this, [this] {
        m_pending = false;
        applyScale();
    });
}

void WReferenceScaler::applyScale() {
    const double factor = std::min(width() / double(m_referenceSize.width()),
            height() / double(m_referenceSize.height()));
    if (factor <= 0) return;
    const QSize target = m_fillWindow ? size() :
            QSize(qRound(m_referenceSize.width() * factor),
                    qRound(m_referenceSize.height() * factor));
    if (std::abs(m_scale - factor) > 0.0001) {
        m_scale = factor;
        m_canvas->setUpdatesEnabled(false);
        // Clear constraints first so previous scaled minimums cannot prevent
        // shrinking. Restore from immutable reference metrics, never from the
        // previous frame (avoids cumulative rounding/font-size drift).
        for (const auto& metric : m_metrics) {
            if (!metric.widget) continue;
            metric.widget->setMinimumSize(0, 0);
            metric.widget->setMaximumSize(QWIDGETSIZE_MAX, QWIDGETSIZE_MAX);
        }
        for (const auto& metric : m_metrics) {
            auto* widget = metric.widget.data();
            if (!widget) continue;
            QFont font = metric.font;
            if (font.pixelSize() > 0) font.setPixelSize(std::max(1, qRound(font.pixelSize() * factor)));
            else if (font.pointSizeF() > 0) font.setPointSizeF(font.pointSizeF() * factor);
            widget->setFont(font);
            widget->setMinimumSize(scaledConstraint(metric.minimum, factor));
            widget->setMaximumSize(scaledConstraint(metric.maximum, factor));
            if (!metric.style.isEmpty()) widget->setStyleSheet(scaleStyle(metric.style, factor));
            if (auto* waveform = qobject_cast<WWaveformViewer*>(widget)) {
                waveform->setReferenceScale(factor);
            }
            if (auto* overview = qobject_cast<WOverview*>(widget)) {
                overview->setReferenceScale(factor);
            }
            widget->updateGeometry();
        }
        m_canvas->setUpdatesEnabled(true);
        setProperty("referenceScale", factor);
    }
    // A wider window may keep the same scale. Resize the flexible layout even
    // then, so waveforms use the whole viewport without stretching the fonts.
    m_canvas->setFixedSize(target);
    m_canvas->move((width() - target.width()) / 2, (height() - target.height()) / 2);
}
