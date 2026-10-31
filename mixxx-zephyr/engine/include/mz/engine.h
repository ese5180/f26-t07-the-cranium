// The whole player: two decks, the mixer, the track library and the storage
// worker.
//
// Three threads use it, each through its own methods:
//   control thread  post() — MIDI and buttons; the only producer of events
//   audio thread    render()
//   worker thread   serviceWorker() — opens tracks and reads them from storage
// They exchange messages through lock-free queues only, so the audio thread
// never waits for the other two.
#pragma once

#include <atomic>
#include <cstdint>

#include "mz/audio_source.h"
#include "mz/caching_reader.h"
#include "mz/config.h"
#include "mz/controls.h"
#include "mz/deck.h"
#include "mz/mixer.h"
#include "mz/spsc_queue.h"

namespace mz {

// Where tracks live. The host build implements it on stdio, the Zephyr build
// on a FAT file system on the SD card.
class Storage {
  public:
    virtual ~Storage() = default;
    virtual File* open(const char* name) = 0;
    virtual void close(File* file) = 0;
};

// The track list the BROWSE knob scrolls through.
class Library {
  public:
    Library();

    // Before the threads start.
    bool add(const char* name);

    int count() const {
        return m_count;
    }
    const char* name(int index) const;

    int selected() const {
        return m_selected.load(std::memory_order_relaxed);
    }
    void move(int steps);
    void select(int index);

  private:
    char m_names[kMaxTracks][kMaxPathLength];
    int m_count;
    std::atomic<int> m_selected;
};

class Engine {
  public:
    explicit Engine(uint32_t outputRate = 48000);

    Library& library() {
        return m_library;
    }

    // ---- control thread ----

    // Returns false if the queue is full and the event was dropped.
    bool post(const ControlEvent& event);
    // Loads a library track into a deck (the worker opens it).
    bool requestLoad(int deck, int trackIndex);

    // ---- audio thread ----

    // Renders frames (at most kMaxBlockFrames) of interleaved stereo 16-bit.
    void render(int16_t* out, int frames);
    void setOutputMode(OutputMode mode) {
        m_outputMode = mode;
    }

    // ---- worker thread ----

    // Opens requested tracks and fills chunk requests. Returns true if it did
    // any work, so the caller can sleep when it returns false.
    bool serviceWorker(Storage* storage);

    // ---- any thread ----

    DeckStatus deckStatus(int deck) const {
        return m_decks[deck].publishedStatus();
    }
    uint32_t droppedEvents() const {
        return m_dropped.load(std::memory_order_relaxed);
    }
    uint32_t outputRate() const {
        return m_outputRate;
    }

    // For tests on one thread.
    Deck& deck(int index) {
        return m_decks[index];
    }

  private:
    struct LoadRequest {
        int8_t deck;
        int16_t track;
    };
    struct LoadedMessage {
        int8_t deck;
        uint32_t generation;
        int64_t frameCount;
        uint32_t sampleRate;
    };

    uint32_t m_outputRate;
    OutputMode m_outputMode;
    Library m_library;

    CachingReader m_readers[kNumDecks];
    Deck m_decks[kNumDecks];
    Mixer m_mixer;

    // Worker thread state.
    File* m_files[kNumDecks];
    WavSource m_sources[kNumDecks];

    SpscQueue<ControlEvent, 256> m_events; // control -> audio
    SpscQueue<LoadRequest, 8> m_loads; // control -> worker
    SpscQueue<LoadedMessage, 8> m_loaded; // worker -> audio
    std::atomic<uint32_t> m_dropped;

    // Audio thread buffers.
    CSAMPLE m_deckBuffers[kNumDecks][kMaxBlockFrames * 2];
    CSAMPLE m_main[kMaxBlockFrames * 2];
    CSAMPLE m_headphones[kMaxBlockFrames * 2];
};

} // namespace mz
