#include <gtest/gtest.h>

#include <QtEndian>
#include <iostream>

#include "library/rekordbox/rekordboxdatabase.h"

namespace {
using namespace mixxx::rekordbox;
constexpr int kPage = 512;
void put32(QByteArray* bytes, int offset, quint32 value) {
    qToLittleEndian(value, bytes->data() + offset);
}
void put16(QByteArray* bytes, int offset, quint16 value) {
    qToLittleEndian(value, bytes->data() + offset);
}
QByteArray database() {
    QByteArray bytes(kPage * 3, '\0');
    put32(&bytes, 4, kPage);
    put32(&bytes, 8, 1);
    put32(&bytes, 20, 7);
    put32(&bytes, 28, 7); // Playlist tree.
    put32(&bytes, 36, 1);
    put32(&bytes, 40, 2);
    for (quint32 page = 1; page <= 2; ++page) {
        put32(&bytes, page * kPage + 4, page);
        put32(&bytes, page * kPage + 8, 7);
    }
    put32(&bytes, kPage + 12, 2);
    bytes[kPage + 27] = 0x40; // Index/non-data page.
    put16(&bytes, kPage * 2 + 24, 2);
    put16(&bytes, kPage * 3 - 4, 3); // Two live rows.
    put16(&bytes, kPage * 3 - 6, 0);
    put16(&bytes, kPage * 3 - 8, 64);
    return bytes;
}

TEST(RekordboxDatabaseTest, ReadsBoundedRowsAndSequence) {
    const auto result = readDatabase(database(), DatabaseKind::Main);
    ASSERT_TRUE(result.valid()) << result.error.toStdString();
    EXPECT_EQ(result.pageSize, kPage);
    EXPECT_EQ(result.sequence, 7);
    ASSERT_EQ(result.rows.size(), 2);
    EXPECT_EQ(result.rows.at(0).offset, 2 * kPage + 40);
    EXPECT_EQ(result.rows.at(0).size, 64);
    EXPECT_EQ(result.rows.at(1).size, kPage - 36 - 104);
}

TEST(RekordboxDatabaseTest, RejectsTruncatedAndOversizedHeaders) {
    auto bytes = database();
    for (int size : {0, 1, 27, 100, 513}) {
        EXPECT_FALSE(readDatabase(bytes.left(size), DatabaseKind::Main).valid());
    }
    put32(&bytes, 8, 0xffffffff);
    EXPECT_FALSE(readDatabase(bytes, DatabaseKind::Main).valid());
    bytes = database();
    put32(&bytes, 4, 0);
    EXPECT_FALSE(readDatabase(bytes, DatabaseKind::Main).valid());
}

TEST(RekordboxDatabaseTest, RejectsCyclicPageChain) {
    auto bytes = database();
    put32(&bytes, kPage + 12, 1);
    const auto result = readDatabase(bytes, DatabaseKind::Main);
    EXPECT_FALSE(result.valid());
    EXPECT_TRUE(result.error.contains("Cyclic"));
    EXPECT_TRUE(result.rows.isEmpty());
}

TEST(RekordboxDatabaseTest, RejectsFullWidthOutOfRangeReferences) {
    auto bytes = database();
    put32(&bytes, 40, 0x10002); // Must not truncate to 16 bits.
    EXPECT_FALSE(readDatabase(bytes, DatabaseKind::Main).valid());
    bytes = database();
    put32(&bytes, kPage + 12, 0xffffffff);
    EXPECT_FALSE(readDatabase(bytes, DatabaseKind::Main).valid());
}

TEST(RekordboxDatabaseTest, RejectsLiveRowsInFooterAndDuplicateOffsets) {
    auto bytes = database();
    put16(&bytes, kPage * 3 - 8, kPage - 40);
    EXPECT_FALSE(readDatabase(bytes, DatabaseKind::Main).valid());
    put16(&bytes, kPage * 3 - 8, 0);
    EXPECT_FALSE(readDatabase(bytes, DatabaseKind::Main).valid());
}

TEST(RekordboxDatabaseTest, IgnoresDeletedRowBytesAndOffsets) {
    auto bytes = database();
    put16(&bytes, kPage * 3 - 4, 1);
    put16(&bytes, kPage * 3 - 8, 0xffff);
    const auto result = readDatabase(bytes, DatabaseKind::Main);
    ASSERT_TRUE(result.valid());
    EXPECT_EQ(result.rows.size(), 1);
}

TEST(RekordboxDatabaseTest, StopsAtNextTableWithoutCastingItsRows) {
    auto bytes = database();
    put32(&bytes, 2 * kPage + 8, 8);
    const auto result = readDatabase(bytes, DatabaseKind::Main);
    ASSERT_TRUE(result.valid());
    EXPECT_TRUE(result.rows.isEmpty());
    EXPECT_EQ(result.diagnostics.size(), 1);
}

TEST(RekordboxDatabaseTest, KeepsExtendedTableIdentityAndUnknownRows) {
    auto bytes = database();
    put32(&bytes, 28, 3); // Tags in exportExt, albums in main PDB.
    put32(&bytes, kPage + 8, 3);
    put32(&bytes, 2 * kPage + 8, 3);
    const auto result = readDatabase(bytes, DatabaseKind::Extended);
    ASSERT_TRUE(result.valid());
    EXPECT_EQ(result.kind, DatabaseKind::Extended);
    ASSERT_EQ(result.rows.size(), 2);
    EXPECT_EQ(result.rows.at(0).tableType, 3);
    EXPECT_EQ(result.bytes, bytes);
}

TEST(RekordboxDatabaseTest, ReadsExportedBrowseOrderAndSpecialVisibility) {
    DatabaseDocument document;
    document.kind = DatabaseKind::Main;
    document.pageSize = 512;
    document.bytes = QByteArray(256, '\0');
    const auto descriptor = [&](int offset, quint16 id, const QByteArray& name) {
        put16(&document.bytes, offset, id);
        document.bytes[offset + 4] = static_cast<char>(name.size() * 2 + 3);
        document.bytes.replace(offset + 5, name.size(), name);
        document.rows.append({16, 1, static_cast<quint32>(document.rows.size()),
                offset, name.size() + 5});
    };
    descriptor(0, 4, "TRACK");
    descriptor(24, 17, "PLAYLIST");
    descriptor(48, 27, "MATCHING");
    const auto entry = [&](int offset, quint16 id, quint8 visibility, quint16 position) {
        put16(&document.bytes, offset, id);
        document.bytes[offset + 5] = static_cast<char>(visibility);
        put16(&document.bytes, offset + 6, position);
        document.rows.append({17, 2, static_cast<quint32>(document.rows.size()), offset, 8});
    };
    entry(80, 4, 0, 2);
    entry(88, 17, 0, 1);
    entry(96, 27, 2, 3);
    entry(104, 7, 1, 0); // Hidden.
    entry(112, 999, 0, 4); // Unknown descriptor cannot become a category.
    const auto menu = readBrowseMenu(document);
    EXPECT_TRUE(menu.fromExport);
    ASSERT_EQ(menu.categories.size(), 3);
    EXPECT_EQ(menu.categories.at(0).label, "PLAYLIST");
    EXPECT_EQ(menu.categories.at(1).label, "TRACK");
    EXPECT_EQ(menu.categories.at(2).label, "MATCHING");
    EXPECT_EQ(menu.categories.at(2).visibility, 2);
    EXPECT_FALSE(menu.diagnostics.isEmpty());
}

TEST(RekordboxDatabaseTest, ReadsHistoryEntriesInExportedOrder) {
    DatabaseDocument document;
    document.kind = DatabaseKind::Main;
    document.pageSize = 512;
    document.bytes = QByteArray(128, '\0');
    put32(&document.bytes, 0, 20);
    document.bytes[4] = 13;
    document.bytes.replace(5, 5, "Set 1");
    document.rows.append({11, 1, 0, 0, 10});
    put32(&document.bytes, 32, 4);
    put32(&document.bytes, 36, 20);
    put32(&document.bytes, 40, 2);
    document.rows.append({12, 2, 0, 32, 12});
    put32(&document.bytes, 48, 9);
    put32(&document.bytes, 52, 20);
    put32(&document.bytes, 56, 1);
    document.rows.append({12, 2, 1, 48, 12});
    const auto index = readHistoryIndex(document);
    ASSERT_EQ(index.histories.size(), 1);
    EXPECT_EQ(index.histories.first().name, "Set 1");
    EXPECT_EQ(index.histories.first().trackIds, (QList<quint32>{9, 4}));
}

TEST(RekordboxDatabaseTest, ReadsMountedExportMenuWhenProvided) {
    const QString path = qEnvironmentVariable("NAUTIC_REKORDBOX_PDB");
    if (path.isEmpty()) GTEST_SKIP() << "Set NAUTIC_REKORDBOX_PDB for read-only USB QA";
    const auto document = readDatabaseFile(path, DatabaseKind::Main);
    ASSERT_TRUE(document.valid()) << document.error.toStdString();
    const auto menu = readBrowseMenu(document);
    ASSERT_TRUE(menu.fromExport);
    ASSERT_FALSE(menu.categories.isEmpty());
    quint16 lastPosition = 0;
    for (const auto& category : menu.categories) {
        EXPECT_GT(category.position, lastPosition);
        EXPECT_FALSE(category.label.isEmpty());
        lastPosition = category.position;
        std::cout << category.position << " " << category.label.toStdString() << "\n";
    }
}
} // namespace

namespace {
QByteArray playlistDatabase() {
    auto bytes = database();
    const int first = kPage * 2 + 40;
    const int second = first + 64;
    put32(&bytes, first + 8, 2);
    put32(&bytes, first + 12, 10);
    bytes[first + 20] = 13; // Five-byte short UTF-8 name.
    bytes.replace(first + 21, 5, "House");
    put32(&bytes, second + 8, 19); // Sparse sorting positions are legitimate.
    put32(&bytes, second + 12, 42);
    bytes[second + 20] = 13;
    bytes.replace(second + 21, 5, "House"); // Same label, different identity.
    return bytes;
}

TEST(RekordboxPlaylistTest, PreservesSparseOrderAndDuplicateLabels) {
    const auto index = readPlaylistIndex(readDatabase(playlistDatabase(), DatabaseKind::Main));
    ASSERT_TRUE(index.error.isEmpty()) << index.error.toStdString();
    ASSERT_EQ(index.playlists.size(), 2);
    EXPECT_EQ(index.playlists.value(10).sortOrder, 2);
    EXPECT_EQ(index.playlists.value(42).sortOrder, 19);
    EXPECT_EQ(index.playlists.value(10).name, index.playlists.value(42).name);
}

TEST(RekordboxPlaylistTest, RejectsDisconnectedFolderCycles) {
    auto bytes = playlistDatabase();
    put32(&bytes, kPage * 2 + 40, 42);
    put32(&bytes, kPage * 2 + 104, 10);
    const auto index = readPlaylistIndex(readDatabase(bytes, DatabaseKind::Main));
    EXPECT_TRUE(index.error.contains("Cyclic"));
    EXPECT_TRUE(index.playlists.isEmpty());
}

TEST(RekordboxPlaylistTest, RejectsStringThatCrossesAnotherRow) {
    auto bytes = playlistDatabase();
    bytes[kPage * 2 + 60] = 0x7f; // Declares 62 bytes, crossing the next row.
    const auto index = readPlaylistIndex(readDatabase(bytes, DatabaseKind::Main));
    EXPECT_TRUE(index.error.contains("exceeds"));
}

TEST(RekordboxPlaylistTest, ExtendedDatabaseIsNotAMainPlaylistIndex) {
    const auto index = readPlaylistIndex(readDatabase(playlistDatabase(), DatabaseKind::Extended));
    EXPECT_FALSE(index.error.isEmpty());
}
} // namespace

namespace {
TEST(RekordboxDatabaseTest, PreservesPageIndexesAbove65535) {
    auto bytes = database();
    const auto page = bytes.mid(2 * kPage, kPage);
    constexpr quint32 highIndex = 65537;
    bytes.resize((highIndex + 1) * kPage);
    bytes.replace(highIndex * kPage, kPage, page);
    put32(&bytes, 36, highIndex);
    put32(&bytes, 40, highIndex);
    put32(&bytes, highIndex * kPage + 4, highIndex);
    const auto result = readDatabase(bytes, DatabaseKind::Main);
    ASSERT_TRUE(result.valid()) << result.error.toStdString();
    ASSERT_EQ(result.rows.size(), 2);
    EXPECT_EQ(result.rows.constFirst().pageIndex, highIndex);
}

TEST(RekordboxPlaylistTest, DecodesUnicodePlaylistName) {
    auto bytes = playlistDatabase();
    const int start = 2 * kPage + 60;
    const QString expected = QString::fromUtf8("Música");
    bytes[start] = static_cast<char>(0x90);
    put16(&bytes, start + 1, 4 + expected.size() * 2);
    bytes[start + 3] = 0;
    for (int i = 0; i < expected.size(); ++i) {
        put16(&bytes, start + 4 + i * 2, expected.at(i).unicode());
    }
    const auto index = readPlaylistIndex(readDatabase(bytes, DatabaseKind::Main));
    ASSERT_TRUE(index.error.isEmpty()) << index.error.toStdString();
    EXPECT_EQ(index.playlists.value(10).name, expected);
}

TEST(RekordboxPlaylistTest, PreservesSparseTrackPositionsWithMissingPlaylistDiagnostic) {
    auto bytes = database();
    for (int offset : {28, kPage + 8, 2 * kPage + 8}) {
        put32(&bytes, offset, 8);
    }
    const int first = 2 * kPage + 40;
    const int second = first + 64;
    put32(&bytes, first, 7);
    put32(&bytes, first + 4, 100);
    put32(&bytes, first + 8, 42);
    put32(&bytes, second, 31);
    put32(&bytes, second + 4, 101);
    put32(&bytes, second + 8, 42);
    const auto index = readPlaylistIndex(readDatabase(bytes, DatabaseKind::Main));
    ASSERT_TRUE(index.error.isEmpty());
    EXPECT_EQ(index.tracks.value(42).value(7), 100);
    EXPECT_EQ(index.tracks.value(42).value(31), 101);
    EXPECT_EQ(index.diagnostics.size(), 1);
}
} // namespace

namespace {
TEST(RekordboxPlaylistTest, PreservesSiblingSortTiesWithDiagnostic) {
    auto bytes = playlistDatabase();
    put32(&bytes, 2 * kPage + 104 + 8, 2);
    const auto index = readPlaylistIndex(readDatabase(bytes, DatabaseKind::Main));
    EXPECT_TRUE(index.error.isEmpty());
    EXPECT_EQ(index.playlists.size(), 2);
    EXPECT_EQ(index.diagnostics.size(), 1);
}
} // namespace

namespace {
QByteArray shortText(const QByteArray& text) {
    return QByteArray(1, static_cast<char>((text.size() + 1) * 2 + 1)) + text;
}
QByteArray wideText(const QString& text) {
    QByteArray bytes(4 + text.size() * 2, '\0');
    bytes[0] = static_cast<char>(0x90);
    put16(&bytes, 1, bytes.size());
    for (int i = 0; i < text.size(); ++i) put16(&bytes, 4 + i * 2, text.at(i).unicode());
    return bytes;
}
QByteArray metadataTrack() {
    QByteArray row(136, '\0');
    put16(&row, 0, 0x24);
    put32(&row, 8, 48000);
    put32(&row, 32, 9); // Key table identity.
    put32(&row, 52, 12);
    put32(&row, 56, 12843);
    put32(&row, 72, 0xf0000042); // Must not narrow to signed 32-bit.
    put16(&row, 80, 2025);
    put16(&row, 84, 321);
    row[89] = 4;
    for (int i = 0; i < 21; ++i) {
        put16(&row, 94 + i * 2, row.size());
        switch (i) {
        case 0: {
            QByteArray isrc(4, '\0');
            isrc[0] = static_cast<char>(0x90);
            isrc += QByteArray(1, 3) + "GBABC2500001" + QByteArray(1, '\0');
            put16(&isrc, 1, isrc.size());
            row += isrc;
            break;
        }
        case 12: row += shortText("Extended mix"); break;
        case 14: row += shortText("/PIONEER/USBANLZ/001/ANLZ0000.DAT"); break;
        case 16: row += wideText(QString::fromUtf8("Entrada fría 🎵")); break;
        case 17: row += wideText(QString::fromUtf8("Música 東京")); break;
        case 20: row += wideText(QString::fromUtf8("/Contents/Música 東京.flac")); break;
        default: row += shortText(""); break;
        }
    }
    return row;
}
// Each row occupies a separate page, through the real structural validator.
QByteArray metadataDatabase(const QList<QPair<quint32, QByteArray>>& rows) {
    constexpr int pageSize = 1024;
    QByteArray bytes(pageSize * (rows.size() + 1), '\0');
    put32(&bytes, 4, pageSize);
    put32(&bytes, 8, rows.size());
    for (int i = 0; i < rows.size(); ++i) {
        const auto page = i + 1;
        const auto start = page * pageSize;
        put32(&bytes, 28 + i * 16, rows.at(i).first);
        put32(&bytes, 36 + i * 16, page);
        put32(&bytes, 40 + i * 16, page);
        put32(&bytes, start + 4, page);
        put32(&bytes, start + 8, rows.at(i).first);
        put16(&bytes, start + 24, 1);
        put16(&bytes, start + pageSize - 4, 1);
        bytes.replace(start + 40, rows.at(i).second.size(), rows.at(i).second);
    }
    return bytes;
}
TrackIndex tracksFromRows(const QList<QPair<quint32, QByteArray>>& rows) {
    return readTrackIndex(readDatabase(metadataDatabase(rows), DatabaseKind::Main));
}
TEST(RekordboxMetadataTest, PreservesUnicodeIsrcPrecisionAndOriginalFields) {
    QByteArray key(8, '\0');
    put32(&key, 0, 9);
    key += shortText("8A");
    const auto index = tracksFromRows({{0, metadataTrack()}, {5, key}});
    ASSERT_TRUE(index.error.isEmpty());
    ASSERT_EQ(index.tracks.size(), 1);
    const auto& track = index.tracks.first();
    EXPECT_EQ(track.id, 0xf0000042);
    EXPECT_EQ(track.filePath, QString::fromUtf8("/Contents/Música 東京.flac"));
    EXPECT_EQ(track.analysisPath, "/PIONEER/USBANLZ/001/ANLZ0000.DAT");
    EXPECT_EQ(track.metadata.value("isrc").toString(), "GBABC2500001");
    EXPECT_EQ(track.metadata.value("title").toString(), QString::fromUtf8("Música 東京"));
    EXPECT_EQ(track.metadata.value("comment").toString(), QString::fromUtf8("Entrada fría 🎵"));
    EXPECT_DOUBLE_EQ(track.metadata.value("bpm").toDouble(), 128.43);
    EXPECT_EQ(track.metadata.value("tempo_hundredths").toInt(), 12843);
    EXPECT_EQ(track.metadata.value("sample_rate").toInt(), 48000);
    EXPECT_EQ(track.metadata.value("key").toString(), "8A");
    EXPECT_EQ(track.metadata.value("mix_name").toString(), "Extended mix");
    EXPECT_TRUE(index.diagnostics.isEmpty());
}
TEST(RekordboxMetadataTest, RejectsOverflowingOptionalStringWithoutLosingTrack) {
    auto row = metadataTrack();
    const auto offset = qFromLittleEndian<quint16>(row.constData() + 94 + 17 * 2);
    put16(&row, offset + 1, 0xffff);
    const auto index = tracksFromRows({{0, row}});
    ASSERT_EQ(index.tracks.size(), 1);
    EXPECT_FALSE(index.tracks.first().metadata.contains("title"));
    EXPECT_TRUE(index.tracks.first().metadata.contains("title_raw"));
    EXPECT_FALSE(index.diagnostics.isEmpty());
}
TEST(RekordboxMetadataTest, RejectsIsrcWithoutTerminatorInsideDeclaredLength) {
    auto row = metadataTrack();
    const auto offset = qFromLittleEndian<quint16>(row.constData() + 94);
    const auto length = qFromLittleEndian<quint16>(row.constData() + offset + 1);
    row[offset + length - 1] = 'X';
    const auto index = tracksFromRows({{0, row}});
    ASSERT_EQ(index.tracks.size(), 1);
    EXPECT_FALSE(index.tracks.first().metadata.contains("isrc"));
    EXPECT_TRUE(index.tracks.first().metadata.contains("isrc_raw"));
}
TEST(RekordboxMetadataTest, MissingKeyAndInvalidTempoRemainExplicit) {
    auto row = metadataTrack();
    put32(&row, 56, 0xffffffff);
    const auto index = tracksFromRows({{0, row}});
    ASSERT_EQ(index.tracks.size(), 1);
    const auto metadata = index.tracks.first().metadata;
    EXPECT_FALSE(metadata.contains("bpm"));
    EXPECT_DOUBLE_EQ(metadata.value("tempo_hundredths").toDouble(), 4294967295.0);
    EXPECT_TRUE(metadata.value("key").toString().isEmpty());
    EXPECT_GE(index.diagnostics.size(), 2);
}
TEST(RekordboxMetadataTest, BadAudioPathStringDoesNotDiscardOtherRows) {
    auto bad = metadataTrack();
    put16(&bad, 94 + 20 * 2, 0xffff);
    auto good = metadataTrack();
    put32(&good, 72, 99);
    const auto index = tracksFromRows({{0, bad}, {0, good}});
    ASSERT_EQ(index.tracks.size(), 1);
    EXPECT_TRUE(index.tracks.contains(99));
    EXPECT_FALSE(index.diagnostics.isEmpty());
}
TEST(RekordboxMetadataTest, ResolvesNearAndFarArtistNames) {
    QByteArray nearArtistRow(10, '\0');
    put32(&nearArtistRow, 4, 5);
    nearArtistRow[9] = 10;
    nearArtistRow += shortText("Artist");
    QByteArray farArtistRow(12, '\0');
    put16(&farArtistRow, 0, 100);
    put32(&farArtistRow, 4, 7);
    put16(&farArtistRow, 10, 12);
    farArtistRow += wideText(QString::fromUtf8("Compositor ñ"));
    auto row = metadataTrack();
    put32(&row, 68, 5);
    put32(&row, 12, 7);
    const auto index = tracksFromRows({{0, row}, {2, nearArtistRow}, {2, farArtistRow}});
    ASSERT_EQ(index.tracks.size(), 1);
    EXPECT_EQ(index.tracks.first().metadata.value("artist").toString(), "Artist");
    EXPECT_EQ(index.tracks.first().metadata.value("composer").toString(), QString::fromUtf8("Compositor ñ"));
}
TEST(RekordboxMetadataTest, DoesNotInterpretExtendedTagsAsAlbums) {
    const auto document = readDatabase(metadataDatabase({{0, metadataTrack()}}), DatabaseKind::Extended);
    const auto index = readTrackIndex(document);
    EXPECT_FALSE(index.error.isEmpty());
    EXPECT_TRUE(index.tracks.isEmpty());
}
} // namespace
