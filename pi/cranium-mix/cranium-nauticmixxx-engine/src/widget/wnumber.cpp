#include "util/fpclassify.h"
#include "widget/wnumber.h"

#include "moc_wnumber.cpp"
#include <QFontInfo>
#include <QEvent>
#include "widget/rx3displayformat.h"
#include "skin/legacy/skincontext.h"

WNumber::WNumber(QWidget* pParent)
        : WLabel(pParent),
          m_iNoDigits(2) {
}

void WNumber::setup(const QDomNode& node, const SkinContext& context) {
    m_rx3Format = context.selectString(node, "Rx3Format");
    WLabel::setup(node, context);

    // Number of digits after the decimal.
    context.hasNodeSelectInt(node, "NumberOfDigits", &m_iNoDigits);

    setValue(0.);
}

void WNumber::onConnectedControlChanged(double dParameter, double dValue) {
    Q_UNUSED(dParameter);
    // We show the actual control value instead of its parameter.
    setValue(dValue);
}

void WNumber::setValue(double dValue) {
    m_rx3LastValue = dValue;
    if (m_rx3Format == QStringLiteral("loop")) {
        setText(rx3::loop(dValue));
        return;
    }
    if (m_rx3Format == QStringLiteral("beat-ms")) {
        setText(rx3::smallSuffix(rx3::beatMilliseconds(dValue), QStringLiteral(" msec"), QFontInfo(font()).pixelSize()));
        return;
    }
    if (m_rx3Format == QStringLiteral("bpm")) {
        const QString value = QString::number(util_isfinite(dValue) ? std::max(0.0, dValue) : 0.0, 'f', 1);
        const int dot = value.indexOf('.');
        setText(rx3::smallSuffix(value.left(dot), value.mid(dot), QFontInfo(font()).pixelSize()));
        return;
    }
    if (m_skinText.contains("%1")) {
        setText(m_skinText.arg(QString::number(dValue, 'f', m_iNoDigits)));
    } else {
        setText(m_skinText + QString::number(dValue, 'f', m_iNoDigits));
    }
}

bool WNumber::event(QEvent* event) {
    const bool result = WLabel::event(event);
    if (event->type() == QEvent::FontChange && !m_rx3Format.isEmpty()) setValue(m_rx3LastValue);
    return result;
}
