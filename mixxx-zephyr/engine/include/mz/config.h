// Mixxx Zephyr: compile-time sizes of the engine.
//
// Everything the engine needs is allocated statically from these numbers, so
// nothing is allocated on the audio path and the RAM use is known at link time.
// A Zephyr build sets them from Kconfig (app/Kconfig); host builds use the
// defaults below.
#pragma once

#include <cstddef>
#include <cstdint>

#ifndef MZ_CHUNK_FRAMES
#define MZ_CHUNK_FRAMES 4096
#endif

#ifndef MZ_CHUNKS_PER_DECK
#define MZ_CHUNKS_PER_DECK 6
#endif

#ifndef MZ_MAX_BLOCK_FRAMES
#define MZ_MAX_BLOCK_FRAMES 512
#endif

#ifndef MZ_MAX_TRACKS
#define MZ_MAX_TRACKS 64
#endif

namespace mz {

// Sample type of the mixing engine, as CSAMPLE in Mixxx.
using CSAMPLE = float;

constexpr int kNumDecks = 2;
constexpr int kNumHotcues = 8;

// Frames per cache chunk. Mixxx uses 8192 frames of float; this port stores
// 16-bit stereo, so one chunk is kChunkFrames * 4 bytes.
constexpr int kChunkFrames = MZ_CHUNK_FRAMES;
constexpr int kChunksPerDeck = MZ_CHUNKS_PER_DECK;

// Largest block the audio callback may ask for.
constexpr int kMaxBlockFrames = MZ_MAX_BLOCK_FRAMES;

constexpr int kMaxTracks = MZ_MAX_TRACKS;
constexpr int kMaxPathLength = 96;

static_assert((kChunkFrames & (kChunkFrames - 1)) == 0,
        "MZ_CHUNK_FRAMES must be a power of two");
static_assert(kChunksPerDeck >= 3,
        "a deck needs at least the current, the next and the previous chunk");

} // namespace mz
