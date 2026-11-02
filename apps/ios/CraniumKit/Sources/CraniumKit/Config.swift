import Foundation

/// The four values the app needs from the deployed stack. See docs/mobile-apps.md, "Configuration".
///
/// They name the AWS account, so they are not in git: `apps/configure.sh` writes them to
/// `apps/config/cranium.json`, and the build copies that file into the app. Nothing here prints
/// them, and no error message repeats them.
public struct CraniumConfig: Equatable, Sendable {
    /// The console, for example `https://console.example.com`, with no trailing slash.
    public let consoleURL: URL
    /// Cognito's managed login, for example `https://login.example.com`, with no trailing slash.
    public let loginDomain: URL
    /// The mobile app client: public, no secret, code flow with PKCE only.
    public let mobileClientId: String
    /// `cranium://signin`, the client's only redirect URI.
    public let redirectURI: String

    /// The only redirect URI the mobile app client allows.
    public static let expectedRedirectURI = "cranium://signin"

    /// The scheme `ASWebAuthenticationSession` waits for: `cranium`.
    public var callbackScheme: String { "cranium" }

    public init(consoleURL: URL, loginDomain: URL, mobileClientId: String,
                redirectURI: String = CraniumConfig.expectedRedirectURI) {
        self.consoleURL = consoleURL
        self.loginDomain = loginDomain
        self.mobileClientId = mobileClientId
        self.redirectURI = redirectURI
    }
}

/// Where the configuration in the app came from.
public enum ConfigSource: Equatable, Sendable {
    /// `cranium.json`, written by `apps/configure.sh` from the deployed stack.
    case deployed
    /// `cranium.example.json`: made-up values, for building without a stack. Sign-in cannot work.
    case example
}

public struct LoadedConfig: Equatable, Sendable {
    public let config: CraniumConfig
    public let source: ConfigSource

    public init(config: CraniumConfig, source: ConfigSource) {
        self.config = config
        self.source = source
    }
}

public enum ConfigError: Error, Equatable, LocalizedError {
    /// Neither `cranium.json` nor `cranium.example.json` is in the app.
    case missing
    /// The file is not a JSON object with the four values.
    case unreadable(file: String)
    /// A value is there but not usable. Says which, never what it is.
    case invalid(key: String, reason: String)

    public var errorDescription: String? {
        switch self {
        case .missing:
            return "The app has no configuration. Run apps/configure.sh, then build it again."
        case .unreadable(let file):
            return "\(file) is not a configuration: it needs consoleUrl, loginDomain, mobileClientId and redirectUri."
        case .invalid(let key, let reason):
            return "The configuration's \(key) \(reason). Run apps/configure.sh, then build it again."
        }
    }
}

extension CraniumConfig {
    public static let deployedFileName = "cranium.json"
    public static let exampleFileName = "cranium.example.json"

    /// Reads `cranium.json` from the app bundle, else `cranium.example.json`, which the build
    /// copies in only when there is no `cranium.json` (and only in a Debug build).
    public static func load(from bundle: Bundle) throws -> LoadedConfig {
        try load(deployed: bundle.url(forResource: "cranium", withExtension: "json"),
                 example: bundle.url(forResource: "cranium.example", withExtension: "json"))
    }

    /// The deployed file wins whenever it is there. A broken deployed file is an error, not a
    /// reason to fall back: that would hide the problem behind values that cannot sign in.
    public static func load(deployed: URL?, example: URL?) throws -> LoadedConfig {
        if let deployed, FileManager.default.fileExists(atPath: deployed.path) {
            let data = try readFile(deployed, name: deployedFileName)
            return LoadedConfig(config: try parse(data, file: deployedFileName), source: .deployed)
        }
        if let example, FileManager.default.fileExists(atPath: example.path) {
            let data = try readFile(example, name: exampleFileName)
            return LoadedConfig(config: try parse(data, file: exampleFileName), source: .example)
        }
        throw ConfigError.missing
    }

    private static func readFile(_ url: URL, name: String) throws -> Data {
        do {
            return try Data(contentsOf: url)
        } catch {
            throw ConfigError.unreadable(file: name)
        }
    }

    private struct File: Decodable {
        let consoleUrl: String
        let loginDomain: String
        let mobileClientId: String
        let redirectUri: String
    }

    /// Parses and checks the JSON that `apps/configure.sh` writes.
    public static func parse(_ data: Data, file: String = deployedFileName) throws -> CraniumConfig {
        let raw: File
        do {
            raw = try JSONDecoder().decode(File.self, from: data)
        } catch {
            throw ConfigError.unreadable(file: file)
        }
        let console = try httpsBase(raw.consoleUrl, key: "consoleUrl")
        let login = try httpsBase(raw.loginDomain, key: "loginDomain")
        let clientId = raw.mobileClientId
        guard !clientId.isEmpty, clientId.count <= 128,
              clientId.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII }) else {
            throw ConfigError.invalid(key: "mobileClientId", reason: "is not a Cognito app client ID")
        }
        guard raw.redirectUri == expectedRedirectURI else {
            throw ConfigError.invalid(key: "redirectUri", reason: "is not \(expectedRedirectURI), the only one the app client allows")
        }
        return CraniumConfig(consoleURL: console, loginDomain: login, mobileClientId: clientId,
                             redirectURI: raw.redirectUri)
    }

    /// An https URL with a host and nothing after it but slashes, which are dropped.
    private static func httpsBase(_ text: String, key: String) throws -> URL {
        var trimmed = text
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.path.isEmpty, components.query == nil, components.fragment == nil,
              components.user == nil, components.password == nil,
              let url = components.url else {
            throw ConfigError.invalid(key: key, reason: "is not an https address with nothing after the host")
        }
        return url
    }
}
