#pragma once

namespace mixxx {

// Immutable capability profile. Availability of an external source is a
// separate concern represented by SourceBinding/SessionState.
class TrackUsePolicy final {
  public:
    static constexpr TrackUsePolicy rekordboxUsbPolicy() {
        return TrackUsePolicy(false, false, false, false, true);
    }

    static constexpr TrackUsePolicy usbFolderPolicy() {
        return TrackUsePolicy(false, false, true, false, true);
    }

    static constexpr TrackUsePolicy standardLibraryPolicy() {
        return TrackUsePolicy(true, true, true, true, true);
    }

    constexpr bool canPersist() const {
        return m_canPersist;
    }

    constexpr bool canImport() const {
        return m_canImport;
    }

    constexpr bool canAnalyze() const {
        return m_canAnalyze;
    }

    constexpr bool canExportMetadata() const {
        return m_canExportMetadata;
    }

    constexpr bool canLoadForPlayback() const {
        return m_canLoadForPlayback;
    }

    constexpr bool operator==(const TrackUsePolicy&) const = default;

  private:
    constexpr TrackUsePolicy(
            bool canPersist,
            bool canImport,
            bool canAnalyze,
            bool canExportMetadata,
            bool canLoadForPlayback)
            : m_canPersist(canPersist),
              m_canImport(canImport),
              m_canAnalyze(canAnalyze),
              m_canExportMetadata(canExportMetadata),
              m_canLoadForPlayback(canLoadForPlayback) {
    }

    const bool m_canPersist;
    const bool m_canImport;
    const bool m_canAnalyze;
    const bool m_canExportMetadata;
    const bool m_canLoadForPlayback;
};

} // namespace mixxx
