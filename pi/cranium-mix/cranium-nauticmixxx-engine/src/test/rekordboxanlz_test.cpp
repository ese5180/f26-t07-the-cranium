#include <gtest/gtest.h>

#include "library/rekordbox/rekordboxanlzreader.h"
#include "library/rekordbox/rekordboxdatabase.h"

#include "rekordbox_anlz.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QCryptographicHash>
#include <QSet>
#include <QtEndian>

#include <memory>
#include <string>
#include <vector>

namespace {
const char* kSweepFixture =
        "/tmp/mixxx-audit-20260917/repos/rekordcrate/data/anlz/sweep/ANLZ0000.DAT";
const char* kFixture =
        "/tmp/mixxx-audit-20260917/repos/pyrekordbox/.testdata/export/PIONEER/"
        "USBANLZ/P016/0000875E/ANLZ0000.DAT";
// Own the stream for as long as any generated object may reference it.
struct ParsedFixture {
    kaitai::kstream stream;
    rekordbox_anlz_t document;
    explicit ParsedFixture(const QByteArray& bytes)
            : stream(bytes.toStdString()), document(&stream) {}
};
std::unique_ptr<ParsedFixture> parse(const QByteArray& bytes) {
    return std::make_unique<ParsedFixture>(bytes);
}

void putBe16(QByteArray* bytes, qsizetype offset, quint16 value) {
    qToBigEndian(value, bytes->data() + offset);
}

void putBe32(QByteArray* bytes, qsizetype offset, quint32 value) {
    qToBigEndian(value, bytes->data() + offset);
}

QByteArray cueComment(const QString& value) {
    if (value.isEmpty()) {
        return {};
    }
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

QByteArray pcpt(quint32 hotCue, quint8 type, quint32 startMs, quint32 endMs) {
    QByteArray entry(56, '\0');
    entry.replace(0, 4, "PCPT");
    putBe32(&entry, 4, 28);
    putBe32(&entry, 8, entry.size());
    putBe32(&entry, 12, hotCue);
    putBe32(&entry, 16, 0); // inactive/ordinary cue
    putBe32(&entry, 20, 0x00010000);
    putBe16(&entry, 24, 0xffff);
    putBe16(&entry, 26, 0xffff);
    entry[28] = static_cast<char>(type);
    putBe16(&entry, 30, 1000);
    putBe32(&entry, 32, startMs);
    putBe32(&entry, 36, endMs);
    return entry;
}

QByteArray pcp2(quint32 hotCue,
        quint8 type,
        quint32 startMs,
        quint32 endMs,
        const QString& label,
        quint8 red,
        quint8 green,
        quint8 blue) {
    const auto comment = cueComment(label);
    QByteArray entry(48 + comment.size(), '\0');
    entry.replace(0, 4, "PCP2");
    putBe32(&entry, 4, 16);
    putBe32(&entry, 8, entry.size());
    putBe32(&entry, 12, hotCue);
    entry[16] = static_cast<char>(type);
    putBe16(&entry, 18, 1000);
    putBe32(&entry, 20, startMs);
    putBe32(&entry, 24, endMs);
    putBe32(&entry, 40, comment.size());
    entry.replace(44, comment.size(), comment);
    const auto color = 44 + comment.size();
    entry[color] = 1; // Palette lookup byte is preserved structurally, not mapped.
    entry[color + 1] = static_cast<char>(red);
    entry[color + 2] = static_cast<char>(green);
    entry[color + 3] = static_cast<char>(blue);
    return entry;
}

QByteArray cueList(bool extended,
        quint32 listType,
        const QList<QByteArray>& entries) {
    const auto header = extended ? 20 : 24;
    QByteArray section(header, '\0');
    section.replace(0, 4, extended ? "PCO2" : "PCOB");
    putBe32(&section, 4, header);
    putBe32(&section, 12, listType);
    putBe16(&section, extended ? 16 : 18, entries.size());
    for (const auto& entry : entries) {
        section.append(entry);
    }
    putBe32(&section, 8, section.size());
    return section;
}

QByteArray anlzWith(const QList<QByteArray>& sections) {
    QByteArray bytes(28, '\0');
    bytes.replace(0, 4, "PMAI");
    putBe32(&bytes, 4, 28);
    for (const auto& section : sections) {
        bytes.append(section);
    }
    putBe32(&bytes, 8, bytes.size());
    return bytes;
}
} // namespace

TEST(RekordboxAnlzDiscoveryTest, ParsesExternalRekordboxSweepFixture) {
    QFile file(QString::fromLatin1(kSweepFixture));
    if (!file.exists()) { GTEST_SKIP() << "External rekordcrate sweep fixture unavailable"; }
    ASSERT_TRUE(file.open(QIODevice::ReadOnly)) << file.errorString().toStdString();
    const auto bytes = file.readAll();
    ASSERT_FALSE(bytes.isEmpty());
    auto anlz = parse(bytes);
    ASSERT_TRUE(anlz);
    EXPECT_FALSE(anlz->document.sections()->empty());
}

TEST(RekordboxAnlzDiscoveryTest, ParsesExternalBeatGridWithoutMixingMetadata) {
    QFile file(QString::fromLatin1(kFixture));
    if (!file.exists()) { GTEST_SKIP() << "External pyrekordbox fixture unavailable"; }
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    auto anlz = parse(file.readAll());
    ASSERT_TRUE(anlz);
    const auto section = std::find_if(anlz->document.sections()->begin(), anlz->document.sections()->end(),
            [](const auto& section) {
                return section->fourcc() == rekordbox_anlz_t::SECTION_TAGS_BEAT_GRID;
            });
    ASSERT_NE(section, anlz->document.sections()->end());
    auto* beatGrid = static_cast<rekordbox_anlz_t::beat_grid_tag_t*>((*section)->body());
    ASSERT_NE(beatGrid, nullptr);
    EXPECT_EQ(beatGrid->num_beats(), 368u);
    ASSERT_FALSE(beatGrid->beats()->empty());
    EXPECT_EQ(beatGrid->beats()->front()->beat_number(), 1u);
    EXPECT_EQ(beatGrid->beats()->front()->tempo(), 12800u);
    EXPECT_EQ(beatGrid->beats()->front()->time(), 25u);
    EXPECT_EQ(beatGrid->beats()->at(1)->beat_number(), 2u);
    EXPECT_EQ(beatGrid->beats()->at(1)->time(), 494u);
}

TEST(RekordboxAnlzDiscoveryTest, NeutralReaderParsesExternalFixtureWithoutTrackAdapters) {
    if (!QFile::exists(QString::fromLatin1(kFixture))) { GTEST_SKIP() << "External pyrekordbox fixture unavailable"; }
    const auto result = mixxx::rekordbox::readAnlzFile(QString::fromLatin1(kFixture));
    ASSERT_TRUE(result.containerValid);
    EXPECT_TRUE(result.hasPathSection);
    EXPECT_TRUE(result.hadBeatGrid);
    EXPECT_TRUE(result.hadCueSection);
    EXPECT_TRUE(result.hadWaveformSection);
    ASSERT_EQ(result.beats.size(), 368);
    EXPECT_EQ(result.beats.front().timeMs, 25u);
    EXPECT_EQ(result.beats.front().tempoCentiBpm, 12800u);
    EXPECT_EQ(result.beats.front().beatInBar, 1u);
    EXPECT_FALSE(result.waveforms.isEmpty());
    // This real fixture has declared but empty PCOB/PCO2 cue lists. Empty here
    // means "no cue entries", not "cue sections unsupported".
    EXPECT_TRUE(result.cues.isEmpty());
}

TEST(RekordboxAnlzDiscoveryTest, DecodesPco2HotCueColorLabelAndHotLoop) {
    // Synthetic structural conformance fixture using the documented PCP2
    // offsets from Deep Symmetry and pyrekordbox. It is not claimed as a new
    // real Rekordbox capture.
    const auto bytes = anlzWith({cueList(true,
            1,
            {pcp2(1, 1, 1250, 0xffffffffu,
                     QStringLiteral("Intro"), 0x12, 0x34, 0x56),
                    pcp2(8, 2, 2000, 4000,
                            QStringLiteral("Loop"), 0xaa, 0xbb, 0xcc)})});
    const auto result = mixxx::rekordbox::readAnlz(bytes);
    ASSERT_TRUE(result.containerValid) << result.diagnostics.join('\n').toStdString();
    ASSERT_EQ(result.pco2Cues.size(), 2);
    ASSERT_EQ(result.cues.size(), 2);
    const auto& point = result.cues[0];
    EXPECT_EQ(point.kind, mixxx::rekordbox::RuntimeCue::Kind::HotCue);
    EXPECT_EQ(point.hotcueIndex, 1);
    EXPECT_EQ(point.startMs, 1250.0);
    EXPECT_FALSE(point.endMs);
    EXPECT_EQ(point.label, QStringLiteral("Intro"));
    ASSERT_TRUE(point.color);
    EXPECT_EQ(*point.color, mixxx::RgbColor(0x123456));
    const auto& loop = result.cues[1];
    EXPECT_EQ(loop.kind, mixxx::rekordbox::RuntimeCue::Kind::HotLoop);
    EXPECT_EQ(loop.hotcueIndex, 8);
    EXPECT_EQ(loop.startMs, 2000.0);
    EXPECT_EQ(loop.endMs, 4000.0);
    EXPECT_EQ(loop.loopLengthMs(), 2000.0);
    EXPECT_EQ(loop.label, QStringLiteral("Loop"));
}

TEST(RekordboxAnlzDiscoveryTest, DecodesPco2MemoryCueWithoutHotSlot) {
    const auto result = mixxx::rekordbox::readAnlz(anlzWith({cueList(true,
            0,
            {pcp2(0, 1, 750, 0xffffffffu,
                    QStringLiteral("Memory"), 0, 0, 0)})}));
    ASSERT_TRUE(result.containerValid) << result.diagnostics.join('\n').toStdString();
    ASSERT_EQ(result.cues.size(), 1);
    EXPECT_EQ(result.cues[0].kind,
            mixxx::rekordbox::RuntimeCue::Kind::MemoryCue);
    EXPECT_EQ(result.cues[0].hotcueIndex, -1);
    EXPECT_EQ(result.cues[0].startMs, 750.0);
    EXPECT_EQ(result.cues[0].label, QStringLiteral("Memory"));
    EXPECT_FALSE(result.cues[0].color);
}

TEST(RekordboxAnlzDiscoveryTest, FallsBackToPcobWhenPco2IsAbsentOrEmpty) {
    const auto legacy = cueList(false, 1, {pcpt(2, 1, 1500, 0xffffffffu)});
    for (const auto& sections : {QList<QByteArray>{legacy},
                 QList<QByteArray>{legacy, cueList(true, 1, {})}}) {
        const auto result = mixxx::rekordbox::readAnlz(anlzWith(sections));
        ASSERT_TRUE(result.containerValid) << result.diagnostics.join('\n').toStdString();
        ASSERT_EQ(result.pcobCues.size(), 1);
        EXPECT_TRUE(result.pco2Cues.isEmpty());
        ASSERT_EQ(result.cues.size(), 1);
        EXPECT_EQ(result.cues[0].kind,
                mixxx::rekordbox::RuntimeCue::Kind::HotCue);
        EXPECT_EQ(result.cues[0].hotcueIndex, 2);
        EXPECT_EQ(result.cues[0].startMs, 1500.0);
    }
}

TEST(RekordboxAnlzDiscoveryTest, AcceptsModernPcobHotCueSlotsAboveThree) {
    // Confirmed by the real NAUTIC_01 fixture
    // P012/00009B36/ANLZ0000.EXT, which mirrors slots D and E in PCOB.
    const auto result = mixxx::rekordbox::readAnlz(anlzWith(
            {cueList(false, 1, {pcpt(5, 1, 156833, 0xffffffffu)})}));
    ASSERT_TRUE(result.containerValid)
            << result.diagnostics.join('\n').toStdString();
    ASSERT_EQ(result.pcobCues.size(), 1);
    EXPECT_EQ(result.pcobCues[0].kind,
            mixxx::rekordbox::RuntimeCue::Kind::HotCue);
    EXPECT_EQ(result.pcobCues[0].hotcueIndex, 5);
    EXPECT_EQ(result.pcobCues[0].startMs, 156833.0);
}

TEST(RekordboxAnlzDiscoveryTest, NonemptyPco2TakesPriorityOverPcob) {
    const auto result = mixxx::rekordbox::readAnlz(anlzWith(
            {cueList(false, 1, {pcpt(1, 1, 1000, 0xffffffffu)}),
                    cueList(true,
                            1,
                            {pcp2(4, 1, 2000, 0xffffffffu,
                                    QStringLiteral("Modern"), 1, 2, 3)})}));
    ASSERT_TRUE(result.containerValid) << result.diagnostics.join('\n').toStdString();
    ASSERT_EQ(result.pcobCues.size(), 1);
    ASSERT_EQ(result.pco2Cues.size(), 1);
    ASSERT_EQ(result.cues.size(), 1);
    EXPECT_EQ(result.cues[0].hotcueIndex, 4);
    EXPECT_EQ(result.cues[0].label, QStringLiteral("Modern"));
}

TEST(RekordboxAnlzDiscoveryTest, DecodesRealRekordcrateExtendedCueFragment) {
    // Real PCP2 entry contributed to rekordcrate by @FizzyApple12 and retained
    // in rekordcrate's extended_cue_empty_comment_roundtrip test. Wrapping the
    // unmodified entry in PMAI/PCO2 supplies external non-synthetic evidence
    // for slot, type, millisecond time, empty comment and RGB offsets.
    const auto entry = QByteArray::fromHex(
            "50435032000000100000005800000004010003e8000462f7ffffffff"
            "00010000000000000000000000000000004d00ff0000000000c17000"
            "0000000000000000000000000230776100000000000000000000100000000000");
    ASSERT_EQ(entry.size(), 88);
    const auto result = mixxx::rekordbox::readAnlz(
            anlzWith({cueList(true, 1, {entry})}));
    ASSERT_TRUE(result.containerValid) << result.diagnostics.join('\n').toStdString();
    ASSERT_EQ(result.cues.size(), 1);
    EXPECT_EQ(result.cues[0].kind,
            mixxx::rekordbox::RuntimeCue::Kind::HotCue);
    EXPECT_EQ(result.cues[0].hotcueIndex, 4);
    EXPECT_EQ(result.cues[0].startMs, 287479.0);
    EXPECT_TRUE(result.cues[0].label.isEmpty());
    ASSERT_TRUE(result.cues[0].color);
    EXPECT_EQ(*result.cues[0].color, mixxx::RgbColor(0x4d00ff));
}

TEST(RekordboxAnlzDiscoveryTest, RejectsMalformedCueSectionWithoutPublishingPrefix) {
    auto bytes = anlzWith({cueList(true,
            1,
            {pcp2(1, 1, 1250, 0xffffffffu,
                    QStringLiteral("Cue"), 1, 2, 3)})});
    // PMAI 28 + PCO2 header 20 + PCP2 len_entry offset 8.
    putBe32(&bytes, 56, 0xffffffffu);
    const auto result = mixxx::rekordbox::readAnlz(bytes);
    EXPECT_TRUE(result.containerValid); // Semantic section error, valid framing.
    EXPECT_TRUE(result.partial);
    EXPECT_TRUE(result.hadCueSection);
    EXPECT_TRUE(result.cues.isEmpty());
    EXPECT_TRUE(result.pco2Cues.isEmpty());
    const auto raw = std::find_if(result.unmappedSections.cbegin(),
            result.unmappedSections.cend(),
            [](const auto& section) { return section.tag == "PCO2"; });
    ASSERT_NE(raw, result.unmappedSections.cend());
    EXPECT_EQ(raw->bytes, bytes.mid(28));
}

TEST(RekordboxAnlzDiscoveryTest, CueAuditMatchesIndependentRealUsbInventory) {
    // Optional inventory generated read-only by unmodified pyrekordbox
    // Construct definitions. This validates real nonempty PCOB/PCO2 entries;
    // synthetic fixtures remain responsible only for unavailable loop cases.
    const auto manifest = QString::fromLocal8Bit(qgetenv("MIXXX_CUE_AUDIT_JSON"));
    if (manifest.isEmpty()) {
        GTEST_SKIP() << "External real USB cue inventory not supplied";
    }
    QFile input(manifest);
    ASSERT_TRUE(input.open(QIODevice::ReadOnly));
    const auto root = QJsonDocument::fromJson(input.readAll()).object();
    const auto fixtures = root.value("fixtures").toArray();
    ASSERT_FALSE(fixtures.isEmpty());
    QSet<QString> visited;
    int comparedEntries = 0;
    for (const auto& value : fixtures) {
        const auto fixture = value.toObject();
        const auto path = fixture.value("file").toString();
        const auto tag = fixture.value("tag").toString();
        SCOPED_TRACE(path.toStdString());
        // The independent inventory groups every nonempty cue-list section by
        // file and format. A modern EXT may contain both nonempty PCOB and
        // PCO2 sections, so reject only duplicate file/format pairs.
        const auto fixtureKey = path + QChar::LineFeed + tag;
        ASSERT_FALSE(visited.contains(fixtureKey));
        visited.insert(fixtureKey);
        QFile file(path);
        ASSERT_TRUE(file.open(QIODevice::ReadOnly));
        const auto bytes = file.readAll();
        EXPECT_EQ(QString::fromLatin1(QCryptographicHash::hash(
                          bytes, QCryptographicHash::Sha256).toHex()),
                fixture.value("sha256").toString());
        const auto parsed = mixxx::rekordbox::readAnlz(bytes);
        ASSERT_TRUE(parsed.containerValid)
                << parsed.diagnostics.join('\n').toStdString();
        const auto& actual = tag == "PCO2" ? parsed.pco2Cues : parsed.pcobCues;
        const auto expected = fixture.value("entries").toArray();
        ASSERT_EQ(actual.size(), expected.size());
        for (int i = 0; i < expected.size(); ++i) {
            const auto entry = expected[i].toObject();
            const auto hotCue = entry.value("hot_cue").toInt();
            const auto loop = entry.value("type").toString() == "loop" ||
                    entry.value("type").toString() == "2";
            const auto expectedKind = hotCue > 0
                    ? (loop ? mixxx::rekordbox::RuntimeCue::Kind::HotLoop
                            : mixxx::rekordbox::RuntimeCue::Kind::HotCue)
                    : (loop ? mixxx::rekordbox::RuntimeCue::Kind::MemoryLoop
                            : mixxx::rekordbox::RuntimeCue::Kind::MemoryCue);
            EXPECT_EQ(actual[i].kind, expectedKind);
            EXPECT_EQ(actual[i].hotcueIndex, hotCue > 0 ? hotCue : -1);
            EXPECT_EQ(actual[i].startMs, entry.value("time").toDouble());
            if (loop) {
                EXPECT_EQ(actual[i].endMs,
                        entry.value("loop_time").toDouble());
            } else {
                EXPECT_FALSE(actual[i].endMs);
            }
            EXPECT_EQ(actual[i].label,
                    tag == "PCO2" ? entry.value("comment").toString()
                                   : QString());
            const auto rgb = (entry.value("color_red").toInt() << 16) |
                    (entry.value("color_green").toInt() << 8) |
                    entry.value("color_blue").toInt();
            if (rgb != 0) {
                ASSERT_TRUE(actual[i].color);
                EXPECT_EQ(*actual[i].color, mixxx::RgbColor(rgb));
            } else {
                EXPECT_FALSE(actual[i].color);
            }
            ++comparedEntries;
        }
    }
    EXPECT_EQ(comparedEntries,
            root.value("entries").toObject().value("PCOB").toInt() +
                    root.value("entries").toObject().value("PCO2").toInt());
    RecordProperty("real_cue_files", visited.size());
    RecordProperty("real_cue_entries", comparedEntries);
}

TEST(RekordboxAnlzDiscoveryTest, PpthDecodesUtf16BeExactlyOnce) {
    // External pyrekordbox export, P016/0000875E, not a synthetic path fixture.
    if (!QFile::exists(QString::fromLatin1(kFixture))) { GTEST_SKIP() << "External pyrekordbox fixture unavailable"; }
    const auto result = mixxx::rekordbox::readAnlzFile(QString::fromLatin1(kFixture));
    ASSERT_TRUE(result.containerValid);
    ASSERT_TRUE(result.hasPathSection);
    EXPECT_EQ(result.exportedAudioPath,
            QStringLiteral("/Contents/Loopmasters/UnknownAlbum/Demo Track 1.mp3"));
    EXPECT_FALSE(result.exportedAudioPath.contains(QChar::Null));
}

TEST(RekordboxAnlzDiscoveryTest, IndependentPyrekordboxValuesForAllExportVariants) {
    // JSON generated OUTSIDE Mixxx using unmodified pyrekordbox Construct
    // definitions at f695541827cc488af267d6ca8a8e0052598d85a0. No runtime dependency.
    const auto manifest = QString::fromLocal8Bit(qgetenv("MIXXX_ANLZ_REFERENCE_JSON"));
    if (manifest.isEmpty()) { GTEST_SKIP() << "External independent reference not supplied"; }
    QFile file(manifest);
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    const auto references = QJsonDocument::fromJson(file.readAll()).array();
    ASSERT_EQ(references.size(), 18);
    for (const auto& value : references) {
        const auto ref = value.toObject();
        QFile input(ref.value("path").toString());
        ASSERT_TRUE(input.open(QIODevice::ReadOnly));
        const auto bytes = input.readAll();
        ASSERT_EQ(QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex()),
                ref.value("sha256").toString());
        const auto read = mixxx::rekordbox::readAnlz(bytes);
        ASSERT_TRUE(read.containerValid) << read.diagnostics.join('\n').toStdString();
        int waveformCount = 0;
        for (const auto& item : ref.value("sections").toArray()) {
            const auto section = item.toObject();
            const auto tag = section.value("tag").toString();
            if (tag == "PPTH") { EXPECT_EQ(read.exportedAudioPath, section.value("audioPath").toString()); }
            if (tag == "PQTZ") {
                const auto beats = section.value("beats").toArray();
                ASSERT_EQ(read.beats.size(), beats.size());
                for (int i = 0; i < beats.size(); ++i) {
                    const auto beat = beats[i].toArray();
                    EXPECT_EQ(read.beats[i].timeMs, beat[0].toInt());
                    EXPECT_EQ(read.beats[i].beatInBar, beat[1].toInt());
                    EXPECT_EQ(read.beats[i].tempoCentiBpm, beat[2].toInt());
                }
            }
            if (section.contains("stride")) {
                ++waveformCount;
                const auto found = std::find_if(read.waveforms.cbegin(), read.waveforms.cend(),
                        [&](const auto& w) { return w.sectionTag == tag.toLatin1(); });
                ASSERT_NE(found, read.waveforms.cend());
                EXPECT_EQ(found->entryCount, section.value("count").toInt());
                EXPECT_EQ(found->bytesPerEntry, quint32(section.value("stride").toInt()));
                EXPECT_EQ(found->payloadOffset, section.value("header").toInt() - 12);
                EXPECT_EQ(found->bytes.size() - found->payloadOffset,
                        found->entryCount * *found->bytesPerEntry);
                EXPECT_FALSE(found->samplesDecoded);
            }
        }
        EXPECT_EQ(read.waveforms.size(), waveformCount);
    }
}

TEST(RekordboxAnlzDiscoveryTest, RejectsTruncatedContainerAndPreservesValidSectionsOnBadCount) {
    // Negative mutations of an external real fixture, NOT synthetic compatibility evidence.
    QFile file(QString::fromLatin1(kFixture));
    if (!file.exists()) { GTEST_SKIP() << "External fixture unavailable"; }
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    const auto original = file.readAll();
    for (int size : {0, 4, 12, 27, int(original.size() - 1)}) {
        EXPECT_FALSE(mixxx::rekordbox::readAnlz(original.left(size)).containerValid);
    }
    auto changed = original;
    const auto offset = changed.indexOf("PQTZ");
    ASSERT_GT(offset, 0);
    qToBigEndian<quint32>(0xffffffff, changed.data() + offset + 20);
    const auto read = mixxx::rekordbox::readAnlz(changed);
    EXPECT_TRUE(read.containerValid);
    EXPECT_TRUE(read.partial);
    EXPECT_TRUE(read.hasPathSection);
    EXPECT_TRUE(read.beats.isEmpty());
    EXPECT_FALSE(read.waveforms.isEmpty());
    EXPECT_FALSE(read.unmappedSections.isEmpty());
    changed = original;
    qToBigEndian<quint32>(0xffffffff, changed.data() + offset + 8);
    EXPECT_FALSE(mixxx::rekordbox::readAnlz(changed).containerValid);
}

TEST(RekordboxAnlzDiscoveryTest, AbsentPqtzDoesNotSynthesizeGrid) {
    QFile file(QString::fromLatin1(kFixture));
    if (!file.exists()) { GTEST_SKIP() << "External fixture unavailable"; }
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    auto bytes = file.readAll();
    const auto offset = bytes.indexOf("PQTZ");
    ASSERT_GT(offset, 0);
    bytes.remove(offset, qFromBigEndian<quint32>(bytes.constData() + offset + 8));
    qToBigEndian<quint32>(bytes.size(), bytes.data() + 8);
    const auto read = mixxx::rekordbox::readAnlz(bytes);
    EXPECT_TRUE(read.containerValid);
    EXPECT_FALSE(read.hadBeatGrid);
    EXPECT_TRUE(read.beats.isEmpty());
    EXPECT_TRUE(read.hasPathSection);
}

TEST(RekordboxAnlzDiscoveryTest, StreamingDescriptorsMatchAllExternalVariantBodies) {
    const auto manifest = QString::fromLocal8Bit(qgetenv("MIXXX_ANLZ_REFERENCE_JSON"));
    if (manifest.isEmpty()) {
        GTEST_SKIP() << "Independent external reference required";
    }
    QFile reference(manifest);
    ASSERT_TRUE(reference.open(QIODevice::ReadOnly));
    const auto document = QJsonDocument::fromJson(reference.readAll());
    const auto references = document.array();
    ASSERT_EQ(references.size(), 18);
    for (const auto& item : references) {
        const auto ref = item.toObject();
        const auto path = ref.value("path").toString();
        SCOPED_TRACE(path.toStdString());
        QFile file(path);
        ASSERT_TRUE(file.open(QIODevice::ReadOnly));
        const auto bytes = file.readAll();
        const auto inlineRead = mixxx::rekordbox::readAnlz(bytes);
        const auto streamed = mixxx::rekordbox::readAnlzFile(path,
                mixxx::rekordbox::AnlzWaveformReadMode::Descriptor);
        ASSERT_TRUE(streamed.containerValid);
        EXPECT_EQ(streamed.exportedAudioPath, inlineRead.exportedAudioPath);
        EXPECT_EQ(streamed.partial, inlineRead.partial);
        ASSERT_EQ(streamed.beats.size(), inlineRead.beats.size());
        for (int i = 0; i < streamed.beats.size(); ++i) {
            EXPECT_EQ(streamed.beats[i].timeMs, inlineRead.beats[i].timeMs);
            EXPECT_EQ(streamed.beats[i].beatInBar, inlineRead.beats[i].beatInBar);
            EXPECT_EQ(streamed.beats[i].tempoCentiBpm, inlineRead.beats[i].tempoCentiBpm);
        }
        ASSERT_EQ(streamed.waveforms.size(), inlineRead.waveforms.size());
        for (int i = 0; i < streamed.waveforms.size(); ++i) {
            const auto& descriptor = streamed.waveforms[i];
            const auto& eager = inlineRead.waveforms[i];
            EXPECT_TRUE(descriptor.bytes.isEmpty());
            EXPECT_TRUE(descriptor.payloadDeferred);
            EXPECT_FALSE(descriptor.samplesDecoded);
            EXPECT_EQ(descriptor.headerBytes, eager.headerBytes);
            EXPECT_EQ(descriptor.sectionOffset, eager.sectionOffset);
            EXPECT_EQ(descriptor.payloadLength, eager.bytes.size() - eager.payloadOffset);
            EXPECT_EQ(descriptor.entryCount, eager.entryCount);
            EXPECT_EQ(descriptor.bytesPerEntry, eager.bytesPerEntry);
            EXPECT_EQ(descriptor.sourceFingerprint, QCryptographicHash::hash(bytes, QCryptographicHash::Sha256));
            EXPECT_EQ(bytes.mid(descriptor.sectionOffset + descriptor.headerLength,
                              descriptor.payloadLength), eager.bytes.mid(eager.payloadOffset));
        }
        ASSERT_EQ(streamed.unmappedSections.size(), inlineRead.unmappedSections.size());
        for (int i = 0; i < streamed.unmappedSections.size(); ++i) {
            EXPECT_EQ(streamed.unmappedSections[i].bytes, inlineRead.unmappedSections[i].bytes);
        }
    }
}

TEST(RekordboxAnlzDiscoveryTest, PqtzAuditMatchesAllRealFixturesAndOwnerPdbMetadata) {
    // Audit inventory: real pyrekordbox export/backups and rekordcrate fixtures;
    // every tuple independently checked against unmodified Construct definitions.
    const auto manifest = QString::fromLocal8Bit(qgetenv("MIXXX_PQTZ_AUDIT_JSON"));
    if (manifest.isEmpty()) {
        GTEST_SKIP() << "External PQTZ audit inventory not supplied";
    }
    QFile file(manifest);
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    const auto audit = QJsonDocument::fromJson(file.readAll()).object();
    const auto fixtures = audit.value("files").toArray();
    ASSERT_EQ(fixtures.size(), 57);
    int pqtzCount = 0;
    for (const auto& item : fixtures) {
        const auto fixture = item.toObject();
        const auto path = fixture.value("file").toString();
        SCOPED_TRACE(path.toStdString());
        QFile input(path);
        ASSERT_TRUE(input.open(QIODevice::ReadOnly));
        const auto bytes = input.readAll();
        ASSERT_EQ(QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex()),
                fixture.value("sha256").toString());
        const auto parsed = mixxx::rekordbox::readAnlz(bytes);
        ASSERT_TRUE(parsed.containerValid);
        const auto grids = fixture.value("pqtz").toArray();
        ASSERT_LE(grids.size(), 1);
        EXPECT_EQ(parsed.hadBeatGrid, !grids.isEmpty());
        if (grids.isEmpty()) {
            EXPECT_TRUE(parsed.beats.isEmpty());
            continue;
        }
        ++pqtzCount;
        const auto reference = grids.first().toObject().value("beats").toArray();
        ASSERT_EQ(parsed.beats.size(), reference.size());
        for (int i = 0; i < reference.size(); ++i) {
            const auto beat = reference[i].toArray();
            EXPECT_EQ(parsed.beats[i].timeMs, beat[0].toDouble());
            EXPECT_EQ(parsed.beats[i].beatInBar, beat[1].toInt());
            EXPECT_EQ(parsed.beats[i].tempoCentiBpm, beat[2].toInt());
        }
    }
    EXPECT_EQ(pqtzCount, 21);
    const auto comparisons = audit.value("pdb_comparisons").toArray();
    ASSERT_EQ(comparisons.size(), 8);
    for (const auto& item : comparisons) {
        const auto ref = item.toObject();
        const auto path = ref.value("pdb").toString();
        SCOPED_TRACE(path.toStdString());
        const auto document = mixxx::rekordbox::readDatabaseFile(path,
                mixxx::rekordbox::DatabaseKind::Main);
        ASSERT_TRUE(document.valid());
        EXPECT_EQ(QString::fromLatin1(QCryptographicHash::hash(document.bytes, QCryptographicHash::Sha256).toHex()),
                ref.value("pdb_sha256").toString());
        const auto index = mixxx::rekordbox::readTrackIndex(document);
        ASSERT_TRUE(index.error.isEmpty());
        const auto id = ref.value("track_id").toInt();
        ASSERT_TRUE(index.tracks.contains(id));
        const auto track = index.tracks.value(id);
        EXPECT_EQ(track.filePath, ref.value("audio").toString());
        EXPECT_EQ(track.analysisPath, ref.value("analysis").toString());
        EXPECT_EQ(track.metadata.value("tempo_hundredths").toInt(), ref.value("pdb_tempo_centi_bpm").toInt());
        EXPECT_EQ(track.metadata.value("duration").toInt(), ref.value("pdb_duration_s").toInt());
        const auto anlz = mixxx::rekordbox::readAnlzFile(ref.value("candidate").toString());
        ASSERT_TRUE(anlz.containerValid);
        EXPECT_TRUE(anlz.hasPathSection);
        EXPECT_EQ(anlz.exportedAudioPath, track.filePath);
        if (ref.value("pdb_tempo_centi_bpm").toInt() == 0) {
            EXPECT_FALSE(track.metadata.contains("bpm"));
            EXPECT_TRUE(anlz.hadBeatGrid);
            EXPECT_TRUE(anlz.beats.isEmpty());
        }
    }
}

TEST(RekordboxAnlzDiscoveryTest, PqtzTemporalBoundsRejectWithoutPublishingPartialGrid) {
    // Negative/boundary mutations of real Demo Track 1; NOT variable-tempo evidence.
    QFile file(QString::fromLatin1(kFixture));
    if (!file.exists()) {
        GTEST_SKIP() << "External pyrekordbox fixture unavailable";
    }
    ASSERT_TRUE(file.open(QIODevice::ReadOnly));
    const auto original = file.readAll();
    const auto offset = original.indexOf("PQTZ");
    ASSERT_GT(offset, 0);
    const auto first = offset + 24;
    const auto firstTime = qFromBigEndian<quint32>(original.constData() + first + 4);
    for (int scenario = 0; scenario < 8; ++scenario) {
        SCOPED_TRACE(scenario);
        auto bytes = original;
        switch (scenario) {
        case 0: qToBigEndian<quint16>(0, bytes.data() + first + 2); break; // zero tempo
        case 1: qToBigEndian<quint16>(0, bytes.data() + first); break;
        case 2: qToBigEndian<quint16>(5, bytes.data() + first); break;
        case 3: qToBigEndian<quint32>(firstTime, bytes.data() + first + 12); break;
        case 4: qToBigEndian<quint32>(firstTime - 1, bytes.data() + first + 12); break;
        case 5: qToBigEndian<quint32>(1000001, bytes.data() + offset + 20); break;
        case 6: qToBigEndian<quint32>(0xffffffffu, bytes.data() + offset + 20); break;
        case 7: qToBigEndian<quint32>(0xffffffffu, bytes.data() + first + 4); break;
        }
        const auto read = mixxx::rekordbox::readAnlz(bytes);
        EXPECT_TRUE(read.containerValid); // Section semantic error, not bad framing.
        EXPECT_TRUE(read.partial);
        EXPECT_TRUE(read.hasPathSection);
        EXPECT_FALSE(read.hadBeatGrid);
        EXPECT_TRUE(read.beats.isEmpty()); // No valid prefix leaks from a rejected PQTZ.
        const auto raw = std::find_if(read.unmappedSections.cbegin(), read.unmappedSections.cend(),
                [](const auto& section) { return section.tag == "PQTZ"; });
        ASSERT_NE(raw, read.unmappedSections.cend());
        EXPECT_EQ(raw->bytes, bytes.mid(offset, qFromBigEndian<quint32>(bytes.constData() + offset + 8)));
    }
    // Origin 0 is representable, not a "missing" sentinel.
    auto zero = original;
    qToBigEndian<quint32>(0, zero.data() + first + 4);
    const auto atZero = mixxx::rekordbox::readAnlz(zero);
    ASSERT_TRUE(atZero.hadBeatGrid);
    EXPECT_EQ(atZero.beats.first().timeMs, 0u);
    // The last u32 timestamp is preserved without signed overflow. This boundary
    // is not a claim that the resulting enormous time gap is a real beatgrid.
    auto maximum = original;
    const auto count = qFromBigEndian<quint32>(original.constData() + offset + 20);
    qToBigEndian<quint32>(0xffffffffu, maximum.data() + first + (count - 1) * 8 + 4);
    const auto maxRead = mixxx::rekordbox::readAnlz(maximum);
    ASSERT_TRUE(maxRead.hadBeatGrid);
    EXPECT_EQ(maxRead.beats.last().timeMs, 0xffffffffu);
}

TEST(RekordboxAnlzDiscoveryTest, ActiveLoopFlagSurvivesExtendedCuePrecedence) {
    auto legacy = pcpt(0, 2, 1000, 3000); putBe32(&legacy, 16, 4);
    auto modern = pcp2(0, 2, 1000, 3000, "Active", 1, 2, 3);
    for (bool legacyFirst : {false, true}) {
        const auto a = cueList(false, 0, {legacy}); const auto b = cueList(true, 0, {modern});
        const auto parsed = mixxx::rekordbox::readAnlz(anlzWith(legacyFirst ? QList<QByteArray>{a,b} : QList<QByteArray>{b,a}));
        ASSERT_TRUE(parsed.containerValid); ASSERT_EQ(1, parsed.cues.size());
        EXPECT_TRUE(parsed.cues[0].activeLoop); EXPECT_EQ("Active", parsed.cues[0].label);
    }
}

#include "library/rekordbox/rekordboxperformancewriter.h"
TEST(RekordboxAnlzDiscoveryTest, PerformanceWriterPreservesUnknownBytesAndRoundTripsCues) {
    QByteArray path(16, '\0'); path.replace(0, 4, "PPTH"); putBe32(&path, 4, 16);
    const auto encoded = QTextCodec::codecForName("UTF-16BE")->fromUnicode(QString("/Contents/test.mp3") + QChar::Null);
    putBe32(&path, 12, encoded.size()); path.append(encoded); putBe32(&path, 8, path.size());
    QByteArray unknown(28, char(0x55)); unknown.replace(0, 4, "TEST"); putBe32(&unknown, 4, 12); putBe32(&unknown, 8, unknown.size());
    auto entry = pcp2(1, 1, 1000, 0xffffffffu, "Old", 1, 2, 3); entry.append(QByteArray::fromHex("cafebabe")); putBe32(&entry, 8, entry.size());
    const auto original = anlzWith({path, unknown, cueList(true, 1, {entry})});
    mixxx::rekordbox::RuntimeCue hot; hot.kind = mixxx::rekordbox::RuntimeCue::Kind::HotCue;
    hot.hotcueIndex = 1; hot.startMs = 1250; hot.label = QString::fromUtf8("Entrada ñ");
    mixxx::rekordbox::RuntimeCue loop; loop.kind = mixxx::rekordbox::RuntimeCue::Kind::MemoryLoop;
    loop.startMs = 2000; loop.endMs = 4000; loop.activeLoop = true;
    const QList<mixxx::rekordbox::RuntimeBeat> beats{{0,1,12000},{500,2,12000},{1000,3,12000}};
    QString error;
    const auto updated = mixxx::rekordbox::performance::rewrite(original, "/Contents/test.mp3", {hot,loop}, beats, true, &error);
    ASSERT_TRUE(error.isEmpty()) << error.toStdString(); EXPECT_TRUE(updated.contains(unknown));
    EXPECT_TRUE(updated.contains(QByteArray::fromHex("cafebabe")));
    const auto parsed = mixxx::rekordbox::readAnlz(updated);
    ASSERT_TRUE(parsed.containerValid); ASSERT_EQ(2, parsed.cues.size()); ASSERT_EQ(3, parsed.beats.size());
    EXPECT_EQ(1250, *parsed.cues[0].startMs); EXPECT_EQ(hot.label, parsed.cues[0].label);
    EXPECT_TRUE(parsed.cues[1].activeLoop); EXPECT_EQ(12000, parsed.beats[1].tempoCentiBpm);
    const auto deleted = mixxx::rekordbox::performance::rewrite(updated, "/Contents/test.mp3", {}, beats, true, &error);
    EXPECT_TRUE(mixxx::rekordbox::readAnlz(deleted).cues.isEmpty()); EXPECT_TRUE(deleted.contains(unknown));
    EXPECT_TRUE(mixxx::rekordbox::performance::rewrite(original, "/other.mp3", {}, {}, true, &error).isEmpty());
    EXPECT_FALSE(error.isEmpty());
}

TEST(RekordboxAnlzDiscoveryTest, PerformanceWriterUpdatesExtendedGridReferencesAndPreservesOpaqueFlags) {
    using namespace mixxx::rekordbox;
    QByteArray section(62,'\0');section.replace(0,4,"PQT2");performance::put32(section,4,56);performance::put32(section,8,62);
    performance::put32(section,40,3);performance::put32(section,28,0);performance::put32(section,36,1000);
    section[57]=char(0x42);section[59]=char(0x77);section[61]=char(0x13);
    QString error;const QList<RuntimeBeat> previous{{0,1,12000},{500,2,12000},{1000,3,12000}};
    const QList<RuntimeBeat> edited{{100,4,12000},{600,1,12000},{1100,2,12000}};
    const auto updated=performance::extendedBeatGrid(section,previous,edited,&error);
    ASSERT_TRUE(error.isEmpty());EXPECT_EQ(100u,performance::get32(updated,28));EXPECT_EQ(1100u,performance::get32(updated,36));
    EXPECT_EQ(4,quint8(updated[56]));EXPECT_EQ(section[57],updated[57]);EXPECT_EQ(section[59],updated[59]);EXPECT_EQ(section[61],updated[61]);
    performance::put32(section,36,999);error.clear();EXPECT_TRUE(performance::extendedBeatGrid(section,previous,edited,&error).isEmpty());EXPECT_FALSE(error.isEmpty());
}
