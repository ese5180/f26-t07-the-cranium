// Tests for enginebuffer.cpp

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <QString>
#include <cmath>
#include "track/sourcebinding.h"
#include <QTest>
#include <QtDebug>

#include "control/controlobject.h"
#include "engine/controls/ratecontrol.h"
#include "mixer/basetrackplayer.h"
#include "preferences/usersettings.h"
#include "test/mixxxtest.h"
#include "test/mockedenginebackendtest.h"
#include "test/signalpathtest.h"

// In case any of the test in this file fail. You can use the audioplot.py tool
// in the tools folder to visually compare the results of the enginebuffer
// with the golden test data.

namespace {
const QString kAppGroup = QStringLiteral("[App]");
}

class EngineBufferTest : public MockedEngineBackendTest {};

class EngineBufferE2ETest : public SignalPathTest {};

TEST_F(EngineBufferTest, DisableKeylockResetsPitch) {
    // To prevent one-slider users from getting stuck on a key,
    // KeyunlockMode::ResetLockedKey resets the musical pitch.
    ControlObject::set(ConfigKey(m_sGroup1, "keylockMode"),
            1.0); // KeylockMode::LockCurrentKey
    ControlObject::set(ConfigKey(m_sGroup1, "keyunlockMode"),
            0.0); // KeyunlockMode::ResetLockedKey
    ControlObject::set(ConfigKey(m_sGroup1, "file_bpm"), 128.0);
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), 0.5);
    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 0.0);
    // We require a buffer process to see that the keylock state has changed.
    ProcessBuffer();
    ASSERT_EQ(0.0, ControlObject::get(ConfigKey(m_sGroup1, "pitch")));
}

TEST_F(EngineBufferTest, DisableKeylockKeepsPitch) {
    // Pitch must not change when unlocking with KeyunlockMode::KeepLockedKey.
    ControlObject::set(ConfigKey(m_sGroup1, "keylockMode"),
            1.0); // KeylockMode::LockCurrentKey
    ControlObject::set(ConfigKey(m_sGroup1, "keyunlockMode"),
            1.0); // KeyunlockMode::KeepLockedKey
    ControlObject::set(ConfigKey(m_sGroup1, "file_bpm"), 128.0);
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), 0.5);
    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 0.0);
    // We require a buffer process to see that the keylock state has changed.
    ProcessBuffer();
    ASSERT_NEAR(0.5, ControlObject::get(ConfigKey(m_sGroup1, "pitch")), 1e-10);
}

TEST_F(EngineBufferTest, TrackLoadResetsPitch) {
    // When a new track is loaded, the pitch value should be reset.
    config()->set(ConfigKey("[Controls]","SpeedAutoReset"),
                  ConfigValue(BaseTrackPlayer::RESET_PITCH));
    ControlObject::set(ConfigKey(m_sGroup1, "file_bpm"), 128.0);
    ControlObject::set(ConfigKey(m_sGroup1, "pitch_adjust"), 0.5);
    ProcessBuffer();
    ASSERT_NEAR(0.5, ControlObject::get(ConfigKey(m_sGroup1, "pitch_adjust")), 1e-10);

    m_pMixerDeck1->loadFakeTrack(false, 0.0);
    ASSERT_NEAR(0.0, ControlObject::get(ConfigKey(m_sGroup1, "pitch_adjust")), 1e-10);
}

TEST_F(EngineBufferTest, PitchRoundtrip) {
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "keylockMode"),
            0.0); // KeylockMode::LockOriginalKey
    ControlObject::set(ConfigKey(m_sGroup1, "keyunlockMode"),
            0.0); // KeyunlockMode::ResetLockedKey
    ProcessBuffer();
    // we are in kPakmOffsetScaleReseting mode
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.5);
    ProcessBuffer();
    // pitch_adjust must not change
    ASSERT_DOUBLE_EQ(0.0,
                     ControlObject::get(ConfigKey(m_sGroup1, "pitch_adjust")));

    ControlObject::set(ConfigKey(m_sGroup1, "pitch_adjust"), 0.5);
    ProcessBuffer();
    // rate must not change
    ASSERT_DOUBLE_EQ(0.5, ControlObject::get(ConfigKey(m_sGroup1, "rate")));

    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ProcessBuffer();
    // pitch is reset, as well as pitch_adjust
    // speed must not change, pitch and pitch_adjust must be 0
    ASSERT_DOUBLE_EQ(0.5, ControlObject::get(ConfigKey(m_sGroup1, "rate")));
    ASSERT_DOUBLE_EQ(0.0, ControlObject::get(ConfigKey(m_sGroup1, "pitch")));
    ASSERT_DOUBLE_EQ(0.0, ControlObject::get(ConfigKey(m_sGroup1, "pitch_adjust")));

    ControlObject::set(ConfigKey(m_sGroup1, "keylockMode"),
            1.0); // KeylockMode::LockCurrentKey
    ProcessBuffer();
    // rate must not change
    ASSERT_DOUBLE_EQ(0.5, ControlObject::get(ConfigKey(m_sGroup1, "rate")));
    // pitch must reflect the absolute pitch
    ASSERT_DOUBLE_EQ(0.0, ControlObject::get(ConfigKey(m_sGroup1, "pitch")));

    ControlObject::set(ConfigKey(m_sGroup1, "keylockMode"),
            0.0); // KeylockMode::LockOriginalKey
    ProcessBuffer();
    // rate must not change
    ASSERT_DOUBLE_EQ(0.5, ControlObject::get(ConfigKey(m_sGroup1, "rate")));
    // pitch must be 0
    ASSERT_NEAR(0.0, ControlObject::get(ConfigKey(m_sGroup1, "pitch")), 1e-10);
}

#ifdef __RUBBERBAND__
TEST_F(EngineBufferTest, SlowRubberBand) {
    // At very slow speeds, RubberBand needs to reallocate buffers and since
    // this
    // is done in the engine thread it can be a major party-stopper.
    // Make sure slow speeds still use the linear scaler.
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), 2.8);

    // Hack to get a slow, non-scratching direct speed
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 0.0072);

    // With Soundtouch, it should switch the scaler as well
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::SoundTouch));
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);

    // Back to full speed
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 1);
    ProcessBuffer();

    // With Rubberband, and transport stopped it should be still keylock
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::RubberBandFaster));
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 0.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleKeylock1, m_pChannel1->getEngineBuffer()->m_pScale);

    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 0.0072);

    // Playing at low rate, the vinyl scaler should be used
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
}
#endif

TEST_F(EngineBufferTest, ScalerNoTransport) {
    // normally use the Vinyl scaler
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);

    // switch to keylock scaler
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleKeylock1, m_pChannel1->getEngineBuffer()->m_pScale);

    // Stop and disable keylock: do not change scaler
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 0.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleKeylock1, m_pChannel1->getEngineBuffer()->m_pScale);

    // play: we need to use vinyl scaler
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
}

TEST_F(EngineBufferTest, VinylScalerRampZero) {
    // scratch in play mode
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2_enable"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), 1.0);

    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
    EXPECT_EQ(m_pMockScaleVinyl1->getProcessedTempo(), 1.0);

    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), 0.0);

    // we are in scratching mode so a zero rate has to be processed
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
    EXPECT_EQ(m_pMockScaleVinyl1->getProcessedTempo(), 0.0);
}

TEST_F(EngineBufferTest, ReadFadeOut) {
    // Start playing
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);

    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
    EXPECT_EQ(m_pMockScaleVinyl1->getProcessedTempo(), 1.0);

    // pause
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 0.0);

    // The scaler need to be processed with the old rate to
    // prepare the crossfade buffer
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
    EXPECT_EQ(m_pMockScaleVinyl1->getProcessedTempo(), 1.0);
}

TEST_F(EngineBufferTest, ResetPitchAdjustUsesLinear) {
    // If the key was adjusted, but keylock is off, and then the key is
    // reset, then the engine should be using the linear scaler.

    // First, we should be using the keylock scaler here.
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), 1.2);
    // Remember that a rate of "0" is "regular playback speed".
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.05);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleKeylock1, m_pChannel1->getEngineBuffer()->m_pScale);

    // Reset pitch adjust, and we should be back to the linear scaler.
    ControlObject::set(ConfigKey(m_sGroup1, "pitch_adjust_set_default"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(m_pMockScaleVinyl1, m_pChannel1->getEngineBuffer()->m_pScale);
}

TEST_F(EngineBufferE2ETest, SoundTouchCrashTest) {
    // Soundtouch has a bug where a pitch value of zero causes an infinite loop
    // and crash.
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::SoundTouch));
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), 1.2);
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.05);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    // Start by playing with soundtouch enabled.
    ProcessBuffer();
    // Pause the buffer.  This causes the pitch to be set to 0.
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 0.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), -0.05);
    // Should not crash
    ProcessBuffer();
}

TEST_F(EngineBufferE2ETest, BasicProcessingTest) {
    // Confirm that playing ramps from silence, pausing ramps to silence,
    // and also just confirm that playing works as predicted.
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.05);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "BasicProcessingTestPlay");
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "BasicProcessingTestPlaying");
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 0.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "BasicProcessingTestPause");
}

TEST_F(EngineBufferE2ETest, ScratchTest) {
    // Confirm that vinyl scratching smoothly transitions from one direction
    // to the other.
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2_enable"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), 1.1);
    m_pChannel1->getEngineBuffer()->queueNewPlaypos(
            mixxx::audio::FramePos(225), EngineBuffer::SEEK_EXACT);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), -1.1);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "ScratchTestMain");
}

TEST_F(EngineBufferE2ETest, ScratchTestStart) {
    // Confirm that vinyl scratching smoothly transitions from zero speed
    // to an the other speed above the 0.07 threshold.
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2_enable"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), 1);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), 0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "scratch2"), 0.5);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "ScratchTestStart");
}

TEST_F(EngineBufferE2ETest, ReverseTest) {
    // Confirm that pushing the reverse button smoothly transitions.
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "reverse"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "ReverseTest");
}

// DISABLED: This test is too dependent on the sound touch library version.
TEST_F(EngineBufferE2ETest, DISABLED_SoundTouchToggleTest) {
   // Test various cases where SoundTouch toggles on and off.
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::SoundTouch));
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.5);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    // Test transition from vinyl to keylock
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "SoundTouchTest");
    // Test transition from keylock to vinyl due to slow speed.
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 0.0072);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "SoundTouchTestSlow");
    // Test transition back to keylock due to regular speed.
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "SoundTouchTestRegular");
}

#ifdef __RUBBERBAND__
// DISABLED: This test is too dependent on the rubber band library version.
TEST_F(EngineBufferE2ETest, DISABLED_RubberbandToggleTest) {
   // Test various cases where Rubberband toggles on and off.
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::RubberBandFaster));
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.5);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    // Test transition from vinyl to keylock
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "RubberbandTest");
    // Test transition from keylock to vinyl due to slow speed.
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 0.0072);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "RubberbandTestSlow");
    // Test transition back to keylock due to regular speed.
    ControlObject::set(ConfigKey(m_sGroup1, "rateSearch"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "RubberbandTestRegular");
}
#endif

// DISABLED: This test is too dependent on the sound touch library version.
// NOTE(uklotzde, 2018-01-10): We have also seen spurious failures on the
// Linux build server under high load. These failures might by caused by
// delayed asynchronous reads from CachingReader. The corresponding chunks
// will be filled with 0-samples by the engine buffer scaler.
TEST_F(EngineBufferE2ETest, DISABLED_KeylockReverseTest) {
    // Confirm that when toggling reverse while keylock is on, interpolation
    // is smooth.
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::SoundTouch));
    ControlObject::set(ConfigKey(m_sGroup1, "keylockMode"),
                       0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.5);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "keylock"), 1.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "reverse"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "KeylockReverseTest");
}

TEST_F(EngineBufferE2ETest, SeekTest) {
    // Confirm that seeking to a new position smoothly transitions.
    ControlObject::set(ConfigKey(m_sGroup1, "rate"), 0.0);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    m_pChannel1->getEngineBuffer()->queueNewPlaypos(
            mixxx::audio::FramePos(500), EngineBuffer::SEEK_EXACT);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "SeekTest");
}

TEST_F(EngineBufferE2ETest, SoundTouchReverseTest) {
    // This test must not crash when changing to reverse while pitch is tweaked
    // Testing issue #8061
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::SoundTouch));
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), -1);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "reverse"), 1.0);
    ProcessBuffer();
    // Note: we cannot compare a golden buffer here, because the result depends
    // on the uses library version
}

#ifdef __RUBBERBAND__
TEST_F(EngineBufferE2ETest, RubberbandReverseTest) {
    // This test must not crash when changing to reverse while pitch is tweaked
    // Testing issue #8061
    ControlObject::set(ConfigKey(kAppGroup, QStringLiteral("keylock_engine")),
            static_cast<double>(EngineBuffer::KeylockEngine::RubberBandFaster));
    ControlObject::set(ConfigKey(m_sGroup1, "pitch"), -1);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "reverse"), 1.0);
    ProcessBuffer();
    // Note: we cannot compare a golden buffer here, because the result depends
    // on the uses library version
}
#endif

TEST_F(EngineBufferE2ETest, CueGotoAndStopTest) {
    // Be sure, that the Crossfade buffer is processed only once
    // Issue #8251
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "cue_gotoandstop"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "CueGotoAndStopTest");
}

TEST_F(EngineBufferE2ETest, CueGotoAndPlayTest) {
    // Be sure, cue seek is not overwritten by quantization seek
    // Issue #8249
    ControlObject::set(ConfigKey(m_sGroup1, "quantize"), 1.0);
    ControlObject::set(ConfigKey(m_sGroup1, "cue_point"), 0.0);
    m_pChannel1->getEngineBuffer()->queueNewPlaypos(
            mixxx::audio::FramePos(500), EngineBuffer::SEEK_EXACT);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "cue_gotoandplay"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "CueGotoAndPlayTest");
}

TEST_F(EngineBufferE2ETest, CueStartPlayTest) {
    // Be sure, cue seek is not overwritten by quantization seek
    // Issue #8252
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "start_play"), 1.0);
    ProcessBuffer();
    assertBufferMatchesReference(m_pEngineMixer->getMainBuffer(),
            kProcessBufferSize,
            "StartPlayTest");
}

TEST_F(EngineBufferE2ETest, CueGotoAndPlayDenon) {
    // Be sure, cue point is not moved
    // enable Denon mode issue #8254
    ControlObject::set(ConfigKey(m_sGroup1, "cue_mode"), 2.0); // CUE_MODE_DENON
    m_pChannel1->getEngineBuffer()->queueNewPlaypos(
            mixxx::audio::FramePos(500), EngineBuffer::SEEK_EXACT);
    ProcessBuffer();
    double cueBefore = ControlObject::get(ConfigKey(m_sGroup1, "cue_point"));
    ControlObject::set(ConfigKey(m_sGroup1, "cue_gotoandplay"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(cueBefore, ControlObject::get(ConfigKey(m_sGroup1, "cue_point")));
}

TEST_F(EngineBufferTest, RateTempTest) {
    RateControl::setTemporaryRateChangeCoarseAmount(4);
    RateControl::setTemporaryRateChangeFineAmount(2);

    ControlObject::set(ConfigKey(m_sGroup1, "rate_dir"), 1);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(1.0, m_pChannel1->getEngineBuffer()->m_speed_old);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up"), 1);
    ProcessBuffer();
    EXPECT_EQ(1.04, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up"), 0);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up_small"), 1);
    ProcessBuffer();
    EXPECT_EQ(1.02, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up_small"), 0);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down"), 1);
    ProcessBuffer();
    EXPECT_EQ(0.96, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down"), 0);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down_small"), 1);
    ProcessBuffer();
    EXPECT_EQ(0.98, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down_small"), 0);

    ControlObject::set(ConfigKey(m_sGroup1, "rate_dir"), -1);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up"), 1);
    ProcessBuffer();
    EXPECT_EQ(1.04, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up"), 0);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up_small"), 1);
    ProcessBuffer();
    EXPECT_EQ(1.02, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_up_small"), 0);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down"), 1);
    ProcessBuffer();
    EXPECT_EQ(0.96, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down"), 0);

    ProcessBuffer();

    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down_small"), 1);
    ProcessBuffer();
    EXPECT_EQ(0.98, m_pChannel1->getEngineBuffer()->m_speed_old);
    ControlObject::set(ConfigKey(m_sGroup1, "rate_temp_down_small"), 0);
}


TEST_F(EngineBufferTest, RatePermTest) {
    RateControl::setPermanentRateChangeCoarseAmount(4);
    RateControl::setPermanentRateChangeFineAmount(2);

    ControlObject::set(ConfigKey(m_sGroup1, "rate_dir"), 1);
    ControlObject::set(ConfigKey(m_sGroup1, "play"), 1.0);
    ProcessBuffer();
    EXPECT_EQ(1.0, m_pChannel1->getEngineBuffer()->m_speed_old);

    ControlObject::set(ConfigKey(m_sGroup1, "rate_perm_up"), 1);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "rate_perm_up"), 0);
    EXPECT_EQ(1.04, m_pChannel1->getEngineBuffer()->m_speed_old);

    ControlObject::set(ConfigKey(m_sGroup1, "rate_perm_up_small"), 1);
    ProcessBuffer();
    ControlObject::set(ConfigKey(m_sGroup1, "rate_perm_up_small"), 0);
    EXPECT_EQ(1.06, m_pChannel1->getEngineBuffer()->m_speed_old);
}

// Compare against a second deck that plays uninterrupted. This checks the
// actual transport destination, rather than only the SLIP control lamp.
class Rx3SlipTest : public MockedEngineBackendTest {
  protected:
    void SetUp() override {
        MockedEngineBackendTest::SetUp();
        m_pTrack1 = m_pMixerDeck1->loadFakeTrack(true, 120.0);
        m_pTrack2 = m_pMixerDeck2->loadFakeTrack(true, 120.0);
        deck()->setTrackEndPosition(mixxx::audio::FramePos(44100 * 60));
        reference()->setTrackEndPosition(mixxx::audio::FramePos(44100 * 60));
        set("quantize", 0);
        ControlObject::set(ConfigKey(m_sGroup2,"quantize"),0);
        seekBoth(100000);
    }
    EngineBuffer* deck() {return m_pChannel1->getEngineBuffer();}
    EngineBuffer* reference() {return m_pChannel2->getEngineBuffer();}
    void set(const QString& key,double value) {ControlObject::set(ConfigKey(m_sGroup1,key),value);}
    double get(const QString& key) {return ControlObject::get(ConfigKey(m_sGroup1,key));}
    void process(int count=1) {for(int i=0;i<count;++i) ProcessBuffer();}
    void seekBoth(double frame) {
        deck()->queueNewPlaypos(mixxx::audio::FramePos(frame),EngineBuffer::SEEK_EXACT);
        reference()->queueNewPlaypos(mixxx::audio::FramePos(frame),EngineBuffer::SEEK_EXACT);
        process();
    }
    void expectReference() {
        EXPECT_NEAR(reference()->getExactPlayPos().value(),deck()->getExactPlayPos().value(),1);
    }
    void expectDeadline(double beats, const QString& control) {
        const double start = reference()->getExactPlayPos().value();
        const double durationFrames = beats * 44100 * 60 / 120;
        double previous = start;
        int callbacks = 0;
        while (get(control) != 0 && callbacks++ < 2000) {
            previous = reference()->getExactPlayPos().value();
            process();
        }
        ASSERT_LT(callbacks, 2000);
        // The deadline is applied in the first callback after its beat has
        // elapsed; neither early cancellation nor an extra beat is allowed.
        EXPECT_GE(previous - start, durationFrames);
        EXPECT_LT(previous - start, durationFrames + 512);
        EXPECT_EQ(0, get("slip_active"));
        expectReference();
    }
};

TEST_F(Rx3SlipTest, ArmingDoesNotDisplaceNormalPlayback) {
    set("slip_enabled",1);process(10);
    EXPECT_EQ(0,get("slip_active"));expectReference();
    set("slip_enabled",0);process();expectReference();
}

TEST_F(Rx3SlipTest, ScratchReleaseReturnsWithoutDisarming) {
    set("slip_enabled",1);process();
    set("scratch2_enable",1);set("scratch2",0);process(30);
    EXPECT_EQ(1,get("slip_active"));
    EXPECT_LT(deck()->getExactPlayPos().value(),reference()->getExactPlayPos().value());
    set("scratch2_enable",0);process();
    EXPECT_EQ(0,get("slip_active"));EXPECT_EQ(1,get("slip_enabled"));expectReference();
}

TEST_F(Rx3SlipTest, VinylPauseContinuesBackgroundUntilPlay) {
    set("slip_enabled",1);process();
    set("play",0);process(30);EXPECT_EQ(1,get("slip_active"));
    set("play",1);process();expectReference();EXPECT_EQ(1,get("slip_enabled"));
}

TEST_F(Rx3SlipTest, PauseWithoutVinylDoesNotSlip) {
    set("slip_enabled",1);set("rx3_vinyl_mode",0);process();
    set("play",0);process(30);EXPECT_EQ(0,get("slip_active"));
    set("play",1);process();
    EXPECT_LT(deck()->getExactPlayPos().value(),reference()->getExactPlayPos().value());
}

TEST_F(Rx3SlipTest, LoopExitReturnsWithoutDisarming) {
    set("slip_enabled",1);process();
    const auto start=deck()->getExactPlayPos();
    deck()->setLoop(start,start+mixxx::audio::FrameDiff_t(22050),true);
    process(100);EXPECT_EQ(1,get("slip_active"));
    set("loop_enabled",0);process();expectReference();EXPECT_EQ(1,get("slip_enabled"));
}

TEST_F(Rx3SlipTest, SlipLoopWorksWithModeOffAndRestoresIt) {
    set("rx3_slip_loop",0.125);process(100);
    EXPECT_EQ(1,get("slip_active"));
    set("rx3_slip_loop",0);process();expectReference();
    EXPECT_EQ(0,get("slip_enabled"));EXPECT_EQ(0,get("slip_active"));
}

TEST_F(Rx3SlipTest, SlipLoopPreservesArmedModeAndSupportsThirdBeat) {
    set("slip_enabled",1);process();
    set("rx3_slip_loop",1.0/3);process(80);
    set("rx3_slip_loop",0.75);process(20);
    set("rx3_slip_loop",0);process();expectReference();EXPECT_EQ(1,get("slip_enabled"));
}

TEST_F(Rx3SlipTest, NativeLoopRollPreservesArmedMode) {
    set("slip_enabled",1);process();
    set("beatlooproll_0.125_activate",1);process(80);
    set("beatlooproll_0.125_activate",0);process();expectReference();EXPECT_EQ(1,get("slip_enabled"));
}

TEST_F(Rx3SlipTest, HotcueReleaseReturnsWithoutStopping) {
    set("hotcue_1_set",1);set("hotcue_1_position",300000);set("slip_enabled",1);process();
    set("hotcue_1_activate",1);process(30);
    EXPECT_EQ(1,get("slip_active"));
    EXPECT_GT(deck()->getExactPlayPos().value(),reference()->getExactPlayPos().value());
    set("hotcue_1_activate",0);process();expectReference();
    EXPECT_EQ(1,get("play"));EXPECT_EQ(1,get("slip_enabled"));
}

TEST_F(Rx3SlipTest, HotcueAutomaticallyReturnsAtFourBeats) {
    set("hotcue_1_set",1);set("hotcue_1_position",300000);set("slip_enabled",1);process();
    set("hotcue_1_activate",1);
    expectDeadline(4, "slip_hotcue");
    set("hotcue_1_activate",0);process();expectReference();EXPECT_EQ(1,get("play"));
}

TEST_F(Rx3SlipTest, ReverseAutomaticallyReturnsAtEightBeats) {
    seekBoth(250000);set("slip_enabled",1);process();
    set("reverse",1);
    expectDeadline(8, "reverse");
    EXPECT_EQ(0,get("reverse"));EXPECT_EQ(0,get("slip_active"));
    EXPECT_EQ(1,get("slip_enabled"));expectReference();
}

TEST_F(Rx3SlipTest, OverlappingLoopAndScratchKeepOneBackground) {
    set("slip_enabled",1);process();
    set("scratch2_enable",1);set("scratch2",0);process(30);
    const auto start=deck()->getExactPlayPos();
    deck()->setLoop(start,start+mixxx::audio::FrameDiff_t(22050),true);process(30);
    set("loop_enabled",0);process();EXPECT_EQ(1,get("slip_active"));
    set("scratch2_enable",0);process();expectReference();
}

TEST_F(Rx3SlipTest, LoadingTrackResetsSlipAndIndicators) {
    set("slip_enabled",1);set("scratch2_enable",1);process();
    m_pMixerDeck1->loadFakeTrack(false,120);process();
    EXPECT_EQ(0,get("slip_enabled"));EXPECT_EQ(0,get("slip_active"));
    EXPECT_EQ(0,get("slip_hotcue"));EXPECT_EQ(0,get("slip_indicator"));
}

TEST_F(Rx3SlipTest, ReverseRollDeadlineRestoresInitiallyDisabledSlip) {
    seekBoth(250000);
    set("reverseroll", 1);
    expectDeadline(8, "reverse");
    EXPECT_EQ(0, get("slip_enabled"));
    set("reverseroll", 0);
    process();
    expectReference();
}

TEST_F(Rx3SlipTest, ReverseReleasePreservesArmedSlip) {
    seekBoth(250000);
    set("slip_enabled", 1);
    process();
    set("reverseroll", 1);
    process(30);
    EXPECT_EQ(1, get("slip_active"));
    set("reverseroll", 0);
    process();
    EXPECT_EQ(1, get("slip_enabled"));
    expectReference();
}

TEST_F(Rx3SlipTest, EarlierHotcueReleaseCannotCancelAnotherHeldPad) {
    set("hotcue_1_set", 1);
    set("hotcue_1_position", 300000);
    set("hotcue_2_set", 1);
    set("hotcue_2_position", 400000);
    set("slip_enabled", 1);
    process();
    set("hotcue_1_activate", 1);
    process(20);
    set("hotcue_2_activate", 1);
    process(20);
    set("hotcue_1_activate", 0);
    process();
    EXPECT_EQ(2, get("slip_hotcue"));
    EXPECT_EQ(1, get("slip_active"));
    set("hotcue_2_activate", 0);
    process();
    expectReference();
}

TEST_F(Rx3SlipTest, QuantizedPlayAfterSlipPauseReturnsExactlyToBackground) {
    set("quantize", 1);
    set("slip_enabled", 1);
    process();
    set("play", 0);
    process(30);
    set("play", 1);
    process();
    expectReference();
}

TEST_F(Rx3SlipTest, DisabledSlipFlashingKeepsActionLampBlinking) {
    set("slip_enabled", 1);
    set("slip_flashing", 0);
    process();
    EXPECT_EQ(1, get("slip_indicator"));
    EXPECT_EQ(1, get("slip_flash_indicator"));
    set("scratch2_enable", 1);
    set("scratch2", 0);
    process();
    ControlObject::getControl(ConfigKey("[App]", "indicator_250ms"))->setAndConfirm(1);
    QCoreApplication::processEvents();
    EXPECT_EQ(1, get("slip_indicator"));
    ControlObject::getControl(ConfigKey("[App]", "indicator_250ms"))->setAndConfirm(0);
    QCoreApplication::processEvents();
    EXPECT_EQ(0, get("slip_indicator"));
    EXPECT_EQ(1, get("slip_flash_indicator"));
    EXPECT_EQ(1, get("slip_play_indicator"));
}

TEST_F(Rx3SlipTest, BackgroundTempoTracksPitchChangesDuringScratch) {
    set("slip_enabled", 1);
    process();
    set("scratch2_enable", 1);
    set("scratch2", 0);
    process(30);
    set("rate", 0.5);
    ControlObject::set(ConfigKey(m_sGroup2, "rate"), 0.5);
    process(30);
    set("scratch2_enable", 0);
    process();
    expectReference();
}

TEST_F(Rx3SlipTest, HotcueAtTrackEndReturnsRatherThanEnteringSlipPause) {
    set("hotcue_1_set", 1);
    set("hotcue_1_position", (44100 * 60 - 1024) * 2);
    set("slip_enabled", 1);
    process();
    set("hotcue_1_activate", 1);
    process(8);
    EXPECT_EQ(0, get("slip_hotcue"));
    EXPECT_EQ(0, get("slip_active"));
    EXPECT_EQ(1, get("play"));
    expectReference();
}

TEST_F(Rx3SlipTest, EjectionClearsSlipWithoutWaitingForAnotherTrack) {
    set("slip_enabled", 1);
    set("scratch2_enable", 1);
    process();
    deck()->ejectTrack();
    EXPECT_EQ(0, get("slip_enabled"));
    EXPECT_EQ(0, get("slip_active"));
    EXPECT_EQ(0, get("slip_indicator"));
}


class EmergencyHistoryScaler : public MockScaler {
  public:
    double scaleBuffer(CSAMPLE* output,SINT samples) override {
        const auto frames=MockScaler::scaleBuffer(output,samples);
        for(SINT frame=0;frame<samples/2;++frame) {
            const CSAMPLE value=CSAMPLE(0.4*std::sin(m_frame++*0.03));
            output[2*frame]=value;output[2*frame+1]=value;
        }
        return frames;
    }
  private:
    size_t m_frame=0;
};
class Rx3EmergencyTest : public MockedEngineBackendTest {
  protected:
    void SetUp() override {
        MockedEngineBackendTest::SetUp();
        delete m_pMockScaleVinyl1;delete m_pMockScaleKeylock1;
        delete m_pMockScaleVinyl2;delete m_pMockScaleKeylock2;
        m_pMockScaleVinyl1=new EmergencyHistoryScaler;m_pMockScaleKeylock1=new EmergencyHistoryScaler;
        m_pMockScaleVinyl2=new EmergencyHistoryScaler;m_pMockScaleKeylock2=new EmergencyHistoryScaler;
        deck(1)->setScalerForTest(m_pMockScaleVinyl1,m_pMockScaleKeylock1);
        deck(2)->setScalerForTest(m_pMockScaleVinyl2,m_pMockScaleKeylock2);
        m_usb=std::make_shared<mixxx::rekordbox::SessionState>();
    }
    EngineBuffer* deck(int index) {return (index==1?m_pChannel1:m_pChannel2)->getEngineBuffer();}
    TrackPointer loadUsb(int index,const std::shared_ptr<mixxx::rekordbox::SessionState>& usb,bool play=true) {
        auto track=Track::newTemporary(mixxx::FileAccess(),mixxx::TrackUsePolicy::rekordboxUsbPolicy(),
                mixxx::SourceBinding::rekordboxUsb(index,usb));
        track->setAudioProperties(mixxx::kEngineChannelCount,mixxx::audio::SampleRate(44100),mixxx::audio::Bitrate(),mixxx::Duration::fromSeconds(60));
        track->trySetBpm(122.0);deck(index)->loadFakeTrack(track,play);
        ControlObject::set(ConfigKey(QString("[Channel%1]").arg(index),"quantize"),0);
        return track;
    }
    double get(int index,const QString& key) {return ControlObject::get(ConfigKey(QString("[Channel%1]").arg(index),key));}
    void process(int count=1) {for(int i=0;i<count;++i) ProcessBuffer();}
    double energy(int index) {
        const auto* audio=m_pEngineMixer->getChannelBuffer(QString("[Channel%1]").arg(index));
        if(!audio) return 0;
        double result=0;for(int i=0;i<kProcessBufferSize;++i) result+=std::abs(audio[i]);return result;
    }
    std::shared_ptr<mixxx::rekordbox::SessionState> m_usb;
};
TEST_F(Rx3EmergencyTest, SharedUsbLossKeepsBothDecksAudibleAndFreezesTransport) {
    const auto first=loadUsb(1,m_usb);const auto second=loadUsb(2,m_usb);process(220);
    ASSERT_GT(energy(1),1);ASSERT_GT(energy(2),1);
    const auto position1=deck(1)->getExactPlayPos();const auto position2=deck(2)->getExactPlayPos();
    m_usb->invalidate();process();
    EXPECT_EQ(1,get(1,"rx3_emergency_loop"));EXPECT_EQ(1,get(2,"rx3_emergency_loop"));
    EXPECT_TRUE(deck(1)->isTrackLoaded());EXPECT_TRUE(deck(2)->isTrackLoaded());
    for(const auto& key:{"play","cue_gotoandstop","reverse","slip_enabled","scratch2_enable"})
        ControlObject::set(ConfigKey(m_sGroup1,key),key==QString("play")?0:1);
    deck(1)->queueNewPlaypos(mixxx::audio::FramePos(10),EngineBuffer::SEEK_EXACT);
    process(230);
    EXPECT_EQ(position1,deck(1)->getExactPlayPos());EXPECT_EQ(position2,deck(2)->getExactPlayPos());
    EXPECT_GT(energy(1),1);EXPECT_GT(energy(2),1);EXPECT_EQ(1,get(1,"play"));
    EXPECT_EQ(0,get(1,"slip_active"));
}
TEST_F(Rx3EmergencyTest, DifferentUsbKeepsRunningAndNewTrackClearsEmergency) {
    auto other=std::make_shared<mixxx::rekordbox::SessionState>();
    loadUsb(1,m_usb);loadUsb(2,other);process(220);
    const auto position=deck(2)->getExactPlayPos();m_usb->invalidate();process(10);
    EXPECT_EQ(1,get(1,"rx3_emergency_loop"));EXPECT_EQ(0,get(2,"rx3_source_lost"));
    EXPECT_GT(deck(2)->getExactPlayPos(),position);
    loadUsb(1,other);process();EXPECT_EQ(0,get(1,"rx3_source_lost"));EXPECT_EQ(0,get(1,"rx3_emergency_loop"));
}
TEST_F(Rx3EmergencyTest, PausedDeckDoesNotStartAudioAndReadFailureAlsoLatches) {
    const auto track=loadUsb(1,m_usb,false);process();m_usb->invalidate();process();
    EXPECT_EQ(1,get(1,"rx3_source_lost"));EXPECT_EQ(0,get(1,"rx3_emergency_loop"));EXPECT_EQ(0,energy(1));
    auto other=std::make_shared<mixxx::rekordbox::SessionState>();
    const auto readable=loadUsb(1,other);process(220);
    ASSERT_TRUE(QMetaObject::invokeMethod(deck(1),"slotTrackSourceUnavailable",Qt::DirectConnection,Q_ARG(TrackPointer,readable)));
    process();EXPECT_EQ(1,get(1,"rx3_emergency_loop"));EXPECT_GT(energy(1),1);
    deck(1)->ejectTrack();process();EXPECT_EQ(0,get(1,"rx3_source_lost"));EXPECT_EQ(0,energy(1));
}
TEST(Rx3EmergencyAudio, LoopsFourBeatsAtCapturedRateWithoutAnotherSourceRead) {
    Rx3EmergencyLoop loop;loop.prepare();
    std::vector<CSAMPLE> input(48000*8);
    for(size_t i=0;i<input.size()/2;++i) input[2*i]=input[2*i+1]=CSAMPLE(std::sin(i*0.01));
    loop.capture(input.data(),int(input.size()),48000);ASSERT_TRUE(loop.start(122));
    EXPECT_EQ(size_t(std::round(4*48000*60.0/122)),loop.lengthFrames());
    std::vector<CSAMPLE> first(loop.lengthFrames()*2),second(first.size());
    loop.render(first.data(),int(first.size()));loop.render(second.data(),int(second.size()));
    for(size_t i=64;i<first.size();++i) EXPECT_FLOAT_EQ(first[i],second[i]);
    loop.reset();EXPECT_FALSE(loop.start(122));
}

class Rx3EmergencyE2ETest : public SignalPathTest {};
TEST_F(Rx3EmergencyE2ETest, HealthyUsbTrackEndDoesNotReportSourceLoss) {
    auto session=std::make_shared<mixxx::rekordbox::SessionState>();
    const auto track=Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo(getTestDir().filePath("sine-30.wav"))),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),mixxx::SourceBinding::rekordboxUsb(1,session));
    ASSERT_TRUE(track);track->trySetBpm(122);loadTrack(m_pMixerDeck1,track);
    auto* engine=m_pChannel1->getEngineBuffer();
    ControlObject::set(ConfigKey(m_sGroup1,"quantize"),0);ControlObject::set(ConfigKey(m_sGroup1,"repeat"),0);
    engine->queueNewPlaypos(engine->getTrackEndPosition()-11025,EngineBuffer::SEEK_EXACT);
    ControlObject::set(ConfigKey(m_sGroup1,"play"),1);
    for(int i=0;i<100;++i) {ProcessBuffer();QTest::qSleep(1);}
    EXPECT_EQ(0,ControlObject::get(ConfigKey(m_sGroup1,"rx3_source_lost")));
    EXPECT_EQ(0,ControlObject::get(ConfigKey(m_sGroup1,"rx3_emergency_loop")));
}

TEST_F(Rx3EmergencyE2ETest, RevokedUsbWithRealDecoderRepeatsCapturedAudio) {
    auto session=std::make_shared<mixxx::rekordbox::SessionState>();
    const auto track=Track::newTemporary(mixxx::FileAccess(mixxx::FileInfo(getTestDir().filePath("sine-30.wav"))),
            mixxx::TrackUsePolicy::rekordboxUsbPolicy(),mixxx::SourceBinding::rekordboxUsb(1,session));
    ASSERT_TRUE(track);track->trySetBpm(122);loadTrack(m_pMixerDeck1,track);
    ControlObject::set(ConfigKey(m_sGroup1,"quantize"),0);
    ControlObject::set(ConfigKey(m_sGroup1,"play"),1);
    auto energy=[this] {
        const auto* audio=m_pEngineMixer->getChannelBuffer(m_sGroup1);
        double sum=0;for(int i=0;i<kProcessBufferSize;++i) sum+=std::abs(audio[i]);return sum;
    };
    for(int i=0;i<250;++i) {ProcessBuffer();QTest::qSleep(1);}
    ASSERT_GT(energy(),0.1);
    const auto position=m_pChannel1->getEngineBuffer()->getExactPlayPos();
    session->invalidate();
    for(int i=0;i<100;++i) {ProcessBuffer();QTest::qSleep(1);}
    EXPECT_EQ(1,ControlObject::get(ConfigKey(m_sGroup1,"rx3_source_lost")));
    EXPECT_EQ(1,ControlObject::get(ConfigKey(m_sGroup1,"rx3_emergency_loop")));
    EXPECT_EQ(position,m_pChannel1->getEngineBuffer()->getExactPlayPos());EXPECT_GT(energy(),0.1);
    EXPECT_TRUE(m_pChannel1->getEngineBuffer()->isTrackLoaded());
}

#include "engine/channels/enginemicrophone.h"
class Rx3MicrophoneSignalPathTest : public BaseSignalPathTest {};
TEST_F(Rx3MicrophoneSignalPathTest, NativeControlsProcessCapturedMicrophoneAndClearOnDisconnect) {
    const QString group="[Microphone1]";
    EngineMicrophone mic(m_pEngineMixer->registerChannelGroup(group),m_pEffectsManager);
    ControlObject::set(ConfigKey("[App]","samplerate"),48000);
    const AudioInput input(AudioPathType::Microphone,0,mixxx::audio::ChannelCount(2),0);
    mic.onInputConfigured(input);
    ASSERT_EQ(1,ControlObject::get(ConfigKey(group,"input_configured")));
    ControlObject::set(ConfigKey(group,"rx3_eq_low"),12);
    const double gain=ControlObject::get(ConfigKey(group,"pregain"));
    ASSERT_GT(gain,0);
    std::array<CSAMPLE,960> source{},output{};
    double inputPower=0,outputPower=0;
    for(int buffer=0;buffer<100;++buffer) {
        for(int frame=0;frame<480;++frame) source[2*frame]=CSAMPLE(0.1*std::sin(2*3.14159265358979323846*100*(buffer*480+frame)/48000));
        mic.receiveBuffer(input,source.data(),480);mic.process(output.data(),int(output.size()));
        if(buffer>=50) for(int frame=0;frame<480;++frame) {
            inputPower+=source[2*frame]*source[2*frame]*gain*gain;
            outputPower+=output[2*frame]*output[2*frame];
            EXPECT_FLOAT_EQ(0,output[2*frame+1]);
        }
    }
    EXPECT_NEAR(12,10*std::log10(outputPower/inputPower),1.1);
    mic.onInputUnconfigured(input);mic.process(output.data(),int(output.size()));
    EXPECT_EQ(0,ControlObject::get(ConfigKey(group,"input_configured")));
    for(auto sample:output) EXPECT_FLOAT_EQ(0,sample);
}

#include "engine/enginetalkoverducking.h"
TEST_F(Rx3MicrophoneSignalPathTest, NormalTalkoverUsesDbLevelsAndDetectsBothPolarities) {
    const QString group="[Rx3TalkoverTest]";
    ControlObject::set(ConfigKey("[App]","samplerate"),48000);
    EngineTalkoverDucking duck(config(),group);
    ControlObject::set(ConfigKey(group,"rx3_talkover_enabled"),1);
    ControlObject::set(ConfigKey(group,"talkoverDucking"),1);
    const std::array<CSAMPLE,4> antiphase{{-0.5f,0.5f,-0.5f,0.5f}};
    const std::array<CSAMPLE,4> quiet{{0.1f,-0.1f,0.1f,-0.1f}};
    for(double level: {-24.0,-18.0,-12.0,-6.0}) {
        duck.processKey(quiet.data(),int(quiet.size()));EXPECT_FLOAT_EQ(1,duck.getGain(48000));
        ControlObject::set(ConfigKey(group,"rx3_talkover_level"),level);
        duck.processKey(antiphase.data(),int(antiphase.size()));
        EXPECT_NEAR(std::pow(10,level/20),duck.getGain(48000),1e-6);
    }
    duck.processKey(nullptr,0);EXPECT_FLOAT_EQ(1,duck.getGain(48000));
    duck.setAboveThreshold(true);EXPECT_LT(duck.getGain(48000),1);
    ControlObject::set(ConfigKey(group,"talkoverDucking"),0);EXPECT_FLOAT_EQ(1,duck.getGain(48000));
}
