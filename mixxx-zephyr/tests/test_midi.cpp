// MIDI parsing and the generated DDJ-FLX4 mapping, end to end.
#include <vector>

#include "mz/control_behavior.h"
#include "mz/midi.h"
#include "support.h"
#include "test.h"

using namespace mz_test;
using mz::Target;

namespace {

const mz::MidiInputMapping* findInput(Target target, int deck, mz::MidiOption option,
        mz::ScriptFunction script = mz::ScriptFunction::None, int index = 0) {
    const mz::ControllerMapping& m = mz::kPioneerDdjFlx4Mapping;
    for (size_t i = 0; i < m.inputCount; ++i) {
        const mz::MidiInputMapping& e = m.inputs[i];
        if (e.target == target && e.deck == deck && e.option == option && e.script == script &&
                e.index == index) {
            return &e;
        }
    }
    return nullptr;
}

struct Rig {
    Rig() {
        storage.add("a.wav", makeSineWav(44100, 10, 440));
        storage.add("b.wav", makeSineWav(44100, 10, 880));
        engine.library().add("a.wav");
        engine.library().add("b.wav");
        engine.requestLoad(0, 0);
        run(engine, storage, 2);
    }
    void send(uint8_t status, uint8_t data1, uint8_t data2) {
        mapper.process(mz::MidiMessage{status, data1, data2});
    }
    void press(const mz::MidiInputMapping* m) {
        send(m->status, m->midino, 0x7F);
        send(m->status, m->midino, 0x00);
    }
    mz::Engine engine{48000};
    MemoryStorage storage;
    mz::MidiMapper mapper{&engine, &mz::kPioneerDdjFlx4Mapping};
};

std::vector<std::vector<uint8_t>> g_sent;

void capture(const uint8_t* bytes, size_t length, void*) {
    g_sent.emplace_back(bytes, bytes + length);
}

} // namespace

TEST(parserHandlesRunningStatusRealtimeAndSysex) {
    mz::MidiParser parser;
    const uint8_t stream[] = {
            0x90, 0x0B, 0x7F, // note on
            0x0B, 0x00, // running status: the same note off
            0xF8, // clock in between
            0xB0, 0x13, 0xF8, 0x40, // clock inside a message
            0xF0, 0x00, 0x40, 0x05, 0xF7, // SysEx
            0xC2, 0x05, // program change, one data byte
            0x91, 0x0C, 0x7F};
    std::vector<mz::MidiMessage> messages;
    for (uint8_t byte : stream) {
        mz::MidiMessage m;
        if (parser.feed(byte, &m)) {
            messages.push_back(m);
        }
    }
    CHECK(messages.size() == 5);
    CHECK(messages[0].status == 0x90 && messages[0].data1 == 0x0B && messages[0].data2 == 0x7F);
    CHECK(messages[1].status == 0x90 && messages[1].data1 == 0x0B && messages[1].data2 == 0x00);
    CHECK(messages[2].status == 0xB0 && messages[2].data1 == 0x13 && messages[2].data2 == 0x40);
    CHECK(messages[3].status == 0xC2 && messages[3].data1 == 0x05);
    CHECK(messages[4].status == 0x91 && messages[4].data1 == 0x0C);
}

TEST(generatedMappingHasTheFlx4Essentials) {
    const mz::ControllerMapping& m = mz::kPioneerDdjFlx4Mapping;
    CHECK(m.inputCount == 99);
    CHECK(m.outputCount == 46);
    // PLAY/PAUSE (DECK1) in Pioneer-DDJ-FLX4.midi.xml: status 0x90, midino 0x0B.
    const mz::MidiInputMapping* play = findInput(Target::Play, 0, mz::MidiOption::Normal);
    CHECK(play != nullptr && play->status == 0x90 && play->midino == 0x0B);
    CHECK(findInput(Target::Volume, 1, mz::MidiOption::FourteenBitMsb) != nullptr);
    CHECK(findInput(Target::Crossfader, -1, mz::MidiOption::FourteenBitLsb) != nullptr);
    CHECK(findInput(Target::Filter, 0, mz::MidiOption::FourteenBitMsb) != nullptr);
    CHECK(findInput(Target::HotcueActivate, 1, mz::MidiOption::Normal,
                  mz::ScriptFunction::None, 7) != nullptr);
    CHECK(findInput(Target::None, 0, mz::MidiOption::Script, mz::ScriptFunction::JogTurn) !=
            nullptr);
    CHECK(findInput(Target::None, 1, mz::MidiOption::Script,
                  mz::ScriptFunction::TempoSliderLsb) != nullptr);
}

TEST(playButtonStartsTheDeckAndLightsItsLed) {
    Rig rig;
    g_sent.clear();
    mz::MidiOutputs leds(&rig.engine, &mz::kPioneerDdjFlx4Mapping, capture, nullptr);
    leds.update(true);
    const size_t initial = g_sent.size();
    CHECK(initial == mz::kPioneerDdjFlx4Mapping.outputCount);

    rig.press(findInput(Target::Play, 0, mz::MidiOption::Normal));
    run(rig.engine, rig.storage, 4);
    CHECK(rig.engine.deck(0).isPlaying());
    leds.update();
    bool lit = false;
    for (size_t i = initial; i < g_sent.size(); ++i) {
        if (g_sent[i] == std::vector<uint8_t>{0x90, 0x0B, 0x7F}) {
            lit = true;
        }
    }
    CHECK(lit);
    // Nothing changed: nothing more is sent.
    const size_t after = g_sent.size();
    leds.update();
    CHECK(g_sent.size() == after);
}

TEST(fourteenBitFaderReachesBothEnds) {
    Rig rig;
    const mz::MidiInputMapping* msb = findInput(Target::Volume, 0, mz::MidiOption::FourteenBitMsb);
    const mz::MidiInputMapping* lsb = findInput(Target::Volume, 0, mz::MidiOption::FourteenBitLsb);
    rig.send(msb->status, msb->midino, 0x00);
    rig.send(lsb->status, lsb->midino, 0x00);
    run(rig.engine, rig.storage, 1);
    CHECK(rig.engine.deck(0).volume() == 0.0);
    rig.send(msb->status, msb->midino, 0x7F);
    rig.send(lsb->status, lsb->midino, 0x7F);
    run(rig.engine, rig.storage, 1);
    CHECK(rig.engine.deck(0).volume() == 1.0);
    // Centre of a 14-bit fader: MSB 0x40, LSB 0.
    rig.send(msb->status, msb->midino, 0x40);
    rig.send(lsb->status, lsb->midino, 0x00);
    run(rig.engine, rig.storage, 1);
    const mz::AudioTaper volume(-20, 0, 1);
    CHECK_NEAR(rig.engine.deck(0).volume(), volume.parameterToValue(64 / 127.0), 1e-6);
}

TEST(eqAndFilterKnobsRestAtNeutral) {
    Rig rig;
    for (Target t : {Target::EqLow, Target::EqMid, Target::EqHigh, Target::Filter}) {
        const mz::MidiInputMapping* msb = findInput(t, 0, mz::MidiOption::FourteenBitMsb);
        const mz::MidiInputMapping* lsb = findInput(t, 0, mz::MidiOption::FourteenBitLsb);
        CHECK(msb != nullptr && lsb != nullptr);
        rig.send(msb->status, msb->midino, 0x40);
        rig.send(lsb->status, lsb->midino, 0x00);
    }
    // At neutral the deck's audio is unchanged: compare with a fresh rig.
    Rig plain;
    rig.engine.post(event(Target::Play, 0, 1));
    plain.engine.post(event(Target::Play, 0, 1));
    std::vector<int16_t> a = run(rig.engine, rig.storage, 30);
    std::vector<int16_t> b = run(plain.engine, plain.storage, 30);
    CHECK(a == b);
}

TEST(tempoSliderUsesTheScriptsFormula) {
    Rig rig;
    const mz::MidiInputMapping* msb =
            findInput(Target::None, 0, mz::MidiOption::Script, mz::ScriptFunction::TempoSliderMsb);
    const mz::MidiInputMapping* lsb =
            findInput(Target::None, 0, mz::MidiOption::Script, mz::ScriptFunction::TempoSliderLsb);
    CHECK(msb != nullptr && lsb != nullptr);
    // fullValue 0 -> rate 1 -> ratio 1 - 0.08.
    rig.send(msb->status, msb->midino, 0x00);
    rig.send(lsb->status, lsb->midino, 0x00);
    run(rig.engine, rig.storage, 1);
    CHECK_NEAR(rig.engine.deck(0).rateRatio(), 0.92, 1e-12);
    // fullValue 0x2000 (centre) -> rate 0.
    rig.send(msb->status, msb->midino, 0x40);
    rig.send(lsb->status, lsb->midino, 0x00);
    run(rig.engine, rig.storage, 1);
    CHECK_NEAR(rig.engine.deck(0).rateRatio(), 1.0, 1e-12);
}

TEST(browseAndLoadPickTheNextTrack) {
    Rig rig;
    const mz::MidiInputMapping* browse = findInput(Target::MoveVertical, -1, mz::MidiOption::SelectKnob);
    const mz::MidiInputMapping* load = findInput(Target::LoadSelectedTrack, 1, mz::MidiOption::Normal);
    CHECK(browse != nullptr && load != nullptr);
    rig.send(browse->status, browse->midino, 0x01); // one step down
    CHECK(rig.engine.library().selected() == 1);
    rig.send(browse->status, browse->midino, 0x7F); // one step up
    rig.send(browse->status, browse->midino, 0x01);
    rig.press(load);
    run(rig.engine, rig.storage, 2);
    CHECK(rig.engine.deckStatus(1).trackLoaded);
    CHECK(rig.storage.opened == 2);
}

TEST(jogWheelThroughTheMappingNudges) {
    Rig rig;
    const mz::MidiInputMapping* jog =
            findInput(Target::None, 0, mz::MidiOption::Script, mz::ScriptFunction::JogTurn);
    CHECK(jog != nullptr);
    rig.send(jog->status, jog->midino, 64 + 5); // 5 ticks forward, deck paused
    run(rig.engine, rig.storage, 300);
    CHECK(rig.engine.deck(0).position() > 0);
}

TEST(unknownMessagesAreCountedNotMapped) {
    Rig rig;
    rig.send(0x9F, 0x7E, 0x7F);
    CHECK(rig.mapper.unmapped() == 1);
}
