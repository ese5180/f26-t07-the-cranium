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
        "console": "default-src 'none'; script-src 'self' {self}; style-src 'self' {self}; img-src 'self' {self} data: https://tile.openstreetmap.org; connect-src 'self' {self} {console} {customer} {idp} {live}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'",
        "customer": "default-src 'none'; script-src 'self' {self}; style-src 'self' {self}; img-src 'self' {self} data:; connect-src 'self' {self} {console} {customer} {idp} {live}; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
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
            // The live API (docs/live.md), from the app's own configuration only: wss://<id>.execute-api....
            .replacingOccurrences(of: "{live}", with: config.liveURL.flatMap(origin(of:)) ?? "")
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

    /// Whether `app.open` and the web view may hand an address to the system. A `sidestore:` address only in the
    /// forms `isSideStoreLink` takes, for this console (`console`, the app's `consoleURL`); without it, none.
    public static func mayOpenOutside(_ url: URL, console: URL? = nil) -> Bool {
        guard let scheme = url.scheme?.lowercased(), outsideSchemes.contains(scheme) else { return false }
        guard url.absoluteString.utf16.count <= 4096 else { return false }
        switch scheme {
        case "https":
            guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return false }
        case "sidestore":
            return console.map { isSideStoreLink(url, console: $0) } ?? false
        default:
            break
        }
        return true
    }

    // MARK: SideStore

    /// A member's source on this console: `<console>/api/sidestore/crs_<key>/source.json` (cloud lib/sidestore.mjs).
    static let sourcePath = #"^/api/sidestore/crs_[A-Za-z0-9_-]{43}/source\.json$"#
    /// An IPA through a member's source on this console, which answers with a presigned S3 link.
    static let sourceIPAPath = #"^/api/sidestore/crs_[A-Za-z0-9_-]{43}/cranium-ios-\d{1,3}\.\d{1,3}\.\d{1,5}\.ipa$"#
    /// The console's presigned S3 GET of an IPA (`GET /api/apps/ios/<version>/download`): the bucket's own host,
    /// `<bucket>.s3.<region>.amazonaws.com` (cloud aws-apps.mjs), the object `apps/ios/cranium-ios-<version>.ipa`.
    static let s3Host = #"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.[a-z]{2}(-[a-z]+)+-\d{1,2}\.amazonaws\.com$"#
    static let s3IPAPath = #"^/apps/ios/cranium-ios-\d{1,3}\.\d{1,3}\.\d{1,5}\.ipa$"#

    /// The two SideStore addresses the app hands over, and nothing else of SideStore's (its `pairing` and
    /// `certificate` hosts export a pairing file or a signing certificate, so they are never opened from here):
    ///
    /// - `sidestore://source?url=<console>/api/sidestore/crs_<key>/source.json`: add a member's source (the Apps page);
    /// - `sidestore://install?url=<IPA link>`: install that IPA (the app's own update, `AppUpdate`), the link one that
    ///   `isIPALink` takes.
    ///
    /// Exactly one query item, `url`; no path, port, user or fragment.
    public static func isSideStoreLink(_ url: URL, console: URL) -> Bool {
        guard url.scheme?.lowercased() == "sidestore", url.user == nil, url.password == nil, url.port == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.path.isEmpty, components.fragment == nil,
              let items = components.queryItems, items.count == 1, items[0].name == "url",
              let value = items[0].value, let inner = URL(string: value) else { return false }
        switch components.host?.lowercased() {
        case "source":
            return isConsole(inner, console: console) && matches(inner.path, sourcePath) && inner.query == nil
        case "install":
            return isIPALink(inner, console: console)
        default:
            return false
        }
    }

    /// An IPA link SideStore may be handed: the console's presigned S3 GET of an iPhone build (https, the bucket's
    /// host, the object's path, signed), or an IPA through a member's source on this console.
    public static func isIPALink(_ url: URL, console: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil, url.fragment == nil,
              let host = url.host?.lowercased(), url.absoluteString.utf16.count <= 4096 else { return false }
        if isConsole(url, console: console) { return matches(url.path, sourceIPAPath) && url.query == nil }
        guard matches(host, s3Host), url.port == nil, matches(url.path, s3IPAPath),
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return false }
        return items.contains { $0.name == "X-Amz-Signature" && !($0.value ?? "").isEmpty }
    }

    /// Whether `url` is https on the console's own origin, with no user or fragment.
    static func isConsole(_ url: URL, console: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.user == nil && url.password == nil && url.fragment == nil
            && origin(of: url) != nil && origin(of: url) == origin(of: console)
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    public enum Navigation: Equatable, Sendable {
        /// In the web view.
        case allow
        /// Not in the web view; handed to the system.
        case openOutside(URL)
        /// Not at all.
        case drop
    }

    /// The console's pages that are not in this app (apps/shared/pages.json `excluded.ios`): the Serial console and
    /// Board setup need a board's USB serial port, which iOS gives no app. The web UI leaves them out too.
    public static let excludedSections: Set<String> = ["serial", "setup"]

    /// Whether an address of the bundle is one of `excludedSections`, as `#/serial` or `#/setup/...`.
    public static func isExcludedPage(_ url: URL) -> Bool {
        guard let fragment = url.fragment, fragment.hasPrefix("/") else { return false }
        let section = fragment.dropFirst().split(separator: "/", omittingEmptySubsequences: false).first ?? ""
        return excludedSections.contains(section.split(separator: "?").first.map(String.init) ?? "")
    }

    /// What becomes of a navigation: only the bundle's origin, in the main frame, stays in the web view.
    /// A page of `excludedSections` is dropped. Anything else, or a new window, is cancelled, and goes to the system
    /// if `mayOpenOutside` allows it.
    /// A frame of another document (an iframe) is never loaded.
    ///
    /// - Parameters:
    ///   - mainFrame: the navigation is of the main frame; false for an iframe.
    ///   - newWindow: the page asked for a window of its own (`target="_blank"`, `window.open`).
    ///   - console: the app's `consoleURL`, for the SideStore addresses `mayOpenOutside` takes.
    public static func navigation(to url: URL, mainFrame: Bool, newWindow: Bool, console: URL? = nil) -> Navigation {
        if !newWindow, mainFrame, isBundle(url) { return isExcludedPage(url) ? .drop : .allow }
        if !mainFrame && !newWindow { return .drop }
        return mayOpenOutside(url, console: console) ? .openOutside(url) : .drop
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
