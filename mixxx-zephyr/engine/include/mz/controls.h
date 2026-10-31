// The controls the engine understands.
//
// In Mixxx every control is a ControlObject named by a group and a key, such
// as [Channel1],play, and controller scripts change them from their own
// thread. Here the controls are a fixed enumeration, and a change travels to
// the audio thread as a ControlEvent through a lock-free queue, so the audio
// thread is the only one that ever writes deck state.
#pragma once

#include <cstdint>

namespace mz {

enum class Target : uint8_t {
    None = 0,

    // Per deck. Buttons carry 1 (pressed) or 0 (released).
    Play, // [ChannelN],play (toggle)
    CueDefault, // [ChannelN],cue_default
    StartStop, // [ChannelN],start_stop
    Pfl, // [ChannelN],pfl (toggle)
    HotcueActivate, // [ChannelN],hotcue_X_activate; index is X - 1
    HotcueClear, // [ChannelN],hotcue_X_clear
    LoopIn, // [ChannelN],loop_in
    LoopOut, // [ChannelN],loop_out
    ReloopToggle, // [ChannelN],reloop_toggle
    ReloopAndStop, // [ChannelN],reloop_andstop

    // Per deck, values already converted by the MIDI layer.
    Volume, // channel fader gain, 0..1 (audio taper -20..0 dB)
    Pregain, // trim gain, 0..4 (audio taper -12..+12 dB)
    EqLow, // EQ knob value 0..2, 1 neutral
    EqMid,
    EqHigh,
    Filter, // quick-effect super knob 0..1, 0.5 neutral
    Rate, // [ChannelN],rate, the tempo slider in -1..1
    CycleTempoRange, // FLX4 script: next of 6, 10, 16, 25 %
    JogTurn, // FLX4 script jogTurn: ticks, signed
    JogSearch, // FLX4 script jogSearch: ticks, signed
    JogTouch, // FLX4 script jogTouch: 1 touched, 0 released
    LoadSelectedTrack, // [ChannelN],LoadSelectedTrack (handled by the worker)

    // Mixer.
    Crossfader, // -1..1
    HeadMix, // -1 (cue only) .. 1 (main only)
    MainGain, // 0..5 (audio taper -14..+14 dB)
    HeadGain,

    // Library.
    MoveVertical, // signed steps

    Count,
};

struct ControlEvent {
    Target target;
    int8_t deck; // 0 or 1, or -1 for mixer and library controls
    int8_t index; // hotcue number - 1, otherwise 0
    float value;
};

} // namespace mz
