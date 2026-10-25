// Helpers shared by the tests: files in memory and a WAV writer.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "mz/audio_source.h"
#include "mz/engine.h"

namespace mz_test {

class MemoryFile : public mz::File {
  public:
    explicit MemoryFile(std::vector<uint8_t> bytes)
            : m_bytes(std::move(bytes)) {
    }
    long read(uint64_t offset, void* buffer, size_t length) override {
        if (offset >= m_bytes.size()) {
            return 0;
        }
        const size_t n = std::min(length, static_cast<size_t>(m_bytes.size() - offset));
        std::memcpy(buffer, m_bytes.data() + offset, n);
        return static_cast<long>(n);
    }
    uint64_t size() override {
        return m_bytes.size();
    }

  private:
    std::vector<uint8_t> m_bytes;
};

class MemoryStorage : public mz::Storage {
  public:
    void add(const std::string& name, std::vector<uint8_t> bytes) {
        m_files[name] = std::move(bytes);
    }
    mz::File* open(const char* name) override {
        auto it = m_files.find(name);
        if (it == m_files.end()) {
            return nullptr;
        }
        ++opened;
        return new MemoryFile(it->second);
    }
    void close(mz::File* file) override {
        ++closed;
        delete file;
    }
    int opened = 0;
    int closed = 0;

  private:
    std::map<std::string, std::vector<uint8_t>> m_files;
};

inline void put16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back(static_cast<uint8_t>(v));
    b.push_back(static_cast<uint8_t>(v >> 8));
}

inline void put32(std::vector<uint8_t>& b, uint32_t v) {
    put16(b, static_cast<uint16_t>(v));
    put16(b, static_cast<uint16_t>(v >> 16));
}

// A WAV file. samples are per channel, interleaved, already in the target
// format's byte layout (see makeWav16 for the usual case).
inline std::vector<uint8_t> makeWav(uint16_t format, uint16_t channels, uint32_t rate,
        uint16_t bits, const std::vector<uint8_t>& data, bool extensible = false,
        bool extraChunk = false) {
    std::vector<uint8_t> b;
    b.insert(b.end(), {'R', 'I', 'F', 'F'});
    put32(b, 0); // patched below
    b.insert(b.end(), {'W', 'A', 'V', 'E'});
    if (extraChunk) {
        // A LIST chunk of odd length, which needs a pad byte.
        b.insert(b.end(), {'L', 'I', 'S', 'T'});
        put32(b, 3);
        b.insert(b.end(), {'a', 'b', 'c', 0});
    }
    b.insert(b.end(), {'f', 'm', 't', ' '});
    const uint16_t blockAlign = static_cast<uint16_t>(channels * bits / 8);
    put32(b, extensible ? 40 : 16);
    put16(b, extensible ? 0xFFFE : format);
    put16(b, channels);
    put32(b, rate);
    put32(b, rate * blockAlign);
    put16(b, blockAlign);
    put16(b, bits);
    if (extensible) {
        put16(b, 22);
        put16(b, bits);
        put32(b, channels == 2 ? 3 : 4);
        // Sub-format GUID: format code then the fixed tail.
        put16(b, format);
        b.insert(b.end(), {0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00,
                                  0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71});
    }
    b.insert(b.end(), {'d', 'a', 't', 'a'});
    put32(b, static_cast<uint32_t>(data.size()));
    b.insert(b.end(), data.begin(), data.end());
    const uint32_t riffSize = static_cast<uint32_t>(b.size() - 8);
    std::memcpy(b.data() + 4, &riffSize, 4);
    return b;
}

// 16-bit stereo where frame i holds (left(i), right(i)).
template<typename Left, typename Right>
std::vector<uint8_t> makeWav16(uint32_t rate, int64_t frames, Left left, Right right) {
    std::vector<uint8_t> data;
    data.reserve(static_cast<size_t>(frames) * 4);
    for (int64_t i = 0; i < frames; ++i) {
        put16(data, static_cast<uint16_t>(left(i)));
        put16(data, static_cast<uint16_t>(right(i)));
    }
    return makeWav(1, 2, rate, 16, data);
}

// A sine at frequency Hz and amplitude (of full scale), 16-bit stereo.
inline std::vector<uint8_t> makeSineWav(uint32_t rate, double seconds, double frequency,
        double amplitude = 0.5) {
    const auto frames = static_cast<int64_t>(rate * seconds);
    auto sample = [=](int64_t i) {
        return static_cast<int16_t>(std::lrint(
                amplitude * 32767 * std::sin(2 * 3.14159265358979 * frequency * i / rate)));
    };
    return makeWav16(rate, frames, sample, sample);
}

// Renders blocks with the worker serviced in between, as the real threads
// would interleave. Returns the rendered audio.
inline std::vector<int16_t> run(mz::Engine& engine, mz::Storage& storage, int blocks,
        int frames = 256) {
    std::vector<int16_t> out(static_cast<size_t>(blocks) * frames * 2);
    for (int b = 0; b < blocks; ++b) {
        engine.serviceWorker(&storage);
        engine.render(out.data() + static_cast<size_t>(b) * frames * 2, frames);
    }
    engine.serviceWorker(&storage);
    return out;
}

inline double rms(const int16_t* samples, size_t count) {
    double sum = 0;
    for (size_t i = 0; i < count; ++i) {
        sum += static_cast<double>(samples[i]) * samples[i];
    }
    return count ? std::sqrt(sum / count) / 32768.0 : 0;
}

inline mz::ControlEvent event(mz::Target target, int deck, float value, int index = 0) {
    return mz::ControlEvent{target, static_cast<int8_t>(deck), static_cast<int8_t>(index), value};
}

} // namespace mz_test
