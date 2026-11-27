#pragma once

#include <QElapsedTimer>
#include <QPainter>
#include <QPainterPath>
#include <QTimer>
#include <memory>

#include "control/controlproxy.h"
#include "skin/legacy/skincontext.h"
#include "widget/wlabel.h"

namespace rx3 {
// Pioneer documents the waves, but not their cadence. Keep the approximation
// explicit and independent of BPM: both fixed wave pairs blink together.
inline constexpr int kDeckWaveStageMs = 400;
inline int deckWaveStage(bool playing, qint64 elapsedMs) {
    return playing ? 1 - (qMax(qint64(0), elapsedMs) / kDeckWaveStageMs) % 2 : 0;
}
inline void drawDeckBadge(QPainter* painter, const QRectF& rect, int deck, int stage, bool slipEnabled=false, bool slipLit=true) {
    painter->save();
    const qreal scale = qMin(rect.width() / 92, rect.height() / 52);
    painter->translate(rect.center().x() - 46 * scale,
            rect.center().y() - 23 * scale);
    painter->scale(scale, scale);
    painter->setRenderHint(QPainter::Antialiasing);
    QFont font("Arial");
    font.setPixelSize(12);
    painter->setFont(font);
    painter->setPen(Qt::white);
    painter->drawText(QRectF(0, 1, 92, 14), Qt::AlignCenter, QStringLiteral("DECK"));
    if (slipEnabled) {
        QFont slipFont("Arial");slipFont.setPixelSize(8);painter->setFont(slipFont);
        painter->setPen(slipLit ? QColor("#FFFF00") : QColor("#555500"));
        painter->drawText(QRectF(66,2,26,11),Qt::AlignCenter,QStringLiteral("SLIP"));
        painter->setPen(Qt::white);
    }
    font.setPixelSize(26);
    font.setBold(false);
    painter->setFont(font);
    painter->drawText(QRectF(0, 13, 92, 31), Qt::AlignCenter, QString::number(deck));
    painter->setPen(QPen(QColor("#F84418"), 1.4, Qt::SolidLine, Qt::RoundCap));
    painter->setBrush(Qt::NoBrush);
    for (int wave = 0; wave < (stage > 0 ? 2 : 0); ++wave) {
        for (int side : {-1, 1}) {
            const qreal x = 46 + side * (12 + wave * 4);
            const qreal bulge = x + side * 4;
            const qreal halfHeight = 6 + wave * 3;
            QPainterPath path;
            path.moveTo(x, 29 - halfHeight);
            path.cubicTo(bulge, 29 - halfHeight * 0.4,
                    bulge, 29 + halfHeight * 0.4, x, 29 + halfHeight);
            painter->drawPath(path);
        }
    }
    painter->restore();
}
} // namespace rx3

class WRx3DeckBadge : public WLabel {
  public:
    explicit WRx3DeckBadge(QWidget* parent = nullptr) : WLabel(parent) {
        m_timer.setInterval(40);
        connect(&m_timer, &QTimer::timeout, this, [this] { update(); });
    }
    void setup(const QDomNode& node, const SkinContext& context) override {
        WLabel::setup(node, context);
        m_deck = context.selectString(node, "Channel").toInt();
        const QString group = QStringLiteral("[Channel%1]").arg(m_deck);
        m_play = std::make_unique<ControlProxy>(group, "play", this, ControlFlag::NoAssertIfMissing);
        m_loaded = std::make_unique<ControlProxy>(group, "track_loaded", this, ControlFlag::NoAssertIfMissing);
        m_play->connectValueChanged(this, [this](double) { refreshPlayback(); });
        m_loaded->connectValueChanged(this, [this](double) { refreshPlayback(); });
        m_slip = std::make_unique<ControlProxy>(group, "slip_enabled", this, ControlFlag::NoAssertIfMissing);
        m_slipIndicator = std::make_unique<ControlProxy>(group, "slip_indicator", this, ControlFlag::NoAssertIfMissing);
        m_slip->connectValueChanged(this, [this](double) { update(); });
        m_slipIndicator->connectValueChanged(this, [this](double) { update(); });
        refreshPlayback();
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        WLabel::paintEvent(event);
        QPainter painter(this);
        rx3::drawDeckBadge(&painter, rect(), m_deck,
                rx3::deckWaveStage(m_playing, m_elapsed.isValid() ? m_elapsed.elapsed() : 0), m_slip && m_slip->get()>0,
                m_slipIndicator && m_slipIndicator->get()>0);
    }
  private:
    void refreshPlayback() {
        const bool playing = m_play && m_loaded && m_play->get() > 0 && m_loaded->get() > 0;
        if (playing == m_playing) return;
        m_playing = playing;
        if (playing) {
            m_elapsed.start();
            m_timer.start();
        } else {
            m_timer.stop();
            m_elapsed.invalidate();
        }
        update();
    }
    QTimer m_timer;
    QElapsedTimer m_elapsed;
    std::unique_ptr<ControlProxy> m_play;
    std::unique_ptr<ControlProxy> m_loaded;
    std::unique_ptr<ControlProxy> m_slip;
    std::unique_ptr<ControlProxy> m_slipIndicator;
    int m_deck = 1;
    bool m_playing = false;
};
