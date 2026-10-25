// MIDI input and LED output.
//
// MidiParser turns a byte stream (a DIN-MIDI UART) into messages. MidiMapper
// applies a controller mapping as Mixxx's MidiController does: it finds the
// control for each message, joins 14-bit MSB/LSB pairs, converts the value
// with the control's taper, and posts the result to the engine. The mapping
// tables are generated from a Mixxx .midi.xml file by tools/gen_mapping.py;
// the handful of script functions the FLX4 mapping needs are built in.
// MidiOutputs does the reverse for LEDs, from the mapping's <outputs>.
#pragma once

#include <cstddef>
#include <cstdint>

#include "mz/controls.h"

namespace mz {

class Engine;

struct MidiMessage {
    uint8_t status;
    uint8_t data1;
    uint8_t data2;
};

// Running status is supported; real-time bytes are ignored and SysEx is
// skipped.
class MidiParser {
  public:
    MidiParser();
    // Returns true when byte completes a channel message.
    bool feed(uint8_t byte, MidiMessage* message);

  private:
    uint8_t m_status;
    uint8_t m_data[2];
    uint8_t m_count;
    bool m_inSysex;
};

enum class MidiOption : uint8_t {
    Normal,
    FourteenBitMsb,
    FourteenBitLsb,
    SelectKnob, // relative: 1..63 forward, 65..127 back
    Script, // a built-in replacement for a script function
};

// Script functions of the FLX4 mapping that are built in. Anything else the
// mapping binds to a script is left out by the generator.
enum class ScriptFunction : uint8_t {
    None,
    JogTurn,
    JogSearch,
    JogTouch,
    TempoSliderMsb,
    TempoSliderLsb,
    CycleTempoRange,
    Shift,
};

struct MidiInputMapping {
    uint8_t status;
    uint8_t midino;
    Target target;
    int8_t deck;
    int8_t index;
    MidiOption option;
    ScriptFunction script;
};

// What an LED shows.
enum class OutputSource : uint8_t {
    PlayIndicator,
    CueIndicator,
    HotcueStatus,
    Pfl,
    TrackLoaded,
    LoopEnabled,
};

struct MidiOutputMapping {
    OutputSource source;
    int8_t deck;
    int8_t index;
    uint8_t status;
    uint8_t midino;
    uint8_t on;
    uint8_t off;
    float minimum;
    float maximum;
};

struct ControllerMapping {
    const char* name;
    const MidiInputMapping* inputs;
    size_t inputCount;
    const MidiOutputMapping* outputs;
    size_t outputCount;
};

// The generated Pioneer DDJ-FLX4 mapping.
extern const ControllerMapping kPioneerDdjFlx4Mapping;

class MidiMapper {
  public:
    MidiMapper(Engine* engine, const ControllerMapping* mapping);

    // Control thread.
    void process(const MidiMessage& message);

    uint32_t unmapped() const {
        return m_unmapped;
    }

  private:
    void dispatch(const MidiInputMapping& mapping, double midiValue, uint8_t rawValue);
    void post(Target target, int deck, int index, double value);

    Engine* m_engine;
    const ControllerMapping* m_mapping;
    // Last MSB of each 14-bit control, by input index.
    uint8_t m_msb[512];
    uint8_t m_tempoMsb[2];
    uint32_t m_unmapped;
};

// Sends LED messages when a deck's state changes.
class MidiOutputs {
  public:
    using SendFunction = void (*)(const uint8_t* bytes, size_t length, void* context);

    MidiOutputs(const Engine* engine, const ControllerMapping* mapping,
            SendFunction send, void* context);

    // Call every few milliseconds from the control thread. force resends all.
    void update(bool force = false);

  private:
    const Engine* m_engine;
    const ControllerMapping* m_mapping;
    SendFunction m_send;
    void* m_context;
    int16_t m_last[256];
};

} // namespace mz
