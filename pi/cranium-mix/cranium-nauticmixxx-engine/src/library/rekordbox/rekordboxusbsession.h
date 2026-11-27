#pragma once

#include <memory>
#include <mutex>

#include "library/rekordbox/rekordboxdevice.h"
#include "library/rekordbox/rekordboxruntimecatalog.h"
#include "library/rekordbox/rekordboxsessionstate.h"
#include "track/track_decl.h"

namespace mixxx::rekordbox {

enum class UsbSessionState { Missing, Unreadable, Parsing, Ready, Error, Invalidated };
enum class UsbSessionError {
    None, MissingDevice, UnreadableDevice, NotRekordbox,
    IncompleteExport, CorruptExport, ChangedDevice,
};

// One connection / one load attempt. No UI, mount polling, SQL, Track, or audio
// handles. A discovery owner supplies a volume root and calls refresh() or
// invalidate() on removal; reconnect always constructs a new session.
struct PerformanceEdit;

class RekordboxUsbSession final {
  public:
    explicit RekordboxUsbSession(const QString& root);
    ~RekordboxUsbSession();
    RekordboxUsbSession(const RekordboxUsbSession&) = delete;
    RekordboxUsbSession& operator=(const RekordboxUsbSession&) = delete;

    // Synchronous, potentially expensive: call off the UI/audio thread. Only a
    // fully built/sealed catalog is published. invalidate() may cancel a load.
    bool load();
    bool refresh();
    // Explicit USB write, off GUI/audio threads; returns an error or empty.
    QString writeList(const QString& name, const QList<quint32>& ids, bool history = false);
    QString writePerformance(const PerformanceEdit& edit);
    QString writeRating(quint32 trackId,int rating);
    // Explicit synchronous I/O, off UI/audio threads. nullopt is failure; an
    // engaged empty QByteArray is a valid zero-length payload. No cache or mutation
    // of the sealed catalog; returned bytes own their storage.
    std::optional<QByteArray> loadWaveformPayload(
            const RuntimeWaveform& descriptor, QString* error = nullptr);
    void invalidate();
    DeviceSnapshot deviceSnapshot() const;
    UsbSessionState state() const;
    UsbSessionError errorCode() const;
    QString error() const;
    std::shared_ptr<const RuntimeCatalog> catalog() const;
    // Available only while the session is Ready. Bindings keep a weak
    // reference to this token and fail closed immediately on invalidation.
    std::shared_ptr<const SessionState> sessionState() const;
    // Projects only a track from this session's sealed catalog. The result is
    // temporary, non-persistable, non-analyzable, and bound to this session.
    TrackPointer createTemporaryTrack(
            quint32 rekordboxId, QString* error = nullptr);
    // Optional future input, never parsed as main PDB or required in Phase 2.
    QString extendedDatabasePath() const;

  private:
    void invalidateLocked();
    mutable std::mutex m_mutex;
    QString m_root;
    const std::shared_ptr<SessionState> m_sessionState;
    const QString m_sessionId;
    DeviceSnapshot m_snapshot;
    std::shared_ptr<RuntimeCatalog> m_catalog;
    QString m_extendedDatabasePath;
    UsbSessionState m_state{UsbSessionState::Missing};
    UsbSessionError m_errorCode{UsbSessionError::None};
    QString m_error;
    bool m_attempted{false};
};

} // namespace mixxx::rekordbox
