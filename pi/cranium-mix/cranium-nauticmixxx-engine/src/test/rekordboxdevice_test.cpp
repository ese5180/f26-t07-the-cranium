#include "library/rekordbox/rekordboxdevice.h"

#include <gtest/gtest.h>

#include <QDir>
#include <QFile>
#include <QSqlError>
#include <QSqlQuery>
#include <QTemporaryDir>

#include "library/library_prefs.h"
#include "library/rekordbox/rekordboxsessionstate.h"
#include "library/trackcollection.h"
#include "sources/soundsourceproxy.h"
#include "test/librarytest.h"
#include "track/sourcebinding.h"
#include "track/track.h"

namespace {
using namespace mixxx::rekordbox;

void writeFile(const QString& path, const QByteArray& bytes = QByteArray("fixture")) {
    ASSERT_TRUE(QDir().mkpath(QFileInfo(path).absolutePath()));
    QFile file(path);
    ASSERT_TRUE(file.open(QIODevice::WriteOnly));
    ASSERT_EQ(file.write(bytes), bytes.size());
}

QJsonObject provenanceFor(const QTemporaryDir& directory) {
    return {{"version", 1},
            {"provider", "rekordbox_usb"},
            {"root", directory.path()},
            {"db_fingerprint", QStringLiteral("0123456789abcdef")},
            {"relative_path", "track.mp3"},
            {"analysis_relative_path", "/PIONEER/USBANLZ/fixture.DAT"},
            {"rekordbox_id", 42},
            {"metadata",
                    QJsonObject{{"artist", QStringLiteral("Fixture Artist")},
                            {"title", QStringLiteral("Fixture Title")},
                            {"bpm", 128.0}}}};
}

int externalSourceRows(const QSqlDatabase& database, TrackId id) {
    QSqlQuery query(database);
    query.prepare(QStringLiteral(
            "SELECT COUNT(*) FROM external_track_sources WHERE track_id=:id"));
    query.bindValue(QStringLiteral(":id"), id.toVariant());
    EXPECT_TRUE(query.exec()) << query.lastError().text().toStdString();
    EXPECT_TRUE(query.next());
    return query.value(0).toInt();
}

class RekordboxDeviceTest : public testing::Test {
  protected:
    QTemporaryDir temporary;
    QString root() const { return temporary.path(); }
    QString path(const QString& relative) const { return temporary.filePath(relative); }
    void exportMarker() { writeFile(path("PIONEER/rekordbox/export.pdb")); }
};

TEST_F(RekordboxDeviceTest, DetectsVisibleAndHiddenExportDirectories) {
    ASSERT_TRUE(temporary.isValid());
    EXPECT_EQ(inspectDevice(root()).state, DeviceState::Missing);
    writeFile(path(".PIONEER/rekordbox/export.pdb"));
    EXPECT_EQ(inspectDevice(root()).state, DeviceState::Readable);
    EXPECT_TRUE(databasePath(root()).contains(".PIONEER/"));
    exportMarker();
    EXPECT_TRUE(databasePath(root()).endsWith("/PIONEER/rekordbox/export.pdb"));
}

TEST_F(RekordboxDeviceTest, ResolvesVolumeRelativeUnicodePaths) {
    writeFile(path(QString::fromUtf8("Contents/Música/niño.mp3")));
    const auto resolved = resolvePath(root(), QString::fromUtf8("/Contents/Música/niño.mp3"));
    EXPECT_EQ(resolved, QFileInfo(path(QString::fromUtf8("Contents/Música/niño.mp3"))).canonicalFilePath());
    EXPECT_EQ(resolvePath(root(), "\\Contents\\missing.mp3", false),
            QDir(QFileInfo(root()).canonicalFilePath()).filePath("Contents/missing.mp3"));
    EXPECT_TRUE(resolvePath(root(), "/Contents/missing.mp3").isEmpty());
}

TEST_F(RekordboxDeviceTest, RejectsEscapingAndInvalidPaths) {
    for (const auto& input : {"../outside.mp3", "/Contents/../../outside.mp3",
                 "C:\\outside.mp3", "//server/share.mp3", "/", ""}) {
        EXPECT_TRUE(resolvePath(root(), input, false).isEmpty()) << input;
    }
    EXPECT_TRUE(resolvePath(root(), QString("bad") + QChar::Null + "path", false).isEmpty());
    QTemporaryDir outside;
    writeFile(outside.filePath("track.mp3"));
    ASSERT_TRUE(QFile::link(outside.path(), path("escape")));
    EXPECT_TRUE(resolvePath(root(), "escape/track.mp3").isEmpty());
    EXPECT_TRUE(resolvePath(root(), "escape/new.mp3", false).isEmpty());
}

TEST_F(RekordboxDeviceTest, SnapshotChangesWhenExportOrMountChanges) {
    exportMarker();
    const auto original = inspectDevice(root());
    EXPECT_TRUE(original.matches(inspectDevice(root())));
    writeFile(databasePath(root()), "updated");
    EXPECT_FALSE(original.matches(inspectDevice(root())));
    QTemporaryDir copy;
    writeFile(copy.filePath("PIONEER/rekordbox/export.pdb"), "fixture");
    const auto other = inspectDevice(copy.path());
    EXPECT_EQ(original.fingerprint, other.fingerprint);
    EXPECT_FALSE(original.matches(other));
    ASSERT_TRUE(QFile::remove(databasePath(root())));
    EXPECT_EQ(inspectDevice(root()).state, DeviceState::Missing);
}

TEST_F(RekordboxDeviceTest, ProtectsBeforeDiscoveryAndAfterUnplug) {
    exportMarker();
    const auto track = path("Contents/Artist/Album/track.mp3");
    EXPECT_TRUE(isReadOnlyPath(track));
    ASSERT_TRUE(QFile::remove(databasePath(root())));
    EXPECT_TRUE(isReadOnlyPath(track));
    EXPECT_FALSE(isReadOnlyPath(root() + "-other/track.mp3"));
}

TEST_F(RekordboxDeviceTest, ProtectsSymlinkedNewDestinations) {
    exportMarker();
    QTemporaryDir links;
    ASSERT_TRUE(QFile::link(root(), links.filePath("usb")));
    EXPECT_TRUE(isReadOnlyPath(links.filePath("usb/Contents/new.mp3")));
}

TEST_F(RekordboxDeviceTest, LocalFoldersRemainWritable) {
    writeFile(path("Contents/local.mp3"));
    EXPECT_FALSE(isReadOnlyPath(path("Contents/local.mp3")));
    EXPECT_FALSE(isReadOnlyPath(path("new.mp3")));
}

TEST_F(RekordboxDeviceTest, RefusesOversizedDiscoveryReads) {
    exportMarker();
    QFile database(databasePath(root()));
    ASSERT_TRUE(database.open(QIODevice::WriteOnly));
    ASSERT_TRUE(database.resize(512LL * 1024 * 1024 + 1));
    database.close();
    EXPECT_EQ(inspectDevice(root()).state, DeviceState::TooLarge);
    EXPECT_TRUE(isReadOnlyPath(path("Contents/new.mp3")));
}
} // namespace

class RekordboxReadOnlyLibraryTest : public LibraryTest {};

TEST_F(RekordboxReadOnlyLibraryTest,
        RestrictedRuntimeTrackCannotImportPersistOrRefreshTags) {
    QTemporaryDir directory;
    ASSERT_TRUE(directory.isValid());
    const auto location = directory.filePath(QStringLiteral("track.mp3"));
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath(QStringLiteral("id3-test-data/artist.mp3")),
            location));

    auto session = std::make_shared<mixxx::rekordbox::SessionState>();
    const auto track = Track::newTemporary(
            mixxx::FileAccess(mixxx::FileInfo(location)),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),
            mixxx::SourceBinding::rekordboxUsb(42, session));
    ASSERT_TRUE(track);
    track->setTitle(QStringLiteral("Runtime title"));

    track->markForMetadataExport();
    EXPECT_FALSE(track->isMarkedForMetadataExport());
    EXPECT_EQ(SoundSourceProxy(track).updateTrackFromSource(
                      SoundSourceProxy::UpdateTrackFromSourceMode::Always,
                      SyncTrackMetadataParams{}),
            SoundSourceProxy::UpdateTrackFromSourceResult::NotUpdated);
    EXPECT_EQ(track->getTitle(), QStringLiteral("Runtime title"));

    EXPECT_FALSE(internalCollection()->addTrack(track, true).isValid());
    EXPECT_FALSE(internalCollection()->getTrackDAO().saveTrack(track.get()));
    EXPECT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Skipped);
    EXPECT_FALSE(track->getId().isValid());

    QSqlQuery query(internalCollection()->database());
    query.prepare(QStringLiteral(
            "SELECT COUNT(*) FROM track_locations WHERE location=:location"));
    query.bindValue(QStringLiteral(":location"), location);
    ASSERT_TRUE(query.exec()) << query.lastError().text().toStdString();
    ASSERT_TRUE(query.next());
    EXPECT_EQ(query.value(0).toInt(), 0);
    EXPECT_TRUE(track->getSourceBinding().isSessionLive());
}

TEST(RekordboxExternalSourceTest, RejectsMalformedAndUnboundedProvenance) {
    QTemporaryDir directory;
    auto track = Track::newTemporary(directory.filePath("track.mp3"));
    ASSERT_TRUE(track);
    const auto valid = provenanceFor(directory);
    EXPECT_TRUE(track->setExternalSource(valid));
    EXPECT_EQ(track->getExternalSource(), valid);

    auto invalidPath = valid;
    invalidPath.insert(QStringLiteral("relative_path"), QStringLiteral("../track.mp3"));
    EXPECT_FALSE(track->setExternalSource(invalidPath));
    EXPECT_EQ(track->getExternalSource(), valid);

    auto oversized = valid;
    oversized.insert(QStringLiteral("diagnostic"),
            QString(mixxx::TrackRecord::kMaxExternalSourcePayloadBytes, QChar('x')));
    EXPECT_FALSE(track->setExternalSource(oversized));
    EXPECT_EQ(track->getExternalSource(), valid);
}

TEST_F(RekordboxReadOnlyLibraryTest, AutoSyncSavesLocallyWithoutWritingUsbTags) {
    QTemporaryDir usb;
    ASSERT_TRUE(usb.isValid());
    writeFile(usb.filePath("PIONEER/rekordbox/export.pdb"));
    const QString location = usb.filePath("track.mp3");
    ASSERT_TRUE(QFile::copy(getTestDir().filePath("id3-test-data/cover-test-jpg.mp3"), location));
    QFile file(location);
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    const auto original = file.readAll();
    file.close();
    config()->setValue(mixxx::library::prefs::kSyncTrackMetadataConfigKey, true);
    auto track = getOrAddTrackByLocation(location);
    ASSERT_TRUE(track);
    const auto id = track->getId();
    ASSERT_TRUE(id.isValid());
    track->setTitle("Local edit on a read-only source");
    EXPECT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Saved);
    EXPECT_FALSE(track->isMarkedForMetadataExport());
    track.reset();
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    EXPECT_EQ(file.readAll(), original);
    file.close();
    track = trackCollectionManager()->getTrackById(id);
    ASSERT_TRUE(track);
    EXPECT_EQ(track->getTitle(), QString("Local edit on a read-only source"));
    EXPECT_EQ(track->getLocation(), location);
}

TEST_F(RekordboxReadOnlyLibraryTest, ProvenanceSurvivesReloadWithoutExportDatabase) {
    QTemporaryDir directory;
    const auto location = directory.filePath("track.mp3");
    ASSERT_TRUE(QFile::copy(getTestDir().filePath("id3-test-data/cover-test-jpg.mp3"), location));
    auto track = getOrAddTrackByLocation(location);
    ASSERT_TRUE(track);
    const auto id = track->getId();
    const auto provenance = provenanceFor(directory);
    ASSERT_TRUE(track->setExternalSource(provenance));
    ASSERT_TRUE(track->isReadOnlySource());
    EXPECT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Saved);
    const auto database = trackCollectionManager()->internalCollection()->database();
    EXPECT_EQ(externalSourceRows(database, id), 1);
    TrackWeakPointer weakTrack(track);
    track.reset();
    EXPECT_TRUE(weakTrack.expired());
    track = trackCollectionManager()->getTrackById(id);
    ASSERT_TRUE(track);
    EXPECT_EQ(track->getExternalSource(), provenance);
    EXPECT_TRUE(track->isReadOnlySource());
    QFile file(location);
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    const auto original = file.readAll();
    file.close();
    config()->setValue(mixxx::library::prefs::kSyncTrackMetadataConfigKey, true);
    track->markForMetadataExport();
    EXPECT_FALSE(track->isMarkedForMetadataExport());
    track->setTitle("Local change after restart");
    EXPECT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Saved);
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    EXPECT_EQ(file.readAll(), original);
}

TEST_F(RekordboxReadOnlyLibraryTest, ExplicitMetadataExportIsBlockedByProvenance) {
    QTemporaryDir directory;
    const auto location = directory.filePath("track.mp3");
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath("id3-test-data/cover-test-jpg.mp3"), location));
    auto track = getOrAddTrackByLocation(location);
    ASSERT_TRUE(track);
    ASSERT_TRUE(track->setExternalSource(provenanceFor(directory)));
    ASSERT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Saved);
    track->markForMetadataExport();
    EXPECT_FALSE(track->isMarkedForMetadataExport());
    EXPECT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Skipped);
    EXPECT_FALSE(track->isMarkedForMetadataExport());
}

TEST_F(RekordboxReadOnlyLibraryTest, CompanionRowIsDeletedWithoutForeignKeys) {
    QTemporaryDir directory;
    const auto location = directory.filePath("track.mp3");
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath("id3-test-data/cover-test-jpg.mp3"), location));
    auto track = getOrAddTrackByLocation(location);
    ASSERT_TRUE(track);
    const auto id = track->getId();
    ASSERT_TRUE(track->setExternalSource(provenanceFor(directory)));
    ASSERT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Saved);
    track.reset();

    const auto database = trackCollectionManager()->internalCollection()->database();
    ASSERT_EQ(externalSourceRows(database, id), 1);
    QSqlQuery query(database);
    ASSERT_TRUE(query.exec(QStringLiteral("PRAGMA foreign_keys=OFF")));
    query.prepare(QStringLiteral("DELETE FROM library WHERE id=:id"));
    query.bindValue(QStringLiteral(":id"), id.toVariant());
    ASSERT_TRUE(query.exec()) << query.lastError().text().toStdString();
    EXPECT_EQ(externalSourceRows(database, id), 0);
    ASSERT_TRUE(query.exec(QStringLiteral("PRAGMA foreign_keys=ON")));
}

TEST_F(RekordboxReadOnlyLibraryTest, InvalidStoredProvenanceIsIgnoredOnReload) {
    QTemporaryDir directory;
    const auto location = directory.filePath("track.mp3");
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath("id3-test-data/cover-test-jpg.mp3"), location));
    auto track = getOrAddTrackByLocation(location);
    ASSERT_TRUE(track);
    const auto id = track->getId();
    ASSERT_TRUE(track->setExternalSource(provenanceFor(directory)));
    ASSERT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Saved);
    track.reset();

    const auto database = trackCollectionManager()->internalCollection()->database();
    QSqlQuery query(database);
    query.prepare(QStringLiteral(
            "UPDATE external_track_sources SET payload=:payload WHERE track_id=:id"));
    query.bindValue(QStringLiteral(":payload"), QStringLiteral("{not-json"));
    query.bindValue(QStringLiteral(":id"), id.toVariant());
    ASSERT_TRUE(query.exec()) << query.lastError().text().toStdString();

    track = trackCollectionManager()->getTrackById(id);
    ASSERT_TRUE(track);
    EXPECT_TRUE(track->getExternalSource().isEmpty());
    EXPECT_FALSE(track->isReadOnlySource());
}

TEST_F(RekordboxReadOnlyLibraryTest, ProvenanceFailureRollsBackLibraryUpdate) {
    QTemporaryDir directory;
    const auto location = directory.filePath("track.mp3");
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath("id3-test-data/cover-test-jpg.mp3"), location));
    auto track = getOrAddTrackByLocation(location);
    ASSERT_TRUE(track);
    const auto id = track->getId();
    const auto originalTitle = track->getTitle();
    const auto database = trackCollectionManager()->internalCollection()->database();

    QSqlQuery query(database);
    ASSERT_TRUE(query.exec(QStringLiteral(
            "CREATE TRIGGER reject_external_source_before_insert "
            "BEFORE INSERT ON external_track_sources BEGIN "
            "SELECT RAISE(ABORT, 'test provenance failure'); END")))
            << query.lastError().text().toStdString();
    ASSERT_TRUE(track->setExternalSource(provenanceFor(directory)));
    track->setTitle(QStringLiteral("must roll back"));
    EXPECT_EQ(trackCollectionManager()->saveTrack(track),
            TrackCollectionManager::SaveTrackResult::Failed);

    query.prepare(QStringLiteral("SELECT title FROM library WHERE id=:id"));
    query.bindValue(QStringLiteral(":id"), id.toVariant());
    ASSERT_TRUE(query.exec()) << query.lastError().text().toStdString();
    ASSERT_TRUE(query.next());
    EXPECT_EQ(query.value(0).toString(), originalTitle);
    EXPECT_EQ(externalSourceRows(database, id), 0);
    ASSERT_TRUE(query.exec(QStringLiteral(
            "DROP TRIGGER reject_external_source_before_insert")));
}
