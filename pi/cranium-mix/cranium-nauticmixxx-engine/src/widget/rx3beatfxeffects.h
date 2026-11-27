#pragma once

#include "effects/backends/effectsbackendmanager.h"
#include "effects/backends/effectmanifest.h"
#include "effects/effectslot.h"
#include "effects/effectparameter.h"
#include "effects/effectknobparameterslot.h"
#include "effects/rx3beatfxtiming.h"

// A performance-oriented subset of the actual built-in processors. Do not
// expose utility/EQ processors here or invent names for missing RX3 algorithms.
inline bool isRx3BeatFx(const EffectManifestPointer& manifest) {
    if (!manifest) return false;
    static const QStringList ids{
            "org.mixxx.effects.echo", "org.mixxx.effects.reverb",
            "org.mixxx.effects.flanger", "org.mixxx.effects.phaser",
            "org.mixxx.effects.filter", "org.mixxx.effects.pitchshift",
            "org.mixxx.effects.tremolo", "org.mixxx.effects.glitch"};
    return ids.contains(manifest->id());
}

inline QList<EffectManifestPointer> rx3BeatFxManifests(
        const EffectsBackendManagerPointer& backend) {
    QList<EffectManifestPointer> result;
    for (const auto& manifest : backend->getManifests())
        if (isRx3BeatFx(manifest)) result.append(manifest);
    return result;
}

inline EffectParameterPointer rx3FxParameter(const EffectSlotPointer& slot, const QString& id) {
    if (!slot) return {};
    for (const auto& map : {slot->getLoadedParameters(), slot->getHiddenParameters()})
        for (auto list = map.cbegin(); list != map.cend(); ++list)
            for (const auto& parameter : list.value())
                if (parameter->manifest()->id() == id) return parameter;
    return {};
}

inline void rx3SetFxParameter(const EffectSlotPointer& slot, const QString& id, double value) {
    for (const auto type : {EffectParameterType::Knob, EffectParameterType::Button})
        for (unsigned int i = 0; slot && i < slot->numParameters(type); ++i) {
            auto parameter = slot->getEffectParameterSlot(type, i);
            if (parameter->getManifest() && parameter->getManifest()->id() == id) {
                const QString prefix = type == EffectParameterType::Knob ?
                        EffectKnobParameterSlot::formatItemPrefix(parameter->slotNumber()) :
                        QString("button_parameter%1").arg(parameter->slotNumber() + 1);
                ControlObject::set(ConfigKey(slot->getGroup(), prefix), value);
                return;
            }
        }
    if (auto parameter = rx3FxParameter(slot, id)) parameter->setValue(value);
}

// Scope preparation to explicit RX3 selections. Preserve generic effect loading,
// Color FX and registration of the processor already in use.
inline void rx3PrepareBeatFx(const EffectSlotPointer& slot, const EffectManifestPointer& manifest) {
    if (!isRx3BeatFx(manifest)) return;
    slot->setMetaParameter(manifest->metaknobDefault(), true);
    if (manifest->id().endsWith(".filter")) {
        rx3SetFxParameter(slot, "lpf", 22050);
        rx3SetFxParameter(slot, "hpf", 13);
    }
    for (const auto& id : {QString("send_amount"), QString("depth"), QString("mix")})
        if (auto parameter = rx3FxParameter(slot, id))
            rx3SetFxParameter(slot, id, parameter->manifest()->getMaximum());
    if (manifest->id().endsWith(".pitchshift")) {
        rx3SetFxParameter(slot, "range", 1);
        rx3SetFxParameter(slot, "pitch", 0);
    }
}

inline void rx3SetBeatFxEnabled(const EffectSlotPointer& slot, bool enabled) {
    // Notify the enabled control owner so activation reaches the audio engine.
    if (slot) ControlObject::set(ConfigKey(slot->getGroup(), "enabled"), enabled ? 1 : 0);
}

inline void rx3LoadBeatFx(const EffectSlotPointer& slot, const EffectManifestPointer& manifest) {
    const ConfigKey mixKey("[EffectRack1_EffectUnit1]", "mix");
    const double mix=ControlObject::get(mixKey);
    ControlObject::set(ConfigKey("[EffectRack1_EffectUnit1]", "enabled"), 0);
    rx3SetBeatFxEnabled(slot, false);
    slot->loadEffectWithDefaults(manifest);
    rx3PrepareBeatFx(slot,manifest);
    // Loading into the empty placeholder can reset the whole chain preset.
    ControlObject::set(mixKey, mix);
    ControlObject::set(ConfigKey("[EffectRack1_EffectUnit1]", "enabled"), 0);
}
