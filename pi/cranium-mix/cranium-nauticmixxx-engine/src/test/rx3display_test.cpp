#include <gtest/gtest.h>
#include <QCoreApplication>
#include <QtTest>
#include <QLabel>
#include <QPointer>
#include <QPushButton>
#include <QStandardItemModel>
#include <QVBoxLayout>
#include "util/fpclassify.h"
#include "control/controlpotmeter.h"
#include "test/mixxxtest.h"
#include "widget/rx3displayformat.h"
#include "widget/wreferencescaler.h"
#include "track/beats.h"

TEST(Rx3Display, TimeUsesThreeDecimalsAndCarriesMinutes) {
    EXPECT_EQ(QStringLiteral("00:00.000"), rx3::time(0));
    EXPECT_EQ(QStringLiteral("04:21.799"), rx3::time(261.799));
    EXPECT_EQ(QStringLiteral("00:59.999"), rx3::time(59.9999));
    EXPECT_EQ(QStringLiteral("01:00.000"), rx3::time(60));
    EXPECT_EQ(QStringLiteral("01:02:03"), rx3::time(3723.9, true));
    EXPECT_EQ(QStringLiteral("00:00.000"), rx3::time(util_double_nan()));
}
TEST(Rx3Display, BeatMillisecondsNeverShowsInfinity) {
    EXPECT_EQ(QStringLiteral("500"), rx3::beatMilliseconds(120));
    EXPECT_EQ(QStringLiteral("483"), rx3::beatMilliseconds(124));
    EXPECT_EQ(QStringLiteral("689"), rx3::beatMilliseconds(87));
    EXPECT_EQ(QStringLiteral("—"), rx3::beatMilliseconds(0));
    EXPECT_EQ(QStringLiteral("—"), rx3::beatMilliseconds(-1));
}
TEST(Rx3Display, BarsFollowTheBeatGridAcrossTempoChanges) {
    using namespace mixxx;
    const auto rate = audio::SampleRate(48000);
    const auto grid = Beats::fromBeatPositions(rate, {audio::FramePos(0), audio::FramePos(24000),
            audio::FramePos(48000), audio::FramePos(72000), audio::FramePos(96000),
            audio::FramePos(144000), audio::FramePos(192000)});
    ASSERT_TRUE(grid);
    auto beat = grid->iteratorFrom(audio::FramePos(168000));
    if (*beat > audio::FramePos(168000)) --beat;
    EXPECT_EQ(QStringLiteral("02.2"), rx3::bars(beat - grid->cfirstmarker()));
    EXPECT_EQ(QStringLiteral("01.1"), rx3::bars(0));
    EXPECT_EQ(QStringLiteral("02.1"), rx3::bars(4));
    EXPECT_EQ(QStringLiteral("—"), rx3::bars(-1));
}
class Rx3ReferenceScaleTest : public MixxxTest {};
namespace {
class DragTestViewport : public WReferenceScaler {
  public:
    explicit DragTestViewport(QWidget* canvas)
            : WReferenceScaler(canvas, QSize(1280, 800), nullptr, true) {
        setWindowFlag(Qt::FramelessWindowHint);
    }
    int moveRequests = 0;
    bool systemMoveSupported = true;
  protected:
    bool startWindowMove() override {
        ++moveRequests;
        return systemMoveSupported;
    }
};
void sendDragMouse(QWidget* target, QEvent::Type type, QPoint global,
        Qt::MouseButton button, Qt::MouseButtons buttons) {
    QMouseEvent event(type, target->mapFromGlobal(global), global, button, buttons,
            Qt::NoModifier);
    QCoreApplication::sendEvent(target, &event);
}
}

TEST_F(Rx3ReferenceScaleTest, FramelessDragUsesOnlyEmptyTopMarginAndPreservesRemain) {
    auto* canvas = new QWidget;
    auto* skinContainer = new QWidget(canvas);
    skinContainer->setObjectName(QStringLiteral("SkinContainer"));
    skinContainer->setGeometry(0, 0, 1280, 800);
    auto* remain = new QPushButton(QStringLiteral("REMAIN"), skinContainer);
    // Deliberately overlap the 10 px strip, as can happen at a smaller scale.
    remain->setGeometry(20, 6, 540, 28);
    QSignalSpy clicks(remain, &QPushButton::clicked);
    DragTestViewport viewport(canvas);
    viewport.show();
    QCoreApplication::processEvents();
    for (QPoint point : {QPoint(600, 0), QPoint(600, 9)}) {
        QTest::mouseClick(canvas, Qt::LeftButton, Qt::NoModifier, point);
    }
    EXPECT_EQ(2, viewport.moveRequests);
    QTest::mouseClick(skinContainer, Qt::LeftButton, Qt::NoModifier, QPoint(600, 5));
    EXPECT_EQ(3, viewport.moveRequests);
    for (QPoint point : {QPoint(600, 10), QPoint(600, 40), QPoint(5, 5),
                 QPoint(1275, 5), QPoint(30, 8)}) {
        QTest::mouseClick(canvas, Qt::LeftButton, Qt::NoModifier, point);
    }
    QTest::mouseClick(canvas, Qt::RightButton, Qt::NoModifier, QPoint(600, 5));
    EXPECT_EQ(3, viewport.moveRequests);
    QTest::mouseClick(remain, Qt::LeftButton);
    EXPECT_EQ(1, clicks.count());
    EXPECT_EQ(3, viewport.moveRequests);
    viewport.showFullScreen();
    QCoreApplication::processEvents();
    QTest::mouseClick(canvas, Qt::LeftButton, Qt::NoModifier, QPoint(600, 5));
    EXPECT_EQ(3, viewport.moveRequests);
    viewport.showNormal();
    viewport.setWindowFlag(Qt::FramelessWindowHint, false);
    viewport.show();
    QCoreApplication::processEvents();
    QTest::mouseClick(canvas, Qt::LeftButton, Qt::NoModifier, QPoint(600, 5));
    EXPECT_EQ(3, viewport.moveRequests);
}

TEST_F(Rx3ReferenceScaleTest, DragFallbackMovesWindowAndEndsOnRelease) {
    auto* canvas = new QWidget;
    DragTestViewport viewport(canvas);
    viewport.systemMoveSupported = false;
    viewport.show();
    viewport.move(50, 80);
    QCoreApplication::processEvents();
    const QPoint origin = viewport.pos();
    const QPoint press = canvas->mapToGlobal(QPoint(600, 5));
    sendDragMouse(canvas, QEvent::MouseButtonPress, press, Qt::LeftButton, Qt::LeftButton);
    sendDragMouse(&viewport, QEvent::MouseMove, press + QPoint(90, 60),
            Qt::NoButton, Qt::LeftButton);
    EXPECT_EQ(origin + QPoint(90, 60), viewport.pos());
    sendDragMouse(&viewport, QEvent::MouseButtonRelease, press + QPoint(90, 60),
            Qt::LeftButton, Qt::NoButton);
    sendDragMouse(&viewport, QEvent::MouseMove, press + QPoint(180, 120),
            Qt::NoButton, Qt::NoButton);
    EXPECT_EQ(origin + QPoint(90, 60), viewport.pos());
    EXPECT_EQ(1, viewport.moveRequests);
    EXPECT_NE(&viewport, QWidget::mouseGrabber());
}

TEST_F(Rx3ReferenceScaleTest, ResizesUniformlyWithoutRecreatingWidgetsOrDrifting) {
    auto* canvas = new QWidget;
    canvas->setFixedSize(1280, 800);
    canvas->setStyleSheet(QStringLiteral("QLabel { font-size:20px; color:#ff8800; }"));
    QPointer<QLabel> label = new QLabel(QStringLiteral("120.0"), canvas);
    label->setFixedSize(120,40);
    label->setProperty("testControlValue", 7);
    WReferenceScaler viewport(canvas, QSize(1280,800), nullptr);
    viewport.show();
    QCoreApplication::processEvents();
    for (int repeat = 0; repeat < 3; ++repeat) {
        viewport.resize(1920,1080);
        QCoreApplication::processEvents();
        EXPECT_NEAR(1.35, viewport.scale(), 0.001);
        EXPECT_EQ(QSize(1728,1080), canvas->size());
        EXPECT_EQ(QPoint(96,0), canvas->pos());
        EXPECT_EQ(QSize(162,54), label->size());
        viewport.resize(1024,640);
        QCoreApplication::processEvents();
        EXPECT_NEAR(0.8, viewport.scale(), 0.001);
        EXPECT_EQ(QSize(96,32), label->size());
        viewport.resize(1280,800);
        QCoreApplication::processEvents();
        EXPECT_EQ(QSize(120,40), label->size());
        EXPECT_TRUE(canvas->styleSheet().contains(QStringLiteral("font-size:20px")));
        ASSERT_TRUE(label);
        EXPECT_EQ(7, label->property("testControlValue").toInt());
    }
}

#include "widget/rx3displaystate.h"
TEST_F(Rx3ReferenceScaleTest, FillWindowUsesEveryPixelAcrossAspectRatios) {
    auto* canvas = new QWidget;
    canvas->setMinimumSize(1280, 800);
    auto* layout = new QVBoxLayout(canvas);
    layout->setContentsMargins(0, 0, 0, 0);
    QPointer<QLabel> label = new QLabel(QStringLiteral("120.0"), canvas);
    label->setFixedHeight(40);
    label->setProperty("testControlValue", 7);
    layout->addWidget(label);
    WReferenceScaler viewport(canvas, QSize(1280, 800), nullptr, true);
    viewport.show();
    for (int repeat = 0; repeat < 3; ++repeat) {
        // The first two sizes deliberately have the same scale factor.
        for (QSize size : {QSize(1280, 800), QSize(1440, 800),
                     QSize(1920, 1080), QSize(1024, 640), QSize(800, 480), QSize(1280, 800)}) {
            viewport.resize(size);
            QCoreApplication::processEvents();
            EXPECT_EQ(size, canvas->size());
            EXPECT_EQ(QPoint(0, 0), canvas->pos());
            EXPECT_EQ(size.width(), label->width());
            EXPECT_EQ(qRound(40 * viewport.scale()), label->height());
            EXPECT_EQ(7, label->property("testControlValue").toInt());
        }
    }
}

TEST(Rx3Display, LoopSizesIncludeFractions) {
    EXPECT_EQ(QStringLiteral("2"), rx3::loop(2));
    EXPECT_EQ(QStringLiteral("1/2"), rx3::loop(0.5));
    EXPECT_EQ(QStringLiteral("1/128"), rx3::loop(1.0 / 128));
    EXPECT_EQ(QStringLiteral("0.75"), rx3::loop(0.75));
    EXPECT_TRUE(rx3::loop(0).isEmpty());
}
TEST_F(Rx3ReferenceScaleTest, MasterFollowsPlaybackWithoutChangingEngineControls) {
    std::vector<std::unique_ptr<ControlObject>> inputs;
    for (const auto& group : {QStringLiteral("[Channel1]"), QStringLiteral("[Channel2]")}) {
        for (const auto& key : {QStringLiteral("play"), QStringLiteral("track_loaded"),
                     QStringLiteral("sync_leader"), QStringLiteral("visual_bpm")})
            inputs.push_back(std::make_unique<ControlObject>(ConfigKey(group, key)));
    }
    Rx3DisplayState display;
    ControlProxy first(QStringLiteral("[RX3Display]"), QStringLiteral("master1"));
    ControlProxy second(QStringLiteral("[RX3Display]"), QStringLiteral("master2"));
    first.connectValueChanged(&display, [&](double) { EXPECT_LE(first.get() + second.get(), 1); });
    second.connectValueChanged(&display, [&](double) { EXPECT_LE(first.get() + second.get(), 1); });
    auto set = [&](int deck, const QString& key, double value) {
        ControlObject::getControl(QStringLiteral("[Channel%1]").arg(deck), key)->set(value);
        QCoreApplication::processEvents();
    };
    EXPECT_EQ(0, display.masterDeck());
    set(1, QStringLiteral("track_loaded"), 1);
    set(1, QStringLiteral("visual_bpm"), 122);
    set(1, QStringLiteral("play"), 1);
    set(2, QStringLiteral("track_loaded"), 1);
    set(2, QStringLiteral("visual_bpm"), 128);
    set(2, QStringLiteral("play"), 1);
    EXPECT_EQ(1, display.masterDeck());
    set(1, QStringLiteral("play"), 0);
    EXPECT_EQ(2, display.masterDeck());
    EXPECT_EQ(128, ControlObject::get(ConfigKey("[RX3Display]", "master_bpm")));
    set(1, QStringLiteral("play"), 1);
    EXPECT_EQ(2, display.masterDeck());
    set(2, QStringLiteral("play"), 0);
    EXPECT_EQ(1, display.masterDeck());
    set(1, QStringLiteral("track_loaded"), 0);
    EXPECT_EQ(2, display.masterDeck());
    set(2, QStringLiteral("track_loaded"), 0);
    EXPECT_EQ(0, display.masterDeck());
    EXPECT_EQ(0, ControlObject::get(ConfigKey("[Channel1]", "sync_leader")));
    EXPECT_EQ(122, ControlObject::get(ConfigKey("[Channel1]", "visual_bpm")));
}

TEST_F(Rx3ReferenceScaleTest, SuccessfulDeckLoadAutoClosesBrowser) {
    std::vector<std::unique_ptr<ControlObject>> inputs;
    for (const auto& group : {QStringLiteral("[Channel1]"), QStringLiteral("[Channel2]")}) {
        for (const auto& key : {QStringLiteral("play"), QStringLiteral("track_loaded"),
                     QStringLiteral("sync_leader"), QStringLiteral("visual_bpm")}) {
            inputs.push_back(std::make_unique<ControlObject>(ConfigKey(group, key)));
        }
    }
    ControlObject tabCurrent(ConfigKey(QStringLiteral("[Tab]"), QStringLiteral("current")));
    ControlObject autoClose(ConfigKey(
            QStringLiteral("[RX3Browser]"), QStringLiteral("auto_close_on_load")));
    tabCurrent.set(1);
    autoClose.set(1);

    Rx3DisplayState display;
    auto setLoaded = [&](int deck, double value) {
        ControlObject::getControl(ConfigKey(
                QStringLiteral("[Channel%1]").arg(deck), QStringLiteral("track_loaded")))
                ->set(value);
        QCoreApplication::processEvents();
    };

    // Unloading or a failed load must not hide the browser.
    setLoaded(1, 0);
    EXPECT_EQ(1, tabCurrent.get());

    // A successful load is the rising edge of track_loaded.
    setLoaded(1, 1);
    EXPECT_EQ(0, tabCurrent.get());

    // Replacing a track does not produce another track_loaded rising edge.
    // BaseTrackPlayer::newTrackLoaded must still close the browser.
    tabCurrent.set(1);
    display.trackLoadSucceeded();
    EXPECT_EQ(0, tabCurrent.get());

    // The policy is presentation-only and can be disabled without affecting
    // the actual deck load state.
    tabCurrent.set(1);
    autoClose.set(0);
    setLoaded(2, 1);
    EXPECT_EQ(1, tabCurrent.get());
    EXPECT_EQ(1, ControlObject::get(
                         ConfigKey(QStringLiteral("[Channel2]"),
                                 QStringLiteral("track_loaded"))));
}

#include "skin/legacy/skincontext.h"
#include "waveform/renderers/waveformmark.h"
#include "waveform/renderers/waveformsignalcolors.h"
#include "waveform/beatgridmarkers.h"
class Rx3HotcueTest : public MixxxTest {};
TEST_F(Rx3HotcueTest, PlayheadWidthIsOptInAndRejectsInvalidValues) {
    SkinContext context(config(), QString());
    WaveformSignalColors colors;
    for (const QString& value : {QStringLiteral("2"), QStringLiteral(""),
                 QStringLiteral("invalid"), QStringLiteral("-1"), QStringLiteral("99")}) {
        QDomDocument doc;
        ASSERT_TRUE(doc.setContent(QStringLiteral(
                "<Visual><PlayPosColor>#ff0000</PlayPosColor>"
                "<PlayPosWidth>%1</PlayPosWidth></Visual>").arg(value)));
        colors.setup(doc.documentElement(), context);
        EXPECT_EQ(QColor("#ff0000"), colors.getPlayPosColor());
        const int expected = value == "2" ? 2 : value == "99" ? 4 : 1;
        EXPECT_EQ(expected, colors.getPlayPosWidth());
    }
    QDomDocument legacy;
    ASSERT_TRUE(legacy.setContent(QStringLiteral("<Visual/>")));
    colors.setup(legacy.documentElement(), context);
    EXPECT_EQ(1, colors.getPlayPosWidth());
}

TEST_F(Rx3HotcueTest, PairedBadgesLeaveSignalTransparentAtBothPixelRatios) {
    ControlObject position(ConfigKey("[Channel1]","hotcue_1_position"));
    SkinContext context(config(), QString());
    QDomDocument doc;
    ASSERT_TRUE(doc.setContent(QStringLiteral("<DefaultMark><Rx3Hotcue>true</Rx3Hotcue><Color>#00ff00</Color><TextColor>#000000</TextColor></DefaultMark>")));
    WaveformSignalColors colors;
    for(float ratio : {1.f,2.f}) {
        WaveformMark mark("[Channel1]",doc.documentElement(),context,0,colors,0);
        mark.setBreadth(200);
        EXPECT_TRUE(mark.rx3Hotcue()); EXPECT_EQ(QStringLiteral("A"),mark.rx3Label());
        const auto image=mark.generateImage(ratio);
        EXPECT_EQ(255,image.pixelColor(qRound(2*ratio),qRound(2*ratio)).alpha());
        EXPECT_EQ(255,image.pixelColor(qRound(2*ratio),qRound(190*ratio)).alpha());
        for(int x=0;x<image.width();++x) EXPECT_EQ(0,image.pixelColor(x,qRound(100*ratio)).alpha());
        EXPECT_EQ(0,image.pixelColor(qRound(2*ratio),qRound(12*ratio)).alpha());
        const auto red = mixxx::beatgrid::edgeTicks(200, 1, 10, true);
        QImage composite(image.size(), image.format());
        composite.setDevicePixelRatio(ratio);
        composite.fill(Qt::transparent);
        QPainter painter(&composite);
        painter.fillRect(QRectF(7, red.topStart, 1, red.topEnd-red.topStart), Qt::red);
        painter.fillRect(QRectF(7, red.bottomStart, 1, red.bottomEnd-red.bottomStart), Qt::red);
        painter.drawImage(QPointF(0,0), image);
        painter.end();
        EXPECT_EQ(QColor(Qt::red),composite.pixelColor(qRound(7*ratio),qRound(13*ratio)));
        EXPECT_EQ(QColor(Qt::red),composite.pixelColor(qRound(7*ratio),qRound(186*ratio)));
    }
}
TEST_F(Rx3HotcueTest, StandardSkinsRetainContinuousMarkerAndNumericLabels) {
    ControlObject position(ConfigKey("[Channel1]","hotcue_2_position"));
    SkinContext context(config(), QString()); QDomDocument doc;
    ASSERT_TRUE(doc.setContent(QStringLiteral("<DefaultMark><Color>#00ffff</Color><TextColor>#000000</TextColor></DefaultMark>")));
    WaveformSignalColors colors;
    WaveformMark mark("[Channel1]",doc.documentElement(),context,0,colors,1);
    mark.setBreadth(200); EXPECT_FALSE(mark.rx3Hotcue());
    const auto image=mark.generateImage(1);
    EXPECT_GT(image.pixelColor(qRound(mark.m_linePosition),100).alpha(),0);
}
TEST_F(Rx3HotcueTest, LabelsAndWaveformMarkersUseFixedRx3Palette) {
    SkinContext context(config(), QString()); QDomDocument doc;
    ASSERT_TRUE(doc.setContent(QStringLiteral("<DefaultMark><Rx3Hotcue>true</Rx3Hotcue><Color>#00ff00</Color></DefaultMark>")));
    WaveformSignalColors colors;
    WaveformMark mark("[Channel1]",doc.documentElement(),context,0,colors,7);
    EXPECT_EQ(QStringLiteral("H"),mark.rx3Label());
    mark.setBreadth(200); mark.setBaseColor(QColor("#cc00ff"),128);
    mark.generateImage(1);
    EXPECT_EQ(QColor("#c3af04"),mark.fillColor());
}

#include "widget/rx3waveform.h"
TEST(Rx3Overview, MeasuredBandsRiseFromBlueBaselineToWhiteEnvelope) {
    QImage image(8, 120, QImage::Format_ARGB32_Premultiplied);
    image.fill(Qt::transparent);
    QPainter painter(&image);
    rx3::drawSummaryColumn(&painter, 3, 110, 1, 90, 30, 30, 30);
    painter.end();
    EXPECT_EQ(QColor("#0055e1"), image.pixelColor(3, 100));
    EXPECT_EQ(QColor("#f0a000"), image.pixelColor(3, 65));
    EXPECT_EQ(QColor("#ffffff"), image.pixelColor(3, 25));
    EXPECT_EQ(0, image.pixelColor(3, 10).alpha());
    EXPECT_EQ(0, image.pixelColor(3, 115).alpha());
}
TEST(Rx3Overview, SilenceIsTransparentAndBandOnlyAudioKeepsItsColor) {
    QImage image(8, 120, QImage::Format_ARGB32_Premultiplied);
    image.fill(Qt::transparent);
    QPainter painter(&image);
    rx3::drawSummaryColumn(&painter, 1, 110, 1, 0, 0, 0, 0);
    rx3::drawSummaryColumn(&painter, 3, 110, 1, 90, 90, 0, 0);
    rx3::drawSummaryColumn(&painter, 5, 110, 1, 90, 0, 0, 90);
    painter.end();
    for (int y=0; y<image.height(); ++y) EXPECT_EQ(0, image.pixelColor(1,y).alpha());
    EXPECT_EQ(QColor("#0055e1"), image.pixelColor(3, 25));
    EXPECT_EQ(QColor("#ffffff"), image.pixelColor(5, 100));
}

#include "widget/whotcuebutton.h"
#include "widget/controlwidgetconnection.h"
TEST_F(Rx3HotcueTest, AssignedPadsUseFixedRx3PaletteAndEmptyPadsUseWhite) {
    const QColor expected[] = {QColor("#ff376f"), QColor("#45acdb"),
            QColor("#7dc13d"), QColor("#aa72ff"), QColor("#30d26e"),
            QColor("#e0641b"), QColor("#305aff"), QColor("#c3af04")};
    SkinContext context(config(), QString());
    for (int hotcue = 1; hotcue <= 8; ++hotcue) {
        const QString prefix = QStringLiteral("hotcue_%1_").arg(hotcue);
        ControlObject color(ConfigKey("[Channel1]", prefix + "color"));
        ControlObject type(ConfigKey("[Channel1]", prefix + "type"));
        ControlObject enabled(ConfigKey("[Channel1]", prefix + "enabled"));
        QDomDocument doc;
        ASSERT_TRUE(doc.setContent(QStringLiteral(
                "<HotcueButton><Rx3Badge>true</Rx3Badge><Hotcue>%1</Hotcue>"
                "<NumberStates>2</NumberStates></HotcueButton>").arg(hotcue)));
        WHotcueButton button("[Channel1]", nullptr);
        button.setup(doc.documentElement(), context);
        auto* connection = new ControlParameterWidgetConnection(&button,
                enabled.getKey(), nullptr,
                ControlParameterWidgetConnection::DIR_FROM_AND_TO_WIDGET,
                ControlParameterWidgetConnection::EMIT_ON_PRESS_AND_RELEASE);
        button.addConnection(connection);
        button.setDisplayConnection(connection);
        button.resize(120, 40);
        QFont font("Arial");
        font.setPixelSize(28);
        button.setFont(font);
        const auto countPixels = [&](const QColor& target) {
            const QImage image = button.grab().toImage();
            int count = 0;
            for (int y = 0; y < image.height(); ++y) {
                for (int x = 0; x < image.width(); ++x) {
                    if (image.pixelColor(x, y) == target) {
                        ++count;
                    }
                }
            }
            return count;
        };
        color.set(0x010203);
        enabled.set(1);
        QCoreApplication::processEvents();
        EXPECT_GT(countPixels(expected[hotcue - 1]), 0);
        EXPECT_GT(countPixels(Qt::black), 0);
        EXPECT_EQ(countPixels(Qt::white), 0);
        enabled.set(0);
        QCoreApplication::processEvents();
        EXPECT_GT(countPixels(Qt::white), 0);
    }
}

TEST_F(Rx3HotcueTest, PlayheadIsRedWhenStoppedAndWhiteWhenPlaying) {
    SkinContext context(config(), QString());
    QDomDocument doc;
    ASSERT_TRUE(doc.setContent(QStringLiteral("<Visual><PlayPosColor>#ffffff</PlayPosColor>"
            "<PlayPosStoppedColor>#ff0000</PlayPosStoppedColor><PlayPosWidth>2</PlayPosWidth></Visual>")));
    WaveformSignalColors colors;
    colors.setup(doc.documentElement(), context);
    EXPECT_EQ(QColor(Qt::red), colors.getPlayPosColor(false));
    EXPECT_EQ(QColor(Qt::white), colors.getPlayPosColor(true));
    EXPECT_EQ(2, colors.getPlayPosWidth());
    // Other skins keep their static color when they omit the new option.
    ASSERT_TRUE(doc.setContent(QStringLiteral("<Visual><PlayPosColor>#123456</PlayPosColor></Visual>")));
    colors.setup(doc.documentElement(), context);
    EXPECT_EQ(QColor("#123456"), colors.getPlayPosColor(false));
    EXPECT_EQ(QColor("#123456"), colors.getPlayPosColor(true));
    EXPECT_EQ(QColor("#FFFF00"), colors.getPlayPosColor(true, true));
    EXPECT_EQ(QColor("#FFFF00"), colors.getPlayPosColor(false, true));
}

TEST_F(Rx3HotcueTest, CueAndLoopStartRenderOnlySmallWhiteTriangle) {
    SkinContext context(config(), QString());
    WaveformSignalColors colors;
    for (const QString& key : {QStringLiteral("cue_point"), QStringLiteral("loop_start_position")}) {
        ControlObject position(ConfigKey("[Channel1]", key));
        QDomDocument doc;
        ASSERT_TRUE(doc.setContent(QStringLiteral("<Mark><Control>%1</Control>"
                "<Rx3Triangle>true</Rx3Triangle><Color>#ffffff</Color><Align>bottom</Align></Mark>").arg(key)));
        WaveformMark mark("[Channel1]", doc.documentElement(), context, 0, colors, Cue::kNoHotCue);
        mark.setBreadth(100);
        ASSERT_TRUE(mark.rx3Triangle());
        for (float ratio : {1.f, 2.f}) {
            const auto image = mark.generateImage(ratio);
            EXPECT_EQ(QSize(qRound(9*ratio), qRound(100*ratio)), image.size());
            int whitePixels = 0;
            for (int y = 0; y < image.height(); ++y) {
                for (int x = 0; x < image.width(); ++x) {
                    const auto pixel = image.pixelColor(x,y);
                    if (!pixel.alpha()) continue;
                    EXPECT_GE(y, qRound(92*ratio));
                    EXPECT_EQ(QColor(Qt::white), pixel);
                    ++whitePixels;
                }
            }
            EXPECT_GT(whitePixels, 10*ratio*ratio);
            EXPECT_LT(whitePixels, 60*ratio*ratio);
        }
    }
}

TEST(Rx3Overview, SummaryUsesGlobalBlueAndRgbModesWithoutThreeBandColors) {
    using Mode = mixxx::rekordbox::WaveformMode;
    for (auto mode : {Mode::Blue, Mode::RGB}) {
        QImage image(8, 120, QImage::Format_ARGB32_Premultiplied);
        image.fill(Qt::transparent);
        QPainter painter(&image);
        rx3::drawSummaryColumn(&painter,3,110,1,90,90,30,10,mode);
        painter.end();
        const QColor expected = mode == Mode::Blue ? QColor("#1d6fe0") : QColor(90,30,10);
        EXPECT_EQ(expected, image.pixelColor(3,100));
        EXPECT_EQ(expected, image.pixelColor(3,30));
        EXPECT_EQ(0, image.pixelColor(3,10).alpha());
    }
    EXPECT_EQ(Mode::Blue, rx3::waveformModeForType(WaveformWidgetType::AllShaderSimpleWaveform));
    EXPECT_EQ(Mode::RGB, rx3::waveformModeForType(WaveformWidgetType::AllShaderRGBWaveform));
    EXPECT_EQ(Mode::ThreeBand, rx3::waveformModeForType(WaveformWidgetType::AllShaderFilteredWaveform));
}

TEST(Rx3Overview, TimeScaleMarksEveryThirtySecondsBelowThickAxis) {
    for (int dpr : {1,2}) {
        QImage image(302*dpr,80*dpr,QImage::Format_ARGB32_Premultiplied);
        image.setDevicePixelRatio(dpr); image.fill(Qt::black);
        QPainter painter(&image);
        rx3::drawOverviewDivisions(&painter,302,80,1,150,0,{},0.5);
        painter.end();
        for (int y : {64,65,66}) EXPECT_EQ(QColor(Qt::white),image.pixelColor(25*dpr,y*dpr));
        EXPECT_EQ(QColor(Qt::black),image.pixelColor(25*dpr,61*dpr));
        for (int x : {61,121,181,241}) EXPECT_EQ(QColor(Qt::white),image.pixelColor(x*dpr,73*dpr));
        EXPECT_EQ(QColor(Qt::black),image.pixelColor(91*dpr,73*dpr));
        EXPECT_EQ(QColor(Qt::white),image.pixelColor(121*dpr,77*dpr));
        EXPECT_EQ(QColor(Qt::black),image.pixelColor(61*dpr,77*dpr));
    }
}

TEST(Rx3Overview, AxisFollowsPlayheadIncludingSeekBackAndTrackEnds) {
    for (int dpr : {1,2}) {
        // Sequential positions also cover seeking back after reaching the end.
        for (double position : {0.0,0.25,0.5,1.0,0.25,-0.1,1.1,util_double_nan()}) {
            QImage image(300*dpr,80*dpr,QImage::Format_ARGB32_Premultiplied);
            image.setDevicePixelRatio(dpr); image.fill(Qt::black);
            QPainter painter(&image);
            rx3::drawOverviewDivisions(&painter,300,80,1,150,0,{},position);
            painter.end();
            const double progress=std::isfinite(position)?std::clamp(position,0.0,1.0):0;
            for (int x : {0,74,75,149,150,299}) {
                for (int y : {64,65,66}) {
                    EXPECT_EQ(x < 300*progress ? QColor(Qt::white) : QColor("#808080"),
                            image.pixelColor(x*dpr,y*dpr)) << position << " x=" << x;
                }
            }
        }
    }
}

TEST(Rx3Overview, PhraseModeUsesExportedIntervalsAndDoesNotInventMissingPhrases) {
    using namespace mixxx::rekordbox;
    const QVector<Phrase> phrases{{0,30,PhraseKind::Intro},{30,90,PhraseKind::Chorus}};
    for (int dpr : {1,2}) {
        for (bool available : {false,true}) {
            QImage image(302*dpr,80*dpr,QImage::Format_ARGB32_Premultiplied);
            image.setDevicePixelRatio(dpr); image.fill(Qt::black);
            QPainter painter(&image);
            rx3::drawOverviewDivisions(&painter,302,80,1,150,1,available?phrases:QVector<Phrase>{});
            painter.end();
            EXPECT_EQ(available?rx3::phraseColor(PhraseKind::Intro):QColor(Qt::black),image.pixelColor(30*dpr,76*dpr));
            EXPECT_EQ(available?rx3::phraseColor(PhraseKind::Chorus):QColor(Qt::black),image.pixelColor(90*dpr,76*dpr));
            EXPECT_EQ(QColor(Qt::black),image.pixelColor(220*dpr,76*dpr));
        }
    }
}

TEST(Rx3Overview, EveryLaterHotcueOverlapsEarlierSlotsRegardlessOfTimeOrder) {
    const QColor colors[]{QColor("#ff376f"),QColor("#45acdb"),QColor("#7dc13d"),QColor("#aa72ff"),
            QColor("#30d26e"),QColor("#e0641b"),QColor("#305aff"),QColor("#c3af04")};
    for (int dpr : {1,2}) {
        for (int later=1; later<8; ++later) {
            QImage image(100*dpr,80*dpr,QImage::Format_ARGB32_Premultiplied);
            image.setDevicePixelRatio(dpr);image.fill(Qt::black);
            QPainter painter(&image);
            // Reverse chronological/list order on purpose; letters decide stacking.
            rx3::drawOverviewHotcues(&painter,{{later,49,colors[later],QString()},
                    {later-1,50,colors[later-1],QString()}},100,80);
            painter.end();
            EXPECT_EQ(colors[later],image.pixelColor(50*dpr,5*dpr));
            EXPECT_EQ(colors[later],image.pixelColor(50*dpr,75*dpr));
            EXPECT_EQ(10,rx3::overviewHotcueRects(100,80,50)[0].height());
        }
    }
}


#include "preferences/dialog/dlgpreferences.h"
namespace {
class Rx3PreferenceFixturePage : public DlgPreferencePage {
  public:
    Rx3PreferenceFixturePage() : DlgPreferencePage(nullptr) {}
    void slotUpdate() override {}
    void slotApply() override {}
    void slotResetToDefaults() override {}
};
}
TEST_F(Rx3HotcueTest, DeletedControllerPreferencePageCannotLeaveDanglingValidationPointer) {
    DlgPreferences::PreferencesPage empty;
    EXPECT_EQ(nullptr, empty.pDlg.data());
    EXPECT_EQ(nullptr, empty.pTreeItem);
    auto page = std::make_unique<Rx3PreferenceFixturePage>();
    DlgPreferences::PreferencesPage stored(page.get(), nullptr);
    const auto copy = stored;
    EXPECT_EQ(page.get(), stored.pDlg.data());
    EXPECT_TRUE(stored.pDlg->okayToClose());
    page.reset();
    EXPECT_EQ(nullptr, stored.pDlg.data());
    EXPECT_EQ(nullptr, copy.pDlg.data());
}

#include "waveform/renderers/waveformwidgetrenderer.h"
#include "waveform/visualplayposition.h"
namespace {
class Rx3MarkerLayerRenderer : public WaveformWidgetRenderer {
  public:
    Rx3MarkerLayerRenderer() : WaveformWidgetRenderer("[Channel1]") {}
    void prepare() {
        m_width=100; m_height=100;
        m_audioSamplePerPixel=1;
        m_playMarkerPosition=.5;
        onPreRender(nullptr);
    }
};
}
TEST_F(Rx3HotcueTest, CueTriangleCoversThePlayheadAtTheSamePosition) {
    ControlObject position(ConfigKey("[Channel1]", "cue_point")); position.set(100);
    ControlObject play(ConfigKey("[Channel1]", "play"));
    ControlObject samples(ConfigKey("[Channel1]", "track_samples")); samples.set(200);
    ControlObject rate(ConfigKey("[Channel1]", "rate_ratio")); rate.set(1);
    ControlObject gain(ConfigKey("[Channel1]", "total_gain")); gain.set(1);
    auto visual = VisualPlayPosition::getVisualPlayPosition("[Channel1]");
    // A stationary published position needs no VSync clock or audio device.
    visual->set(.5,0,0,0,0,SlipModeState::Disabled,false,false,false,0,0,1,0);
    SkinContext context(config(),QString());
    QDomDocument doc;
    ASSERT_TRUE(doc.setContent(QStringLiteral("<Visual><PlayPosColor>#ffffff</PlayPosColor>"
            "<PlayPosStoppedColor>#ff0000</PlayPosStoppedColor><PlayPosWidth>2</PlayPosWidth>"
            "<Mark><Control>cue_point</Control><Rx3Triangle>true</Rx3Triangle><Color>#ffffff</Color></Mark></Visual>")));
    Rx3MarkerLayerRenderer renderer;
    ASSERT_TRUE(renderer.init());
    renderer.setup(doc.documentElement(),context); renderer.prepare();
    auto mark=WaveformMarkPointer::create("[Channel1]",doc.documentElement().firstChildElement("Mark"),
            context,0,*renderer.getWaveformSignalColors(),Cue::kNoHotCue);
    renderer.setMarkPositions({{mark,46}});
    for (int playing : {0,1}) {
        play.set(playing);
        for (int dpr : {1,2}) {
            QImage image(100*dpr,100*dpr,QImage::Format_ARGB32_Premultiplied);
            image.setDevicePixelRatio(dpr); image.fill(Qt::transparent);
            QPainter painter(&image); renderer.draw(&painter,nullptr); painter.end();
            EXPECT_EQ(QColor(Qt::white),image.pixelColor(50*dpr,96*dpr));
            EXPECT_EQ(QColor(playing ? Qt::white : Qt::red),image.pixelColor(50*dpr,50*dpr));
        }
    }
}

#include "widget/rx3browserplayback.h"
#include "widget/rx3browsericons.h"

TEST(Rx3BrowserPlayback, AuditionAndSeekingDoNotMarkTrackImmediately) {
    rx3::BrowserPlaybackLedger ledger;
    const QList<rx3::BrowserPlaybackLedger::Sample> playing{{"deck1", "track-a", true}};
    ledger.advance(playing, 0);
    EXPECT_TRUE(ledger.isPlaying("track-a"));
    for (int seconds=0; seconds<59; ++seconds) ledger.advance(playing, 1);
    EXPECT_FALSE(ledger.wasPlayed("track-a"));
    // A stalled UI/sleep interval must not be counted as listening time.
    ledger.advance(playing, 180);
    EXPECT_FALSE(ledger.wasPlayed("track-a"));
    ledger.advance(playing, 0.999);
    EXPECT_FALSE(ledger.wasPlayed("track-a"));
    ledger.advance(playing, 0.001);
    EXPECT_TRUE(ledger.wasPlayed("track-a"));
    ledger.advance({{"deck1", "track-a", false}}, 1);
    EXPECT_FALSE(ledger.isPlaying("track-a"));
    EXPECT_TRUE(ledger.wasPlayed("track-a"));
}
TEST(Rx3BrowserPlayback, PauseDoesNotCountAndReplacementStartsFromZero) {
    rx3::BrowserPlaybackLedger ledger;
    ledger.advance({{"deck1", "track-a", true}}, 0);
    for (int i=0;i<30;++i) ledger.advance({{"deck1", "track-a", true}}, 1);
    for (int i=0;i<90;++i) ledger.advance({{"deck1", "track-a", false}}, 1);
    EXPECT_FALSE(ledger.wasPlayed("track-a"));
    ledger.advance({{"deck1", "track-b", true}}, 1);
    for (int i=0;i<59;++i) ledger.advance({{"deck1", "track-b", true}}, 1);
    EXPECT_FALSE(ledger.wasPlayed("track-b"));
    ledger.advance({{"deck1", "track-b", true}}, 1);
    EXPECT_TRUE(ledger.wasPlayed("track-b"));
    ledger.advance({{"deck1", "track-a", true}}, 1);
    EXPECT_FALSE(ledger.wasPlayed("track-a"));
}
TEST(Rx3BrowserPlayback, BothDecksAreTrackedAndSameTrackIsNotCountedTwice) {
    rx3::BrowserPlaybackLedger ledger;
    QList<rx3::BrowserPlaybackLedger::Sample> decks{{"deck1", "usb-one/track-1", true},
            {"deck2", "usb-one/track-1", true}};
    ledger.advance(decks, 0);
    for(int i=0;i<30;++i) ledger.advance(decks, 1);
    EXPECT_FALSE(ledger.wasPlayed("usb-one/track-1"));
    EXPECT_FALSE(ledger.wasPlayed("usb-two/track-1"));
    decks[0].playing=false;
    ledger.advance(decks, 1);
    EXPECT_TRUE(ledger.isPlaying("usb-one/track-1"));
    for(int i=0;i<29;++i) ledger.advance(decks, 1);
    EXPECT_TRUE(ledger.wasPlayed("usb-one/track-1"));
    ledger.advance({}, 1);
    EXPECT_FALSE(ledger.isPlaying("usb-one/track-1"));
    EXPECT_TRUE(ledger.wasPlayed("usb-one/track-1"));
}
TEST(Rx3BrowserPlayback, ColorsAndLosslessMarkerFollowPlaybackState) {
    EXPECT_EQ(QColor("#01FF02"), rx3::browserTrackColor(true,false));
    EXPECT_EQ(QColor("#01FF02"), rx3::browserTrackColor(true,true));
    EXPECT_EQ(QColor("#008A01"), rx3::browserTrackColor(false,true));
    EXPECT_EQ(QColor("#FFFFFF"), rx3::browserTrackColor(false,false));
    for (const auto& type : {"WAV", "aiff", "aif", "FLAC", "alac"})
        EXPECT_TRUE(rx3::isLosslessFileType(type));
    for (const auto& type : {"mp3", "aac", "m4a", "ogg", ""})
        EXPECT_FALSE(rx3::isLosslessFileType(type));
}

#include "widget/rx3browseraudio.h"
TEST_F(Rx3HotcueTest, LosslessMarkerDistinguishesAlacFromAacInTheSameContainer) {
    const auto root = getTestDir().filePath("id3-test-data/");
    ASSERT_TRUE(QFile::exists(root+"cover-test-itunes-12.7.0-alac.m4a"));
    EXPECT_TRUE(rx3::isAlacAudioFile(root+"cover-test-itunes-12.7.0-alac.m4a"));
    EXPECT_FALSE(rx3::isAlacAudioFile(root+"cover-test-itunes-12.7.0-aac.m4a"));
    EXPECT_FALSE(rx3::isAlacAudioFile(root+"cover-test-ffmpeg-aac.m4a"));
    EXPECT_FALSE(rx3::isAlacAudioFile(root+"missing.m4a"));
}
TEST(Rx3BrowserPlayback, PlayReplacesBothNoteAndHAtReferenceAndRetinaSizes) {
    for (int dpr : {1,2}) {
        QImage note(32*dpr,32*dpr,QImage::Format_ARGB32_Premultiplied);
        note.setDevicePixelRatio(dpr); note.fill(Qt::black);
        QImage lossless=note, play=note, losslessPlay=note;
        const auto paint = [&](QImage* image, bool playing, bool h) {
            QPainter painter(image);
            rx3::drawBrowserTrackIcon(&painter,QRectF(0,0,32,32),QColor("#01FF02"),playing,h);
        };
        paint(&note,false,false); paint(&lossless,false,true);
        paint(&play,true,false); paint(&losslessPlay,true,true);
        EXPECT_EQ(play,losslessPlay);
        EXPECT_NE(note,lossless);
        EXPECT_NE(note,play);
        EXPECT_EQ(QColor("#01FF02"),play.pixelColor(14*dpr,16*dpr));
    }
}
TEST(Rx3BrowserPlayback, RenderBrowserIconReview) {
    const auto output=qEnvironmentVariable("NAUTIC_BROWSER_ARTIFACT_DIR");
    if (output.isEmpty()) return;
    QImage image(980,640,QImage::Format_ARGB32_Premultiplied); image.fill(Qt::black);
    QPainter p(&image);
    const QStringList labels{"ARTIST","ALBUM","TRACK","KEY","PLAYLIST","HISTORY","MATCHING","FOLDER","REC"};
    QFont labelFont("Arial"); labelFont.setPixelSize(11);
    for(int row=0;row<labels.size();++row) {
        const QRect rect(0,row*65,96,65);
        p.fillRect(rect,QColor(row==2 ? "#006f88" : "#202020"));
        rx3::drawBrowserCategoryIcon(&p,QRectF(32,row*65+6,32,32),labels[row],QColor("#bcbcbc"));
        p.setFont(labelFont); p.setPen(QColor("#bcbcbc"));
        p.drawText(rect.adjusted(0,39,0,0),Qt::AlignHCenter|Qt::AlignTop,labels[row]);
    }
    const QStringList titles{"Lossless track — WAV", "Compressed track — MP3", "Playing track — FLAC",
            "Played track — ALAC", "Short audition stopped", "Playing on the other deck"};
    QFont rowFont("Arial"); rowFont.setPixelSize(24);
    for(int row=0;row<titles.size();++row) {
        const int y=65+row*58;
        p.fillRect(QRect(98,y,882,58),QColor(row==5?"#008bea":row%2?"#000000":"#262626"));
        const QColor color=rx3::browserTrackColor(row==2 || row==5,row==3);
        rx3::drawBrowserTrackIcon(&p,QRectF(109,y+10,38,38),color,row==2 || row==5,row==0 || row==3);
        p.setFont(rowFont); p.setPen(color); p.drawText(QRect(156,y,700,58),Qt::AlignVCenter,titles[row]);
    }
    p.end();
    ASSERT_TRUE(image.save(output+"/browser-icons.png"));
}

#include "widget/wwidgetgroup.h"
#include "widget/wlabel.h"
TEST_F(Rx3HotcueTest, RenderBpmGeometryReview) {
    const auto skin=qEnvironmentVariable("NAUTIC_SKIN_DIR");
    const auto output=qEnvironmentVariable("NAUTIC_BROWSER_ARTIFACT_DIR");
    if (skin.isEmpty() || output.isEmpty()) return;
    QFile css(skin+"/style.qss"); ASSERT_TRUE(css.open(QIODevice::ReadOnly));
    const QString style=QString::fromUtf8(css.readAll());
    SkinContext context(config(),QString());
    for (bool browser : {false,true}) {
        QFile xml(skin+(browser?"/rx3_library_deck.xml":"/deck.xml"));
        ASSERT_TRUE(xml.open(QIODevice::ReadOnly));
        QDomDocument doc; ASSERT_TRUE(doc.setContent(&xml));
        QDomElement headerNode;
        const QString headerName=browser?"RX3LibraryBpmHeader":"DeckHeaderBpmTitleRow";
        const auto groups=doc.elementsByTagName("WidgetGroup");
        for (int i=0;i<groups.size();++i) {
            const auto group=groups.at(i).toElement();
            if (group.firstChildElement("ObjectName").text()==headerName) headerNode=group;
        }
        ASSERT_FALSE(headerNode.isNull());
        WWidgetGroup box;
        box.setObjectName(browser?"RX3LibraryDeckBpmBox1":"DeckHeaderBpm");
        QDomDocument boxDoc; ASSERT_TRUE(boxDoc.setContent(QStringLiteral("<WidgetGroup><Layout>vertical</Layout></WidgetGroup>")));
        box.setup(boxDoc.documentElement(),context);
        box.setProperty("highlight",1);
        auto* header=new WWidgetGroup(&box); header->setup(headerNode,context);
        header->setObjectName(headerName); header->setFixedHeight(16);
        WLabel* master=nullptr;
        WLabel* caption=nullptr;
        const auto children=headerNode.firstChildElement("Children");
        for (auto node=children.firstChildElement("Label");!node.isNull();node=node.nextSiblingElement("Label")) {
            auto* label=new WLabel(header); label->setup(node,context);
            label->setObjectName(node.firstChildElement("ObjectName").text());
            if (label->objectName().contains("Master")) {
                master=label; label->setSizePolicy(QSizePolicy::MinimumExpanding,QSizePolicy::MinimumExpanding);
                label->setProperty("highlight",1);
            } else caption=label;
            header->layout()->addWidget(label);
        }
        ASSERT_NE(nullptr,master); ASSERT_NE(nullptr,caption);
        box.layout()->addWidget(header);
        auto* value=new QLabel("123.0",&box);
        value->setObjectName(browser?"RX3LibraryDeckBpm1":"DeckHeaderBpmValue");
        value->setProperty("highlight",1); value->setAlignment(Qt::AlignCenter);
        box.layout()->addWidget(value);
        box.setStyleSheet(style); box.resize(browser?100:120,80); box.show();
        QCoreApplication::processEvents();
        // The orange label must fill the header through its last inner pixel.
        EXPECT_EQ(header->contentsRect().right(),master->geometry().right());
        EXPECT_EQ(Qt::AlignCenter,master->alignment());
        EXPECT_EQ(header->contentsRect().left(),caption->geometry().left());
        EXPECT_TRUE(caption->alignment().testFlag(Qt::AlignLeft));
        ASSERT_TRUE(box.grab().save(output+(browser?"/bpm-browser.png":"/bpm-performance.png")));
    }
}

#include "widget/wrx3deckbadge.h"
TEST(Rx3DeckBadge, BothFixedWavePairsBlinkOnAnEightHundredMillisecondCycle) {
    EXPECT_EQ(1,rx3::deckWaveStage(true,0));
    EXPECT_EQ(1,rx3::deckWaveStage(true,199));
    EXPECT_EQ(1,rx3::deckWaveStage(true,200));
    EXPECT_EQ(0,rx3::deckWaveStage(true,400));
    EXPECT_EQ(0,rx3::deckWaveStage(true,600));
    EXPECT_EQ(1,rx3::deckWaveStage(true,800));
    EXPECT_EQ(0,rx3::deckWaveStage(false,400));
}
namespace {
int deckWavePixels(const QImage& image) {
    int result=0;
    for(int y=0;y<image.height();++y) for(int x=0;x<image.width();++x) {
        const auto color=image.pixelColor(x,y);
        if(color.red()>100 && color.green()<100 && color.blue()<70) ++result;
    }
    return result;
}
}
TEST(Rx3DeckBadge, VectorWavesAndCompactLabelSpacingAtBothPixelDensities) {
    const auto output=qEnvironmentVariable("NAUTIC_BROWSER_ARTIFACT_DIR");
    for (int dpr : {1,2}) for (int deck : {1,2}) {
        int previous=0;
        for (int stage=0;stage<=3;++stage) {
            QImage image(92*dpr,52*dpr,QImage::Format_ARGB32_Premultiplied);
            image.setDevicePixelRatio(dpr);image.fill(QColor("#181818"));
            QPainter painter(&image);rx3::drawDeckBadge(&painter,QRectF(0,0,92,52),deck,stage);painter.end();
            const int pixels=deckWavePixels(image);
            if(stage==0) EXPECT_EQ(0,pixels);
            else if(stage==1) EXPECT_GT(pixels,previous);
            else EXPECT_EQ(pixels,previous);
            previous=pixels;
            int wordBottom=-1,numberTop=52*dpr;
            for(int y=0;y<52*dpr;++y) for(int x=36*dpr;x<56*dpr;++x) {
                const auto c=image.pixelColor(x,y);
                if(c.red()>200 && c.green()>200 && c.blue()>200) {
                    if(y<15*dpr) wordBottom=qMax(wordBottom,y);
                    else numberTop=qMin(numberTop,y);
                }
            }
            ASSERT_GE(wordBottom,0);
            EXPECT_GE(numberTop-wordBottom,1);
            EXPECT_LE(numberTop-wordBottom,8*dpr);
            if(!output.isEmpty()) ASSERT_TRUE(image.save(output+QString("/deck-%1-stage-%2-%3x.png").arg(deck).arg(stage).arg(dpr)));
        }
    }
}
TEST_F(Rx3HotcueTest, DeckWavesStopImmediatelyOnPauseAndUnloadAndRestartOnPlay) {
    ControlObject play(ConfigKey("[Channel1]","play"));
    ControlObject loaded(ConfigKey("[Channel1]","track_loaded"));
    SkinContext context(config(),QString());
    QDomDocument doc;ASSERT_TRUE(doc.setContent(QStringLiteral("<Label><Channel>1</Channel></Label>")));
    WRx3DeckBadge badge;badge.setup(doc.documentElement(),context);badge.resize(92,52);badge.show();
    const auto waveCount=[&] {QCoreApplication::processEvents();return deckWavePixels(badge.grab().toImage());};
    EXPECT_EQ(0,waveCount());
    loaded.set(1);play.set(1);EXPECT_GT(waveCount(),0);
    play.set(0);EXPECT_EQ(0,waveCount());
    play.set(1);EXPECT_GT(waveCount(),0);
    loaded.set(0);EXPECT_EQ(0,waveCount());
}

#include <QTableWidget>
#include <QScrollBar>
#include <QHeaderView>
#include "widget/wrx3browser.h"
#include "widget/rx3browsernavigation.h"
#include "test/librarytest.h"
#include "library/browse/browsetablemodel.h"

TEST(Rx3BrowserNavigation, CategoryOrderPlacesPlaylistAfterKey) {
    const QStringList shuffled={"PLAYLIST","SEARCH","FOLDER","ALBUMS","KEY","TRACK","ARTIST","HISTORY","MATCHING"};
    auto ordered=shuffled;
    std::stable_sort(ordered.begin(),ordered.end(),[](const auto& a,const auto& b){return rx3::categoryRank(a)<rx3::categoryRank(b);});
    EXPECT_EQ((QStringList{"ARTIST","ALBUMS","TRACK","KEY","PLAYLIST","HISTORY","MATCHING","FOLDER","SEARCH"}),ordered);
}
TEST_F(Rx3ReferenceScaleTest, TwelveRowsNeverExposeTheThirteenthAtAnyHeight) {
    Rx3PreviewTable table(30,1);
    table.setFrameShape(QFrame::NoFrame);table.setShowGrid(false);
    table.verticalHeader()->hide();table.setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    table.setVerticalScrollMode(QAbstractItemView::ScrollPerItem);
    table.show();
    for(int height: {377,500,638,639,642,690,861,1020}) {
        table.resize(600,height);
        const auto rows=rx3::twelveBrowserRows(height);
        table.fitRows(rows.rowHeight,rows.headerHeight);
        QCoreApplication::processEvents();
        EXPECT_EQ(12*rows.rowHeight,table.viewport()->height());
        EXPECT_EQ(11,table.rowAt(table.viewport()->height()-1));
        EXPECT_EQ(rows.rowHeight,table.visualRect(table.model()->index(11,0)).height());
        EXPECT_GE(table.visualRect(table.model()->index(12,0)).top(),table.viewport()->height());
        table.scrollTo(table.model()->index(20,0),QAbstractItemView::PositionAtTop);
        EXPECT_EQ(11,table.rowAt(table.viewport()->height()-1)-table.rowAt(0));
        table.scrollToTop();
    }
}
TEST(Rx3BrowserNavigation, MatchingRequiresMetadataAndExcludesReference) {
    using mixxx::rekordbox::RuntimeTrack;
    QHash<quint32,RuntimeTrack> tracks;
    auto add=[&](quint32 id,QString key,double bpm,QString path) {
        RuntimeTrack track;track.rekordboxId=id;track.key=key;track.bpm=bpm;track.resolvedAudioPath=path;tracks.insert(id,track);
    };
    add(1,"Am",120,"/usb/reference.wav");add(2,"Am",122,"/usb/a.wav");
    add(3,"C",119,"/usb/b.wav");add(4,"Am",140,"/usb/too-fast.wav");
    add(5,"",120,"/usb/unknown.wav");add(6,"Am",0,"/usb/no-tempo.wav");
    EXPECT_EQ((QList<quint32>{3,2}),rx3::matchingTrackIds(tracks,"/usb/reference.wav","Am",120));
    EXPECT_TRUE(rx3::matchingTrackIds(tracks,"/usb/reference.wav","",120).isEmpty());
    EXPECT_TRUE(rx3::matchingTrackIds(tracks,"/usb/reference.wav","Am",0).isEmpty());
}
class Rx3UsbFolderTest : public LibraryTest {};
TEST_F(Rx3UsbFolderTest, RawUsbTracksRemainTemporaryAndConfined) {
    QTemporaryDir usb;
    ASSERT_TRUE(usb.isValid());
    QFile audio(usb.filePath("plain.wav"));ASSERT_TRUE(audio.open(QIODevice::WriteOnly));audio.write("fixture");audio.close();
    BrowseTableModel model(nullptr,trackCollectionManager(),nullptr);
    model.setTransientUsbRoot(usb.path());
    const auto track=model.getTrackByRef(TrackRef::fromFilePath(audio.fileName()));
    ASSERT_TRUE(track);
    EXPECT_FALSE(track->getId().isValid());
    EXPECT_FALSE(track->getUsePolicy().canPersist());
    EXPECT_FALSE(track->getUsePolicy().canImport());
    EXPECT_FALSE(track->getUsePolicy().canExportMetadata());
    EXPECT_TRUE(track->getUsePolicy().canAnalyze());
    EXPECT_TRUE(track->isSourceAvailableForPlayback());
    EXPECT_FALSE(model.getCapabilities().testFlag(TrackModel::Capability::RemoveFromDisk));
    QTemporaryDir outside;
    QFile external(outside.filePath("other.wav"));ASSERT_TRUE(external.open(QIODevice::WriteOnly));external.close();
    EXPECT_FALSE(model.getTrackByRef(TrackRef::fromFilePath(external.fileName())));
#ifndef Q_OS_WIN
    ASSERT_TRUE(QFile::link(external.fileName(),usb.filePath("escape.wav")));
    EXPECT_FALSE(model.getTrackByRef(TrackRef::fromFilePath(usb.filePath("escape.wav"))));
#endif
    EXPECT_FALSE(model.getTrackByRef(TrackRef::fromFilePath(usb.filePath("missing.wav"))));
    model.releaseBrowseThread();
}

struct Rx3BrowserTestAccess {
    static void prepare(WRx3Browser& browser) {
        browser.m_pages->setCurrentIndex(0);browser.m_source->setText("▣ USB1");browser.m_breadcrumb->setText("PLAYLIST");browser.m_library->hide();browser.m_emptySpace->hide();
        browser.m_leftColumn->show();browser.m_sidebar->hide();browser.m_facets->show();
        browser.m_facets->addItems({"Playlist A","Playlist B"});browser.m_facets->setCurrentRow(0);
        for(const auto& label:QStringList{"ARTIST","ALBUM","TRACK","KEY","PLAYLIST","HISTORY","MATCHING","FOLDER","REC","DATE ADDED"})
            new QListWidgetItem("\n"+label,browser.m_categories);
        browser.m_categories->setCurrentRow(4);browser.setPreview("TRACK",{"Track A","Track B"});
        browser.m_focus=WRx3Browser::NavigationTarget::Categories;browser.updateNavigationHighlight();
    }
    static void overflowFacets(WRx3Browser& browser) {
        for(int i=0;i<20;++i) browser.m_facets->addItem(QString("Additional row %1").arg(i));
        browser.fitBrowseRows();
    }
    static void enterColumn(WRx3Browser& browser) {
        browser.m_focus=WRx3Browser::NavigationTarget::Facets;browser.updateNavigationHighlight();
    }
    static void fit(WRx3Browser& browser) {browser.fitBrowseRows();}
    static void showTrackResults(WRx3Browser& browser) {browser.showTrackList(WRx3Browser::BrowserLevel::Categories);}
    static int browserPage(WRx3Browser& browser) {return browser.m_pages->currentIndex();}
    static void sources(WRx3Browser& browser) {browser.showSources();}
    static void audioTools(WRx3Browser& browser) {browser.showAudioTools();browser.m_pages->setCurrentWidget(browser.m_tools);}
    static void moveTools(WRx3Browser& browser,int ticks) {browser.move(ticks);}
    static void enterTools(WRx3Browser& browser) {browser.enter();}
    static void backTools(WRx3Browser& browser) {browser.back();}
    static void filterTools(WRx3Browser& browser) {browser.showFilterTools();browser.m_pages->setCurrentWidget(browser.m_tools);}
    static void playbackTools(WRx3Browser& browser) {browser.showPlaybackTools();browser.m_pages->setCurrentWidget(browser.m_tools);}
    static void isolatedSources(WRx3Browser& browser,QStandardItemModel& devices,int selected) {
        browser.m_sources->clear();browser.m_devices.clear();
        for(int row=0;row<devices.rowCount();++row) {
            const QPersistentModelIndex device(devices.index(row,0));browser.m_devices.push_back(device);
            const auto root=browser.deviceRoot(device);browser.m_usbSlots.insert(root,row+1);
            auto* item=new QTreeWidgetItem(browser.m_sources,{QString("USB%1").arg(row+1)});
            item->setData(0,Qt::UserRole,root);item->setData(0,Qt::UserRole+2,item->text(0));
            item->setData(0,Qt::UserRole+3,"›");
        }
        browser.m_sources->setCurrentItem(browser.m_sources->topLevelItem(selected));
        // Isolated presentation fixture, without a parsed library catalog.
        browser.m_sourceSettings->setEnabled(true);
    }
    static QString navigationSource(WRx3Browser& browser) {return browser.deviceRoot(browser.sourceDeviceForNavigation());}
    static WRx3ToolMenu* sourceSettings(WRx3Browser& browser) {return browser.m_sourceMenu;}
    static bool sourceSettingsOpen(WRx3Browser& browser) {return browser.m_sourceDetails->currentWidget()==browser.m_sourceMenu;}
    static void previousBrowseSource(WRx3Browser& browser,int row) {browser.m_selectedDevice=browser.m_devices[row];}


};
TEST_F(Rx3ReferenceScaleTest, UsbPresentationHasTwoColumnsAndTouchKeyboard) {
    PlayerInfo::create();
    {
        SidebarModel model;
        auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        auto* library=new WLibrary(nullptr);
        // During skin startup the table exists before a track model is installed.
        auto* startupTable=new WTrackTableView(nullptr,config(),nullptr,0.0);
        library->addWidget(startupTable);
        ASSERT_EQ(nullptr,startupTable->model());
        WRx3Browser browser(library,sidebar,nullptr,nullptr);
        const QString qaDirectory=qEnvironmentVariable("NAUTIC_BROWSER_QA_DIR");
        QFile qaStyle(qEnvironmentVariable("NAUTIC_BROWSER_QA_STYLE"));
        if(qaStyle.open(QIODevice::ReadOnly)) browser.setStyleSheet(QString::fromUtf8(qaStyle.readAll()));
        auto capture=[&](const QString& name){
            if(!qaDirectory.isEmpty()) browser.grab().save(QDir(qaDirectory).filePath(name+".png"));
        };
        browser.resize(1280,690);browser.show();QCoreApplication::processEvents();
        EXPECT_TRUE(startupTable->property("rx3ModelConnected").toBool());
        capture("source-no-device");
        auto* sources=browser.findChild<QTreeWidget*>("RX3BrowserSources");
        ASSERT_TRUE(sources);EXPECT_EQ(QString("NO DEVICE"),sources->topLevelItem(0)->text(0));
        auto* info=browser.findChild<QLabel*>("RX3SourceInfo");
        EXPECT_FALSE(info->text().contains("Reading"));
        Rx3BrowserTestAccess::prepare(browser);QCoreApplication::processEvents();
        Rx3BrowserTestAccess::fit(browser);QCoreApplication::processEvents();
        auto* preview=browser.findChild<QTableWidget*>("RX3PlaylistPreviewTracks");
        auto* categories=browser.findChild<QListWidget*>("RX3BrowserCategories");
        ASSERT_TRUE(preview);ASSERT_TRUE(categories);
        EXPECT_EQ(1,preview->columnCount());EXPECT_EQ(12,preview->rowCount());
        EXPECT_EQ(QString("Track A"),preview->item(0,0)->text());
        EXPECT_EQ(0,categories->verticalScrollBar()->maximum());
        EXPECT_TRUE(categories->property("categoryFocus").toBool());capture("category-controller");
        auto* facets=browser.findChild<QListWidget*>("RX3BrowserFacets");
        auto* divider=browser.findChild<QWidget*>("RX3BrowseColumnDivider");
        ASSERT_TRUE(facets);ASSERT_TRUE(divider);
        EXPECT_EQ(QFrame::NoFrame,facets->frameShape());
        EXPECT_EQ(facets->width(),facets->viewport()->width());
        EXPECT_EQ(1,divider->width());
        EXPECT_EQ(divider->mapTo(&browser,QPoint(divider->width(),0)).x(),
                preview->mapTo(&browser,QPoint(0,0)).x());
        const auto dividerImage=divider->grab().toImage();
        for(int y=0;y<dividerImage.height();++y) EXPECT_EQ(QColor("#777777"),dividerImage.pixelColor(0,y));
        // Overflow must stay navigable without reserving a black scrollbar strip.
        Rx3BrowserTestAccess::overflowFacets(browser);QCoreApplication::processEvents();
        EXPECT_GT(facets->verticalScrollBar()->maximum(),0);
        EXPECT_EQ(facets->width(),facets->viewport()->width());
        facets->setCurrentRow(facets->count()-1);facets->scrollToItem(facets->currentItem());
        QCoreApplication::processEvents();
        EXPECT_TRUE(facets->viewport()->rect().intersects(facets->visualItemRect(facets->currentItem())));
        capture("category-overflow");
        facets->setCurrentRow(0);facets->scrollToTop();
        Rx3BrowserTestAccess::enterColumn(browser);
        EXPECT_FALSE(categories->property("categoryFocus").toBool());capture("category-touch");
        auto* keyboard=browser.findChild<QWidget*>("RX3SearchKeyboard");
        ASSERT_TRUE(keyboard);
        auto findKey=[&](const QString& text)->QPushButton* {
            for(auto* key:keyboard->findChildren<QPushButton*>()) if(key->text()==text) return key;
            return nullptr;
        };
        auto* search=browser.findChild<QLineEdit*>();ASSERT_TRUE(search);
        findKey("P")->click();findKey("O")->click();findKey("P")->click();EXPECT_EQ(QString("POP"),search->text());
        findKey("⌫")->click();EXPECT_EQ(QString("PO"),search->text());
        findKey("SPACE")->click();EXPECT_EQ(QString("PO "),search->text());
        findKey("CLEAR")->click();EXPECT_TRUE(search->text().isEmpty());
        findKey("123")->click();ASSERT_TRUE(findKey("7"));findKey("7")->click();EXPECT_EQ(QString("7"),search->text());
        findKey("ABC")->click();ASSERT_TRUE(findKey("Q"));keyboard->show();
        QCoreApplication::processEvents();capture("search-keyboard");keyboard->hide();
        for(int height: {552,690,864}) {
            browser.resize(1280,height);QCoreApplication::processEvents();
            Rx3BrowserTestAccess::fit(browser);QCoreApplication::processEvents();
            EXPECT_EQ(0,categories->verticalScrollBar()->maximum()) << "height=" << height;
            EXPECT_EQ(11,preview->rowAt(preview->viewport()->height()-1)) << "height=" << height
                    << " viewport=" << preview->viewport()->height() << " row=" << preview->rowHeight(0);
        }
    }
    PlayerInfo::destroy();
}

#include "widget/wrx3performancewidgets.h"
#include "widget/wrx3shortcut.h"
#include "widget/rx3libraryworkflow.h"
#include "widget/wrx3toolmenu.h"
#include <QTemporaryDir>

namespace {
QByteArray rx3SettingsFixture(const QString& name,const QMap<int,int>& fields) {
    const int size=name=="DJMMYSETTING.DAT"?52:name=="DEVSETTING.DAT"?32:40;
    QByteArray data(104+size+4,'\0');
    qToLittleEndian<quint32>(96,data.data());
    const QByteArray brand=name=="DJMMYSETTING.DAT"?"PioneerDJ":name=="DEVSETTING.DAT"?"PIONEER DJ":"PIONEER";
    std::copy(brand.cbegin(),brand.cend(),data.begin()+4);
    const QByteArray software="rekordbox";
    std::copy(software.cbegin(),software.cend(),data.begin()+36);
    qToLittleEndian<quint32>(size,data.data()+100);
    for(int i=0;i<size;++i) data[104+i]=char(0x80);
    if(name=="DEVSETTING.DAT") data[114]=char(1);
    for(auto it=fields.cbegin();it!=fields.cend();++it) data[104+it.key()]=char(it.value());
    const auto body=name=="DJMMYSETTING.DAT"?data.left(104+size):data.mid(104,size);
    qToLittleEndian<quint16>(rx3::settingsChecksum(body),data.data()+104+size);
    return data;
}
}
TEST(Rx3MySettings, ValidatesHeaderLengthChecksumAndEnumBeforeReturningSettings) {
    const auto valid=rx3SettingsFixture("MYSETTING.DAT",{{25,0x83},{36,0x82}});
    const auto result=rx3::readMySettings("MYSETTING.DAT",valid);
    EXPECT_TRUE(result.error.isEmpty());
    EXPECT_EQ(0.16,result.values.value("tempo_range"));
    EXPECT_EQ(1,result.values.value("hotcue_autoload"));
    auto corrupt=valid;corrupt[140]=char(quint8(corrupt[140])^1);
    EXPECT_FALSE(rx3::readMySettings("MYSETTING.DAT",corrupt).error.isEmpty());
    EXPECT_FALSE(rx3::readMySettings("MYSETTING.DAT",valid.left(140)).error.isEmpty());
    const auto unknown=rx3::readMySettings("MYSETTING.DAT",rx3SettingsFixture("MYSETTING.DAT",{{36,0x90}}));
    EXPECT_FALSE(unknown.error.isEmpty());EXPECT_TRUE(unknown.values.isEmpty());
}
TEST(Rx3MySettings, ReadsDeviceWaveformCodesAndMixerChecksumFromWholeFile) {
    const auto device=rx3::readMySettings("DEVSETTING.DAT",rx3SettingsFixture("DEVSETTING.DAT",{{10,4}}));
    ASSERT_TRUE(device.error.isEmpty());EXPECT_EQ(2,device.values.value("waveform_color"));
    const auto mixer=rx3::readMySettings("DJMMYSETTING.DAT",rx3SettingsFixture("DJMMYSETTING.DAT",{{13,0x82},{15,0x81}}));
    ASSERT_TRUE(mixer.error.isEmpty());EXPECT_EQ(2,mixer.values.value("crossfader_curve"));
    EXPECT_EQ(1,mixer.values.value("headphones"));
}
TEST(Rx3MySettings, ReadsConnectedRekordboxExportWithoutWritingToUsb) {
    const auto root=qEnvironmentVariable("NAUTIC_RX3_SETTINGS_USB");
    if(root.isEmpty()) GTEST_SKIP()<<"Set NAUTIC_RX3_SETTINGS_USB for real export validation";
    int files=0;
    for(const auto& name:{"MYSETTING.DAT","MYSETTING2.DAT","DJMMYSETTING.DAT","DEVSETTING.DAT"}) {
        QFile file(QDir(root).filePath(QString("PIONEER/")+name));
        if(!file.exists()) continue;
        ASSERT_TRUE(file.open(QIODevice::ReadOnly));
        const auto result=rx3::readMySettings(name,file.readAll());
        EXPECT_TRUE(result.error.isEmpty())<<name<<": "<<result.error.toStdString();++files;
    }
    EXPECT_GT(files,0);
}
TEST_F(Rx3ReferenceScaleTest, ShortcutTouchEncoderAndStoredValuesUseRealDeckControls) {
    ControlObject masterTempo(ConfigKey("[Channel1]","keylock"));
    ControlPotmeter range(ConfigKey("[Channel1]","rateRange"),0.01,4);
    ControlObject bend(ConfigKey("[Channel1]","rx3_pitch_bend"),false,false,false,1);
    ControlObject beatValue(ConfigKey("[Channel1]","rx3_quantize_beats"),false,false,false,1);
    range.set(0.06);
    QWidget canvas;canvas.resize(1280,800);canvas.show();
    WRx3Shortcut panel(config(),nullptr,&canvas);panel.setVisibleControl(true);
    QCoreApplication::processEvents();
    EXPECT_TRUE(panel.findChild<QFrame*>("ShortcutRow_time_mode")->property("encoderFocus").toBool());
    panel.enter();panel.move(-1);
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[RX3Settings]","time_mode")));
    panel.enter();panel.move(1);
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[RX3Settings]","time_mode")));
    auto* tempo=panel.findChild<QPushButton*>("Shortcut_tempo_range1_2");
    ASSERT_TRUE(tempo);tempo->click();EXPECT_EQ(0.16,range.get());
    EXPECT_EQ(0.16,config()->getValue<double>(ConfigKey("[RX3Settings]","tempo_range1")));
    auto* master=panel.findChild<QPushButton*>("Shortcut_master_tempo1_0");
    ASSERT_TRUE(master);master->click();EXPECT_EQ(1,masterTempo.get());
    auto* quantize=panel.findChild<QPushButton*>("Shortcut_quantize_beat_0");
    ASSERT_TRUE(quantize);quantize->click();EXPECT_EQ(0.125,beatValue.get());
    range.set(0.06);panel.restore();EXPECT_EQ(0.16,range.get());
    ControlObject::set(ConfigKey("[RX3Shortcut]","open"),1);
    EXPECT_TRUE(panel.findChild<QFrame*>("ShortcutRow_usb_load")->property("encoderFocus").toBool());
    EXPECT_FALSE(panel.findChild<QFrame*>("ShortcutRow_time_mode")->property("encoderFocus").toBool());
    panel.findChild<QPushButton*>("ShortcutClose")->click();
    EXPECT_FALSE(panel.isVisible());EXPECT_EQ(1,masterTempo.get());
}
TEST_F(Rx3ReferenceScaleTest, MySettingsImportBlocksPlaybackAndInvalidFilesWithoutPartialChanges) {
    ControlObject play(ConfigKey("[Channel1]","play"));
    ControlPotmeter range(ConfigKey("[Channel1]","rateRange"),0.01,4);range.set(0.06);
    QTemporaryDir usb;ASSERT_TRUE(usb.isValid());QDir(usb.path()).mkdir("PIONEER");
    qApp->setProperty("rx3SettingsUsbRoot",usb.path());
    QWidget canvas;WRx3Shortcut panel(config(),nullptr,&canvas);
    auto write=[&](const QString& name,const QByteArray& bytes) {
        QFile file(QDir(usb.path()).filePath("PIONEER/"+name));
        EXPECT_TRUE(file.open(QIODevice::WriteOnly));EXPECT_EQ(bytes.size(),file.write(bytes));
    };
    write("MYSETTING.DAT",rx3SettingsFixture("MYSETTING.DAT",{{36,0x82}}));
    play.set(1);EXPECT_TRUE(panel.loadSettings().contains("Pause both decks"));EXPECT_EQ(0.06,range.get());
    play.set(0);write("MYSETTING2.DAT",QByteArray("broken"));
    EXPECT_TRUE(panel.loadSettings().contains("No settings applied"));EXPECT_EQ(0.06,range.get());
    QFile::remove(QDir(usb.path()).filePath("PIONEER/MYSETTING2.DAT"));
    EXPECT_TRUE(panel.loadSettings().contains("MY SETTINGS loaded"));EXPECT_EQ(0.16,range.get());
    qApp->setProperty("rx3SettingsUsbRoot",QString());
}
TEST_F(Rx3ReferenceScaleTest, SourceMySettingsLoadsHighlightedUsbWithoutOpeningShortcut) {
    ControlObject play(ConfigKey("[Channel1]","play"));
    ControlPotmeter range(ConfigKey("[Channel1]","rateRange"),0.01,4);range.set(0.06);
    QTemporaryDir usb1,usb2;ASSERT_TRUE(usb1.isValid());ASSERT_TRUE(usb2.isValid());
    QStandardItemModel devices;
    for(const auto& root:{usb1.path(),usb2.path()}) {
        ASSERT_TRUE(QDir(root).mkdir("PIONEER"));auto* item=new QStandardItem(root);
        item->setData(QVariantList{root,"USB","ready"},SidebarModel::DataRole);devices.appendRow(item);
    }
    const auto settings=rx3SettingsFixture("MYSETTING.DAT",{{36,0x82}});
    QFile file(QDir(usb2.path()).filePath("PIONEER/MYSETTING.DAT"));ASSERT_TRUE(file.open(QIODevice::WriteOnly));
    ASSERT_EQ(settings.size(),file.write(settings));file.close();
    PlayerInfo::create();
    {
        QWidget canvas;canvas.resize(1280,800);canvas.show();WRx3Shortcut shortcut(config(),nullptr,&canvas);
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        WRx3Browser browser(new WLibrary(nullptr),sidebar,nullptr,&canvas,config());
        browser.resize(1280,690);browser.show();QCoreApplication::processEvents();
        QFile style(qEnvironmentVariable("NAUTIC_BROWSER_QA_STYLE"));
        if(style.open(QIODevice::ReadOnly)) browser.setStyleSheet(QString::fromUtf8(style.readAll()));
        Rx3BrowserTestAccess::isolatedSources(browser,devices,1);
        Rx3BrowserTestAccess::previousBrowseSource(browser,0);
        EXPECT_EQ(usb2.path(),Rx3BrowserTestAccess::navigationSource(browser));
        auto* button=browser.findChild<QPushButton*>("RX3SourceSettings");ASSERT_TRUE(button);button->click();
        ASSERT_TRUE(Rx3BrowserTestAccess::sourceSettingsOpen(browser));EXPECT_FALSE(shortcut.isVisible());
        auto* actions=browser.findChild<QListWidget*>("RX3SourceSettingsActions");ASSERT_TRUE(actions);
        ASSERT_EQ(3,actions->count());EXPECT_EQ("LOAD",actions->item(0)->text());
        EXPECT_EQ("BACKGROUND COLOR",actions->item(1)->text());EXPECT_EQ("WAVEFORM COLOR",actions->item(2)->text());
        // Another presentation may alter the global property; LOAD owns the menu's USB.
        qApp->setProperty("rx3SettingsUsbRoot",usb1.path());
        Rx3BrowserTestAccess::enterTools(browser);EXPECT_EQ(0.16,range.get());EXPECT_FALSE(shortcut.isVisible());
        const auto output=qEnvironmentVariable("NAUTIC_BROWSER_QA_DIR");
        if(!output.isEmpty()) ASSERT_TRUE(browser.grab().save(QDir(output).filePath("source-my-settings.png")));
        Rx3BrowserTestAccess::moveTools(browser,3);Rx3BrowserTestAccess::enterTools(browser);
        EXPECT_FALSE(Rx3BrowserTestAccess::sourceSettingsOpen(browser));
        Rx3BrowserTestAccess::isolatedSources(browser,devices,0);button->click();
        range.set(0.06);Rx3BrowserTestAccess::enterTools(browser);EXPECT_EQ(0.06,range.get());
        bool missing=false;for(auto* label:Rx3BrowserTestAccess::sourceSettings(browser)->findChildren<QLabel*>())
            missing|=label->text().contains("No rekordbox MY SETTINGS");
        EXPECT_TRUE(missing);EXPECT_EQ(usb1.path(),Rx3BrowserTestAccess::navigationSource(browser));
        EXPECT_FALSE(shortcut.isVisible());
    }
    PlayerInfo::destroy();qApp->setProperty("rx3SettingsUsbRoot",QString());
}
TEST_F(Rx3ReferenceScaleTest, SourceHeaderOrderAndEncoderReachSettingsAndMenuWithoutUsb) {
    PlayerInfo::create();
    {
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        WRx3Browser browser(new WLibrary(nullptr),sidebar,nullptr,nullptr,config());
        browser.resize(1280,690);browser.show();QCoreApplication::processEvents();
        const QStringList names={"RX3SourceButton","RX3BrowseButton","RX3TagListButton","RX3PlaylistButton","RX3SearchButton","RX3BrowserToolsButton"};
        const QStringList texts={"SOURCE","BROWSE","TAG LIST","PLAYLIST","SEARCH","MENU"};
        int previous=-1;
        for(int i=0;i<names.size();++i) {
            auto* button=browser.findChild<QPushButton*>(names[i]);ASSERT_TRUE(button);
            EXPECT_EQ(texts[i],button->text());EXPECT_GT(button->x(),previous);previous=button->x();
            if(i>=1 && i<=4) EXPECT_FALSE(button->isEnabled());
        }
        Rx3BrowserTestAccess::moveTools(browser,1);
        auto* settings=browser.findChild<QPushButton*>("RX3SourceSettings");ASSERT_TRUE(settings);
        EXPECT_TRUE(settings->property("encoderFocus").toBool());EXPECT_FALSE(settings->isEnabled());
        Rx3BrowserTestAccess::enterTools(browser);EXPECT_FALSE(Rx3BrowserTestAccess::sourceSettingsOpen(browser));
        Rx3BrowserTestAccess::moveTools(browser,6);
        auto* menu=browser.findChild<QPushButton*>("RX3BrowserToolsButton");ASSERT_TRUE(menu);
        EXPECT_TRUE(menu->property("encoderFocus").toBool());Rx3BrowserTestAccess::enterTools(browser);
        auto* utility=browser.findChild<WRx3Utility*>("RX3Utility");ASSERT_TRUE(utility);EXPECT_TRUE(utility->isVisible());
        Rx3BrowserTestAccess::moveTools(browser,100);Rx3BrowserTestAccess::enterTools(browser);
        EXPECT_FALSE(utility->isVisible());EXPECT_EQ("SOURCE",browser.findChild<QPushButton*>("RX3BrowserBreadcrumb")->text());
    }
    PlayerInfo::destroy();
}
TEST(Rx3SourceAppearance, PortableAccentIsPerUsbAndPreservesRekordboxFiles) {
    QTemporaryDir usb1,usb2;ASSERT_TRUE(usb1.isValid());ASSERT_TRUE(usb2.isValid());
    for(const auto& root:{usb1.path(),usb2.path()}) ASSERT_TRUE(QDir(root).mkdir("PIONEER"));
    const QString settingsPath=QDir(usb1.path()).filePath("PIONEER/MYSETTING.DAT");
    const auto original=rx3SettingsFixture("MYSETTING.DAT",{{36,0x81}});
    QFile settings(settingsPath);ASSERT_TRUE(settings.open(QIODevice::WriteOnly));ASSERT_EQ(original.size(),settings.write(original));settings.close();
    ASSERT_TRUE(rx3::saveSourceColor(usb1.path(),6).isEmpty());EXPECT_EQ(6,rx3::readSourceColor(usb1.path()));
    EXPECT_EQ(0,rx3::readSourceColor(usb2.path()));EXPECT_FALSE(rx3::saveSourceColor(usb2.path(),99).isEmpty());
    ASSERT_TRUE(settings.open(QIODevice::ReadOnly));EXPECT_EQ(original,settings.readAll());settings.close();
    QFile corrupt(rx3::sourceAppearancePath(usb1.path()));ASSERT_TRUE(corrupt.open(QIODevice::WriteOnly));
    corrupt.write("{\"version\":1,\"color\":2.5}");corrupt.close();EXPECT_EQ(0,rx3::readSourceColor(usb1.path()));
    EXPECT_FALSE(rx3::saveSourceColor("/missing-nautic-usb",1).isEmpty());
}
TEST_F(Rx3ReferenceScaleTest, RenderShortcutAtReferenceAndFullscreenSizes) {
    const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
    if(output.isEmpty()) GTEST_SKIP()<<"Set NAUTIC_RX3_RENDER_DIR for visual QA";
    auto* canvas=new QWidget;canvas->resize(1280,800);
    auto* panel=new WRx3Shortcut(config(),nullptr,canvas);
    WReferenceScaler viewport(canvas,QSize(1280,800),nullptr,true);viewport.show();
    panel->setVisibleControl(true);
    for(const auto size:{QSize(1280,800),QSize(1920,1080)}) {
        viewport.resize(size);QCoreApplication::processEvents();
        ASSERT_TRUE(viewport.grab().save(QDir(output).filePath(QString("shortcut-%1.png").arg(size.width()))));
        EXPECT_LE(panel->minimumSizeHint().height(),panel->height());
    }
}
TEST_F(Rx3ReferenceScaleTest, ShortcutNeverCoversSharedBrowserFooterAfterLayoutOrResize) {
    ControlObject page(ConfigKey("[Tab]","current"),false,false,false,0);
    QWidget canvas;canvas.resize(1280,800);canvas.show();
    QWidget browser(&canvas);browser.setGeometry(0,48,1280,752);browser.show();
    QFrame footer(&browser);footer.setObjectName("RX3LibraryDecks");
    footer.setStyleSheet("background:#050607;border:1px solid white;");
    footer.setGeometry(8,644,1264,94);footer.show();
    QLabel deck1("DECK 1 — REMAIN 04:21",&footer);deck1.move(8,3);deck1.show();
    QLabel deck2("DECK 2 — REMAIN 02:53",&footer);deck2.move(650,3);deck2.show();
    QCoreApplication::processEvents();
    const auto before=canvas.grab(footer.geometry().translated(browser.pos())).toImage();
    WRx3Shortcut panel(config(),nullptr,&canvas);panel.setVisibleControl(true);
    QCoreApplication::processEvents();
    EXPECT_LE(panel.geometry().bottom()+1,footer.mapTo(&canvas,QPoint()).y()-2);
    EXPECT_TRUE(before==canvas.grab(footer.geometry().translated(browser.pos())).toImage());
    // A delayed browser layout and fullscreen scaling move the shared footer.
    for(const auto size:{QSize(1280,800),QSize(1920,1200)}) {
        canvas.resize(size);browser.setGeometry(0,48,size.width(),size.height()-48);
        footer.setGeometry(8,size.height()-149,size.width()-16,101);
        QCoreApplication::processEvents();
        EXPECT_LE(panel.geometry().bottom()+1,footer.mapTo(&canvas,QPoint()).y()-2);
        EXPECT_LE(panel.minimumSizeHint().height(),panel.height());
        const auto covered=canvas.grab(footer.geometry().translated(browser.pos())).toImage();
        panel.setVisibleControl(false);QCoreApplication::processEvents();
        EXPECT_TRUE(covered==canvas.grab(footer.geometry().translated(browser.pos())).toImage());
        panel.setVisibleControl(true);QCoreApplication::processEvents();
    }
}
TEST_F(Rx3ReferenceScaleTest, ShortcutUsbBlockSeparatesSlotDeviceAndSettings) {
    QTemporaryDir usb;
    qApp->setProperty("rx3SettingsUsbRoot",usb.path());
    qApp->setProperty("rx3SettingsUsbName","USB2");
    qApp->setProperty("rx3SettingsUsbDeviceName","CDJ3K 64Flair");
    QWidget canvas;canvas.resize(1280,800);canvas.show();
    WRx3Shortcut panel(config(),nullptr,&canvas);panel.setVisibleControl(true);
    QCoreApplication::processEvents();
    auto* block=panel.findChild<QFrame*>("ShortcutUsbBlock");ASSERT_TRUE(block);
    auto* slot=block->findChild<QLabel*>("ShortcutUsbSlot");ASSERT_TRUE(slot);
    auto* name=block->findChild<QLabel*>("ShortcutUsbDeviceName");ASSERT_TRUE(name);
    EXPECT_TRUE(slot->text().contains("USB2"));EXPECT_EQ("CDJ3K 64Flair",name->text());
    EXPECT_LT(slot->mapTo(block,QPoint()).y(),name->mapTo(block,QPoint()).y());
    const auto lines=block->findChildren<QWidget*>("ShortcutUsbSeparator");ASSERT_EQ(2,lines.size());
    EXPECT_EQ(1,lines[0]->height());EXPECT_EQ(2,lines[1]->height());
    for(auto* line:lines) {EXPECT_GT(line->x(),0);EXPECT_LT(line->geometry().right(),block->width()-1);}
    auto* load=block->findChild<QPushButton*>("ShortcutSettingsLoad");ASSERT_TRUE(load);EXPECT_TRUE(load->isEnabled());
    ControlObject playing(ConfigKey("[Channel1]","play"),false,false,false,1);
    QTest::qWait(170);EXPECT_FALSE(load->isEnabled());
    const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
    if(!output.isEmpty()) EXPECT_TRUE(canvas.grab().save(QDir(output).filePath("shortcut-usb-card.png")));
    qApp->setProperty("rx3SettingsUsbRoot",QString());
    qApp->setProperty("rx3SettingsUsbDeviceName",QString());
}
TEST_F(Rx3ReferenceScaleTest, UserInputSelectsDeckButEngineFeedbackDoesNot) {
    ControlObject pitch1(ConfigKey("[Channel1]","rate"));
    ControlObject pitch2(ConfigKey("[Channel2]","rate"));
    ControlObject quantize2(ConfigKey("[Channel2]","quantize"));
    Rx3PerformanceState state;
    EXPECT_EQ(1,state.activeDeck());
    pitch2.set(0.02);QCoreApplication::processEvents();
    EXPECT_EQ(1,state.activeDeck()); // The owning engine control is feedback.
    ControlObject::set(ConfigKey("[Channel2]","quantize"),1);QCoreApplication::processEvents();
    EXPECT_EQ(1,state.activeDeck());
    ControlObject::set(ConfigKey("[Channel1]","rate"),0);QCoreApplication::processEvents();
    EXPECT_EQ(1,state.activeDeck()); // Same-value physical input still selects.
    pitch2.set(0.03);QCoreApplication::processEvents();EXPECT_EQ(1,state.activeDeck());
    QWidget deck;deck.setProperty("rx3Deck",2);
    QWidget title(&deck);title.setProperty("rx3DeckSelect",2);
    QMouseEvent press(QEvent::MouseButtonPress,QPointF(1,1),QPointF(1,1),Qt::LeftButton,Qt::LeftButton,Qt::NoModifier);QCoreApplication::sendEvent(&deck,&press);
    EXPECT_EQ(1,state.activeDeck());
    QCoreApplication::sendEvent(&title,&press);
    EXPECT_EQ(2,state.activeDeck());
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[RX3Display]","active1")));
    EXPECT_EQ(1,ControlObject::get(ConfigKey("[RX3Display]","active2")));
}
TEST_F(Rx3ReferenceScaleTest, PlaybackProxyFeedbackNeverChangesSelectedDeckOrGrid) {
    // BpmControl updates rate_ratio through a ControlProxy on every callback,
    // rather than the owning ControlObject. Reproduce both decks playing.
    std::vector<std::unique_ptr<ControlObject>> controls;
    for (int deck = 1; deck <= 2; ++deck) {
        for (const auto& item : {"rate_ratio", "beat_distance", "playposition", "VuMeter",
                     "visual_bpm", "sync_leader", "scratch2", "scratch2_scratching", "jog"}) {
            controls.push_back(std::make_unique<ControlObject>(
                    ConfigKey(QString("[Channel%1]").arg(deck), item)));
        }
    }
    Rx3PerformanceState state;
    state.selectDeck(2);
    ControlObject::set(ConfigKey("[RX3Controller]", "grid_mode"), 1);
    for (int tick = 0; tick < 100; ++tick) {
        for (int deck = 1; deck <= 2; ++deck) {
            for (const auto& item : {"rate_ratio", "beat_distance", "playposition", "VuMeter",
                         "visual_bpm", "sync_leader", "scratch2", "scratch2_scratching"}) {
                ControlProxy feedback(QString("[Channel%1]").arg(deck), item);
                feedback.set(1.0 + tick * 0.001);
            }
        }
        QCoreApplication::processEvents();
        EXPECT_EQ(2, state.activeDeck());
        EXPECT_EQ(0, ControlObject::get(ConfigKey("[RX3Display]", "gridpanel1")));
        EXPECT_EQ(1, ControlObject::get(ConfigKey("[RX3Display]", "gridpanel2")));
    }
    ControlObject::set(ConfigKey("[Channel1]", "jog"), 0.2);
    QCoreApplication::processEvents();
    EXPECT_EQ(2, state.activeDeck());
    EXPECT_EQ(0, ControlObject::get(ConfigKey("[RX3Display]", "gridpanel1")));
    ControlObject::set(ConfigKey("[RX3Controller]", "grid_mode"), 0);
}
TEST_F(Rx3ReferenceScaleTest, GridToolsOnlyEditSelectedTrackAndResetEntrySnapshot) {
    PlayerInfo::create();
    {
        const auto first=Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/preview.wav")));const auto second=Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/preview.wav")));
        for(const auto& track : {first,second}) {
            track->setAudioProperties(mixxx::audio::ChannelCount(2),mixxx::audio::SampleRate(48000),mixxx::audio::Bitrate(1411),mixxx::Duration::fromSeconds(20));
            ASSERT_TRUE(track->trySetBeats(mixxx::Beats::fromBeatPositions(mixxx::audio::SampleRate(48000),{mixxx::audio::FramePos(0),mixxx::audio::FramePos(24000),mixxx::audio::FramePos(48000),mixxx::audio::FramePos(72000)})));
            track->setMainCuePosition(mixxx::audio::FramePos(1000));
        }
        PlayerInfo::instance().setTrackInfo("[Channel1]",first);
        PlayerInfo::instance().setTrackInfo("[Channel2]",second);
        ControlObject position1(ConfigKey("[Channel1]","playposition"));
        ControlObject position2(ConfigKey("[Channel2]","playposition"));
        Rx3PerformanceState state;
        const auto original1=first->getBeats();const auto original2=second->getBeats();
        ControlObject::set(ConfigKey("[RX3Controller]","grid_mode"),1);QCoreApplication::processEvents();
        EXPECT_TRUE(mixxx::beatgrid::editingDeck("[Channel1]"));
        EXPECT_FALSE(mixxx::beatgrid::editingDeck("[Channel2]"));
        auto action=[](const QString& key){ControlObject::set(ConfigKey("[RX3Controller]",key),1);ControlObject::set(ConfigKey("[RX3Controller]",key),0);QCoreApplication::processEvents();};
        action("grid_snap_cue");EXPECT_NE(original1,first->getBeats());EXPECT_EQ(original2,second->getBeats());
        EXPECT_EQ(mixxx::audio::FramePos(1000),first->getBeats()->findClosestBeat(mixxx::audio::FramePos(1000)));
        action("grid_reset");EXPECT_EQ(original1,first->getBeats());
        state.selectDeck(2);EXPECT_EQ(1,ControlObject::get(ConfigKey("[RX3Display]","gridpanel2")));
        EXPECT_EQ(0,ControlObject::get(ConfigKey("[RX3Display]","gridpanel1")));
        action("grid_later_half");EXPECT_NE(original2,second->getBeats());EXPECT_EQ(original1,first->getBeats());
        action("grid_earlier_half");
        EXPECT_EQ(original2->findClosestBeat(mixxx::audio::FramePos(24000)),second->getBeats()->findClosestBeat(mixxx::audio::FramePos(24000)));
        action("grid_reset");EXPECT_EQ(original2,second->getBeats());
        ControlObject::set(ConfigKey("[RX3Controller]","grid_mode"),0);QCoreApplication::processEvents();
        EXPECT_FALSE(mixxx::beatgrid::editingDeck("[Channel2]"));
        const auto red=mixxx::beatgrid::displayTicks(200,1,10,true,true);
        EXPECT_EQ(0,red.topStart);EXPECT_EQ(200,red.topEnd);
        const auto white=mixxx::beatgrid::displayTicks(200,1,10,false,true);
        EXPECT_EQ(4,white.topStart);EXPECT_EQ(14,white.topEnd);
    }
    PlayerInfo::destroy();
}
TEST_F(Rx3ReferenceScaleTest, RenderPerformanceTitlesAndJumpCorners) {
    const QString output=qEnvironmentVariable("NAUTIC_PERFORMANCE_QA_DIR");
    if(output.isEmpty()) GTEST_SKIP()<<"Render artifact directory is optional";
    SkinContext context(config(),QString());
    QWidget panel;QVBoxLayout layout(&panel);layout.setContentsMargins(0,0,0,0);
    auto* title=new WRx3ModeTitle(&panel);title->setText("BEAT JUMP");title->setFixedHeight(16);title->setAlignment(Qt::AlignCenter);layout.addWidget(title);
    for(bool reverse : {true,false}) {
        QDomDocument doc;ASSERT_TRUE(doc.setContent(QString("<PushButton><Reverse>%1</Reverse><NumberStates>1</NumberStates><State><Number>0</Number><Text>1</Text></State></PushButton>").arg(reverse?"true":"false")));
        auto* pad=new WRx3JumpPad(&panel);pad->setup(doc.documentElement(),context);pad->setFixedHeight(22);layout.addWidget(pad);
    }
    panel.setStyleSheet("QWidget{background:#000;color:#fff;font-family:Arial;font-weight:bold;} WPushButton{background:#252525;font-size:13px;border:0;}");panel.resize(300,70);panel.show();QCoreApplication::processEvents();
    ASSERT_TRUE(panel.grab().save(QDir(output).filePath("beat-jump.png")));
}

TEST_F(Rx3ReferenceScaleTest, RangeBadgeUsesGreenRedWhiteAndUnboxedWide) {
    ControlPotmeter range(ConfigKey("[Channel1]", "rateRange"), 0.01, 4.0);
    range.set(0.06);
    WRx3RangeBadge badge("[Channel1]");
    EXPECT_EQ(1, badge.getHighlight());
    for (const auto value : {0.10, 0.16, 0.50, 1.0}) {
        range.set(value);
        QCoreApplication::processEvents();
        EXPECT_EQ(value==0.16?2:value>=1?3:0, badge.getHighlight());
    }
    range.set(0.06);
    QCoreApplication::processEvents();
    EXPECT_EQ(1, badge.getHighlight());
}

TEST_F(Rx3ReferenceScaleTest, ReferenceReadoutTypographyRemainsThinWhenScaled) {
    QFile css(qEnvironmentVariable("NAUTIC_RX3_STYLESHEET",
            QDir(config()->getResourcePath()).filePath("../nautic/skins/XDJ_RX3_Mixxx/style.qss")));
    if (!css.exists()) css.setFileName(QDir(config()->getResourcePath()).filePath("skins/XDJ_RX3_Mixxx/style.qss"));
    ASSERT_TRUE(css.open(QIODevice::ReadOnly));
    auto* canvas = new QWidget;
    canvas->setStyleSheet(QString::fromUtf8(css.readAll()));
    auto* layout = new QVBoxLayout(canvas);
    std::vector<WLabel*> labels;
    for (const auto& name : {"DeckTempoPercent", "BPMPercent", "DeckCueLabel", "RateDisplay",
                 "RateRangeSuffix", "DeckHeaderBpmValue", "BpmMaster"}) {
        auto* label = new WLabel(canvas);
        label->setObjectName(name);
        label->setText("126.0");
        layout->addWidget(label);
        labels.push_back(label);
    }
    WReferenceScaler viewport(canvas, QSize(1280,800), nullptr, true);
    viewport.show();
    for (const QSize size : {QSize(1280,800), QSize(2560,1440), QSize(1280,800)}) {
        viewport.resize(size);
        QCoreApplication::processEvents();
        for (const auto* label : labels) {
            const bool regular = label->objectName() == "DeckCueLabel" || label->objectName() == "BpmMaster";
            EXPECT_EQ(regular ? QFont::Normal : QFont::Light, label->font().weight()) << label->objectName().toStdString();
        }
    }
}

#include <QWheelEvent>
#include "widget/wwaveformviewer.h"
TEST_F(Rx3ReferenceScaleTest, WheelOnlyZoomsBothDecksAndKeepsGridSelection) {
    std::vector<std::unique_ptr<ControlObject>> controls;
    for (int deck = 1; deck <= 2; ++deck) {
        for (const auto& item : {"waveform_zoom", "scratch_position_enable", "scratch_position",
                     "wheel", "play", "passthrough", "rate", "beats_translate_curpos"}) {
            controls.push_back(std::make_unique<ControlObject>(
                    ConfigKey(QString("[Channel%1]").arg(deck), item)));
        }
    }
    ControlObject::set(ConfigKey("[Channel1]", "waveform_zoom"), 5);
    ControlObject::set(ConfigKey("[Channel2]", "waveform_zoom"), 3);
    ControlObject::set(ConfigKey("[Channel1]", "rate"), 0.02);
    Rx3PerformanceState selection;
    selection.selectDeck(2);
    ControlObject::set(ConfigKey("[RX3Controller]", "grid_mode"), 1);
    WWaveformViewer first("[Channel1]", config()), second("[Channel2]", config());
    QDomDocument node;
    ASSERT_TRUE(node.setContent(QString("<Visual><Rx3SharedWheelZoom>true</Rx3SharedWheelZoom></Visual>")));
    SkinContext context(config(), QString());
    first.setup(node.documentElement(), context);
    second.setup(node.documentElement(), context);
    auto scroll = [&](QWidget* target, QPoint angle, QPoint pixels, Qt::KeyboardModifiers modifiers) {
        QWheelEvent wheel(QPointF(10,10), QPointF(10,10), pixels, angle,
                Qt::NoButton, modifiers, Qt::NoScrollPhase, false);
        QCoreApplication::sendEvent(target, &wheel);
        EXPECT_TRUE(wheel.isAccepted());
        QCoreApplication::processEvents();
        EXPECT_EQ(ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")),
                ControlObject::get(ConfigKey("[Channel2]", "waveform_zoom")));
        EXPECT_EQ(2, selection.activeDeck());
        EXPECT_DOUBLE_EQ(0.02, ControlObject::get(ConfigKey("[Channel1]", "rate")));
        for (int deck = 1; deck <= 2; ++deck) {
            for (const auto& item : {"scratch_position_enable", "scratch_position", "wheel", "beats_translate_curpos"}) {
                EXPECT_EQ(0, ControlObject::get(ConfigKey(QString("[Channel%1]").arg(deck), item)));
            }
        }
    };
    scroll(&first, QPoint(0,120), {}, Qt::NoModifier);
    EXPECT_EQ(4, ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")));
    scroll(&second, QPoint(0,-120), {}, Qt::ControlModifier | Qt::ShiftModifier);
    EXPECT_EQ(5, ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")));
    scroll(&first, {}, QPoint(0,2), Qt::AltModifier);
    EXPECT_EQ(4, ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")));
    scroll(&second, QPoint(120,0), {}, Qt::NoModifier);
    EXPECT_EQ(4, ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")));
    for (int repeat = 0; repeat < 15; ++repeat) scroll(&first, QPoint(0,120), {}, Qt::NoModifier);
    EXPECT_EQ(1, ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")));
    for (int repeat = 0; repeat < 15; ++repeat) scroll(&second, QPoint(0,-120), {}, Qt::NoModifier);
    EXPECT_EQ(10, ControlObject::get(ConfigKey("[Channel1]", "waveform_zoom")));
    ControlObject::set(ConfigKey("[RX3Controller]", "grid_mode"), 0);
}

#include "widget/wnumberpos.h"
#include "widget/wnumberrate.h"
TEST_F(Rx3ReferenceScaleTest, RenderLoadedThinNumericReadouts) {
    const QString output = qEnvironmentVariable("NAUTIC_PERFORMANCE_QA_DIR");
    if (output.isEmpty()) GTEST_SKIP() << "Render artifact directory is optional";
    ControlObject elapsed(ConfigKey("[Channel1]", "time_elapsed"));
    ControlObject remaining(ConfigKey("[Channel1]", "time_remaining"));
    ControlObject mode(ConfigKey("[Controls]", "ShowDurationRemaining"), false, false, false, 1);
    ControlObject format(ConfigKey("[Controls]", "TimeFormat"));
    ControlObject rate(ConfigKey("[Channel1]", "rate_ratio"), false, false, false, 1.0169);
    QFile css(qEnvironmentVariable("NAUTIC_RX3_STYLESHEET",
            QDir(config()->getResourcePath()).filePath("../nautic/skins/XDJ_RX3_Mixxx/style.qss")));
    if (!css.exists()) css.setFileName(QDir(config()->getResourcePath()).filePath("skins/XDJ_RX3_Mixxx/style.qss"));
    ASSERT_TRUE(css.open(QIODevice::ReadOnly));
    QWidget panel;
    panel.setStyleSheet(QString::fromUtf8(css.readAll()) + " QWidget#ReadoutFixture { background:#000;color:#fff; }");
    panel.setObjectName("ReadoutFixture");
    QHBoxLayout layout(&panel);
    SkinContext context(config(), QString());
    QDomDocument timeNode;
    ASSERT_TRUE(timeNode.setContent(QString("<NumberPos><Rx3Format>deck</Rx3Format></NumberPos>")));
    auto* time = new WNumberPos("[Channel1]", &panel);
    time->setObjectName("DeckTrackTime");
    time->setup(timeNode.documentElement(), context);
    layout.addWidget(time);
    auto* pitch = new WNumberRate("[Channel1]", &panel);
    pitch->setObjectName("DeckTempoPercent");
    QDomDocument pitchNode;
    ASSERT_TRUE(pitchNode.setContent(QString("<NumberRate><NumberOfDigits>2</NumberOfDigits></NumberRate>")));
    pitch->setup(pitchNode.documentElement(), context);
    layout.addWidget(pitch);
    auto* percent = new WLabel(&panel);
    percent->setObjectName("BPMPercent"); percent->setText("%"); layout.addWidget(percent);
    auto* bpm = new WNumber(&panel);
    bpm->setObjectName("DeckHeaderBpmValue");
    QDomDocument bpmNode;
    ASSERT_TRUE(bpmNode.setContent(QString("<Number><Rx3Format>bpm</Rx3Format></Number>")));
    bpm->setup(bpmNode.documentElement(), context); layout.addWidget(bpm);
    panel.resize(620,100); panel.show(); QCoreApplication::processEvents();
    remaining.set(409.342); elapsed.set(30); rate.set(1.0169); bpm->setValue(132.3);
    QCoreApplication::processEvents();
    EXPECT_TRUE(time->text().contains("06:49"));
    EXPECT_EQ(QFont::Light, time->font().weight());
    EXPECT_EQ(QFont::Light, pitch->font().weight());
    EXPECT_EQ(QFont::Light, bpm->font().weight());
    ASSERT_TRUE(panel.grab().save(QDir(output).filePath("numeric-readouts.png")));
}

#include "effects/rx3effectquantize.h"
TEST_F(Rx3ReferenceScaleTest, EffectQuantizeUsesRoutedDeckAndBypassesStoppedDecks) {
    ControlObject setting(ConfigKey("[RX3Settings]","effect_quantize"),false,false,false,1);
    ControlObject active(ConfigKey("[RX3Controller]","active_deck"),false,false,false,1);
    ControlObject play1(ConfigKey("[Channel1]","play"),false,false,false,1);
    ControlObject bpm1(ConfigKey("[Channel1]","visual_bpm"),false,false,false,120);
    ControlObject phase1(ConfigKey("[Channel1]","beat_distance"),false,false,false,0.5);
    ControlObject play2(ConfigKey("[Channel2]","play"),false,false,false,1);
    ControlObject bpm2(ConfigKey("[Channel2]","visual_bpm"),false,false,false,100);
    ControlObject phase2(ConfigKey("[Channel2]","beat_distance"),false,false,false,0.25);
    const QString unit="[EffectRack1_EffectUnit1]";
    ChannelHandleFactory handles;
    QSet<ChannelHandleAndGroup> route{{handles.getOrCreateHandle("[Channel2]"),"[Channel2]"}};
    EXPECT_EQ(450,rx3::effectActivationDelay(unit,route));
    play2.set(0);EXPECT_EQ(0,rx3::effectActivationDelay(unit,route));
    route={{handles.getOrCreateHandle("[Master]"),"[Master]"}};
    EXPECT_EQ(250,rx3::effectActivationDelay(unit,route));
    setting.set(0);EXPECT_EQ(0,rx3::effectActivationDelay(unit,route));
    EXPECT_EQ(0,rx3::effectActivationDelay("[EqualizerRack1_[Channel1]]",route));
}

#include "widget/wrx3countdown.h"
#include <QEventLoop>

TEST(Rx3Countdown, DeadlineIsMonotonicAndPausePreservesRemainingTime) {
    Rx3Countdown timer;timer.setSeconds(2);
    EXPECT_EQ("00:00:02",Rx3Countdown::text(timer.seconds()));EXPECT_DOUBLE_EQ(1,timer.fraction());
    timer.start();QEventLoop loop;QTimer::singleShot(140,&loop,&QEventLoop::quit);loop.exec();
    EXPECT_TRUE(timer.running());EXPECT_LT(timer.fraction(),1);EXPECT_GT(timer.fraction(),0);
    timer.pause();const auto paused=timer.remainingMs();
    QTimer::singleShot(140,&loop,&QEventLoop::quit);loop.exec();EXPECT_EQ(paused,timer.remainingMs());
    timer.setSeconds(0);timer.start();EXPECT_FALSE(timer.running());EXPECT_EQ(0,timer.seconds());
    timer.setSeconds(400000);EXPECT_EQ(359999,timer.seconds());
}
TEST_F(Rx3ReferenceScaleTest, TimerReplacesWaveformStackAndRunsWhenEditorCloses) {
    QWidget canvas;canvas.resize(1100,480);auto* layout=new QVBoxLayout(&canvas);
    auto* rail=new QWidget(&canvas);rail->setObjectName("RX3TransportRail");rail->setFixedHeight(28);layout->addWidget(rail);
    auto* waves=new QWidget(&canvas);waves->setObjectName("Waveforms");layout->addWidget(waves,1);
    auto* stack=new QStackedLayout(waves);stack->setStackingMode(QStackedLayout::StackAll);
    auto* waveform=new QLabel("Waveform surface",waves);stack->addWidget(waveform);
    auto* timer=new WRx3Countdown(config(),&canvas);canvas.show();timer->setOpen(true);QCoreApplication::processEvents();
    EXPECT_FALSE(waveform->isVisible());EXPECT_EQ(QStackedLayout::StackOne,stack->stackingMode());
    timer->findChild<QPushButton*>("CountdownPreset3")->click();EXPECT_EQ(3000,timer->countdown().seconds());
    timer->findChild<QPushButton*>("CountdownStart")->click();EXPECT_TRUE(timer->countdown().running());
    timer->findChild<QPushButton*>("CountdownRemain")->click();EXPECT_FALSE(timer->isVisible());EXPECT_TRUE(waveform->isVisible());
    EXPECT_TRUE(timer->countdown().running());timer->setOpen(true);
    auto* history=timer->findChild<QPushButton*>("CountdownHistory0");EXPECT_TRUE(history->isEnabled());
    history->click();EXPECT_EQ(3000,timer->countdown().seconds());EXPECT_FALSE(timer->countdown().running());
    timer->findChild<QPushButton*>("CountdownClear")->click();
    for(const auto digit:{0,1,2,0,0,0}) timer->findChild<QPushButton*>("CountdownDigit"+QString::number(digit))->click();
    EXPECT_EQ(4800,timer->countdown().seconds());
    timer->findChild<QPushButton*>("CountdownAdjust-300")->click();EXPECT_EQ(4500,timer->countdown().seconds());
    const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
    if(!output.isEmpty()) ASSERT_TRUE(canvas.grab().save(QDir(output).filePath("countdown-1100.png")));
    timer->setOpen(false);
    if(!output.isEmpty()) {
        Rx3Countdown preview;Rx3CountdownRail stopwatch(&preview,[]{},nullptr);
        for(int height:{28,42}) {
            stopwatch.resize(560*height/28,height);stopwatch.show();QCoreApplication::processEvents();
            ASSERT_TRUE(stopwatch.grab().save(QDir(output).filePath(QString("countdown-rail-%1.png").arg(height))));
        }
    }
}
TEST_F(Rx3ReferenceScaleTest, ShortcutUsesBrowserPageAndRestoresPreviousPage) {
    ControlObject page(ConfigKey("[Tab]","current"),false,false,false,0);
    QWidget canvas;WRx3Shortcut panel(config(),nullptr,&canvas);
    panel.setVisibleControl(true);EXPECT_EQ(1,page.get());panel.setVisibleControl(false);EXPECT_EQ(0,page.get());
    page.set(1);panel.setVisibleControl(true);panel.setVisibleControl(false);EXPECT_EQ(1,page.get());
}
TEST_F(Rx3ReferenceScaleTest, ShortcutEncoderCanReachCloseAfterToolsAndRestorePreviousPage) {
    ControlObject page(ConfigKey("[Tab]","current"),false,false,false,0);
    ControlObject masterTempo(ConfigKey("[Channel1]","keylock"),false,false,false,1);
    QWidget canvas;canvas.resize(1280,800);canvas.show();
    WRx3Shortcut panel(config(),nullptr,&canvas);
    auto* closeRow=panel.findChild<QFrame*>("ShortcutRow_close");ASSERT_TRUE(closeRow);
    const auto pulse=[](const QString& key,double value) {
        ControlObject::set(ConfigKey("[RX3Shortcut]",key),value);
        ControlObject::set(ConfigKey("[RX3Shortcut]",key),0);
    };
    for(const double previousPage:{0.0,1.0}) {
        page.set(previousPage);
        pulse("open",1);
        ASSERT_TRUE(panel.isVisible());EXPECT_EQ(1,page.get());
        // MY SETTINGS LOAD is followed by TOOLS, then CLOSE.
        pulse("move",1);
        EXPECT_FALSE(closeRow->property("encoderFocus").toBool());
        pulse("move",1);
        ASSERT_TRUE(closeRow->property("encoderFocus").toBool());
        pulse("move",-1);EXPECT_FALSE(closeRow->property("encoderFocus").toBool());
        pulse("move",1);ASSERT_TRUE(closeRow->property("encoderFocus").toBool());
        pulse("enter",1);
        EXPECT_FALSE(panel.isVisible());
        EXPECT_EQ(0,ControlObject::get(ConfigKey("[RX3Shortcut]","visible")));
        EXPECT_EQ(previousPage,page.get());EXPECT_EQ(1,masterTempo.get());
    }
}
TEST(Rx3Overview, RemainAndTimeShadeOppositeRegionsAndAxisMatches) {
    for(const bool remaining:{false,true}) {
        QImage image(200,60,QImage::Format_ARGB32);image.fill(Qt::white);QPainter painter(&image);
        rx3::drawOverviewShade(&painter,200,60,1,0.25,remaining,false);
        rx3::drawOverviewDivisions(&painter,200,60,1,180,0,{},0.25,remaining);
        painter.end();
        EXPECT_EQ(QColor(Qt::white),image.pixelColor(remaining?150:25,30));
        EXPECT_LT(image.pixelColor(remaining?25:150,30).red(),120);
        EXPECT_EQ(QColor(Qt::white),image.pixelColor(remaining?150:25,45));
        EXPECT_EQ(QColor("#808080"),image.pixelColor(remaining?25:150,45));
    }
    EXPECT_FALSE(rx3::overviewWarningOff(31,true,250));EXPECT_TRUE(rx3::overviewWarningOff(29,true,250));
    EXPECT_FALSE(rx3::overviewWarningOff(29,true,125));EXPECT_TRUE(rx3::overviewWarningOff(14,true,125));
    EXPECT_FALSE(rx3::overviewWarningOff(14,false,125));
}
TEST_F(Rx3ReferenceScaleTest, DeckTimeShortTouchTogglesOnlyThatDeckAndHoldOnlyAutoCue) {
    ControlObject global(ConfigKey("[Controls]","ShowDurationRemaining"),false,false,false,1);
    ControlObject mode1(ConfigKey("[Channel1]","rx3_time_remaining"),false,false,false,1);
    ControlObject mode2(ConfigKey("[Channel2]","rx3_time_remaining"),false,false,false,1);
    ControlObject autoCue(ConfigKey("[Channel1]","rx3_auto_cue"),false,false,false,1);
    ControlObject elapsed(ConfigKey("[Channel1]","time_elapsed"),false,false,false,30);
    ControlObject remaining(ConfigKey("[Channel1]","time_remaining"),false,false,false,90);
    ControlObject format(ConfigKey("[Controls]","TimeFormat"));
    WNumberPos number("[Channel1]");number.resize(300,80);number.show();
    SkinContext context(config(),QString());QDomDocument doc;
    ASSERT_TRUE(doc.setContent(QString("<NumberPos><Rx3Format>deck</Rx3Format></NumberPos>")));number.setup(doc.documentElement(),context);
    auto press=[&number]{QMouseEvent event(QEvent::MouseButtonPress,QPointF(2,2),QPointF(2,2),Qt::LeftButton,Qt::LeftButton,Qt::NoModifier);QCoreApplication::sendEvent(&number,&event);};
    auto release=[&number]{QMouseEvent event(QEvent::MouseButtonRelease,QPointF(2,2),QPointF(2,2),Qt::LeftButton,Qt::NoButton,Qt::NoModifier);QCoreApplication::sendEvent(&number,&event);};
    press();release();EXPECT_EQ(0,mode1.get());EXPECT_EQ(1,mode2.get());EXPECT_TRUE(number.text().contains("00:30")) << number.text().toStdString();
    press();QEventLoop loop;QTimer::singleShot(1100,&loop,&QEventLoop::quit);loop.exec();release();
    EXPECT_EQ(0,autoCue.get());EXPECT_EQ(0,mode1.get());EXPECT_EQ(1,mode2.get());
}

TEST_F(Rx3ReferenceScaleTest, SlipLoopTouchHoldsFractionAndReleasesOnHide) {
    ControlObject loop(ConfigKey("[Channel1]", "rx3_slip_loop"));
    ControlObject other(ConfigKey("[Channel2]", "rx3_slip_loop"));
    SkinContext context(config(), QString());
    QDomDocument node;
    ASSERT_TRUE(node.setContent(QStringLiteral("<PushButton><Channel>1</Channel><Beats>1/3</Beats></PushButton>")));
    WRx3SlipLoopPad pad;
    pad.setup(node.documentElement(), context);
    pad.resize(120, 18);
    pad.show();
    auto press = [&] {
        QMouseEvent event(QEvent::MouseButtonPress, QPointF(2,2), QPointF(2,2), Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
        QCoreApplication::sendEvent(&pad, &event);
    };
    press();
    EXPECT_DOUBLE_EQ(1.0 / 3, loop.get());
    EXPECT_EQ(0, other.get());
    QMouseEvent release(QEvent::MouseButtonRelease, QPointF(2,2), QPointF(2,2), Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
    QCoreApplication::sendEvent(&pad, &release);
    EXPECT_EQ(0, loop.get());
    press();
    pad.hide();
    EXPECT_EQ(0, loop.get());
}

TEST(Rx3DeckBadge, SlipIndicatorUsesYellowWithoutChangingDeckNumber) {
    QImage image(92,52,QImage::Format_ARGB32);
    image.fill(Qt::black);
    QPainter painter(&image);
    rx3::drawDeckBadge(&painter,QRectF(0,0,92,52),1,0,true,true);
    painter.end();
    int yellow = 0;
    for (int y=0;y<14;++y) for (int x=66;x<92;++x) {
        const auto color=image.pixelColor(x,y);
        if(color.red()>100 && color.green()>100 && color.blue()<20) ++yellow;
    }
    EXPECT_GT(yellow,10);
}

#include "widget/wrx3info.h"
TEST_F(Rx3ReferenceScaleTest, InfoStackHidesWaveformsRetainsFooterAndUsesDeckButtons) {
    PlayerInfo::create();
    {
        ControlObject page(ConfigKey("[Tab]","current"));
        auto* canvas=new QWidget;auto* layout=new QVBoxLayout(canvas);
        auto* top=new QWidget(canvas);auto* header=new QHBoxLayout(top);header->addWidget(new QLabel("INFO",top));
        top->findChild<QLabel*>()->setObjectName("RX3InfoLabel");layout->addWidget(top);
        auto* area=new QWidget(canvas);area->setObjectName("RX3PerformanceArea");auto* waves=new QWidget(area);
        waves->setObjectName("Waveforms");auto* row=new QHBoxLayout(area);row->addWidget(waves);layout->addWidget(area,1);
        auto* modes=new QWidget(canvas);modes->setObjectName("RX3ModeStripContainer");layout->addWidget(modes);
        auto* footer=new QLabel("Live deck footer",canvas);layout->addWidget(footer);
        WRx3Info info(nullptr,canvas);canvas->resize(1280,800);canvas->show();QCoreApplication::processEvents();
        EXPECT_TRUE(waves->isVisible());info.setOpen(true);QCoreApplication::processEvents();
        EXPECT_FALSE(waves->isVisible());EXPECT_TRUE(footer->isVisible());EXPECT_FALSE(modes->isVisible());
        EXPECT_EQ(1,ControlObject::get(ConfigKey("[RX3Info]","visible")));
        info.findChild<QPushButton*>("RX3InfoDeck2")->click();EXPECT_TRUE(info.isVisible());
        const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
        if(!output.isEmpty()) EXPECT_TRUE(canvas->grab().save(QDir(output).filePath("info-empty.png")));
        info.setOpen(false);EXPECT_TRUE(waves->isVisible());EXPECT_TRUE(modes->isVisible());
        // Remove the page before destroying its parent-owned layout.
        info.setParent(nullptr);delete canvas;
    }
    PlayerInfo::destroy();
}

TEST_F(Rx3ReferenceScaleTest, InfoMetadataHasArtworkCommentJumpAndBoundedRatingPreview) {
    rx3::InfoTrack data;data.location="track.mp3";data.root="usb";
    data.record=mixxx::rekordbox::RuntimeTrack{};data.record->rekordboxId=1;
    data.values[0]="Boats";data.values[1]="Xinobi";data.values[4]="122.0 bpm";
    data.values[5]="Bbm";data.values[8]="Chill House";data.values[9]="2021-09-08";
    data.comment="BB39";data.rating=4;data.number=6;data.total=56;
    Rx3TrackInfoPanel panel(nullptr);panel.resize(1000,480);panel.setTrack(data);panel.show();
    QString jumped;panel.setJump([&](const QString& key,const rx3::InfoTrack&){jumped=key;});
    panel.move(8);panel.enter();EXPECT_EQ(QString("genre"),jumped);
    panel.move(-2);panel.hold(true);panel.move(12);
    auto* fields=panel.findChild<QListWidget*>("RX3InfoFields");ASSERT_TRUE(fields);
    EXPECT_EQ(QString(5,QChar(0x2605)),fields->item(6)->text());
    panel.move(-12);EXPECT_EQ(QString(5,QChar(0x2606)),fields->item(6)->text());panel.hold(false);
    const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
    if(!output.isEmpty()) EXPECT_TRUE(panel.grab().save(QDir(output).filePath("info-metadata.png")));
    data.record.reset();panel.setTrack(data);panel.move(8);jumped.clear();panel.enter();EXPECT_TRUE(jumped.isEmpty());
}

TEST_F(Rx3ReferenceScaleTest, WaveformColorButtonsPaintSamplesAndKeepSelectionControl) {
    QWidget canvas;canvas.resize(1280,800);canvas.show();WRx3Shortcut panel(config(),nullptr,&canvas);
    panel.setVisibleControl(true);QCoreApplication::processEvents();
    const QStringList names={"BLUE","RGB","3BAND"};
    for(int i=0;i<3;++i) {
        auto* button=panel.findChild<QPushButton*>(QString("Shortcut_waveform_color_%1").arg(i));ASSERT_TRUE(button);
        EXPECT_EQ(names[i],button->accessibleName());button->click();
        EXPECT_EQ(i,ControlObject::get(ConfigKey("[RX3Settings]","waveform_color")));
        const auto image=button->grab().toImage();
        EXPECT_NE(QColor("#007CE0"),image.pixelColor(image.width()/2,image.height()/3));
    }
}


#include "widget/wrx3emergency.h"
TEST_F(Rx3ReferenceScaleTest, EmergencyViewHidesOnlyLostDeckAndRestoresSharedFootersOnLoad) {
    ControlObject lost1(ConfigKey("[Channel1]","rx3_source_lost"));ControlObject lost2(ConfigKey("[Channel2]","rx3_source_lost"));
    ControlObject loop1(ConfigKey("[Channel1]","rx3_emergency_loop"));ControlObject loop2(ConfigKey("[Channel2]","rx3_emergency_loop"));
    QWidget canvas;canvas.resize(1280,800);auto* root=new QVBoxLayout(&canvas);
    auto* area=new QWidget(&canvas);area->setObjectName("RX3PerformanceArea");auto* waves=new QHBoxLayout(area);root->addWidget(area,1);
    std::array<QLabel*,2> overview{},waveform{},title{};
    for(int i=0;i<2;++i) {
        auto* rail=new QWidget(area);rail->setProperty("rx3Deck",i+1);auto* column=new QVBoxLayout(rail);waves->addWidget(rail);
        waveform[i]=new QLabel("Native waveform",rail);waveform[i]->setObjectName(QString("Waveform%1").arg(i+1));column->addWidget(waveform[i]);
        auto* bars=new QLabel("09.3 Bars",rail);bars->setObjectName("WaveformInfo_Bars");column->addWidget(bars);
        auto* footer=new QWidget(&canvas);footer->setProperty("rx3Deck",i+1);auto* row=new QHBoxLayout(footer);root->addWidget(footer);
        title[i]=new QLabel("Loaded title",footer);title[i]->setObjectName("DeckTitle");row->addWidget(title[i]);
        overview[i]=new QLabel("Loaded overview",footer);overview[i]->setObjectName("RX3LibraryDeckOverview");row->addWidget(overview[i]);
    }
    WRx3Emergency presentation(&canvas);canvas.show();QCoreApplication::processEvents();
    lost1.set(1);loop1.set(1);QCoreApplication::processEvents();
    EXPECT_FALSE(waveform[0]->isVisibleTo(&canvas));EXPECT_TRUE(waveform[1]->isVisibleTo(&canvas));
    EXPECT_FALSE(title[0]->isVisibleTo(&canvas));EXPECT_FALSE(overview[0]->isVisibleTo(&canvas));
    EXPECT_TRUE(overview[1]->isVisibleTo(&canvas));
    auto* message=canvas.findChild<QLabel*>("RX3EmergencyMessage");ASSERT_TRUE(message);EXPECT_TRUE(message->isVisibleTo(&canvas));
    lost2.set(1);loop2.set(1);QCoreApplication::processEvents();
    EXPECT_FALSE(waveform[1]->isVisibleTo(&canvas));EXPECT_FALSE(overview[1]->isVisibleTo(&canvas));
    const auto output=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
    if(!output.isEmpty()) EXPECT_TRUE(canvas.grab().save(QDir(output).filePath("emergency-both-decks.png")));
    lost1.set(0);loop1.set(0);lost2.set(0);loop2.set(0);QCoreApplication::processEvents();
    EXPECT_TRUE(waveform[0]->isVisibleTo(&canvas));EXPECT_TRUE(title[0]->isVisibleTo(&canvas));
    EXPECT_TRUE(overview[0]->isVisibleTo(&canvas));EXPECT_FALSE(message->isVisibleTo(&canvas));
}

namespace {
QWidget* makeEmptyLogoCanvas(UserSettingsPointer config) {
    const QString skin = qEnvironmentVariable("NAUTIC_SKIN_DIR",
            QDir(config->getResourcePath()).filePath("../nautic/skins/XDJ_RX3_Mixxx"));
    QFile css(skin + "/style.qss");
    if (!css.open(QIODevice::ReadOnly)) return nullptr;
    auto* canvas = new QWidget;
    canvas->setObjectName("Mixxx");
    QString style = QString::fromUtf8(css.readAll());
    style.replace("skin:/", skin + "/");
    canvas->setStyleSheet(style);
    auto* row = new QHBoxLayout(canvas);
    row->setContentsMargins(0, 0, 0, 0);
    auto* waves = new WWidgetGroup(canvas);
    waves->setObjectName("Waveforms");
    QDomDocument node;
    node.setContent(QStringLiteral("<WidgetGroup><Layout>stacked</Layout></WidgetGroup>"));
    SkinContext context(config, QString());
    waves->setup(node.documentElement(), context);
    row->addWidget(waves);
    auto* side = new QWidget(canvas);
    side->setFixedWidth(184);
    row->addWidget(side);
    auto* content = new WWidgetGroup(waves);
    content->setObjectName("WaveformsContent");
    node.setContent(QStringLiteral("<WidgetGroup><Layout>horizontal</Layout></WidgetGroup>"));
    content->setup(node.documentElement(), context);
    waves->addWidget(content);
    auto* cards = new QWidget(content);
    cards->setObjectName("WaveformDeckInfo");
    cards->setFixedWidth(176);
    content->addWidget(cards);
    auto* signalArea = new WWidgetGroup(content);
    signalArea->setObjectName("WaveformSignals");
    node.setContent(QStringLiteral("<WidgetGroup><Layout>stacked</Layout></WidgetGroup>"));
    signalArea->setup(node.documentElement(), context);
    content->addWidget(signalArea);
    auto* logo = new WWidgetGroup(signalArea);
    logo->setObjectName("NauticBgLogoContainer");
    node.setContent(QStringLiteral("<WidgetGroup><Layout>vertical</Layout></WidgetGroup>"));
    logo->setup(node.documentElement(), context);
    auto* label = new WLabel(logo);
    label->setObjectName("NauticBgLogo");
    label->setFixedSize(420, 140);
    logo->addWidget(label);
    signalArea->addWidget(logo);
    auto* signalContent = new WWidgetGroup(signalArea);
    signalContent->setObjectName("WaveformSignalContent");
    signalContent->setup(node.documentElement(), context);
    for (int deck = 0; deck < 2; ++deck) {
        auto* surface = new QWidget(signalContent);
        surface->setMinimumHeight(200);
        surface->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
        surface->setAutoFillBackground(true);
        QPalette colors = surface->palette();
        colors.setColor(QPalette::Window, Qt::black);
        surface->setPalette(colors);
        signalContent->addWidget(surface);
    }
    signalArea->addWidget(signalContent);
    qobject_cast<QStackedLayout*>(signalArea->layout())->setCurrentWidget(signalContent);
    return canvas;
}
}

TEST_F(Rx3ReferenceScaleTest, EmptyLogoIsCompleteAboveRowsAndHidesForEitherLoadedDeck) {
    ControlObject loaded1(ConfigKey("[Channel1]", "track_loaded"));
    ControlObject loaded2(ConfigKey("[Channel2]", "track_loaded"));
    auto* canvas = makeEmptyLogoCanvas(config());
    ASSERT_NE(nullptr, canvas);
    auto* waves = canvas->findChild<QWidget*>("WaveformSignals");
    auto* stack = qobject_cast<QStackedLayout*>(waves->layout());
    auto* logo = canvas->findChild<QWidget*>("NauticBgLogoContainer");
    auto* label = canvas->findChild<QWidget*>("NauticBgLogo");
    auto* content = canvas->findChild<QWidget*>("WaveformSignalContent");
    WReferenceScaler viewport(canvas, QSize(1280, 800), nullptr, true);
    viewport.show();
    QCoreApplication::processEvents();
    Rx3DisplayState state;
    state.bindCanvas(canvas);
    for (const auto size : {QSize(1280, 800), QSize(1920, 1080), QSize(1280, 800)}) {
        viewport.resize(size);
        QCoreApplication::processEvents();
        ASSERT_EQ(logo, stack->currentWidget());
        ASSERT_TRUE(label->isVisible());
        EXPECT_FALSE(content->isVisible());
        EXPECT_TRUE(canvas->findChild<QWidget*>("WaveformDeckInfo")->isVisible());
        EXPECT_EQ(QStackedLayout::StackOne, stack->stackingMode());
        EXPECT_TRUE(logo->testAttribute(Qt::WA_TransparentForMouseEvents));
        // The composited image must contain every pixel of the complete label,
        // including the top and bottom of the N rather than just the row gap.
        const auto fullLabel = label->grab().toImage();
        const auto fullCanvas = viewport.grab().toImage();
        const QPoint labelPosition = label->mapTo(&viewport, QPoint(0, 0));
        const double dpr = fullCanvas.devicePixelRatio();
        const QRect crop(qRound(labelPosition.x() * dpr), qRound(labelPosition.y() * dpr),
                fullLabel.width(), fullLabel.height());
        const auto onBlack = [](const QImage& image) {
            QImage composited(image.size(), QImage::Format_RGB32);
            composited.setDevicePixelRatio(image.devicePixelRatio());
            composited.fill(Qt::black);
            QPainter painter(&composited);
            painter.drawImage(QPoint(0, 0), image);
            return composited;
        };
        EXPECT_EQ(onBlack(fullLabel), onBlack(fullCanvas.copy(crop)));
        const auto visibleLabel = onBlack(fullLabel);
        int lightPixels = 0;
        for (int y = 0; y < fullLabel.height(); ++y) {
            for (int x = 0; x < fullLabel.width(); ++x) {
                if (qGray(visibleLabel.pixel(x, y)) > 128) ++lightPixels;
            }
        }
        EXPECT_GT(lightPixels, 500);
        const auto output = qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
        if (!output.isEmpty()) ASSERT_TRUE(fullCanvas.save(output +
                QString("/empty-logo-%1.png").arg(size.width())));
        loaded2.set(1); QCoreApplication::processEvents();
        EXPECT_FALSE(label->isVisible()); EXPECT_EQ(content, stack->currentWidget());
        loaded1.set(1); loaded2.set(0); QCoreApplication::processEvents();
        EXPECT_FALSE(label->isVisible()); EXPECT_EQ(content, stack->currentWidget());
        loaded1.set(0); QCoreApplication::processEvents();
        EXPECT_TRUE(label->isVisible()); EXPECT_EQ(logo, stack->currentWidget());
    }
}

TEST_F(Rx3ReferenceScaleTest, EmptyLogoRestoresAfterTimerAndDelayedStackChanges) {
    ControlObject loaded1(ConfigKey("[Channel1]", "track_loaded"));
    ControlObject loaded2(ConfigKey("[Channel2]", "track_loaded"));
    auto* canvas = makeEmptyLogoCanvas(config());
    ASSERT_NE(nullptr, canvas);
    canvas->resize(1280, 800); canvas->show();
    Rx3DisplayState state;
    auto* timer = new WRx3Countdown(config(), canvas);
    state.bindCanvas(canvas);
    auto* waves = canvas->findChild<QWidget*>("Waveforms");
    auto* stack = qobject_cast<QStackedLayout*>(waves->layout());
    auto* logo = canvas->findChild<QWidget*>("NauticBgLogoContainer");
    auto* content = canvas->findChild<QWidget*>("WaveformsContent");
    auto* signalContent = canvas->findChild<QWidget*>("WaveformSignalContent");
    auto* signalStack = qobject_cast<QStackedLayout*>(canvas->findChild<QWidget*>("WaveformSignals")->layout());
    timer->setOpen(true); loaded1.set(1); QCoreApplication::processEvents();
    EXPECT_EQ(timer, stack->currentWidget());
    timer->setOpen(false); QCoreApplication::processEvents();
    EXPECT_EQ(content, stack->currentWidget()); EXPECT_FALSE(logo->isVisible());
    loaded1.set(0); QCoreApplication::processEvents();
    EXPECT_EQ(content, stack->currentWidget()); EXPECT_TRUE(logo->isVisible());
    EXPECT_EQ(logo, signalStack->currentWidget()); EXPECT_FALSE(signalContent->isVisible());
    // A delayed page/layout restoration must not leave the empty logo behind.
    signalStack->setCurrentWidget(signalContent); waves->hide(); waves->show();
    QCoreApplication::processEvents();
    EXPECT_EQ(logo, signalStack->currentWidget());
    delete canvas;
}


TEST(Rx3Overview, EndWarningDimsTheWholeAddressAndHonorsThresholds) {
    EXPECT_FALSE(rx3::overviewWarningOff(30, true, 250));
    EXPECT_TRUE(rx3::overviewWarningOff(29.9, true, 250));
    EXPECT_FALSE(rx3::overviewWarningOff(15, true, 125));
    EXPECT_TRUE(rx3::overviewWarningOff(14.9, true, 125));
    EXPECT_FALSE(rx3::overviewWarningOff(14, false, 125));
    EXPECT_FALSE(rx3::overviewWarningOff(14, true, 125, 0));
    EXPECT_TRUE(rx3::overviewWarningOff(40, true, 250, 60));
    for (bool remaining : {false, true}) {
        QImage on(300, 80, QImage::Format_ARGB32); on.fill(Qt::black);
        QImage off = on;
        { QPainter painter(&on); rx3::drawOverviewDivisions(&painter, 300, 80, 1, 120, 0, {}, 0.5, remaining, false); }
        { QPainter painter(&off); rx3::drawOverviewDivisions(&painter, 300, 80, 1, 120, 0, {}, 0.5, remaining, true); }
        for (int x : {25, 250}) {
            EXPECT_GE(on.pixelColor(x, 65).red(), 128);
            EXPECT_EQ(QColor("#202020"), off.pixelColor(x, 65));
        }
        EXPECT_EQ(on.pixelColor(76, 73), off.pixelColor(76, 73));
    }
}

#include "widget/woverview.h"
#include "waveform/waveformwidgetfactory.h"
namespace {
class OverviewPaintCounter : public QObject {
  public:
    int paints = 0;
    bool eventFilter(QObject*, QEvent* event) override {
        if (event->type() == QEvent::Paint) ++paints;
        return false;
    }
};
}
TEST_F(Rx3ReferenceScaleTest, ActualOverviewWarningRepaintsAtRestAndStopsWhenPaused) {
    const QString group = "[Channel1]";
    ControlObject play(ConfigKey(group, "play"), false, false, false, 1);
    ControlObject position(ConfigKey(group, "playposition"), false, false, false, 0.5);
    ControlObject samples(ConfigKey(group, "track_samples"), false, false, false, 48000 * 2 * 120);
    ControlObject rate(ConfigKey(group, "track_samplerate"), false, false, false, 48000);
    ControlObject ratio(ConfigKey(group, "rate_ratio"), false, false, false, 1);
    ControlObject remaining(ConfigKey(group, "time_remaining"), false, false, false, 29);
    ControlObject mode(ConfigKey(group, "rx3_time_remaining"), false, false, false, 1);
    struct FactoryScope {
        FactoryScope() { WaveformWidgetFactory::createInstance(); }
        ~FactoryScope() { WaveformWidgetFactory::destroy(); }
    } factoryScope;
    auto* factory = WaveformWidgetFactory::instance();
    const int originalWarning = factory->getEndOfTrackWarningTime();
    factory->setEndOfTrackWarningTime(30);
    WOverview overview(group, nullptr, config());
    SkinContext context(config(), QString()); QDomDocument xml;
    ASSERT_TRUE(xml.setContent(QStringLiteral("<Overview><Rx3Overview>true</Rx3Overview></Overview>")));
    overview.setup(xml.documentElement(), context);
    overview.resize(300, 80); overview.initWithTrack(Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/preview.wav")))); overview.show();
    QCoreApplication::processEvents();
    OverviewPaintCounter counter; overview.installEventFilter(&counter);
    QTest::qWait(600);
    EXPECT_GT(counter.paints, 1);
    bool lit = false, dim = false;
    for (int attempt = 0; attempt < 8; ++attempt) {
        const auto image = overview.grab().toImage();
        const auto color = image.pixelColor(250, 65);
        lit = lit || color == QColor(Qt::white);
        dim = dim || color == QColor("#202020");
        const auto output = qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
        if (!output.isEmpty() && (color == QColor(Qt::white) || color == QColor("#202020"))) {
            QDir().mkpath(output);
            EXPECT_TRUE(image.save(output + (color == QColor(Qt::white) ? "/address-lit.png" : "/address-dim.png")));
        }
        QTest::qWait(80);
    }
    EXPECT_TRUE(lit); EXPECT_TRUE(dim);
    play.set(0); QCoreApplication::processEvents();
    EXPECT_EQ(QColor(Qt::white), overview.grab().toImage().pixelColor(250, 65));
    QCoreApplication::processEvents(); counter.paints = 0;
    QTest::qWait(300); EXPECT_EQ(0, counter.paints);
    factory->setEndOfTrackWarningTime(0); play.set(1); QCoreApplication::processEvents();
    EXPECT_EQ(QColor(Qt::white), overview.grab().toImage().pixelColor(250, 65));
    QCoreApplication::processEvents(); counter.paints = 0;
    QTest::qWait(300); EXPECT_EQ(0, counter.paints);
    factory->setEndOfTrackWarningTime(originalWarning);
}

TEST_F(Rx3ReferenceScaleTest, Rx3OverviewEndStateKeepsBackgroundAndFrameColors) {
    const QString group="[Channel1]";
    ControlObject play(ConfigKey(group,"play"),false,false,false,0);
    ControlObject position(ConfigKey(group,"playposition"),false,false,false,0.5);
    ControlObject samples(ConfigKey(group,"track_samples"),false,false,false,48000*2*120);
    ControlObject rate(ConfigKey(group,"track_samplerate"),false,false,false,48000);
    ControlObject ratio(ConfigKey(group,"rate_ratio"),false,false,false,1);
    ControlObject remaining(ConfigKey(group,"time_remaining"),false,false,false,10);
    ControlObject mode(ConfigKey(group,"rx3_time_remaining"),false,false,false,1);
    ControlObject end(ConfigKey(group,"end_of_track"),false,false,false,0);
    struct FactoryScope {
        FactoryScope() {WaveformWidgetFactory::createInstance();}
        ~FactoryScope() {WaveformWidgetFactory::destroy();}
    } factoryScope;
    for(const bool rx3Overview:{true,false}) {
        end.set(0);
        WOverview overview(group,nullptr,config());
        SkinContext context(config(),QString());QDomDocument xml;
        ASSERT_TRUE(xml.setContent(QString("<Overview><Rx3Overview>%1</Rx3Overview>"
                "<BgColor>#000000</BgColor><AxesColor>#00000000</AxesColor>"
                "<EndOfTrackColor>#c81914</EndOfTrackColor></Overview>")
                .arg(rx3Overview?"true":"false")));
        overview.setup(xml.documentElement(),context);overview.resize(300,80);
        overview.initWithTrack(Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/preview.wav"))));
        overview.show();QCoreApplication::processEvents();
        const auto normal=overview.grab().toImage();
        for(const double seconds:{10.0,0.0}) {
            remaining.set(seconds);end.set(1);QCoreApplication::processEvents();
            const auto ending=overview.grab().toImage();
            if(rx3Overview) EXPECT_EQ(normal,ending);
            else {
                EXPECT_NE(normal,ending);
                const auto background=ending.pixelColor(250,20);
                const auto frame=ending.pixelColor(250,0);
                EXPECT_GT(background.red(),background.green()+20);
                EXPECT_GT(frame.red(),frame.green()+50);
            }
            end.set(0);
        }
    }
}

#include "widget/rx3touchpreview.h"
#include "track/track.h"
#include "control/controlobject.h"
#include "control/controlpushbutton.h"
class Rx3TouchPreviewTest : public MixxxTest {};
TEST_F(Rx3TouchPreviewTest, AsyncSeekReleaseAndSupersededLoads) {
    ControlPushButton play(ConfigKey("[PreviewDeck1]", "play"));
    ControlObject position(ConfigKey("[PreviewDeck1]", "playposition"));
    ControlObject main(ConfigKey("[PreviewDeck1]", "main_mix"));
    ControlObject pfl(ConfigKey("[PreviewDeck1]", "pfl"));
    auto first = Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/preview.wav"))); auto second = Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/preview.wav")));
    TrackPointer requested;
    rx3::TouchPreview preview([&](TrackPointer track) { requested = track; });
    preview.begin(first, {}, 0.75); EXPECT_EQ(first, requested); EXPECT_EQ(0, play.get());
    preview.move(0.8); preview.completed(first);
    EXPECT_EQ(0.8, position.get()); EXPECT_EQ(1, play.get());
    EXPECT_EQ(0, main.get()); EXPECT_EQ(1, pfl.get());
    preview.move(-1); EXPECT_EQ(0, position.get());
    preview.move(2); EXPECT_EQ(1, position.get());
    preview.cancel(); EXPECT_EQ(0, play.get());
    preview.begin(first, {}, 0.5); preview.cancel(); preview.completed(first);
    EXPECT_EQ(0, play.get());
    preview.begin(second, {}, 0.25); preview.completed(first); EXPECT_EQ(0, play.get());
    preview.completed(second); EXPECT_EQ(1, play.get()); EXPECT_EQ(0.25, position.get());
    preview.cancel();
}

TEST(Rx3LibraryWorkflow, TagsPreserveOrderAndEnforceCapacity) {
    rx3::TagList tags;
    EXPECT_FALSE(tags.toggle(0));
    for(quint32 id=1;id<=100;++id) ASSERT_TRUE(tags.toggle(id));
    EXPECT_FALSE(tags.toggle(101));EXPECT_EQ(100,tags.ids().size());
    ASSERT_TRUE(tags.toggle(50));ASSERT_TRUE(tags.toggle(101));
    EXPECT_FALSE(tags.ids().contains(50));EXPECT_EQ(101u,tags.ids().last());
    tags.clear();EXPECT_TRUE(tags.ids().isEmpty());
}
TEST(Rx3LibraryWorkflow, FilterCombinesConditionsAndRejectsMissingRequiredMetadata) {
    mixxx::rekordbox::RuntimeTrack track;track.bpm=120;track.key="Am";track.rating=4;track.colorId=2;
    rx3::TrackFilter filter;filter.referenceBpm=120;filter.tempoTolerance=0.06;
    filter.referenceKey="Am";filter.keyMode=1;filter.minimumRating=3;filter.color=2;
    ASSERT_TRUE(filter.accepts(track));track.bpm=130;EXPECT_FALSE(filter.accepts(track));
    track.bpm=120;track.rating=2;EXPECT_FALSE(filter.accepts(track));
    track.rating=4;track.key="UNKNOWN";EXPECT_FALSE(filter.accepts(track));
    track.key="Am";track.colorId=3;EXPECT_FALSE(filter.accepts(track));
    track.colorId=2;track.bpm.reset();EXPECT_FALSE(filter.accepts(track));
    filter.tempoTolerance=0;EXPECT_TRUE(filter.accepts(track));
    filter={};track.key.clear();track.rating.reset();track.colorId.reset();EXPECT_TRUE(filter.accepts(track));
}
TEST(Rx3ToolMenu, EncoderEditingBackAndSelfReplacingActions) {
    WRx3ToolMenu menu(nullptr);int value=0,backCalls=0,executed=0;
    menu.showMenu("TOOLS",{
        {[]{return QString("VALUE");},{},[&](int delta){value+=delta;}},
        {[]{return QString("SUBMENU");},[&]{++executed;menu.showMenu("SUB",{{[]{return QString("DONE");},{},{}}},[&]{++backCalls;});},{}}
    },[&]{++backCalls;});
    menu.enter();menu.move(3);EXPECT_EQ(3,value);menu.goBack();EXPECT_EQ(0,backCalls);
    menu.move(1);menu.enter();EXPECT_EQ(1,executed);menu.goBack();EXPECT_EQ(1,backCalls);
}

#include "sources/rx3autocue.h"
TEST(Rx3MySettings, SaveChangesOnlyOwnedFieldsAndRecomputesChecksum) {
    const auto original=rx3SettingsFixture("MYSETTING.DAT",{{25,0x83},{8,0x81}});
    QString error;const auto updated=rx3::writeMySettings("MYSETTING.DAT",original,{{"tempo_range",0.16},{"play_mode",1},{"auto_cue_level",-72}},&error);
    ASSERT_TRUE(error.isEmpty());ASSERT_EQ(original.size(),updated.size());
    EXPECT_EQ(original[112],updated[112]);
    const auto checked=rx3::readMySettings("MYSETTING.DAT",updated);ASSERT_TRUE(checked.error.isEmpty());
    EXPECT_EQ(0.16,checked.values.value("tempo_range"));EXPECT_EQ(1,checked.values.value("play_mode"));EXPECT_EQ(-72,checked.values.value("auto_cue_level"));
    error.clear();EXPECT_TRUE(rx3::writeMySettings("MYSETTING.DAT",original,{{"tempo_range",0.99}},&error).isEmpty());EXPECT_FALSE(error.isEmpty());
}
TEST(Rx3AutoCue, SoundLevelsUseAbsoluteAmplitudeAndSourceFramePositions) {
    rx3::SoundStartLevels levels;
    const CSAMPLE samples[]={0,0,0.0002f,-0.0002f,0.002f,-0.002f,0.03f,-0.03f};
    levels.consume(samples,4,2,100);
    ASSERT_TRUE(levels.complete());const auto positions=levels.positions();ASSERT_EQ(8,positions.size());
    EXPECT_EQ(103,positions[0].toDouble());EXPECT_EQ(102,positions[4].toDouble());EXPECT_EQ(101,positions[7].toDouble());
}

TEST(Rx3MySettings, UsbSaveValidatesEveryFileBeforeCommitAndRetainsRecoveryCopy) {
    QTemporaryDir usb;
    ASSERT_TRUE(usb.isValid());ASSERT_TRUE(QDir().mkpath(usb.filePath("PIONEER/rekordbox")));
    const rx3::UsbStorageInfo storage(usb.path());
    ASSERT_TRUE(storage.isReady());ASSERT_FALSE(storage.isReadOnly());ASSERT_GT(storage.bytesAvailable(),0);
    auto write=[&](const QString& name,const QByteArray& bytes) {
        QFile file(usb.filePath("PIONEER/"+name));
        return file.open(QIODevice::WriteOnly) && file.write(bytes)==bytes.size();
    };
    auto read=[&](const QString& name) {QFile file(usb.filePath("PIONEER/"+name));if(!file.open(QIODevice::ReadOnly)) return QByteArray();return file.readAll();};
    ASSERT_TRUE(write("rekordbox/export.pdb","identity fixture"));
    const auto original=rx3SettingsFixture("MYSETTING.DAT",{{36,0x80}});
    ASSERT_TRUE(write("MYSETTING.DAT",original));ASSERT_TRUE(write("MYSETTING2.DAT","invalid"));
    const auto rejected=rx3::saveUsbMySettings(usb.path(),{{"tempo_range",0.16}});
    EXPECT_TRUE(rejected.contains("No settings saved"))<<rejected.toStdString();
    EXPECT_EQ(original,read("MYSETTING.DAT"));
    QFile::remove(usb.filePath("PIONEER/MYSETTING2.DAT"));
    const auto saved=rx3::saveUsbMySettings(usb.path(),{{"tempo_range",0.16}});
    ASSERT_TRUE(saved.startsWith("MY SETTINGS saved"))<<saved.toStdString();
    EXPECT_EQ(original,read("MYSETTING.DAT.nauticmixxx-settings-backup"));
    const auto result=rx3::readMySettings("MYSETTING.DAT",read("MYSETTING.DAT"));
    ASSERT_TRUE(result.error.isEmpty());EXPECT_EQ(0.16,result.values.value("tempo_range"));
    EXPECT_EQ(QByteArray("identity fixture"),read("rekordbox/export.pdb"));
}

#include "engine/channels/rx3microphonetone.h"
#include <cmath>
#include <limits>

namespace {
std::vector<CSAMPLE> rx3MicSine(double rate,double frequency,int frames) {
    std::vector<CSAMPLE> signal(frames*2);
    for(int frame=0;frame<frames;++frame) signal[2*frame]=CSAMPLE(0.1*std::sin(2*3.14159265358979323846*frequency*frame/rate));
    return signal;
}
double rx3MicRms(const std::vector<CSAMPLE>& signal) {
    double power=0;int count=0;
    for(size_t sample=signal.size()/2;sample<signal.size();sample+=2) {power+=signal[sample]*signal[sample];++count;}
    return std::sqrt(power/count);
}
}
TEST(Rx3MicrophoneTone, NeutralIsTransparentAndChannelsAreIndependent) {
    auto signal=rx3MicSine(48000,1000,48000);const auto original=signal;
    rx3::MicrophoneTone tone;tone.process(signal.data(),int(signal.size()),48000,0,0,false);
    EXPECT_EQ(original,signal);
    tone.process(signal.data(),int(signal.size()),48000,12,-12,true);
    for(size_t sample=0;sample<signal.size();sample+=2) {
        EXPECT_TRUE(std::isfinite(signal[sample]));EXPECT_FLOAT_EQ(0,signal[sample+1]);
    }
}
TEST(Rx3MicrophoneTone, ShelvesBoostAndCutEachBandAcrossSampleRates) {
    for(double rate: {44100.0,48000.0,96000.0}) for(bool high: {false,true}) for(double gain: {-12.0,12.0}) {
        auto signal=rx3MicSine(rate,high?10000:100,int(rate));const auto inputRms=rx3MicRms(signal);
        rx3::MicrophoneTone tone;tone.process(signal.data(),int(signal.size()),rate,high?0:gain,high?gain:0,false);
        EXPECT_NEAR(gain,20*std::log10(rx3MicRms(signal)/inputRms),1.1) << rate << " high=" << high;
    }
}
TEST(Rx3MicrophoneTone, LowCutRejectsRumbleAndResetRemovesPreviousSignal) {
    auto signal=rx3MicSine(48000,20,48000);const auto inputRms=rx3MicRms(signal);
    rx3::MicrophoneTone tone;tone.process(signal.data(),int(signal.size()),48000,0,0,true);
    EXPECT_LT(20*std::log10(rx3MicRms(signal)/inputRms),-20);
    tone.reset();std::fill(signal.begin(),signal.end(),0);
    tone.process(signal.data(),int(signal.size()),44100,12,12,false);
    for(auto sample:signal) EXPECT_FLOAT_EQ(0,sample);
}
TEST(Rx3MicrophoneTone, SmoothingIsIndependentOfCallbackSizeAndInvalidGainIsSafe) {
    auto whole=rx3MicSine(48000,4000,4800);auto split=whole;
    rx3::MicrophoneTone a,b;a.process(whole.data(),int(whole.size()),48000,-12,12,true);
    for(size_t offset=0;offset<split.size();offset+=128) b.process(split.data()+offset,int(std::min(size_t(128),split.size()-offset)),48000,-12,12,true);
    EXPECT_EQ(whole,split);
    a.process(whole.data(),int(whole.size()),48000,std::numeric_limits<double>::infinity(),std::numeric_limits<double>::quiet_NaN(),false);
    for(auto sample:whole) EXPECT_TRUE(std::isfinite(sample));
}

TEST(Rx3MySettings, MicrophoneLowCutRoundTripsWithoutChangingOtherMixerSettings) {
    const auto original=rx3SettingsFixture("DJMMYSETTING.DAT",{{17,0x80},{18,0x81},{19,0x83}});
    QString error;const auto updated=rx3::writeMySettings("DJMMYSETTING.DAT",original,{{"mic_low_cut",1},{"talkover_level",-18}},&error);
    ASSERT_TRUE(error.isEmpty())<<error.toStdString();ASSERT_FALSE(updated.isEmpty());
    const auto loaded=rx3::readMySettings("DJMMYSETTING.DAT",updated);
    ASSERT_TRUE(loaded.error.isEmpty());EXPECT_EQ(1,loaded.values.value("mic_low_cut"));
    EXPECT_EQ(-18,loaded.values.value("talkover_level"));
    for(int offset=0;offset<156;++offset) if(offset!=121 && offset!=123) EXPECT_EQ(original[offset],updated[offset])<<offset;
}

TEST_F(Rx3ReferenceScaleTest, AudioToolsUsesCommonEncoderAndBlocksUnconfiguredMicrophone) {
    ControlObject configured(ConfigKey("[Microphone1]","input_configured"));
    ControlPotmeter low(ConfigKey("[Microphone1]","rx3_eq_low"),-12,12);
    ControlPotmeter high(ConfigKey("[Microphone1]","rx3_eq_high"),-12,12);
    ControlPushButton cut(ConfigKey("[Microphone1]","rx3_low_cut"));
    PlayerInfo::create();
    {
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        auto* library=new WLibrary(nullptr);
        WRx3Browser browser(library,sidebar,nullptr,nullptr,config());
        browser.resize(1280,690);browser.show();QCoreApplication::processEvents();
        Rx3BrowserTestAccess::audioTools(browser);QCoreApplication::processEvents();
        auto* list=browser.findChild<QListWidget*>("RX3ToolsActions");ASSERT_TRUE(list);
        auto select=[&](const QString& prefix) {
            int row=-1;for(int index=0;index<list->count();++index) if(list->item(index)->text().startsWith(prefix)) {row=index;break;}
            ASSERT_GE(row,0)<<prefix.toStdString();
            Rx3BrowserTestAccess::moveTools(browser,row-list->currentRow());Rx3BrowserTestAccess::enterTools(browser);
        };
        select("MIC 1 LOW:");Rx3BrowserTestAccess::moveTools(browser,2);EXPECT_DOUBLE_EQ(0,low.get());
        configured.set(1);Rx3BrowserTestAccess::moveTools(browser,2);EXPECT_DOUBLE_EQ(1,low.get());
        Rx3BrowserTestAccess::backTools(browser); // Editing ends without leaving audio tools.
        select("MIC 1 LOW CUT");EXPECT_DOUBLE_EQ(1,cut.get());
        select("MIC 1 HIGH:");Rx3BrowserTestAccess::moveTools(browser,-3);EXPECT_DOUBLE_EQ(-1.5,high.get());
        Rx3BrowserTestAccess::enterTools(browser);QCoreApplication::processEvents();
        const auto renders=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
        if(!renders.isEmpty()) ASSERT_TRUE(browser.grab().save(QDir(renders).filePath("audio-tools-1280.png")));
        EXPECT_TRUE(list->isVisible());EXPECT_GT(list->height(),300);
    }
    PlayerInfo::destroy();
}

TEST_F(Rx3ReferenceScaleTest, WorkflowMenusKeepOwnedStringLabelsAcrossEncoderRefresh) {
    PlayerInfo::create();
    {
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        auto* library=new WLibrary(nullptr);
        WRx3Browser browser(library,sidebar,nullptr,nullptr,config());
        browser.resize(1280,690);browser.show();QCoreApplication::processEvents();
        Rx3BrowserTestAccess::filterTools(browser);QCoreApplication::processEvents();
        auto* list=browser.findChild<QListWidget*>("RX3ToolsActions");ASSERT_TRUE(list);
        EXPECT_EQ("KEY: OFF ",list->item(1)->text());
        Rx3BrowserTestAccess::moveTools(browser,1);Rx3BrowserTestAccess::enterTools(browser);
        Rx3BrowserTestAccess::moveTools(browser,1);EXPECT_EQ("KEY: COMPATIBLE ",list->item(1)->text());
        Rx3BrowserTestAccess::backTools(browser);
        Rx3BrowserTestAccess::playbackTools(browser);QCoreApplication::processEvents();
        bool found=false;for(int row=0;row<list->count();++row) if(list->item(row)->text().startsWith("PLAY MODE:")) {
            found=true;EXPECT_TRUE(list->item(row)->text().contains("SINGLE"));
            Rx3BrowserTestAccess::moveTools(browser,row-list->currentRow());Rx3BrowserTestAccess::enterTools(browser);
            EXPECT_TRUE(list->item(row)->text().contains("CONTINUE"));break;
        }
        EXPECT_TRUE(found);
    }
    PlayerInfo::destroy();
}


TEST_F(Rx3ReferenceScaleTest, ToolMenuEncoderReachesBackAfterLastActionAndPreservesTouch) {
    WRx3ToolMenu menu(nullptr);menu.resize(640,400);menu.show();
    int first=0,last=0,backs=0;
    menu.showMenu("TOOLS",{
        {[]{return QString("FIRST");},[&]{++first;},{},{}},
        {[]{return QString("LAST");},[&]{++last;},{},{}}
    },[&]{++backs;});
    auto* list=menu.findChild<QListWidget*>("RX3ToolsActions");ASSERT_TRUE(list);
    auto* back=menu.findChild<QPushButton*>("RX3ToolsBack");ASSERT_TRUE(back);
    menu.move(1);EXPECT_EQ(1,list->currentRow());
    menu.move(1);EXPECT_EQ(-1,list->currentRow());
    EXPECT_TRUE(back->property("encoderFocus").toBool());EXPECT_TRUE(list->selectedItems().isEmpty());
    menu.move(100);menu.enter();EXPECT_EQ(1,backs);EXPECT_EQ(0,last);
    menu.move(-1);EXPECT_EQ(1,list->currentRow());EXPECT_FALSE(back->property("encoderFocus").toBool());
    menu.enter();EXPECT_EQ(1,last);
    menu.move(1);QCoreApplication::processEvents();
    QTest::mouseClick(list->viewport(),Qt::LeftButton,Qt::NoModifier,list->visualItemRect(list->item(0)).center());
    EXPECT_EQ(1,first);EXPECT_FALSE(back->property("encoderFocus").toBool());
    back->click();EXPECT_EQ(2,backs);
}

TEST_F(Rx3ReferenceScaleTest, ToolMenuBackEndsEditingAndHandlesEmptyAndReplacedMenus) {
    WRx3ToolMenu menu(nullptr);int value=0,backs=0;bool held=false;
    const auto root=[&]{++backs;menu.showMenu("ROOT",{},[&]{++backs;});};
    menu.showMenu("EDIT",{{[]{return QString("VALUE");},{},[&](int delta){value+=delta;},[&](bool editing){held=editing;}}},root);
    auto* back=menu.findChild<QPushButton*>("RX3ToolsBack");ASSERT_TRUE(back);
    menu.enter();EXPECT_TRUE(held);menu.move(3);EXPECT_EQ(3,value);
    menu.goBack();EXPECT_FALSE(held);EXPECT_EQ(0,backs);
    EXPECT_FALSE(back->property("encoderFocus").toBool());
    menu.move(1);EXPECT_TRUE(back->property("encoderFocus").toBool());
    menu.enter();EXPECT_EQ(1,backs);EXPECT_TRUE(back->property("encoderFocus").toBool());
    menu.move(-100);menu.enter();EXPECT_EQ(2,backs);
}

TEST_F(Rx3ReferenceScaleTest, BeatFxToolsEncoderSelectsStoresAndReleasesPadOnExit) {
    struct FactoryScope {
        FactoryScope() {WaveformWidgetFactory::createInstance();}
        ~FactoryScope() {WaveformWidgetFactory::destroy();}
    } factoryScope;
    auto factory=std::make_shared<ChannelHandleFactory>();
    EffectsManager effects(config(),factory);
    for(const auto& group:QStringList{"[MasterOutput]","[Master]","[Channel1]","[Channel2]","[Microphone]","[Microphone2]","[Auxiliary1]"})
        effects.registerInputChannel(ChannelHandleAndGroup(factory->getOrCreateHandle(group),group));
    effects.registerOutputChannel(ChannelHandleAndGroup(factory->getOrCreateHandle("[MasterOutput]"),"[MasterOutput]"));
    effects.setup();
    PlayerInfo::create();
    {
        QWidget canvas;
        WRx3BeatFx fx(config(),&effects,&canvas);
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        auto* library=new WLibrary(nullptr);
        WRx3Browser browser(library,sidebar,nullptr,&canvas,config());
        canvas.resize(1280,800);browser.resize(1280,690);canvas.show();browser.show();QCoreApplication::processEvents();
        Rx3BrowserTestAccess::sources(browser);QCoreApplication::processEvents();
        auto* sources=browser.findChild<QTreeWidget*>();ASSERT_TRUE(sources);
        ASSERT_EQ(1,sources->topLevelItemCount());EXPECT_EQ("NO DEVICE",sources->topLevelItem(0)->text(0));
        EXPECT_TRUE(browser.findChild<QPushButton*>("RX3BrowserToolsButton"));
        WRx3Shortcut shortcut(config(),&effects,&canvas);
        const auto shortcutPulse=[](const QString& key,double value) {
            ControlObject::set(ConfigKey("[RX3Shortcut]",key),value);
            ControlObject::set(ConfigKey("[RX3Shortcut]",key),0);
        };
        shortcutPulse("open",1);shortcutPulse("move",1);shortcutPulse("enter",1);
        EXPECT_FALSE(shortcut.isVisible()); // The established gesture now opens UTILITY without USB or mouse.
        auto* table=browser.findChild<QTableWidget*>("RX3UtilitySettings");ASSERT_TRUE(table);
        int fxIndex=-1,index=0;
        for(int row=0;row<table->rowCount();++row) {
            if(table->columnSpan(row,0)==2) continue;
            if(table->item(row,0)->text()=="BEAT FX") fxIndex=index;
            ++index;
        }
        ASSERT_GE(fxIndex,0);Rx3BrowserTestAccess::moveTools(browser,fxIndex);Rx3BrowserTestAccess::enterTools(browser);
        auto* list=browser.findChild<QListWidget*>("RX3ToolsActions");ASSERT_TRUE(list);
        auto select=[&](const QString& prefix) {
            int row=-1;for(int i=0;i<list->count();++i) if(list->item(i)->text().startsWith(prefix)) {row=i;break;}
            ASSERT_GE(row,0)<<prefix.toStdString();
            Rx3BrowserTestAccess::moveTools(browser,row-list->currentRow());Rx3BrowserTestAccess::enterTools(browser);
        };
        const auto slot=effects.getEffectChain(WRx3BeatFx::unitGroup())->getEffectSlot(0);
        select("EFFECT:");Rx3BrowserTestAccess::moveTools(browser,1);
        ASSERT_TRUE(slot->isLoaded());EXPECT_DOUBLE_EQ(0,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"enabled")));
        Rx3BrowserTestAccess::backTools(browser);
        select("LEVEL / DEPTH:");Rx3BrowserTestAccess::moveTools(browser,2);EXPECT_NEAR(0.6,fx.amount(),1e-9);
        Rx3BrowserTestAccess::enterTools(browser);
        select("STORE SELECTED EFFECT IN BANK 1");EXPECT_EQ(slot->getManifest()->uniqueId(),fx.bankId(0));
        select("MANUAL BPM:");Rx3BrowserTestAccess::moveTools(browser,8);EXPECT_DOUBLE_EQ(128,fx.effectBpm());
        Rx3BrowserTestAccess::backTools(browser);
        select("CH SELECT:");Rx3BrowserTestAccess::moveTools(browser,-10);
        EXPECT_DOUBLE_EQ(1,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"group_[Master]_enable")));
        Rx3BrowserTestAccess::backTools(browser);
        select("X-PAD:");EXPECT_DOUBLE_EQ(1,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"enabled")));
        Rx3BrowserTestAccess::moveTools(browser,2);
        EXPECT_DOUBLE_EQ(1,rx3FxParameter(slot,"delay_time")->getValue());
        EXPECT_TRUE(list->currentItem()->text().contains("1 BEAT"));
        Rx3BrowserTestAccess::backTools(browser);EXPECT_DOUBLE_EQ(0,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"enabled")));
        select("X-PAD:");browser.hide();QCoreApplication::processEvents();
        EXPECT_DOUBLE_EQ(0,ControlObject::get(ConfigKey("[RX3BeatFx]","xpad_hold")));
        EXPECT_DOUBLE_EQ(0,ControlObject::get(ConfigKey(WRx3BeatFx::unitGroup(),"enabled")));
    }
    PlayerInfo::destroy();
}

TEST_F(Rx3ReferenceScaleTest, UtilityPreviewCommitCancelAndLiveValues) {
    WRx3Utility utility(nullptr);utility.resize(1280,650);utility.show();
    int value=0,applications=0,closed=0;
    utility.present({{"DECK","TEST SETTING",{"OFF","ON"},[&]{return value?QString("ON"):QString("OFF");},
        [&]{return value;},[&](int choice){value=choice;++applications;return true;},{}},
        {"GENERAL","PHYSICAL DISPLAY",{},[]{return QString("UNAVAILABLE");},{},{},"Hardware control unavailable."}},[&]{++closed;});
    auto* table=utility.findChild<QTableWidget*>("RX3UtilitySettings");ASSERT_TRUE(table);
    EXPECT_EQ("DECK",table->item(0,0)->text());EXPECT_EQ("GENERAL",table->item(2,0)->text());
    EXPECT_FALSE(table->item(0,0)->flags().testFlag(Qt::ItemIsSelectable));
    utility.enter();utility.move(1);EXPECT_EQ(0,value);EXPECT_EQ(0,applications);
    utility.back();EXPECT_EQ(0,value);EXPECT_EQ(0,closed);
    utility.enter();utility.move(100);utility.enter();EXPECT_EQ(1,value);EXPECT_EQ(1,applications);
    value=0;utility.refresh();EXPECT_EQ("OFF",table->item(1,1)->text());
    utility.move(1);utility.enter();EXPECT_EQ(1,applications);
    EXPECT_EQ("Hardware control unavailable.",utility.findChild<QLabel*>("RX3UtilityStatus")->text());
    utility.move(1);EXPECT_TRUE(utility.findChild<QPushButton*>("RX3UtilityBack")->property("encoderFocus").toBool());
    utility.enter();EXPECT_EQ(1,closed);
    utility.move(-2);utility.enter();utility.move(1);utility.hide();utility.show();utility.enter();
    EXPECT_EQ(0,value);EXPECT_EQ(1,applications); // Hide canceled the uncommitted value.
}

TEST_F(Rx3ReferenceScaleTest, UtilityTouchChoiceCommitsOnceAndFailedApplyKeepsActualValue) {
    WRx3Utility utility(nullptr);utility.resize(640,400);utility.show();
    int value=0,calls=0;
    utility.present({{"DECK","TOUCH VALUE",{"ONE","TWO"},[&]{return QString::number(value);},[&]{return value;},
            [&](int choice){++calls;if(choice==1) return false;value=choice;return true;},{} }},[]{});
    auto* table=utility.findChild<QTableWidget*>("RX3UtilitySettings");ASSERT_TRUE(table);
    QCoreApplication::processEvents();
    QTest::mouseClick(table->viewport(),Qt::LeftButton,Qt::NoModifier,table->visualItemRect(table->item(1,1)).center());
    auto* editor=utility.findChild<QComboBox*>();ASSERT_TRUE(editor);
    editor->setCurrentIndex(1);QMetaObject::invokeMethod(editor,"activated",Qt::DirectConnection,Q_ARG(int,1));
    EXPECT_EQ(1,calls);EXPECT_EQ(0,value);EXPECT_EQ("0",table->item(1,1)->text());
    EXPECT_TRUE(utility.findChild<QLabel*>("RX3UtilityStatus")->text().contains("No value applied"));
}

TEST_F(Rx3ReferenceScaleTest, UtilitySharesLiveShortcutControlsAndPersistsBothAutoCueLevels) {
    ControlObject head(ConfigKey("[Master]","headSplit"));
    ControlObject level1(ConfigKey("[Channel1]","rx3_auto_cue_level"));
    ControlObject level2(ConfigKey("[Channel2]","rx3_auto_cue_level"));
    QWidget canvas;WRx3Shortcut shortcut(config(),nullptr,&canvas);
    head.set(1);EXPECT_DOUBLE_EQ(1,shortcut.utilityValue("headphones"));
    ASSERT_TRUE(shortcut.setUtilityValue("headphones",0));EXPECT_DOUBLE_EQ(0,head.get());
    level1.set(-60);level2.set(-66);EXPECT_DOUBLE_EQ(-999,shortcut.utilityValue("auto_cue_level"));
    ASSERT_TRUE(shortcut.setUtilityValue("auto_cue_level",-78));
    EXPECT_DOUBLE_EQ(-78,level1.get());EXPECT_DOUBLE_EQ(-78,level2.get());
    EXPECT_DOUBLE_EQ(-78,config()->getValue<double>(ConfigKey("[RX3Settings]","rx3_auto_cue_level1")));
    EXPECT_DOUBLE_EQ(-78,config()->getValue<double>(ConfigKey("[RX3Settings]","rx3_auto_cue_level2")));
    EXPECT_FALSE(shortcut.setUtilityValue("auto_cue_level",-35));EXPECT_DOUBLE_EQ(-78,level1.get());
    config()->setValue(kConfigKeyLoadWhenDeckPlaying,LoadWhenDeckPlaying::AllowButStopDeck);
    EXPECT_DOUBLE_EQ(0,shortcut.utilityValue("load_lock"));
    ASSERT_TRUE(shortcut.setUtilityValue("load_lock",1));
    EXPECT_EQ(LoadWhenDeckPlaying::Reject,config()->getValue<LoadWhenDeckPlaying>(kConfigKeyLoadWhenDeckPlaying,LoadWhenDeckPlaying::AllowButStopDeck));
}

TEST_F(Rx3ReferenceScaleTest, MenuHoldOpensUtilityWithoutReleaseOpeningToolsAndReturnsSource) {
    PlayerInfo::create();
    {
        std::vector<std::unique_ptr<ControlObject>> controls;
        for(int deck=1;deck<=2;++deck) for(const auto& item:QList<QPair<QString,double>>{
                {"rx3_quantize_beats",1},{"rx3_hotcue_autoload",0},{"rx3_auto_cue_level",0},
                {"slip_flashing",1},{"channel_fader_curve",1}}) {
            controls.push_back(std::make_unique<ControlObject>(ConfigKey(QString("[Channel%1]").arg(deck),item.first)));
            controls.back()->set(item.second);
        }
        ControlObject head(ConfigKey("[Master]","headSplit"));
        QWidget canvas;canvas.resize(1280,800);canvas.show();
        WRx3Shortcut shortcut(config(),nullptr,&canvas);
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        WRx3Browser browser(new WLibrary(nullptr),sidebar,nullptr,&canvas,config());
        browser.resize(1280,690);browser.show();QCoreApplication::processEvents();
        QFile style(qEnvironmentVariable("NAUTIC_BROWSER_QA_STYLE"));
        if(style.open(QIODevice::ReadOnly)) browser.setStyleSheet(QString::fromUtf8(style.readAll()));
        auto* button=browser.findChild<QPushButton*>("RX3BrowserToolsButton");ASSERT_TRUE(button);
        auto* breadcrumb=browser.findChild<QPushButton*>("RX3BrowserBreadcrumb");ASSERT_TRUE(breadcrumb);
        EXPECT_EQ("SOURCE",breadcrumb->text());
        button->click();EXPECT_EQ("UTILITY",breadcrumb->text());
        auto* utility=browser.findChild<WRx3Utility*>("RX3Utility");ASSERT_TRUE(utility);EXPECT_TRUE(utility->isVisible());
        EXPECT_TRUE(button->property("active").toBool());
        EXPECT_FALSE(browser.findChild<QPushButton*>("RX3SourceButton")->property("active").toBool());
        Rx3BrowserTestAccess::backTools(browser);
        EXPECT_FALSE(utility->isVisible());EXPECT_EQ("SOURCE",breadcrumb->text());
        QTimer* hold=nullptr;for(auto* timer:browser.findChildren<QTimer*>()) if(timer->isSingleShot() && timer->interval()==2000) hold=timer;
        ASSERT_TRUE(hold);hold->setInterval(20);
        QTest::mousePress(button,Qt::LeftButton);QTest::qWait(30);EXPECT_TRUE(utility->isVisible());
        QTest::mouseRelease(button,Qt::LeftButton);EXPECT_TRUE(utility->isVisible());EXPECT_EQ("UTILITY",breadcrumb->text());
        auto* table=utility->findChild<QTableWidget*>("RX3UtilitySettings");ASSERT_TRUE(table);
        QStringList categories;for(int i=0;i<table->rowCount();++i) if(table->columnSpan(i,0)==2) categories.push_back(table->item(i,0)->text());
        EXPECT_EQ((QStringList{"SYSTEM","DECK","MIXER","EFFECTS","BROWSER","RECORDING","DISPLAY","GENERAL"}),categories);
        // MENU exposes setup directly, without the desktop menubar or a keyboard.
        int setupRow = 1;
        for (const auto* command : {"open_controllers", "open_audio", "open_preferences"}) {
            ControlObject setup(ConfigKey("[Cranium]", command));
            int opened = 0;
            QObject::connect(&setup, &ControlObject::valueChanged, &browser,
                    [&opened](double value) { if (value > 0) ++opened; });
            QTest::mouseClick(table->viewport(), Qt::LeftButton, Qt::NoModifier,
                    table->visualItemRect(table->item(setupRow++, 0)).center());
            EXPECT_EQ(1, opened);
            EXPECT_EQ(0, setup.get());
            EXPECT_TRUE(utility->isVisible());
        }
        utility->move(-3);
        const QMap<QString,QString> actionsByCategory{
                {"PLAYBACK OPTIONS","DECK"},{"DECK 1 MEMORY CUES / LOOPS","DECK"},
                {"DECK 2 MEMORY CUES / LOOPS","DECK"},{"SHORTCUT / MY SETTINGS","DECK"},
                {"MIXER / MIC / AUX / BOOTH","MIXER"},{"BEAT FX","EFFECTS"},
                {"TAG LIST / TAG TRACK","BROWSER"},{"PLAYLIST BANK","BROWSER"},
                {"TRACK FILTER","BROWSER"},{"RELATED KEY","BROWSER"},
                {"PREVIEW SELECTED TRACK","BROWSER"},{"USB RECORDING","RECORDING"}};
        QMap<QString,int> indices;QString category;int index=0;
        for(int row=0;row<table->rowCount();++row) {
            const QString name=table->item(row,0)->text();
            if(table->columnSpan(row,0)==2) {category=name;continue;}
            if(actionsByCategory.contains(name)) {
                EXPECT_EQ(actionsByCategory.value(name),category);
                EXPECT_EQ("OPEN ›",table->item(row,1)->text());indices[name]=index;
            }
            EXPECT_FALSE(name.contains("LCD"));EXPECT_NE("TOUCH DISPLAY CALIBRATION",name);
            EXPECT_NE("AUTO STANDBY",name);EXPECT_NE("SCREEN SAVER",name);
            EXPECT_NE("MIXER MODE",name);EXPECT_NE("MASTER ATTENUATOR",name);
            EXPECT_NE("MIC OUT TO BOOTH",name);EXPECT_NE("ON AIR DISPLAY",name);
            ++index;
        }
        EXPECT_EQ(actionsByCategory.size(),indices.size());
        auto* actions=browser.findChild<QListWidget*>("RX3ToolsActions");ASSERT_TRUE(actions);
        int selectedIndex=0;
        for(auto it=indices.cbegin();it!=indices.cend();++it) {
            if(it.key()=="SHORTCUT / MY SETTINGS") continue;
            Rx3BrowserTestAccess::moveTools(browser,it.value()-selectedIndex);selectedIndex=it.value();
            const int selectedRow=table->currentRow();
            Rx3BrowserTestAccess::enterTools(browser);
            EXPECT_TRUE(actions->isVisible());EXPECT_FALSE(utility->isVisible());
            EXPECT_EQ("UTILITY / "+it.key(),breadcrumb->text());
            Rx3BrowserTestAccess::backTools(browser);
            EXPECT_TRUE(utility->isVisible());EXPECT_EQ("UTILITY",breadcrumb->text());
            EXPECT_EQ(selectedRow,table->currentRow());
        }
        const auto renders=qEnvironmentVariable("NAUTIC_RX3_RENDER_DIR");
        if(!renders.isEmpty()) {
            Rx3BrowserTestAccess::moveTools(browser,-selectedIndex);selectedIndex=0;
            ASSERT_TRUE(browser.grab().save(QDir(renders).filePath("utility-deck-1280.png")));
            for(const auto& section:QStringList{"MIXER","BROWSER","DISPLAY","GENERAL"}) {
                for(int row=0;row<table->rowCount();++row) if(table->item(row,0)->text()==section)
                    table->scrollToItem(table->item(row,0),QAbstractItemView::PositionAtTop);
                QCoreApplication::processEvents();
                ASSERT_TRUE(browser.grab().save(QDir(renders).filePath("utility-"+section.toLower()+"-1280.png")));
            }
        }
        button->click();EXPECT_FALSE(utility->isVisible());EXPECT_EQ("SOURCE",breadcrumb->text());
        EXPECT_FALSE(shortcut.isVisible());EXPECT_TRUE(browser.findChild<QPushButton*>("RX3SourceButton")->property("active").toBool());
    }
    PlayerInfo::destroy();
}

TEST_F(Rx3ReferenceScaleTest, UtilityActionCanReplaceMenuAndRowsMatchBrowserColors) {
    WRx3Utility utility(nullptr);utility.resize(640,440);utility.show();
    int executions=0;
    WRx3Utility::Setting action{"BROWSER","OPEN ACTION",{},[]{return QString("OPEN ›");},{},{},{}};
    action.execute=[&]{++executions;utility.present({{"GENERAL","REPLACEMENT",{},[]{return QString("DONE");},{},{},{}}},[]{});};
    utility.present({action,{"BROWSER","SECOND",{},[]{return QString("VALUE");},{},{},{}},
            {"BROWSER","THIRD",{},[]{return QString("VALUE");},{},{},{}}},[]{});
    QCoreApplication::processEvents();
    auto* table=utility.findChild<QTableWidget*>("RX3UtilitySettings");ASSERT_TRUE(table);
    const auto image=table->viewport()->grab().toImage();
    const auto black=table->visualItemRect(table->item(2,0));
    const auto gray=table->visualItemRect(table->item(3,0));
    EXPECT_EQ(QColor("#000000"),image.pixelColor(150,black.center().y()));
    EXPECT_EQ(QColor("#262626"),image.pixelColor(150,gray.center().y()));
    EXPECT_EQ(QColor("#777777"),image.pixelColor(table->columnViewportPosition(1)-1,gray.center().y()));
    utility.enter();EXPECT_EQ(1,executions);EXPECT_EQ("REPLACEMENT",table->item(1,0)->text());
}

TEST_F(Rx3ReferenceScaleTest, UtilityWaveformDivisionsWithoutPhrasesFallsBackToTimeScale) {
    QImage expected(400,100,QImage::Format_ARGB32_Premultiplied),actual(400,100,QImage::Format_ARGB32_Premultiplied);
    expected.fill(Qt::black);actual.fill(Qt::black);
    {QPainter painter(&expected);rx3::drawOverviewDivisions(&painter,400,100,1,180,0);}
    {QPainter painter(&actual);rx3::drawOverviewDivisions(&painter,400,100,1,180,1);}
    EXPECT_EQ(expected,actual);
}

TEST_F(Rx3ReferenceScaleTest, UtilityWaveformControlsReadFactoryAndPersistRealChoices) {
    struct FactoryScope {
        FactoryScope() {WaveformWidgetFactory::createInstance();}
        ~FactoryScope() {WaveformWidgetFactory::destroy();}
    } factoryScope;
    auto* waveform=WaveformWidgetFactory::instance();waveform->setConfig(config());
    auto handles=std::make_shared<ChannelHandleFactory>();EffectsManager effects(config(),handles);
    QWidget canvas;WRx3Shortcut shortcut(config(),&effects,&canvas);
    ASSERT_TRUE(shortcut.setUtilityValue("waveform_current_position",0));
    EXPECT_DOUBLE_EQ(0.25,waveform->getPlayMarkerPosition());
    ASSERT_TRUE(shortcut.setUtilityValue("waveform_current_position",1));
    EXPECT_DOUBLE_EQ(0.5,waveform->getPlayMarkerPosition());
    EXPECT_DOUBLE_EQ(0.5,config()->getValue<double>(ConfigKey("[Waveform]","PlayMarkerPosition")));
    waveform->setPlayMarkerPosition(0.4);EXPECT_DOUBLE_EQ(-999,shortcut.utilityValue("waveform_current_position"));
    ASSERT_TRUE(shortcut.setUtilityValue("waveform_divisions",1));EXPECT_EQ(1,waveform->getOverviewDivisions());
    EXPECT_EQ(1,config()->getValue<int>(ConfigKey("[Waveform]","OverviewDivisions")));
    EXPECT_FALSE(shortcut.setUtilityValue("waveform_divisions",2));EXPECT_EQ(1,waveform->getOverviewDivisions());
}

TEST(Rx3Display, BrowseHotCueSummaryUsesExportedSlotsAndDoesNotInventMissingCues) {
    using mixxx::rekordbox::RuntimeCue;
    RuntimeCue cue;cue.kind=RuntimeCue::Kind::HotCue;cue.hotcueIndex=2;cue.startMs=61000;
    RuntimeCue first=cue;first.hotcueIndex=1;first.startMs=0;
    RuntimeCue loop=cue;loop.kind=RuntimeCue::Kind::HotLoop;loop.hotcueIndex=8;loop.startMs=120000;loop.endMs=124000;
    RuntimeCue memory=cue;memory.kind=RuntimeCue::Kind::MemoryCue;memory.hotcueIndex=-1;
    EXPECT_EQ(QString("HOT CUES   A 0:00    B 1:01    H 2:00 ↻"),rx3::exportedHotCueSummary({cue,loop,memory,first}));
    EXPECT_EQ(QString("HOT CUES   None in export"),rx3::exportedHotCueSummary({memory}));
    cue.hotcueIndex=9;EXPECT_EQ(QString("HOT CUES   None in export"),rx3::exportedHotCueSummary({cue}));
}

#include <QTouchEvent>
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
#include <QPointingDevice>
#endif
#include "waveform/widgets/waveformwidgetabstract.h"
struct CraniumWaveformTouchTestAccess {
    static void attach(WWaveformViewer& viewer, WaveformWidgetAbstract* waveform) {
        viewer.setWaveformWidget(waveform);
    }
};
namespace {
class CraniumTouchTestWaveform : public QWidget, public WaveformWidgetAbstract {
  public:
    explicit CraniumTouchTestWaveform(const QString& group, QWidget* parent)
            : QWidget(parent), WaveformWidgetAbstract(group) {m_widget=this;}
    WaveformWidgetType::Type getType() const override {return WaveformWidgetType::QtWaveform;}
    void castToQWidget() override {m_widget=this;}
};
class CraniumTouchControls {
  public:
    CraniumTouchControls() {
        WaveformWidgetFactory::createInstance();
        for(int deck=1;deck<=2;++deck) for(const auto* item:{"waveform_zoom","scratch_position_enable",
                "scratch_position","wheel","play","passthrough","rate","playposition","beats_translate_curpos"})
            values.push_back(std::make_unique<ControlObject>(ConfigKey(QString("[Channel%1]").arg(deck),item)));
        for(int deck=1;deck<=2;++deck) ControlObject::set(ConfigKey(QString("[Channel%1]").arg(deck),"waveform_zoom"),5);
    }
    ~CraniumTouchControls() {WaveformWidgetFactory::destroy();}
    std::vector<std::unique_ptr<ControlObject>> values;
};
void setupCraniumTouch(WWaveformViewer& viewer, UserSettingsPointer config) {
    QDomDocument node;
    ASSERT_TRUE(node.setContent(QString("<Visual><Rx3SharedWheelZoom>true</Rx3SharedWheelZoom><CraniumPinchZoom>true</CraniumPinchZoom></Visual>")));
    SkinContext context(config,QString());viewer.setup(node.documentElement(),context);
}
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
const QPointingDevice* craniumTouchDevice() {
    static QPointingDevice device("Cranium test touchscreen",99,QInputDevice::DeviceType::TouchScreen,
            QPointingDevice::PointerType::Finger,QInputDevice::Capability::Position,10,0);
    return &device;
}
QEventPoint touchPoint(int id, QEventPoint::State state, QPointF position) {
    return QEventPoint(id,state,position,position);
}
void sendCraniumTouch(QObject* target,QEvent::Type type,const QList<QEventPoint>& points) {
    QTouchEvent event(type,craniumTouchDevice(),Qt::NoModifier,points);
    QCoreApplication::sendEvent(target,&event);EXPECT_TRUE(event.isAccepted());
}
#endif
}
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
TEST_F(Rx3ReferenceScaleTest, CraniumPinchIsContinuousAndOrientationIndependent) {
    CraniumTouchControls controls;QWidget root;
    WWaveformViewer first("[Channel1]",config(),&root),second("[Channel2]",config(),&root);
    setupCraniumTouch(first,config());setupCraniumTouch(second,config());
    const auto press=QEventPoint::State::Pressed,move=QEventPoint::State::Updated,release=QEventPoint::State::Released;
    for(int deck=1;deck<=2;++deck) {
        const auto group=QString("[Channel%1]").arg(deck);
        ControlObject::set(ConfigKey(group,"play"),1);
        ControlObject::set(ConfigKey(group,"playposition"),0.4);
        ControlObject::set(ConfigKey(group,"rate"),0.02);
    }
    for(int angle=0;angle<360;angle+=45) {
        SCOPED_TRACE(angle);
        const auto direction=QPointF(std::cos(angle*3.141592653589793/180),std::sin(angle*3.141592653589793/180));
        const QPointF center(300,300);
        ControlObject::set(ConfigKey("[Channel1]","waveform_zoom"),5);
        ControlObject::set(ConfigKey("[Channel2]","waveform_zoom"),5);
        const auto frame=[&](QEvent::Type type,QEventPoint::State state,double span) {
            sendCraniumTouch(&first,type,{touchPoint(1,state,center-direction*span/2),touchPoint(2,state,center+direction*span/2)});
        };
        frame(QEvent::TouchBegin,press,100);
        frame(QEvent::TouchUpdate,move,135);QTest::qWait(40);QCoreApplication::processEvents();
        EXPECT_EQ(4,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
        frame(QEvent::TouchUpdate,move,190);QTest::qWait(40);QCoreApplication::processEvents();
        EXPECT_EQ(3,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
        // Reverse the same gesture without lifting: closer fingers zoom out.
        frame(QEvent::TouchUpdate,move,100);QTest::qWait(40);QCoreApplication::processEvents();
        EXPECT_EQ(5,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
        frame(QEvent::TouchUpdate,move,102);QTest::qWait(40);QCoreApplication::processEvents();
        EXPECT_EQ(5,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
        frame(QEvent::TouchEnd,release,102);QTest::qWait(40);QCoreApplication::processEvents();
    }
    for(int deck=1;deck<=2;++deck) {
        const auto group=QString("[Channel%1]").arg(deck);
        EXPECT_EQ(5,ControlObject::get(ConfigKey(group,"waveform_zoom")));
        EXPECT_EQ(1,ControlObject::get(ConfigKey(group,"play")));
        EXPECT_EQ(0.4,ControlObject::get(ConfigKey(group,"playposition")));
        EXPECT_EQ(0.02,ControlObject::get(ConfigKey(group,"rate")));
        for(const auto* item:{"scratch_position_enable","scratch_position","wheel","beats_translate_curpos"})
            EXPECT_EQ(0,ControlObject::get(ConfigKey(group,item)));
    }
}

TEST_F(Rx3ReferenceScaleTest, CraniumPinchUsesCoarseFarZoomAndHandlesQuickReleases) {
    CraniumTouchControls controls;WWaveformViewer viewer("[Channel1]",config());setupCraniumTouch(viewer,config());
    const auto press=QEventPoint::State::Pressed,move=QEventPoint::State::Updated,release=QEventPoint::State::Released;
    const auto frame=[&](QEvent::Type type,QEventPoint::State state,double span) {
        sendCraniumTouch(&viewer,type,{touchPoint(1,state,{100,100}),touchPoint(2,state,{100+span,100})});
    };
    ControlObject::set(ConfigKey("[Channel1]","waveform_zoom"),10);
    frame(QEvent::TouchBegin,press,100);
    frame(QEvent::TouchUpdate,move,120);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(8,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    frame(QEvent::TouchUpdate,move,160);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(6,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    frame(QEvent::TouchUpdate,move,250);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(4,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    frame(QEvent::TouchEnd,release,250);QTest::qWait(40);QCoreApplication::processEvents();
    ControlObject::set(ConfigKey("[Channel1]","waveform_zoom"),5);
    // Motion delivered only with release must not disappear.
    frame(QEvent::TouchBegin,press,100);frame(QEvent::TouchEnd,release,150);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(3,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    frame(QEvent::TouchBegin,press,100);frame(QEvent::TouchUpdate,move,5000);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(1,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    frame(QEvent::TouchEnd,release,5000);QTest::qWait(40);QCoreApplication::processEvents();
    frame(QEvent::TouchBegin,press,100);frame(QEvent::TouchUpdate,move,5);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(10,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    sendCraniumTouch(&viewer,QEvent::TouchCancel,{});
    frame(QEvent::TouchUpdate,move,400);QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(10,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
}

TEST_F(Rx3ReferenceScaleTest, CraniumCrossWindowPinchCoalescesFramesAndIgnoresStaleStationaryPoints) {
    CraniumTouchControls controls;QWidget root;
    WWaveformViewer first("[Channel1]",config(),&root),second("[Channel2]",config(),&root);
    setupCraniumTouch(first,config());setupCraniumTouch(second,config());
    const auto press=QEventPoint::State::Pressed,move=QEventPoint::State::Updated,still=QEventPoint::State::Stationary,release=QEventPoint::State::Released;
    sendCraniumTouch(&first,QEvent::TouchBegin,{touchPoint(1,press,{200,100})});
    sendCraniumTouch(&second,QEvent::TouchBegin,{touchPoint(2,press,{200,300})});
    // A split native-window frame represents rotation, not a pinch.
    sendCraniumTouch(&second,QEvent::TouchUpdate,{touchPoint(2,move,{300,200})});
    sendCraniumTouch(&first,QEvent::TouchUpdate,{touchPoint(1,move,{100,200})});QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(5,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    // Translation and stale Stationary snapshots must not invent scale changes.
    sendCraniumTouch(&first,QEvent::TouchUpdate,{touchPoint(1,move,{150,250}),touchPoint(2,still,{900,900})});
    sendCraniumTouch(&second,QEvent::TouchUpdate,{touchPoint(2,move,{350,250}),touchPoint(1,still,{-900,-900})});QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_EQ(5,ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")));
    sendCraniumTouch(&second,QEvent::TouchUpdate,{touchPoint(2,move,{320,250}),touchPoint(1,still,{-900,-900})});
    sendCraniumTouch(&first,QEvent::TouchUpdate,{touchPoint(1,move,{180,250}),touchPoint(2,still,{900,900})});QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_GT(ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")),5);
    sendCraniumTouch(&first,QEvent::TouchUpdate,{touchPoint(1,move,{100,250})});
    sendCraniumTouch(&second,QEvent::TouchUpdate,{touchPoint(2,move,{400,250})});QTest::qWait(40);QCoreApplication::processEvents();
    EXPECT_LT(ControlObject::get(ConfigKey("[Channel1]","waveform_zoom")),5);
    sendCraniumTouch(&first,QEvent::TouchEnd,{touchPoint(1,release,{100,250})});
    sendCraniumTouch(&second,QEvent::TouchEnd,{touchPoint(2,release,{400,250})});QTest::qWait(40);QCoreApplication::processEvents();
}

TEST_F(Rx3ReferenceScaleTest, CraniumWaveformScrubsOnlyWhilePausedAndCannotResumeAfterPinch) {
    CraniumTouchControls controls;
    WWaveformViewer viewer("[Channel1]",config());setupCraniumTouch(viewer,config());
    CraniumTouchTestWaveform waveform("[Channel1]",&viewer);
    CraniumWaveformTouchTestAccess::attach(viewer,&waveform);
    const auto press=QEventPoint::State::Pressed,move=QEventPoint::State::Updated,release=QEventPoint::State::Released;
    sendCraniumTouch(&viewer,QEvent::TouchBegin,{touchPoint(1,press,{50,50})});
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[Channel1]","scratch_position_enable")));
    sendCraniumTouch(&viewer,QEvent::TouchUpdate,{touchPoint(1,move,{75,50})});
    EXPECT_EQ(1,ControlObject::get(ConfigKey("[Channel1]","scratch_position_enable")));
    // Starting playback in the middle of a paused drag immediately releases it.
    ControlObject::set(ConfigKey("[Channel1]","play"),1);
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[Channel1]","scratch_position_enable")));
    const auto position=ControlObject::get(ConfigKey("[Channel1]","scratch_position"));
    sendCraniumTouch(&viewer,QEvent::TouchUpdate,{touchPoint(1,move,{150,50})});
    EXPECT_EQ(position,ControlObject::get(ConfigKey("[Channel1]","scratch_position")));
    sendCraniumTouch(&viewer,QEvent::TouchEnd,{touchPoint(1,release,{150,50})});
    // Even genuine/synthesized mouse drags cannot seek the central view while playing.
    QTest::mousePress(&viewer,Qt::LeftButton,Qt::NoModifier,{30,30});
    QTest::mouseMove(&viewer,{130,30});QTest::mouseRelease(&viewer,Qt::LeftButton);
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[Channel1]","scratch_position_enable")));
    EXPECT_EQ(position,ControlObject::get(ConfigKey("[Channel1]","scratch_position")));
    ControlObject::set(ConfigKey("[Channel1]","play"),0);
    sendCraniumTouch(&viewer,QEvent::TouchBegin,{touchPoint(2,press,{50,50}),touchPoint(3,press,{150,50})});
    sendCraniumTouch(&viewer,QEvent::TouchUpdate,{touchPoint(2,move,{50,50}),touchPoint(3,move,{190,50})});
    sendCraniumTouch(&viewer,QEvent::TouchUpdate,{touchPoint(2,move,{50,50}),touchPoint(3,release,{190,50})});
    sendCraniumTouch(&viewer,QEvent::TouchUpdate,{touchPoint(2,move,{250,50})});
    EXPECT_EQ(0,ControlObject::get(ConfigKey("[Channel1]","scratch_position_enable")));
    sendCraniumTouch(&viewer,QEvent::TouchCancel,{});
}
#endif

TEST_F(Rx3ReferenceScaleTest, CraniumSmallOverviewRemainsClickableWhilePlaying) {
    CraniumTouchControls controls;
    ControlObject samples(ConfigKey("[Channel1]","track_samples"),false,false,false,48000*2*120);
    ControlObject sampleRate(ConfigKey("[Channel1]","track_samplerate"),false,false,false,48000);
    ControlObject ratio(ConfigKey("[Channel1]","rate_ratio"),false,false,false,1);
    ControlObject remaining(ConfigKey("[Channel1]","time_remaining"),false,false,false,100);
    ControlObject lock(ConfigKey("[RX3Settings]","needle_lock"),false,false,false,0);
    QWidget root;
    WWaveformViewer central("[Channel1]",config(),&root);setupCraniumTouch(central,config());
    WOverview small("[Channel1]",nullptr,config(),&root);
    SkinContext context(config(),QString());QDomDocument node;
    ASSERT_TRUE(node.setContent(QString("<Overview><Rx3Overview>true</Rx3Overview></Overview>")));
    small.setup(node.documentElement(),context);small.resize(300,80);
    small.initWithTrack(Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo("/tmp/cranium-overview-test.wav"))));
    auto* connection=new ControlParameterWidgetConnection(&small,ConfigKey("[Channel1]","playposition"),nullptr,
            ControlParameterWidgetConnection::DIR_FROM_AND_TO_WIDGET,
            ControlParameterWidgetConnection::EMIT_ON_PRESS_AND_RELEASE);
    small.addConnection(connection);small.setDisplayConnection(connection);
    ControlObject::set(ConfigKey("[Channel1]","play"),1);
    ControlObject::set(ConfigKey("[Channel1]","playposition"),0.2);
    QTest::mouseClick(&small,Qt::LeftButton,Qt::NoModifier,{225,40});
    EXPECT_GT(ControlObject::get(ConfigKey("[Channel1]","playposition")),0.7);
    EXPECT_EQ(1,ControlObject::get(ConfigKey("[Channel1]","play")));
}


#include "widget/wcraniumsettings.h"
#include "soundio/craniumaudio.h"

TEST_F(Rx3ReferenceScaleTest, CraniumEmbeddedSetupPreservesWindowAndBlocksLiveAudioChanges) {
    QWidget host;host.resize(800,480);host.show();
    bool busy=false,developer=false;int applied=0,closed=0,modeChanges=0;QString masterId,headId;int masterBase=-1,headBase=-1;
    QVariantList devices{QVariantMap{{"id","flx4"},{"name","DDJ-FLX4"},{"channels",4}}};
    QVariantList controllers;
    CraniumSettings::Services services;
    services.controllers=[&]{return controllers;};services.usbStatus=[]{return QString("USB: no FLX4 visible");};
    services.audioDevices=[&](bool){return devices;};
    services.audioRouting=[]{return QVariantMap{{"main","flx4"},{"mainBase",0},{"headphones","flx4"},{"headphonesBase",2}};};
    services.playing=[&]{return busy;};services.developer=[&]{return developer;};
    services.setDeveloper=[&](bool value){developer=value;++modeChanges;return QString();};
    services.applyAudio=[&](QString main,int mainPair,QString head,int headPair){++applied;masterId=main;headId=head;masterBase=mainPair;headBase=headPair;return QString();};
    services.close=[&]{++closed;};
    CraniumSettings settings(std::move(services),&host);settings.resize(host.size());settings.show();settings.openPage(0);
    auto* select=settings.findChild<QComboBox*>("CraniumControllerSelect");ASSERT_TRUE(select);EXPECT_TRUE(select->currentText().contains("No MIDI"));
    controllers<<QVariantMap{{"name","DDJ-FLX4"},{"enabled",true},{"output",true},{"mapping","Cranium FLX4 mapping"}};
    settings.openPage(0);EXPECT_EQ("DDJ-FLX4",select->currentText());EXPECT_TRUE(settings.findChild<QPushButton*>("CraniumControllerEnable")->isEnabled());
    settings.openPage(1);auto* apply=settings.findChild<QPushButton*>("CraniumAudioApply");ASSERT_TRUE(apply);
    QTest::mouseClick(apply,Qt::LeftButton);QTest::qWait(90);QCoreApplication::processEvents();EXPECT_EQ(1,applied);EXPECT_EQ("flx4",masterId);EXPECT_EQ("flx4",headId);EXPECT_EQ(0,masterBase);EXPECT_EQ(2,headBase);
    busy=true;settings.openPage(1);EXPECT_FALSE(apply->isEnabled());QTest::mouseClick(apply,Qt::LeftButton);EXPECT_EQ(1,applied);
    settings.openPage(2);auto* tools=settings.findChild<QPushButton*>("CraniumDeveloperTools");tools->click();
    auto* hold=settings.findChild<QPushButton*>("CraniumDeveloperHold");ASSERT_TRUE(hold);
    QTest::mouseClick(hold,Qt::LeftButton);EXPECT_FALSE(developer);EXPECT_EQ(0,modeChanges);
    for(auto* timer:settings.findChildren<QTimer*>())if(timer->isSingleShot()&&timer->interval()==2000)timer->setInterval(20);
    QTest::mousePress(hold,Qt::LeftButton);QTest::qWait(50);QTest::mouseRelease(hold,Qt::LeftButton);EXPECT_TRUE(developer);EXPECT_EQ(1,modeChanges);
    settings.findChild<QPushButton*>("CraniumReturnToKiosk")->click();EXPECT_FALSE(developer);EXPECT_EQ(2,modeChanges);
    settings.findChild<QPushButton*>("CraniumSettingsBack")->click();EXPECT_EQ(1,closed);
    EXPECT_EQ(&host,settings.window());EXPECT_EQ(QSize(800,480),host.size());
    const auto renders=qEnvironmentVariable("CRANIUM_SETTINGS_RENDERS");
    if(!renders.isEmpty())for(const auto size:{QSize(800,480),QSize(1280,800)}){
        host.resize(size);settings.resize(size);settings.openPage(0);QCoreApplication::processEvents();
        ASSERT_TRUE(settings.grab().save(QDir(renders).filePath(QString("cranium-controller-%1x%2.png").arg(size.width()).arg(size.height()))));
        settings.openPage(1);QCoreApplication::processEvents();ASSERT_TRUE(settings.grab().save(QDir(renders).filePath(QString("cranium-audio-%1x%2.png").arg(size.width()).arg(size.height()))));
    }
}

TEST_F(Rx3ReferenceScaleTest, CraniumAudioRoutesRejectClashesAndRetainAdvancedInputsAndOutputs) {
    SoundDeviceId flx;flx.name="DDJ-FLX4";flx.portAudioIndex=3;
    SoundDeviceId otherInterface;otherInterface.name="Other interface";otherInterface.portAudioIndex=4;
    SoundManagerConfig previous(nullptr);previous.setAPI("ALSA");previous.clearOutputs();previous.clearInputs();
    previous.addInput(otherInterface,AudioInput(AudioPath::AudioPathType::Microphone,0,mixxx::audio::ChannelCount::mono()));
    previous.addOutput(otherInterface,AudioOutput(AudioPath::AudioPathType::Booth,0,mixxx::audio::ChannelCount::stereo()));
    const CraniumAudioEndpoint device{flx,"ALSA",4};auto next=previous;
    EXPECT_TRUE(craniumAudioRouting(previous,device,0,device,2,&next).isEmpty());
    EXPECT_EQ(previous.getInputs(),next.getInputs());EXPECT_EQ(3,next.getOutputs().size());
    EXPECT_FALSE(craniumAudioRouting(previous,device,0,device,0,&next).isEmpty());
    EXPECT_FALSE(craniumAudioRouting(previous,device,0,device,4,&next).isEmpty());
    EXPECT_FALSE(craniumAudioRouting(previous,device,-1,std::nullopt,0,&next).isEmpty());
    auto other=device;other.api="OTHER API";
    EXPECT_FALSE(craniumAudioRouting(previous,device,0,other,2,&next).isEmpty());
    EXPECT_FALSE(craniumAudioRouting(previous,other,0,std::nullopt,0,&next).isEmpty());
    previous.addOutput(flx,AudioOutput(AudioPath::AudioPathType::Booth,2,mixxx::audio::ChannelCount::stereo()));
    EXPECT_FALSE(craniumAudioRouting(previous,device,0,device,2,&next).isEmpty());
}


TEST_F(Rx3ReferenceScaleTest, TrackResultsReplaceMenuInsteadOfLeavingAKeyboardOverUtility) {
    PlayerInfo::create();
    {
        SidebarModel model;auto* sidebar=new WLibrarySidebar;sidebar->setModel(&model);
        WRx3Browser browser(new WLibrary(nullptr),sidebar,nullptr,nullptr,config());browser.resize(800,480);browser.show();
        auto* menu=browser.findChild<QPushButton*>("RX3BrowserToolsButton");ASSERT_TRUE(menu);menu->click();
        auto* utility=browser.findChild<WRx3Utility*>("RX3Utility");ASSERT_TRUE(utility);ASSERT_TRUE(utility->isVisible());
        Rx3BrowserTestAccess::showTrackResults(browser);
        EXPECT_EQ(0,Rx3BrowserTestAccess::browserPage(browser));EXPECT_FALSE(utility->isVisible());
    }
    PlayerInfo::destroy();
}

TEST_F(Rx3ReferenceScaleTest, ConnectionCheckFinishesAndAudioRefreshStaysResponsive) {
    QWidget host;host.resize(800,480);host.show();QVariantList controllers;bool playing=false;int toggles=0;
    CraniumSettings::Services services;
    services.controllers=[&]{return controllers;};services.usbStatus=[]{return QString("No USB controller detected.");};
    services.playing=[&]{return playing;};services.audioDevices=[](bool){return QVariantList();};
    services.refreshAudio=[&host](auto complete){QTimer::singleShot(160,&host,[complete]{complete({QVariantMap{{"id","output"},{"name","USB audio"},{"channels",4}}},{});});};
    services.deckState=[&](int){return QVariantMap{{"loaded",true},{"playing",playing}};};
    services.toggleDeck=[&](int){playing=!playing;++toggles;return QString();};
    CraniumSettings settings(std::move(services),&host);settings.resize(host.size());settings.show();settings.openPage(0);
    auto* notice=settings.findChild<QLabel*>("CraniumSettingsNotice");ASSERT_TRUE(notice);
    for(auto* timer:settings.findChildren<QTimer*>())if(timer->isSingleShot()&&timer->interval()==3000)timer->setInterval(30);
    settings.findChild<QPushButton*>("CraniumControllerRefresh")->click();EXPECT_TRUE(notice->text().contains("Checking"));
    QTest::qWait(70);QCoreApplication::processEvents();EXPECT_TRUE(notice->text().contains("No controller detected"));
    for(auto* label:settings.findChildren<QLabel*>())EXPECT_FALSE(label->text().contains("the Pi"));
    settings.openPage(1);int ticks=0;QTimer heartbeat;QObject::connect(&heartbeat,&QTimer::timeout,&host,[&]{++ticks;});heartbeat.start(10);
    auto* refresh=settings.findChild<QPushButton*>("CraniumAudioRefresh");refresh->click();
    EXPECT_TRUE(notice->text().contains("Refreshing"));EXPECT_FALSE(refresh->isEnabled());
    EXPECT_TRUE(settings.findChild<QProgressBar*>("CraniumSettingsProgress")->isVisible());
    settings.findChild<QPushButton*>("CraniumSettingsTab2")->click();EXPECT_TRUE(settings.findChild<QPushButton*>("CraniumDeveloperTools")->isVisible());
    QTest::qWait(220);QCoreApplication::processEvents();EXPECT_GT(ticks,5);EXPECT_FALSE(notice->text().contains("Refreshing"));
    EXPECT_FALSE(settings.findChild<QProgressBar*>("CraniumSettingsProgress")->isVisible());
    settings.openPage(1);auto* play=settings.findChild<QPushButton*>("CraniumDeck1Play");ASSERT_TRUE(play);ASSERT_TRUE(play->isEnabled());
    play->click();EXPECT_TRUE(playing);EXPECT_EQ(1,toggles);EXPECT_TRUE(play->text().contains("PAUSE"));EXPECT_FALSE(refresh->isEnabled());
    play->click();EXPECT_FALSE(playing);EXPECT_EQ(2,toggles);EXPECT_TRUE(refresh->isEnabled());
}


#include <QScopeGuard>
TEST_F(Rx3ReferenceScaleTest, CentralWaveformBackingIsBlackBeforeAnyNativeRendererFrame) {
    const auto previous=qgetenv("CRANIUM_APPLIANCE");qputenv("CRANIUM_APPLIANCE","1");
    const auto restore=qScopeGuard([previous]{if(previous.isNull())qunsetenv("CRANIUM_APPLIANCE");else qputenv("CRANIUM_APPLIANCE",previous);});
    CraniumTouchControls controls;WWaveformViewer viewer("[Channel1]",config());setupCraniumTouch(viewer,config());
    viewer.resize(180,80);viewer.show();QCoreApplication::processEvents();
    const auto image=viewer.grab().toImage();
    for(const auto point:{QPoint(0,0),QPoint(90,40),QPoint(179,79)})EXPECT_EQ(QColor(Qt::black),image.pixelColor(point));
}
