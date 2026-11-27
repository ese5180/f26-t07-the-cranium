#include "library/rekordbox/rekordboxperformancewriter.h"
#include <gtest/gtest.h>

#include <cmath>
#include <thread>

#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QCoreApplication>
#include <QThread>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QtEndian>

#include "library/rekordbox/rekordboxdatabase.h"
#include "library/rekordbox/rekordboxratingwriter.h"
#include "library/rekordbox/rekordboxdecodertiming.h"
#include "library/rekordbox/rekordboxanlzreader.h"
#include "library/rekordbox/rekordboxruntimetrackmodel.h"
#include "library/rekordbox/rekordboxusbsession.h"
#include "library/proxytrackmodel.h"
#include "sources/soundsourceproxy.h"
#include "test/librarytest.h"
#include "test/mixxxtest.h"
#include "test/soundsourceproviderregistration.h"
#include "track/track.h"
#include "track/keyutils.h"
#include "util/samplebuffer.h"

namespace {
using namespace mixxx::rekordbox;
void put32(QByteArray* bytes, int offset, quint32 value) {
    qToLittleEndian(value, bytes->data() + offset);
}
void put16(QByteArray* bytes, int offset, quint16 value) {
    qToLittleEndian(value, bytes->data() + offset);
}
QByteArray text(const QByteArray& value) {
    return QByteArray(1, static_cast<char>((value.size() + 1) * 2 + 1)) + value;
}
QByteArray track(quint32 id = 1, const QByteArray& path = "/Contents/test.mp3",
        const QByteArray& analysis = "/PIONEER/USBANLZ/test.DAT") {
    QByteArray row(136, '\0');
    put32(&row, 72, id);
    put32(&row, 56, 12850);
    put16(&row, 84, 123);
    row[88] = 3;
    row[89] = 4;
    for (const auto& field : QList<QPair<int, QByteArray>>{{14, analysis},
                 {16, "Comment"}, {17, "Title"}, {20, path}}) {
        put16(&row, 94 + field.first * 2, row.size());
        row.append(text(field.second));
    }
    return row;
}
QByteArray playlist(quint32 id, quint32 parent, bool folder, quint32 order = 0) {
    QByteArray row(20, '\0');
    put32(&row, 0, parent);
    put32(&row, 8, order);
    put32(&row, 12, id);
    put32(&row, 16, folder);
    return row + text("Node");
}
QByteArray entry(quint32 list, quint32 id, quint32 order) {
    QByteArray row(12, '\0');
    put32(&row, 0, order);
    put32(&row, 4, id);
    put32(&row, 8, list);
    return row;
}
using Rows = QList<QPair<quint32, QByteArray>>;
Rows rows() {
    QByteArray key(8, '\0');
    put32(&key, 0, 5);
    auto song = track();
    put32(&song, 32, 5);
    return {{0, song}, {5, key + text("Am")},
            {7, playlist(10, 0, true)}, {7, playlist(11, 10, true)},
            {7, playlist(12, 11, false, 2)}, {7, playlist(13, 11, false, 1)},
            {8, entry(12, 1, 3)}, {8, entry(12, 1, 1)}};
}
// Synthetic DeviceSQL container: one bounded live row per data page. No claim
// of being a physical Pioneer export. Uses the production reader, not a mock.
QByteArray database(const Rows& data) {
    constexpr int pageSize = 512;
    QMap<quint32, QList<QByteArray>> tables;
    for (const auto& row : data) {
        tables[row.first].append(row.second);
    }
    QByteArray bytes(pageSize * (data.size() + 1), '\0');
    put32(&bytes, 4, pageSize);
    put32(&bytes, 8, tables.size());
    int page = 1;
    int table = 0;
    for (auto it = tables.cbegin(); it != tables.cend(); ++it, ++table) {
        put32(&bytes, 28 + 16 * table, it.key());
        put32(&bytes, 36 + 16 * table, page);
        put32(&bytes, 40 + 16 * table, page + it.value().size() - 1);
        for (const auto& row : it.value()) {
            const int at = page * pageSize;
            put32(&bytes, at + 4, page);
            put32(&bytes, at + 8, it.key());
            put32(&bytes, at + 12, page + 1);
            put16(&bytes, at + 24, 1);
            put16(&bytes, at + pageSize - 4, 1);
            bytes.replace(at + 40, row.size(), row);
            ++page;
        }
    }
    return bytes;
}
bool write(const QString& path, const QByteArray& bytes) {
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) {
        return false;
    }
    QFile file(path);
    return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size();
}
QString pdb(const QTemporaryDir& volume) {
    return volume.filePath("PIONEER/rekordbox/export.pdb");
}

void putAnlz16(QByteArray* bytes, qsizetype offset, quint16 value) {
    qToBigEndian(value, bytes->data() + offset);
}

void putAnlz32(QByteArray* bytes, qsizetype offset, quint32 value) {
    qToBigEndian(value, bytes->data() + offset);
}

QByteArray anlzWideString(const QString& value) {
    QByteArray bytes;
    bytes.reserve((value.size() + 1) * 2);
    for (const auto character : value) {
        const auto code = character.unicode();
        bytes.append(static_cast<char>(code >> 8));
        bytes.append(static_cast<char>(code & 0xff));
    }
    bytes.append(QByteArray(2, '\0'));
    return bytes;
}

QByteArray anlzPpth(const QString& owner) {
    const auto path = anlzWideString(owner);
    QByteArray section(16, '\0');
    section.replace(0, 4, "PPTH");
    putAnlz32(&section, 4, 16);
    putAnlz32(&section, 12, path.size());
    section.append(path);
    putAnlz32(&section, 8, section.size());
    return section;
}

QByteArray anlzPcp2(quint32 hotCue,
        quint8 type,
        quint32 startMs,
        quint32 endMs,
        const QString& label,
        quint32 rgb) {
    const auto comment = label.isEmpty() ? QByteArray() : anlzWideString(label);
    QByteArray entry(48 + comment.size(), '\0');
    entry.replace(0, 4, "PCP2");
    putAnlz32(&entry, 4, 16);
    putAnlz32(&entry, 8, entry.size());
    putAnlz32(&entry, 12, hotCue);
    entry[16] = static_cast<char>(type);
    putAnlz16(&entry, 18, 1000);
    putAnlz32(&entry, 20, startMs);
    putAnlz32(&entry, 24, endMs);
    putAnlz32(&entry, 40, comment.size());
    entry.replace(44, comment.size(), comment);
    const auto color = 44 + comment.size();
    entry[color + 1] = static_cast<char>((rgb >> 16) & 0xff);
    entry[color + 2] = static_cast<char>((rgb >> 8) & 0xff);
    entry[color + 3] = static_cast<char>(rgb & 0xff);
    return entry;
}

QByteArray anlzPcpt(quint32 hotCue, quint8 type, quint32 startMs, quint32 endMs) {
    QByteArray entry(56, '\0');
    entry.replace(0, 4, "PCPT");
    putAnlz32(&entry, 4, 28);
    putAnlz32(&entry, 8, 56);
    putAnlz32(&entry, 12, hotCue);
    putAnlz32(&entry, 20, 0x00010000);
    putAnlz16(&entry, 24, 0xffff);
    putAnlz16(&entry, 26, 0xffff);
    entry[28] = static_cast<char>(type);
    putAnlz16(&entry, 30, 1000);
    putAnlz32(&entry, 32, startMs);
    putAnlz32(&entry, 36, endMs);
    return entry;
}

QByteArray anlzCueList(bool extended,
        quint32 listType,
        const QList<QByteArray>& entries) {
    const int header = extended ? 20 : 24;
    QByteArray section(header, '\0');
    section.replace(0, 4, extended ? "PCO2" : "PCOB");
    putAnlz32(&section, 4, header);
    putAnlz32(&section, 12, listType);
    putAnlz16(&section, extended ? 16 : 18, entries.size());
    for (const auto& entry : entries) {
        section.append(entry);
    }
    putAnlz32(&section, 8, section.size());
    return section;
}

QByteArray syntheticCueAnlz(const QString& owner) {
    const QList<QByteArray> sections{
            anlzPpth(owner),
            // Legacy cue must be suppressed by the nonempty PCO2 lists.
            anlzCueList(false, 1, {anlzPcpt(2, 1, 500, 0xffffffffu)}),
            anlzCueList(true,
                    1,
                    {anlzPcp2(1, 1, 1250, 0xffffffffu,
                             QStringLiteral("Intro"), 0x123456),
                            anlzPcp2(8, 2, 2000, 4000,
                                    QStringLiteral("Hot loop"), 0xaabbcc)}),
            anlzCueList(true,
                    0,
                    {anlzPcp2(0, 1, 750, 0xffffffffu,
                             QStringLiteral("Memory"), 0),
                            anlzPcp2(0, 2, 5000, 7000,
                                    QStringLiteral("Memory loop"), 0)}),
    };
    QByteArray bytes(28, '\0');
    bytes.replace(0, 4, "PMAI");
    putAnlz32(&bytes, 4, 28);
    for (const auto& section : sections) {
        bytes.append(section);
    }
    putAnlz32(&bytes, 8, bytes.size());
    return bytes;
}

TEST(RekordboxUsbSessionTest, SyntheticUsbToCatalogIntegration) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "not decoded audio"));
    RekordboxUsbSession session(volume.path());
    EXPECT_EQ(session.state(), UsbSessionState::Missing);
    EXPECT_FALSE(session.catalog());
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    EXPECT_EQ(session.state(), UsbSessionState::Ready);
    EXPECT_EQ(session.errorCode(), UsbSessionError::None);
    const auto catalog = session.catalog();
    ASSERT_TRUE(catalog);
    EXPECT_TRUE(catalog->sealed());
    ASSERT_EQ(catalog->tracks().size(), 1);
    const auto song = catalog->findTrack(1);
    ASSERT_TRUE(song);
    EXPECT_EQ(song->title, "Title");
    EXPECT_EQ(song->comment, "Comment");
    EXPECT_EQ(song->key, "Am");
    ASSERT_TRUE(song->bpm);
    EXPECT_DOUBLE_EQ(*song->bpm, 128.5);
    EXPECT_EQ(song->durationSeconds, 123u);
    EXPECT_EQ(song->rating, 4u);
    EXPECT_EQ(song->colorId, 3u);
    EXPECT_EQ(song->audioRelativePath, "/Contents/test.mp3");
    EXPECT_EQ(song->resolvedAudioPath, volume.filePath("Contents/test.mp3"));
    // Phase 3 inspects the declared analysis path. This synthetic PDB has no
    // existing ANLZ file, so inspection is complete and the result is Missing.
    EXPECT_EQ(song->analysisState, RuntimeAnalysisState::Missing);
    EXPECT_TRUE(song->beats.isEmpty());
    EXPECT_TRUE(song->cues.isEmpty());
    EXPECT_TRUE(song->waveforms.isEmpty());
    QString projectionError;
    const auto projected = session.createTemporaryTrack(1, &projectionError);
    ASSERT_TRUE(projected) << projectionError.toStdString();
    EXPECT_FALSE(projected->getId().isValid());
    EXPECT_EQ(projected->getTitle(), QStringLiteral("Title"));
    EXPECT_EQ(projected->getComment(), QStringLiteral("Comment"));
    EXPECT_EQ(projected->getDurationSecondsInt(), 123);
    EXPECT_EQ(projected->getRating(), 4);
    EXPECT_DOUBLE_EQ(projected->getBpm(), mixxx::Bpm::kValueUndefined);
    EXPECT_EQ(projected->getSourceBinding().rekordboxId(), 1u);
    EXPECT_TRUE(projected->isSourceAvailableForPlayback());
    EXPECT_FALSE(projected->getUsePolicy().canPersist());
    EXPECT_FALSE(session.createTemporaryTrack(999, &projectionError));
    EXPECT_FALSE(projectionError.isEmpty());
    ASSERT_EQ(catalog->playlists().size(), 1);
    const auto folder = catalog->findPlaylist(11);
    ASSERT_TRUE(folder);
    ASSERT_EQ(folder->children.size(), 2);
    EXPECT_EQ(folder->children.first().rekordboxId, 13u);
    EXPECT_TRUE(catalog->findPlaylist(13)->trackIds.isEmpty());
    EXPECT_EQ(catalog->findPlaylist(12)->trackIds, (QList<quint32>{1, 1}));
    EXPECT_TRUE(session.refresh());
    EXPECT_FALSE(session.load());
    session.invalidate();
    EXPECT_FALSE(projected->isSourceAvailableForPlayback());
}

class RekordboxRuntimeTrackModelTest : public LibraryTest {};

TEST_F(RekordboxRuntimeTrackModelTest,
        ExposesProviderRowsWithoutTrackIdsImportOrPathDrag) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "audio fixture"));
    auto session = std::make_shared<RekordboxUsbSession>(volume.path());
    ASSERT_TRUE(session->load()) << session->error().toStdString();

    RekordboxRuntimeTrackModel model(nullptr, trackCollectionManager());
    model.showAllTracks(session);
    ASSERT_EQ(model.rowCount(), 1);
    const auto row = model.index(0, 0);
    EXPECT_EQ(model.getTrackUrl(row).scheme(), QStringLiteral("rekordbox-usb"));
    EXPECT_FALSE(model.getTrackId(row).isValid());
    EXPECT_TRUE(model.getTrackRows(TrackId()).isEmpty());
    EXPECT_TRUE(model.hasCapabilities(TrackModel::Capability::LoadToDeck));
    EXPECT_FALSE(model.hasCapabilities(TrackModel::Capability::AddToTrackSet));
    EXPECT_FALSE(model.hasCapabilities(TrackModel::Capability::AddToAutoDJ));
    EXPECT_FALSE(model.hasCapabilities(TrackModel::Capability::Analyze));
    EXPECT_FALSE(model.flags(row).testFlag(Qt::ItemIsDragEnabled));
    EXPECT_FALSE(model.flags(row).testFlag(Qt::ItemIsEditable));

    const auto title = model.index(
            0, model.fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_TITLE));
    EXPECT_EQ(model.data(title).toString(), QStringLiteral("Title"));
    ProxyTrackModel proxy(&model);
    EXPECT_EQ(proxy.fieldIndex(QStringLiteral("preview")),
            model.fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_PREVIEW));
    EXPECT_EQ(proxy.fieldIndex(QStringLiteral("title")),
            model.fieldIndex(ColumnCache::COLUMN_LIBRARYTABLE_TITLE));
    const auto projected = model.getTrack(row);
    ASSERT_TRUE(projected);
    EXPECT_FALSE(projected->getId().isValid());
    EXPECT_EQ(projected->getSourceBinding().rekordboxId(), 1u);
    EXPECT_TRUE(projected->isSourceAvailableForPlayback());

    model.showPlaylist(session, {1, 1, 999}, 12);
    EXPECT_EQ(model.rowCount(), 2); // Declared duplicates and order survive.
    session->invalidate();
    EXPECT_FALSE(model.getTrack(model.index(0, 0)));
}

TEST_F(RekordboxRuntimeTrackModelTest, BrowserPreviewCacheSeparatesStylesAndClearsWithSession) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    QByteArray analysis(28, '\0');
    analysis.replace(0,4,"PMAI"); putAnlz32(&analysis,4,28);
    analysis += anlzPpth(QStringLiteral("/Contents/test.mp3"));
    for (const auto& tag : {QByteArray("PWV4"), QByteArray("PWV6")}) {
        const int header = tag == "PWV4" ? 24 : 20;
        const int stride = tag == "PWV4" ? 6 : 3;
        QByteArray section(header, '\0');
        section.replace(0,4,tag); putAnlz32(&section,4,header);
        putAnlz32(&section,12,stride); putAnlz32(&section,16,2);
        section += QByteArray(stride*2, char(100));
        putAnlz32(&section,8,section.size()); analysis += section;
    }
    putAnlz32(&analysis,8,analysis.size());
    ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"),analysis));
    auto session = std::make_shared<RekordboxUsbSession>(volume.path());
    ASSERT_TRUE(session->load());
    ASSERT_EQ(2,session->catalog()->findTrack(1)->waveforms.size());
    RekordboxRuntimeTrackModel model(nullptr,trackCollectionManager());
    model.showAllTracks(session);
    const auto index = model.index(0,0);
    for (auto mode : {WaveformMode::ThreeBand,WaveformMode::RGB,WaveformMode::Blue}) {
        EXPECT_EQ(nullptr,model.waveformPreview(index,mode));
        model.requestWaveformPreview(index,mode);
        // Switching styles while earlier requests are pending must not reuse
        // or suppress another mode's request.
    }
    QElapsedTimer timer; timer.start();
    while ((!model.waveformPreview(index,WaveformMode::RGB) ||
            !model.waveformPreview(index,WaveformMode::Blue) ||
            !model.waveformPreview(index,WaveformMode::ThreeBand)) && timer.elapsed()<3000) {
        QCoreApplication::processEvents(); QThread::msleep(1);
    }
    for (auto mode : {WaveformMode::ThreeBand,WaveformMode::RGB,WaveformMode::Blue}) {
        const auto* preview = model.waveformPreview(index,mode);
        ASSERT_NE(nullptr,preview);
        EXPECT_EQ(mode==WaveformMode::ThreeBand ? QByteArray("PWV6") : QByteArray("PWV4"),preview->tag);
        EXPECT_EQ(2,preview->columns.size());
        EXPECT_FALSE(model.getTrackId(index).isValid());
    }
    model.clearSession();
    EXPECT_EQ(0,model.rowCount());
    EXPECT_EQ(nullptr,model.waveformPreview(index,WaveformMode::RGB));
}

TEST_F(RekordboxRuntimeTrackModelTest,
        ProjectionRevalidatesFingerprintAtSameMountpoint) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "audio fixture"));
    auto session = std::make_shared<RekordboxUsbSession>(volume.path());
    ASSERT_TRUE(session->load()) << session->error().toStdString();

    RekordboxRuntimeTrackModel model(nullptr, trackCollectionManager());
    model.showAllTracks(session);
    ASSERT_EQ(model.rowCount(), 1);
    ASSERT_TRUE(write(pdb(volume), database({{0, track(2)}})));
    EXPECT_FALSE(model.getTrack(model.index(0, 0)));
    EXPECT_EQ(session->state(), UsbSessionState::Invalidated);
    EXPECT_EQ(session->errorCode(), UsbSessionError::ChangedDevice);
}

TEST(RekordboxUsbSessionTest, MapsSupportedNamedMetadataAndPreservesUnsignedArtworkId) {
    QTemporaryDir volume;
    auto song = track();
    put32(&song, 68, 2);
    put32(&song, 12, 2);
    put32(&song, 64, 3);
    put32(&song, 60, 4);
    put32(&song, 28, 0xffffffffu);
    QByteArray artist(10, '\0');
    put32(&artist, 4, 2);
    artist[9] = 10;
    QByteArray album(22, '\0');
    put32(&album, 12, 3);
    album[21] = 22;
    QByteArray genre(4, '\0');
    put32(&genre, 0, 4);
    QByteArray artwork(4, '\0');
    put32(&artwork, 0, 0xffffffffu);
    ASSERT_TRUE(write(pdb(volume), database({{0, song},
            {2, artist + text("Artist")}, {3, album + text("Album")},
            {1, genre + text("Genre")}, {13, artwork + text("/PIONEER/art.jpg")}})));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    const auto result = session.catalog()->findTrack(1);
    ASSERT_TRUE(result);
    EXPECT_EQ(result->artist, "Artist");
    EXPECT_EQ(result->composer, "Artist");
    EXPECT_EQ(result->album, "Album");
    EXPECT_EQ(result->genre, "Genre");
    EXPECT_EQ(result->artworkId, 0xffffffffu);
    EXPECT_EQ(result->artworkRelativePath, "/PIONEER/art.jpg");
    EXPECT_EQ(result->resolvedArtworkPath, volume.filePath("PIONEER/art.jpg"));
}

TEST(RekordboxUsbSessionTest, DoesNotInventAbsentBpmOrOutOfRangeRating) {
    QTemporaryDir volume;
    auto song = track();
    put32(&song, 56, 0);
    song[89] = 6;
    ASSERT_TRUE(write(pdb(volume), database({{0, song}})));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    const auto result = session.catalog()->findTrack(1);
    ASSERT_TRUE(result);
    EXPECT_FALSE(result->bpm);
    EXPECT_FALSE(result->rating);
    EXPECT_EQ(result->rawMetadata.value("rating").toInt(), 6);
    EXPECT_FALSE(result->diagnostics.isEmpty());
}

TEST(RekordboxUsbSessionTest, ConcurrentInvalidationCannotRepublishCatalog) {
    QTemporaryDir volume;
    auto bytes = database(rows());
    bytes.append(QByteArray(4 * 1024 * 1024, '\0'));
    ASSERT_TRUE(write(pdb(volume), bytes));
    for (int attempt = 0; attempt < 10; ++attempt) {
        RekordboxUsbSession session(volume.path());
        std::thread loader([&] { session.load(); });
        while (session.state() == UsbSessionState::Missing) {
            std::this_thread::yield();
        }
        const auto retained = session.catalog();
        session.invalidate();
        loader.join();
        EXPECT_EQ(session.state(), UsbSessionState::Invalidated);
        EXPECT_FALSE(session.catalog());
        EXPECT_FALSE(session.load());
        if (retained) {
            EXPECT_FALSE(retained->valid());
        }
    }
}

TEST(RekordboxUsbSessionTest, DistinguishesMissingNonRekordboxIncompleteAndCorrupt) {
    QTemporaryDir volume;
    RekordboxUsbSession missing(volume.filePath("absent"));
    EXPECT_FALSE(missing.load());
    EXPECT_FALSE(missing.sessionState());
    EXPECT_EQ(missing.state(), UsbSessionState::Missing);
    EXPECT_EQ(missing.errorCode(), UsbSessionError::MissingDevice);
    RekordboxUsbSession emptyRoot(QString{});
    EXPECT_FALSE(emptyRoot.load());
    EXPECT_EQ(emptyRoot.errorCode(), UsbSessionError::MissingDevice);
    RekordboxUsbSession other(volume.path());
    EXPECT_FALSE(other.load());
    EXPECT_EQ(other.errorCode(), UsbSessionError::NotRekordbox);
    ASSERT_TRUE(QDir().mkpath(volume.filePath("PIONEER/rekordbox")));
    RekordboxUsbSession incomplete(volume.path());
    EXPECT_FALSE(incomplete.load());
    EXPECT_EQ(incomplete.errorCode(), UsbSessionError::IncompleteExport);
    ASSERT_TRUE(write(pdb(volume), "broken"));
    RekordboxUsbSession corrupt(volume.path());
    EXPECT_FALSE(corrupt.load());
    EXPECT_EQ(corrupt.state(), UsbSessionState::Error);
    EXPECT_EQ(corrupt.errorCode(), UsbSessionError::CorruptExport);
    EXPECT_FALSE(corrupt.catalog());
    RekordboxUsbSession notDirectory(pdb(volume));
    EXPECT_FALSE(notDirectory.load());
    EXPECT_EQ(notDirectory.state(), UsbSessionState::Unreadable);
}

TEST(RekordboxUsbSessionTest, UnreadableDatabase) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    const auto permissions = QFile::permissions(pdb(volume));
    ASSERT_TRUE(QFile::setPermissions(pdb(volume), QFileDevice::WriteOwner));
    if (QFileInfo(pdb(volume)).isReadable()) {
        QFile::setPermissions(pdb(volume), permissions);
        GTEST_SKIP() << "Platform/process bypasses permission bits";
    }
    RekordboxUsbSession session(volume.path());
    EXPECT_FALSE(session.load());
    EXPECT_EQ(session.state(), UsbSessionState::Unreadable);
    EXPECT_EQ(session.errorCode(), UsbSessionError::UnreadableDevice);
    EXPECT_TRUE(QFile::setPermissions(pdb(volume), permissions));
}

TEST(RekordboxUsbSessionTest, UnreadableExportDirectoryIsNotMisreportedAsMissing) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    const auto path = volume.filePath("PIONEER/rekordbox");
    const auto permissions = QFile::permissions(path);
    ASSERT_TRUE(QFile::setPermissions(path, QFileDevice::WriteOwner));
    if (QFileInfo(path).isReadable() && QFileInfo(path).isExecutable()) {
        QFile::setPermissions(path, permissions);
        GTEST_SKIP() << "Platform/process bypasses directory permissions";
    }
    RekordboxUsbSession session(volume.path());
    EXPECT_FALSE(session.load());
    EXPECT_EQ(session.state(), UsbSessionState::Unreadable);
    EXPECT_EQ(session.errorCode(), UsbSessionError::UnreadableDevice);
    EXPECT_TRUE(QFile::setPermissions(path, permissions));
}

TEST(RekordboxUsbSessionTest, EmptyValidExportAndOptionalExtendedDatabase) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database({})));
    const auto ext = volume.filePath("PIONEER/rekordbox/exportExt.pdb");
    ASSERT_TRUE(write(ext, "not interpreted in phase 2"));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    EXPECT_TRUE(session.catalog()->tracks().isEmpty());
    EXPECT_EQ(session.extendedDatabasePath(), ext);
}

TEST(RekordboxUsbSessionTest, HiddenPioneerStructure) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(volume.filePath(".PIONEER/rekordbox/export.pdb"), database(rows())));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    EXPECT_EQ(session.catalog()->tracks().size(), 1);
}

TEST(RekordboxUsbSessionTest, MissingAndUnsafePathsRemainExplicit) {
    QTemporaryDir volume;
    QTemporaryDir outside;
    ASSERT_TRUE(write(outside.filePath("outside.mp3"), "outside"));
    ASSERT_TRUE(QFile::link(outside.path(), volume.filePath("escape")));
    Rows data{{0, track(1)}, {0, track(2, "../outside.mp3")},
            {0, track(3, "/escape/outside.mp3")}, {0, track(4, "C:\\other.mp3")},
            {0, track(5, "\\Contents\\backslash.mp3")}};
    ASSERT_TRUE(write(pdb(volume), database(data)));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    const auto catalog = session.catalog();
    EXPECT_EQ(catalog->findTrack(1)->resolvedAudioPath, volume.filePath("Contents/test.mp3"));
    EXPECT_FALSE(catalog->findTrack(1)->diagnostics.isEmpty());
    for (quint32 id : {2u, 3u, 4u}) {
        EXPECT_TRUE(catalog->findTrack(id)->resolvedAudioPath.isEmpty());
        EXPECT_FALSE(catalog->findTrack(id)->audioRelativePath.isEmpty());
        EXPECT_FALSE(catalog->findTrack(id)->diagnostics.isEmpty());
    }
    EXPECT_EQ(catalog->findTrack(5)->resolvedAudioPath, volume.filePath("Contents/backslash.mp3"));
}

TEST(RekordboxUsbSessionTest, RejectsDatabaseSymlinkOutsideVolume) {
    QTemporaryDir volume;
    QTemporaryDir outside;
    ASSERT_TRUE(write(outside.filePath("export.pdb"), database(rows())));
    ASSERT_TRUE(QDir().mkpath(QFileInfo(pdb(volume)).absolutePath()));
    ASSERT_TRUE(QFile::link(outside.filePath("export.pdb"), pdb(volume)));
    RekordboxUsbSession session(volume.path());
    EXPECT_FALSE(session.load());
    EXPECT_EQ(session.errorCode(), UsbSessionError::IncompleteExport);
}

TEST(RekordboxUsbSessionTest, InvalidReferencesDiagnosedAndFiltered) {
    QTemporaryDir volume;
    auto data = rows();
    data.append({8, entry(12, 999, 2)});
    data.append({8, entry(999, 1, 0)});
    data.append({8, entry(10, 1, 0)});
    data.append({7, playlist(14, 999, false)});
    data.append({7, playlist(15, 12, false)});
    ASSERT_TRUE(write(pdb(volume), database(data)));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    const auto catalog = session.catalog();
    EXPECT_EQ(catalog->playlists().size(), 3);
    EXPECT_EQ(catalog->findPlaylist(12)->trackIds, (QList<quint32>{1, 1}));
    EXPECT_TRUE(catalog->findPlaylist(10)->trackIds.isEmpty());
    EXPECT_GE(catalog->diagnostics().size(), 4);
}

TEST(RekordboxUsbSessionTest, DuplicateTrackIdentitiesAndPathsAreNotOverwritten) {
    QTemporaryDir volume;
    auto data = rows();
    data.append({0, track(1, "/Contents/duplicate.mp3")});
    data.append({0, track(2)});
    ASSERT_TRUE(write(pdb(volume), database(data)));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    EXPECT_EQ(session.catalog()->tracks().size(), 1);
    EXPECT_EQ(session.catalog()->findTrack(1)->title, "Title");
    EXPECT_TRUE(session.catalog()->diagnostics().join('\n').contains("duplicate", Qt::CaseInsensitive));
}

TEST(RekordboxUsbSessionTest, DuplicatePlaylistIdsAndCyclesAreFatal) {
    QTemporaryDir volume;
    for (const auto& extra : Rows{{7, playlist(10, 0, false)}, {7, playlist(99, 99, true)}}) {
        auto data = rows();
        data.append(extra);
        ASSERT_TRUE(write(pdb(volume), database(data)));
        RekordboxUsbSession session(volume.path());
        EXPECT_FALSE(session.load());
        EXPECT_EQ(session.errorCode(), UsbSessionError::CorruptExport);
        EXPECT_FALSE(session.catalog());
    }
}

TEST(RekordboxUsbSessionTest, ExcessiveDepthDoesNotPublishPartialCatalog) {
    QTemporaryDir volume;
    Rows data;
    for (quint32 id = 1; id <= 66; ++id) {
        data.append({7, playlist(id, id - 1, true)});
    }
    ASSERT_TRUE(write(pdb(volume), database(data)));
    RekordboxUsbSession session(volume.path());
    EXPECT_FALSE(session.load());
    EXPECT_FALSE(session.catalog());
    EXPECT_EQ(session.errorCode(), UsbSessionError::CorruptExport);
}

TEST(RekordboxUsbSessionTest, DisconnectInvalidatesAndReconnectNeedsNewSession) {
    QTemporaryDir volume;
    const auto bytes = database(rows());
    ASSERT_TRUE(write(pdb(volume), bytes));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    const auto sessionState = session.sessionState();
    ASSERT_TRUE(sessionState);
    ASSERT_TRUE(sessionState->isActive());
    const auto retained = session.catalog();
    const auto snapshot = retained->findTrack(1);
    ASSERT_TRUE(QDir(volume.path()).removeRecursively());
    EXPECT_FALSE(session.refresh());
    EXPECT_EQ(session.state(), UsbSessionState::Invalidated);
    EXPECT_FALSE(session.catalog());
    EXPECT_FALSE(retained->valid());
    EXPECT_TRUE(sessionState->isInvalidated());
    EXPECT_TRUE(retained->tracks().isEmpty());
    EXPECT_EQ(snapshot->title, "Title");
    EXPECT_TRUE(session.extendedDatabasePath().isEmpty());
    ASSERT_TRUE(write(pdb(volume), bytes));
    EXPECT_FALSE(session.load());
    RekordboxUsbSession reconnected(volume.path());
    ASSERT_TRUE(reconnected.load());
    ASSERT_TRUE(reconnected.sessionState());
    EXPECT_NE(sessionState->identifier(),
            reconnected.sessionState()->identifier());
    EXPECT_NE(retained, reconnected.catalog());
    EXPECT_FALSE(retained->valid());
}

TEST(RekordboxUsbSessionTest, ExportChangeInvalidatesAndDestructionClearsSharedCatalog) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    std::shared_ptr<const RuntimeCatalog> retained;
    {
        RekordboxUsbSession session(volume.path());
        ASSERT_TRUE(session.load());
        retained = session.catalog();
        ASSERT_TRUE(write(pdb(volume), database({})));
        EXPECT_FALSE(session.refresh());
        EXPECT_EQ(session.errorCode(), UsbSessionError::ChangedDevice);
        EXPECT_FALSE(retained->valid());
    }
    {
        RekordboxUsbSession session(volume.path());
        ASSERT_TRUE(session.load());
        retained = session.catalog();
    }
    EXPECT_FALSE(retained->valid());
}

TEST(RekordboxUsbSessionTest, InvalidationBeforeLoadIsTerminalAndIdempotent) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    RekordboxUsbSession session(volume.path());
    session.invalidate();
    session.invalidate();
    EXPECT_FALSE(session.load());
    EXPECT_FALSE(session.refresh());
    EXPECT_EQ(session.state(), UsbSessionState::Invalidated);
}

struct FileSnapshot {
    QByteArray contents;
    QDateTime modified;
    QFileDevice::Permissions permissions;
    bool operator==(const FileSnapshot& other) const {
        return contents == other.contents && modified == other.modified && permissions == other.permissions;
    }
};
QMap<QString, FileSnapshot> snapshot(const QString& root) {
    QMap<QString, FileSnapshot> result;
    QDirIterator it(root, QDir::Files | QDir::Hidden | QDir::NoDotAndDotDot, QDirIterator::Subdirectories);
    while (it.hasNext()) {
        QFile file(it.next());
        if (file.open(QIODevice::ReadOnly)) {
            result.insert(file.fileName(), {file.readAll(), QFileInfo(file).lastModified(), file.permissions()});
        }
    }
    return result;
}

TEST(RekordboxUsbSessionTest, ReadOnlyContentTimestampsPermissionsAndFileSet) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "untouched audio"));
    ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"), "untouched ANLZ"));
    const auto before = snapshot(volume.path());
    {
        RekordboxUsbSession session(volume.path());
        ASSERT_TRUE(session.load());
        EXPECT_TRUE(session.refresh());
        EXPECT_TRUE(isReadOnlyPath(volume.filePath("Contents/test.mp3")));
        session.invalidate();
    }
    EXPECT_EQ(snapshot(volume.path()), before);
}

TEST(RekordboxUsbSessionTest, OptionalRealExportFixtureReadOnly) {
    const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
    if (root.isEmpty()) {
        GTEST_SKIP() << "Set MIXXX_REKORDBOX_REAL_FIXTURE to an existing external export root";
    }
    const auto before = snapshot(root);
    ASSERT_FALSE(before.isEmpty());
    RekordboxUsbSession session(root);
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    const auto doc = readDatabaseFile(databasePath(root), DatabaseKind::Main);
    const auto index = readTrackIndex(doc);
    EXPECT_EQ(session.catalog()->tracks().size(), index.tracks.size());
    for (const auto& source : index.tracks) {
        const auto song = session.catalog()->findTrack(source.id);
        ASSERT_TRUE(song);
        EXPECT_EQ(song->rawMetadata, source.metadata);
        EXPECT_EQ(song->audioRelativePath, source.filePath);
    }
    RecordProperty("track_count", session.catalog()->tracks().size());
    RecordProperty("root_playlist_count", session.catalog()->playlists().size());
    EXPECT_TRUE(session.refresh());
    session.invalidate();
    EXPECT_EQ(snapshot(root), before);
}

TEST(RekordboxUsbSessionTest, OptionalRealAnlzAssociationAndStates) {
    const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
    if (root.isEmpty()) {
        GTEST_SKIP() << "Set MIXXX_REKORDBOX_REAL_FIXTURE to an existing external export root";
    }
    RekordboxUsbSession session(root);
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    const auto catalog = session.catalog();
    ASSERT_FALSE(catalog->tracks().isEmpty());
    QSet<QString> audioPaths;
    for (const auto& track : catalog->tracks()) {
        EXPECT_FALSE(track.resolvedAnlzPath.isEmpty());
        EXPECT_NE(track.analysisState, RuntimeAnalysisState::Unknown);
        EXPECT_NE(track.analysisState, RuntimeAnalysisState::Invalid);

        EXPECT_FALSE(audioPaths.contains(track.audioRelativePath))
                << "Duplicate audio path across tracks";
        audioPaths.insert(track.audioRelativePath);
        const auto read = readAnlzFile(track.resolvedAnlzPath);
        ASSERT_TRUE(read.containerValid);
        EXPECT_TRUE(read.hasPathSection);
        // Semantic association: the analysis container names this audio path.
        EXPECT_EQ(read.exportedAudioPath, track.audioRelativePath);
        ASSERT_EQ(track.beats.size(), read.beats.size());
        for (int i = 0; i < read.beats.size(); ++i) {
            EXPECT_EQ(track.beats[i].timeMs, read.beats[i].timeMs);
            EXPECT_EQ(track.beats[i].tempoCentiBpm, read.beats[i].tempoCentiBpm);
            EXPECT_EQ(track.beats[i].beatInBar, read.beats[i].beatInBar);
        }
    }
    EXPECT_EQ(audioPaths.size(), catalog->tracks().size());
    session.invalidate();
}

TEST(RekordboxUsbSessionTest, OptionalRealBrowserWaveformDecodesReadOnly) {
    const auto root = QString::fromLocal8Bit(
            qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
    if (root.isEmpty()) {
        GTEST_SKIP() << "Set MIXXX_REKORDBOX_REAL_FIXTURE to an existing export root";
    }
    RekordboxUsbSession session(root);
    ASSERT_TRUE(session.load()) << session.error().toStdString();

    std::optional<RuntimeWaveform> selected;
    for (const auto& track : session.catalog()->tracks()) {
        for (const auto& waveform : track.waveforms) {
            if (waveform.sectionTag == "PWV4" ||
                    waveform.sectionTag == "PWAV" ||
                    waveform.sectionTag == "PWV2" ||
                    waveform.sectionTag == "PWV7" ||
                    waveform.sectionTag == "PWV5" ||
                    waveform.sectionTag == "PWV3" ||
                    waveform.sectionTag == "PWV6") {
                selected = waveform;
                break;
            }
        }
        if (selected) {
            break;
        }
    }
    ASSERT_TRUE(selected) << "No supported ANLZ waveform in the export";
    QString error;
    const auto payload = session.loadWaveformPayload(*selected, &error);
    ASSERT_TRUE(payload) << error.toStdString();
    const auto columns = decodeRuntimeWaveformColumns(
            LoadedRuntimeWaveform{*selected, *payload}, 1024);
    ASSERT_FALSE(columns.isEmpty());
    EXPECT_LE(columns.size(), 1024);
    RecordProperty("waveform_tag", selected->sectionTag.constData());
    RecordProperty("source_entries", selected->entryCount);
    RecordProperty("browser_columns", columns.size());
}

TEST(RekordboxDecoderTimingTest, ReadsFrameCountsAndRejectsUntrustedTags) {
    QTemporaryDir files;
    // A synthetic two-frame header tests parsing, never audio compatibility.
    QByteArray bytes(834, '\0');
    putAnlz32(&bytes, 0, 0xfffb9000u); // 128kbps MPEG-1 stereo 44.1kHz
    putAnlz32(&bytes, 417, 0xfffb9000u);
    bytes.replace(36, 4, "Info");
    putAnlz32(&bytes, 40, 1);
    putAnlz32(&bytes, 44, 100);
    bytes.replace(48, 9, "LAME3.100");
    const auto setDelay = [&](int delay, int padding) {
        const quint32 packed = (delay << 12) | padding;
        bytes[69] = static_cast<char>(packed >> 16);
        bytes[70] = static_cast<char>(packed >> 8);
        bytes[71] = static_cast<char>(packed);
    };
    const auto path = files.filePath("header.mp3");
    setDelay(576, 1404);
    ASSERT_TRUE(write(path, bytes));
    auto parsed = readMp3TimingInfo(path);
    ASSERT_TRUE(parsed);
    EXPECT_EQ(parsed->sampleRate, 44100);
    EXPECT_EQ(parsed->leadInFrames, 1105);
    EXPECT_EQ(parsed->audibleFrames, 115200 - 576 - 1404);
    setDelay(123, 1000);
    ASSERT_TRUE(write(path, bytes));
    parsed = readMp3TimingInfo(path);
    ASSERT_TRUE(parsed);
    EXPECT_EQ(parsed->leadInFrames, 652); // not a hard-coded 1105
    bytes.replace(48, 4, "Fake");
    ASSERT_TRUE(write(path, bytes));
    EXPECT_FALSE(readMp3TimingInfo(path));
    bytes.replace(48, 4, "LAME");
    setDelay(576, 1); // invalid decoder tail compensation
    ASSERT_TRUE(write(path, bytes));
    EXPECT_FALSE(readMp3TimingInfo(path));
    ASSERT_TRUE(write(path, bytes.left(60)));
    EXPECT_FALSE(readMp3TimingInfo(path));
    ASSERT_TRUE(write(path, QByteArray::fromHex("494433040000ffffffff")));
    EXPECT_FALSE(readMp3TimingInfo(path));
}

class RekordboxUsbSessionAudioTest : public LibraryTest {};

TEST_F(RekordboxUsbSessionAudioTest, OptionalMetronomeDecoderTiming) {
    const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_METRONOME_USB"));
    const auto truthRoot = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_METRONOME_TRUTH"));
    if (root.isEmpty() || truthRoot.isEmpty()) {
        GTEST_SKIP() << "External METRONOME export and original reference JSON required";
    }
    RekordboxUsbSession session(root);
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    QJsonArray report;
    int files = 0;
    for (const auto& runtime : session.catalog()->tracks()) {
        if (!QFileInfo(runtime.resolvedAudioPath).fileName().startsWith("grid_test_128bpm_")) {
            continue;
        }
        ++files;
        const auto name = QFileInfo(runtime.resolvedAudioPath).completeBaseName();
        QFile truthFile(QDir(truthRoot).filePath(name + ".json"));
        ASSERT_TRUE(truthFile.open(QIODevice::ReadOnly));
        const auto truth = QJsonDocument::fromJson(truthFile.readAll()).object();
        const auto truthBeats = truth["beats"].toArray();
        ASSERT_EQ(truthBeats.size(), 64);
        const auto providers = SoundSourceProxy::allProviderRegistrationsForUrl(
                QUrl::fromLocalFile(runtime.resolvedAudioPath));
        ASSERT_FALSE(providers.isEmpty());
        int opened = 0;
        for (const auto& registration : providers) {
            QString error;
            auto projected = session.createTemporaryTrack(runtime.rekordboxId, &error);
            ASSERT_TRUE(projected) << error.toStdString();
            SoundSourceProxy proxy(projected, registration.getProvider());
            auto audio = proxy.openAudioSource();
            if (!audio) {
                report.append(QJsonObject{{"file", QFileInfo(runtime.resolvedAudioPath).fileName()},
                        {"provider", registration.getProvider()->getDisplayName()},
                        {"state", "decoder could not open fixture"}});
                continue;
            }
            ++opened;
            const auto sr = audio->getSignalInfo().getSampleRate().value();
            ASSERT_EQ(static_cast<double>(sr), truth["sample_rate"].toDouble());
            const auto channels = audio->getSignalInfo().getChannelCount().value();
            const SINT start = static_cast<SINT>(sr * 0.95);
            const SINT count = static_cast<SINT>(sr * 0.1);
            mixxx::SampleBuffer samples(count * channels);
            const auto read = audio->readSampleFrames(mixxx::WritableSampleFrames(
                    mixxx::IndexRange::forward(start, count),
                    mixxx::SampleBuffer::WritableSlice(samples)));
            ASSERT_EQ(read.frameLength(), count);
            SINT peak = 0;
            for (SINT i = 1; i < count; ++i) {
                if (std::abs(read.readableData()[i * channels]) >
                        std::abs(read.readableData()[peak * channels])) {
                    peak = i;
                }
            }
            const auto beats = projected->getBeats();
            ASSERT_TRUE(beats);
            const auto grid = beats->findClosestBeat(mixxx::audio::FramePos(sr));
            const double decodedLeadIn = start + peak - sr;
            // Rekordbox exports integer ms and this 44.1k WAV's grid is
            // already early in the source. Never repair it by moving WAVs.
            double maxGridErrorMs = 0;
            double maxPeakErrorFrames = 0;
            for (const auto& reference : truthBeats) {
                const SINT frame = static_cast<SINT>(reference.toObject()["sample"].toDouble());
                const auto beat = beats->findClosestBeat(mixxx::audio::FramePos(frame));
                maxGridErrorMs = std::max(maxGridErrorMs,
                        std::abs(beat.value() - frame - decodedLeadIn) * 1000.0 / sr);
                const SINT first = frame - count / 2;
                const auto window = audio->readSampleFrames(mixxx::WritableSampleFrames(
                        mixxx::IndexRange::forward(first, count),
                        mixxx::SampleBuffer::WritableSlice(samples)));
                ASSERT_EQ(window.frameLength(), count);
                SINT peakIndex = 0;
                for (SINT i = 1; i < count; ++i) {
                    if (std::abs(window.readableData()[i * channels]) >
                            std::abs(window.readableData()[peakIndex * channels])) peakIndex = i;
                }
                maxPeakErrorFrames = std::max(maxPeakErrorFrames,
                        std::abs(double(first + peakIndex - frame) - decodedLeadIn));
            }
            if (QFileInfo(runtime.resolvedAudioPath).suffix() == "mp3") {
                EXPECT_LT(maxGridErrorMs, 0.7);
                EXPECT_NEAR(projected->getMainCuePosition().value(), start + peak, sr * 0.0001);
                EXPECT_LE(maxPeakErrorFrames, 2);
                if (proxy.getProvider()->getDisplayName().startsWith("Apple CoreAudio")) {
                    EXPECT_LE(std::abs(decodedLeadIn), 2);
                }
            } else
            {
                EXPECT_LT(maxGridErrorMs, 1.6);
                EXPECT_EQ(projected->getMainCuePosition().value(), sr);
                EXPECT_EQ(maxPeakErrorFrames, 0);
            }
            // Repeated random seeks to the projected cue must return the same
            // PCM. This detects seek/prefetch errors separately from latency.
            const SINT cueFrame = static_cast<SINT>(std::llround(projected->getMainCuePosition().value()));
            std::vector<CSAMPLE> cuePcm;
            for (int repeat = 0; repeat < 8; ++repeat) {
                const auto cueRead = audio->readSampleFrames(mixxx::WritableSampleFrames(
                        mixxx::IndexRange::forward(cueFrame, count),
                        mixxx::SampleBuffer::WritableSlice(samples)));
                ASSERT_EQ(cueRead.frameLength(), count);
                if (repeat == 0) {
                    cuePcm.assign(cueRead.readableData(), cueRead.readableData() + count * channels);
                } else {
                    for (SINT i = 0; i < count * channels; ++i) {
                        ASSERT_NEAR(cueRead.readableData()[i], cuePcm[i], 0.00001) << "repeat=" << repeat;
                    }
                }
            }
            QJsonObject item{{"file", QFileInfo(runtime.resolvedAudioPath).fileName()},
                    {"provider", proxy.getProvider()->getDisplayName()},
                    {"sample_rate", static_cast<double>(sr)},
                    {"decoded_frames", static_cast<double>(audio->frameLength())},
                    {"kick_frame", static_cast<double>(start + peak)},
                    {"grid_frame", grid.value()},
                    {"cue_frame", projected->getMainCuePosition().value()},
                    {"decoded_lead_in_frames", decodedLeadIn},
                    {"max_grid_error_ms_64_beats", maxGridErrorMs},
                    {"max_peak_error_frames_64_beats", maxPeakErrorFrames},
                    {"cue_seek_repetitions", 8}};
            qInfo().noquote() << QJsonDocument(item).toJson(QJsonDocument::Compact);
            report.append(item);
        }
        EXPECT_GT(opened, 0);
    }
    EXPECT_EQ(files, 4);
    const auto reportPath = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_TIMING_REPORT"));
    if (!reportPath.isEmpty()) {
        QFile output(reportPath);
        ASSERT_TRUE(output.open(QIODevice::WriteOnly));
        output.write(QJsonDocument(report).toJson());
    }
}

TEST_F(RekordboxUsbSessionAudioTest,
        OptionalRealPqtzProjectionWaitsForDecoderSampleRate) {
    const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
    if (root.isEmpty()) {
        GTEST_SKIP() << "External pyrekordbox export required";
    }
    QFile source(QDir(root).filePath(
            "PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT"));
    ASSERT_TRUE(source.open(QIODevice::ReadOnly));
    const auto anlzBytes = source.readAll();
    const auto parsed = readAnlz(anlzBytes);
    ASSERT_TRUE(parsed.containerValid);
    ASSERT_GE(parsed.beats.size(), 2);

    QTemporaryDir volume;
    const auto owner = parsed.exportedAudioPath.toUtf8();
    ASSERT_TRUE(write(pdb(volume), database({{0, track(1, owner)}})));
    ASSERT_TRUE(write(
            volume.filePath("PIONEER/USBANLZ/test.DAT"), anlzBytes));
    const auto audioPath = resolvePath(
            volume.path(), parsed.exportedAudioPath, false);
    ASSERT_FALSE(audioPath.isEmpty());
    ASSERT_TRUE(QDir().mkpath(QFileInfo(audioPath).absolutePath()));
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath(QStringLiteral("id3-test-data/artist.mp3")),
            audioPath));

    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    const auto runtimeTrack = session.catalog()->findTrack(1);
    ASSERT_TRUE(runtimeTrack);
    ASSERT_TRUE(runtimeTrack->bpm);
    EXPECT_DOUBLE_EQ(*runtimeTrack->bpm, 128.5);
    EXPECT_EQ(runtimeTrack->beats.first().tempoCentiBpm, 12800);
    QString error;
    const auto projected = session.createTemporaryTrack(1, &error);
    ASSERT_TRUE(projected) << error.toStdString();
    EXPECT_EQ(projected->getBeatsImportStatus(), Track::ImportStatus::Pending);
    EXPECT_EQ(projected->getWaveformImportStatus(), Track::ImportStatus::Pending);
    EXPECT_FALSE(projected->getWaveform());
    EXPECT_DOUBLE_EQ(projected->getBpm(), mixxx::Bpm::kValueUndefined);

    SoundSourceProxy proxy(projected);
    auto audioSource = proxy.openAudioSource();
    ASSERT_TRUE(audioSource);
    const double removedFrames = proxy.getProvider()->getDisplayName().startsWith("Apple CoreAudio") ? 1105 : 0;
    audioSource->close();
    EXPECT_EQ(projected->getBeatsImportStatus(), Track::ImportStatus::Complete);
    EXPECT_EQ(projected->getWaveformImportStatus(), Track::ImportStatus::Complete);
    ASSERT_TRUE(projected->getWaveform());
    ASSERT_TRUE(projected->getWaveformSummary());
    EXPECT_GT(projected->getWaveform()->getDataSize(), 1);
    EXPECT_EQ(projected->getWaveform()->getCompletion(),
            projected->getWaveform()->getDataSize());
    const auto beats = projected->getBeats();
    ASSERT_TRUE(beats);
    const auto sampleRate = projected->getSampleRate();
    ASSERT_TRUE(sampleRate.isValid());
    auto it = beats->cfirstmarker();
    const auto expectedFirst = std::round(
            parsed.beats.first().timeMs * sampleRate.value() / 1000.0 - removedFrames);
    EXPECT_DOUBLE_EQ((*it).value(), expectedFirst);
    ++it;
    const auto expectedSecond = std::round(
            parsed.beats[1].timeMs * sampleRate.value() / 1000.0 - removedFrames);
    EXPECT_NEAR((*it).value(), expectedSecond, sampleRate.value()*0.0011);
    const auto projectedGridBpm =
            beats->getBpmAroundPosition(*beats->cfirstmarker(), 1).value();
    const auto expectedGridBpm =
            sampleRate.value() * 60.0 / (expectedSecond - expectedFirst);
    EXPECT_NEAR(projectedGridBpm, expectedGridBpm, 0.2);
    EXPECT_NE(projectedGridBpm, *runtimeTrack->bpm); // PDB BPM remains separate.
}

TEST_F(RekordboxUsbSessionAudioTest, QuantizedConstantTempoKeepsExactExportedBpmAndDynamicGridIsPreserved) {
    for(const bool dynamic:{false,true}) {
        QTemporaryDir volume;const auto owner=QStringLiteral("/Contents/test.wav");
        auto row=track(1,owner.toUtf8());put32(&row,56,12200);
        ASSERT_TRUE(write(pdb(volume),database({{0,row}})));
        auto bytes=syntheticCueAnlz(owner);
        QByteArray grid(24,'\0');grid.replace(0,4,"PQTZ");putAnlz32(&grid,4,24);putAnlz32(&grid,20,300);
        for(int i=0;i<300;++i) {
            const int tempo=dynamic && i>=150?12400:12200;
            const auto time=quint32(std::round(250+i*6000000.0/12200+(dynamic && i>=150?(i-150)*(6000000.0/12400-6000000.0/12200):0)));
            const int offset=grid.size();grid.append(QByteArray(8,'\0'));
            putAnlz16(&grid,offset,1+i%4);putAnlz16(&grid,offset+2,tempo);putAnlz32(&grid,offset+4,time);
        }
        putAnlz32(&grid,8,grid.size());bytes.append(grid);putAnlz32(&bytes,8,bytes.size());
        ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"),bytes));
        ASSERT_TRUE(QDir().mkpath(volume.filePath("Contents")));
        ASSERT_TRUE(QFile::copy(getTestDir().filePath("sine-30.wav"),volume.filePath("Contents/test.wav")));
        RekordboxUsbSession session(volume.path());ASSERT_TRUE(session.load());
        const auto runtime=session.catalog()->findTrack(1);ASSERT_TRUE(runtime);ASSERT_EQ(300,runtime->beats.size());
        const auto projected=session.createTemporaryTrack(1);ASSERT_TRUE(projected);
        SoundSourceProxy proxy(projected);const auto audio=proxy.openAudioSource();ASSERT_TRUE(audio);
        const auto beats=projected->getBeats();ASSERT_TRUE(beats);
        const double sampleRate=projected->getSampleRate().value();
        const auto saved=mixxx::rekordbox::capturePerformance(projected,&*runtime);
        ASSERT_TRUE(saved.error.isEmpty())<<saved.error.toStdString();
        ASSERT_EQ(runtime->beats.size(),saved.beats.size());
        for(int i=0;i<runtime->beats.size();++i) {
            EXPECT_EQ(runtime->beats[i].timeMs,saved.beats[i].timeMs);
            EXPECT_EQ(runtime->beats[i].tempoCentiBpm,saved.beats[i].tempoCentiBpm);
            EXPECT_EQ(runtime->beats[i].beatInBar,saved.beats[i].beatInBar);
        }
        if(!dynamic) {
            EXPECT_DOUBLE_EQ(122,projected->getBpm());
            for(int i=0;i<300;++i) {
                const auto position=beats->findClosestBeat(mixxx::audio::FramePos(sampleRate*(0.25+i*60.0/122)));
                EXPECT_NEAR(position.value(),sampleRate*(0.25+i*60.0/122),1);
                EXPECT_DOUBLE_EQ(122,beats->getBpmAroundPosition(position,1).value());
            }
        } else {
            int i=0;for(auto it=beats->cfirstmarker();i<runtime->beats.size();++it,++i)
                EXPECT_NEAR((*it).value(),std::round(runtime->beats[i].timeMs*sampleRate/1000),1);
            EXPECT_NEAR(124,beats->getBpmAroundPosition(mixxx::audio::FramePos(sampleRate*100),4).value(),0.1);
        }
    }
}

TEST_F(RekordboxUsbSessionAudioTest,
        SyntheticPco2CuesReachTemporaryTrackWithoutSqlPersistence) {
    QTemporaryDir volume;
    const auto owner = QStringLiteral("/Contents/test.mp3");
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"),
            syntheticCueAnlz(owner)));
    ASSERT_TRUE(QDir().mkpath(volume.filePath("Contents")));
    ASSERT_TRUE(QFile::copy(
            getTestDir().filePath(QStringLiteral("id3-test-data/artist.mp3")),
            volume.filePath("Contents/test.mp3")));

    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    const auto runtimeTrack = session.catalog()->findTrack(1);
    ASSERT_TRUE(runtimeTrack);
    ASSERT_EQ(runtimeTrack->cues.size(), 4);
    EXPECT_EQ(runtimeTrack->cues[0].hotcueIndex, 1); // PCO2, not PCOB slot 2.
    EXPECT_EQ(runtimeTrack->analysisState, RuntimeAnalysisState::Ready);

    QString error;
    const auto projected = session.createTemporaryTrack(1, &error);
    ASSERT_TRUE(projected) << error.toStdString();
    EXPECT_FALSE(projected->getUsePolicy().canPersist());
    EXPECT_EQ(projected->getCueImportStatus(), Track::ImportStatus::Pending);
    SoundSourceProxy proxy(projected);
    auto audioSource = proxy.openAudioSource();
    ASSERT_TRUE(audioSource);
    audioSource->close();
    EXPECT_EQ(projected->getCueImportStatus(), Track::ImportStatus::Complete);

    const auto cues = projected->getCuePoints();
    ASSERT_EQ(cues.size(), 5);
    CuePointer hotCue;
    CuePointer hotLoop;
    CuePointer mainCue;
    CuePointer memoryLoop;
    for (const auto& cue : cues) {
        if (cue->getType() == mixxx::CueType::HotCue && cue->getHotCue() == 0) {
            hotCue = cue;
        } else if (cue->getType() == mixxx::CueType::Loop && cue->getHotCue() == 7) {
            hotLoop = cue;
        } else if (cue->getType() == mixxx::CueType::MainCue) {
            mainCue = cue;
        } else if (cue->getType() == mixxx::CueType::MemoryLoop &&
                cue->getHotCue() == Cue::kNoHotCue) {
            memoryLoop = cue;
        }
    }
    ASSERT_TRUE(hotCue);
    ASSERT_TRUE(hotLoop);
    ASSERT_TRUE(mainCue);
    ASSERT_TRUE(memoryLoop);
    const auto sampleRate = projected->getSampleRate();
    ASSERT_TRUE(sampleRate.isValid());
    // This existing LAME fixture contains 576 encoder + 529 decoder frames.
    // CoreAudio removes them; untrimmed decoders retain them in PCM.
    const double removedFrames = proxy.getProvider()->getDisplayName().startsWith("Apple CoreAudio") ? 1105 : 0;
    EXPECT_NEAR(hotCue->getPosition().value(),
            1250.0 * sampleRate.value() / 1000.0 - removedFrames, 0.000001);
    EXPECT_EQ(hotCue->getLabel(), QStringLiteral("Intro"));
    EXPECT_EQ(hotCue->getColor(), mixxx::RgbColor(0x123456));
    EXPECT_NEAR(hotLoop->getPosition().value(),
            2000.0 * sampleRate.value() / 1000.0 - removedFrames, 0.000001);
    EXPECT_NEAR(hotLoop->getEndPosition().value(),
            4000.0 * sampleRate.value() / 1000.0 - removedFrames, 0.000001);
    EXPECT_NEAR(mainCue->getPosition().value(),
            750.0 * sampleRate.value() / 1000.0 - removedFrames, 0.000001);
    EXPECT_NEAR(memoryLoop->getEndPosition().value(),
            7000.0 * sampleRate.value() / 1000.0 - removedFrames, 0.000001);

    // Even after cues make the temporary Track dirty, the capability guard is
    // authoritative and prevents TrackDAO/CueDAO persistence.
    EXPECT_EQ(trackCollectionManager()->saveTrack(projected),
            TrackCollectionManager::SaveTrackResult::Skipped);
    QSqlQuery query(dbConnection());
    ASSERT_TRUE(query.exec(QStringLiteral("SELECT COUNT(*) FROM cues")));
    ASSERT_TRUE(query.next());
    EXPECT_EQ(query.value(0).toInt(), 0);
}

TEST_F(RekordboxUsbSessionAudioTest, DecoderTrimmingKeepsStartCuePlayable) {
    QTemporaryDir volume;
    const auto owner = QStringLiteral("/Contents/test.mp3");
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    QByteArray bytes(28, '\0');
    bytes.replace(0, 4, "PMAI");
    putAnlz32(&bytes, 4, 28);
    bytes += anlzPpth(owner);
    bytes += anlzCueList(true, 1, {anlzPcp2(1, 1, 0, 0xffffffffu, {}, 0),
            anlzPcp2(2, 2, 0, 1000, {}, 0)});
    bytes += anlzCueList(true, 0, {anlzPcp2(0, 1, 0, 0xffffffffu, {}, 0),
            anlzPcp2(0, 2, 0, 10, {}, 0)});
    putAnlz32(&bytes, 8, bytes.size());
    ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"), bytes));
    ASSERT_TRUE(QDir().mkpath(volume.filePath("Contents")));
    ASSERT_TRUE(QFile::copy(getTestDir().filePath("id3-test-data/artist.mp3"),
            volume.filePath("Contents/test.mp3")));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    QString error;
    const auto projected = session.createTemporaryTrack(1, &error);
    ASSERT_TRUE(projected) << error.toStdString();
    SoundSourceProxy proxy(projected);
    auto audio = proxy.openAudioSource();
    ASSERT_TRUE(audio);
    EXPECT_EQ(projected->getMainCuePosition().value(), 0);
    const bool trimmed = proxy.getProvider()->getDisplayName().startsWith("Apple CoreAudio");
    const auto cues = projected->getCuePoints();
    EXPECT_EQ(cues.size(), trimmed ? 4 : 5);
    for (const auto& cue : cues) {
        EXPECT_GE(cue->getPosition().value(), 0);
        if (cue->getType() == mixxx::CueType::Loop) {
            EXPECT_GT(cue->getEndPosition(), cue->getPosition());
        }
    }
    EXPECT_EQ(session.catalog()->findTrack(1)->cues.size(), 4);
    const auto original=session.catalog()->findTrack(1);
    const auto edit=mixxx::rekordbox::capturePerformance(projected,&*original);
    ASSERT_TRUE(edit.error.isEmpty())<<edit.error.toStdString();
    ASSERT_EQ(original->cues.size(),edit.cues.size());
    QStringList savedCues;
    for(const auto& candidate:edit.cues) savedCues.append(QString("%1/%2: %3–%4").arg(int(candidate.kind)).arg(candidate.hotcueIndex).arg(candidate.startMs.value_or(-1),0,'g',16).arg(candidate.endMs.value_or(-1),0,'g',16));
    for(const auto& cue:original->cues) {
        const auto saved=std::find_if(edit.cues.cbegin(),edit.cues.cend(),[&](const auto& candidate) {
            return candidate.kind==cue.kind && candidate.hotcueIndex==cue.hotcueIndex && candidate.startMs==cue.startMs && candidate.endMs==cue.endMs;
        });
        EXPECT_NE(edit.cues.cend(),saved)<<"kind "<<int(cue.kind)<<" slot "<<cue.hotcueIndex<<" start "<<cue.startMs.value_or(-1)<<" end "<<cue.endMs.value_or(-1)<<" offset "<<projected->property("rekordboxTimingOffsetMillis").toDouble()<<" saved "<<savedCues.join(", ").toStdString();
    }
}

TEST_F(RekordboxUsbSessionAudioTest,
        OptionalRealUsbCueReachesTemporaryTrack) {
    const auto root = QString::fromLocal8Bit(
            qgetenv("MIXXX_REKORDBOX_REAL_CUE_FIXTURE"));
    if (root.isEmpty()) {
        GTEST_SKIP() << "Real Rekordbox export with nonempty cues not supplied";
    }
    RekordboxUsbSession session(root);
    ASSERT_TRUE(session.load()) << session.error().toStdString();
    std::optional<RuntimeTrack> selected;
    for (const auto& track : session.catalog()->tracks()) {
        const bool hasHotCue = std::any_of(track.cues.cbegin(),
                track.cues.cend(),
                [](const RuntimeCue& cue) {
                    return cue.kind == RuntimeCue::Kind::HotCue;
                });
        if (hasHotCue && !track.resolvedAudioPath.isEmpty() &&
                SoundSourceProxy::isFileSuffixSupported(
                        QFileInfo(track.resolvedAudioPath).suffix())) {
            selected = track;
            break;
        }
    }
    ASSERT_TRUE(selected) << "No playable real track with a Hot Cue";
    const auto runtimeHot = std::find_if(selected->cues.cbegin(),
            selected->cues.cend(),
            [](const RuntimeCue& cue) {
                return cue.kind == RuntimeCue::Kind::HotCue;
            });
    ASSERT_NE(runtimeHot, selected->cues.cend());
    ASSERT_TRUE(runtimeHot->startMs);

    QString error;
    const auto projected = session.createTemporaryTrack(
            selected->rekordboxId, &error);
    ASSERT_TRUE(projected) << error.toStdString();
    SoundSourceProxy proxy(projected);
    auto audioSource = proxy.openAudioSource();
    ASSERT_TRUE(audioSource);
    const auto timing = readMp3TimingInfo(projected->getLocation());
    const double removedFrames = timing &&
            proxy.getProvider()->getDisplayName().startsWith("Apple CoreAudio") &&
            audioSource->frameLength() == timing->audibleFrames ? timing->leadInFrames : 0;
    audioSource->close();
    ASSERT_EQ(projected->getCueImportStatus(), Track::ImportStatus::Complete);
    ASSERT_EQ(projected->getWaveformImportStatus(), Track::ImportStatus::Complete);
    ASSERT_TRUE(projected->getWaveform());
    ASSERT_TRUE(projected->getWaveformSummary());
    EXPECT_TRUE(projected->getWaveform()->getVersion().startsWith(
            QStringLiteral("Rekordbox-ANLZ-PWV")));
    const auto projectedCues = projected->getCuePoints();
    const auto projectedHot = std::find_if(projectedCues.cbegin(),
            projectedCues.cend(),
            [&](const CuePointer& cue) {
                return cue->getType() == mixxx::CueType::HotCue &&
                        cue->getHotCue() == runtimeHot->hotcueIndex - 1;
            });
    ASSERT_NE(projectedHot, projectedCues.cend());
    const auto sampleRate = projected->getSampleRate();
    ASSERT_TRUE(sampleRate.isValid());
    EXPECT_DOUBLE_EQ((*projectedHot)->getPosition().value(),
            std::max(0.0, *runtimeHot->startMs * sampleRate.value() / 1000.0 - removedFrames));
    EXPECT_EQ((*projectedHot)->getLabel(), runtimeHot->label);
    if (runtimeHot->color) {
        EXPECT_EQ((*projectedHot)->getColor(), *runtimeHot->color);
    }
    EXPECT_EQ(trackCollectionManager()->saveTrack(projected),
            TrackCollectionManager::SaveTrackResult::Skipped);
    QSqlQuery query(dbConnection());
    ASSERT_TRUE(query.exec(QStringLiteral("SELECT COUNT(*) FROM cues")));
    ASSERT_TRUE(query.next());
    EXPECT_EQ(query.value(0).toInt(), 0);
    RecordProperty("rekordbox_track_id", selected->rekordboxId);
    RecordProperty("title", selected->title.toStdString());
    RecordProperty("artist", selected->artist.toStdString());
    RecordProperty("audio_path", selected->audioRelativePath.toStdString());
    RecordProperty("waveform_version",
            projected->getWaveform()->getVersion().toStdString());
    RecordProperty("runtime_cue_count", selected->cues.size());
}

TEST(RekordboxUsbSessionTest, SyntheticCorruptAndPartialAnlzDoNotDiscardValidTrack) {
    QTemporaryDir volume;
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "metadata-only audio"));
    ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"), "not PMAI"));
    ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.EXT"), QByteArray("PMAI", 4)));
    RekordboxUsbSession session(volume.path());
    ASSERT_TRUE(session.load());
    const auto song = session.catalog()->findTrack(1);
    ASSERT_TRUE(song);
    EXPECT_EQ(song->title, "Title");
    EXPECT_TRUE(song->beats.isEmpty());
    EXPECT_EQ(song->analysisState, RuntimeAnalysisState::Invalid);
    EXPECT_FALSE(song->diagnostics.isEmpty());
}
} // namespace

namespace {
TEST(RekordboxUsbSessionTest, OwnerAssociationRejectsSwappedMissingAndUnassociatedAnalysis) {
    // Source: pyrekordbox's real export, unmodified DAT bytes. A synthetic PDB
    // represents deliberate mismatches, not compatibility evidence for cues.
    const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
    if (root.isEmpty()) { GTEST_SKIP() << "External export root not supplied"; }
    QFile source(QDir(root).filePath("PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT"));
    ASSERT_TRUE(source.open(QIODevice::ReadOnly));
    const auto bytes = source.readAll();
    const auto real = readAnlz(bytes);
    ASSERT_TRUE(real.containerValid);
    ASSERT_FALSE(real.exportedAudioPath.isEmpty());
    const auto owner = real.exportedAudioPath.toUtf8();
    for (int scenario = 0; scenario < 6; ++scenario) {
        SCOPED_TRACE(scenario);
        QTemporaryDir volume;
        const QByteArray audio = scenario == 1 ? QByteArray("/Contents/other.mp3") : owner;
        const QByteArray locator = scenario == 2 ? QByteArray() : QByteArray("/PIONEER/USBANLZ/test.DAT");
        ASSERT_TRUE(write(pdb(volume), database({{0, track(1, audio, locator)}})));
        auto candidate = bytes;
        if (scenario == 4) { candidate = bytes.left(28); }
        if (scenario == 5) {
            const auto at = candidate.indexOf("PPTH");
            ASSERT_GT(at, 0);
            candidate.remove(at, qFromBigEndian<quint32>(candidate.constData() + at + 8));
            qToBigEndian<quint32>(candidate.size(), candidate.data() + 8);
        }
        if (scenario != 3) {
            ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"), candidate));
        }
        RekordboxUsbSession session(volume.path());
        ASSERT_TRUE(session.load());
        const auto song = session.catalog()->findTrack(1);
        ASSERT_TRUE(song);
        EXPECT_EQ(song->title, "Title");
        EXPECT_EQ(song->bpm, 128.5); // PDB BPM differs from the actual 128.00 grid.
        if (scenario == 0) {
            EXPECT_EQ(song->analysisState, RuntimeAnalysisState::Partial); // PVBR retained, not mapped.
            ASSERT_EQ(song->beats.size(), 368);
            EXPECT_EQ(song->beats.first().tempoCentiBpm, 12800);
            EXPECT_EQ(song->waveforms.size(), 2); // No duplicate DAT read.
        } else {
            EXPECT_EQ(song->analysisState, scenario == 4 ? RuntimeAnalysisState::Invalid : RuntimeAnalysisState::Missing);
            EXPECT_TRUE(song->beats.isEmpty());
            EXPECT_TRUE(song->waveforms.isEmpty());
        }
    }
}

TEST(RekordboxUsbSessionTest, SwappedSiblingDoesNotContaminateValidOwnerAndCorruptSiblingStaysPartial) {
    const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
    if (root.isEmpty()) { GTEST_SKIP() << "External fixture unavailable"; }
    QFile a(QDir(root).filePath("PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT"));
    QFile b(QDir(root).filePath("PIONEER/USBANLZ/P053/0001D21F/ANLZ0000.EXT"));
    ASSERT_TRUE(a.open(QIODevice::ReadOnly));
    ASSERT_TRUE(b.open(QIODevice::ReadOnly));
    const auto first = a.readAll();
    const auto second = b.readAll();
    const auto owner = readAnlz(first).exportedAudioPath.toUtf8();
    for (const auto& sibling : {second, QByteArray("corrupt")}) {
        QTemporaryDir volume;
        ASSERT_TRUE(write(pdb(volume), database({{0, track(1, owner)}})));
        ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.DAT"), first));
        ASSERT_TRUE(write(volume.filePath("PIONEER/USBANLZ/test.EXT"), sibling));
        RekordboxUsbSession session(volume.path());
        ASSERT_TRUE(session.load());
        const auto song = session.catalog()->findTrack(1);
        ASSERT_TRUE(song);
        EXPECT_EQ(song->analysisState, RuntimeAnalysisState::Partial);
        EXPECT_EQ(song->beats.size(), 368);
        EXPECT_EQ(song->waveforms.size(), 2); // Wrong-owner EXT contributes nothing.
        EXPECT_EQ(song->title, "Title");
    }
}
} // namespace

namespace {
// Waveform evidence: unmodified pyrekordbox export at the documented revision.
// Mutations below are negative/zero-length boundary cases, never cue fixtures.
class RekordboxLazyWaveformTest : public ::testing::Test {
  protected:
    QTemporaryDir volume;
    QByteArray original;
    QString analysisPath;
    std::unique_ptr<RekordboxUsbSession> session;

    void SetUp() override {
        const auto root = QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_REAL_FIXTURE"));
        if (root.isEmpty()) {
            GTEST_SKIP() << "External pyrekordbox export required";
        }
        QFile file(QDir(root).filePath("PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT"));
        ASSERT_TRUE(file.open(QIODevice::ReadOnly));
        original = file.readAll();
        const auto read = readAnlz(original);
        ASSERT_TRUE(read.containerValid);
        ASSERT_FALSE(read.waveforms.isEmpty());
        ASSERT_TRUE(write(pdb(volume), database({{0, track(1, read.exportedAudioPath.toUtf8())}})));
        analysisPath = volume.filePath("PIONEER/USBANLZ/test.DAT");
        ASSERT_TRUE(write(analysisPath, original));
        session = std::make_unique<RekordboxUsbSession>(volume.path());
    }

    RuntimeWaveform first() {
        return session->catalog()->findTrack(1)->waveforms.first();
    }
};

TEST_F(RekordboxLazyWaveformTest, MountRetainsOnlyDescriptorsAndCorrectOffsets) {
    ASSERT_TRUE(session->load());
    const auto song = session->catalog()->findTrack(1);
    ASSERT_TRUE(song);
    const auto inlineRead = readAnlz(original);
    ASSERT_EQ(song->waveforms.size(), inlineRead.waveforms.size());
    qint64 retainedBodyBytes = 0;
    qint64 declaredPayloadBytes = 0;
    for (int i = 0; i < song->waveforms.size(); ++i) {
        const auto& descriptor = song->waveforms[i];
        const auto& inlineWave = inlineRead.waveforms[i];
        EXPECT_TRUE(descriptor.payloadDeferred);
        EXPECT_FALSE(descriptor.samplesDecoded);
        EXPECT_TRUE(descriptor.bytes.isEmpty());
        EXPECT_EQ(descriptor.sourceAnalysisPath, QFileInfo(analysisPath).canonicalFilePath());
        EXPECT_EQ(descriptor.ownerTrackId, 1u);
        EXPECT_FALSE(descriptor.sessionId.isEmpty());
        EXPECT_EQ(descriptor.headerLength, inlineWave.payloadOffset + 12);
        EXPECT_EQ(descriptor.payloadOffset, inlineWave.payloadOffset);
        EXPECT_EQ(descriptor.sectionOffset, inlineWave.sectionOffset);
        EXPECT_EQ(descriptor.payloadLength, inlineWave.entryCount * *inlineWave.bytesPerEntry);
        EXPECT_EQ(original.mid(descriptor.sectionOffset, 4), descriptor.sectionTag);
        EXPECT_EQ(original.mid(descriptor.sectionOffset, descriptor.headerLength), descriptor.headerBytes);
        EXPECT_EQ(descriptor.headerBytes.size(), descriptor.headerLength);
        EXPECT_EQ(descriptor.sourceFingerprint, QCryptographicHash::hash(original, QCryptographicHash::Sha256));
        retainedBodyBytes += descriptor.bytes.size();
        declaredPayloadBytes += descriptor.payloadLength;
    }
    EXPECT_EQ(retainedBodyBytes, 0);
    EXPECT_GT(declaredPayloadBytes, 0);
    EXPECT_TRUE(session->catalog()->sealed());
}

TEST_F(RekordboxLazyWaveformTest, ExplicitLoadReturnsExactOwnedPayloadWithoutMutatingCatalog) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    QString error;
    const auto payload = session->loadWaveformPayload(descriptor, &error);
    ASSERT_TRUE(payload) << error.toStdString();
    EXPECT_TRUE(error.isEmpty());
    EXPECT_EQ(*payload, original.mid(descriptor.sectionOffset + descriptor.headerLength, descriptor.payloadLength));
    EXPECT_TRUE(first().bytes.isEmpty());
    session->invalidate();
    EXPECT_FALSE(session->loadWaveformPayload(descriptor));
    session.reset();
    EXPECT_EQ(payload->size(), descriptor.payloadLength); // Value outlives QFile/session.
    EXPECT_FALSE(descriptor.headerBytes.isEmpty());
}

TEST_F(RekordboxLazyWaveformTest, RejectsTruncatedSource) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    ASSERT_TRUE(write(analysisPath, original.left(original.size() - 1)));
    EXPECT_FALSE(session->loadWaveformPayload(descriptor));
}

TEST_F(RekordboxLazyWaveformTest, FingerprintRejectsSameSizeModificationWithRestoredMtime) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    const auto modified = QFileInfo(analysisPath).lastModified();
    auto changed = original;
    const int offset = descriptor.sectionOffset + descriptor.headerLength;
    changed[offset] = changed[offset] ^ 1;
    ASSERT_TRUE(write(analysisPath, changed));
    QFile file(analysisPath);
    ASSERT_TRUE(file.open(QIODevice::ReadWrite)); // Only the test mutates its temp copy.
    ASSERT_TRUE(file.setFileTime(modified, QFileDevice::FileModificationTime));
    file.close();
    EXPECT_FALSE(session->loadWaveformPayload(descriptor));
}

TEST_F(RekordboxLazyWaveformTest, RejectsForgedPathsOffsetsLengthsAndFingerprint) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    for (int scenario = 0; scenario < 7; ++scenario) {
        SCOPED_TRACE(scenario);
        auto forged = descriptor;
        switch (scenario) {
        case 0: forged.sourceAnalysisPath = "/etc/hosts"; break;
        case 1: ++forged.sectionOffset; break;
        case 2: forged.payloadLength = 0xffffffffu; break;
        case 3: ++forged.headerLength; break;
        case 4: ++forged.payloadOffset; break;
        case 5: forged.sourceFingerprint = QByteArray(32, '\0'); break;
        case 6: forged.ownerTrackId = 99; break;
        }
        EXPECT_FALSE(session->loadWaveformPayload(forged));
    }
}

TEST_F(RekordboxLazyWaveformTest, RejectsSourceReplacedWithOutOfRootSymlink) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    QTemporaryDir outside;
    const auto external = outside.filePath("same.DAT");
    ASSERT_TRUE(write(external, original));
    ASSERT_TRUE(QFile::remove(analysisPath));
    ASSERT_TRUE(QFile::link(external, analysisPath));
    EXPECT_FALSE(session->loadWaveformPayload(descriptor));
}

TEST_F(RekordboxLazyWaveformTest, RejectsDescriptorFromAnotherSessionOnSameVolume) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    RekordboxUsbSession other(volume.path());
    ASSERT_TRUE(other.load());
    EXPECT_FALSE(other.loadWaveformPayload(descriptor));
    EXPECT_TRUE(other.loadWaveformPayload(other.catalog()->findTrack(1)->waveforms.first()));
}

TEST_F(RekordboxLazyWaveformTest, EmptyPayloadIsSuccessNotFailure) {
    // Boundary mutation of real PWAV: count=0 and no payload, framing adjusted.
    const auto waveform = readAnlz(original).waveforms.first();
    ASSERT_EQ(waveform.sectionTag, "PWAV");
    auto changed = original;
    changed.remove(waveform.sectionOffset + waveform.headerLength, waveform.payloadLength);
    qToBigEndian<quint32>(0, changed.data() + waveform.sectionOffset + 12);
    qToBigEndian<quint32>(waveform.headerLength, changed.data() + waveform.sectionOffset + 8);
    qToBigEndian<quint32>(changed.size(), changed.data() + 8);
    ASSERT_TRUE(write(analysisPath, changed));
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    EXPECT_EQ(descriptor.payloadLength, 0u);
    EXPECT_EQ(descriptor.entryCount, 0);
    const auto payload = session->loadWaveformPayload(descriptor);
    ASSERT_TRUE(payload);
    EXPECT_TRUE(payload->isEmpty());
    EXPECT_FALSE(descriptor.samplesDecoded);
}

TEST_F(RekordboxLazyWaveformTest, UnknownWaveformPreservedRawWithoutInventingDecoder) {
    // Unknown FourCC negative case based on real waveform bytes.
    const auto waveform = readAnlz(original).waveforms.first();
    auto changed = original;
    changed.replace(waveform.sectionOffset, 4, "PWVX");
    ASSERT_TRUE(write(analysisPath, changed));
    ASSERT_TRUE(session->load());
    const auto song = session->catalog()->findTrack(1);
    ASSERT_TRUE(song);
    EXPECT_EQ(song->analysisState, RuntimeAnalysisState::Partial);
    bool found = false;
    for (const auto& raw : song->unmappedAnalysisSections) {
        if (raw.tag == "PWVX") {
            found = true;
            EXPECT_EQ(raw.bytes, changed.mid(waveform.sectionOffset, waveform.headerLength + waveform.payloadLength));
        }
    }
    EXPECT_TRUE(found);
    for (const auto& w : song->waveforms) {
        EXPECT_NE(w.sectionTag, "PWVX");
        EXPECT_FALSE(w.samplesDecoded);
        EXPECT_TRUE(w.bytes.isEmpty());
    }
}

TEST_F(RekordboxLazyWaveformTest, PdbChangeInvalidatesPayloadLoading) {
    ASSERT_TRUE(session->load());
    const auto descriptor = first();
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    EXPECT_FALSE(session->loadWaveformPayload(descriptor));
    EXPECT_EQ(session->state(), UsbSessionState::Invalidated);
}
} // namespace

TEST(RekordboxUsbSessionTest, RatingCommitChangesOneByteAndSurvivesReconnection) {
    QTemporaryDir volume;
    const auto original=database(rows());ASSERT_TRUE(write(pdb(volume),original));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"),"audio fixture"));
    const auto index=readDatabase(original,DatabaseKind::Main);
    qint64 ratingOffset=-1;for(const auto& row:index.rows) if(row.tableType==0) ratingOffset=row.offset+89;
    ASSERT_GE(ratingOffset,0);
    RekordboxUsbSession session(volume.path());ASSERT_TRUE(session.load());
    const auto before=session.catalog()->findTrack(1);ASSERT_TRUE(before);
    EXPECT_TRUE(session.writeRating(1,2).isEmpty());
    EXPECT_EQ(2u,session.catalog()->findTrack(1)->rating);
    EXPECT_EQ(inspectDevice(volume.path()).fingerprint,session.deviceSnapshot().fingerprint);
    QFile edited(pdb(volume));ASSERT_TRUE(edited.open(QIODevice::ReadOnly));
    const auto bytes=edited.readAll();edited.close();ASSERT_EQ(original.size(),bytes.size());
    for(int i=0;i<bytes.size();++i) EXPECT_EQ(i==ratingOffset?char(2):original.at(i),bytes.at(i))<<i;
    QFile backup(pdb(volume)+".nauticmixxx-rating-backup");ASSERT_TRUE(backup.open(QIODevice::ReadOnly));
    EXPECT_EQ(original,backup.readAll());
    EXPECT_EQ(before->cues.size(),session.catalog()->findTrack(1)->cues.size());
    EXPECT_TRUE(session.writeRating(1,5).isEmpty());
    session.invalidate();
    RekordboxUsbSession reconnected(volume.path());ASSERT_TRUE(reconnected.load());
    EXPECT_EQ(5u,reconnected.catalog()->findTrack(1)->rating);
    EXPECT_EQ(before->title,reconnected.catalog()->findTrack(1)->title);
    EXPECT_EQ(before->audioRelativePath,reconnected.catalog()->findTrack(1)->audioRelativePath);
}

TEST(RekordboxUsbSessionTest, RatingRejectsChangedExportRevocationAndInvalidValues) {
    QTemporaryDir volume;const auto original=database(rows());ASSERT_TRUE(write(pdb(volume),original));
    RekordboxUsbSession session(volume.path());ASSERT_TRUE(session.load());
    EXPECT_FALSE(session.writeRating(1,-1).isEmpty());EXPECT_FALSE(session.writeRating(1,6).isEmpty());
    EXPECT_FALSE(session.writeRating(999,3).isEmpty());
    auto replaced=original;replaced[20]=char(42);ASSERT_TRUE(write(pdb(volume),replaced));
    EXPECT_FALSE(session.writeRating(1,3).isEmpty());
    QFile bytes(pdb(volume));ASSERT_TRUE(bytes.open(QIODevice::ReadOnly));EXPECT_EQ(replaced,bytes.readAll());bytes.close();
    EXPECT_EQ(4u,session.catalog()->findTrack(1)->rating);
    session.invalidate();EXPECT_FALSE(session.writeRating(1,3).isEmpty());
}

TEST(RekordboxUsbSessionTest, RealExportRatingEditUsesOnlyAnIsolatedDatabaseCopy) {
    const auto root=qEnvironmentVariable("MIXXX_REKORDBOX_REAL_FIXTURE");
    if(root.isEmpty()) GTEST_SKIP()<<"Provide an external read-only export fixture";
    const auto original=readDatabaseFile(databasePath(root),DatabaseKind::Main);ASSERT_TRUE(original.valid());
    const auto tracks=readTrackIndex(original);ASSERT_FALSE(tracks.tracks.isEmpty());
    const auto track=tracks.tracks.first();const int previous=track.metadata.value("rating").toInt();
    QTemporaryDir copy;ASSERT_TRUE(write(pdb(copy),original.bytes));
    const auto snapshot=inspectDevice(copy.path());const auto rating=(previous+1)%6;
    QByteArray fingerprint;
    EXPECT_TRUE(writeUsbRating(snapshot,track.id,track.filePath,rating,&fingerprint).isEmpty());
    const auto edited=readDatabaseFile(pdb(copy),DatabaseKind::Main);ASSERT_TRUE(edited.valid());
    EXPECT_EQ(rating,readTrackIndex(edited).tracks.value(track.id).metadata.value("rating").toInt());
    int changes=0;for(int i=0;i<edited.bytes.size();++i) if(edited.bytes.at(i)!=original.bytes.at(i)) ++changes;
    EXPECT_EQ(1,changes);EXPECT_EQ(original.sequence,edited.sequence);
    EXPECT_EQ(original.bytes,readDatabaseFile(databasePath(root),DatabaseKind::Main).bytes);
    const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
    if(!output.isEmpty()) {ASSERT_TRUE(write(QDir(output).filePath("real-rating-original.pdb"),original.bytes));
        ASSERT_TRUE(write(QDir(output).filePath("real-rating-edited.pdb"),edited.bytes));}
}


TEST(RekordboxUsbSessionTest, PerformanceSaveReconnectAndChangedAnalysisProtection) {
    QTemporaryDir volume; ASSERT_TRUE(volume.isValid());
    ASSERT_TRUE(write(pdb(volume), database(rows())));
    const QString owner = "/Contents/test.mp3";
    const auto analysisPath = volume.filePath("PIONEER/USBANLZ/test.DAT");
    ASSERT_TRUE(write(analysisPath, syntheticCueAnlz(owner)));
    ASSERT_TRUE(QDir().mkpath(volume.filePath("Contents")));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "fake audio"));
    RekordboxUsbSession session(volume.path()); ASSERT_TRUE(session.load());
    const auto catalogTrack = session.catalog()->findTrack(1); ASSERT_TRUE(catalogTrack);
    PerformanceEdit edit; edit.trackId = 1; edit.binding = mixxx::SourceBinding::rekordboxUsb(1, session.sessionState());
    edit.cues = catalogTrack->cues; edit.cues[0].startMs = 1600; edit.cues[0].label = "Changed";
    edit.cues[3].activeLoop = true; edit.beats = {{100,1,12000},{600,2,12000},{1100,3,12000}};
    QFile originalDatabase(pdb(volume)); ASSERT_TRUE(originalDatabase.open(QIODevice::ReadOnly));
    const auto originalPdb = originalDatabase.readAll(); originalDatabase.close();
    ASSERT_TRUE(session.writePerformance(edit).isEmpty());
    QFile savedDatabase(pdb(volume)); ASSERT_TRUE(savedDatabase.open(QIODevice::ReadOnly));
    EXPECT_EQ(originalPdb, savedDatabase.readAll()); EXPECT_TRUE(QFile::exists(analysisPath + ".nauticmixxx-performance-backup"));
    RekordboxUsbSession reconnected(volume.path()); ASSERT_TRUE(reconnected.load());
    const auto saved = reconnected.catalog()->findTrack(1); ASSERT_TRUE(saved); ASSERT_EQ(4, saved->cues.size());
    EXPECT_EQ(1600, *saved->cues[0].startMs); EXPECT_EQ("Changed", saved->cues[0].label);
    EXPECT_TRUE(saved->cues[3].activeLoop); ASSERT_EQ(3, saved->beats.size()); EXPECT_EQ(100, saved->beats[0].timeMs);
    QFile savedAnalysis(analysisPath); ASSERT_TRUE(savedAnalysis.open(QIODevice::ReadOnly));
    const auto savedBytes = savedAnalysis.readAll(); savedAnalysis.close();
    ASSERT_TRUE(write(analysisPath, savedBytes + "changed"));
    EXPECT_FALSE(session.writePerformance(edit).isEmpty()); QFile changedAnalysis(analysisPath); ASSERT_TRUE(changedAnalysis.open(QIODevice::ReadOnly));
    EXPECT_EQ(savedBytes + "changed", changedAnalysis.readAll());
    edit.binding = mixxx::SourceBinding::rekordboxUsb(1, reconnected.sessionState());
    EXPECT_FALSE(session.writePerformance(edit).isEmpty());
    session.invalidate(); EXPECT_FALSE(session.writePerformance(edit).isEmpty());
}

#include "library/rekordbox/rekordboxplaylistwriter.h"
TEST(RekordboxUsbSessionTest, PlaylistAndHistoryAppendRetainTrackBytesAndReconnect) {
    QTemporaryDir volume; ASSERT_TRUE(write(pdb(volume), database(rows())));
    ASSERT_TRUE(write(volume.filePath("Contents/test.mp3"), "audio"));
    RekordboxUsbSession session(volume.path()); ASSERT_TRUE(session.load());
    const auto before = session.catalog()->findTrack(1); ASSERT_TRUE(before);
    ASSERT_TRUE(session.writeList(QString::fromUtf8("TAG selección"), {1,1}, false).isEmpty());
    ASSERT_TRUE(session.writeList("HISTORY 001", {1}, true).isEmpty());
    const auto oldSize=QFileInfo(pdb(volume)).size();
    ASSERT_TRUE(session.writeList("HISTORY 001", {1,1}, true).isEmpty());
    // Appending the next played track retains previous rows and allocates only one new page.
    EXPECT_LE(QFileInfo(pdb(volume)).size()-oldSize,2*4096);
    RekordboxUsbSession reconnect(volume.path()); ASSERT_TRUE(reconnect.load());
    const auto lists = reconnect.catalog()->playlists();
    const auto found = std::find_if(lists.cbegin(), lists.cend(), [](const auto& list) { return list.name == QString::fromUtf8("TAG selección"); });
    ASSERT_NE(found, lists.cend()); EXPECT_EQ(QList<quint32>({1,1}), found->trackIds);
    ASSERT_FALSE(reconnect.catalog()->histories().isEmpty());
    EXPECT_EQ(QList<quint32>({1,1}), reconnect.catalog()->histories().last().trackIds);
    EXPECT_EQ(1,reconnect.catalog()->histories().size());
    EXPECT_EQ(before->rawMetadata, reconnect.catalog()->findTrack(1)->rawMetadata);
    EXPECT_FALSE(session.writeList("bad", {999}, false).isEmpty());
    EXPECT_FALSE(session.writeList("", {1}, true).isEmpty());
}

TEST(RekordboxUsbSessionTest, RealExportPlaylistAndHistoryEditsUseOnlyAnIsolatedCopy) {
    const auto root=qEnvironmentVariable("MIXXX_REKORDBOX_REAL_FIXTURE");
    if(root.isEmpty()) GTEST_SKIP()<<"Provide an external read-only export fixture";
    const auto original=readDatabaseFile(databasePath(root),DatabaseKind::Main);ASSERT_TRUE(original.valid());
    const auto tracks=readTrackIndex(original);ASSERT_GE(tracks.tracks.size(),2);
    const QList<quint32> ids{tracks.tracks.first().id,tracks.tracks.last().id};
    QTemporaryDir copy;ASSERT_TRUE(write(pdb(copy),original.bytes));
    auto expected=inspectDevice(copy.path());quint32 id=0;
    ASSERT_TRUE(writeUsbList(&expected,"Nautic isolated playlist test",ids,false,&id).isEmpty());
    ASSERT_NE(0u,id);
    ASSERT_TRUE(writeUsbList(&expected,"Nautic isolated history test",ids.mid(0,1),true,&id).isEmpty());
    ASSERT_TRUE(writeUsbList(&expected,"Nautic isolated history test",ids,true,&id).isEmpty());
    const auto edited=readDatabaseFile(pdb(copy),DatabaseKind::Main);ASSERT_TRUE(edited.valid());
    const auto editedTracks=readTrackIndex(edited);ASSERT_EQ(tracks.tracks.size(),editedTracks.tracks.size());
    for(const auto& track:tracks.tracks) EXPECT_EQ(track.metadata,editedTracks.tracks.value(track.id).metadata);
    EXPECT_EQ(ids,readHistoryIndex(edited).histories.last().trackIds);
    EXPECT_EQ(original.bytes,readDatabaseFile(databasePath(root),DatabaseKind::Main).bytes);
}

TEST(RekordboxUsbSessionTest, DifferentMountedDeviceIdentityRefusesUsbWrites) {
    QTemporaryDir volume;const auto original=database(rows());ASSERT_TRUE(write(pdb(volume),original));
    auto wrong=inspectDevice(volume.path());ASSERT_EQ(DeviceState::Readable,wrong.state);
    ASSERT_FALSE(wrong.mountIdentity.isEmpty());wrong.mountIdentity.append("different mounted device");
    EXPECT_FALSE(inspectDevice(volume.path()).matches(wrong));
    quint32 id=0;EXPECT_FALSE(writeUsbList(&wrong,"Must not be written",{1},false,&id).isEmpty());
    EXPECT_EQ(original,readDatabaseFile(pdb(volume),DatabaseKind::Main).bytes);
}

TEST_F(RekordboxUsbSessionAudioTest, OptionalRealExportPerformanceMetadataSurvivesLoad) {
    const auto root=qEnvironmentVariable("MIXXX_REKORDBOX_REAL_FIXTURE");
    if(root.isEmpty()) GTEST_SKIP()<<"Set a read-only copied Rekordbox export";
    RekordboxUsbSession session(root);
    ASSERT_TRUE(session.load())<<session.error().toStdString();
    int loaded=0,grids=0,keys=0,hotCues=0;
    QJsonArray report;
    for(const auto& runtime:session.catalog()->tracks()) {
        if(!QFileInfo::exists(runtime.resolvedAudioPath)) continue;
        SCOPED_TRACE(runtime.title.toStdString());
        auto projected=session.createTemporaryTrack(runtime.rekordboxId);
        ASSERT_TRUE(projected);
        SoundSourceProxy proxy(projected);
        auto audio=proxy.openAudioSource();ASSERT_TRUE(audio);
        ++loaded;
        if(runtime.beats.size()>=2) {++grids;EXPECT_TRUE(projected->getBeats());}
        if(KeyUtils::guessKeyFromText(runtime.key)!=mixxx::track::io::key::INVALID) {
            ++keys;EXPECT_EQ(projected->getKey(),KeyUtils::guessKeyFromText(runtime.key));
        }
        const auto cues=projected->getCuePoints();
        int trackHotCues=0;
        for(const auto& cue:runtime.cues) {
            if(cue.kind!=RuntimeCue::Kind::HotCue && cue.kind!=RuntimeCue::Kind::HotLoop) continue;
            ++hotCues;++trackHotCues;
            EXPECT_TRUE(std::any_of(cues.cbegin(),cues.cend(),[&](const auto& value){
                return value->getHotCue()==cue.hotcueIndex-1 && value->getPosition().isValid();
            }));
        }
        report.append(QJsonObject{{"title",runtime.title},{"export_key",runtime.key},
                {"loaded_key",projected->getKeyText()},{"grid_beats",runtime.beats.size()},
                {"hot_cues",trackHotCues}});
        audio->close();
    }
    EXPECT_GT(loaded,0);RecordProperty("loaded_tracks",loaded);
    RecordProperty("grids",grids);RecordProperty("keys",keys);RecordProperty("hot_cues",hotCues);
    const auto output=qEnvironmentVariable("CRANIUM_EXPORT_PROJECTION_REPORT");
    if(!output.isEmpty()) {QFile file(output);ASSERT_TRUE(file.open(QIODevice::WriteOnly));file.write(QJsonDocument(report).toJson());}
}
