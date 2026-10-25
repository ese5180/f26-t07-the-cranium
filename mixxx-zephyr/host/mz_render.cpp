// Renders a short mix through the engine, to hear it without hardware:
//
//   mz_render deck1.wav deck2.wav out.wav [seconds]
//
// Both decks start together. Over the run the crossfader moves from deck 1 to
// deck 2 while deck 1's filter knob sweeps down to a low-pass, as a DJ would
// fade one track out. The input files are read from the current directory's
// paths as given; the output is 48 kHz 16-bit stereo.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include "mz/engine.h"

namespace {

class StdioFile : public mz::File {
  public:
    explicit StdioFile(std::FILE* file)
            : m_file(file) {
        std::fseek(m_file, 0, SEEK_END);
        m_size = static_cast<uint64_t>(std::ftell(m_file));
    }
    ~StdioFile() override {
        std::fclose(m_file);
    }
    long read(uint64_t offset, void* buffer, size_t length) override {
        if (std::fseek(m_file, static_cast<long>(offset), SEEK_SET) != 0) {
            return -1;
        }
        return static_cast<long>(std::fread(buffer, 1, length, m_file));
    }
    uint64_t size() override {
        return m_size;
    }

  private:
    std::FILE* m_file;
    uint64_t m_size;
};

class StdioStorage : public mz::Storage {
  public:
    mz::File* open(const char* name) override {
        std::FILE* file = std::fopen(name, "rb");
        return file ? new StdioFile(file) : nullptr;
    }
    void close(mz::File* file) override {
        delete file;
    }
};

void writeLe(std::FILE* f, uint32_t value, int bytes) {
    for (int i = 0; i < bytes; ++i) {
        std::fputc(static_cast<int>((value >> (8 * i)) & 0xFF), f);
    }
}

bool writeWav(const char* path, const std::vector<int16_t>& samples, uint32_t rate) {
    std::FILE* f = std::fopen(path, "wb");
    if (!f) {
        return false;
    }
    const auto dataBytes = static_cast<uint32_t>(samples.size() * 2);
    std::fwrite("RIFF", 1, 4, f);
    writeLe(f, 36 + dataBytes, 4);
    std::fwrite("WAVEfmt ", 1, 8, f);
    writeLe(f, 16, 4);
    writeLe(f, 1, 2);
    writeLe(f, 2, 2);
    writeLe(f, rate, 4);
    writeLe(f, rate * 4, 4);
    writeLe(f, 4, 2);
    writeLe(f, 16, 2);
    std::fwrite("data", 1, 4, f);
    writeLe(f, dataBytes, 4);
    for (int16_t s : samples) {
        writeLe(f, static_cast<uint16_t>(s), 2);
    }
    return std::fclose(f) == 0;
}

mz::ControlEvent event(mz::Target target, int deck, double value) {
    return mz::ControlEvent{target, static_cast<int8_t>(deck), 0, static_cast<float>(value)};
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: %s deck1.wav deck2.wav out.wav [seconds]\n", argv[0]);
        return 2;
    }
    const double seconds = argc > 4 ? std::atof(argv[4]) : 20.0;
    constexpr uint32_t kRate = 48000;
    constexpr int kBlock = 256;

    static mz::Engine engine(kRate);
    StdioStorage storage;
    engine.library().add(argv[1]);
    engine.library().add(argv[2]);
    engine.requestLoad(0, 0);
    engine.requestLoad(1, 1);
    engine.serviceWorker(&storage);

    std::vector<int16_t> out;
    int16_t block[kBlock * 2];
    // Let the decks load and fill their caches before starting.
    for (int i = 0; i < 4; ++i) {
        engine.render(block, kBlock);
        engine.serviceWorker(&storage);
    }
    if (!engine.deckStatus(0).trackLoaded || !engine.deckStatus(1).trackLoaded) {
        std::fprintf(stderr, "cannot load %s or %s (uncompressed WAV only)\n", argv[1], argv[2]);
        return 1;
    }
    engine.post(event(mz::Target::Crossfader, -1, -1));
    engine.post(event(mz::Target::Play, 0, 1));
    engine.post(event(mz::Target::Play, 1, 1));

    const auto blocks = static_cast<int>(seconds * kRate / kBlock);
    for (int b = 0; b < blocks; ++b) {
        const double t = static_cast<double>(b) / blocks;
        engine.post(event(mz::Target::Crossfader, -1, -1 + 2 * t));
        engine.post(event(mz::Target::Filter, 0, 0.5 - 0.45 * t));
        engine.serviceWorker(&storage);
        engine.render(block, kBlock);
        out.insert(out.end(), block, block + kBlock * 2);
    }
    if (!writeWav(argv[3], out, kRate)) {
        std::fprintf(stderr, "cannot write %s\n", argv[3]);
        return 1;
    }
    std::printf("wrote %s: %.1f s, cache misses deck 1 %u, deck 2 %u\n", argv[3], seconds,
            engine.deckStatus(0).underruns, engine.deckStatus(1).underruns);
    return 0;
}
