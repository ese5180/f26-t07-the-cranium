#include "mz/midi.h"

#include <algorithm>

#include "mz/control_behavior.h"
#include "mz/engine.h"

namespace mz {

namespace {

// Data bytes per channel-message type (status high nibble 0x8..0xE).
int dataBytes(uint8_t status) {
    switch (status & 0xF0) {
    case 0xC0:
    case 0xD0:
        return 1;
    default:
        return 2;
    }
}

} // namespace

MidiParser::MidiParser()
        : m_status(0), m_data{0, 0}, m_count(0), m_inSysex(false) {
}

bool MidiParser::feed(uint8_t byte, MidiMessage* message) {
    if (byte >= 0xF8) {
        return false; // real-time: clock, start, stop, active sensing
    }
    if (byte == 0xF0) {
        m_inSysex = true;
        m_status = 0;
        return false;
    }
    if (byte == 0xF7) {
        m_inSysex = false;
        return false;
    }
    if (byte & 0x80) {
        m_inSysex = false;
        if (byte >= 0xF0) {
            m_status = 0; // system common: cancels running status
            return false;
        }
        m_status = byte;
        m_count = 0;
        return false;
    }
    if (m_inSysex || m_status == 0) {
        return false;
    }
    m_data[m_count++] = byte;
    if (m_count < dataBytes(m_status)) {
        return false;
    }
    message->status = m_status;
    message->data1 = m_data[0];
    message->data2 = m_count > 1 ? m_data[1] : 0;
    m_count = 0; // running status: the next data byte starts a new message
    return true;
}

MidiMapper::MidiMapper(Engine* engine, const ControllerMapping* mapping)
        : m_engine(engine), m_mapping(mapping), m_msb{}, m_tempoMsb{0x40, 0x40}, m_unmapped(0) {
}

void MidiMapper::post(Target target, int deck, int index, double value) {
    m_engine->post(ControlEvent{target,
            static_cast<int8_t>(deck),
            static_cast<int8_t>(index),
            static_cast<float>(value)});
}

void MidiMapper::process(const MidiMessage& in) {
    MidiMessage message = in;
    // Note off is a note on with velocity 0, as Mixxx treats it.
    if ((message.status & 0xF0) == 0x80) {
        message.status = static_cast<uint8_t>(0x90 | (message.status & 0x0F));
        message.data2 = 0;
    }

    bool matched = false;
    for (size_t i = 0; i < m_mapping->inputCount; ++i) {
        const MidiInputMapping& mapping = m_mapping->inputs[i];
        if (mapping.status != message.status || mapping.midino != message.data1) {
            continue;
        }
        matched = true;
        switch (mapping.option) {
        case MidiOption::FourteenBitMsb:
            if (i < sizeof(m_msb)) {
                m_msb[i] = message.data2;
            }
            break;
        case MidiOption::FourteenBitLsb: {
            // Find the MSB entry of the same control.
            uint8_t msb = 0;
            for (size_t j = 0; j < m_mapping->inputCount && j < sizeof(m_msb); ++j) {
                const MidiInputMapping& other = m_mapping->inputs[j];
                if (other.option == MidiOption::FourteenBitMsb &&
                        other.target == mapping.target && other.deck == mapping.deck &&
                        other.index == mapping.index) {
                    msb = m_msb[j];
                    break;
                }
            }
            // MidiController::processInputMapping: 14 bits scaled to 0..127.
            const int value14 = (msb << 7) | message.data2;
            dispatch(mapping, std::min(value14 / 128.0, 127.0), message.data2);
            break;
        }
        default:
            dispatch(mapping, message.data2, message.data2);
            break;
        }
    }
    if (!matched) {
        ++m_unmapped;
    }
}

void MidiMapper::dispatch(const MidiInputMapping& mapping, double midi, uint8_t raw) {
    const int deck = mapping.deck;
    if (mapping.option == MidiOption::Script) {
        switch (mapping.script) {
        case ScriptFunction::JogTurn:
            post(Target::JogTurn, deck, 0, static_cast<int>(raw) - 64);
            break;
        case ScriptFunction::JogSearch:
            post(Target::JogSearch, deck, 0, static_cast<int>(raw) - 64);
            break;
        case ScriptFunction::JogTouch:
            post(Target::JogTouch, deck, 0, raw != 0 ? 1 : 0);
            break;
        case ScriptFunction::TempoSliderMsb:
            if (deck >= 0 && deck < 2) {
                m_tempoMsb[deck] = raw;
            }
            break;
        case ScriptFunction::TempoSliderLsb:
            if (deck >= 0 && deck < 2) {
                // PioneerDDJFLX4.tempoSliderLSB
                const int fullValue = (m_tempoMsb[deck] << 7) + raw;
                post(Target::Rate, deck, 0, 1 - (fullValue / static_cast<double>(0x2000)));
            }
            break;
        case ScriptFunction::CycleTempoRange:
            post(Target::CycleTempoRange, deck, 0, raw != 0 ? 1 : 0);
            break;
        case ScriptFunction::Shift:
        case ScriptFunction::None:
            break;
        }
        return;
    }

    if (mapping.option == MidiOption::SelectKnob) {
        const int steps = raw >= 64 ? static_cast<int>(raw) - 128 : raw;
        post(mapping.target, deck, mapping.index, steps);
        return;
    }

    // The value each control's taper gives the MIDI value, as the matching
    // ControlObject behaviour in Mixxx would.
    double value = 0;
    switch (mapping.target) {
    case Target::Volume: {
        const AudioTaper taper(-20, 0, 1);
        value = taper.parameterToValue(taper.midiToParameter(midi));
        break;
    }
    case Target::Pregain: {
        const AudioTaper taper(-12, 12, 0.5);
        value = taper.parameterToValue(taper.midiToParameter(midi));
        break;
    }
    case Target::MainGain:
    case Target::HeadGain: {
        const AudioTaper taper(-14, 14, 0.5);
        value = taper.parameterToValue(taper.midiToParameter(midi));
        break;
    }
    case Target::EqLow:
    case Target::EqMid:
    case Target::EqHigh:
        // Biquad Equalizer knobs: linear 0..2.
        value = LinearTaper{0, 2}.parameterToValue(potmeterMidiToParameter(midi));
        break;
    case Target::Filter:
        value = potmeterMidiToParameter(midi);
        break;
    case Target::Crossfader:
    case Target::HeadMix:
        value = LinearTaper{-1, 1}.parameterToValue(potmeterMidiToParameter(midi));
        break;
    default:
        // Buttons: any non-zero value is a press.
        value = raw != 0 ? 1 : 0;
        break;
    }
    post(mapping.target, deck, mapping.index, value);
}

MidiOutputs::MidiOutputs(const Engine* engine, const ControllerMapping* mapping,
        SendFunction send, void* context)
        : m_engine(engine), m_mapping(mapping), m_send(send), m_context(context) {
    for (int16_t& last : m_last) {
        last = -1;
    }
}

void MidiOutputs::update(bool force) {
    DeckStatus status[kNumDecks];
    for (int d = 0; d < kNumDecks; ++d) {
        status[d] = m_engine->deckStatus(d);
    }
    for (size_t i = 0; i < m_mapping->outputCount && i < 256; ++i) {
        const MidiOutputMapping& output = m_mapping->outputs[i];
        if (output.deck < 0 || output.deck >= kNumDecks) {
            continue;
        }
        const DeckStatus& s = status[output.deck];
        double value = 0;
        switch (output.source) {
        case OutputSource::PlayIndicator:
            value = s.playing ? 1 : 0;
            break;
        case OutputSource::CueIndicator:
            value = s.cueIndicator ? 1 : 0;
            break;
        case OutputSource::HotcueStatus:
            value = (s.hotcuesSet >> output.index) & 1;
            break;
        case OutputSource::Pfl:
            value = s.pfl ? 1 : 0;
            break;
        case OutputSource::TrackLoaded:
            value = s.trackLoaded ? 1 : 0;
            break;
        case OutputSource::LoopEnabled:
            value = s.loopEnabled ? 1 : 0;
            break;
        }
        // MidiOutputHandler::controlChanged
        const uint8_t byte3 =
                (value >= static_cast<double>(output.minimum) &&
                        value <= static_cast<double>(output.maximum))
                ? output.on
                : output.off;
        if (!force && m_last[i] == byte3) {
            continue;
        }
        m_last[i] = byte3;
        const uint8_t bytes[3] = {output.status, output.midino, byte3};
        m_send(bytes, sizeof(bytes), m_context);
    }
}

} // namespace mz
