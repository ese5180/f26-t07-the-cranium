#pragma once

#include <QPainter>
#include <QList>
#include <QString>
#include "waveform/rekordboxwaveform.h"
#include "waveform/widgets/waveformwidgettype.h"

namespace rx3 {
struct OverviewGeometry {
    qreal signalBottom;
    qreal axisTop;
    qreal axisThickness;
    qreal ticksTop;
    qreal ticksHeight;
};
inline OverviewGeometry overviewGeometry(qreal height, qreal scale = 1) {
    const qreal axisTop = qMax(qreal(0), height - 16*scale);
    return {qMax(qreal(0),axisTop-4*scale),axisTop,3*scale,
            axisTop+6*scale,10*scale};
}
inline bool overviewWarningOff(double seconds,bool playing,qint64 elapsedMs,
        double warningSeconds=30) {
    if(!playing || !std::isfinite(seconds) || !std::isfinite(warningSeconds) ||
            warningSeconds<=0 || seconds<=0 || seconds>=warningSeconds) return false;
    const int halfPeriod=seconds<15?125:250;
    return (elapsedMs/halfPeriod)%2!=0;
}
inline void drawOverviewShade(QPainter* painter,qreal width,qreal height,qreal scale,
        double position,bool remaining,bool blinkOff) {
    const auto g=overviewGeometry(height,scale);
    const qreal x=width*std::clamp(std::isfinite(position)?position:0.0,0.0,1.0);
    const qreal top=qMin(g.signalBottom,12*scale);
    painter->fillRect(QRectF(remaining?0:x,top,remaining?x:width-x,
            qMax(qreal(0),g.signalBottom-top)),QColor(0,0,0,153));
    if(blinkOff) painter->fillRect(QRectF(remaining?x:0,top,remaining?width-x:x,
            qMax(qreal(0),g.signalBottom-top)),QColor(0,0,0,153));
}
inline qreal overviewTimeX(double seconds, double duration, qreal width) {
    if (!(duration>0) || !std::isfinite(duration)) return 1;
    return 1 + qMax(qreal(0),width-2)*std::clamp(seconds/duration,0.0,1.0);
}
inline QString phraseName(mixxx::rekordbox::PhraseKind kind) {
    using Kind = mixxx::rekordbox::PhraseKind;
    switch (kind) {
    case Kind::Intro: return QStringLiteral("Intro");
    case Kind::Verse: return QStringLiteral("Verse");
    case Kind::Up: return QStringLiteral("Up");
    case Kind::Down: return QStringLiteral("Down");
    case Kind::Bridge: return QStringLiteral("Bridge");
    case Kind::Chorus: return QStringLiteral("Chorus / Drop");
    case Kind::Outro: return QStringLiteral("Outro");
    default: return QStringLiteral("Phrase");
    }
}
inline QColor phraseColor(mixxx::rekordbox::PhraseKind kind) {
    using Kind = mixxx::rekordbox::PhraseKind;
    switch (kind) {
    case Kind::Intro: return QColor(225,70,70);
    case Kind::Verse: return QColor(80,110,255);
    case Kind::Up: return QColor(140,50,255);
    case Kind::Down: return QColor(155,115,45);
    case Kind::Bridge: return QColor(225,215,65);
    case Kind::Chorus: return QColor(120,195,125);
    case Kind::Outro: return QColor(115,130,150);
    default: return QColor("#707070");
    }
}
inline QColor phraseColor(const mixxx::rekordbox::Phrase& phrase) {
    // Rekordbox's mood/kind palette, documented by Beat Link's Util.java.
    const auto kind=phrase.sourceKind;
    if (phrase.mood==3) {
        if (kind==1) return QColor(255,170,180);
        if (kind>=2 && kind<=4) return QColor(165,160,255);
        if (kind>=5 && kind<=7) return QColor(190,160,255);
        if (kind==8) return QColor(255,250,165);
        if (kind==9) return QColor(185,225,185);
        if (kind==10) return QColor(145,160,180);
    } else if (phrase.mood==2) {
        constexpr QRgb colors[]{qRgb(225,70,70),qRgb(80,110,255),qRgb(80,85,255),
                qRgb(100,80,255),qRgb(120,80,255),qRgb(140,80,255),qRgb(160,80,255),
                qRgb(225,215,65),qRgb(120,195,125),qRgb(115,130,150)};
        if (kind>=1 && kind<=10) return QColor(colors[kind-1]);
    } else if (phrase.mood==1) {
        if (kind==1) return phrase.k1==1?QColor(200,0,0):QColor(200,50,0);
        if (kind==2) return phrase.k2!=0?QColor(90,50,255):
                phrase.k3==0?QColor(140,50,255):QColor(105,50,255);
        if (kind==3) return QColor(155,115,45);
        if (kind==5) return QColor(15,170,0);
        if (kind==6) return phrase.k1==1?QColor(80,135,195):QColor(95,135,175);
    }
    return phraseColor(phrase.kind);
}
inline void drawOverviewDivisions(QPainter* painter, qreal width, qreal height,
        qreal scale, double duration, int mode,
        const QVector<mixxx::rekordbox::Phrase>& phrases = {},
        double playPosition = 0, bool remaining=false, bool blinkOff=false) {
    const auto g = overviewGeometry(height,scale);
    painter->save();
    painter->setRenderHint(QPainter::Antialiasing,false);
    painter->fillRect(QRectF(0,g.axisTop,width,g.axisThickness),
            QColor(blinkOff ? "#202020" : "#808080"));
    // Position, rather than playback history: seeking back restores the gray tail.
    const qreal playedWidth = std::isfinite(playPosition) ?
            width * std::clamp(playPosition,0.0,1.0) : 0;
    const qreal litStart=remaining?playedWidth:0;
    const qreal litWidth=remaining?width-playedWidth:playedWidth;
    if(litWidth>0 && !blinkOff) painter->fillRect(
            QRectF(litStart,g.axisTop,litWidth,g.axisThickness),Qt::white);
    if (duration > 0 && std::isfinite(duration)) {
        if (mode == 1 && !phrases.isEmpty()) {
            for (const auto& phrase : phrases) {
                const qreal left=overviewTimeX(phrase.startSeconds,duration,width);
                const qreal right=overviewTimeX(phrase.endSeconds,duration,width);
                if (right > left) painter->fillRect(QRectF(left,g.ticksTop,
                        qMax(qreal(0),right-left-scale),g.ticksHeight),phraseColor(phrase));
            }
        } else {
            // Source time: changing playback tempo must not move these ticks.
            for (int n=1; n<=int(std::min(duration/30.0,10000.0)); ++n) {
                const qreal x=overviewTimeX(n*30.0,duration,width);
                const bool minute=n%2==0;
                painter->fillRect(QRectF(x-(minute?scale:scale/2),g.ticksTop,
                        minute?2*scale:scale,minute?8*scale:5*scale),Qt::white);
            }
        }
    }
    painter->restore();
}
inline std::array<QRectF,2> overviewHotcueRects(qreal width, qreal height,
        qreal position, qreal scale = 1) {
    const qreal badge=10*scale;
    const qreal x=qBound(qreal(0),position-badge/2,qMax(qreal(0),width-badge));
    const auto g=overviewGeometry(height,scale);
    return {QRectF(x,0,badge,badge),
            QRectF(x,g.ticksTop,badge,badge)};
}
struct OverviewHotcue {
    int slot;
    qreal position;
    QColor color;
    QString label;
};
inline void drawOverviewHotcues(QPainter* painter, QList<OverviewHotcue> cues,
        qreal width, qreal height, qreal scale = 1) {
    std::stable_sort(cues.begin(),cues.end(),[](const auto& a,const auto& b) {
        return a.slot<b.slot;
    });
    painter->save();
    QFont font("Arial"); font.setPixelSize(qMax(7,qRound(9*scale)));font.setBold(true);
    painter->setFont(font);
    for (const auto& cue : cues) {
        for (const auto& rect : overviewHotcueRects(width,height,cue.position,scale)) {
            painter->fillRect(rect,cue.color);
            painter->setPen(Qt::black);
            painter->drawText(rect,Qt::AlignCenter,cue.label);
        }
    }
    painter->restore();
}

inline mixxx::rekordbox::WaveformMode waveformModeForType(WaveformWidgetType::Type type) {
    using Mode = mixxx::rekordbox::WaveformMode;
    switch (type) {
    case WaveformWidgetType::SoftwareSimpleWaveform:
    case WaveformWidgetType::QtSimpleWaveform:
    case WaveformWidgetType::GLSimpleWaveform:
    case WaveformWidgetType::AllShaderSimpleWaveform:
        return Mode::Blue;
    case WaveformWidgetType::RGBWaveform:
    case WaveformWidgetType::GLRGBWaveform:
    case WaveformWidgetType::GLSLRGBWaveform:
    case WaveformWidgetType::QtRGBWaveform:
    case WaveformWidgetType::AllShaderRGBWaveform:
    case WaveformWidgetType::AllShaderLRRGBWaveform:
    case WaveformWidgetType::AllShaderTexturedRGB:
        return Mode::RGB;
    default:
        return Mode::ThreeBand;
    }
}

// Same small, upward-pointing marker in detail waveforms and deck overviews.
inline QRectF positionTriangleRect(qreal x, qreal bottom, qreal scale = 1) {
    return QRectF(x - 4 * scale, bottom - 7 * scale, 8 * scale, 7 * scale);
}
inline void drawPositionTriangle(QPainter* painter, qreal x, qreal bottom, qreal scale = 1) {
    const auto rect = positionTriangleRect(x, bottom, scale);
    painter->save();
    painter->setPen(Qt::NoPen);
    painter->setBrush(Qt::white);
    painter->drawPolygon(QPolygonF{rect.bottomLeft(), QPointF(x, rect.top()), rect.bottomRight()});
    painter->restore();
}

// One-sided, three-band summary: measured low frequencies at the baseline,
// mids above them, highs at the envelope. Never invent signal for silence.
inline void drawSummaryColumn(QPainter* painter, qreal x, qreal baseline,
        qreal scale, int all, int low, int mid, int high,
        mixxx::rekordbox::WaveformMode mode = mixxx::rekordbox::WaveformMode::ThreeBand) {
    if (all <= 0 || scale <= 0) return;
    const int sum = low + mid + high;
    const qreal peak = qBound(0, all, 255) * scale;
    if (mode != mixxx::rekordbox::WaveformMode::ThreeBand) {
        const QColor color = mode == mixxx::rekordbox::WaveformMode::Blue
                ? QColor("#1d6fe0") : QColor(qBound(0, low, 255), qBound(0, mid, 255), qBound(0, high, 255));
        painter->setPen(color);
        painter->drawLine(QPointF(x, baseline), QPointF(x, baseline - peak));
        return;
    }
    const qreal orange = sum > 0 ? peak * (low + mid) / sum : 0;
    const qreal blue = sum > 0 ? peak * low / sum : 0;
    painter->setPen(QColor("#ffffff"));
    painter->drawLine(QPointF(x, baseline), QPointF(x, baseline - peak));
    if (orange > 0) {
        painter->setPen(QColor("#f0a000"));
        painter->drawLine(QPointF(x, baseline), QPointF(x, baseline - orange));
    }
    if (blue > 0) {
        painter->setPen(QColor("#0055e1"));
        painter->drawLine(QPointF(x, baseline), QPointF(x, baseline - blue));
    }
}
} // namespace rx3
