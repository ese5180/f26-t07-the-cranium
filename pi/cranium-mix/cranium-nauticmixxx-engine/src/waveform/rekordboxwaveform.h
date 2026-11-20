#pragma once

#include <QColor>
#include <QByteArray>
#include <QVector>
#include <array>
#include <algorithm>
#include <cmath>
#include <memory>
#include <atomic>

namespace mixxx::rekordbox {

enum class WaveformMode { Blue = 0, RGB = 1, ThreeBand = 2 };

// Preserve the ANLZ channels separately from Mixxx's lossy four-byte envelope.
// Published once by the importer, then immutable for the lifetime of the track.
struct WaveformColumn {
    quint8 low{0}, mid{0}, high{0}, all{0}, whiteness{0};
};
struct WaveformSeries {
    QVector<WaveformColumn> columns;
    double columnsPerSecond{150.0};
    QByteArray tag;
    double originSeconds{0.0};
};
// Signed extrema of decoded PCM; separate from the immutable Pioneer channels.
// 1500 bins/s bounds memory while preserving phase at the measured 112 px/s.
struct SignedWaveformColumn {
    float minimum{1.f}, maximum{-1.f};
};
struct SignedWaveform {
    QVector<SignedWaveformColumn> columns;
    double columnsPerSecond{1500.0};
    double firstAudibleSecond{-1.0};
};
enum class PhraseKind { Intro, Verse, Up, Down, Bridge, Chorus, Outro, Unknown };
struct Phrase {
    double startSeconds{0};
    double endSeconds{0};
    PhraseKind kind{PhraseKind::Unknown};
    quint16 sourceKind{0};
    quint16 mood{0};
    quint8 k1{0}, k2{0}, k3{0};
};
struct WaveformSet {
    std::array<WaveformSeries, 3> detail;
    std::array<WaveformSeries, 3> overview;
    double durationSeconds{0};
    QVector<Phrase> phrases;
    // Published atomically after decoding on the reader worker, never on the
    // audio callback. No file or library cache is written.
    mutable std::shared_ptr<const SignedWaveform> signedAudio;
};

inline WaveformColumn peakColumn(const WaveformSeries& series, double first, double last, bool preserveColor = false) {
    WaveformColumn peak;
    const int begin = std::max(0, static_cast<int>(std::floor(first)));
    const int end = std::min(static_cast<int>(series.columns.size()),
            std::max(begin + 1, static_cast<int>(std::ceil(last))));
    if (last <= 0 || first >= series.columns.size()) return peak;
    for (int i = begin; i < end; ++i) {
        const auto& c = series.columns[i];
        // Color/whiteness belongs to the peak envelope sample. Do not mix RGB
        // maxima from unrelated columns into an invented color.
        if (preserveColor) {
            if (c.all >= peak.all) peak = c;
            continue;
        }
        if (c.all >= peak.all) {
            peak.whiteness = c.whiteness;
        }
        peak.low = std::max(peak.low, c.low);
        peak.mid = std::max(peak.mid, c.mid);
        peak.high = std::max(peak.high, c.high);
        peak.all = std::max(peak.all, c.all);
    }
    return peak;
}

// Gradient stops measured from 01 calibration crops. Five knots preserve the
// measured shape without emitting one rectangle for every vertical pixel.
// Spectral color still comes from PWV3/PWV5; this is an approximation, see report.
template<typename GradientRectangle>
void renderSignedColumns(const WaveformSeries& series, const SignedWaveform& audio,
        WaveformMode mode, double firstSecond, double lastSecond, int width,
        float height, const std::array<float, 3>& gains, GradientRectangle rectangle,
        const WaveformSeries* eqBands = nullptr) {
    if (width <= 0 || height <= 0 || series.columns.isEmpty() || audio.columns.isEmpty()) return;
    const double step = (lastSecond-firstSecond)/width;
    const float center = height/2.f;
    // Measured absolute full-scale height: 100 px in the 114 px grid.
    const float scale = height * (50.f/114.f);
    for (int x=0; x<width; ++x) {
        const double t = firstSecond+x*step;
        const int begin = std::max(0, int(std::floor(t*audio.columnsPerSecond)));
        const int end = std::min(int(audio.columns.size()), int(std::ceil((t+step)*audio.columnsPerSecond)));
        if (end<=begin) continue;
        float lo=1.f, hi=-1.f;
        for (int i=begin;i<end;++i) {
            lo=std::min(lo,audio.columns[i].minimum);
            hi=std::max(hi,audio.columns[i].maximum);
        }
        if (lo>hi) continue;
        const auto c=peakColumn(series,(t-series.originSeconds)*series.columnsPerSecond,
                (t+step-series.originSeconds)*series.columnsPerSecond,true);
        float gain=1.f;
        if (eqBands && !eqBands->columns.isEmpty()) {
            const auto b=peakColumn(*eqBands,(t-eqBands->originSeconds)*eqBands->columnsPerSecond,
                    (t+step-eqBands->originSeconds)*eqBands->columnsPerSecond);
            const float total=float(b.low)*b.low+float(b.mid)*b.mid+float(b.high)*b.high;
            if (total>0) gain=std::sqrt((b.low*b.low*gains[0]*gains[0]+b.mid*b.mid*gains[1]*gains[1]+b.high*b.high*gains[2]*gains[2])/total);
        }
        const float top=std::clamp(center-hi*scale*gain,0.f,height);
        const float bottom=std::clamp(center-lo*scale*gain,0.f,height);
        if (bottom<=top) continue;
        const auto color=[&](int knot) {
            if (mode==WaveformMode::RGB) {
                constexpr float levels[5]={133/255.f,201/255.f,245/255.f,201/255.f,133/255.f};
                return qRgb(std::clamp(qRound(c.low*gains[0]*levels[knot]),0,255),
                        std::clamp(qRound(c.mid*gains[1]*levels[knot]),0,255),
                        std::clamp(qRound(c.high*gains[2]*levels[knot]),0,255));
            }
            // Median gradient samples by PWV3 whiteness, measured on 01/02.
            // Code 7 was not visible in these detail captures; white is the
            // specified endpoint, not a measured match for that code.
            constexpr int colors[8][5][3]={{{80,60,255},{59,99,238},{50,121,230},{58,110,238},{79,61,254}},{{79,64,254},{51,110,230},{47,128,229},{51,110,230},{79,64,254}},{{60,89,194},{46,119,199},{37,135,203},{46,119,199},{60,89,194}},{{53,120,201},{42,136,204},{36,146,205},{42,136,204},{53,120,201}},{{47,139,201},{37,149,204},{32,154,205},{37,149,204},{47,139,201}},{{36,155,189},{30,159,196},{28,160,201},{30,159,196},{36,155,189}},{{35,173,194},{30,170,199},{28,169,204},{30,170,199},{35,173,194}},{{255,255,255},{255,255,255},{255,255,255},{255,255,255},{255,255,255}}};
            const int white=std::clamp(qRound(c.whiteness*7.f/255.f),0,7);
            return qRgb(colors[white][knot][0],colors[white][knot][1],colors[white][knot][2]);
        };
        for (int k=0;k<4;++k) rectangle(float(x),top+(bottom-top)*k/4,
                float(x+1),top+(bottom-top)*(k+1)/4,color(k),color(k+1));
    }
}

// Extended overview gradient: measured native column height is 28 source
// pixels, independent of how much title/chrome the reference crop contains.
template<typename GradientRectangle>
void renderPreviewColumns(const WaveformSeries& series, WaveformMode mode,
        int width, float height, const std::array<float,3>& gains,
        GradientRectangle rectangle, float amplitudeHeight=28.f) {
    if (series.columns.isEmpty() || width<=0 || height<=1) return;
    float peak=1;
    for (const auto& c:series.columns) peak=std::max(peak,float(c.all));
    const float baseline=height-1;
    const float scale=std::min(amplitudeHeight,baseline)/peak;
    for (int x=0;x<width;++x) {
        const auto c=peakColumn(series,double(x)*series.columns.size()/width,
                double(x+1)*series.columns.size()/width,true);
        const float level=std::max({c.low*gains[0],c.mid*gains[1],c.high*gains[2]});
        const float top=std::max(0.f,baseline-level*scale);
        if (top>=baseline) continue;
        const auto color=[&](int k) {
            if (mode==WaveformMode::RGB) {
                constexpr int levels[5]={71,100,142,188,235};
                const float divisor=std::max(1.f,float(c.all));
                return qRgb(std::clamp(qRound(c.low*gains[0]*levels[k]/divisor),0,255),
                        std::clamp(qRound(c.mid*gains[1]*levels[k]/divisor),0,255),
                        std::clamp(qRound(c.high*gains[2]*levels[k]/divisor),0,255));
            }
            constexpr int low[5][3]={{5,27,43},{6,38,60},{9,54,84},{12,71,113},{14,88,140}};
            constexpr int high[5][3]={{2,2,2},{139,151,158},{155,169,179},{173,190,202},{193,214,229}};
            const float white=series.tag=="PWV4" ? c.whiteness/255.f : 0.f;
            return qRgb(qRound(low[k][0]+(high[k][0]-low[k][0])*white),
                    qRound(low[k][1]+(high[k][1]-low[k][1])*white),
                    qRound(low[k][2]+(high[k][2]-low[k][2])*white));
        };
        for (int k=0;k<4;++k) rectangle(float(x),top+(baseline-top)*k/4,
                float(x+1),top+(baseline-top)*(k+1)/4,color(k),color(k+1));
    }
}

// Shared geometry for GPU detail and CPU overview. One physical-pixel column,
// maximum reduction, no interpolation across time. Palette from the supplied
// PNGs; see nautic/docs/calibration-v2/capture-measurements.json.
template<typename Rectangle>
void renderColumns(const WaveformSeries& series, WaveformMode mode,
        double firstSecond, double lastSecond, int width, float height,
        bool overview, const std::array<float, 3>& gains, Rectangle rectangle,
        const WaveformSeries* eqBands = nullptr) {
    if (series.columns.isEmpty() || width <= 0 || height <= 0) return;
    const double first = (firstSecond - series.originSeconds) * series.columnsPerSecond;
    const double increment = (lastSecond-firstSecond)*series.columnsPerSecond/width;
    const float half = overview ? height : height/2.f;
    float overviewPeak = 1;
    if (overview) {
        for (const auto& c : series.columns) {
            const float level = mode == WaveformMode::ThreeBand ?
                    c.low + 0.425f*c.mid + c.high : c.all;
            overviewPeak = std::max(overviewPeak, level);
        }
    }
    for (int x=0; x<width; ++x) {
        auto c=peakColumn(series, first+x*increment, first+(x+1)*increment, mode != WaveformMode::ThreeBand);
        auto draw=[&](float amplitude, QRgb color) {
            const float y=std::clamp(amplitude,0.f,1.f)*half;
            if (y>0) rectangle(float(x), half-y, float(x+1), overview ? half : half+y, color);
        };
        if (mode==WaveformMode::ThreeBand) {
            // A slope of approximately 0.375 source pixels per raw unit was
            // measured on the five calibration detail captures (114 px grid).
            const float low=c.low/152.f*gains[0], mid=c.mid/152.f*gains[1], high=c.high/152.f*gains[2];
            if (overview) {
                // PWV6 is stacked; PWV7 uses overlapping envelopes.
                const float l=c.low*gains[0]/overviewPeak;
                const float m=0.425f*c.mid*gains[1]/overviewPeak;
                const float h=c.high*gains[2]/overviewPeak;
                draw(l+m+h,qRgb(255,255,255));
                draw(l+m,qRgb(255,166,0));
                draw(l,qRgb(0,85,225));
            } else {
                draw(low,qRgb(0,81,225));
                draw(mid,qRgb(255,163,0));
                draw(std::min(low,mid),qRgb(179,101,6));
                draw(high,qRgb(245,234,214));
            }
        } else if (mode==WaveformMode::RGB) {
            const int r=std::clamp(qRound(c.low*gains[0]),0,255);
            const int g=std::clamp(qRound(c.mid*gains[1]),0,255);
            const int b=std::clamp(qRound(c.high*gains[2]),0,255);
            if (overview) {
                const float denom=std::max(1.f, float(c.all));
                draw(c.all/overviewPeak, qRgb(std::min(255,qRound(r*191/denom)),
                        std::min(255,qRound(g*191/denom)), std::min(255,qRound(b*191/denom))));
                draw(c.high/overviewPeak, qRgb(std::min(255,qRound(r*255/denom)),
                        std::min(255,qRound(g*255/denom)), std::min(255,qRound(b*255/denom))));
            } else draw(c.all/255.f,qRgb(r,g,b));
        } else {
            const float white=c.whiteness/255.f;
            // Outer Blue color sampled from calibration PNGs. The white
            // endpoint follows the requested Blue specification; it is not
            // a claim to reproduce Rekordbox's signed-sample gradients.
            const QColor base=overview ? QColor(14,85,135) : QColor(80,59,255);
            float eqGain = 1.f;
            if (eqBands && !eqBands->columns.isEmpty()) {
                const double begin = (firstSecond + x*(lastSecond-firstSecond)/width - eqBands->originSeconds) * eqBands->columnsPerSecond;
                const double end = (firstSecond + (x+1)*(lastSecond-firstSecond)/width - eqBands->originSeconds) * eqBands->columnsPerSecond;
                const auto band = peakColumn(*eqBands, begin, end);
                const float total = float(band.low)*band.low + float(band.mid)*band.mid + float(band.high)*band.high;
                if (total > 0) eqGain = std::sqrt((band.low*band.low*gains[0]*gains[0] +
                        band.mid*band.mid*gains[1]*gains[1] + band.high*band.high*gains[2]*gains[2])/total);
            }
            draw(eqGain*c.all/(overview ? overviewPeak : 255.f),qRgb(qRound(base.red()+(255-base.red())*white),
                    qRound(base.green()+(255-base.green())*white),
                    qRound(base.blue()+(255-base.blue())*white)));
        }
    }
}
} // namespace mixxx::rekordbox
