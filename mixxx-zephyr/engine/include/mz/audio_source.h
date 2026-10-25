// Reading audio files.
//
// Mixxx decodes through SoundSource plug-ins (FFmpeg, libsndfile, ...) behind
// mixxx::AudioSource. Here a File gives random-access bytes, and an
// AudioSource turns them into 16-bit stereo frames at the file's own rate.
// Only uncompressed WAV is decoded so far.
#pragma once

#include <cstddef>
#include <cstdint>

namespace mz {

// Random-access file. The host build implements it on stdio, the Zephyr
// build on the Zephyr file-system API (FAT on an SD card).
class File {
  public:
    virtual ~File() = default;
    // Reads up to length bytes at offset; returns the number read, or -1.
    virtual long read(uint64_t offset, void* buffer, size_t length) = 0;
    virtual uint64_t size() = 0;
};

class AudioSource {
  public:
    virtual ~AudioSource() = default;

    virtual int64_t frameCount() const = 0;
    virtual uint32_t sampleRate() const = 0;

    // Fills out with up to count interleaved stereo frames starting at frame;
    // returns the number of frames written. Mono files come out on both sides.
    virtual int64_t readFrames(int64_t frame, int64_t count, int16_t* out) = 0;
};

// Uncompressed RIFF/WAVE: 8, 16, 24 or 32-bit integer PCM or 32-bit float,
// mono or stereo, any sample rate, plain or WAVE_FORMAT_EXTENSIBLE headers.
class WavSource : public AudioSource {
  public:
    WavSource();

    // Parses the header. Returns false for anything this reader cannot play.
    bool open(File* file);

    int64_t frameCount() const override {
        return m_frames;
    }
    uint32_t sampleRate() const override {
        return m_sampleRate;
    }
    int64_t readFrames(int64_t frame, int64_t count, int16_t* out) override;

    uint16_t channels() const {
        return m_channels;
    }
    uint16_t bitsPerSample() const {
        return m_bitsPerSample;
    }
    bool isFloat() const {
        return m_float;
    }

  private:
    File* m_file;
    uint64_t m_dataOffset;
    int64_t m_frames;
    uint32_t m_sampleRate;
    uint16_t m_channels;
    uint16_t m_bitsPerSample;
    uint16_t m_bytesPerFrame;
    bool m_float;
};

} // namespace mz
