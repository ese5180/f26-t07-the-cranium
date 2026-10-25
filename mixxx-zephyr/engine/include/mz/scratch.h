// Jog-wheel smoothing and scratching.
//
// Rotary is Mixxx's src/util/rotary.cpp (a moving average over the last
// calls), used by RateControl to smooth "jog". AlphaBetaFilter is
// src/util/alphabetafilter.h. Scratcher reproduces what Mixxx's controller
// script engine does for engine.scratchEnable / scratchTick / scratchDisable
// (src/controllers/scripting/legacy/controllerscriptinterfacelegacy.cpp):
// every millisecond it feeds the wheel movement through the alpha-beta filter
// and writes the smoothed velocity to scratch2.
#pragma once

namespace mz {

class Rotary {
  public:
    static constexpr int kSize = 25; // RateControl's m_pJogFilter(25)

    Rotary();
    double filter(double value);

  private:
    double m_history[kSize];
    int m_head;
};

class AlphaBetaFilter {
  public:
    AlphaBetaFilter();

    void init(double dt, double v, double alpha = 1.0 / 512, double beta = (1.0 / 512) / 1024);
    void observation(double dx);
    double predictedVelocity() const {
        return m_v;
    }

  private:
    bool m_initialized;
    double m_dt, m_x, m_v, m_alpha, m_beta;
};

class Scratcher {
  public:
    // Mixxx runs the scratch timer every kScratchTimerMs.
    static constexpr double kTickSeconds = 0.001;

    Scratcher();

    // engine.scratchEnable(deck, intervalsPerRev, rpm, alpha, beta, ramp=true)
    void enable(int intervalsPerRev, double rpm, double alpha, double beta,
            double currentVelocity);
    // engine.scratchTick(deck, interval)
    void tick(int interval);
    // engine.scratchDisable(deck, ramp=true): ramp to rampTo (the deck's rate
    // if it is playing, otherwise 0).
    void disable(double rampTo);

    // Advances the 1 ms timer by seconds of audio. Returns true while the
    // deck should take its speed from velocity() (scratch2_enable).
    bool advance(double seconds);

    bool enabled() const {
        return m_enabled;
    }
    double velocity() const {
        return m_velocity;
    }

  private:
    void step();

    AlphaBetaFilter m_filter;
    bool m_enabled; // scratch2_enable
    bool m_timerRunning;
    bool m_ramp;
    double m_dx;
    double m_intervalAccumulator;
    double m_rampTo;
    double m_rampFactor;
    double m_velocity; // scratch2
    double m_sinceMovement; // seconds since the last tick()
    double m_pending; // audio time not yet covered by timer steps
};

} // namespace mz
