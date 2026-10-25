#include "mz/scratch.h"

#include <cmath>

namespace mz {

Rotary::Rotary()
        : m_history{}, m_head(0) {
}

double Rotary::filter(double value) {
    m_head = (m_head + 1) % kSize;
    m_history[m_head] = value;
    double sum = 0;
    for (double v : m_history) {
        sum += v;
    }
    return sum / kSize;
}

AlphaBetaFilter::AlphaBetaFilter()
        : m_initialized(false), m_dt(0), m_x(0), m_v(0), m_alpha(0), m_beta(0) {
}

void AlphaBetaFilter::init(double dt, double v, double alpha, double beta) {
    m_initialized = true;
    m_dt = dt;
    m_x = 0.0;
    m_v = v;
    m_alpha = alpha;
    m_beta = beta;
}

void AlphaBetaFilter::observation(double dx) {
    if (!m_initialized) {
        return;
    }
    const double predictedX = m_x + m_v * m_dt;
    const double predictedV = m_v;
    const double residualX = dx - predictedX;
    m_x = predictedX + residualX * m_alpha;
    m_v = predictedV + residualX * m_beta / m_dt;
    m_x -= dx; // relative to the previous observation
}

Scratcher::Scratcher()
        : m_enabled(false),
          m_timerRunning(false),
          m_ramp(false),
          m_dx(0),
          m_intervalAccumulator(0),
          m_rampTo(0),
          m_rampFactor(0.001),
          m_velocity(0),
          m_sinceMovement(0),
          m_pending(0) {
}

void Scratcher::enable(int intervalsPerRev, double rpm, double alpha, double beta,
        double currentVelocity) {
    const double intervalsPerSecond = (rpm * intervalsPerRev) / 60.0;
    if (intervalsPerSecond == 0.0) {
        return;
    }
    m_dx = 1.0 / intervalsPerSecond;
    m_intervalAccumulator = 0.0;
    m_ramp = false;
    m_rampFactor = 0.001;
    // The FLX4 script passes ramp=true, so the velocity starts at the deck's.
    if (alpha != 0.0 && beta != 0.0) {
        m_filter.init(kTickSeconds, currentVelocity, alpha, beta);
    } else {
        m_filter.init(kTickSeconds, currentVelocity);
    }
    m_velocity = currentVelocity;
    m_enabled = true;
    m_timerRunning = true;
    m_sinceMovement = 0;
    m_pending = 0;
}

void Scratcher::tick(int interval) {
    m_sinceMovement = 0;
    m_intervalAccumulator += interval;
}

void Scratcher::disable(double rampTo) {
    m_rampTo = rampTo;
    m_sinceMovement = 0;
    m_ramp = true;
}

void Scratcher::step() {
    if (m_ramp && m_sinceMovement >= kTickSeconds) {
        m_filter.observation(m_rampTo * m_rampFactor);
    } else {
        m_filter.observation(m_dx * m_intervalAccumulator);
    }
    m_velocity = m_filter.predictedVelocity();
    m_intervalAccumulator = 0;
    m_sinceMovement += kTickSeconds;

    if (m_ramp && std::fabs(m_rampTo - m_velocity) <= 0.00001) {
        m_ramp = false;
        m_enabled = false;
        m_timerRunning = false;
        m_dx = 0.0;
    }
}

bool Scratcher::advance(double seconds) {
    if (!m_timerRunning) {
        return false;
    }
    m_pending += seconds;
    while (m_pending >= kTickSeconds && m_timerRunning) {
        m_pending -= kTickSeconds;
        step();
    }
    return m_enabled;
}

} // namespace mz
