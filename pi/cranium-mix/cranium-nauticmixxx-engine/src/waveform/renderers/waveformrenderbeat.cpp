#include "waveform/renderers/waveformrenderbeat.h"

#include <QPainter>

#include "track/track.h"
#include "util/painterscope.h"
#include "waveform/beatgridmarkers.h"
#include "waveform/renderers/waveformwidgetrenderer.h"
#include "widget/wskincolor.h"

class QPaintEvent;

WaveformRenderBeat::WaveformRenderBeat(WaveformWidgetRenderer* waveformWidgetRenderer)
        : WaveformRendererAbstract(waveformWidgetRenderer),
          m_tickLength(10.0) {
    m_beats.resize(256);
    m_downbeats.resize(64);
}

WaveformRenderBeat::~WaveformRenderBeat() {
}

void WaveformRenderBeat::setup(const QDomNode& node, const SkinContext& context) {
    m_beatColor = QColor(context.selectString(node, "BeatColor"));
    m_beatColor = WSkinColor::getCorrectColor(m_beatColor).toRgb();
    m_downbeatColor = QColor(context.selectString(node, "DownbeatColor"));
    if (!m_downbeatColor.isValid()) {
        m_downbeatColor = QColor(QStringLiteral("#ff0000"));
    }
    m_downbeatColor = WSkinColor::getCorrectColor(m_downbeatColor).toRgb();
    m_tickLength = std::max(1.0, context.selectDouble(node, "BeatTickLength", 10.0));
}

void WaveformRenderBeat::draw(QPainter* painter, QPaintEvent* /*event*/) {
    TrackPointer pTrackInfo = m_waveformRenderer->getTrackInfo();

    if (!pTrackInfo) {
        return;
    }

    mixxx::BeatsPointer trackBeats = pTrackInfo->getBeats();
    if (!trackBeats) {
        return;
    }

    int alpha = m_waveformRenderer->getBeatGridAlpha();
    if (alpha == 0) {
        return;
    }
#ifdef MIXXX_USE_QOPENGL
    // Using alpha transparency with drawLines causes a graphical issue when
    // drawing with QPainter on the QOpenGLWindow: instead of individual lines
    // a large rectangle encompassing all beatlines is drawn.
    m_beatColor.setAlphaF(1.f);
    m_downbeatColor.setAlphaF(1.f);
#else
    m_beatColor.setAlphaF(alpha/100.0);
    m_downbeatColor.setAlphaF(alpha/100.0);
#endif

    const double trackSamples = m_waveformRenderer->getTrackSamples();
    if (trackSamples <= 0) {
        return;
    }

    const float devicePixelRatio = m_waveformRenderer->getDevicePixelRatio();

    const double firstDisplayedPosition =
            m_waveformRenderer->getFirstDisplayedPosition();
    const double lastDisplayedPosition =
            m_waveformRenderer->getLastDisplayedPosition();

    // qDebug() << "trackSamples" << trackSamples
    //          << "firstDisplayedPosition" << firstDisplayedPosition
    //          << "lastDisplayedPosition" << lastDisplayedPosition;

    const auto startPosition = mixxx::audio::FramePos::fromEngineSamplePos(
            firstDisplayedPosition * trackSamples);
    const auto endPosition = mixxx::audio::FramePos::fromEngineSamplePos(
            lastDisplayedPosition * trackSamples);
    auto it = trackBeats->iteratorFrom(startPosition);

    // if no beat do not waste time saving/restoring painter
    if (it == trackBeats->cend() || *it > endPosition) {
        return;
    }

    PainterScope PainterScope(painter);

    painter->setRenderHint(QPainter::Antialiasing, false);

    const Qt::Orientation orientation = m_waveformRenderer->getOrientation();
    const float rendererWidth = m_waveformRenderer->getWidth();
    const float rendererHeight = m_waveformRenderer->getHeight();
    const float rendererBreadth = orientation == Qt::Horizontal
            ? rendererHeight
            : rendererWidth;
    const double firstAudibleSample =
            mixxx::beatgrid::firstAudibleEngineSample(pTrackInfo, trackSamples);
    const double onsetTolerance = 0.02 * trackSamples /
            std::max(0.001, pTrackInfo->getDuration());

    int beatCount = 0;
    int downbeatCount = 0;
    int beatIndex = it - trackBeats->cfirstmarker();

    for (; it != trackBeats->cend() && *it <= endPosition; ++it, ++beatIndex) {
        double beatPosition = it->toEngineSamplePos();
        if (beatPosition + onsetTolerance < firstAudibleSample) {
            continue;
        }
        double xBeatPoint =
                m_waveformRenderer->transformSamplePositionInRendererWorld(beatPosition);

        xBeatPoint = qRound(xBeatPoint * devicePixelRatio) / devicePixelRatio;

        const bool isDownbeat = ((beatIndex % 4) + 4) % 4 == 0;
        const auto geometry = mixxx::beatgrid::displayTicks(
                rendererBreadth, scaleFactor(), m_tickLength, isDownbeat,
                mixxx::beatgrid::editingDeck(m_waveformRenderer->getGroup()));
        QVector<QLineF>& ticks = isDownbeat ? m_downbeats : m_beats;
        int& tickCount = isDownbeat ? downbeatCount : beatCount;

        // Each beat is represented by one short tick at either edge.
        if (tickCount + 2 > ticks.size()) {
            ticks.resize(std::max(
                    ticks.size() * 2, static_cast<qsizetype>(tickCount + 2)));
        }

        if (orientation == Qt::Horizontal) {
            ticks[tickCount++].setLine(xBeatPoint, geometry.topStart,
                    xBeatPoint, geometry.topEnd);
            ticks[tickCount++].setLine(
                    xBeatPoint, geometry.bottomStart, xBeatPoint, geometry.bottomEnd);
        } else {
            ticks[tickCount++].setLine(geometry.topStart, xBeatPoint,
                    geometry.topEnd, xBeatPoint);
            ticks[tickCount++].setLine(
                    geometry.bottomStart, xBeatPoint, geometry.bottomEnd, xBeatPoint);
        }
    }

    // Make sure to use constData to prevent detaches!
    QPen beatPen(m_beatColor);
    beatPen.setWidthF(1.0 / devicePixelRatio);
    painter->setPen(beatPen);
    painter->drawLines(m_beats.constData(), beatCount);

    QPen downbeatPen(m_downbeatColor);
    downbeatPen.setWidthF(1.0 / devicePixelRatio);
    painter->setPen(downbeatPen);
    painter->drawLines(m_downbeats.constData(), downbeatCount);
}
