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
    /// The customer side (docs/mobile-apps.md, "Customers"): the customer pool, the phone apps'
    /// client of it and the customer API. Nil for a `cranium.json` written before the stack had
    /// them: then the app signs in admins only, and says so.
    public let customer: CustomerConfig?
    /// The live API's WebSocket (docs/live.md), for example
    /// `wss://abc123def4.execute-api.us-east-1.amazonaws.com/live`: the pages keep it open so that a
    /// board's change shows at once. Nil for a `cranium.json` written before console 2.4.0 had it: then
    /// the pages poll, as they always did.
    public let liveURL: URL?

    /// The only redirect URI the mobile app client allows.
    public static let expectedRedirectURI = "cranium://signin"

    /// The scheme `ASWebAuthenticationSession` waits for: `cranium`.
    public var callbackScheme: String { "cranium" }

    public init(consoleURL: URL, loginDomain: URL, mobileClientId: String,
                redirectURI: String = CraniumConfig.expectedRedirectURI, userPool: CognitoUserPool? = nil,
                customer: CustomerConfig? = nil, liveURL: URL? = nil) {
        self.consoleURL = consoleURL
        self.loginDomain = loginDomain
        self.mobileClientId = mobileClientId
        self.redirectURI = redirectURI
        self.userPool = userPool
        self.customer = customer
        self.liveURL = liveURL
    }
}

/// The customer side's values: `customerApiUrl`, `customerClientId`, `customerRegion` and
/// `customerUserPoolId` in the configuration, all four or none.
public struct CustomerConfig: Equatable, Sendable {
    /// Where the customer API is: `{apiURL}/api/c/...`. The console's API, on the customer site's
    /// name once it has one.
    public let apiURL: URL
    /// The phone apps' client of the customer pool: public, no secret, SRP only.
    public let clientId: String
    /// The customer pool, apart from the staff pool.
    public let pool: CognitoUserPool

    public init(apiURL: URL, clientId: String, pool: CognitoUserPool) {
        self.apiURL = apiURL
        self.clientId = clientId
        self.pool = pool
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
        let customerApiUrl: String?
        let customerClientId: String?
        let customerRegion: String?
        let customerUserPoolId: String?
        let liveUrl: String?
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
        guard isClientId(clientId) else {
            throw ConfigError.invalid(key: "mobileClientId", reason: "is not a Cognito app client ID")
        }
        guard raw.redirectUri == expectedRedirectURI else {
            throw ConfigError.invalid(key: "redirectUri", reason: "is not \(expectedRedirectURI), the only one the app client allows")
        }
        let pool = try userPool(id: raw.userPoolId, region: raw.region)
        return CraniumConfig(consoleURL: console, loginDomain: login, mobileClientId: clientId,
                             redirectURI: raw.redirectUri, userPool: pool,
                             customer: try customer(raw), liveURL: try live(raw.liveUrl, region: pool?.region))
    }

    /// The live API's address, or nil when the file has none. It goes into the pages' policy, so it is
    /// held to exactly what the stack's LiveUrl output is (`liveAddress`). Anything else is an error, as
    /// for the other keys; so is one without the user pool's Region to hold it to.
    static func live(_ text: String?, region: String?) throws -> URL? {
        guard let text else { return nil }
        guard let region, let url = liveAddress(text, region: region) else {
            throw ConfigError.invalid(key: "liveUrl",
                                      reason: "is not the live API's address (wss://<id>.execute-api.<region>.amazonaws.com/<stage>)")
        }
        return url
    }

    /// `text` if it is the live API's address in `region`, as the stack's LiveUrl output is: `wss://`,
    /// the API's ID (ten lower-case letters and digits), `.execute-api.<region>.amazonaws.com`, `/` and a
    /// stage of letters, digits, `_` and `-`. Nil otherwise.
    public static func liveAddress(_ text: String, region: String) -> URL? {
        guard CognitoUserPool.isRegion(region), text.utf8.count <= 300, text.hasPrefix("wss://") else { return nil }
        let rest = text.dropFirst("wss://".count)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let host = rest[..<slash]
        let stage = rest[rest.index(after: slash)...]
        let suffix = ".execute-api.\(region).amazonaws.com"
        guard host.hasSuffix(suffix) else { return nil }
        let id = host.dropLast(suffix.count)
        let lowerOrDigit = { (scalar: Unicode.Scalar) in ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) }
        guard id.count == 10, id.unicodeScalars.allSatisfy(lowerOrDigit) else { return nil }
        guard (1...128).contains(stage.count),
              stage.unicodeScalars.allSatisfy({ lowerOrDigit($0) || ("A"..."Z").contains($0) || $0 == "_" || $0 == "-" })
        else { return nil }
        return URL(string: text)
    }

    /// Letters and digits, 1 to 128: what Cognito's app client IDs are.
    private static func isClientId(_ text: String) -> Bool {
        !text.isEmpty && text.count <= 128
            && text.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    }

    /// The four customer keys: all or none. One that is there but wrong is an error, as for the
    /// other keys.
    private static func customer(_ raw: File) throws -> CustomerConfig? {
        let keys: [(String, String?)] = [("customerApiUrl", raw.customerApiUrl), ("customerClientId", raw.customerClientId),
                                         ("customerRegion", raw.customerRegion), ("customerUserPoolId", raw.customerUserPoolId)]
        let given = keys.filter { $0.1 != nil }
        if given.isEmpty { return nil }
        if let missing = keys.first(where: { $0.1 == nil }) {
            throw ConfigError.invalid(key: missing.0, reason: "is missing, though \(given[0].0) is there")
        }
        let api = try httpsBase(raw.customerApiUrl!, key: "customerApiUrl")
        guard isClientId(raw.customerClientId!) else {
            throw ConfigError.invalid(key: "customerClientId", reason: "is not a Cognito app client ID")
        }
        guard CognitoUserPool.isRegion(raw.customerRegion!) else {
            throw ConfigError.invalid(key: "customerRegion", reason: "is not an AWS Region")
        }
        guard let pool = CognitoUserPool(id: raw.customerUserPoolId!, region: raw.customerRegion!) else {
            throw ConfigError.invalid(key: "customerUserPoolId", reason: "is not a user pool ID in that Region")
        }
        return CustomerConfig(apiURL: api, clientId: raw.customerClientId!, pool: pool)
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
