#include "waveform/renderers/allshader/waveformrenderersignalbase.h"



allshader::WaveformRendererSignalBase::WaveformRendererSignalBase(
        WaveformWidgetRenderer* waveformWidget)
        : ::WaveformRendererSignalBase(waveformWidget) {
}

#include "track/track.h"
#include "waveform/waveform.h"
#include "waveform/renderers/waveformwidgetrenderer.h"
#include "waveform/renderers/allshader/matrixforwidgetgeometry.h"

void allshader::WaveformRendererSignalBase::initializeGL() {
    allshader::WaveformRendererAbstract::initializeGL();
    m_nativeShader.init();
}

bool allshader::WaveformRendererSignalBase::paintRekordbox(
        mixxx::rekordbox::WaveformMode mode, bool slip) {
    const auto track = m_waveformRenderer->getTrackInfo();
    const auto waveform = track ? track->getWaveform() : ConstWaveformPointer();
    if (!waveform || !waveform->rekordbox) return false;
    if (slip && !m_waveformRenderer->isSlipActive()) return true;
    const auto& native = *waveform->rekordbox;
    const auto& series = native.detail[static_cast<int>(mode)];
    const auto source = slip ? ::WaveformRendererAbstract::Slip : ::WaveformRendererAbstract::Play;
    const float dpr = m_waveformRenderer->getDevicePixelRatio();
    const int width = qRound(m_waveformRenderer->getLength() * dpr);
    const float top = 18.f * scaleFactor() * dpr;
    const float height = std::max(1.f, float(m_waveformRenderer->getBreadth() * dpr - top - 4.f * scaleFactor() * dpr));
    std::array<float, 3> gains{1, 1, 1};
    getGains(nullptr, false, &gains[0], &gains[1], &gains[2]);
    m_nativeVertices.clear();
    m_nativeColors.clear();
    const auto signedAudio=std::atomic_load(&native.signedAudio);
    if (signedAudio && mode!=mixxx::rekordbox::WaveformMode::ThreeBand) {
        mixxx::rekordbox::renderSignedColumns(series,*signedAudio,mode,
                m_waveformRenderer->getFirstDisplayedPosition(source)*native.durationSeconds,
                m_waveformRenderer->getLastDisplayedPosition(source)*native.durationSeconds,
                width,height,gains,[&](float x1,float y1,float x2,float y2,QRgb c1,QRgb c2) {
                    if (slip && y1>=height/2) return;
                    m_nativeVertices.addRectangle(x1,top+y1,x2,top+std::min(y2,slip?height/2:height));
                    m_nativeColors.addGradientRectangle(c1,c2);
                },&native.detail[2]);
    } else mixxx::rekordbox::renderColumns(series, mode,
            m_waveformRenderer->getFirstDisplayedPosition(source) * native.durationSeconds,
            m_waveformRenderer->getLastDisplayedPosition(source) * native.durationSeconds,
            width, height, false, gains,
            [&](float x1, float y1, float x2, float y2, QRgb color) {
                if (slip) y2 = height / 2;
                m_nativeVertices.addRectangle(x1, top + y1, x2, top + y2);
                m_nativeColors.addForRectangle(qRed(color)/255.f, qGreen(color)/255.f, qBlue(color)/255.f);
            }, &native.detail[2]);
    if (!m_nativeVertices.size()) return true;
    const int position = m_nativeShader.positionLocation();
    const int colors = m_nativeShader.colorLocation();
    m_nativeShader.bind();
    m_nativeShader.enableAttributeArray(position);
    m_nativeShader.enableAttributeArray(colors);
    m_nativeShader.setUniformValue(m_nativeShader.matrixLocation(),
            matrixForWidgetGeometry(m_waveformRenderer, true));
    m_nativeShader.setAttributeArray(position, GL_FLOAT, m_nativeVertices.constData(), 2);
    m_nativeShader.setAttributeArray(colors, GL_FLOAT, m_nativeColors.constData(), 3);
    glDrawArrays(GL_TRIANGLES, 0, m_nativeVertices.size());
    m_nativeShader.disableAttributeArray(position);
    m_nativeShader.disableAttributeArray(colors);
    m_nativeShader.release();
    return true;
}
