#pragma once

#include <QPainter>
#include <QPainterPath>
#include <QStringList>

namespace rx3 {
inline QColor browserTrackColor(bool playing, bool played) {
    return QColor(playing ? "#01FF02" : played ? "#008A01" : "#FFFFFF");
}
inline bool isLosslessFileType(const QString& type) {
    // M4A may contain AAC or ALAC: never infer losslessness from that container.
    return QStringList{QStringLiteral("wav"), QStringLiteral("wave"),
            QStringLiteral("aif"), QStringLiteral("aiff"), QStringLiteral("flac"),
            QStringLiteral("alac")}.contains(type.trimmed().toLower());
}

// All icons use one 32x32 vector canvas, independent of installed symbol fonts.
inline void drawBrowserTrackIcon(QPainter* p, const QRectF& rect,
        const QColor& color, bool playing, bool lossless) {
    p->save();
    p->setRenderHint(QPainter::Antialiasing);
    p->translate(rect.topLeft());
    p->scale(rect.width()/32, rect.height()/32);
    p->setPen(Qt::NoPen); p->setBrush(color);
    if (playing) {
        p->drawPolygon(QPolygonF{QPointF(10,7), QPointF(25,16), QPointF(10,25)});
    } else {
        p->drawEllipse(QRectF(10,22,9,6));
        p->fillRect(QRectF(17,5,2.2,20), color);
        QPainterPath flag;
        flag.moveTo(19,5); flag.cubicTo(20,10,29,10,26,17);
        flag.cubicTo(25,20,22,20,22,20);
        flag.cubicTo(27,13,18,13,18,9); flag.closeSubpath();
        p->drawPath(flag);
        if (lossless) {
            // The H sits above-left of the note, never as part of the title.
            QFont font(QStringLiteral("Arial")); font.setPixelSize(10);
            p->setFont(font); p->setPen(color);
            p->drawText(QRectF(2,4,9,12), Qt::AlignCenter, QStringLiteral("H"));
        }
    }
    p->restore();
}

inline void drawBrowserCategoryIcon(QPainter* p, const QRectF& rect,
        const QString& label, const QColor& color) {
    p->save(); p->setRenderHint(QPainter::Antialiasing);
    p->translate(rect.topLeft()); p->scale(rect.width()/32, rect.height()/32);
    p->setPen(QPen(color,1.4)); p->setBrush(Qt::NoBrush);
    const auto list = [&] {
        p->drawRect(QRectF(4,3,24,26));
        for (int y : {9,16,23}) {
            p->drawPoint(QPointF(8,y)); p->drawLine(QPointF(12,y),QPointF(24,y));
        }
    };
    if (label == "ARTIST" || label == "REMIXER") {
        p->drawEllipse(QPointF(16,9),6,6);
        p->drawArc(QRectF(4,19,24,16),0,180*16);
    } else if (label == "ALBUM" || label == "ALBUMS") {
        p->drawRect(QRectF(4,4,24,24));
        p->drawEllipse(QPointF(16,16),9,9); p->drawEllipse(QPointF(16,16),2,2);
    } else if (label == "TRACK" || label == "TRACKS") {
        drawBrowserTrackIcon(p,QRectF(0,0,32,32),color,false,false);
    } else if (label == "KEY") {
        p->drawRect(QRectF(3,3,26,26));
        QFont font(QStringLiteral("Arial")); font.setPixelSize(19); p->setFont(font);
        p->drawText(QRectF(3,3,26,26),Qt::AlignCenter,QStringLiteral("b#"));
    } else if (label == "PLAYLIST" || label == "HISTORY") {
        list();
        if (label == "HISTORY") {
            p->setBrush(QColor("#202020")); p->drawEllipse(QPointF(24,24),7,7);
            p->setBrush(Qt::NoBrush);
            p->drawLine(QPointF(24,20),QPointF(24,24)); p->drawLine(QPointF(24,24),QPointF(28,26));
        }
    } else if (label == "MATCHING" || label == "RELATED TRACKS") {
        p->drawEllipse(QRectF(3,12,18,18)); p->drawEllipse(QRectF(12,3,18,18));
    } else if (label == "FOLDER") {
        p->drawPolygon(QPolygonF{QPointF(3,7),QPointF(13,7),QPointF(17,11),
                QPointF(29,11),QPointF(29,28),QPointF(3,28)});
    } else if (label == "REC" || label == "RECORDING") {
        p->drawEllipse(QPointF(16,16),12,12); p->drawEllipse(QPointF(16,16),8,8);
    } else if (label == "SEARCH") {
        p->drawEllipse(QPointF(13,13),9,9); p->drawLine(QPointF(20,20),QPointF(29,29));
    } else if (label == "RATING") {
        p->drawPolygon(QPolygonF{QPointF(16,2),QPointF(20,12),QPointF(31,12),
                QPointF(22,19),QPointF(25,30),QPointF(16,23),QPointF(7,30),
                QPointF(10,19),QPointF(1,12),QPointF(12,12)});
    } else if (label == "COLOR") {
        p->drawEllipse(QPointF(16,16),12,12);
        p->drawLine(QPointF(4,16),QPointF(28,16)); p->drawLine(QPointF(16,4),QPointF(16,28));
    } else if (label == "YEAR" || label == "DATE ADDED") {
        p->drawRect(QRectF(4,6,24,23)); p->drawLine(QPointF(4,13),QPointF(28,13));
        p->drawLine(QPointF(10,2),QPointF(10,10)); p->drawLine(QPointF(22,2),QPointF(22,10));
    } else if (label == "LABEL" || label == "GENRE") {
        p->drawPolygon(QPolygonF{QPointF(3,4),QPointF(17,4),QPointF(30,17),QPointF(17,30),QPointF(3,16)});
        p->drawEllipse(QPointF(9,10),2,2);
    } else if (label == "BPM") {
        QPainterPath pulse; pulse.moveTo(2,17); pulse.lineTo(9,17); pulse.lineTo(13,5);
        pulse.lineTo(18,27); pulse.lineTo(23,17); pulse.lineTo(30,17); p->drawPath(pulse);
    } else {
        list();
    }
    p->restore();
}
} // namespace rx3
