#pragma once

#include <algorithm>
#include <cmath>
#include <vector>
#include "util/types.h"

// Captured post-scaler stereo PCM. Allocation happens only when a removable
// track loads, outside the audio callback. Playback needs no decoder or disk.
class Rx3EmergencyLoop {
  public:
    void prepare() {
        m_audio.resize(8 * 192000 * 2);
        reset();
    }
    void reset() {
        m_write=m_count=m_start=m_length=m_cursor=0;
        m_sampleRate=0;m_transition=0;
    }
    void capture(const CSAMPLE* audio,int samples,double sampleRate) {
        if(m_audio.empty() || sampleRate<=0 || samples%2) return;
        if(m_sampleRate!=sampleRate) {reset();m_sampleRate=sampleRate;}
        const auto capacity=m_audio.size()/2;
        for(int frame=0;frame<samples/2;++frame) {
            m_audio[2*m_write]=audio[2*frame];
            m_audio[2*m_write+1]=audio[2*frame+1];
            m_write=(m_write+1)%capacity;
            m_count=std::min(m_count+1,capacity);
        }
    }
    bool start(double bpm) {
        if(m_count<2 || m_sampleRate<=0) return false;
        const auto capacity=m_audio.size()/2;
        const double framesPerBeat=std::isfinite(bpm) && bpm>0 ? m_sampleRate*60/bpm : 0;
        m_length=m_count;
        if(framesPerBeat>=1) {
            for(int beats:{4,2,1}) {
                const auto length=static_cast<size_t>(std::round(framesPerBeat*beats));
                if(length<=m_count) {m_length=length;break;}
            }
        } else m_length=std::min(m_count,static_cast<size_t>(m_sampleRate));
        m_start=(m_write+capacity-m_length)%capacity;
        m_cursor=0;m_transition=32;
        const auto last=(m_write+capacity-1)%capacity;
        m_last[0]=m_audio[2*last];m_last[1]=m_audio[2*last+1];
        return true;
    }
    void render(CSAMPLE* output,int samples) {
        if(!m_length) {std::fill(output,output+samples,CSAMPLE(0));return;}
        const auto capacity=m_audio.size()/2;
        const auto fade=std::min(size_t(32),m_length/4);
        for(int frame=0;frame<samples/2;++frame) {
            const auto index=(m_start+m_cursor)%capacity;
            for(int channel=0;channel<2;++channel) {
                CSAMPLE value=m_audio[2*index+channel];
                if(fade && m_cursor>=m_length-fade) {
                    const auto offset=m_cursor-(m_length-fade);
                    const double blend=double(offset+1)/fade;
                    value=CSAMPLE(value*(1-blend)+m_audio[2*((m_start+offset)%capacity)+channel]*blend);
                }
                if(m_transition>0) {
                    const double blend=double(33-m_transition)/32;
                    value=CSAMPLE(m_last[channel]*(1-blend)+value*blend);
                }
                output[2*frame+channel]=value;
            }
            if(m_transition>0) --m_transition;
            m_cursor=(m_cursor+1)%m_length;
        }
    }
    size_t lengthFrames() const {return m_length;}
  private:
    std::vector<CSAMPLE> m_audio;
    size_t m_write=0,m_count=0,m_start=0,m_length=0,m_cursor=0;
    double m_sampleRate=0;
    int m_transition=0;
    CSAMPLE m_last[2]{};
};
