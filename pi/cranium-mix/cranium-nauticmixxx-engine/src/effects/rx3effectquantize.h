#pragma once

#include <QSet>
#include <cmath>
#include "control/controlobject.h"
#include "engine/channelhandle.h"

namespace rx3 {
// Use the routed deck's beat, preferring the selected deck when the effect is
// assigned to several channels or to the main output. No running deck: immediate.
inline int effectActivationDelay(const QString& unit,
        const QSet<ChannelHandleAndGroup>& channels) {
    const ConfigKey setting("[RX3Settings]","effect_quantize");
    if(!unit.startsWith("[EffectRack1_EffectUnit") || !ControlObject::exists(setting) ||
            ControlObject::get(setting)<=0) return 0;
    QSet<QString> groups;
    for(const auto& channel:channels) groups.insert(channel.name());
    const bool master=groups.contains("[Master]");
    const ConfigKey selected("[RX3Controller]","active_deck");
    const int preferred=ControlObject::exists(selected) && ControlObject::get(selected)==2?2:1;
    for(const int deck:{preferred,3-preferred}) {
        const auto group=QString("[Channel%1]").arg(deck);
        if(!master && !groups.contains(group)) continue;
        const ConfigKey play(group,"play"),bpmKey(group,"visual_bpm"),phaseKey(group,"beat_distance");
        if(!ControlObject::exists(play) || !ControlObject::exists(bpmKey) || !ControlObject::exists(phaseKey) ||
                ControlObject::get(play)<=0) continue;
        const double bpm=ControlObject::get(bpmKey),phase=ControlObject::get(phaseKey);
        if(!std::isfinite(bpm) || bpm<=0 || !std::isfinite(phase) || phase<=0.002 || phase>=0.998) return 0;
        return qBound(1,qRound((1-phase)*60000/bpm),2000);
    }
    return 0;
}
}
