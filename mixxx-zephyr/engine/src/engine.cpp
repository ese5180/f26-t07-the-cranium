#include "mz/engine.h"

#include <cmath>
#include <cstring>

#include "mz/math.h"

namespace mz {

namespace {

int16_t toS16(CSAMPLE sample) {
    // Hard clip, as Mixxx does when it converts to an integer device format.
    float scaled = sample * 32768.0f;
    if (scaled > 32767.0f) {
        scaled = 32767.0f;
    } else if (scaled < -32768.0f) {
        scaled = -32768.0f;
    }
    return static_cast<int16_t>(std::lrintf(scaled));
}

} // namespace

Library::Library()
        : m_names{}, m_count(0), m_selected(0) {
}

bool Library::add(const char* name) {
    if (m_count >= kMaxTracks || name == nullptr) {
        return false;
    }
    const size_t length = std::strlen(name);
    if (length == 0 || length >= static_cast<size_t>(kMaxPathLength)) {
        return false;
    }
    std::memcpy(m_names[m_count], name, length + 1);
    ++m_count;
    return true;
}

const char* Library::name(int index) const {
    if (index < 0 || index >= m_count) {
        return nullptr;
    }
    return m_names[index];
}

void Library::move(int steps) {
    if (m_count == 0) {
        return;
    }
    int next = m_selected.load(std::memory_order_relaxed) + steps;
    next = clampValue(next, 0, m_count - 1);
    m_selected.store(next, std::memory_order_relaxed);
}

void Library::select(int index) {
    if (index >= 0 && index < m_count) {
        m_selected.store(index, std::memory_order_relaxed);
    }
}

Engine::Engine(uint32_t outputRate)
        : m_outputRate(outputRate),
          m_outputMode(OutputMode::Main),
          m_readers{},
          m_decks{Deck(&m_readers[0]), Deck(&m_readers[1])},
          m_files{},
          m_dropped(0) {
    static_assert(kNumDecks == 2, "the deck initialiser lists two decks");
    for (auto& deck : m_decks) {
        deck.setOutputRate(outputRate);
    }
}

bool Engine::post(const ControlEvent& event) {
    if (event.target == Target::MoveVertical) {
        m_library.move(static_cast<int>(event.value));
        return true;
    }
    if (event.target == Target::LoadSelectedTrack) {
        if (event.value > 0.5f) {
            return requestLoad(event.deck, m_library.selected());
        }
        return true;
    }
    if (!m_events.push(event)) {
        m_dropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    return true;
}

bool Engine::requestLoad(int deck, int trackIndex) {
    if (deck < 0 || deck >= kNumDecks || m_library.name(trackIndex) == nullptr) {
        return false;
    }
    if (!m_loads.push(LoadRequest{static_cast<int8_t>(deck), static_cast<int16_t>(trackIndex)})) {
        m_dropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    return true;
}

void Engine::render(int16_t* out, int frames) {
    if (frames > kMaxBlockFrames) {
        // Callers split larger requests; this keeps the buffers fixed.
        render(out, kMaxBlockFrames);
        render(out + 2 * kMaxBlockFrames, frames - kMaxBlockFrames);
        return;
    }

    LoadedMessage loaded;
    while (m_loaded.pop(&loaded)) {
        m_decks[loaded.deck].trackLoaded(loaded.generation, loaded.frameCount, loaded.sampleRate);
    }
    ControlEvent event;
    while (m_events.pop(&event)) {
        if (event.deck >= 0 && event.deck < kNumDecks) {
            m_decks[event.deck].control(event);
        } else {
            m_mixer.control(event);
        }
    }

    const CSAMPLE* deckBuffers[kNumDecks];
    double volumes[kNumDecks];
    bool pfl[kNumDecks];
    for (int d = 0; d < kNumDecks; ++d) {
        m_decks[d].process(m_deckBuffers[d], frames);
        deckBuffers[d] = m_deckBuffers[d];
        volumes[d] = m_decks[d].volume();
        pfl[d] = m_decks[d].pfl();
    }
    m_mixer.process(deckBuffers, volumes, pfl, frames, m_main, m_headphones);

    for (int i = 0; i < frames; ++i) {
        switch (m_outputMode) {
        case OutputMode::Main:
            out[2 * i] = toS16(m_main[2 * i]);
            out[2 * i + 1] = toS16(m_main[2 * i + 1]);
            break;
        case OutputMode::Headphones:
            out[2 * i] = toS16(m_headphones[2 * i]);
            out[2 * i + 1] = toS16(m_headphones[2 * i + 1]);
            break;
        case OutputMode::SplitCue:
            out[2 * i] = toS16(0.5f * (m_headphones[2 * i] + m_headphones[2 * i + 1]));
            out[2 * i + 1] = toS16(0.5f * (m_main[2 * i] + m_main[2 * i + 1]));
            break;
        }
    }

    for (auto& deck : m_decks) {
        deck.publishStatus();
    }
}

bool Engine::serviceWorker(Storage* storage) {
    bool worked = false;
    LoadRequest request;
    while (m_loads.pop(&request)) {
        worked = true;
        const int d = request.deck;
        if (m_files[d] != nullptr) {
            // The reader stops using the old source as soon as beginTrack()
            // moves to a new generation, and only this thread reads sources.
            m_readers[d].beginTrack(nullptr);
            storage->close(m_files[d]);
            m_files[d] = nullptr;
        }
        File* file = storage->open(m_library.name(request.track));
        LoadedMessage message{static_cast<int8_t>(d), 0, 0, 0};
        if (file != nullptr && m_sources[d].open(file)) {
            m_files[d] = file;
            message.generation = m_readers[d].beginTrack(&m_sources[d]);
            message.frameCount = m_sources[d].frameCount();
            message.sampleRate = m_sources[d].sampleRate();
        } else {
            if (file != nullptr) {
                storage->close(file);
            }
            message.generation = m_readers[d].beginTrack(nullptr);
        }
        // The queue has room for every load the control side may request.
        m_loaded.push(message);
    }
    for (auto& reader : m_readers) {
        if (reader.serviceRequests() > 0) {
            worked = true;
        }
    }
    return worked;
}

} // namespace mz
