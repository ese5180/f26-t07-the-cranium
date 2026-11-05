import Foundation

/// What the shell's web view may show and do (apps/shared/bridge.json, "origins", "policies" and
/// "navigation"; docs/mobile-apps.md "Security"). Pure, so that the tests go through every case.
public enum ShellPolicy {
    /// The scheme and host the bundle is served on: the page's origin is `cranium-app://bundle`.
    public static let scheme = "cranium-app"
    public static let host = "bundle"
    public static let origin = "\(scheme)://\(host)"

    /// bridge.json's `policies`, word for word; BridgeSpecTests compares them with the file.
    public static let templates: [String: String] = [
        "console": "default-src 'none'; script-src 'self' {self}; style-src 'self' {self}; img-src 'self' {self} data: https://tile.openstreetmap.org; connect-src 'self' {self} {console} {customer} {idp}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'",
        "customer": "default-src 'none'; script-src 'self' {self}; style-src 'self' {self}; img-src 'self' {self} data:; connect-src 'self' {self} {console} {customer} {idp}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    ]

    /// The schemes an address may have to be opened outside the app: the system browser, SideStore, an
    /// authenticator app.
    public static let outsideSchemes: Set<String> = ["https", "sidestore", "otpauth"]

    /// `scheme://host[:port]` of an address; nil without a host.
    public static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        if let port = url.port { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    /// The Content-Security-Policy of a page of the bundle, for its route's policy. Nil for a policy that
    /// is not one: such a page is not served.
    public static func contentSecurityPolicy(_ policy: String, config: CraniumConfig) -> String? {
        guard let template = templates[policy] else { return nil }
        let console = origin(of: config.consoleURL) ?? ""
        let customer = config.customer.flatMap { origin(of: $0.apiURL) }
        var idp: [String] = []
        for pool in [config.userPool, config.customer?.pool].compactMap({ $0 }) {
            let address = "https://cognito-idp.\(pool.region).amazonaws.com"
            if !idp.contains(address) { idp.append(address) }
        }
        let text = template
            .replacingOccurrences(of: "{self}", with: origin)
            .replacingOccurrences(of: "{console}", with: console)
            .replacingOccurrences(of: "{customer}", with: customer == console ? "" : customer ?? "")
            .replacingOccurrences(of: "{idp}", with: idp.joined(separator: " "))
        // A value left out leaves two spaces, and a directive must not end in one.
        return text.split(separator: ";").map { directive in
            directive.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        }.joined(separator: "; ")
    }

    /// Whether an address is of the bundle's origin.
    public static func isBundle(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host?.lowercased() == host && url.port == nil
            && url.user == nil && url.password == nil
    }

    /// Whether `app.open` and the web view may hand an address to the system.
    public static func mayOpenOutside(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), outsideSchemes.contains(scheme) else { return false }
        if scheme == "https" {
            guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return false }
        }
        return url.absoluteString.utf16.count <= 4096
    }

    public enum Navigation: Equatable, Sendable {
        /// In the web view.
        case allow
        /// Not in the web view; handed to the system.
        case openOutside(URL)
        /// Not at all.
        case drop
    }

    /// What becomes of a navigation: only the bundle's origin, in the main frame, stays in the web view.
    /// Anything else, or a new window, is cancelled, and goes to the system if `mayOpenOutside` allows it.
    /// A frame of another document (an iframe) is never loaded.
    ///
    /// - Parameters:
    ///   - mainFrame: the navigation is of the main frame; false for an iframe.
    ///   - newWindow: the page asked for a window of its own (`target="_blank"`, `window.open`).
    public static func navigation(to url: URL, mainFrame: Bool, newWindow: Bool) -> Navigation {
        if !newWindow, mainFrame, isBundle(url) { return .allow }
        if !mainFrame && !newWindow { return .drop }
        return mayOpenOutside(url) ? .openOutside(url) : .drop
    }

    /// Where the web view starts: the customer site, or the console when this build has no customer pool.
    public static func startURL(config: CraniumConfig) -> URL {
        URL(string: config.customer == nil ? "\(origin)/admin" : "\(origin)/")!
    }

    /// The request's path as it was sent, percent escapes and all: only ever a key.
    public static func requestPath(_ url: URL) -> String {
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        return path.isEmpty ? "/" : path
    }

    /// The headers of a file of the bundle: its type, no sniffing, and for a page its policy and no store.
    public static func headers(type: String, policy: String?, config: CraniumConfig) -> [String: String]? {
        var headers = [
            "Content-Type": type,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": policy == nil ? "public, max-age=31536000, immutable" : "no-store",
        ]
        if let policy {
            guard let csp = contentSecurityPolicy(policy, config: config) else { return nil }
            headers["Content-Security-Policy"] = csp
        }
        return headers
    }
}
