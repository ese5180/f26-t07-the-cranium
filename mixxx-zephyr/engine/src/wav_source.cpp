#include <cmath>
#include <cstring>

#include "mz/audio_source.h"

namespace mz {

namespace {

constexpr uint16_t kFormatPcm = 1;
constexpr uint16_t kFormatFloat = 3;
constexpr uint16_t kFormatExtensible = 0xFFFE;

uint16_t le16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (p[1] << 8));
}

uint32_t le32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
            (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

int16_t floatToS16(float sample) {
    if (!(sample == sample)) { // NaN
        return 0;
    }
    float scaled = sample * 32768.0f;
    if (scaled > 32767.0f) {
        scaled = 32767.0f;
    } else if (scaled < -32768.0f) {
        scaled = -32768.0f;
    }
    return static_cast<int16_t>(std::lrintf(scaled));
}

// One sample of the file's format, reduced to 16 bits.
int16_t decodeSample(const uint8_t* p, uint16_t bits, bool isFloat) {
    if (isFloat) {
        float f;
        std::memcpy(&f, p, sizeof(f));
        return floatToS16(f);
    }
    switch (bits) {
    case 8:
        return static_cast<int16_t>((static_cast<int>(p[0]) - 128) * 256);
    case 16:
        return static_cast<int16_t>(le16(p));
    case 24:
        // Keep the top 16 bits of the 24.
        return static_cast<int16_t>(static_cast<uint16_t>(p[1] | (p[2] << 8)));
    case 32:
        return static_cast<int16_t>(static_cast<int32_t>(le32(p)) >> 16);
    default:
        return 0;
    }
}

} // namespace

WavSource::WavSource()
        : m_file(nullptr),
          m_dataOffset(0),
          m_frames(0),
          m_sampleRate(0),
          m_channels(0),
          m_bitsPerSample(0),
          m_bytesPerFrame(0),
          m_float(false) {
}

bool WavSource::open(File* file) {
    m_file = file;
    m_frames = 0;
    uint8_t header[12];
    if (file == nullptr || file->read(0, header, sizeof(header)) != sizeof(header)) {
        return false;
    }
    if (std::memcmp(header, "RIFF", 4) != 0 || std::memcmp(header + 8, "WAVE", 4) != 0) {
        return false;
    }

    const uint64_t fileSize = file->size();
    uint64_t offset = 12;
    bool haveFormat = false;
    while (offset + 8 <= fileSize) {
        uint8_t chunk[8];
        if (file->read(offset, chunk, sizeof(chunk)) != sizeof(chunk)) {
            return false;
        }
        const uint32_t chunkSize = le32(chunk + 4);
        const uint64_t body = offset + 8;

        if (std::memcmp(chunk, "fmt ", 4) == 0) {
            uint8_t fmt[40];
            const size_t want = chunkSize < sizeof(fmt) ? chunkSize : sizeof(fmt);
            if (want < 16 || file->read(body, fmt, want) != static_cast<long>(want)) {
                return false;
            }
            uint16_t format = le16(fmt);
            m_channels = le16(fmt + 2);
            m_sampleRate = le32(fmt + 4);
            m_bitsPerSample = le16(fmt + 14);
            if (format == kFormatExtensible && want >= 26) {
                // The sub-format GUID starts with the plain format code.
                format = le16(fmt + 24);
            }
            m_float = format == kFormatFloat;
            const bool supportedFormat = (format == kFormatPcm &&
                                                 (m_bitsPerSample == 8 ||
                                                         m_bitsPerSample == 16 ||
                                                         m_bitsPerSample == 24 ||
                                                         m_bitsPerSample == 32)) ||
                    (m_float && m_bitsPerSample == 32);
            if (!supportedFormat || m_channels < 1 || m_channels > 2 ||
                    m_sampleRate < 8000 || m_sampleRate > 192000) {
                return false;
            }
            m_bytesPerFrame = static_cast<uint16_t>(m_channels * (m_bitsPerSample / 8));
            haveFormat = true;
        } else if (std::memcmp(chunk, "data", 4) == 0) {
            if (!haveFormat) {
                return false;
            }
            m_dataOffset = body;
            uint64_t dataSize = chunkSize;
            // A truncated file, or a streamed one with a placeholder size.
            if (dataSize == 0xFFFFFFFFu || body + dataSize > fileSize) {
                dataSize = fileSize - body;
            }
            m_frames = static_cast<int64_t>(dataSize / m_bytesPerFrame);
            return m_frames > 0;
        }
        // Chunks are padded to an even length.
        offset = body + chunkSize + (chunkSize & 1);
    }
    return false;
}

int64_t WavSource::readFrames(int64_t frame, int64_t count, int16_t* out) {
    if (m_file == nullptr || frame < 0 || frame >= m_frames || count <= 0) {
        return 0;
    }
    if (frame + count > m_frames) {
        count = m_frames - frame;
    }

    // Read in pieces through a small stack buffer; 16-bit stereo, the common
    // case, is read straight into the output.
    if (m_bitsPerSample == 16 && m_channels == 2 && !m_float) {
        const long bytes = m_file->read(m_dataOffset + static_cast<uint64_t>(frame) * 4,
                out,
                static_cast<size_t>(count) * 4);
        return bytes < 0 ? 0 : bytes / 4;
    }

    uint8_t buffer[512];
    const int64_t framesPerRead = static_cast<int64_t>(sizeof(buffer) / m_bytesPerFrame);
    const uint16_t bytesPerSample = m_bitsPerSample / 8;
    int64_t done = 0;
    while (done < count) {
        int64_t n = count - done;
        if (n > framesPerRead) {
            n = framesPerRead;
        }
        const long bytes = m_file->read(
                m_dataOffset + static_cast<uint64_t>(frame + done) * m_bytesPerFrame,
                buffer,
                static_cast<size_t>(n * m_bytesPerFrame));
        if (bytes <= 0) {
            break;
        }
        n = bytes / m_bytesPerFrame;
        for (int64_t i = 0; i < n; ++i) {
            const uint8_t* p = buffer + i * m_bytesPerFrame;
            const int16_t left = decodeSample(p, m_bitsPerSample, m_float);
            const int16_t right = m_channels == 2
                    ? decodeSample(p + bytesPerSample, m_bitsPerSample, m_float)
                    : left;
            out[2 * (done + i)] = left;
            out[2 * (done + i) + 1] = right;
        }
        done += n;
        if (n == 0) {
            break;
        }
    }
    return done;
}

} // namespace mz
