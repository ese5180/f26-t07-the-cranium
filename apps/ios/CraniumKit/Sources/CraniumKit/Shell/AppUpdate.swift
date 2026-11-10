import Foundation

/// The iPhone app's own update, from the phone (docs/mobile-apps.md, "Updating the iPhone app"). The shell asks the
/// console's `GET /api/apps` for the iPhone builds published there, and when one is newer than the app that runs, it
/// offers two ways to it: SideStore, in one tap, and the Mac.
///
/// The tap asks the console for a download link of that build (`GET /api/apps/ios/<version>/download?via=app`, a
/// presigned S3 link good for 15 minutes, on record as `app.ios_download` with `via: app`), and hands it to SideStore as
/// `sidestore://install?url=<link>`: SideStore downloads the IPA, signs it with the person's own Apple ID, and installs
/// it over the app, keeping what the app stored. That is the form SideStore's own URL handler takes for an IPA at an
/// address (SideStore/DeepLinks/URLHandler.swift, hosts `install` and `source`, each with a `url` query item). The
/// console's token goes only to the console; SideStore gets the presigned link and nothing else. Pure, for the tests.
public enum AppUpdate {
    /// An iPhone build on the console, as `GET /api/apps` lists it under `ios.releases`.
    public struct Release: Equatable, Sendable {
        public let version: String
        public let build: String
        public let size: Int
        public let sha256: String
        public let notes: String

        public init(version: String, build: String, size: Int, sha256: String, notes: String = "") {
            self.version = version
            self.build = build
            self.size = size
            self.sha256 = sha256
            self.notes = notes
        }
    }

    /// `major.minor.patch`, compared part by part, as the console compares app versions (lib/apps.mjs).
    public struct Version: Comparable, Hashable, Sendable, CustomStringConvertible {
        public let parts: [Int]

        public init?(_ text: String) {
            let pieces = text.split(separator: ".", omittingEmptySubsequences: false)
            guard pieces.count == 3 else { return nil }
            var parts: [Int] = []
            for piece in pieces {
                guard !piece.isEmpty, piece.count <= 5, piece.allSatisfy({ $0.isASCII && $0.isNumber }),
                      piece == "0" || !piece.hasPrefix("0"), let value = Int(piece) else { return nil }
                parts.append(value)
            }
            self.parts = parts
        }

        public static func < (a: Version, b: Version) -> Bool { a.parts.lexicographicallyPrecedes(b.parts) }
        public var description: String { parts.map(String.init).joined(separator: ".") }
    }

    /// Whether `release` is newer than the app that runs (`CFBundleShortVersionString`, `CFBundleVersion`): a higher
    /// version, or the same version with a higher build. An app whose own version cannot be read is offered nothing.
    public static func isNewer(_ release: Release, thanVersion running: String, build runningBuild: String) -> Bool {
        guard let offered = Version(release.version), let current = Version(running) else { return false }
        if offered != current { return current < offered }
        guard let build = Int(release.build), let currentBuild = Int(runningBuild) else { return false }
        return currentBuild < build
    }

    /// The newest iPhone build in a `GET /api/apps` answer, by version and then build; nil when there is none.
    public static func newest(fromApps data: Data) -> Release? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ios = root["ios"] as? [String: Any], let releases = ios["releases"] as? [[String: Any]] else { return nil }
        let read = releases.compactMap { item -> Release? in
            guard let version = item["version"] as? String, Version(version) != nil,
                  let build = item["buildVersion"] as? String, Int(build) != nil,
                  let size = item["size"] as? Int, size > 0,
                  let sha = item["sha256"] as? String, isSHA256(sha) else { return nil }
            return Release(version: version, build: build, size: size, sha256: sha, notes: (item["notes"] as? String) ?? "")
        }
        return read.max { a, b in
            let (va, vb) = (Version(a.version)!, Version(b.version)!)
            return va == vb ? Int(a.build)! < Int(b.build)! : va < vb
        }
    }

    /// The offer for the app that runs, or nil when the console has nothing newer.
    public static func offer(fromApps data: Data, runningVersion: String, build: String) -> Release? {
        guard let newest = newest(fromApps: data), isNewer(newest, thanVersion: runningVersion, build: build) else { return nil }
        return newest
    }

    /// The console's list of apps.
    public static func appsURL(console: URL) -> URL {
        console.appendingPathComponent("api/apps")
    }

    /// The console's download link for one build, asked for by the app itself.
    public static func downloadURL(console: URL, version: String) -> URL? {
        guard Version(version) != nil else { return nil }
        var components = URLComponents(url: console.appendingPathComponent("api/apps/ios/\(version)/download"),
                                       resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "via", value: "app")]
        return components?.url
    }

    /// The console's Apps page, where SideStore and the Mac's way are explained.
    public static func appsPage(console: URL) -> URL {
        URL(string: "\(console.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/#/apps")!
    }

    /// The presigned link in a `GET /api/apps/ios/<version>/download` answer, if it is the build that was offered (the
    /// same version, size and SHA-256) and a link SideStore may be handed (`ShellPolicy.isIPALink`).
    public static func link(fromDownload data: Data, for release: Release, console: URL) -> URL? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let download = root["download"] as? [String: Any],
              download["version"] as? String == release.version,
              download["size"] as? Int == release.size,
              (download["sha256"] as? String)?.lowercased() == release.sha256.lowercased(),
              let text = download["url"] as? String, let url = URL(string: text),
              ShellPolicy.isIPALink(url, console: console) else { return nil }
        return url
    }

    /// The characters a query value keeps as they are: RFC 3986's unreserved ones. Everything else of the IPA's
    /// link, its `&`, `=`, `%` and `/` too, is percent-encoded, so that SideStore reads back the very same link.
    private static let unreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// `sidestore://install?url=<link>`: SideStore downloads and installs the IPA at that link.
    public static func installLink(ipa: URL) -> URL? {
        guard let value = ipa.absoluteString.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
        return URL(string: "sidestore://install?url=\(value)")
    }

    static func isSHA256(_ text: String) -> Bool {
        text.utf8.count == 64 && text.allSatisfy { $0.isHexDigit && $0.isASCII }
    }

    /// The words of the offer, the same on the banner and in the sheet.
    public enum Words {
        public static func banner(_ release: Release, running: String) -> String {
            "Cranium \(release.version) is ready (this iPhone has \(running))."
        }

        public static let sideStoreTitle = "Install with SideStore"
        public static let sideStoreDetail =
            "One tap, on this iPhone, with no Mac and no cable. Needs SideStore on this iPhone: it downloads the new " +
            "version, signs it with your Apple ID and installs it over this one. What the app keeps stays."
        public static let noSideStore =
            "SideStore is not on this iPhone, so nothing opened the update. SideStore is a free app that installs and " +
            "renews apps with your own Apple ID; it needs a computer once, to install it. The console's Apps page " +
            "(under iPhone) has its guide and your own SideStore link. Or update from the Mac, below."
        public static let macTitle = "Install from the Mac"
        public static let macDetail = "No SideStore needed. On the Mac that installed the app:"
        public static let macSteps = [
            "Connect the iPhone to the Mac with its cable, or keep it on the Mac's Wi-Fi, unlocked.",
            "In Terminal, in the repository, run apps/ios/scripts/renew.sh. It builds the newest app from main and installs it; what the app keeps stays.",
            "Or open the console's Apps page on the Mac and follow the iPhone steps there.",
        ]
    }
}
