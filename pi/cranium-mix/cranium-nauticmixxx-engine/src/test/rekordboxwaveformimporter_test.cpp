#include "library/rekordbox/rekordboxwaveformimporter.h"

#include <gtest/gtest.h>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QDir>
#include <QDirIterator>
#include <QImage>
#include <QPainter>
#include <QLinearGradient>
#include <QTemporaryDir>
#include <QDataStream>
#include <QElapsedTimer>
#include <QtEndian>
#include "sources/soundsourceproxy.h"
#include "track/track.h"
#include "library/rekordbox/rekordboxanlzreader.h"

#include "audio/signalinfo.h"
#include "analyzer/constants.h"
#include "audio/streaminfo.h"
#include "util/duration.h"
#include "waveform/beatgridmarkers.h"

namespace mixxx::rekordbox {
namespace {

mixxx::audio::StreamInfo streamInfo(double durationSeconds = 1.0) {
    return mixxx::audio::StreamInfo(
            mixxx::audio::SignalInfo(
                    mixxx::audio::ChannelCount(2),
                    mixxx::audio::SampleRate(48000)),
            mixxx::audio::Bitrate(320),
            mixxx::Duration::fromSeconds(durationSeconds));
}

RuntimeWaveform descriptor(
        const QByteArray& tag,
        RuntimeWaveformQuality quality,
        quint32 stride,
        int count) {
    RuntimeWaveform result;
    result.sectionTag = tag;
    result.quality = quality;
    result.bytesPerEntry = stride;
    result.entryCount = count;
    result.payloadLength = stride * count;
    return result;
}

TEST(RekordboxWaveformImporterTest, DecodesThreeBandDetailForBothMixxxChannels) {
    QByteArray payload;
    payload.reserve(450);
    for (int i = 0; i < 150; ++i) {
        payload.append(static_cast<char>(i));
        payload.append(static_cast<char>(255 - i));
        payload.append(static_cast<char>(i / 2));
    }
    RekordboxWaveformImporter importer({descriptor("PWV7",
                                                RuntimeWaveformQuality::Detailed,
                                                3,
                                                150),
            payload});
    ASSERT_FALSE(importer.isEmpty());
    const auto imported = importer.importWaveforms(streamInfo());
    EXPECT_TRUE(importer.isEmpty());
    ASSERT_TRUE(imported.waveform);
    ASSERT_TRUE(imported.summary);
    EXPECT_GT(imported.waveform->getDataSize(), 250);
    EXPECT_EQ(imported.waveform->getLow(0), 0);
    EXPECT_EQ(imported.waveform->getMid(0), 255);
    EXPECT_EQ(imported.waveform->getHigh(0), 0);
    EXPECT_EQ(imported.waveform->getLow(1), imported.waveform->getLow(0));
    EXPECT_EQ(imported.waveform->getMid(1), imported.waveform->getMid(0));
    EXPECT_EQ(imported.waveform->getCompletion(), imported.waveform->getDataSize());
    EXPECT_EQ(imported.waveform->saveState(), Waveform::SaveState::Saved);
    EXPECT_EQ(imported.waveform->getVersion(), QStringLiteral("Rekordbox-ANLZ-PWV7"));
}

TEST(RekordboxWaveformImporterTest, DecoderTimingShiftsWithoutStretchingDetailClock) {
    QByteArray detail(153 * 3, '\0');
    detail[30 * 3] = static_cast<char>(255); // source peak at 200ms
    RekordboxWaveformImporter importer(QList<LoadedRuntimeWaveform>{
            {descriptor("PWV7", RuntimeWaveformQuality::Detailed, 3, 153), detail},
            {descriptor("PWV6", RuntimeWaveformQuality::Preview, 3, 1200), QByteArray(3600, '\0')}});
    importer.setSourceTimingOffsetMillis(-20);
    const auto imported = importer.importWaveforms(streamInfo(1));
    ASSERT_TRUE(imported.waveform);
    ASSERT_TRUE(imported.waveform->rekordbox);
    const auto& native = *imported.waveform->rekordbox;
    const auto& series = native.detail[2];
    EXPECT_EQ(series.columnsPerSecond, 150);
    EXPECT_DOUBLE_EQ(series.originSeconds, -0.020);
    EXPECT_DOUBLE_EQ(native.overview[2].columnsPerSecond, 1200 / 1.02);
    EXPECT_EQ(peakColumn(series, (0.18 - series.originSeconds) * 150,
                    (0.185 - series.originSeconds) * 150).low, 255);
    const int frames = imported.waveform->getDataSize() / mixxx::kAnalysisChannels;
    int maximum = 0;
    for (int i = 1; i < frames; ++i) {
        if (imported.waveform->getLow(i * mixxx::kAnalysisChannels) >
                imported.waveform->getLow(maximum * mixxx::kAnalysisChannels)) maximum = i;
    }
    EXPECT_NEAR(double(maximum) / frames, 0.18, 1.0 / frames);
}

TEST(RekordboxWaveformImporterTest, DecodesVerifiedPackedColorDetailLayout) {
    RekordboxWaveformImporter importer({descriptor("PWV5",
                                                RuntimeWaveformQuality::Detailed,
                                                2,
                                                1),
            QByteArray::fromHex("2990")});
    const auto imported = importer.importWaveforms(streamInfo(0.01));
    ASSERT_TRUE(imported.waveform);
    EXPECT_EQ(imported.waveform->getLow(0), 36);   // red = 1/7
    EXPECT_EQ(imported.waveform->getMid(0), 73);   // green = 2/7
    EXPECT_EQ(imported.waveform->getHigh(0), 109); // blue = 3/7
    EXPECT_EQ(imported.waveform->getAll(0), 33);   // height = 4/31
}

TEST(RekordboxWaveformImporterTest, RejectsPayloadWhoseDimensionsDoNotMatch) {
    RekordboxWaveformImporter importer({descriptor("PWV7",
                                                RuntimeWaveformQuality::Detailed,
                                                3,
                                                2),
            QByteArray(5, '\0')});
    const auto imported = importer.importWaveforms(streamInfo());
    EXPECT_FALSE(imported.waveform);
    EXPECT_FALSE(imported.summary);
    EXPECT_TRUE(importer.isEmpty());
}

TEST(RekordboxWaveformImporterTest,
        ProducesBoundedBrowserColumnsWithoutLosingIntervalPeaks) {
    const auto source = LoadedRuntimeWaveform{
            descriptor("PWV7", RuntimeWaveformQuality::Detailed, 3, 4),
            QByteArray::fromHex("0102030405060708090a0b0c")};
    const auto columns = decodeRuntimeWaveformColumns(source, 2);
    ASSERT_EQ(columns.size(), 2);
    EXPECT_EQ(columns[0].low, 4);
    EXPECT_EQ(columns[0].mid, 5);
    EXPECT_EQ(columns[0].high, 6);
    EXPECT_EQ(columns[0].all, 6);
    EXPECT_EQ(columns[1].low, 10);
    EXPECT_EQ(columns[1].mid, 11);
    EXPECT_EQ(columns[1].high, 12);
    EXPECT_EQ(columns[1].all, 12);
}

TEST(RekordboxWaveformImporterTest, PreservesIndependentStylesPreviewsAndWhiteness) {
    QList<LoadedRuntimeWaveform> sources{
            {descriptor("PWV3", RuntimeWaveformQuality::Detailed, 1, 2), QByteArray::fromHex("1fff")},
            {descriptor("PWV5", RuntimeWaveformQuality::Detailed, 2, 1), QByteArray::fromHex("2990")},
            {descriptor("PWV7", RuntimeWaveformQuality::Detailed, 3, 1), QByteArray::fromHex("102030")},
            {descriptor("PWAV", RuntimeWaveformQuality::Preview, 1, 1), QByteArray::fromHex("05")}};
    RekordboxWaveformImporter importer(std::move(sources));
    const auto imported = importer.importWaveforms(streamInfo());
    ASSERT_TRUE(imported.waveform);
    const auto native = imported.waveform->rekordbox;
    ASSERT_TRUE(native);
    EXPECT_EQ(native, imported.summary->rekordbox);
    EXPECT_EQ(native->detail[0].columns[0].whiteness, 0);
    EXPECT_EQ(native->detail[0].columns[1].whiteness, 255);
    EXPECT_EQ(native->detail[0].columnsPerSecond, 150);
    EXPECT_EQ(native->detail[1].columns[0].low, 36);
    EXPECT_EQ(native->detail[2].columns[0].low, 16);
    EXPECT_EQ(native->overview[0].columns[0].all, 41);
    EXPECT_TRUE(native->overview[1].columns.isEmpty());
}

TEST(RekordboxWaveformImporterTest, PeakDecimationPreservesRgbColorOfEnvelopePeak) {
    WaveformSeries series;
    series.columns = {{255, 0, 0, 200, 10}, {0, 255, 0, 100, 50}};
    const auto peak = peakColumn(series, 0, 2, true);
    EXPECT_EQ(peak.all, 200);
    EXPECT_EQ(peak.low, 255);
    EXPECT_EQ(peak.mid, 0);
    EXPECT_EQ(peak.whiteness, 10);
}

TEST(RekordboxWaveformImporterTest, LongTrackResamplingDoesNotOverflowColumnOffsets) {
    QByteArray payload(90000, char(1));
    payload[payload.size() - 1] = char(31);
    RekordboxWaveformImporter importer({descriptor("PWV3",
            RuntimeWaveformQuality::Detailed, 1, payload.size()), payload});
    const auto imported = importer.importWaveforms(streamInfo(600));
    ASSERT_TRUE(imported.waveform);
    EXPECT_EQ(imported.waveform->getAll(imported.waveform->getDataSize() - 1), 255);
    EXPECT_EQ(imported.waveform->rekordbox->detail[0].columns.size(), 90000);
}

TEST(RekordboxWaveformImporterTest, SignedPcmKeepsDcPolarityAndCancellationDiscardsPartialData) {
    if (!SoundSourceProxy::isFileSuffixSupported("wav")) ASSERT_TRUE(SoundSourceProxy::registerProviders());
    QTemporaryDir directory;
    QFile file(directory.filePath("signed.wav"));
    ASSERT_TRUE(file.open(QIODevice::WriteOnly));
    QDataStream data(&file); data.setByteOrder(QDataStream::LittleEndian);
    constexpr int frames=44100;
    data.writeRawData("RIFF",4); data << quint32(36+frames*4);
    data.writeRawData("WAVEfmt ",8); data << quint32(16) << quint16(1) << quint16(2)
        << quint32(44100) << quint32(176400) << quint16(4) << quint16(16);
    data.writeRawData("data",4); data << quint32(frames*4);
    for (int i=0;i<frames;++i) { const qint16 v=i<frames/2?8192:-16384; data << v << v; }
    file.close();
    auto track=Track::newTemporary(directory.filePath("signed.wav"));
    SoundSourceProxy proxy(track); const auto source=proxy.openAudioSource();
    ASSERT_TRUE(source);
    int chunks=0;
    EXPECT_FALSE(decodeSignedWaveform(source,[&] { return ++chunks>1; }));
    const auto result=decodeSignedWaveform(source);
    ASSERT_TRUE(result); ASSERT_EQ(result->columns.size(),1500);
    EXPECT_FLOAT_EQ(result->columns[100].minimum,.25f);
    EXPECT_FLOAT_EQ(result->columns[100].maximum,.25f);
    EXPECT_FLOAT_EQ(result->columns[1000].minimum,-.5f);
    EXPECT_FLOAT_EQ(result->columns[1000].maximum,-.5f);
    EXPECT_DOUBLE_EQ(result->firstAudibleSecond, 0.0);
    source->close();
}

TEST(RekordboxWaveformImporterTest, BeatTicksStayAtEdgesAndRedExtendsOutward) {
    const auto white = mixxx::beatgrid::edgeTicks(114.f, 1.f, 10.f, false);
    const auto red = mixxx::beatgrid::edgeTicks(114.f, 1.f, 10.f, true);
    EXPECT_FLOAT_EQ(white.topStart, 4.f);
    EXPECT_FLOAT_EQ(white.topEnd, 14.f);
    EXPECT_FLOAT_EQ(white.bottomStart, 100.f);
    EXPECT_FLOAT_EQ(white.bottomEnd, 110.f);
    EXPECT_FLOAT_EQ(red.topStart, 2.f);
    EXPECT_FLOAT_EQ(red.topEnd, white.topEnd);
    EXPECT_FLOAT_EQ(red.bottomStart, white.bottomStart);
    EXPECT_FLOAT_EQ(red.bottomEnd, 112.f);
}

TEST(RekordboxWaveformImporterTest, BeatTicksStartAtFirstAudibleColumn) {
    QByteArray payload(600, '\0');
    payload[300] = '\x1f'; // Silence for two seconds at 150 columns/s.
    RekordboxWaveformImporter importer({descriptor("PWV3",
            RuntimeWaveformQuality::Detailed, 1, payload.size()), payload});
    const auto imported = importer.importWaveforms(streamInfo(4.0));
    ASSERT_TRUE(imported.waveform);
    auto track = Track::newTemporary();
    track->setWaveform(imported.waveform);
    const double trackSamples = 4.0 * 48000 * 2;
    EXPECT_DOUBLE_EQ(mixxx::beatgrid::firstAudibleEngineSample(track, trackSamples),
            2.0 * 48000 * 2);

    auto signedAudio = std::make_shared<SignedWaveform>();
    signedAudio->firstAudibleSecond = 2.1;
    std::shared_ptr<const SignedWaveform> published = signedAudio;
    std::atomic_store(&imported.waveform->rekordbox->signedAudio, published);
    EXPECT_DOUBLE_EQ(mixxx::beatgrid::firstAudibleEngineSample(track, trackSamples),
            2.1 / 4.0 * trackSamples);
}

TEST(RekordboxWaveformImporterTest, SignedRenderDoesNotReflectPositiveSignalAcrossAxis) {
    WaveformSeries color; color.columns={{255,0,0,255,0}}; color.columnsPerSecond=1;
    SignedWaveform signal; signal.columns={{.25f,.5f}}; signal.columnsPerSecond=1;
    int rectangles=0;
    renderSignedColumns(color,signal,WaveformMode::RGB,0,1,1,114,{1,1,1},
            [&](float,float y1,float,float y2,QRgb,QRgb) {
                EXPECT_LT(y1,57); EXPECT_LT(y2,57); ++rectangles;
            });
    EXPECT_EQ(rectangles,4);
}

// Optional integration fixture: exercises the same decoder and raster geometry
// as the application against user-supplied ANLZ, without redistributing audio.
TEST(RekordboxWaveformImporterTest, RenderCalibrationFixtures) {
    const QString specPath = qEnvironmentVariable("NAUTIC_CALIBRATION_RENDER_SPEC");
    if (specPath.isEmpty()) GTEST_SKIP() << "No local calibration render specification";
    QFile spec(specPath);
    ASSERT_TRUE(spec.open(QIODevice::ReadOnly));
    const auto jobs = QJsonDocument::fromJson(spec.readAll()).array();
    if (!SoundSourceProxy::isFileSuffixSupported("wav")) ASSERT_TRUE(SoundSourceProxy::registerProviders());
    for (const auto& entry : jobs) {
        const auto job = entry.toObject();
        QList<LoadedRuntimeWaveform> sources;
        for (const auto& ext : {"DAT", "EXT", "2EX"}) {
            const auto parsed = readAnlzFile(job["anlz"].toString() + "/ANLZ0000." + ext);
            ASSERT_TRUE(parsed.containerValid);
            for (const auto& descriptor : parsed.waveforms) {
                sources.append({descriptor, descriptor.bytes.mid(descriptor.payloadOffset, descriptor.payloadLength)});
            }
        }
        RekordboxWaveformImporter importer(std::move(sources));
        const auto imported = importer.importWaveforms(streamInfo(job["duration"].toDouble()));
        ASSERT_TRUE(imported.waveform);
        const auto native = imported.waveform->rekordbox;
        const int mode = job["mode"].toInt();
        const bool overview = job["overview"].toBool();
        const auto& series = overview ? native->overview[mode] : native->detail[mode];
        ASSERT_FALSE(series.columns.isEmpty());
        QImage image(job["width"].toInt(), job["height"].toInt(), QImage::Format_RGB32);
        image.fill(Qt::black);
        QPainter painter(&image);
        painter.setRenderHint(QPainter::Antialiasing, false);
        if (overview) painter.translate(job["preview_offset_x"].toDouble(),0);
        if (!overview && mode!=2 && job.contains("audio")) {
            auto track=Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo(job["audio"].toString())));
            SoundSourceProxy proxy(track);
            const auto source=proxy.openAudioSource();
            ASSERT_TRUE(source);
            QElapsedTimer timer; timer.start();
            const auto signedAudio=decodeSignedWaveform(source);
            qInfo() << "Signed PCM decode milliseconds:" << timer.elapsed() << job["audio"].toString();
            ASSERT_TRUE(signedAudio);
            source->close();
            renderSignedColumns(series,*signedAudio,static_cast<WaveformMode>(mode),
                    job["first_second"].toDouble(),job["last_second"].toDouble(),
                    image.width(),image.height(),{1,1,1},
                    [&](float x1,float y1,float x2,float y2,QRgb c1,QRgb c2) {
                        QLinearGradient gradient(0,y1,0,y2);
                        gradient.setColorAt(0,QColor(c1)); gradient.setColorAt(1,QColor(c2));
                        painter.fillRect(QRectF(x1,y1,x2-x1,y2-y1),gradient);
                    });
        } else if (overview && mode!=2) {
            const auto& preview=mode==0 && !native->overview[1].columns.isEmpty()?native->overview[1]:series;
            renderPreviewColumns(preview,static_cast<WaveformMode>(mode),image.width(),image.height(),{1,1,1},
                    [&](float x1,float y1,float x2,float y2,QRgb c1,QRgb c2) {
                        QLinearGradient gradient(0,y1,0,y2);
                        gradient.setColorAt(0,QColor(c1)); gradient.setColorAt(1,QColor(c2));
                        painter.fillRect(QRectF(x1,y1,x2-x1,y2-y1),gradient);
                    });
        } else renderColumns(series, static_cast<WaveformMode>(mode), job["first_second"].toDouble(),
                job["last_second"].toDouble(), image.width(), overview?std::min(28,image.height()-1):image.height(), overview, {1,1,1},
                [&](float x1, float y1, float x2, float y2, QRgb color) {
                    const float offset=overview?image.height()-1-std::min(28,image.height()-1):0;
                    painter.fillRect(QRectF(x1, offset+std::floor(y1), x2-x1, std::ceil(y2)-std::floor(y1)), QColor(color));
                });
        painter.end();
        ASSERT_TRUE(image.save(job["output"].toString()));
    }
}

TEST(RekordboxWaveformImporterTest, BrowserStylesPreferTheirOwnNativePayload) {
    EXPECT_LT(previewWaveformPriority("PWV6", WaveformMode::ThreeBand),
            previewWaveformPriority("PWV4", WaveformMode::ThreeBand));
    EXPECT_LT(previewWaveformPriority("PWV4", WaveformMode::RGB),
            previewWaveformPriority("PWV6", WaveformMode::RGB));
    EXPECT_LT(previewWaveformPriority("PWV4", WaveformMode::Blue),
            previewWaveformPriority("PWAV", WaveformMode::Blue));
    EXPECT_LT(previewWaveformPriority("PWAV", WaveformMode::Blue),
            previewWaveformPriority("PWV6", WaveformMode::Blue));
    EXPECT_EQ(100, previewWaveformPriority("UNKNOWN", WaveformMode::RGB));
}

TEST(RekordboxWaveformImporterTest, BrowserReductionPreservesPeakColorAndWhiteness) {
    const QByteArray payload = QByteArray::fromHex("640064500a00c80000a0000a");
    const LoadedRuntimeWaveform source{descriptor("PWV4", RuntimeWaveformQuality::Preview, 6, 2), payload};
    const auto full = decodeRuntimeWaveformColumns(source);
    const auto reduced = decodeRuntimeWaveformColumns(source,1);
    ASSERT_EQ(2, full.size()); ASSERT_EQ(1, reduced.size());
    EXPECT_EQ(full[1].all, reduced[0].all);
    EXPECT_EQ(full[1].low, reduced[0].low);
    EXPECT_EQ(full[1].mid, reduced[0].mid);
    EXPECT_EQ(full[1].high, reduced[0].high);
    EXPECT_EQ(255, reduced[0].whiteness);
}

RuntimeAnlzSection phraseFixture(bool masked, quint16 mood=2) {
    QByteArray bytes(32+3*24,'\0');
    bytes.replace(0,4,"PSSI");
    qToBigEndian<quint32>(32,bytes.data()+4);
    qToBigEndian<quint32>(bytes.size(),bytes.data()+8);
    qToBigEndian<quint32>(24,bytes.data()+12);
    qToBigEndian<quint16>(3,bytes.data()+16);
    qToBigEndian<quint16>(mood,bytes.data()+18);
    qToBigEndian<quint16>(11,bytes.data()+26);
    const int starts[]{1,5,8};
    const int kinds[]{1,2,mood==1?5:9};
    for (int i=0;i<3;++i) {
        qToBigEndian<quint16>(i+1,bytes.data()+32+i*24);
        qToBigEndian<quint16>(starts[i],bytes.data()+34+i*24);
        qToBigEndian<quint16>(kinds[i],bytes.data()+36+i*24);
    }
    if (masked) {
        const QByteArray key=QByteArray::fromHex("cbe1eefae5eeadeee9d2e9ebe1e9f3e8e9f4e1");
        for(int i=18;i<bytes.size();++i) bytes[i]=char(quint8(bytes[i])^quint8(quint8(key[(i-18)%key.size()])+3));
    }
    return {"PSSI",32,bytes};
}
QList<RuntimeBeat> phraseBeats() {
    QList<RuntimeBeat> beats;
    for (quint32 time : {0,500,1000,1500,2000,3000,4000,5000,6000,7000})
        beats.append({time,1,12000});
    return beats;
}
TEST(RekordboxWaveformImporterTest, PlainAndMaskedPhrasesFollowOriginalVariableTempoGrid) {
    for (bool masked : {false,true}) {
        for (quint16 mood : {1,2,3}) {
            const auto phrases=decodeRekordboxPhrases({phraseFixture(masked,mood)},phraseBeats(),-.02);
            ASSERT_EQ(3,phrases.size());
            EXPECT_DOUBLE_EQ(-.02,phrases[0].startSeconds);
            EXPECT_DOUBLE_EQ(1.98,phrases[0].endSeconds);
            EXPECT_DOUBLE_EQ(4.98,phrases[1].endSeconds);
            EXPECT_DOUBLE_EQ(7.98,phrases[2].endSeconds);
            EXPECT_EQ(PhraseKind::Intro,phrases[0].kind);
            EXPECT_EQ(mood==1?PhraseKind::Up:PhraseKind::Verse,phrases[1].kind);
            EXPECT_EQ(PhraseKind::Chorus,phrases[2].kind);
        }
    }
}
TEST(RekordboxWaveformImporterTest, RejectsTruncatedPhraseDataAndBadBeatIndices) {
    const auto valid=phraseFixture(false);
    for (int size=0;size<valid.bytes.size();++size) {
        auto truncated=valid;truncated.bytes.truncate(size);
        EXPECT_TRUE(decodeRekordboxPhrases({truncated},phraseBeats()).isEmpty());
    }
    auto bad=valid;
    qToBigEndian<quint16>(0,bad.bytes.data()+34);
    EXPECT_TRUE(decodeRekordboxPhrases({bad},phraseBeats()).isEmpty());
    bad=valid;qToBigEndian<quint16>(65535,bad.bytes.data()+16);
    EXPECT_TRUE(decodeRekordboxPhrases({bad},phraseBeats()).isEmpty());
    bad=valid;qToBigEndian<quint16>(99,bad.bytes.data()+26);
    EXPECT_TRUE(decodeRekordboxPhrases({bad},phraseBeats()).isEmpty());
    EXPECT_TRUE(decodeRekordboxPhrases({valid},{}).isEmpty());
    EXPECT_TRUE(decodeRekordboxPhrases({},phraseBeats()).isEmpty());
}
TEST(RekordboxWaveformImporterTest, PhraseMetadataIsSharedByDetailAndOverviewAndUsesDecoderOffset) {
    RekordboxWaveformImporter importer(QList<LoadedRuntimeWaveform>{
            {descriptor("PWV7",RuntimeWaveformQuality::Detailed,3,1500),QByteArray(4500,char(100))}},
            {phraseFixture(true)},phraseBeats());
    importer.setSourceTimingOffsetMillis(-20);
    const auto imported=importer.importWaveforms(streamInfo(10));
    ASSERT_TRUE(imported.waveform);ASSERT_TRUE(imported.summary);
    ASSERT_EQ(imported.waveform->rekordbox,imported.summary->rekordbox);
    ASSERT_EQ(3,imported.summary->rekordbox->phrases.size());
    EXPECT_DOUBLE_EQ(1.98,imported.summary->rekordbox->phrases[1].startSeconds);
}

TEST(RekordboxWaveformImporterTest, OptionalRealPhrasesReadOnly) {
    const auto root=QString::fromLocal8Bit(qgetenv("MIXXX_REKORDBOX_PHRASE_FIXTURE"));
    if (root.isEmpty()) GTEST_SKIP()<<"External Rekordbox phrase export unavailable";
    QDirIterator files(QDir(root).filePath("PIONEER/USBANLZ"),{"*.EXT"},
            QDir::Files,QDirIterator::Subdirectories);
    int decoded=0;
    int visited=0;
    while (files.hasNext() && decoded<8 && visited++<100) {
        const auto path=files.next();
        auto datPath=path; datPath.chop(4);datPath+=".DAT";
        const auto ext=readAnlzFile(path,AnlzWaveformReadMode::Descriptor);
        const auto dat=readAnlzFile(datPath,AnlzWaveformReadMode::Descriptor);
        if (!ext.containerValid || !dat.containerValid || !ext.hasPathSection ||
                ext.exportedAudioPath!=dat.exportedAudioPath) continue;
        const auto& beats=dat.beats.isEmpty()?ext.beats:dat.beats;
        const auto phrases=decodeRekordboxPhrases(ext.unmappedSections,beats);
        if (phrases.isEmpty()) continue;
        ++decoded;
        for (int i=0;i<phrases.size();++i) {
            EXPECT_LT(phrases[i].startSeconds,phrases[i].endSeconds);
            if (i>0) EXPECT_DOUBLE_EQ(phrases[i-1].endSeconds,phrases[i].startSeconds);
        }
    }
    EXPECT_GT(decoded,0);
    qInfo()<<"Real read-only phrase exports validated:"<<decoded;
}

} // namespace
} // namespace mixxx::rekordbox
