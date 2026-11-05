import Foundation

/// The board's own account of an update over Bluetooth: its status characteristic, from firmware
/// 1.14.0 (`firmware/app/src/bt_status.h`). Any phone in range reads it with no pairing while the board
/// is connectable, and gets a notification each time it changes. It carries no secret. A board with older
/// firmware has no such characteristic, and the app follows it as it did before. See docs/mobile-apps.md,
/// "The status characteristic". The Android app's core/BoardStatus.kt is the same, case for case.
public struct BoardStatus: Equatable, Sendable {
    /// The service the board advertises after the restart that an update over Bluetooth asked for, and
    /// that it has in every window. Its one characteristic: read and notify.
    public static let serviceUUID = "9112B1B4-2A51-40F0-94D3-A76440F0E6CC"
    public static let characteristicUUID = "9112B1B5-2A51-40F0-94D3-A76440F0E6CC"
    /// The first byte. A payload of another format says nothing that this app can read.
    public static let format: UInt8 = 1
    public static let length = 64

    public enum Window: UInt8, Sendable {
        case closed = 0
        /// Advertising for an upload, or connected and not paired yet.
        case open = 1
        /// An authenticated link.
        case linked = 2
        /// An image has arrived and waits for a button: the seconds left are the offer's.
        case offer = 3
        /// After the restart: status only, for 2 minutes.
        case status = 4
        case unknown = 255
    }

    public enum Image: UInt8, Sendable {
        case none = 0, receiving = 1, received = 2, verified = 3, refused = 4
        case unknown = 255
    }

    public enum Refusal: UInt8, Sendable {
        case none = 0, older = 1, notImage0 = 2, noHeader = 3, tooLarge = 4, badSizes = 5
        case incompatibleBoard = 6, incompatibleLayout = 7, malformed = 8, swapPending = 9, cannotInstall = 10
        case unknown = 255
    }

    /// How the window ended.
    public enum Result: UInt8, Sendable {
        case none = 0
        /// Button 1: the board restarts into the bootloader to install it.
        case installing = 1
        /// Button 2.
        case discarded = 2
        /// Nobody pressed a button in the 2 minutes of the offer, or the window's time ran out.
        case timedOut = 3
        case closed = 4
        case unknown = 255
    }

    /// What the bootloader is to do at the next restart.
    public enum Swap: UInt8, Sendable {
        case none = 0, test = 1, permanent = 2, revert = 3, fail = 4
        case unknown = 255
    }

    public enum Via: UInt8, Sendable {
        case none = 0, bluetooth = 1, wifi = 2
        case unknown = 255
    }

    /// The last update's outcome, as the board recorded it.
    public enum Outcome: UInt8, Sendable {
        case none = 0, pending = 1, kept = 2, rolledBack = 3, notInstalled = 4, trialLost = 5, superseded = 6
        case flashError = 7, incompatibleBoard = 8, incompatibleLayout = 9, failed = 10
        case unknown = 255

        /// The record's own word for it, as the board's log line and the shadow say it.
        public var word: String {
            switch self {
            case .none: return "none"
            case .pending: return "pending"
            case .kept: return "succeeded"
            case .rolledBack: return "rolled_back"
            case .notInstalled: return "not_installed"
            case .trialLost: return "trial_lost"
            case .superseded: return "superseded"
            case .flashError: return "flash_error"
            case .incompatibleBoard: return "incompatible_board"
            case .incompatibleLayout: return "incompatible_layout"
            case .failed: return "failed"
            case .unknown: return "unknown"
            }
        }

        /// Over, one way or the other.
        public var isEnd: Bool { self != .none && self != .pending && self != .unknown }
    }

    public enum Proof: UInt8, Sendable {
        case none = 0, cloud = 1, person = 2
        case unknown = 255

        public var word: String {
            switch self {
            case .cloud: return "cloud"
            case .person: return "person"
            default: return "none"
            }
        }
    }

    public let window: Window
    /// Of the window, of the offer while one waits, or of the advertising after the restart.
    public let secondsLeft: Int
    public let image: Image
    public let refusal: Refusal
    /// So far while receiving, then the image's size.
    public let imageBytes: Int
    /// `1.14.1+0`, once the first piece has arrived.
    public let imageVersion: String?
    public let result: Result
    /// Why the window closed, as the firmware numbers it (`enum bt_ota_closed` + 1), 0 while it is open.
    public let closedReason: Int
    public let running: String
    public let onTrial: Bool
    public let swap: Swap
    public let lastVia: Via
    public let lastOutcome: Outcome
    public let lastProof: Proof
    public let lastTarget: String?
    public let lastFrom: String?
    /// The first 8 bytes of the image's own SHA-256, in lower-case hex: of an update over Bluetooth only.
    public let lastHash: String?
    /// Updates over Bluetooth on this board, the last one included.
    public let lastCount: Int
    public let uptime: Int

    /// Reads a payload. Nil when it is short, or of a format this app does not know.
    public static func parse(_ data: Data) -> BoardStatus? {
        let b = [UInt8](data)
        guard b.count >= length, b[0] == format else { return nil }
        func u16(_ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
        func u32(_ at: Int) -> Int { u16(at) | u16(at + 2) << 16 }
        func version(_ at: Int) -> String? {
            guard b[at..<(at + 8)].contains(where: { $0 != 0 }) else { return nil }
            return "\(b[at]).\(b[at + 1]).\(u16(at + 2))+\(u32(at + 4))"
        }
        let hash = b[48..<56]
        return BoardStatus(
            window: Window(rawValue: b[1]) ?? .unknown,
            secondsLeft: u16(2),
            image: Image(rawValue: b[4]) ?? .unknown,
            refusal: Refusal(rawValue: b[5]) ?? .unknown,
            imageBytes: u32(6),
            imageVersion: version(10),
            result: Result(rawValue: b[18]) ?? .unknown,
            closedReason: Int(b[19]),
            running: version(20) ?? "0.0.0+0",
            onTrial: b[28] & 1 != 0,
            swap: Swap(rawValue: (b[28] >> 1) & 7) ?? .unknown,
            lastVia: Via(rawValue: b[29]) ?? .unknown,
            lastOutcome: Outcome(rawValue: b[30]) ?? .unknown,
            lastProof: Proof(rawValue: b[31]) ?? .unknown,
            lastTarget: version(32),
            lastFrom: version(40),
            lastHash: hash.contains(where: { $0 != 0 }) ? hash.map { String(format: "%02x", $0) }.joined() : nil,
            lastCount: u16(56),
            uptime: u32(58))
    }

    /// The two say something different, beyond what counts by itself: the seconds left, the bytes and the uptime.
    public func isNews(after other: BoardStatus?) -> Bool {
        guard let other else { return true }
        return window != other.window || image != other.image || refusal != other.refusal
            || imageVersion != other.imageVersion || result != other.result || closedReason != other.closedReason
            || running != other.running || onTrial != other.onTrial || swap != other.swap || lastVia != other.lastVia
            || lastOutcome != other.lastOutcome || lastProof != other.lastProof || lastTarget != other.lastTarget
            || lastFrom != other.lastFrom || lastHash != other.lastHash || lastCount != other.lastCount
    }

    /// Why the board refused an image, in words.
    public static func words(_ refusal: Refusal) -> String {
        switch refusal {
        case .older: return "It is not newer than what the board runs."
        case .notImage0: return "It is not for image 0."
        case .noHeader: return "It does not start with an image header."
        case .tooLarge: return "It would reach the end of the board's slot."
        case .badSizes: return "Its header claims more than the file holds."
        case .incompatibleBoard: return "It is for another kind of board."
        case .incompatibleLayout: return "It is for another flash layout."
        case .malformed: return "Its signed metadata is malformed, or it could not be read back."
        case .swapPending: return "The bootloader has a swap to do already."
        case .cannotInstall: return "The board could not record it or ask for the swap."
        case .none, .unknown: return "The board did not say why."
        }
    }
}
