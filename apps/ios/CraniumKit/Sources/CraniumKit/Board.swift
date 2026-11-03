import Foundation

/// The board's side of Bluetooth, from docs/mobile-apps.md, "Bluetooth".
public enum SMP {
    /// In the board's advertising data: scan for this.
    public static let serviceUUID = "8D53DC1D-1DB7-4CD3-868B-8A527460AA84"
    /// Write without response, and notify. Needs an authenticated (passkey) link.
    public static let characteristicUUID = "DA2E7828-FBCE-4E01-AE9E-261174997C48"
}

public enum BoardName {
    /// `Cranium-` and four upper-case hex digits, drawn anew for each window.
    public static func isValid(_ name: String) -> Bool {
        let prefix = "Cranium-"
        guard name.hasPrefix(prefix) else { return false }
        let digits = name.dropFirst(prefix.count)
        return digits.count == 4 && digits.unicodeScalars.allSatisfy {
            ("0"..."9").contains($0) || ("A"..."F").contains($0)
        }
    }

    /// A board's name in the console, its AWS IoT thing: `cranium-` and 16 lower-case hex digits.
    public static func isThing(_ thing: String) -> Bool {
        let prefix = "cranium-"
        guard thing.hasPrefix(prefix) else { return false }
        let digits = thing.dropFirst(prefix.count)
        return digits.count == 16 && digits.unicodeScalars.allSatisfy {
            ("0"..."9").contains($0) || ("a"..."f").contains($0)
        }
    }
}

/// One slot of `image list`.
public struct ImageSlot: Equatable, Sendable {
    public let image: Int
    public let slot: Int
    /// As the board writes it: `1.8.0`, or `1.8.0.5` when the build number is not 0.
    public let version: String?
    public let active: Bool
    public let confirmed: Bool
    public let pending: Bool
    public let permanent: Bool

    public init(image: Int, slot: Int, version: String?, active: Bool = false, confirmed: Bool = false,
                pending: Bool = false, permanent: Bool = false) {
        self.image = image
        self.slot = slot
        self.version = version
        self.active = active
        self.confirmed = confirmed
        self.pending = pending
        self.permanent = permanent
    }
}

public struct UploadProgress: Equatable, Sendable {
    public let sent: Int
    public let total: Int

    public init(sent: Int, total: Int) {
        self.sent = sent
        self.total = total
    }

    public var fraction: Double { total > 0 ? min(1, Double(sent) / Double(total)) : 0 }
}

/// What can go wrong at the board. A transport turns its own errors into these.
public enum BoardError: Error, Equatable, LocalizedError {
    /// Bluetooth is off, or the app may not use it. Says which.
    case bluetoothUnavailable(String)
    /// The board was not there to connect to: its window is not open, or has closed.
    case notFound
    /// The link was not authenticated: a wrong passkey, a cancelled prompt, or too slow.
    case pairingFailed
    /// The board refused a command it should allow, for example because its window has closed.
    case refused
    /// The board refused the upload at its start: not newer than what runs, or one has already
    /// arrived in this window.
    case uploadRefused
    /// The link dropped while an upload was under way.
    case disconnectedDuringUpload
    /// The link dropped.
    case disconnected
    /// The board did not answer in time.
    case timedOut
    /// The board's image list has no slot 0 for image 0.
    case noRunningVersion
    /// Anything else, with the library's own words.
    case failed(String)

    public var errorDescription: String? { UserMessage.text(for: self) }
}

/// The board, over whatever carries SMP. The only commands are the two the board allows: image
/// list and image upload. There is deliberately no test, confirm, erase or reset here: the
/// board refuses them, and an error on one would look like a failed update when nothing failed.
public protocol BoardTransport: AnyObject, Sendable {
    /// The advertised name, `Cranium-XXXX`.
    var name: String { get }
    /// Connects and pairs. The phone's own prompt asks for the passkey while this runs.
    func connect() async throws
    /// `image list`.
    func readImageState() async throws -> [ImageSlot]
    /// `image upload` of image 0, to the secondary slot, and nothing after it.
    func upload(_ image: VerifiedImage, progress: @escaping @Sendable (UploadProgress) -> Void) async throws
    func disconnect() async
}
