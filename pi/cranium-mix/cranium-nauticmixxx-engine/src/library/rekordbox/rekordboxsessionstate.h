#pragma once

#include <QUuid>
#include <QtGlobal>

#include <atomic>
#include <utility>

namespace mixxx::rekordbox {

class SessionIdentifier final {
  public:
    static SessionIdentifier create() {
        static std::atomic<quint64> nextGeneration{1};
        return SessionIdentifier(
                nextGeneration.fetch_add(1, std::memory_order_relaxed),
                QUuid::createUuid());
    }

    SessionIdentifier() = default;

    bool isValid() const {
        return m_generation != 0 && !m_uuid.isNull();
    }

    quint64 generation() const {
        return m_generation;
    }

    const QUuid& uuid() const {
        return m_uuid;
    }

    bool operator==(const SessionIdentifier&) const = default;

  private:
    SessionIdentifier(quint64 generation, QUuid uuid)
            : m_generation(generation),
              m_uuid(std::move(uuid)) {
    }

    quint64 m_generation{0};
    QUuid m_uuid;
};

// A small thread-safe revocation token. It has no audio, filesystem, catalog,
// UI, or SQL dependencies. State transitions are terminal: no API can restore
// Active after revoke/invalidate.
class SessionState final {
  public:
    enum class State : quint8 {
        Active,
        Revoked,
        Invalidated,
    };

    SessionState()
            : m_identifier(SessionIdentifier::create()) {
    }

    SessionState(const SessionState&) = delete;
    SessionState& operator=(const SessionState&) = delete;
    SessionState(SessionState&&) = delete;
    SessionState& operator=(SessionState&&) = delete;

    const SessionIdentifier& identifier() const {
        return m_identifier;
    }

    State state() const {
        return m_state.load(std::memory_order_acquire);
    }

    bool isActive() const {
        return state() == State::Active;
    }

    bool isRevoked() const {
        return state() == State::Revoked;
    }

    bool isInvalidated() const {
        return state() == State::Invalidated;
    }

    bool revoke() {
        State expected = State::Active;
        return m_state.compare_exchange_strong(
                expected,
                State::Revoked,
                std::memory_order_acq_rel,
                std::memory_order_acquire);
    }

    bool invalidate() {
        State previous = m_state.load(std::memory_order_acquire);
        while (previous != State::Invalidated) {
            if (m_state.compare_exchange_weak(
                        previous,
                        State::Invalidated,
                        std::memory_order_acq_rel,
                        std::memory_order_acquire)) {
                return true;
            }
        }
        return false;
    }

  private:
    const SessionIdentifier m_identifier;
    std::atomic<State> m_state{State::Active};
};

} // namespace mixxx::rekordbox
