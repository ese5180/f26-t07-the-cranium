#pragma once

#include <QVariantList>
#include <array>
#include <cmath>
#include "engine/engine.h"

namespace rx3 {
class SoundStartLevels {
  public:
    SoundStartLevels() {m_positions.fill(-1);for(int i=0;i<8;++i) m_levels[i]=std::pow(10.0,(-36-6*i)/20.0);}
    void consume(const CSAMPLE* samples,SINT frames,int channels,SINT firstFrame) {
        for(SINT frame=0;frame<frames;++frame) {
            double peak=0;
            for(int channel=0;channel<channels;++channel) peak=std::max(peak,double(std::abs(samples[frame*channels+channel])));
            for(int level=0;level<8;++level) if(m_positions[level]<0 && peak>=m_levels[level]) m_positions[level]=firstFrame+frame;
            if(complete()) return;
        }
    }
    bool complete() const {return m_positions[0]>=0;}
    QVariantList positions() const {QVariantList values;for(auto position:m_positions) values.append(double(position));return values;}
  private:
    std::array<double,8> m_positions,m_levels;
};
} // namespace rx3
