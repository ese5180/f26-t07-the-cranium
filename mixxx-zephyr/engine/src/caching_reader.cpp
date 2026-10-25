#include "mz/caching_reader.h"

namespace mz {

namespace {

constexpr int kChunkShift = __builtin_ctz(static_cast<unsigned>(kChunkFrames));

int32_t chunkOf(int64_t frame) {
    return static_cast<int32_t>(frame >> kChunkShift);
}

} // namespace

CachingReader::CachingReader()
        : m_generation(0),
          m_frameCount(0),
          m_clock(0),
          m_underruns(0),
          m_lastChunk(nullptr),
          m_lastMissing(-1),
          m_source(nullptr),
          m_workerGeneration(0) {
    for (auto& chunk : m_chunks) {
        chunk.state.store(kFree, std::memory_order_relaxed);
        chunk.index = -1;
        chunk.generation = 0;
        chunk.lastUse = 0;
        chunk.frames = 0;
    }
}

void CachingReader::setTrack(uint32_t generation, int64_t frameCount) {
    m_generation = generation;
    m_frameCount = frameCount;
    m_lastChunk = nullptr;
    m_lastMissing = -1;
    m_underruns = 0;
}

const CachingReader::Chunk* CachingReader::find(int32_t chunkIndex) {
    if (m_lastChunk != nullptr && m_lastChunk->index == chunkIndex &&
            m_lastChunk->generation == m_generation &&
            m_lastChunk->state.load(std::memory_order_acquire) == kReady) {
        return m_lastChunk;
    }
    for (auto& chunk : m_chunks) {
        if (chunk.index == chunkIndex && chunk.generation == m_generation &&
                chunk.state.load(std::memory_order_acquire) == kReady) {
            chunk.lastUse = m_clock;
            m_lastChunk = &chunk;
            return &chunk;
        }
    }
    return nullptr;
}

void CachingReader::request(int32_t chunkIndex) {
    if (chunkIndex < 0 || static_cast<int64_t>(chunkIndex) * kChunkFrames >= m_frameCount) {
        return;
    }
    for (auto& chunk : m_chunks) {
        if (chunk.index == chunkIndex && chunk.generation == m_generation) {
            const uint8_t state = chunk.state.load(std::memory_order_acquire);
            if (state == kReady) {
                chunk.lastUse = m_clock;
                return; // already in memory
            }
            if (state == kRequested) {
                return; // on its way
            }
        }
    }
    // A free chunk or one of an old track if there is one, otherwise the
    // least recently used. Chunks the worker is filling are never taken.
    Chunk* victim = nullptr;
    for (auto& chunk : m_chunks) {
        const uint8_t state = chunk.state.load(std::memory_order_acquire);
        if (state == kRequested) {
            continue;
        }
        if (state == kFree || chunk.generation != m_generation) {
            victim = &chunk;
            break;
        }
        if (victim == nullptr || chunk.lastUse < victim->lastUse) {
            victim = &chunk;
        }
    }
    if (victim == nullptr) {
        return; // every chunk is being filled; try again next block
    }
    if (victim == m_lastChunk) {
        m_lastChunk = nullptr;
    }
    victim->index = chunkIndex;
    victim->generation = m_generation;
    victim->lastUse = m_clock;
    victim->state.store(kRequested, std::memory_order_release);
    const auto slot = static_cast<uint8_t>(victim - m_chunks);
    if (!m_requests.push(slot)) {
        victim->state.store(kFree, std::memory_order_release);
    }
}

void CachingReader::frame(int64_t index, int16_t* left, int16_t* right) {
    if (index < 0 || index >= m_frameCount) {
        *left = 0;
        *right = 0;
        return;
    }
    const int32_t chunkIndex = chunkOf(index);
    const Chunk* chunk = find(chunkIndex);
    const int32_t offset = static_cast<int32_t>(index & (kChunkFrames - 1));
    if (chunk == nullptr || offset >= chunk->frames) {
        ++m_underruns;
        if (chunkIndex != m_lastMissing) {
            m_lastMissing = chunkIndex;
            request(chunkIndex);
        }
        *left = 0;
        *right = 0;
        return;
    }
    *left = chunk->samples[2 * offset];
    *right = chunk->samples[2 * offset + 1];
}

void CachingReader::prefetch(int64_t position, bool forward) {
    if (m_frameCount <= 0) {
        return;
    }
    const int32_t current = chunkOf(position < 0 ? 0 : position);
    const int32_t step = forward ? 1 : -1;
    // The current chunk, the next two in the play direction, and the one
    // behind for a quick scratch back.
    request(current);
    request(current + step);
    request(current + 2 * step);
    request(current - step);
}

uint32_t CachingReader::beginTrack(AudioSource* source) {
    m_source = source;
    return ++m_workerGeneration;
}

int CachingReader::serviceRequests() {
    int filled = 0;
    uint8_t slot;
    while (m_requests.pop(&slot)) {
        Chunk& chunk = m_chunks[slot];
        if (chunk.state.load(std::memory_order_acquire) != kRequested) {
            continue;
        }
        if (chunk.generation != m_workerGeneration || m_source == nullptr) {
            // Asked for before the track changed.
            chunk.state.store(kFree, std::memory_order_release);
            continue;
        }
        const int64_t first = static_cast<int64_t>(chunk.index) * kChunkFrames;
        const int64_t got = m_source->readFrames(first, kChunkFrames, chunk.samples);
        chunk.frames = static_cast<int32_t>(got);
        for (int64_t i = got; i < kChunkFrames; ++i) {
            chunk.samples[2 * i] = 0;
            chunk.samples[2 * i + 1] = 0;
        }
        chunk.state.store(kReady, std::memory_order_release);
        ++filled;
    }
    return filled;
}

} // namespace mz
