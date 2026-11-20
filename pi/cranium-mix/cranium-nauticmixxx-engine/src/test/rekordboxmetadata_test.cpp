#include <gtest/gtest.h>
#include <QDir>
#include <QTemporaryDir>

#include "library/rekordbox/rekordboxdatabase.h"
#include "library/rekordbox/rekordboxdevice.h"
#include "library/rekordbox/rekordboxmetadata.h"
#include "track/track.h"

namespace {
using namespace mixxx::rekordbox;
class RekordboxMetadataAdapterTest : public testing::Test {
  protected:
    QTemporaryDir root;
    TrackPointer track = Track::newTemporary(root.filePath("song.flac"));
    QJsonObject source(QJsonObject values) {
        DatabaseTrack row{42, "/song.flac", "/ANLZ0000.DAT", values};
        DeviceSnapshot device;
        device.root = root.path();
        device.fingerprint = QByteArray(32, 'a');
        return makeTrackSource(row, device);
    }
};
TEST_F(RekordboxMetadataAdapterTest, AppliesExportAndRetainsRawMetadata) {
    const auto origin = source({{"title", "Rekordbox title"}, {"key", "8A"},
            {"bpm", 128.43}, {"rating", 4}, {"composer", "Composer"},
            {"sample_rate", 48000}, {"mix_name", "Extended"}});
    ASSERT_TRUE(applyTrackMetadata(track, origin));
    EXPECT_EQ(track->getTitle(), "Rekordbox title");
    EXPECT_EQ(track->getComposer(), "Composer");
    EXPECT_EQ(track->getKey(), mixxx::track::io::key::A_MINOR);
    EXPECT_EQ(track->getKeys().getGlobalKeyText(), "8A");
    EXPECT_EQ(track->getRating(), 4);
    EXPECT_EQ(track->getExternalSource(), origin);
    EXPECT_TRUE(track->isReadOnlySource());
    // The PDB stream estimate must not masquerade as decoded audio properties.
    EXPECT_NE(track->getSampleRate(), mixxx::audio::SampleRate(48000));
}
TEST_F(RekordboxMetadataAdapterTest, InvalidKeyAndMissingFieldsPreserveNativeValues) {
    track->setTitle("Local title");
    track->setKey(mixxx::track::io::key::D_MAJOR, mixxx::track::io::key::USER);
    track->setRating(3);
    const auto origin = source({{"key", "unknown"}, {"rating", 255}, {"bpm", -2}});
    ASSERT_TRUE(applyTrackMetadata(track, origin));
    EXPECT_EQ(track->getTitle(), "Local title");
    EXPECT_EQ(track->getKey(), mixxx::track::io::key::D_MAJOR);
    EXPECT_EQ(track->getRating(), 3);
    EXPECT_EQ(track->getExternalSource().value("metadata").toObject().value("key"), "unknown");
}
TEST_F(RekordboxMetadataAdapterTest, RepeatedLoadPreservesLocalEditsUntilExportChanges) {
    auto origin = source({{"title", "Exported title"}});
    ASSERT_TRUE(applyTrackMetadata(track, origin));
    track->setTitle("Local edit");
    EXPECT_FALSE(applyTrackMetadata(track, origin));
    EXPECT_EQ(track->getTitle(), "Local edit");
    origin.insert("db_fingerprint", "different export");
    EXPECT_TRUE(applyTrackMetadata(track, origin));
    EXPECT_EQ(track->getTitle(), "Exported title");
}
TEST_F(RekordboxMetadataAdapterTest, RejectsDescriptorForDifferentOrEscapingPath) {
    auto origin = source({{"title", "Wrong"}});
    origin.insert("relative_path", "/different.flac");
    EXPECT_FALSE(applyTrackMetadata(track, origin));
    origin.insert("relative_path", "../song.flac");
    EXPECT_FALSE(applyTrackMetadata(track, origin));
    EXPECT_TRUE(track->getExternalSource().isEmpty());
}
} // namespace
