import CraniumKit
import Foundation

/// Where a console page that has no native screen yet is shown: the console's own page in a web view,
/// as the iPhone app shows its web pages. The page signs in itself (nothing is kept on disk), and only
/// the console's own address loads in it; any other address opens in the browser. There is no Web
/// Serial here (WebKit has none), which is why board setup over serial is left out of the Mac app.
enum WebPageTarget {
    /// The configuration built into the app (the same file the iPhone app reads).
    static var loaded: CraniumConfig? { (try? CraniumConfig.load(from: .main))?.config }

    /// The console's address with a page's hash route, or nil when the address is not a web address.
    static func console(_ config: CraniumConfig?, route: String) -> URL? {
        guard let base = config?.consoleURL else { return nil }
        return page(base, route: route)
    }

    /// The customer site's address with a hash route: the customer API's own address, which the site
    /// is served on.
    static func customer(_ config: CraniumConfig?, route: String) -> URL? {
        guard let base = config?.customer?.apiURL else { return nil }
        return page(base, route: route)
    }

    static func page(_ base: URL, route: String) -> URL? {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host != nil, route.hasPrefix("#/") else { return nil }
        parts.path = parts.path.isEmpty ? "/" : parts.path
        parts.query = nil
        parts.fragment = String(route.dropFirst())
        return parts.url
    }

    /// Whether a link stays in the web view: the same host, over https.
    static func stays(_ url: URL, on home: URL) -> Bool {
        url.scheme == "https" && url.host?.lowercased() == home.host?.lowercased()
    }
}
