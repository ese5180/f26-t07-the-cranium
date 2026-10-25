// Decks and the mixer, through the engine, on one thread.
#include <vector>

#include "mz/biquad.h"
#include "mz/engine.h"
#include "support.h"
#include "test.h"

using namespace mz_test;
using mz::Target;

namespace {

constexpr uint32_t kTrackRate = 44100;
constexpr uint32_t kOutputRate = 48000;
constexpr int kBlock = 256;
constexpr double kStep = static_cast<double>(kTrackRate) / kOutputRate;

struct Fixture {
    explicit Fixture(double seconds = 20) {
        storage.add("tone.wav", makeSineWav(kTrackRate, seconds, 440));
        storage.add("other.wav", makeSineWav(kTrackRate, seconds, 1000));
        engine.library().add("tone.wav");
        engine.library().add("other.wav");
        engine.requestLoad(0, 0);
        engine.requestLoad(1, 1);
        run(engine, storage, 2);
    }
    mz::Engine engine{kOutputRate};
    MemoryStorage storage;
};

// Position after n blocks of playback from rest at speed (the first block
// ramps up from 0, as the linear scaler does).
double positionAfter(int blocks, double speed) {
    const double step = kStep * speed;
    return step * kBlock * (blocks - 1) + step * (kBlock + 1) / 2.0;
}

} // namespace

TEST(tracksLoadAndStartPaused) {
    Fixture f;
    mz::DeckStatus s = f.engine.deckStatus(0);
    CHECK(s.trackLoaded);
    CHECK(!s.playing);
    CHECK(s.frameCount == static_cast<int64_t>(kTrackRate * 20));
    CHECK(f.engine.deck(0).position() == 0);
}

TEST(playAdvancesAtTheTracksRate) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    f.engine.post(event(Target::Play, 0, 0)); // release does nothing
    run(f.engine, f.storage, 100);
    // The play loop steps in 32.32 fixed point: exact to well under a frame.
    CHECK_NEAR(f.engine.deck(0).position(), positionAfter(100, 1.0), 1e-4);
    CHECK(f.engine.deckStatus(0).playing);
    CHECK(f.engine.deckStatus(0).underruns < 300);
    // Deck 2 was never started.
    CHECK(f.engine.deck(1).position() == 0);
}

TEST(rateSliderFollowsMixxxDefaults) {
    Fixture f;
    // rate_dir is -1 and the range 8 %: slider at +1 plays at 0.92.
    f.engine.post(event(Target::Rate, 0, 1));
    run(f.engine, f.storage, 1);
    CHECK_NEAR(f.engine.deck(0).rateRatio(), 0.92, 1e-12);
    f.engine.post(event(Target::Rate, 0, -1));
    run(f.engine, f.storage, 1);
    CHECK_NEAR(f.engine.deck(0).rateRatio(), 1.08, 1e-12);
    // The FLX4's tempo-range button cycles 6, 10, 16, 25 %.
    const double expected[] = {0.06, 0.10, 0.16, 0.25, 0.06};
    for (double range : expected) {
        f.engine.post(event(Target::CycleTempoRange, 0, 1));
        f.engine.post(event(Target::CycleTempoRange, 0, 0));
        run(f.engine, f.storage, 1);
        CHECK_NEAR(f.engine.deck(0).rateRatio(), 1 + range, 1e-12);
    }
}

TEST(cueWhilePlayingReturnsToCueAndStops) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 50);
    f.engine.post(event(Target::CueDefault, 0, 1));
    f.engine.post(event(Target::CueDefault, 0, 0));
    run(f.engine, f.storage, 2);
    CHECK(!f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() == 0);
    CHECK(f.engine.deckStatus(0).cueIndicator);
}

TEST(cueWhilePausedSetsCueThenPreviewsIt) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 40);
    f.engine.post(event(Target::Play, 0, 1)); // pause
    run(f.engine, f.storage, 3);
    const double paused = f.engine.deck(0).position();
    CHECK(paused > 0);
    // Paused away from the cue: CUE moves the cue point here.
    f.engine.post(event(Target::CueDefault, 0, 1));
    f.engine.post(event(Target::CueDefault, 0, 0));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).cuePoint() == std::floor(paused));
    // Now at the cue (within a frame): holding CUE previews.
    f.engine.post(event(Target::StartStop, 0, 1));
    run(f.engine, f.storage, 1);
    f.engine.post(event(Target::CueDefault, 0, 1));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).cuePoint() == 0); // start_stop put us at 0, which became the cue
    f.engine.post(event(Target::CueDefault, 0, 0));
    run(f.engine, f.storage, 1);
    f.engine.post(event(Target::CueDefault, 0, 1));
    run(f.engine, f.storage, 10);
    CHECK(f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() > 0);
    f.engine.post(event(Target::CueDefault, 0, 0));
    run(f.engine, f.storage, 1);
    CHECK(!f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() == f.engine.deck(0).cuePoint());
}

TEST(playDuringCuePreviewKeepsPlaying) {
    Fixture f;
    f.engine.post(event(Target::CueDefault, 0, 1)); // at the cue (0): preview
    run(f.engine, f.storage, 5);
    f.engine.post(event(Target::Play, 0, 1));
    f.engine.post(event(Target::CueDefault, 0, 0));
    run(f.engine, f.storage, 5);
    CHECK(f.engine.deck(0).isPlaying());
}

TEST(hotcuesSetJumpPreviewAndClear) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 30);
    f.engine.post(event(Target::HotcueActivate, 0, 1, 2)); // pad 3: set here
    f.engine.post(event(Target::HotcueActivate, 0, 0, 2));
    run(f.engine, f.storage, 1);
    const double hotcue = f.engine.deck(0).hotcue(2);
    CHECK(hotcue > 0);
    CHECK(f.engine.deckStatus(0).hotcuesSet == 0x04);

    run(f.engine, f.storage, 30);
    f.engine.post(event(Target::HotcueActivate, 0, 1, 2)); // playing: jump
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() < hotcue + kBlock * kStep + 1);

    f.engine.post(event(Target::HotcueActivate, 0, 0, 2));
    f.engine.post(event(Target::Play, 0, 1)); // pause
    run(f.engine, f.storage, 5);
    f.engine.post(event(Target::HotcueActivate, 0, 1, 2)); // paused: preview
    run(f.engine, f.storage, 10);
    CHECK(f.engine.deck(0).isPlaying());
    f.engine.post(event(Target::HotcueActivate, 0, 0, 2));
    run(f.engine, f.storage, 1);
    CHECK(!f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() == hotcue);

    f.engine.post(event(Target::HotcueClear, 0, 1, 2));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).hotcue(2) < 0);
    CHECK(f.engine.deckStatus(0).hotcuesSet == 0);
}

TEST(manualLoopWrapsAndReloopToggles) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 20);
    f.engine.post(event(Target::LoopIn, 0, 1));
    run(f.engine, f.storage, 1);
    const double start = std::floor(f.engine.deck(0).position() - kBlock * kStep);
    run(f.engine, f.storage, 20);
    f.engine.post(event(Target::LoopOut, 0, 1));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).loopEnabled());
    const double loopLength = 21 * kBlock * kStep;
    // Play several loop lengths: the position stays inside the loop.
    for (int i = 0; i < 100; ++i) {
        run(f.engine, f.storage, 1);
        CHECK(f.engine.deck(0).position() >= start - 1);
        CHECK(f.engine.deck(0).position() <= start + loopLength + kBlock * kStep + 1);
    }
    CHECK(f.engine.deckStatus(0).loopEnabled);
    f.engine.post(event(Target::ReloopToggle, 0, 1));
    run(f.engine, f.storage, 1);
    CHECK(!f.engine.deck(0).loopEnabled());
    f.engine.post(event(Target::ReloopAndStop, 0, 1));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).loopEnabled());
    CHECK(!f.engine.deck(0).isPlaying());
}

TEST(endOfTrackStops) {
    Fixture f(0.5);
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 200); // about 1 s
    CHECK(!f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() == f.engine.deckStatus(0).frameCount);
}

TEST(jogNudgeMovesAsFarAsInMixxx) {
    Fixture plain;
    Fixture nudged;
    plain.engine.post(event(Target::Play, 0, 1));
    nudged.engine.post(event(Target::Play, 0, 1));
    run(plain.engine, plain.storage, 10);
    run(nudged.engine, nudged.storage, 10);
    nudged.engine.post(event(Target::JogTurn, 0, 10)); // 10 ticks forward
    run(plain.engine, plain.storage, 300);
    run(nudged.engine, nudged.storage, 300);
    const double extra = nudged.engine.deck(0).position() - plain.engine.deck(0).position();
    // ticks * bendScale 0.8 * sensitivity 0.1 * Mixxx's 1024-frame period,
    // in track frames. The jog filter updates on block boundaries, so its
    // 25 periods add up to within one block of 25 * 1024 frames.
    CHECK_NEAR(extra, 10 * 0.8 * 0.1 * 1024, 0.032 * kBlock * kStep + 1);
}

TEST(pausedJogUsesTheLargerMultiplier) {
    Fixture f;
    f.engine.post(event(Target::JogTurn, 0, 5));
    run(f.engine, f.storage, 300);
    CHECK_NEAR(f.engine.deck(0).position(), 5 * 0.8 * 0.1 * 1024 * 18, 0.288 * kBlock * kStep + 1);
    CHECK(!f.engine.deck(0).isPlaying());
}

TEST(scratchFollowsTheWheel) {
    Fixture f;
    f.engine.post(event(Target::JogTouch, 0, 1));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.deck(0).scratching());
    // 720 ticks per turn at 33 1/3 rpm is 400 ticks a second for normal speed.
    double sent = 0;
    const int blocks = 375; // 2 s
    for (int b = 0; b < blocks; ++b) {
        const double due = 400.0 * (b + 1) * kBlock / kOutputRate;
        const int ticks = static_cast<int>(due - sent);
        if (ticks > 0) {
            f.engine.post(event(Target::JogTurn, 0, static_cast<float>(ticks)));
            sent += ticks;
        }
        run(f.engine, f.storage, 1);
    }
    // Two seconds of track, give or take the filter's lag.
    CHECK_NEAR(f.engine.deck(0).position(), 2.0 * kTrackRate, 0.1 * kTrackRate);
    f.engine.post(event(Target::JogTouch, 0, 0));
    run(f.engine, f.storage, 400);
    CHECK(!f.engine.deck(0).scratching());
    const double stopped = f.engine.deck(0).position();
    run(f.engine, f.storage, 20);
    CHECK_NEAR(f.engine.deck(0).position(), stopped, 1.0);
}

TEST(crossfaderAndFadersShapeTheMain) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    f.engine.post(event(Target::Play, 1, 1));
    run(f.engine, f.storage, 20);
    const double both = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);

    f.engine.post(event(Target::Crossfader, -1, -1));
    run(f.engine, f.storage, 2);
    const double leftOnly = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);
    f.engine.post(event(Target::Volume, 0, 0));
    run(f.engine, f.storage, 2);
    const double silent = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);

    // Two uncorrelated sines at 0.5: about 0.5 RMS together, 0.354 alone.
    CHECK_NEAR(both, 0.5, 0.02);
    CHECK_NEAR(leftOnly, 0.3536, 0.01);
    CHECK(silent < 1e-4);
}

TEST(pflIsPreFaderAndHeadMixBlends) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    f.engine.post(event(Target::Pfl, 0, 1));
    f.engine.post(event(Target::Volume, 0, 0)); // fader down
    f.engine.setOutputMode(mz::OutputMode::Headphones);
    run(f.engine, f.storage, 20);
    const double cue = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);
    CHECK_NEAR(cue, 0.3536, 0.01); // heard in the headphones although the fader is down

    f.engine.setOutputMode(mz::OutputMode::Main);
    CHECK(rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2) < 1e-4);

    // headMix fully to main: the headphones follow the (silent) main.
    f.engine.post(event(Target::HeadMix, -1, 1));
    f.engine.setOutputMode(mz::OutputMode::Headphones);
    run(f.engine, f.storage, 2);
    CHECK(rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2) < 1e-4);
}

TEST(splitCuePutsCueLeftAndMainRight) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    f.engine.post(event(Target::Play, 1, 1));
    f.engine.post(event(Target::Pfl, 1, 1));
    f.engine.post(event(Target::Crossfader, -1, -1)); // deck 2 out of the main
    f.engine.setOutputMode(mz::OutputMode::SplitCue);
    run(f.engine, f.storage, 20);
    std::vector<int16_t> out = run(f.engine, f.storage, 20);
    std::vector<int16_t> left, right;
    for (size_t i = 0; i < out.size(); i += 2) {
        left.push_back(out[i]);
        right.push_back(out[i + 1]);
    }
    // Left: deck 2's 1 kHz cue; right: deck 1's 440 Hz main. Both ~0.354.
    CHECK_NEAR(rms(left.data(), left.size()), 0.3536, 0.01);
    CHECK_NEAR(rms(right.data(), right.size()), 0.3536, 0.01);
}

TEST(pregainAndEqChangeTheLevel) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    f.engine.post(event(Target::Volume, 1, 0));
    run(f.engine, f.storage, 20);
    const double unity = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);
    f.engine.post(event(Target::Pregain, 0, 0.5f));
    run(f.engine, f.storage, 2);
    const double half = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);
    CHECK_NEAR(half / unity, 0.5, 0.01);
    // Killing the mids: the 440 Hz tone is cut as much as the mid-cut bell
    // (at the log centre of 250 and 2500 Hz, Q 0.9, -26 dB) cuts 440 Hz.
    f.engine.post(event(Target::Pregain, 0, 1));
    f.engine.post(event(Target::EqMid, 0, 0));
    run(f.engine, f.storage, 40);
    const double killed = rms(run(f.engine, f.storage, 20).data(), 20 * kBlock * 2);
    mz::Biquad midCut;
    midCut.design(mz::BiquadType::Peaking, kOutputRate, std::sqrt(250.0 * 2500.0), 0.9, -26);
    CHECK_NEAR(killed / unity, midCut.magnitudeAt(440, kOutputRate), 0.01);
    CHECK(killed < unity * 0.5);
}

TEST(loadingAMissingFileLeavesTheDeckEmpty) {
    Fixture f;
    f.engine.library().add("missing.wav");
    CHECK(f.engine.requestLoad(0, 2));
    run(f.engine, f.storage, 2);
    CHECK(!f.engine.deckStatus(0).trackLoaded);
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 2);
    CHECK(!f.engine.deck(0).isPlaying());
    // Files are closed when replaced.
    CHECK(f.storage.closed >= 1);
}

TEST(loadingANewTrackResetsTheDeck) {
    Fixture f;
    f.engine.post(event(Target::Play, 0, 1));
    run(f.engine, f.storage, 20);
    f.engine.post(event(Target::HotcueActivate, 0, 1, 0));
    run(f.engine, f.storage, 1);
    CHECK(f.engine.requestLoad(0, 1));
    run(f.engine, f.storage, 2);
    CHECK(!f.engine.deck(0).isPlaying());
    CHECK(f.engine.deck(0).position() == 0);
    CHECK(f.engine.deck(0).hotcue(0) < 0);
}
