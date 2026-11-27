#pragma once
#include "track/taglib/trackmetadata_file.h"

namespace rx3 {
// AAC and ALAC share the M4A extension. Inspect the MP4 audio properties
// on a worker thread instead of putting an H on every M4A browser row.
inline bool isAlacAudioFile(const QString& path) {
    TagLib::MP4::File file(TAGLIB_FILENAME_FROM_QSTRING(path));
    const auto* properties = file.audioProperties();
    return file.isValid() && properties &&
            properties->codec() == TagLib::MP4::Properties::ALAC;
}
} // namespace rx3
