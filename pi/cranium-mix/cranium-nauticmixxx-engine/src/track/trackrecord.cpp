#include "track/trackrecord.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <cmath>
#include <limits>

#include "sources/metadatasource.h"
#include "track/keyfactory.h"
#include "util/fpclassify.h"
#include "util/logger.h"

namespace mixxx {

namespace {

const Logger kLogger("TrackRecord");

constexpr int kMaxExternalSourceDepth = 8;
constexpr int kMaxExternalSourceNodes = 4096;
constexpr int kMaxExternalSourceObjectKeys = 128;
constexpr int kMaxExternalSourceArrayItems = 256;
constexpr int kMaxExternalSourceKeyLength = 128;
constexpr int kMaxExternalSourceStringLength = 256 * 1024;

bool isValidExternalSourceValue(
        const QJsonValue& value,
        int depth,
        int* pRemainingNodes) {
    if (depth > kMaxExternalSourceDepth || --*pRemainingNodes < 0) {
        return false;
    }
    if (value.isString()) {
        return value.toString().size() <= kMaxExternalSourceStringLength;
    }
    if (value.isDouble()) {
        return util_isfinite(value.toDouble());
    }
    if (value.isArray()) {
        const auto array = value.toArray();
        if (array.size() > kMaxExternalSourceArrayItems) {
            return false;
        }
        for (const auto& child : array) {
            if (!isValidExternalSourceValue(child, depth + 1, pRemainingNodes)) {
                return false;
            }
        }
        return true;
    }
    if (value.isObject()) {
        const auto object = value.toObject();
        if (object.size() > kMaxExternalSourceObjectKeys) {
            return false;
        }
        for (auto it = object.constBegin(); it != object.constEnd(); ++it) {
            if (it.key().size() > kMaxExternalSourceKeyLength ||
                    !isValidExternalSourceValue(it.value(), depth + 1, pRemainingNodes)) {
                return false;
            }
        }
    }
    return true;
}

bool isIntegralJsonNumber(const QJsonValue& value, double minimum, double maximum) {
    if (!value.isDouble()) {
        return false;
    }
    const double number = value.toDouble();
    return util_isfinite(number) && number >= minimum && number <= maximum &&
            std::floor(number) == number;
}

} // anonymous namespace

/*static*/ const QString TrackRecord::kTrackTotalPlaceholder = QStringLiteral("//");

// static
bool TrackRecord::isValidExternalSource(const QJsonObject& source) {
    if (source.isEmpty()) {
        return true;
    }
    if (QJsonDocument(source).toJson(QJsonDocument::Compact).size() >
            kMaxExternalSourcePayloadBytes) {
        return false;
    }
    int remainingNodes = kMaxExternalSourceNodes;
    if (!isValidExternalSourceValue(source, 0, &remainingNodes)) {
        return false;
    }
    const auto provider = source.value(QStringLiteral("provider"));
    const auto version = source.value(QStringLiteral("version"));
    if (!provider.isString() || provider.toString().isEmpty() ||
            provider.toString().size() > 64 ||
            !isIntegralJsonNumber(version, 1, std::numeric_limits<int>::max())) {
        return false;
    }
    if (provider.toString() != QStringLiteral("rekordbox_usb")) {
        return true;
    }

    const auto root = source.value(QStringLiteral("root"));
    const auto relativePath = source.value(QStringLiteral("relative_path"));
    if (!root.isString() || root.toString().isEmpty() ||
            root.toString().contains(QChar::Null) ||
            !QFileInfo(root.toString()).isAbsolute() ||
            !relativePath.isString() || relativePath.toString().isEmpty() ||
            relativePath.toString().contains(QChar::Null)) {
        return false;
    }
    QString normalizedRelativePath = relativePath.toString();
    normalizedRelativePath.replace('\\', '/');
    if (normalizedRelativePath.startsWith(QStringLiteral("//")) ||
            normalizedRelativePath.contains(':')) {
        return false;
    }
    if (normalizedRelativePath.startsWith('/')) {
        normalizedRelativePath.remove(0, 1);
    }
    if (normalizedRelativePath.isEmpty() ||
            normalizedRelativePath.split('/').contains(QStringLiteral(".."))) {
        return false;
    }
    const auto rekordboxId = source.value(QStringLiteral("rekordbox_id"));
    return rekordboxId.isUndefined() ||
            isIntegralJsonNumber(rekordboxId, 0, std::numeric_limits<quint32>::max());
}

TrackRecord::TrackRecord(TrackId id)
        : m_id(std::move(id)),
          m_mainCuePosition(mixxx::audio::kStartFramePos),
          m_rating(0),
          m_bpmLocked(false),
          m_headerParsed(false) {
}

void TrackRecord::setKeys(Keys keys) {
    refMetadata().refTrackInfo().setKeyText(keys.getGlobalKeyText());
    m_keys = std::move(keys);
}

UpdateResult TrackRecord::updateGlobalKeyNormalizeText(
        const QString& keyText,
        track::io::key::Source keySource) {
    if (keyText.isEmpty()) {
        // User tries to delete the key
        setKeys(Keys());
        return UpdateResult::Updated;
    }
    // Try to parse the input as a key.
    mixxx::track::io::key::ChromaticKey newKey =
            KeyUtils::guessKeyFromText(keyText);
    if (newKey == mixxx::track::io::key::INVALID && !keyText.isEmpty()) {
        // revert if we can't guess a valid key from it
        return UpdateResult::Rejected;
    }

    // If the new key is the same as the old key, reject the change.
    if (m_keys.getGlobalKey() == newKey) {
        return UpdateResult::Unchanged;
    }

    Keys newKeys;
    if (keySource == mixxx::track::io::key::FILE_METADATA) {
        newKeys = KeyFactory::makeBasicKeysKeepText(
                keyText,
                mixxx::track::io::key::FILE_METADATA);
    } else {
        newKeys = KeyFactory::makeBasicKeys(newKey, keySource);
    }
    setKeys(newKeys);
    return UpdateResult::Updated;
}

namespace {

#if defined(__EXTRA_METADATA__)
bool mergeReplayGainMetadataProperty(
        ReplayGain* pMergedReplayGain,
        const ReplayGain& importedReplayGain) {
    bool modified = false;
    // Preserve the values calculated by Mixxx and only merge missing
    // values from the imported replay gain.
    if (!pMergedReplayGain->hasRatio() &&
            importedReplayGain.hasRatio()) {
        pMergedReplayGain->setRatio(importedReplayGain.getRatio());
        modified = true;
    }
    if (!pMergedReplayGain->hasPeak() &&
            importedReplayGain.hasPeak()) {
        pMergedReplayGain->setPeak(importedReplayGain.getPeak());
        modified = true;
    }
    return modified;
}

// This conditional copy operation only works for nullable properties
// like QString or QUuid.
template<typename T>
bool copyIfNotNull(
        gsl::not_null<T*> pMergedProperty,
        const T& importedProperty) {
    if (pMergedProperty->isNull() &&
            *pMergedProperty != importedProperty) {
        *pMergedProperty = importedProperty;
        return true;
    }
    return false;
}

// This conditional copy operation only works for properties where
// empty = missing.
template<typename T>
bool copyIfNotEmpty(
        gsl::not_null<T*> pMergedProperty,
        const T& importedProperty) {
    if (pMergedProperty->isEmpty() &&
            *pMergedProperty != importedProperty) {
        *pMergedProperty = importedProperty;
        return true;
    }
    return false;
}
#endif // __EXTRA_METADATA__

} // anonymous namespace

bool TrackRecord::updateSourceSynchronizedAt(
        const QDateTime& sourceSynchronizedAt) {
    VERIFY_OR_DEBUG_ASSERT(sourceSynchronizedAt.isValid()) {
        // Cannot be reset after it has been set at least once.
        // This is required to prevent unintended and repeated
        // reimporting of metadata from file tags.
        return false;
    }
    if (getSourceSynchronizedAt() == sourceSynchronizedAt) {
        return false; // unchanged
    }
    if (getSourceSynchronizedAt().isValid() &&
            getSourceSynchronizedAt() > sourceSynchronizedAt) {
        kLogger.warning()
                << "Backdating source synchronization time from"
                << getSourceSynchronizedAt()
                << "to"
                << sourceSynchronizedAt;
    }
    setSourceSynchronizedAt(sourceSynchronizedAt);
    m_headerParsed = sourceSynchronizedAt.isValid();
    return true;
}

TrackRecord::SourceSyncStatus TrackRecord::checkSourceSyncStatus(
        const FileInfo& fileInfo) const {
    // This method cannot be used to update m_headerParsed after modifying
    // m_sourceSynchronizedAt during a short moment of inconsistency.
    // Otherwise the debug assertion triggers!
    DEBUG_ASSERT(m_headerParsed ||
            !getSourceSynchronizedAt().isValid());
    // Legacy fallback: The property sourceSynchronizedAt has been added later.
    // Files that have been added before that time and that have never been
    // re-imported will only have that legacy flag set while sourceSynchronizedAt
    // is still invalid.
    if (!m_headerParsed) {
        // Enforce initial import of metadata if it hasn't succeeded
        // at least once yet.
        return SourceSyncStatus::Void;
    }
    if (!getSourceSynchronizedAt().isValid()) {
        // Existing tracks that have been imported before database version
        // 37 don't have a synchronization time stamp.
        return SourceSyncStatus::Unknown;
    }
    if (!fileInfo.exists()) {
        kLogger.warning()
                << "Failed to obtain synchronization time stamp for not existing file"
                << mixxx::FileInfo(fileInfo);
        return SourceSyncStatus::Undefined;
    }
    const QDateTime fileSourceSynchronizedAt =
            MetadataSource::getFileSynchronizedAt(fileInfo.toQFile());
    if (!fileSourceSynchronizedAt.isValid()) {
        kLogger.warning()
                << "Failed to obtain synchronization time stamp for file"
                << mixxx::FileInfo(fileInfo)
                << ": Is this file missing or inaccessible?";
        return SourceSyncStatus::Undefined;
    }
    if (getSourceSynchronizedAt() < fileSourceSynchronizedAt) {
        return SourceSyncStatus::Outdated;
    }
    if (getSourceSynchronizedAt() > fileSourceSynchronizedAt) {
        // The internal metadata has either been updated and not re-exported (yet)
        // or the file has been replaced with an older version. In both cases the
        // file metadata should not be re-imported implicitly and is considered
        // as synchronized.
        kLogger.debug()
                << "Internal source synchronization time stamp"
                << getSourceSynchronizedAt()
                << "is ahead of"
                << fileSourceSynchronizedAt
                << "for file"
                << mixxx::FileInfo(fileInfo);
    }
    return SourceSyncStatus::Synchronized;
}

bool TrackRecord::replaceMetadataFromSource(
        TrackMetadata&& importedMetadata,
        const QDateTime& sourceSynchronizedAt) {
    VERIFY_OR_DEBUG_ASSERT(sourceSynchronizedAt.isValid()) {
        return false;
    }
    DEBUG_ASSERT(sourceSynchronizedAt.timeSpec() == Qt::UTC);
    if (m_streamInfoFromSource) {
        // Preserve precise stream info if available, i.e. discard the
        // audio properties that are also stored as track metadata.
        importedMetadata.updateStreamInfoFromSource(*m_streamInfoFromSource);
    }
    bool modified = false;
    if (getMetadata() != importedMetadata) {
        setMetadata(std::move(importedMetadata));
        modified = true;
    }
    if (updateSourceSynchronizedAt(sourceSynchronizedAt)) {
        modified = true;
    }
    return modified;
}

bool TrackRecord::mergeExtraMetadataFromSource(
        const TrackMetadata& importedMetadata) {
    bool modified = false;
    TrackInfo* pMergedTrackInfo = m_metadata.ptrTrackInfo();
    const TrackInfo& importedTrackInfo = importedMetadata.getTrackInfo();
    if (pMergedTrackInfo->getTrackTotal() == kTrackTotalPlaceholder) {
        pMergedTrackInfo->setTrackTotal(importedTrackInfo.getTrackTotal());
        // Also set the track number if it is still empty due
        // to insufficient parsing capabilities of Mixxx in
        // previous versions.
        if (pMergedTrackInfo->getTrackNumber().isEmpty() &&
                !importedTrackInfo.getTrackNumber().isEmpty()) {
            pMergedTrackInfo->setTrackNumber(importedTrackInfo.getTrackNumber());
            modified = true;
        }
    }
#if defined(__EXTRA_METADATA__)
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrConductor(),
            importedTrackInfo.getConductor());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrDiscNumber(),
            importedTrackInfo.getDiscNumber());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrDiscTotal(),
            importedTrackInfo.getDiscTotal());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrEncoder(),
            importedTrackInfo.getEncoder());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrEncoderSettings(),
            importedTrackInfo.getEncoderSettings());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrISRC(),
            importedTrackInfo.getISRC());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrLanguage(),
            importedTrackInfo.getLanguage());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrLyricist(),
            importedTrackInfo.getLyricist());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrMood(),
            importedTrackInfo.getMood());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrMovement(),
            importedTrackInfo.getMovement());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrMusicBrainzArtistId(),
            importedTrackInfo.getMusicBrainzArtistId());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrMusicBrainzRecordingId(),
            importedTrackInfo.getMusicBrainzRecordingId());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrMusicBrainzReleaseId(),
            importedTrackInfo.getMusicBrainzReleaseId());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrMusicBrainzWorkId(),
            importedTrackInfo.getMusicBrainzWorkId());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrRemixer(),
            importedTrackInfo.getRemixer());
    modified |= copyIfNotEmpty(
            pMergedTrackInfo->ptrSeratoTags(),
            importedTrackInfo.getSeratoTags());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrSubtitle(),
            importedTrackInfo.getSubtitle());
    modified |= copyIfNotNull(
            pMergedTrackInfo->ptrWork(),
            importedTrackInfo.getWork());
    AlbumInfo* pMergedAlbumInfo = refMetadata().ptrAlbumInfo();
    const AlbumInfo& importedAlbumInfo = importedMetadata.getAlbumInfo();
    modified |= mergeReplayGainMetadataProperty(
            pMergedAlbumInfo->ptrReplayGain(),
            importedAlbumInfo.getReplayGain());
    modified |= copyIfNotNull(
            pMergedAlbumInfo->ptrCopyright(),
            importedAlbumInfo.getCopyright());
    modified |= copyIfNotNull(
            pMergedAlbumInfo->ptrLicense(),
            importedAlbumInfo.getLicense());
    modified |= copyIfNotNull(
            pMergedAlbumInfo->ptrMusicBrainzArtistId(),
            importedAlbumInfo.getMusicBrainzArtistId());
    modified |= copyIfNotNull(
            pMergedAlbumInfo->ptrMusicBrainzReleaseGroupId(),
            importedAlbumInfo.getMusicBrainzReleaseGroupId());
    modified |= copyIfNotNull(
            pMergedAlbumInfo->ptrMusicBrainzReleaseId(),
            importedAlbumInfo.getMusicBrainzReleaseId());
    modified |= copyIfNotNull(
            pMergedAlbumInfo->ptrRecordLabel(),
            importedAlbumInfo.getRecordLabel());
#endif // __EXTRA_METADATA__
    return modified;
}

bool TrackRecord::updateStreamInfoFromSource(
        mixxx::audio::StreamInfo streamInfoFromSource) {
    // Complete missing properties from metadata. Some properties
    // are mandatory while others like the bitrate might not be
    // reported by all decoders.
    VERIFY_OR_DEBUG_ASSERT(streamInfoFromSource.getSignalInfo().getChannelCount().isValid()) {
        streamInfoFromSource.refSignalInfo().setChannelCount(
                getMetadata().getStreamInfo().getSignalInfo().getChannelCount());
    }
    VERIFY_OR_DEBUG_ASSERT(streamInfoFromSource.getSignalInfo().getSampleRate().isValid()) {
        streamInfoFromSource.refSignalInfo().setSampleRate(
                getMetadata().getStreamInfo().getSignalInfo().getSampleRate());
    }
    VERIFY_OR_DEBUG_ASSERT(streamInfoFromSource.getDuration() > Duration::empty()) {
        streamInfoFromSource.setDuration(
                getMetadata().getStreamInfo().getDuration());
    }
    if (!streamInfoFromSource.getBitrate().isValid()) {
        // The bitrate might not be reported by the SoundSource
        streamInfoFromSource.setBitrate(
                getMetadata().getStreamInfo().getBitrate());
    }
    // Stream properties are not expected to vary during a session
    VERIFY_OR_DEBUG_ASSERT(!m_streamInfoFromSource ||
            *m_streamInfoFromSource == streamInfoFromSource) {
        kLogger.warning()
                << "Varying stream properties:"
                << *m_streamInfoFromSource
                << "->"
                << streamInfoFromSource;
    }
    m_streamInfoFromSource = streamInfoFromSource;
    // Stream info from source is always propagated to metadata and
    // unconditionally overwrites any properties that have once been
    // parsed from file tags! This is required to store the most
    // accurate information about the audio stream in the database.
    const bool metadataUpdated = refMetadata().updateStreamInfoFromSource(streamInfoFromSource);
    DEBUG_ASSERT(getMetadata().getStreamInfo() == streamInfoFromSource);
    return metadataUpdated;
}

bool operator==(const TrackRecord& lhs, const TrackRecord& rhs) {
    return lhs.getMetadata() == rhs.getMetadata() &&
            lhs.getExternalSource() == rhs.getExternalSource() &&
            lhs.getCoverInfo() == rhs.getCoverInfo() &&
            lhs.getId() == rhs.getId() &&
            lhs.getSourceSynchronizedAt() == rhs.getSourceSynchronizedAt() &&
            lhs.getDateAdded() == rhs.getDateAdded() &&
            lhs.getFileType() == rhs.getFileType() &&
            lhs.getUrl() == rhs.getUrl() &&
            lhs.getPlayCounter() == rhs.getPlayCounter() &&
            lhs.getColor() == rhs.getColor() &&
            lhs.getMainCuePosition() == rhs.getMainCuePosition() &&
            lhs.getBpmLocked() == rhs.getBpmLocked() &&
            lhs.getKeys() == rhs.getKeys() &&
            lhs.getRating() == rhs.getRating() &&
            lhs.m_headerParsed == rhs.m_headerParsed;
}

} // namespace mixxx
