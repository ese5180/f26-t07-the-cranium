// WAV parsing and the chunk cache.
#include <vector>

#include "mz/audio_source.h"
#include "mz/caching_reader.h"
#include "support.h"
#include "test.h"

using namespace mz_test;

namespace {

// A source whose frame i is (i % 30000, -(i % 30000)), with no file behind it.
class RampSource : public mz::AudioSource {
  public:
    explicit RampSource(int64_t frames)
            : m_frames(frames) {
    }
    int64_t frameCount() const override {
        return m_frames;
    }
    uint32_t sampleRate() const override {
        return 44100;
    }
    int64_t readFrames(int64_t frame, int64_t count, int16_t* out) override {
        ++reads;
        int64_t n = 0;
        for (; n < count && frame + n < m_frames; ++n) {
            const auto v = static_cast<int16_t>((frame + n) % 30000);
            out[2 * n] = v;
            out[2 * n + 1] = static_cast<int16_t>(-v);
        }
        return n;
    }
    int reads = 0;

  private:
    int64_t m_frames;
};

} // namespace

TEST(wav16StereoReadsBack) {
    auto bytes = makeWav16(44100, 1000, [](int64_t i) { return i; }, [](int64_t i) { return -i; });
    MemoryFile file(bytes);
    mz::WavSource wav;
    CHECK(wav.open(&file));
    CHECK(wav.frameCount() == 1000);
    CHECK(wav.sampleRate() == 44100);
    int16_t out[20];
    CHECK(wav.readFrames(500, 10, out) == 10);
    CHECK(out[0] == 500 && out[1] == -500 && out[18] == 509);
    CHECK(wav.readFrames(995, 10, out) == 5);
    CHECK(wav.readFrames(1000, 10, out) == 0);
}

TEST(wavOtherFormatsReduceTo16Bit) {
    // 24-bit mono: 0x123456 keeps its top 16 bits, on both sides.
    std::vector<uint8_t> data24 = {0x56, 0x34, 0x12, 0x00, 0x00, 0x80};
    MemoryFile file24(makeWav(1, 1, 48000, 24, data24));
    mz::WavSource wav24;
    CHECK(wav24.open(&file24));
    int16_t out[4];
    CHECK(wav24.readFrames(0, 2, out) == 2);
    CHECK(out[0] == 0x1234 && out[1] == 0x1234);
    CHECK(out[2] == -32768 && out[3] == -32768);

    // 32-bit float stereo, clipped to the 16-bit range.
    std::vector<uint8_t> dataF;
    for (float f : {0.5f, -0.25f, 2.0f, -2.0f}) {
        uint32_t bits;
        std::memcpy(&bits, &f, 4);
        put32(dataF, bits);
    }
    MemoryFile fileF(makeWav(3, 2, 44100, 32, dataF));
    mz::WavSource wavF;
    CHECK(wavF.open(&fileF));
    CHECK(wavF.isFloat());
    CHECK(wavF.readFrames(0, 2, out) == 2);
    CHECK(out[0] == 16384 && out[1] == -8192 && out[2] == 32767 && out[3] == -32768);

    // 8-bit unsigned.
    MemoryFile file8(makeWav(1, 1, 22050, 8, {0x80, 0xFF, 0x00}));
    mz::WavSource wav8;
    CHECK(wav8.open(&file8));
    int16_t out8[6];
    CHECK(wav8.readFrames(0, 3, out8) == 3);
    CHECK(out8[0] == 0 && out8[2] == 127 * 256 && out8[4] == -32768);
}

TEST(wavExtensibleHeaderAndPaddedChunks) {
    std::vector<uint8_t> data;
    put16(data, 1234);
    put16(data, 4321);
    MemoryFile file(makeWav(1, 2, 96000, 16, data, true, true));
    mz::WavSource wav;
    CHECK(wav.open(&file));
    CHECK(wav.sampleRate() == 96000);
    int16_t out[2];
    CHECK(wav.readFrames(0, 1, out) == 1);
    CHECK(out[0] == 1234 && out[1] == 4321);
}

TEST(wavRejectsWhatItCannotPlay) {
    mz::WavSource wav;
    MemoryFile notWav(std::vector<uint8_t>{'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0, 0, 0, 0});
    CHECK(!wav.open(&notWav));
    // IMA ADPCM (format 0x11) is compressed.
    MemoryFile adpcm(makeWav(0x11, 2, 44100, 4, std::vector<uint8_t>(64, 0)));
    CHECK(!wav.open(&adpcm));
    // Six channels.
    MemoryFile surround(makeWav(1, 6, 48000, 16, std::vector<uint8_t>(120, 0)));
    CHECK(!wav.open(&surround));
    CHECK(!wav.open(nullptr));
}

TEST(readerPlaysSilenceUntilTheWorkerDelivers) {
    RampSource source(mz::kChunkFrames * 10);
    mz::CachingReader reader;
    const uint32_t generation = reader.beginTrack(&source);
    reader.setTrack(generation, source.frameCount());

    int16_t l, r;
    reader.frame(100, &l, &r);
    CHECK(l == 0 && r == 0);
    CHECK(reader.underruns() == 1);
    CHECK(reader.serviceRequests() == 1);
    reader.frame(100, &l, &r);
    CHECK(l == 100 && r == -100);
    CHECK(reader.underruns() == 1);
}

TEST(readerPrefetchesAheadAndEvictsTheOldest) {
    RampSource source(mz::kChunkFrames * 40);
    mz::CachingReader reader;
    reader.setTrack(reader.beginTrack(&source), source.frameCount());

    // Walk through the track as playback would; prefetch keeps us ahead.
    int16_t l, r;
    reader.prefetch(0, true);
    reader.serviceRequests();
    for (int64_t frame = 0; frame < mz::kChunkFrames * 30; frame += 256) {
        reader.tick();
        reader.prefetch(frame, true);
        reader.serviceRequests();
        reader.frame(frame, &l, &r);
        CHECK(l == static_cast<int16_t>(frame % 30000));
    }
    CHECK(reader.underruns() == 0);
    // Each chunk read about once, despite the small cache.
    CHECK(source.reads < 40);
}

TEST(readerDropsChunksOfThePreviousTrack) {
    RampSource first(mz::kChunkFrames * 4);
    RampSource second(mz::kChunkFrames * 4);
    mz::CachingReader reader;
    reader.setTrack(reader.beginTrack(&first), first.frameCount());
    int16_t l, r;
    reader.frame(10, &l, &r); // requests chunk 0 of the first track
    // The worker switches tracks before serving the request.
    const uint32_t generation = reader.beginTrack(&second);
    CHECK(reader.serviceRequests() == 0);
    CHECK(first.reads == 0);
    reader.setTrack(generation, second.frameCount());
    reader.frame(10, &l, &r);
    reader.serviceRequests();
    reader.frame(10, &l, &r);
    CHECK(l == 10);
    CHECK(second.reads == 1);
}
