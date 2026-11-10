import Foundation

/// The board's status in offline mode, from firmware 1.19.0 (`firmware/app/src/policy/bt_offline_policy.h`):
/// what a phone reads of a board that has no Wi-Fi or no cloud, over Bluetooth directly. Unlike the status
/// characteristic of an update, it needs a link that paired with the board's own passkey (the phone asks
/// for the passkey when it first reads it), and the one write, `acceptRequest`, installs the update that
/// a phone has sent and that waits. See docs/mobile-apps.md, "Offline mode". The Android app's
/// core/OfflineStatus.kt is the same, case for case.
public struct OfflineStatus: Equatable, Sendable {
    public static let serviceUUID = "9112B1B6-2A51-40F0-94D3-A76440F0E6CC"
    public static let statusUUID = "9112B1B7-2A51-40F0-94D3-A76440F0E6CC"
    public static let controlUUID = "9112B1B8-2A51-40F0-94D3-A76440F0E6CC"
    public static let format: UInt8 = 1
    public static let length = 20

    public enum Wifi: UInt8, Sendable {
        case none = 0, down = 1, up = 2
        case unknown = 255
    }

    public enum Cloud: UInt8, Sendable {
        case none = 0, down = 1, up = 2
        case unknown = 255
    }

    public enum Update: UInt8, Sendable {
        case idle = 0
        /// A cloud update is on offer and waits for a button at the board.
        case cloudOffer = 1
        case cloudBusy = 2
        case trial = 3
        /// An update sent over Bluetooth has arrived and waits: this phone may accept it.
        case waiting = 4
        case receiving = 5
        case unknown = 255
    }

    public let wifi: Wifi
    public let cloud: Cloud
    public let update: Update
    /// The board's reset kind (`enum reset_kind`), or 255 when it is not known.
    public let rebootCode: Int
    public let running: String
    public let uptime: Int
    /// `major.minor` of the update that waits, while `update` is `.waiting`.
    public let waiting: String?

    /// Reads a payload. Nil when it is short, or of a format this app does not know.
    public static func parse(_ data: Data) -> OfflineStatus? {
        let b = [UInt8](data)
        guard b.count >= length, b[0] == format else { return nil }
        func u16(_ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
        let update = Update(rawValue: b[3]) ?? .unknown
        return OfflineStatus(
            wifi: Wifi(rawValue: b[1]) ?? .unknown,
            cloud: Cloud(rawValue: b[2]) ?? .unknown,
            update: update,
            rebootCode: Int(b[4]),
            running: "\(b[6]).\(b[7]).\(u16(8))+\(u32(10))",
            uptime: u32(14),
            waiting: update == .waiting ? "\(b[18]).\(b[19])" : nil)
    }

    /// The one write: accept the update that waits, naming the version the person was shown.
    /// The board refuses it if another version waits by now. Nil for a version that is not `major.minor`.
    public static func acceptRequest(version: String) -> Data? {
        let parts = version.split(separator: ".").prefix(2).compactMap { UInt8($0) }
        guard parts.count == 2 else { return nil }
        return Data([0x01, parts[0], parts[1]])
    }

    // MARK: In words

    public var wifiWord: String {
        switch wifi {
        case .none: return "No Wi-Fi on this board"
        case .down: return "Not connected"
        case .up: return "Connected"
        case .unknown: return "Unknown"
        }
    }

    public var cloudWord: String {
        switch cloud {
        case .none: return "No cloud on this board"
        case .down: return "Not connected"
        case .up: return "Connected"
        case .unknown: return "Unknown"
        }
    }

    public var updateWord: String {
        switch update {
        case .idle: return "No update"
        case .cloudOffer: return "An update from the cloud waits for a button at the board"
        case .cloudBusy: return "An update from the cloud is being installed"
        case .trial: return "A new version is on trial"
        case .waiting: return "Version \(waiting ?? "?") has arrived and waits for you"
        case .receiving: return "An update is arriving"
        case .unknown: return "Unknown"
        }
    }

    /// Why the board last restarted, by `enum reset_kind` (`reset_cause.h`).
    public var rebootWord: String {
        let names = ["Brown-out", "Power on", "Watchdog", "Debugger", "Security", "Wake from low power", "Lock-up",
                     "Parity", "Clock", "Hardware", "Reset by the user", "Temperature", "Software", "Reset pin"]
        return rebootCode >= 0 && rebootCode < names.count ? names[rebootCode] : "Not known"
    }

    /// Whether the person can accept an update at this moment.
    public var canAccept: Bool { update == .waiting && waiting != nil }

    public var uptimeWord: String {
        let d = uptime / 86_400, h = uptime % 86_400 / 3_600, m = uptime % 3_600 / 60
        if d > 0 { return "\(d) d \(h) h" }
        if h > 0 { return "\(h) h \(m) min" }
        return "\(m) min \(uptime % 60) s"
    }
}
