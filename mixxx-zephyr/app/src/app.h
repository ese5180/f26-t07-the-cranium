// Parts of the Zephyr application, started from main.cpp.
#pragma once

#include <cstdint>

#include "mz/engine.h"

namespace app {

// sd_storage.cpp
class SdStorage : public mz::Storage {
  public:
    mz::File* open(const char* name) override;
    void close(mz::File* file) override;
};
// Mounts the card and adds every .wav in CONFIG_MZ_MUSIC_DIR to the library.
int mountAndScan(mz::Library* library);

// audio_out.cpp: renders blocks and feeds them to I2S, forever.
int startAudio(mz::Engine* engine);
// Blocks written to I2S, and blocks the I2S queue ran dry before.
uint32_t audioBlocks();
uint32_t audioUnderruns();

// midi_uart.cpp: reads the MIDI UART into the engine and drives the LEDs.
int startMidi(mz::Engine* engine);

} // namespace app
