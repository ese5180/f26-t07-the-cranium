#pragma once

#include <QtGlobal>

#include <memory>
#include <utility>

#include "library/rekordbox/rekordboxsessionstate.h"

namespace mixxx {

enum class SourceType : quint8 {
    Unknown,
    StandardLibrary,
    RekordboxUsb,
};

// Lightweight provenance value. The weak reference intentionally does not keep
// a disconnected USB session alive. A missing, expired, mismatched, revoked, or
// invalidated session always fails closed for Rekordbox USB bindings.
class SourceBinding final {
  public:
    static SourceBinding standardLibrary() {
        return SourceBinding(SourceType::StandardLibrary,
                0,
                {},
                {});
    }

    static SourceBinding rekordboxUsb(
            quint32 rekordboxId,
            const std::shared_ptr<const rekordbox::SessionState>& sessionState) {
        return SourceBinding(SourceType::RekordboxUsb,
                rekordboxId,
                sessionState ? sessionState->identifier()
                             : rekordbox::SessionIdentifier{},
                sessionState);
    }

    SourceBinding() = default;

    SourceType sourceType() const {
        return m_sourceType;
    }

    quint32 rekordboxId() const {
        return m_rekordboxId;
    }

    const rekordbox::SessionIdentifier& sessionIdentifier() const {
        return m_sessionIdentifier;
    }

    bool isValid() const {
        switch (m_sourceType) {
        case SourceType::StandardLibrary:
            return true;
        case SourceType::RekordboxUsb:
            return m_rekordboxId != 0 && m_sessionIdentifier.isValid();
        case SourceType::Unknown:
            return false;
        }
        return false;
    }

    std::shared_ptr<const rekordbox::SessionState> sessionState() const {
        const auto state=m_sessionState.lock();
        return state && state->identifier()==m_sessionIdentifier?state:nullptr;
    }

    bool isSessionLive() const {
        if (m_sourceType != SourceType::RekordboxUsb || !isValid()) {
            return false;
        }
        const auto sessionState = m_sessionState.lock();
        return sessionState &&
                sessionState->identifier() == m_sessionIdentifier &&
                sessionState->isActive();
    }

  private:
    SourceBinding(
            SourceType sourceType,
            quint32 rekordboxId,
            rekordbox::SessionIdentifier sessionIdentifier,
            std::weak_ptr<const rekordbox::SessionState> sessionState)
            : m_sourceType(sourceType),
              m_rekordboxId(rekordboxId),
              m_sessionIdentifier(std::move(sessionIdentifier)),
              m_sessionState(std::move(sessionState)) {
    }

    SourceType m_sourceType{SourceType::Unknown};
    quint32 m_rekordboxId{0};
    rekordbox::SessionIdentifier m_sessionIdentifier;
    std::weak_ptr<const rekordbox::SessionState> m_sessionState;
};

} // namespace mixxx
