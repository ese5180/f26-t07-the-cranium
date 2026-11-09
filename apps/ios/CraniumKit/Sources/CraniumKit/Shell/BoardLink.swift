import Foundation

/// A board's QR code, as Scan board reads it (bridge.json `camera.scan`; docs/mobile-apps.md "Scan board").
/// The console prints `<console>/#/devices/<thing>` on a board's label (labels.js); the app opens that page
/// only when the link is exactly that, on the console of the app's own configuration. The website checks
/// a link by the same rules (labels.js readBoardLink), and so does the Android app (BoardLink.kt).
public enum BoardLink {
    public enum Refusal: Error, Equatable, Sendable {
        /// Not a link at all, or one too long to be a board's.
        case notALink
        /// A link to somewhere other than this console: another host, scheme or port, or with a user.
        case otherConsole
        /// This console, but not a board's page.
        case notABoard

        /// What the page is told, with not_allowed.
        public var message: String {
            switch self {
            case .notALink: return "That code is not a link to a board."
            case .otherConsole: return "That code is for another console, so the app did not open it."
            case .notABoard: return "That code is not a board’s page on this console."
            }
        }
    }

    /// The longest link a label holds: the console's origin and the longest thing name, with room to spare.
    public static let maxLength = 2048

    /// The console's origin as a label has it, or nil for one a label never has: https, or plain http on
    /// this computer, with no user and nothing past the origin.
    public static func origin(of console: URL) -> (scheme: String, host: String, port: Int)? {
        guard let parts = URLComponents(url: console, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, ["", "/"].contains(parts.percentEncodedPath),
              parts.query == nil, parts.fragment == nil else { return nil }
        guard scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return nil }
        return (scheme, host, parts.port ?? (scheme == "https" ? 443 : 80))
    }

    /// The board's thing name in a scanned code, or why the app does not open it.
    public static func thing(in text: String, console: URL) -> Result<String, Refusal> {
        guard text.utf8.count <= maxLength, let own = origin(of: console),
              let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty else { return .failure(.notALink) }
        let port = parts.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
        guard scheme == own.scheme, host == own.host, port == own.port, parts.user == nil, parts.password == nil else {
            return .failure(.otherConsole)
        }
        guard ["", "/"].contains(parts.percentEncodedPath), parts.query == nil,
              let fragment = parts.percentEncodedFragment else { return .failure(.notABoard) }
        let prefix = "/devices/"
        guard fragment.hasPrefix(prefix) else { return .failure(.notABoard) }
        let thing = String(fragment.dropFirst(prefix.count))
        guard isThing(thing) else { return .failure(.notABoard) }
        return .success(thing)
    }

    /// A thing name as AWS IoT takes it: 1 to 128 of A-Z a-z 0-9 _ : -.
    public static func isThing(_ text: String) -> Bool {
        (1...128).contains(text.utf8.count) && text.utf8.allSatisfy { byte in
            (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte) || (0x30...0x39).contains(byte)
                || byte == 0x5F || byte == 0x3A || byte == 0x2D
        }
    }
}
