import Foundation

/// Which releases the app offers.
public enum ReleaseOffer {
    /// Before the board is known: the active releases whose version reads, newest first.
    public static func active(_ releases: [FirmwareRelease]) -> [FirmwareRelease] {
        releases
            .compactMap { release in release.isActive ? release.parsedVersion.map { (release, $0) } : nil }
            .sorted { $0.1 > $1.1 }
            .map(\.0)
    }

    /// The default choice: the newest active release.
    public static func newest(_ releases: [FirmwareRelease]) -> FirmwareRelease? {
        active(releases).first
    }

    /// Once the board has said what runs in slot 0: only the active releases strictly newer than
    /// that, newest first. The board refuses anything else at the start of an upload.
    public static func newer(than running: FirmwareVersion, in releases: [FirmwareRelease]) -> [FirmwareRelease] {
        active(releases).filter { ($0.parsedVersion ?? running) > running }
    }

    /// What to preselect once the board is known: the person's earlier choice if it is still on
    /// offer, else the newest on offer.
    public static func choice(keeping preferred: String?, in offered: [FirmwareRelease]) -> FirmwareRelease? {
        offered.first { $0.version == preferred } ?? offered.first
    }
}
