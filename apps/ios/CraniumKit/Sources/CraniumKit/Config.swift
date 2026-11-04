import Foundation

/// The values the app needs from the deployed stack. See docs/mobile-apps.md, "Configuration".
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
    /// The user pool, for the app's own sign-in screen (`PasswordSignIn`). Nil for a
    /// `cranium.json` written before it had `userPoolId` and `region`: then the app signs in on
    /// the AWS sign-in page only.
    public let userPool: CognitoUserPool?

    /// The only redirect URI the mobile app client allows.
    public static let expectedRedirectURI = "cranium://signin"

    /// The scheme `ASWebAuthenticationSession` waits for: `cranium`.
    public var callbackScheme: String { "cranium" }

    public init(consoleURL: URL, loginDomain: URL, mobileClientId: String,
                redirectURI: String = CraniumConfig.expectedRedirectURI, userPool: CognitoUserPool? = nil) {
        self.consoleURL = consoleURL
        self.loginDomain = loginDomain
        self.mobileClientId = mobileClientId
        self.redirectURI = redirectURI
        self.userPool = userPool
    }
}

/// A Cognito user pool: its ID and its Region, from `userPoolId` and `region` in the configuration.
public struct CognitoUserPool: Equatable, Sendable {
    /// For example `us-east-1_AbCdEf123`: the Region, an underscore, and letters and digits.
    public let id: String
    /// For example `us-east-1`. Always the part of the ID before the underscore.
    public let region: String

    /// Nil unless the two are well formed and agree.
    public init?(id: String, region: String) {
        guard Self.isRegion(region), id.hasPrefix(region + "_") else { return nil }
        let name = id.dropFirst(region.count + 1)
        guard (1...64).contains(name.count), name.unicodeScalars.allSatisfy(Self.isLetterOrDigit) else { return nil }
        self.id = id
        self.region = region
    }

    /// `https://cognito-idp.{region}.amazonaws.com/`: Cognito's user pool API, one address for
    /// every operation, which goes in a header.
    public var endpoint: URL {
        // The Region is checked above, so this cannot fail.
        URL(string: "https://cognito-idp.\(region).amazonaws.com/")!
    }

    static let contentType = "application/x-amz-json-1.1"
    static let targetPrefix = "AWSCognitoIdentityProviderService."

    /// /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/, as the website checks the Region in a pool ID.
    static func isRegion(_ text: String) -> Bool {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count >= 3, let first = parts.first, let last = parts.last else { return false }
        let lower = { (part: Substring) in !part.isEmpty && part.unicodeScalars.allSatisfy { ("a"..."z").contains($0) } }
        return first.count == 2 && lower(first) && parts.dropFirst().dropLast().allSatisfy(lower)
            && (1...2).contains(last.count) && last.unicodeScalars.allSatisfy { ("0"..."9").contains($0) }
    }

    private static func isLetterOrDigit(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
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
        let userPoolId: String?
        let region: String?
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
                             redirectURI: raw.redirectUri, userPool: try userPool(id: raw.userPoolId, region: raw.region))
    }

    /// Both or neither. A value that is there but wrong is an error, as for the other keys: falling
    /// back to the AWS sign-in page would hide it.
    private static func userPool(id: String?, region: String?) throws -> CognitoUserPool? {
        switch (id, region) {
        case (nil, nil):
            return nil
        case (nil, _):
            throw ConfigError.invalid(key: "userPoolId", reason: "is missing, though region is there")
        case (_, nil):
            throw ConfigError.invalid(key: "region", reason: "is missing, though userPoolId is there")
        case (let id?, let region?):
            guard CognitoUserPool.isRegion(region) else {
                throw ConfigError.invalid(key: "region", reason: "is not an AWS Region")
            }
            guard let pool = CognitoUserPool(id: id, region: region) else {
                throw ConfigError.invalid(key: "userPoolId", reason: "is not a user pool ID in that Region")
            }
            return pool
        }
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
