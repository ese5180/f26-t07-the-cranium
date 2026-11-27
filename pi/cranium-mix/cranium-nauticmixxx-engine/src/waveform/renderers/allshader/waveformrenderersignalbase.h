#pragma once

#include <limits>
#include "shaders/rgbshader.h"
#include "waveform/renderers/allshader/rgbdata.h"
#include "waveform/renderers/allshader/vertexdata.h"
#include "waveform/rekordboxwaveform.h"

#include "util/class.h"
#include "waveform/renderers/allshader/waveformrendererabstract.h"
#include "waveform/renderers/waveformrenderersignalbase.h"

class WaveformWidgetRenderer;

namespace allshader {
class WaveformRendererSignalBase;
}

class allshader::WaveformRendererSignalBase : public ::WaveformRendererSignalBase,
                                              public allshader::WaveformRendererAbstract {
  public:
    static constexpr float m_maxValue{static_cast<float>(std::numeric_limits<uint8_t>::max())};

    explicit WaveformRendererSignalBase(WaveformWidgetRenderer* waveformWidget);

    void draw(QPainter* painter, QPaintEvent* event) override {
        Q_UNUSED(painter);
        Q_UNUSED(event);
    }

    allshader::WaveformRendererAbstract* allshaderWaveformRenderer() override {
        return this;
    }

    void initializeGL() override;
    bool paintRekordbox(mixxx::rekordbox::WaveformMode mode, bool slip = false);

  private:
    mixxx::RGBShader m_nativeShader;
    VertexData m_nativeVertices;
    RGBData m_nativeColors;

    DISALLOW_COPY_AND_ASSIGN(WaveformRendererSignalBase);
};
