#include <gtest/gtest.h>

#include <atomic>
#include <memory>
#include <thread>
#include <type_traits>

#include "library/rekordbox/rekordboxruntimecatalog.h"

namespace {

using namespace mixxx::rekordbox;

RuntimeTrack makeTrack(quint32 id) {
    RuntimeTrack track;
    track.rekordboxId = id;
    track.title = QStringLiteral("Track %1").arg(id);
    track.artist = QStringLiteral("Artist %1").arg(id);
    track.audioRelativePath = QStringLiteral("/music/track%1.mp3").arg(id);
    track.anlzRelativePath = QStringLiteral("/PIONEER/USBANLZ/P016/0000%1/ANLZ0000.DAT").arg(id);
    track.bpm = 120.0 + id;
    track.durationSeconds = 300;
    track.rating = 4;
    track.colorId = 2;
    track.analysisState = RuntimeAnalysisState::Imported;
    track.rawMetadata = QJsonObject{{"title", track.title}};
    return track;
}

TEST(RekordboxRuntimeCatalogTest, EmptyCatalogIsValidAndLookupsFail) {
    RuntimeCatalog catalog;
    EXPECT_TRUE(catalog.valid());
    EXPECT_TRUE(catalog.tracks().isEmpty());
    EXPECT_TRUE(catalog.playlists().isEmpty());
    EXPECT_EQ(catalog.findTrack(1).has_value(), false);
    EXPECT_EQ(catalog.findPlaylist(1).has_value(), false);
    EXPECT_EQ(catalog.findTrackByAudioPath(QStringLiteral("/x.mp3")).has_value(), false);
}

TEST(RekordboxRuntimeCatalogTest, StoresAndLooksUpTracks) {
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(makeTrack(1)));
    ASSERT_TRUE(catalog.insertTrack(makeTrack(2)));
    ASSERT_EQ(catalog.tracks().size(), 2);

    const auto track = catalog.findTrack(2);
    ASSERT_TRUE(track.has_value());
    EXPECT_EQ(track->rekordboxId, 2u);
    EXPECT_EQ(track->title, QStringLiteral("Track 2"));
    ASSERT_TRUE(track->bpm);
    EXPECT_DOUBLE_EQ(*track->bpm, 122.0);
    EXPECT_EQ(track->analysisState, RuntimeAnalysisState::Imported);

    EXPECT_EQ(catalog.findTrack(3).has_value(), false);
}

TEST(RekordboxRuntimeCatalogTest, RejectsInvalidAndDuplicateTrackIds) {
    RuntimeCatalog catalog;
    RuntimeTrack missingId = makeTrack(7);
    missingId.rekordboxId = 0;
    EXPECT_FALSE(catalog.insertTrack(missingId));

    ASSERT_TRUE(catalog.insertTrack(makeTrack(7)));
    EXPECT_FALSE(catalog.insertTrack(makeTrack(7)));
    EXPECT_EQ(catalog.tracks().size(), 1);
    ASSERT_FALSE(catalog.diagnostics().isEmpty());
    EXPECT_TRUE(catalog.diagnostics().last().contains(
            QStringLiteral("duplicate rekordbox track id 7")));
}

TEST(RekordboxRuntimeCatalogTest, TracksByAudioPath) {
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(makeTrack(9)));
    const auto track = catalog.findTrackByAudioPath(
            QStringLiteral("/music/track9.mp3"));
    ASSERT_TRUE(track.has_value());
    EXPECT_EQ(track->rekordboxId, 9u);
    EXPECT_EQ(catalog.findTrackByAudioPath(QStringLiteral("/missing.mp3")).has_value(), false);
    // Empty paths never match.
    EXPECT_EQ(catalog.findTrackByAudioPath(QString()).has_value(), false);
}

TEST(RekordboxRuntimeCatalogTest, PlaylistsStoreOrderAndRelations) {
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(makeTrack(1)));
    ASSERT_TRUE(catalog.insertTrack(makeTrack(2)));
    RuntimePlaylistNode folder;
    folder.rekordboxId = 10;
    folder.name = QStringLiteral("Folder");
    folder.isFolder = true;
    folder.sortOrder = 1;

    RuntimePlaylistNode playlist;
    playlist.rekordboxId = 11;
    playlist.name = QStringLiteral("Weekend");
    playlist.sortOrder = 2;
    playlist.trackIds = {1u, 2u};
    folder.children.append(playlist);

    ASSERT_TRUE(catalog.insertPlaylist(folder));
    const auto found = catalog.findPlaylist(11);
    ASSERT_TRUE(found.has_value());
    EXPECT_EQ(found->name, QStringLiteral("Weekend"));
    ASSERT_EQ(found->trackIds.size(), 2);
    EXPECT_EQ(found->trackIds.first(), 1u);

    EXPECT_FALSE(catalog.insertPlaylist(folder));
    ASSERT_FALSE(catalog.diagnostics().isEmpty());
}

TEST(RekordboxRuntimeCatalogTest, CuesAndWaveformRepresentData) {
    RuntimeCue hotCue;
    hotCue.kind = RuntimeCue::Kind::HotCue;
    hotCue.hotcueIndex = 1;
    hotCue.label = QStringLiteral("Drop");
    hotCue.color = mixxx::RgbColor::optional(0xF87090);
    hotCue.startMs = 1250.0;

    RuntimeCue loop;
    loop.kind = RuntimeCue::Kind::MemoryLoop;
    loop.startMs = 2000.0;
    loop.endMs = 8000.0;

    RuntimeWaveform waveform;
    waveform.quality = RuntimeWaveformQuality::Preview;
    waveform.bytes = QByteArray(420, '\0');
    waveform.entryCount = 400;
    waveform.diagnostics.append(QStringLiteral("pwav"));

    EXPECT_EQ(hotCue.kind, RuntimeCue::Kind::HotCue);
    ASSERT_TRUE(hotCue.color.has_value());
    EXPECT_EQ(*hotCue.color, mixxx::RgbColor(0xF87090));
    ASSERT_TRUE(loop.endMs.has_value());
    EXPECT_DOUBLE_EQ(*loop.endMs - *loop.startMs, 6000.0);
    EXPECT_EQ(waveform.entryCount, 400);
    EXPECT_EQ(waveform.bytes.size(), 420);
}

TEST(RekordboxRuntimeCatalogTest, InvalidateClearsRowsAndLookups) {
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(makeTrack(1)));
    ASSERT_TRUE(catalog.insertPlaylist([] {
        RuntimePlaylistNode playlist;
        playlist.rekordboxId = 20;
        playlist.name = QStringLiteral("Root");
        return playlist;
    }()));

    catalog.invalidate();
    EXPECT_FALSE(catalog.valid());
    EXPECT_TRUE(catalog.tracks().isEmpty());
    EXPECT_TRUE(catalog.playlists().isEmpty());
    EXPECT_EQ(catalog.findTrack(1).has_value(), false);
    EXPECT_EQ(catalog.findPlaylist(20).has_value(), false);
    // Reinsertion is refused after invalidation so stale workers cannot
    // resurrect a disconnected volume.
    EXPECT_FALSE(catalog.insertTrack(makeTrack(1)));
}

TEST(RekordboxRuntimeCatalogTest, RuntimeTrackWithoutAnalysisIsExplicit) {
    RuntimeTrack track = makeTrack(30);
    track.analysisState = RuntimeAnalysisState::Unknown;
    track.anlzRelativePath.clear();
    track.resolvedAnlzPath.clear();

    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(track));
    const auto stored = catalog.findTrack(30);
    ASSERT_TRUE(stored.has_value());
    EXPECT_EQ(stored->analysisState, RuntimeAnalysisState::Unknown);
    EXPECT_TRUE(stored->anlzRelativePath.isEmpty());
    EXPECT_TRUE(stored->diagnostics.isEmpty());
}


TEST(RekordboxRuntimeCatalogTest, LookupSnapshotsSurviveInvalidationAndDestruction) {
    std::optional<RuntimeTrack> saved;
    std::optional<RuntimePlaylistNode> playlist;
    std::weak_ptr<RuntimeCatalog> weak;
    {
        auto catalog = std::make_shared<RuntimeCatalog>();
        weak = catalog;
        auto track = makeTrack(1);
        RuntimeWaveform preview;
        preview.bytes = QByteArray("original");
        track.waveforms.append(preview);
        RuntimeCue cue;
        cue.startMs = 0.0;
        track.cues.append(cue);
        ASSERT_TRUE(catalog->insertTrack(track));
        RuntimePlaylistNode node;
        node.rekordboxId = 1;
        node.trackIds = {1u};
        ASSERT_TRUE(catalog->insertPlaylist(node));
        saved = catalog->findTrack(1);
        playlist = catalog->findPlaylist(1);
        auto rows = catalog->tracks();
        rows[1].title = QStringLiteral("caller edit");
        track.waveforms[0].bytes[0] = 'X';
        EXPECT_EQ(catalog->findTrack(1)->title, QStringLiteral("Track 1"));
        catalog->invalidate();
        EXPECT_FALSE(catalog->findTrack(1));
        EXPECT_FALSE(catalog->findTrackByAudioPath(track.audioRelativePath));
        EXPECT_EQ(rows[1].waveforms.first().bytes, QByteArray("original"));
    }
    EXPECT_TRUE(weak.expired()); // Snapshots do not retain the catalog/session.
    ASSERT_TRUE(saved);
    ASSERT_TRUE(playlist);
    EXPECT_EQ(saved->waveforms.first().bytes, QByteArray("original"));
    EXPECT_EQ(saved->cues.first().startMs, std::make_optional(0.0));
    EXPECT_EQ(playlist->trackIds, QList<quint32>({1u}));
}

TEST(RekordboxRuntimeCatalogTest, SealingAndInvalidationAreTerminalForWriters) {
    static_assert(!std::is_copy_constructible_v<RuntimeCatalog>);
    RuntimeCatalog catalog;
    catalog.appendDiagnostic(QStringLiteral("retained"));
    ASSERT_TRUE(catalog.insertTrack(makeTrack(1)));
    EXPECT_TRUE(catalog.seal());
    EXPECT_TRUE(catalog.seal());
    EXPECT_TRUE(catalog.sealed());
    EXPECT_FALSE(catalog.insertTrack(makeTrack(2)));
    RuntimePlaylistNode node;
    node.rekordboxId = 1;
    EXPECT_FALSE(catalog.insertPlaylist(node));
    catalog.appendDiagnostic(QStringLiteral("ignored"));
    EXPECT_EQ(catalog.diagnostics().size(), 1);
    catalog.invalidate();
    catalog.invalidate();
    EXPECT_FALSE(catalog.valid());
    EXPECT_FALSE(catalog.seal());
    EXPECT_FALSE(catalog.insertPlaylist(node));
    EXPECT_EQ(catalog.diagnostics().first(), QStringLiteral("retained"));
}

TEST(RekordboxRuntimeCatalogTest, MissingDataAndZeroValuesAreDistinct) {
    RuntimeTrack track;
    track.rekordboxId = 0xffffffffu;
    EXPECT_FALSE(track.bpm);
    EXPECT_FALSE(track.durationSeconds);
    EXPECT_FALSE(track.rating);
    EXPECT_EQ(track.analysisState, RuntimeAnalysisState::Unknown);
    track.rating = 0;
    RuntimeCatalog catalog;
    EXPECT_TRUE(catalog.insertTrack(track));
    EXPECT_EQ(catalog.findTrack(track.rekordboxId)->rating, std::make_optional(0u));
    track.rekordboxId = 2;
    EXPECT_TRUE(catalog.insertTrack(track)); // Missing paths are not duplicate keys.
    EXPECT_FALSE(catalog.findTrackByAudioPath(QString()));
    RuntimeCue cue;
    EXPECT_FALSE(cue.startMs);
    EXPECT_FALSE(cue.loopLengthMs());
    cue.kind = RuntimeCue::Kind::HotLoop;
    cue.startMs = 0.0;
    cue.endMs = 4000.0;
    EXPECT_EQ(cue.loopLengthMs(), std::make_optional(4000.0));
    cue.endMs = 0.0;
    EXPECT_FALSE(cue.loopLengthMs());
}

TEST(RekordboxRuntimeCatalogTest, DuplicatePathsAreRejectedWithoutOverwriting) {
    RuntimeCatalog catalog;
    auto track = makeTrack(1);
    ASSERT_TRUE(catalog.insertTrack(track));
    track.rekordboxId = 2;
    EXPECT_FALSE(catalog.insertTrack(track));
    EXPECT_FALSE(catalog.findTrack(2));
    EXPECT_EQ(catalog.findTrackByAudioPath(track.audioRelativePath)->rekordboxId, 1u);
}

TEST(RekordboxRuntimeCatalogTest, InvalidPlaylistReferencesAreAtomic) {
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(makeTrack(1)));
    RuntimePlaylistNode child;
    child.rekordboxId = 11;
    child.trackIds = {1u, 99u};
    RuntimePlaylistNode folder;
    folder.rekordboxId = 10;
    folder.isFolder = true;
    folder.children = {child};
    EXPECT_FALSE(catalog.insertPlaylist(folder));
    EXPECT_TRUE(catalog.playlists().isEmpty());
    EXPECT_FALSE(catalog.findPlaylist(10));
    EXPECT_FALSE(catalog.findPlaylist(11));
    folder.children[0].trackIds = {1u, 1u};
    EXPECT_TRUE(catalog.insertPlaylist(folder));
    EXPECT_EQ(catalog.findPlaylist(11)->trackIds, QList<quint32>({1u, 1u}));
}

TEST(RekordboxRuntimeCatalogTest, NestedDuplicateIdsAndMalformedNodeTypesAreRejected) {
    RuntimeCatalog catalog;
    RuntimePlaylistNode child;
    child.rekordboxId = 2;
    RuntimePlaylistNode folder;
    folder.rekordboxId = 1;
    folder.isFolder = true;
    folder.children = {child, child};
    EXPECT_FALSE(catalog.insertPlaylist(folder));
    folder.children = {child};
    ASSERT_TRUE(catalog.insertPlaylist(folder));
    EXPECT_FALSE(catalog.insertPlaylist(child)); // Existing nested ID.
    folder.rekordboxId = 3;
    EXPECT_FALSE(catalog.insertPlaylist(folder)); // Nested collision across roots.
    folder.children.clear();
    folder.trackIds = {1u};
    EXPECT_FALSE(catalog.insertPlaylist(folder)); // Folder cannot contain tracks.
    folder.trackIds.clear();
    folder.children = {child};
    folder.isFolder = false;
    EXPECT_FALSE(catalog.insertPlaylist(folder)); // Playlist cannot have children.
    child.rekordboxId = 0;
    EXPECT_FALSE(catalog.insertPlaylist(child));
}

TEST(RekordboxRuntimeCatalogTest, DeepTreesAreRejectedWithoutPartialInsertion) {
    RuntimePlaylistNode node;
    node.rekordboxId = 1;
    for (quint32 id = 2; id <= 67; ++id) {
        RuntimePlaylistNode parent;
        parent.rekordboxId = id;
        parent.isFolder = true;
        parent.children.append(node);
        node = std::move(parent);
    }
    RuntimeCatalog catalog;
    EXPECT_FALSE(catalog.insertPlaylist(node));
    EXPECT_TRUE(catalog.playlists().isEmpty());
    EXPECT_FALSE(catalog.findPlaylist(1));
}

TEST(RekordboxRuntimeCatalogTest, RetainsWaveformFormatsAndVariableBeatPositions) {
    auto track = makeTrack(1);
    RuntimeWaveform preview;
    preview.quality = RuntimeWaveformQuality::Preview;
    preview.sectionTag = QByteArray("PWV6");
    preview.sampleFormat = RuntimeWaveform::SampleFormat::ThreeBand;
    preview.byteOrder = RuntimeWaveform::ByteOrder::BigEndian;
    preview.bytesPerEntry = 3;
    preview.entryCount = 2;
    preview.entriesPerSecond = 1.0;
    preview.durationMs = 2000.0;
    preview.bytes = QByteArray::fromHex("010203040506");
    auto detail = preview;
    detail.quality = RuntimeWaveformQuality::Detailed;
    detail.sectionTag = QByteArray("PWV7");
    track.waveforms = {preview, detail};
    track.beats = {{0, 1, 12000}, {500, 2, 12000}, {1100, 3, 10000}};
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(track));
    const auto result = catalog.findTrack(1);
    ASSERT_TRUE(result);
    ASSERT_EQ(result->waveforms.size(), 2);
    EXPECT_EQ(result->waveforms[1].sectionTag, QByteArray("PWV7"));
    EXPECT_EQ(result->waveforms[0].bytesPerEntry, std::make_optional(3u));
    EXPECT_EQ(result->waveforms[0].durationMs, std::make_optional(2000.0));
    EXPECT_EQ(result->waveforms[0].bytes, preview.bytes);
    EXPECT_EQ(result->beats[2].timeMs, 1100u);
}

TEST(RekordboxRuntimeCatalogTest, ConcurrentLookupsAndInvalidationUseOwningSnapshots) {
    RuntimeCatalog catalog;
    ASSERT_TRUE(catalog.insertTrack(makeTrack(1)));
    ASSERT_TRUE(catalog.seal());
    std::atomic<bool> start{false};
    std::thread reader([&] {
        while (!start.load()) {
            std::this_thread::yield();
        }
        for (int i = 0; i < 1000; ++i) {
            const auto track = catalog.findTrack(1);
            if (track) {
                EXPECT_EQ(track->title, QStringLiteral("Track 1"));
            }
        }
    });
    start.store(true);
    catalog.invalidate();
    reader.join();
    EXPECT_FALSE(catalog.findTrack(1));
}

} // namespace
