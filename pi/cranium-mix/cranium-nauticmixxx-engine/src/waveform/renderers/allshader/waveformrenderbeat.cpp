#include "waveform/renderers/allshader/waveformrenderbeat.h"

#include <QDomNode>

#include "skin/legacy/skincontext.h"
#include "track/track.h"
#include "waveform/beatgridmarkers.h"
#include "waveform/renderers/allshader/matrixforwidgetgeometry.h"
#include "waveform/renderers/waveformwidgetrenderer.h"
#include "widget/wskincolor.h"

namespace allshader {

WaveformRenderBeat::WaveformRenderBeat(WaveformWidgetRenderer* waveformWidget,
        ::WaveformRendererAbstract::PositionSource type)
        : WaveformRenderer(waveformWidget),
          m_tickLength(10.0),
          m_isSlipRenderer(type == ::WaveformRendererAbstract::Slip) {
}

void WaveformRenderBeat::initializeGL() {
    WaveformRenderer::initializeGL();
    m_shader.init();
}

void WaveformRenderBeat::setup(const QDomNode& node, const SkinContext& context) {
    m_color = QColor(context.selectString(node, "BeatColor"));
    m_color = WSkinColor::getCorrectColor(m_color).toRgb();
    m_downbeatColor = QColor(context.selectString(node, "DownbeatColor"));
    if (!m_downbeatColor.isValid()) {
        m_downbeatColor = QColor(QStringLiteral("#ff0000"));
    }
    m_downbeatColor = WSkinColor::getCorrectColor(m_downbeatColor).toRgb();
    m_tickLength = std::max(1.0, context.selectDouble(node, "BeatTickLength", 10.0));
}

void WaveformRenderBeat::paintGL() {
    TrackPointer trackInfo = m_waveformRenderer->getTrackInfo();

    if (!trackInfo || (m_isSlipRenderer && !m_waveformRenderer->isSlipActive())) {
        return;
    }

    auto positionType = m_isSlipRenderer ? ::WaveformRendererAbstract::Slip
                                         : ::WaveformRendererAbstract::Play;

    mixxx::BeatsPointer trackBeats = trackInfo->getBeats();
    if (!trackBeats) {
        return;
    }

    int alpha = m_waveformRenderer->getBeatGridAlpha();
    if (alpha == 0) {
        return;
    }

    const float devicePixelRatio = m_waveformRenderer->getDevicePixelRatio();

    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    m_color.setAlphaF(alpha / 100.0f);
    m_downbeatColor.setAlphaF(alpha / 100.0f);

    const double trackSamples = m_waveformRenderer->getTrackSamples();
    if (trackSamples <= 0) {
        return;
    }

    const double firstDisplayedPosition =
            m_waveformRenderer->getFirstDisplayedPosition(positionType);
    const double lastDisplayedPosition =
            m_waveformRenderer->getLastDisplayedPosition(positionType);

    const auto startPosition = mixxx::audio::FramePos::fromEngineSamplePos(
            firstDisplayedPosition * trackSamples);
    const auto endPosition = mixxx::audio::FramePos::fromEngineSamplePos(
            lastDisplayedPosition * trackSamples);

    if (!startPosition.isValid() || !endPosition.isValid()) {
        return;
    }

    const float rendererBreadth = m_waveformRenderer->getBreadth();
    const float usableBreadth = m_isSlipRenderer ? rendererBreadth / 2 : rendererBreadth;
    const double firstAudibleSample =
            mixxx::beatgrid::firstAudibleEngineSample(trackInfo, trackSamples);
    const double onsetTolerance = 0.02 * trackSamples /
            std::max(0.001, trackInfo->getDuration());

    const int numVerticesPerBeat = 12; // two rectangular edge ticks

    // Count the number of beats in the range to reserve space in the m_vertices vector.
    // Note that we could also use
    //   int numBearsInRange = trackBeats->numBeatsInRange(startPosition, endPosition);
    // for this, but there have been reports of that method failing with a DEBUG_ASSERT.
    int numBeatsInRange = 0;
    for (auto it = trackBeats->iteratorFrom(startPosition);
            it != trackBeats->cend() && *it <= endPosition;
            ++it) {
        numBeatsInRange++;
    }

    const int reserved = numBeatsInRange * numVerticesPerBeat;
    m_vertices.clear();
    m_vertices.reserve(reserved);
    m_downbeatVertices.clear();
    m_downbeatVertices.reserve(reserved);

    auto it = trackBeats->iteratorFrom(startPosition);
    int beatIndex = it - trackBeats->cfirstmarker();
    for (;
            it != trackBeats->cend() && *it <= endPosition;
            ++it, ++beatIndex) {
        double beatPosition = it->toEngineSamplePos();
        if (beatPosition + onsetTolerance < firstAudibleSample) {
            continue;
        }
        double xBeatPoint =
                m_waveformRenderer->transformSamplePositionInRendererWorld(
                        beatPosition, positionType);

        xBeatPoint = qRound(xBeatPoint * devicePixelRatio) / devicePixelRatio;

        const float x1 = static_cast<float>(xBeatPoint);
        const float pixel = 1.f / devicePixelRatio;
        const float x2 = x1 + pixel;
        const bool bar = ((beatIndex % 4) + 4) % 4 == 0;
        const auto ticks = mixxx::beatgrid::displayTicks(
                usableBreadth, scaleFactor(), m_tickLength, bar,
                mixxx::beatgrid::editingDeck(m_waveformRenderer->getGroup()));
        VertexData& vertices = bar ? m_downbeatVertices : m_vertices;
        vertices.addRectangle(x1, ticks.topStart, x2, ticks.topEnd);
        vertices.addRectangle(x1, ticks.bottomStart, x2, ticks.bottomEnd);
    }

    const int positionLocation = m_shader.positionLocation();
    const int matrixLocation = m_shader.matrixLocation();
    const int colorLocation = m_shader.colorLocation();

    m_shader.bind();
    m_shader.enableAttributeArray(positionLocation);

    const QMatrix4x4 matrix = matrixForWidgetGeometry(m_waveformRenderer, false);

    m_shader.setUniformValue(matrixLocation, matrix);

    m_shader.setAttributeArray(
            positionLocation, GL_FLOAT, m_vertices.constData(), 2);
    m_shader.setUniformValue(colorLocation, m_color);
    glDrawArrays(GL_TRIANGLES, 0, m_vertices.size());

    m_shader.setAttributeArray(
            positionLocation, GL_FLOAT, m_downbeatVertices.constData(), 2);
    m_shader.setUniformValue(colorLocation, m_downbeatColor);
    glDrawArrays(GL_TRIANGLES, 0, m_downbeatVertices.size());

    m_shader.disableAttributeArray(positionLocation);
    m_shader.release();
}

} // namespace allshader
