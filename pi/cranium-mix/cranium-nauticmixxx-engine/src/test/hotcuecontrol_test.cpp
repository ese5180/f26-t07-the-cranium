#include "engine/controls/cuecontrol.h"
#include "test/signalpathtest.h"

namespace {
mixxx::audio::FrameDiff_t getBeatLengthFrames(TrackPointer pTrack) {
    return (60.0 / pTrack->getBpm()) * pTrack->getSampleRate();
}

} // anonymous namespace

class HotcueControlTest : public BaseSignalPathTest {
  protected:
    void SetUp() override {
        BaseSignalPathTest::SetUp();

        m_pPlay = std::make_unique<ControlProxy>(m_sGroup1, "play");
        m_pBeatloopActivate = std::make_unique<ControlProxy>(m_sGroup1, "beatloop_activate");
        m_pBeatloopSize = std::make_unique<ControlProxy>(m_sGroup1, "beatloop_size");
        m_pLoopStartPosition = std::make_unique<ControlProxy>(m_sGroup1, "loop_start_position");
        m_pLoopEndPosition = std::make_unique<ControlProxy>(m_sGroup1, "loop_end_position");
        m_pLoopEnabled = std::make_unique<ControlProxy>(m_sGroup1, "loop_enabled");
        m_pLoopDouble = std::make_unique<ControlProxy>(m_sGroup1, "loop_double");
        m_pLoopHalve = std::make_unique<ControlProxy>(m_sGroup1, "loop_halve");
        m_pLoopMove = std::make_unique<ControlProxy>(m_sGroup1, "loop_move");
        m_pHotcue1Activate = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_activate");
        m_pHotcue1ActivateCue = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_activatecue");
        m_pHotcue1ActivateLoop = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_activateloop");
        m_pHotcue1Set = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_set");
        m_pHotcue1SetCue = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_setcue");
        m_pHotcue1SetLoop = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_setloop");
        m_pHotcue1Goto = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_goto");
        m_pHotcue1GotoAndPlay = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_gotoandplay");
        m_pHotcue1GotoAndLoop = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_gotoandloop");
        m_pHotcue1CueLoop = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_cueloop");
        m_pHotcue1Position = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_position");
        m_pHotcue1EndPosition = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_endposition");
        m_pHotcue1Status = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_status");
        m_pHotcue1Clear = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_1_clear");
        m_pHotcue2Activate = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_2_activate");
        m_pHotcue2Status = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_2_status");
        m_pHotcue2Position = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_2_position");
        m_pHotcue2EndPosition = std::make_unique<ControlProxy>(m_sGroup1, "hotcue_2_endposition");
        m_pQuantizeEnabled = std::make_unique<ControlProxy>(m_sGroup1, "quantize");
    }

    CueControl* cueControl() { return m_pChannel1->getEngineBuffer()->m_pCueControl; }
    Rx3ReleaseFx* releaseFx() { return m_pChannel1->getEngineBuffer()->m_pRx3ReleaseFx.get(); }

    TrackPointer createTestTrack() const {
        const QString kTrackLocationTest = getTestDir().filePath(QStringLiteral("sine-30.wav"));
        const auto pTrack = Track::newTemporary(
                mixxx::FileAccess(mixxx::FileInfo(kTrackLocationTest)));
        pTrack->setAudioProperties(
                mixxx::audio::ChannelCount(2),
                mixxx::audio::SampleRate(44100),
                mixxx::audio::Bitrate(),
                mixxx::Duration::fromSeconds(180));
        return pTrack;
    }

    void loadTrack(TrackPointer pTrack) {
        BaseSignalPathTest::loadTrack(m_pMixerDeck1, pTrack);
        ProcessBuffer();
    }

    TrackPointer loadTestTrackWithBpm(double bpm) {
        DEBUG_ASSERT(!m_pPlay->toBool());
        // Setup fake track with 120 bpm can calculate loop size
        TrackPointer pTrack = createTestTrack();
        pTrack->trySetBpm(bpm);

        loadTrack(pTrack);
        ProcessBuffer();

        return pTrack;
    }

    TrackPointer createAndLoadFakeTrack() {
        TrackPointer pTrack = m_pMixerDeck1->loadFakeTrack(false, 0.0);
        ProcessBuffer();
        return pTrack;
    }

    void unloadTrack() {
        m_pMixerDeck1->slotLoadTrack(TrackPointer(), false);
    }

    mixxx::audio::FramePos currentFramePosition() {
        return m_pChannel1->getEngineBuffer()->m_pCueControl->frameInfo().currentPosition;
    }

    void setCurrentFramePosition(mixxx::audio::FramePos position) {
        m_pChannel1->getEngineBuffer()->queueNewPlaypos(position, EngineBuffer::SEEK_STANDARD);
        ProcessBuffer();
    }

    void prepareLoopAndHotcue(mixxx::audio::FramePos start,
            mixxx::audio::FramePos end,
            mixxx::audio::FramePos cue) {
        m_pQuantizeEnabled->set(0);
        setCurrentFramePosition(cue);
        m_pHotcue1SetCue->set(1);
        m_pHotcue1SetCue->set(0);
        setCurrentFramePosition(start);
        m_pLoopStartPosition->set(start.toEngineSamplePos());
        m_pLoopEndPosition->set(end.toEngineSamplePos());
        m_pLoopEnabled->set(1);
        ProcessBuffer();
        ASSERT_TRUE(m_pLoopEnabled->toBool());
    }

    std::unique_ptr<ControlProxy> m_pPlay;
    std::unique_ptr<ControlProxy> m_pBeatloopActivate;
    std::unique_ptr<ControlProxy> m_pBeatloopSize;
    std::unique_ptr<ControlProxy> m_pLoopStartPosition;
    std::unique_ptr<ControlProxy> m_pLoopEndPosition;
    std::unique_ptr<ControlProxy> m_pLoopEnabled;
    std::unique_ptr<ControlProxy> m_pLoopDouble;
    std::unique_ptr<ControlProxy> m_pLoopHalve;
    std::unique_ptr<ControlProxy> m_pLoopMove;
    std::unique_ptr<ControlProxy> m_pHotcue1Activate;
    std::unique_ptr<ControlProxy> m_pHotcue1ActivateCue;
    std::unique_ptr<ControlProxy> m_pHotcue1ActivateLoop;
    std::unique_ptr<ControlProxy> m_pHotcue1Set;
    std::unique_ptr<ControlProxy> m_pHotcue1SetCue;
    std::unique_ptr<ControlProxy> m_pHotcue1SetLoop;
    std::unique_ptr<ControlProxy> m_pHotcue1Goto;
    std::unique_ptr<ControlProxy> m_pHotcue1GotoAndPlay;
    std::unique_ptr<ControlProxy> m_pHotcue1GotoAndLoop;
    std::unique_ptr<ControlProxy> m_pHotcue1CueLoop;
    std::unique_ptr<ControlProxy> m_pHotcue1Position;
    std::unique_ptr<ControlProxy> m_pHotcue1EndPosition;
    std::unique_ptr<ControlProxy> m_pHotcue1Status;
    std::unique_ptr<ControlProxy> m_pHotcue1Clear;
    std::unique_ptr<ControlProxy> m_pHotcue2Activate;
    std::unique_ptr<ControlProxy> m_pHotcue2Status;
    std::unique_ptr<ControlProxy> m_pHotcue2Position;
    std::unique_ptr<ControlProxy> m_pHotcue2EndPosition;
    std::unique_ptr<ControlProxy> m_pQuantizeEnabled;
};

TEST_F(HotcueControlTest, DefautltControlValues) {
    TrackPointer pTrack = createTestTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    loadTrack(pTrack);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, NoTrackLoaded) {
    TrackPointer pTrack = createTestTrack();

    m_pHotcue1Set->set(1);
    m_pHotcue1Set->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1SetCue->set(1);
    m_pHotcue1SetCue->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1ActivateCue->set(1);
    m_pHotcue1ActivateCue->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1ActivateLoop->set(1);
    m_pHotcue1ActivateLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, SetCueAuto) {
    createAndLoadFakeTrack();

    constexpr mixxx::audio::FramePos cuePosition(100);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pQuantizeEnabled->set(0);
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();

    m_pHotcue1Set->set(1);
    m_pHotcue1Set->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, SetCueManual) {
    createAndLoadFakeTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    constexpr mixxx::audio::FramePos hotcuePosition(100);

    m_pQuantizeEnabled->set(0);
    setCurrentFramePosition(hotcuePosition);

    m_pHotcue1SetCue->set(1);
    m_pHotcue1SetCue->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(hotcuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, SetLoopAutoNoRedundantLoopCue) {
    createAndLoadFakeTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    constexpr mixxx::audio::FramePos loopStartPosition(100);
    constexpr mixxx::audio::FramePos loopEndPosition(200);
    m_pChannel1->getEngineBuffer()->setLoop(loopStartPosition, loopEndPosition, true);

    m_pHotcue1Set->set(1);
    m_pHotcue1Set->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);

    // Setting another hotcue inside the loop should create a regular hotcue
    // at the current position, not a redundant loop cue.
    setCurrentFramePosition(mixxx::audio::FramePos(195));
    ProcessBuffer();

    m_pHotcue2Activate->set(1);
    m_pHotcue2Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue2Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(currentFramePosition(), m_pHotcue2Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue2EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, SetLoopManualWithLoop) {
    createAndLoadFakeTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    constexpr mixxx::audio::FramePos loopStartPosition(100);
    constexpr mixxx::audio::FramePos loopEndPosition(200);
    m_pChannel1->getEngineBuffer()->setLoop(loopStartPosition, loopEndPosition, true);

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);
}

TEST_F(HotcueControlTest, SetLoopManualWithoutLoop) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    m_pBeatloopSize->set(4);
    EXPECT_EQ(4, m_pBeatloopSize->get());
    const double beatloopLengthFrames = m_pBeatloopSize->get() * getBeatLengthFrames(pTrack);

    const auto loopStartPosition = mixxx::audio::FramePos(8 * beatLengthFrames);
    setCurrentFramePosition(loopStartPosition);
    ProcessBuffer();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ(loopStartPosition, currentFramePosition());
    EXPECT_FRAMEPOS_EQ_CONTROL(currentFramePosition(), m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(currentFramePosition() + beatloopLengthFrames,
            m_pHotcue1EndPosition);
}

TEST_F(HotcueControlTest, SetLoopManualWithoutLoopOrBeats) {
    createAndLoadFakeTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, CueGoto) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    const auto cuePosition = mixxx::audio::FramePos(8 * getBeatLengthFrames(pTrack));

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    m_pHotcue1SetCue->set(1);
    m_pHotcue1SetCue->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to start of track
    setCurrentFramePosition(mixxx::audio::kStartFramePos);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(mixxx::audio::kStartFramePos, currentFramePosition());

    m_pHotcue1Goto->set(1);
    m_pHotcue1Goto->set(0);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
}

TEST_F(HotcueControlTest, CueGotoAndPlay) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    const auto cuePosition = mixxx::audio::FramePos(8 * getBeatLengthFrames(pTrack));

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    m_pHotcue1SetCue->set(1);
    m_pHotcue1SetCue->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to start of track
    setCurrentFramePosition(mixxx::audio::kStartFramePos);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(mixxx::audio::kStartFramePos, currentFramePosition());

    m_pHotcue1GotoAndPlay->set(1);
    m_pHotcue1GotoAndPlay->set(0);
    ProcessBuffer();
    EXPECT_LE(cuePosition, currentFramePosition());

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
}

TEST_F(HotcueControlTest, CueGotoAndLoop) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const auto cuePosition = mixxx::audio::FramePos(8 * beatLengthFrames);
    m_pBeatloopSize->set(4);
    const double beatloopLengthFrames = m_pBeatloopSize->get() * getBeatLengthFrames(pTrack);

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    m_pHotcue1SetCue->set(1);
    m_pHotcue1SetCue->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to start of track
    setCurrentFramePosition(mixxx::audio::kStartFramePos);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(mixxx::audio::kStartFramePos, currentFramePosition());

    m_pHotcue1GotoAndLoop->set(1);
    m_pHotcue1GotoAndLoop->set(0);
    ProcessBuffer();
    EXPECT_LE(cuePosition, currentFramePosition());

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + beatloopLengthFrames, m_pLoopEndPosition);
}

TEST_F(HotcueControlTest, SavedLoopGoto) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;
    const auto cuePosition = mixxx::audio::FramePos(8 * beatLengthFrames);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    // Set a beatloop this position
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());

    // Save loop to hotcue slot 1
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());

    // Seek to start of track
    setCurrentFramePosition(mixxx::audio::kStartFramePos);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(mixxx::audio::kStartFramePos, currentFramePosition());

    m_pHotcue1Goto->set(1);
    m_pHotcue1Goto->set(0);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
}

TEST_F(HotcueControlTest, SavedLoopGotoAndPlay) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;
    const auto cuePosition = mixxx::audio::FramePos(8 * beatLengthFrames);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    // Set a beatloop this position
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());

    // Save loop to hotcue slot 1
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());

    // Seek to start of track
    setCurrentFramePosition(mixxx::audio::kStartFramePos);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(mixxx::audio::kStartFramePos, currentFramePosition());

    m_pHotcue1GotoAndPlay->set(1);
    m_pHotcue1GotoAndPlay->set(0);
    ProcessBuffer();
    EXPECT_LE(cuePosition, currentFramePosition());

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
}

TEST_F(HotcueControlTest, SavedLoopGotoAndLoop) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;
    const auto cuePosition = mixxx::audio::FramePos(8 * beatLengthFrames);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    // Set a beatloop this position
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());

    // Save loop to hotcue slot 1
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());

    // Seek to start of track
    setCurrentFramePosition(mixxx::audio::kStartFramePos);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(mixxx::audio::kStartFramePos, currentFramePosition());

    m_pHotcue1GotoAndLoop->set(1);
    m_pHotcue1GotoAndLoop->set(0);
    ProcessBuffer();
    EXPECT_LE(cuePosition, currentFramePosition());

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pLoopEndPosition);
}

TEST_F(HotcueControlTest, SavedLoopStatus) {
    createAndLoadFakeTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    constexpr auto loopStartPositon = mixxx::audio::FramePos(100);
    constexpr auto loopEndPosition = mixxx::audio::FramePos(200);

    m_pChannel1->getEngineBuffer()->setLoop(loopStartPositon, loopEndPosition, true);

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPositon, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);

    // Disable Loop
    m_pLoopEnabled->set(0);

    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPositon, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);

    // Re-Enable Loop
    m_pLoopEnabled->set(1);

    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPositon, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);

    m_pHotcue1Clear->set(1);
    m_pHotcue1Clear->set(0);

    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, SavedLoopScale) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop (4 beats)
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pPlay->set(1);
    ProcessBuffer();

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Double loop size (4 => 8 beats)
    m_pLoopDouble->set(1);
    m_pLoopDouble->set(0);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(
            mixxx::audio::kStartFramePos + 2 * loopLengthFrames,
            m_pHotcue1EndPosition);

    // Halve loop size (8 => 4 beats)
    m_pLoopHalve->set(1);
    m_pLoopHalve->set(0);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Halve loop size (4 => 2 beats)
    m_pLoopHalve->set(1);
    m_pLoopHalve->set(0);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(
            mixxx::audio::kStartFramePos + loopLengthFrames / 2,
            m_pHotcue1EndPosition);

    m_pPlay->set(0);
}

TEST_F(HotcueControlTest, SavedLoopMove) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    constexpr double loopSize = 4;
    m_pBeatloopSize->set(loopSize);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = loopSize * beatLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop at position 0
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pPlay->set(1);

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Move loop right (0 => 4 beats)
    m_pLoopMove->set(loopSize);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(
            mixxx::audio::kStartFramePos + 2 * loopLengthFrames,
            m_pHotcue1EndPosition);

    // Move loop left (4 => 0 beats)
    m_pLoopMove->set(-loopSize);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Move loop left (0 => -4 beats)
    m_pLoopMove->set(-loopSize);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos - loopLengthFrames, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1EndPosition);

    m_pPlay->set(0);
}

TEST_F(HotcueControlTest, SavedLoopNoScaleIfDisabled) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop (4 beats)
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pPlay->set(1);
    ProcessBuffer();

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());

    // Double loop size (4 => 8 beats) while saved loop is disabled
    m_pLoopDouble->set(1);
    m_pLoopDouble->set(0);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Halve loop size (8 => 4 beats) while saved loop is disabled
    m_pLoopHalve->set(1);
    m_pLoopHalve->set(0);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Halve loop size (4 => 2 beats) while saved loop is disabled
    m_pLoopHalve->set(1);
    m_pLoopHalve->set(0);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    m_pPlay->set(0);
}

TEST_F(HotcueControlTest, SavedLoopNoMoveIfDisabled) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    constexpr double loopSize = 4;
    m_pBeatloopSize->set(loopSize);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = loopSize * beatLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop at position 0
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    m_pPlay->set(1);

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Disable Loop
    m_pLoopEnabled->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());

    // Move loop right (0 => 4 beats) while saved loop is disabled
    m_pLoopMove->set(loopSize);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Move loop left (4 => 0 beats) while saved loop is disabled
    m_pLoopMove->set(-loopSize);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Move loop left (0 => -4 beats) while saved loop is disabled
    m_pLoopMove->set(-loopSize);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    m_pPlay->set(0);
}

TEST_F(HotcueControlTest, SavedLoopReset) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    ProcessBuffer();

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    const auto loopEndPosition = mixxx::audio::kStartFramePos + loopLengthFrames;

    // Set a new beatloop
    setCurrentFramePosition(loopEndPosition);
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    ProcessBuffer();

    // Check if setting the new beatloop disabled the current saved loop
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);
}

TEST_F(HotcueControlTest, SavedLoopCueLoopWithExistingLoop) {
    createAndLoadFakeTrack();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    constexpr auto loopStartPosition = mixxx::audio::FramePos(100);
    constexpr auto loopEndPosition = mixxx::audio::FramePos(200);

    m_pChannel1->getEngineBuffer()->setLoop(loopStartPosition, loopEndPosition, true);

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);

    // Disable Loop
    m_pHotcue1CueLoop->set(1);
    m_pHotcue1CueLoop->set(0);

    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);

    // Re-Enable Loop
    m_pHotcue1CueLoop->set(1);
    m_pHotcue1CueLoop->set(0);

    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);
}

TEST_F(HotcueControlTest, CueLoopWithoutHotcueSetsHotcue) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    m_pHotcue1CueLoop->set(1);
    m_pHotcue1CueLoop->set(0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
    EXPECT_TRUE(m_pLoopEnabled->toBool());
}

TEST_F(HotcueControlTest, CueLoopWithSavedLoopToggles) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_NE(Cue::kNoPosition, m_pHotcue1EndPosition->get());
    EXPECT_TRUE(m_pLoopEnabled->toBool());

    m_pHotcue1CueLoop->set(1);
    m_pHotcue1CueLoop->set(0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_NE(Cue::kNoPosition, m_pHotcue1EndPosition->get());
    EXPECT_FALSE(m_pLoopEnabled->toBool());

    m_pHotcue1CueLoop->set(1);
    m_pHotcue1CueLoop->set(0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_NE(Cue::kNoPosition, m_pHotcue1EndPosition->get());
    EXPECT_TRUE(m_pLoopEnabled->toBool());
}

TEST_F(HotcueControlTest, SavedLoopToggleDoesNotSeek) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    constexpr double loopSize = 4;
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = loopSize * beatLengthFrames;

    const auto beforeLoopPosition = mixxx::audio::kStartFramePos;
    const auto loopStartPosition = mixxx::audio::FramePos(8 * beatLengthFrames);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to loop start position
    setCurrentFramePosition(loopStartPosition);
    ProcessBuffer();

    m_pPlay->set(1);

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Seek to start of track
    setCurrentFramePosition(beforeLoopPosition);
    EXPECT_NEAR(beforeLoopPosition.value(), currentFramePosition().value(), 1024);

    // Check that the previous seek disabled the loop
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Re-Enable loop
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Check that re-enabling loop didn't seek
    EXPECT_NEAR(beforeLoopPosition.value(), currentFramePosition().value(), 1024);

    // Disable loop
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);
}

TEST_F(HotcueControlTest, SavedLoopActivate) {
    m_pQuantizeEnabled->set(0);
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;

    const auto beforeLoopPosition = mixxx::audio::kStartFramePos;
    const auto loopStartPosition = mixxx::audio::FramePos(8 * beatLengthFrames);
    const auto afterLoopPosition = mixxx::audio::FramePos(16 * beatLengthFrames);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to loop start position
    setCurrentFramePosition(loopStartPosition);
    ProcessBuffer();

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);

    m_pPlay->set(1);

    // Save currently active loop to hotcue slot 1
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Seek to start of track
    setCurrentFramePosition(beforeLoopPosition);
    auto positionBeforeActivate = currentFramePosition();
    EXPECT_NEAR(beforeLoopPosition.value(), currentFramePosition().value(), 1000);

    // Check that the previous seek disabled the loop
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Activate saved loop (does not imply seeking to loop start)
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);
    EXPECT_NEAR(positionBeforeActivate.value(), currentFramePosition().value(), 1000);

    // Seek to position after saved loop
    setCurrentFramePosition(afterLoopPosition);
    ProcessBuffer();

    // Check that the previous seek disabled the loop
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);

    positionBeforeActivate = currentFramePosition();

    // Activate saved loop (usually doesn't imply seeking to loop start, but in this case it does
    // because the play position is behind the loop end position)
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition + loopLengthFrames, m_pHotcue1EndPosition);
    EXPECT_NEAR(loopStartPosition.value(), currentFramePosition().value(), 1000);
}

TEST_F(HotcueControlTest, SavedLoopActivateWhilePlayingTogglesLoop) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    m_pBeatloopSize->set(4);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;
    const auto loopStartPosition = mixxx::audio::FramePos(8 * beatLengthFrames);
    const auto loopEndPosition = loopStartPosition + loopLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop
    setCurrentFramePosition(loopStartPosition);
    ProcessBuffer();
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);

    m_pQuantizeEnabled->set(1);
    m_pPlay->set(1);
    ProcessBuffer();

    // Save currently active loop to hotcue slot 1
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(loopStartPosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
    EXPECT_DOUBLE_EQ(m_pHotcue1Position->get(), m_pLoopStartPosition->get());
    EXPECT_DOUBLE_EQ(m_pHotcue1EndPosition->get(), m_pLoopEndPosition->get());

    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_DOUBLE_EQ(0.0, m_pLoopEnabled->get());

    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_DOUBLE_EQ(1.0, m_pLoopEnabled->get());
}

TEST_F(HotcueControlTest, SavedLoopBeatLoopSizeRestore) {
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    constexpr double savedLoopSize = 8;
    m_pBeatloopSize->set(savedLoopSize);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);

    m_pPlay->set(1);

    // Save currently active loop to hotcue slot 1
    m_pHotcue1ActivateLoop->set(1);
    m_pHotcue1ActivateLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Set new beatloop size
    m_pBeatloopSize->set(savedLoopSize / 2);

    // Re-enabled saved loop
    m_pHotcue1ActivateLoop->set(1);
    m_pHotcue1ActivateLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos + loopLengthFrames,
            m_pHotcue1EndPosition);

    // Check that saved loop's beatloop size has been restored
    EXPECT_DOUBLE_EQ(savedLoopSize, m_pBeatloopSize->get());
}

TEST_F(HotcueControlTest, SavedLoopBeatLoopSizeRestoreDoesNotJump) {
    m_pQuantizeEnabled->set(0);
    // Setup fake track with 120 bpm and calculate loop size
    TrackPointer pTrack = loadTestTrackWithBpm(120.0);

    constexpr double savedLoopSize = 4;
    m_pBeatloopSize->set(savedLoopSize);
    const mixxx::audio::FrameDiff_t beatLengthFrames = getBeatLengthFrames(pTrack);
    const mixxx::audio::FrameDiff_t loopLengthFrames = m_pBeatloopSize->get() * beatLengthFrames;
    const auto cuePosition = mixxx::audio::FramePos(8 * beatLengthFrames);
    const auto beforeLoopPosition = mixxx::audio::kStartFramePos;
    const auto afterLoopPosition = mixxx::audio::FramePos(beatLengthFrames);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Seek to cue Position (8th beat)
    setCurrentFramePosition(cuePosition);
    ProcessBuffer();
    EXPECT_FRAMEPOS_EQ(cuePosition, currentFramePosition());

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    m_pPlay->set(1);

    // Check 1: Play position before saved loop

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Set new beatloop size
    m_pBeatloopSize->set(m_pBeatloopSize->get() / 2);

    // Seek to position before saved loop
    setCurrentFramePosition(beforeLoopPosition);

    // Re-enable saved loop
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Check that saved loop's beatloop size has been restored
    EXPECT_DOUBLE_EQ(savedLoopSize, m_pBeatloopSize->get());

    // Check that enabling the loop didn't cause a jump
    EXPECT_NEAR(beforeLoopPosition.value(), currentFramePosition().value(), 1000);

    // Check 2: Play position after saved loop

    // Disable loop
    m_pLoopEnabled->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Set new beatloop size
    m_pBeatloopSize->set(m_pBeatloopSize->get() / 2);

    // Seek to position after saved loop
    setCurrentFramePosition(afterLoopPosition);

    // Re-enable saved loop
    m_pHotcue1Activate->set(1);
    m_pHotcue1Activate->set(0);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(cuePosition + loopLengthFrames, m_pHotcue1EndPosition);

    // Check that saved loop's beatloop size has been restored
    EXPECT_DOUBLE_EQ(savedLoopSize, m_pBeatloopSize->get());

    // Check that enabling the loop didn't cause a jump
    EXPECT_NEAR(afterLoopPosition.value(), currentFramePosition().value(), 1000);
}

TEST_F(HotcueControlTest, SavedLoopUnloadTrackWhileActive) {
    // Setup fake track with 120 bpm
    qWarning() << "Loading first track";
    loadTestTrackWithBpm(120.0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    ProcessBuffer();

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_NE(Cue::kNoPosition, m_pHotcue1Position->get());
    EXPECT_NE(Cue::kNoPosition, m_pHotcue1EndPosition->get());

    // Setup another fake track with 130 bpm
    unloadTrack();
    qWarning() << "Loading second track";
    loadTestTrackWithBpm(130.0);
    ProcessBuffer();

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());
}

TEST_F(HotcueControlTest, SavedLoopUseLoopInOutWhileActive) {
    m_pQuantizeEnabled->set(0);
    std::unique_ptr<ControlProxy> pLoopIn = std::make_unique<ControlProxy>(m_sGroup1, "loop_in");
    std::unique_ptr<ControlProxy> pLoopOut = std::make_unique<ControlProxy>(m_sGroup1, "loop_out");

    // Setup fake track with 120 bpm
    loadTestTrackWithBpm(120.0);

    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Empty), m_pHotcue1Status->get());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                         .isValid());
    EXPECT_FALSE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                         .isValid());

    // Set a beatloop
    m_pBeatloopActivate->set(1);
    m_pBeatloopActivate->set(0);
    ProcessBuffer();

    // Save currently active loop to hotcue slot 1
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_TRUE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1Position->get())
                        .isValid());
    EXPECT_TRUE(mixxx::audio::FramePos::fromEngineSamplePosMaybeInvalid(
            m_pHotcue1EndPosition->get())
                        .isValid());

    constexpr auto loopEndPosition = mixxx::audio::FramePos(1000);

    setCurrentFramePosition(mixxx::audio::kStartFramePos);

    pLoopIn->set(1);
    pLoopIn->set(0);
    ProcessBuffer();

    setCurrentFramePosition(loopEndPosition);

    pLoopOut->set(1);
    pLoopOut->set(0);

    ProcessBuffer();
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::kStartFramePos, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(loopEndPosition, m_pHotcue1EndPosition);
}

// Ordinary hot cues relocate an active loop; recalling a saved loop continues
// to use that saved loop's own boundaries.
TEST_F(HotcueControlTest, Rx3HotcueMovesPlayingLoopForwardAndBackward) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    const auto target = mixxx::audio::FramePos(16 * beat);
    prepareLoopAndHotcue(mixxx::audio::FramePos(4 * beat),
            mixxx::audio::FramePos(8 * beat), target);
    m_pPlay->set(1);
    ProcessBuffer();
    m_pHotcue1Activate->set(1);
    ProcessBuffer();
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(target, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(target + 4 * beat, m_pLoopEndPosition);
    // Run through several complete wraps, including pad release.
    for (int i = 0; i < 400; ++i) ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_GE(currentFramePosition(), target);
    EXPECT_LT(currentFramePosition(), target + 4 * beat);

    m_pPlay->set(0);
    m_pLoopEnabled->set(0);
    setCurrentFramePosition(mixxx::audio::FramePos(2 * beat));
    m_pHotcue1SetCue->set(1);
    m_pHotcue1SetCue->set(0);
    setCurrentFramePosition(target);
    m_pLoopEnabled->set(1);
    m_pPlay->set(1);
    ProcessBuffer();
    m_pHotcue1GotoAndPlay->set(1);
    m_pHotcue1GotoAndPlay->set(0);
    ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::FramePos(2 * beat), m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::FramePos(6 * beat), m_pLoopEndPosition);
    EXPECT_GE(currentFramePosition(), mixxx::audio::FramePos(2 * beat));
    EXPECT_LT(currentFramePosition(), mixxx::audio::FramePos(6 * beat));
}

TEST_F(HotcueControlTest, Rx3HotcueKeepsManualDurationWithoutQuantize) {
    loadTestTrackWithBpm(120);
    const auto target = mixxx::audio::FramePos(200123);
    prepareLoopAndHotcue(mixxx::audio::FramePos(1000),
            mixxx::audio::FramePos(17345), target);
    m_pHotcue1Goto->set(1);
    m_pHotcue1Goto->set(0);
    ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(target, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(target + 16345, m_pLoopEndPosition);
    EXPECT_FRAMEPOS_EQ(target, currentFramePosition());
}

TEST_F(HotcueControlTest, Rx3HotcueQuantizePreservesPhaseAndBeatLength) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    const auto target = mixxx::audio::FramePos(16 * beat + 1000);
    prepareLoopAndHotcue(mixxx::audio::FramePos(4 * beat),
            mixxx::audio::FramePos(8 * beat), target);
    m_pPlay->set(1);
    for (int i = 0; i < 5; ++i) ProcessBuffer();
    const auto before = m_pChannel1->getEngineBuffer()->getExactPlayPos();
    m_pQuantizeEnabled->set(1);
    m_pHotcue1Activate->set(1);
    ProcessBuffer();
    const auto after = m_pChannel1->getEngineBuffer()->getExactPlayPos();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::FramePos(16 * beat), m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::FramePos(20 * beat), m_pLoopEndPosition);
    // One callback advances 512 stereo frames. The cue's off-grid offset
    // must not replace the phase that was playing before the jump.
    EXPECT_NEAR(0, std::remainder((after - before) - kProcessBufferSize / 2, beat), 1);
    EXPECT_FRAMEPOS_EQ_CONTROL(target, m_pHotcue1Position);
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
}

TEST_F(HotcueControlTest, Rx3HotcueQuantizeWrapsPhaseInsideFractionalLoop) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    prepareLoopAndHotcue(mixxx::audio::FramePos(4 * beat),
            mixxx::audio::FramePos(4.5 * beat), mixxx::audio::FramePos(16 * beat + 500));
    m_pPlay->set(1);
    for (int i = 0; i < 18; ++i) ProcessBuffer();
    m_pQuantizeEnabled->set(1);
    m_pHotcue1Activate->set(1);
    ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::FramePos(16 * beat), m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(mixxx::audio::FramePos(16.5 * beat), m_pLoopEndPosition);
    EXPECT_GE(currentFramePosition(), mixxx::audio::FramePos(16 * beat));
    EXPECT_LT(currentFramePosition(), mixxx::audio::FramePos(16.5 * beat));
}

TEST_F(HotcueControlTest, Rx3HotcueMovesSavedLoopWithoutEditingStoredCue) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    const auto start = mixxx::audio::FramePos(4 * beat);
    const auto end = mixxx::audio::FramePos(8 * beat);
    const auto target = mixxx::audio::FramePos(16 * beat);
    prepareLoopAndHotcue(start, end, target);
    ControlProxy hotcue2Set(m_sGroup1, "hotcue_2_setcue");
    hotcue2Set.set(1);
    hotcue2Set.set(0);
    m_pHotcue2Position->set(target.toEngineSamplePos());
    // Store the active loop in slot 1, replacing the ordinary hot cue there.
    m_pHotcue1SetLoop->set(1);
    m_pHotcue1SetLoop->set(0);
    ASSERT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Active), m_pHotcue1Status->get());
    m_pPlay->set(1);
    ProcessBuffer();
    m_pHotcue2Activate->set(1);
    ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(target, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(target + 4 * beat, m_pLoopEndPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(start, m_pHotcue1Position);
    EXPECT_FRAMEPOS_EQ_CONTROL(end, m_pHotcue1EndPosition);
    EXPECT_DOUBLE_EQ(static_cast<double>(HotcueControl::Status::Set), m_pHotcue1Status->get());
}

TEST_F(HotcueControlTest, Rx3HotcueMovesReverseLoopWithoutDisablingIt) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    const auto target = mixxx::audio::FramePos(16 * beat);
    prepareLoopAndHotcue(mixxx::audio::FramePos(4 * beat),
            mixxx::audio::FramePos(8 * beat), target);
    ControlProxy reverse(m_sGroup1, "reverse");
    reverse.set(1);
    m_pPlay->set(1);
    ProcessBuffer();
    m_pHotcue1Activate->set(1);
    ProcessBuffer();
    m_pHotcue1Activate->set(0);
    for (int i = 0; i < 5; ++i) ProcessBuffer();
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(target, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(target + 4 * beat, m_pLoopEndPosition);
    EXPECT_GE(currentFramePosition(), target);
    EXPECT_LT(currentFramePosition(), target + 4 * beat);
}

TEST_F(HotcueControlTest, Rx3HotcuePreviewReleaseKeepsRelocatedLoopPaused) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    const auto target = mixxx::audio::FramePos(16 * beat);
    prepareLoopAndHotcue(mixxx::audio::FramePos(4 * beat),
            mixxx::audio::FramePos(8 * beat), target);
    m_pHotcue1Activate->set(1);
    ProcessBuffer();
    m_pHotcue1Activate->set(0);
    ProcessBuffer();
    EXPECT_FALSE(m_pPlay->toBool());
    EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_FRAMEPOS_EQ_CONTROL(target, m_pLoopStartPosition);
    EXPECT_FRAMEPOS_EQ_CONTROL(target + 4 * beat, m_pLoopEndPosition);
    EXPECT_FRAMEPOS_EQ(target, currentFramePosition());
}

TEST_F(HotcueControlTest, Rx3SecondLoopTableHasExactDurationAndToggleFeedback) {
    const auto track = loadTestTrackWithBpm(120);
    const double beat = getBeatLengthFrames(track);
    for (double size : {0.75, 1.0, 1.5, 3.0, 5.0, 6.0, 7.0, 9.0}) {
        m_pLoopEnabled->set(0);
        setCurrentFramePosition(mixxx::audio::FramePos(4 * beat));
        ControlProxy toggle(m_sGroup1, QString("beatloop_%1_toggle").arg(size));
        ControlProxy enabled(m_sGroup1, QString("beatloop_%1_enabled").arg(size));
        toggle.set(1); toggle.set(0); ProcessBuffer();
        EXPECT_TRUE(m_pLoopEnabled->toBool());
        EXPECT_EQ(1, enabled.get());
        EXPECT_NEAR(size * beat * 2, m_pLoopEndPosition->get() - m_pLoopStartPosition->get(), 2);
        toggle.set(1); toggle.set(0); ProcessBuffer();
        EXPECT_FALSE(m_pLoopEnabled->toBool());
        EXPECT_EQ(0, enabled.get());
    }
}

TEST_F(HotcueControlTest, Rx3GateCueHoldsReturnsAndPlayCommitsPlayback) {
    const auto track = loadTestTrackWithBpm(120);
    const auto cue = mixxx::audio::FramePos(2 * getBeatLengthFrames(track));
    m_pPlay->set(0); setCurrentFramePosition(cue);
    m_pHotcue1SetCue->set(1); m_pHotcue1SetCue->set(0);
    ControlProxy gate(m_sGroup1, "hotcue_1_rx3_gate");
    gate.set(1); ProcessBuffer();
    EXPECT_TRUE(m_pPlay->toBool());
    for(int i=0;i<8;++i) ProcessBuffer();
    EXPECT_GT(currentFramePosition(), cue);
    gate.set(0); ProcessBuffer();
    EXPECT_FALSE(m_pPlay->toBool());
    EXPECT_FRAMEPOS_EQ(cue,currentFramePosition());
    gate.set(1); ProcessBuffer();
    // PLAY/PAUSE toggles the preview play control; CueControl latches it.
    m_pPlay->set(0); ProcessBuffer();
    gate.set(0); ProcessBuffer();
    EXPECT_TRUE(m_pPlay->toBool());
}

TEST_F(HotcueControlTest, Rx3ReleaseFxHoldLatchAndPausedSafety) {
    loadTestTrackWithBpm(120);
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_4"), 1);
    ProcessBuffer();
    EXPECT_EQ(0, releaseFx()->activePad());
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_4"), 0);
    m_pPlay->set(1);
    for (int pad = 1; pad <= 8; ++pad) {
        const QString key = QString("rx3_release_fx_%1").arg(pad);
        ControlObject::set(ConfigKey(m_sGroup1, key), 1); ProcessBuffer();
        EXPECT_EQ(pad, releaseFx()->activePad());
        ControlObject::set(ConfigKey(m_sGroup1, key), 0); ProcessBuffer();
        EXPECT_EQ(0, releaseFx()->activePad());
    }
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_4_latch"), 1);
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_4_latch"), 0); ProcessBuffer();
    EXPECT_EQ(4, releaseFx()->activePad());
    ProcessBuffer(); EXPECT_EQ(4, releaseFx()->activePad());
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_cancel"), 1); ProcessBuffer();
    EXPECT_EQ(0, releaseFx()->activePad());
}

TEST_F(HotcueControlTest, Rx3ReleaseFxRateDirectionAndDeadline) {
    loadTestTrackWithBpm(120);
    for (int pad : {1, 2, 5, 6}) {
        m_pPlay->set(1);
        const QString key = QString("rx3_release_fx_%1").arg(pad);
        ControlObject::set(ConfigKey(m_sGroup1, key), 1);
        releaseFx()->prepare(100, 1000, 120);
        EXPECT_EQ(pad == 2 || pad == 6, releaseFx()->applyRate(1) < 0);
        EXPECT_GT(std::abs(releaseFx()->applyRate(1)), 0);
        releaseFx()->prepare(pad > 4 ? 1900 : 400, 1000, 120);
        EXPECT_EQ(0, releaseFx()->applyRate(1)); EXPECT_FALSE(m_pPlay->toBool());
        ControlObject::set(ConfigKey(m_sGroup1, key), 0);
        releaseFx()->prepare(0, 1000, 120);
    }
}

TEST_F(HotcueControlTest, Rx3ReleaseFxMuteIsSmoothedAndRestoresAudio) {
    loadTestTrackWithBpm(120); m_pPlay->set(1);
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_4"), 1);
    releaseFx()->prepare(100, 1000, 120);
    CSAMPLE samples[200]; std::fill(std::begin(samples), std::end(samples), 1);
    releaseFx()->processAudio(samples, 200);
    EXPECT_GT(samples[0], 0); EXPECT_LT(samples[0], 1);
    EXPECT_LT(samples[198], 0.00001); EXPECT_EQ(samples[198], samples[199]);
    ControlObject::set(ConfigKey(m_sGroup1, "rx3_release_fx_4"), 0);
    releaseFx()->prepare(100, 1000, 120);
    std::fill(std::begin(samples), std::end(samples), 1); releaseFx()->processAudio(samples, 200);
    EXPECT_GT(samples[198], 0.9999);
}

TEST_F(HotcueControlTest, Rx3ReleaseFxRestoresExistingLoopAndBuildsUp) {
    loadTestTrackWithBpm(120); m_pPlay->set(1);
    m_pQuantizeEnabled->set(0);
    m_pLoopStartPosition->set(44100); m_pLoopEndPosition->set(88200);
    m_pLoopEnabled->set(1); ProcessBuffer();
    for (int pad : {3, 7}) {
        const QString key = QString("rx3_release_fx_%1").arg(pad);
        ControlObject::set(ConfigKey(m_sGroup1, key), 1); ProcessBuffer();
        const double initial = m_pLoopEndPosition->get() - m_pLoopStartPosition->get();
        if (pad == 7) {
            releaseFx()->prepare(44100, 44100, 120);
            EXPECT_NEAR(initial / 2, m_pLoopEndPosition->get() - m_pLoopStartPosition->get(), 2);
        }
        ControlObject::set(ConfigKey(m_sGroup1, key), 0); ProcessBuffer();
        EXPECT_EQ(44100, m_pLoopStartPosition->get()); EXPECT_EQ(88200, m_pLoopEndPosition->get());
        EXPECT_TRUE(m_pLoopEnabled->toBool());
    }
}

TEST_F(HotcueControlTest, Rx3MemoryRecallStoreDeleteAndTenPointLimit) {
    auto track = loadTestTrackWithBpm(120); m_pQuantizeEnabled->set(0);
    for (int i : {3,1,2}) track->createAndAddCue(mixxx::CueType::MemoryCue, Cue::kNoHotCue,
            mixxx::audio::FramePos(i * 10000), {}, mixxx::RgbColor(0xff8800));
    auto pulse = [&](const QString& action) {
        ControlObject::set(ConfigKey(m_sGroup1, "rx3_memory_" + action), 1);
        ControlObject::set(ConfigKey(m_sGroup1, "rx3_memory_" + action), 0); ProcessBuffer();
    };
    EXPECT_EQ(3, ControlObject::get(ConfigKey(m_sGroup1, "rx3_memory_count")));
    setCurrentFramePosition(mixxx::audio::FramePos(0)); pulse("next");
    EXPECT_NEAR(10000, currentFramePosition().value(), 1); EXPECT_FALSE(m_pPlay->toBool());
    pulse("next"); EXPECT_NEAR(20000, currentFramePosition().value(), 1);
    pulse("prev"); EXPECT_NEAR(10000, currentFramePosition().value(), 1);
    pulse("delete"); EXPECT_EQ(2, ControlObject::get(ConfigKey(m_sGroup1, "rx3_memory_count")));
    pulse("store"); EXPECT_EQ(3, ControlObject::get(ConfigKey(m_sGroup1, "rx3_memory_count")));
    pulse("store"); EXPECT_EQ(3, ControlObject::get(ConfigKey(m_sGroup1, "rx3_memory_count")));
    for (int i = 4; i <= 10; ++i) {
        setCurrentFramePosition(mixxx::audio::FramePos(i * 10000));
        ControlObject::set(ConfigKey(m_sGroup1, "cue_point"), i * 20000); pulse("store");
    }
    EXPECT_EQ(10, ControlObject::get(ConfigKey(m_sGroup1, "rx3_memory_count")));
    setCurrentFramePosition(mixxx::audio::FramePos(120000)); pulse("store");
    EXPECT_EQ(10, ControlObject::get(ConfigKey(m_sGroup1, "rx3_memory_count")));
}

TEST_F(HotcueControlTest, Rx3MemoryLoopArmsAtCrossingAndCanExit) {
    auto track = loadTestTrackWithBpm(120); m_pQuantizeEnabled->set(0);
    const auto start = mixxx::audio::FramePos(10000), end = mixxx::audio::FramePos(30000);
    track->createAndAddCue(mixxx::CueType::ActiveLoop, Cue::kNoHotCue, start, end, mixxx::RgbColor(0xff0000));
    auto* cue = cueControl();
    cue->prepareRx3ActiveLoop(mixxx::audio::FramePos(9000), 500); EXPECT_FALSE(m_pLoopEnabled->toBool());
    cue->prepareRx3ActiveLoop(mixxx::audio::FramePos(9900), 512); EXPECT_TRUE(m_pLoopEnabled->toBool());
    EXPECT_EQ(start.toEngineSamplePos(), m_pLoopStartPosition->get()); EXPECT_EQ(end.toEngineSamplePos(), m_pLoopEndPosition->get());
    m_pLoopEnabled->set(0); cue->prepareRx3ActiveLoop(mixxx::audio::FramePos(11000), 512);
    EXPECT_FALSE(m_pLoopEnabled->toBool());
    cue->prepareRx3ActiveLoop(mixxx::audio::FramePos(9000), 2000); EXPECT_TRUE(m_pLoopEnabled->toBool());
}

TEST_F(HotcueControlTest, Rx3GateCueWhilePlayingDoesNotReturnOrStopOnRelease) {
    const auto track=loadTestTrackWithBpm(120);
    const auto cue=mixxx::audio::FramePos(2*getBeatLengthFrames(track));
    m_pPlay->set(0);setCurrentFramePosition(cue);m_pHotcue1SetCue->set(1);m_pHotcue1SetCue->set(0);
    setCurrentFramePosition(cue+getBeatLengthFrames(track));m_pPlay->set(1);ProcessBuffer();
    ControlProxy gate(m_sGroup1,"hotcue_1_rx3_gate");gate.set(1);ProcessBuffer();
    for(int i=0;i<8;++i) ProcessBuffer();
    const auto heldPosition=currentFramePosition();gate.set(0);ProcessBuffer();
    EXPECT_TRUE(m_pPlay->toBool());EXPECT_GT(currentFramePosition(),heldPosition);
}

TEST_F(HotcueControlTest, Rx3EndOfTrackIsExplicitAndClearsOnLoad) {
    const auto track=loadTestTrackWithBpm(120);
    EXPECT_EQ(0,ControlObject::get(ConfigKey(m_sGroup1,"rx3_track_end")));
    m_pPlay->set(1);ProcessBuffer();
    setCurrentFramePosition(mixxx::audio::FramePos(track->getDuration()*track->getSampleRate().value()));
    ProcessBuffer();
    EXPECT_FALSE(m_pPlay->toBool());EXPECT_EQ(1,ControlObject::get(ConfigKey(m_sGroup1,"rx3_track_end")));
    loadTestTrackWithBpm(120);EXPECT_EQ(0,ControlObject::get(ConfigKey(m_sGroup1,"rx3_track_end")));
}
