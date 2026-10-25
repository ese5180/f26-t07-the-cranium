// Streams a track from storage into a fixed set of chunks.
//
// Ported in spirit from Mixxx's src/engine/cachingreader/: the audio thread
// never waits for storage. It reads frames from chunks that are already in
// memory, asks a worker thread for the chunks it is about to need, and plays
// silence for any frame whose chunk has not arrived yet (counted as an
// underrun, as Mixxx logs a cache miss).
//
// Threads:
//   audio thread   frame(), prefetch(), setTrack() on a load message
//   worker thread  serviceRequests(), beginTrack()
// The only shared state is each chunk's atomic state and the request queue.
#pragma once

#include <atomic>
#include <cstdint>

#include "mz/audio_source.h"
#include "mz/config.h"
#include "mz/spsc_queue.h"

namespace mz {

class CachingReader {
  public:
    CachingReader();

    // ---- audio thread ----

    // Switches to the track the worker announced. Old chunks are dropped.
    void setTrack(uint32_t generation, int64_t frameCount);

    int64_t frameCount() const {
        return m_frameCount;
    }

    // One stereo frame; zeros if its chunk is not in memory yet.
    void frame(int64_t index, int16_t* left, int16_t* right);

    // Asks for the chunks around a play position, in the direction of play.
    void prefetch(int64_t position, bool forward);

    // Frames played as silence because their chunk was missing.
    uint32_t underruns() const {
        return m_underruns;
    }

    // Called once per audio block, for the least-recently-used choice.
    void tick() {
        ++m_clock;
        m_lastMissing = -1;
    }

    // ---- worker thread ----

    // Starts reading a new source; returns the generation to announce to the
    // audio thread with setTrack(). source may be nullptr (eject).
    uint32_t beginTrack(AudioSource* source);

    // Fills requested chunks. Returns the number filled.
    int serviceRequests();

  private:
    enum State : uint8_t {
        kFree = 0,
        kRequested = 1,
        kReady = 2,
    };

    struct Chunk {
        std::atomic<uint8_t> state;
        // Written by the audio thread while the chunk is not kRequested;
        // read by the worker after it sees kRequested.
        int32_t index;
        uint32_t generation;
        uint32_t lastUse;
        int32_t frames;
        int16_t samples[kChunkFrames * 2];
    };

    const Chunk* find(int32_t chunkIndex);
    void request(int32_t chunkIndex);

    Chunk m_chunks[kChunksPerDeck];
    SpscQueue<uint8_t, 16> m_requests;

    // Audio thread.
    uint32_t m_generation;
    int64_t m_frameCount;
    uint32_t m_clock;
    uint32_t m_underruns;
    const Chunk* m_lastChunk;
    // The chunk last found missing this block, so it is requested only once.
    int32_t m_lastMissing;

    // Worker thread.
    AudioSource* m_source;
    uint32_t m_workerGeneration;
};

} // namespace mz
