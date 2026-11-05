import Foundation

/// What the API client needs from sign-in.
public protocol AccessTokenProvider: Sendable {
    /// A token that is good for at least another minute, refreshed first if it is not.
    func accessToken() async throws -> String
    /// The API said 401 to `rejected`: refresh, unless another call already has.
    func accessToken(replacing rejected: String) async throws -> String
}

/// The signed-in state: the tokens, their refresh, and sign-out.
///
/// Where the refresh token is kept (docs/mobile-apps.md, "Unlocking with Face ID"):
///
/// - Face ID off: in `store` with the access token, as before, and forgotten 60 minutes after the
///   sign-in with password and code (`refreshTokenLifetime`), so that the 30-day token Cognito
///   gives the phone is never kept without the biometric.
/// - Face ID on: behind it, in the Keychain item that `BiometricLock` looks after, and never in
///   `store`. It is in memory only once Face ID has released it, for that run of the app.
///
/// Two kinds, each with a store of its own (docs/mobile-apps.md, "Customers"): an admin's, of the
/// staff pool, renewed at the managed login's token endpoint; and a customer's, of the customer
/// pool, which has no managed login, renewed and revoked through Cognito's user pool API
/// (InitiateAuth with REFRESH_TOKEN_AUTH, RevokeToken), as the customer site revokes its own.
public actor AuthSession: AccessTokenProvider {
    /// How the tokens are renewed and revoked.
    enum Renewal: Sendable {
        /// The managed login's token endpoint, with the staff pool's phone client.
        case oauth(CraniumConfig)
        /// Cognito's user pool API, with the phone apps' client of the customer pool.
        case userPool(CognitoUserPool, clientId: String)
    }

    private let renewal: Renewal
    private let http: HTTPClient
    private let store: TokenStore
    private let now: @Sendable () -> Date
    private var tokens: Tokens?
    private var refreshing: Task<Tokens, Error>?
    /// The refresh token is kept behind Face ID, not in `store`.
    private var refreshTokenBehindBiometrics: Bool

    /// Refresh this long before the access token runs out.
    static let margin: TimeInterval = 60
    /// Without Face ID, the refresh token is forgotten this long after the sign-in.
    public static let refreshTokenLifetime: TimeInterval = 60 * 60

    public init(config: CraniumConfig, http: HTTPClient, store: TokenStore, refreshTokenBehindBiometrics: Bool = false,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.init(renewal: .oauth(config), http: http, store: store, refreshTokenBehindBiometrics: refreshTokenBehindBiometrics,
                  now: now)
    }

    /// A customer's session: its own store (never the admin's), renewed through the user pool API.
    public init(customer: CustomerConfig, http: HTTPClient, store: TokenStore, refreshTokenBehindBiometrics: Bool = false,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.init(renewal: .userPool(customer.pool, clientId: customer.clientId), http: http, store: store,
                  refreshTokenBehindBiometrics: refreshTokenBehindBiometrics, now: now)
    }

    init(renewal: Renewal, http: HTTPClient, store: TokenStore, refreshTokenBehindBiometrics: Bool,
         now: @escaping @Sendable () -> Date) {
        self.renewal = renewal
        self.http = http
        self.store = store
        self.now = now
        self.refreshTokenBehindBiometrics = refreshTokenBehindBiometrics
        var loaded = try? store.load()
        // A refresh token whose 60 minutes are over goes before anything can use it.
        if !refreshTokenBehindBiometrics, var kept = loaded, Self.refreshTokenIsDue(kept, now: now()) {
            kept.refreshToken = nil
            try? store.save(kept)
            loaded = kept
        }
        self.tokens = loaded
    }

    public var isSignedIn: Bool { tokens != nil }

    /// Whether the session can be renewed: a refresh token is in memory.
    public var hasRefreshToken: Bool { tokens?.refreshToken != nil }

    /// When the access token in memory runs out; nil when signed out. For the shell's bridge
    /// (`ShellAuthPool`), which tells the page how long its token is good for.
    public var accessTokenExpiresAt: Date? { tokens?.expiresAt }

    /// Whose session it is: the access token's `sub`, for the Face ID setting of a customer, whom no
    /// API call names. Nil when not signed in or not known.
    public var subject: String? { tokens.flatMap { JWTClaims.subject($0.accessToken) } }

    /// When the person signed in with password and code: the access token's `auth_time`, which a
    /// refresh keeps, or the time recorded at the sign-in.
    public var signedInAt: Date? { tokens.flatMap(Self.signInTime) }

    static func signInTime(_ tokens: Tokens) -> Date? {
        JWTClaims.authTime(tokens.accessToken) ?? tokens.signedInAt
    }

    /// Whether a refresh token kept with the tokens has outlived its 60 minutes. Not when the sign-in
    /// time is not known (made-up tokens, in the tests and the demo).
    static func refreshTokenIsDue(_ tokens: Tokens, now: Date) -> Bool {
        guard tokens.refreshToken != nil, let start = signInTime(tokens) else { return false }
        return now.timeIntervalSince(start) >= refreshTokenLifetime
    }

    /// Keeps `fresh`: in memory as it is, and in `store` without the refresh token while that is
    /// behind Face ID.
    private func keep(_ fresh: Tokens) throws {
        var stored = fresh
        if refreshTokenBehindBiometrics { stored.refreshToken = nil }
        try store.save(stored)
        tokens = fresh
    }

    /// A full sign-in's tokens, with the time of the sign-in.
    private func signedIn(_ fresh: Tokens) -> Tokens {
        var made = fresh
        if made.signedInAt == nil { made.signedInAt = JWTClaims.authTime(made.accessToken) ?? now() }
        return made
    }

    /// The managed login's configuration; a customer's session has none.
    private func managedLogin() throws -> CraniumConfig {
        guard case .oauth(let config) = renewal else { throw AuthError.refused("This account has no AWS sign-in page.") }
        return config
    }

    public func beginSignIn() throws -> PendingSignIn {
        OAuth.begin(try managedLogin())
    }

    /// Takes the callback URL from the web authentication session, checks it, and trades the
    /// code for tokens.
    public func completeSignIn(callback: URL, pending: PendingSignIn) async throws {
        let config = try managedLogin()
        let code = try OAuth.code(from: callback, expecting: pending, config: config)
        let request = OAuth.tokenRequest(config, code: code, verifier: pending.pkce.verifier)
        let (data, response) = try await http.send(request)
        let fresh = try OAuth.tokens(from: data, status: response.statusCode, keeping: nil, now: now())
        try keep(signedIn(fresh))
    }

    /// Keeps the tokens of a sign-in on the app's own screen (`PasswordSignIn`) as
    /// `completeSignIn(callback:pending:)` keeps those of the AWS sign-in page: in the store, in
    /// place of any before. Both are refreshed the same way, at the token endpoint (`refresh()`),
    /// which Cognito documents for tokens from the user pool API too, as long as the pool does not
    /// remember devices (it does not).
    public func completeSignIn(tokens fresh: Tokens) throws {
        try keep(signedIn(fresh))
    }

    public func accessToken() async throws -> String {
        forgetRefreshTokenIfDue()
        guard let current = tokens else { throw AuthError.notSignedIn }
        if current.expiresAt.timeIntervalSince(now()) > Self.margin {
            return current.accessToken
        }
        return try await refresh().accessToken
    }

    public func accessToken(replacing rejected: String) async throws -> String {
        forgetRefreshTokenIfDue()
        guard let current = tokens else { throw AuthError.notSignedIn }
        if current.accessToken != rejected {
            return current.accessToken
        }
        return try await refresh().accessToken
    }

    /// One refresh at a time: callers that arrive while one runs wait for it.
    private func refresh() async throws -> Tokens {
        if let refreshing {
            return try await refreshing.value
        }
        guard let refreshToken = tokens?.refreshToken else {
            forget()
            throw AuthError.sessionExpired
        }
        let task = Task { [http, now, renewal] () throws -> Tokens in
            switch renewal {
            case .oauth(let config):
                let (data, response) = try await http.send(OAuth.refreshRequest(config, refreshToken: refreshToken))
                return try OAuth.tokens(from: data, status: response.statusCode, keeping: refreshToken, now: now())
            case .userPool(let pool, let clientId):
                let request = try CognitoUserPoolAPI.request(pool, "InitiateAuth", [
                    "AuthFlow": "REFRESH_TOKEN_AUTH",
                    "ClientId": clientId,
                    "AuthParameters": ["REFRESH_TOKEN": refreshToken],
                ])
                let (data, response) = try await http.send(request)
                return try CognitoUserPoolAPI.refreshed(data, response: response, keeping: refreshToken, now: now())
            }
        }
        refreshing = task
        defer { refreshing = nil }
        do {
            var fresh = try await task.value
            // A sign-in that finished while this refresh was on its way wins: its tokens are newer,
            // and its auth_time is the one a change from the phone needs.
            if let current = tokens, current.refreshToken != refreshToken { return current }
            fresh.signedInAt = tokens?.signedInAt
            try keep(fresh)
            return fresh
        } catch AuthError.sessionExpired {
            if let current = tokens, current.refreshToken != refreshToken { return current }
            forget()
            throw AuthError.sessionExpired
        }
    }

    /// Forgets the tokens, then asks Cognito to revoke the refresh token. The revoke is best
    /// effort: the tokens are gone from the phone whatever it answers.
    public func signOut() async {
        let refreshToken = tokens?.refreshToken
        forget()
        guard let refreshToken else { return }
        switch renewal {
        case .oauth(let config):
            _ = try? await http.send(OAuth.revokeRequest(config, refreshToken: refreshToken))
        case .userPool(let pool, let clientId):
            if let request = try? CognitoUserPoolAPI.request(pool, "RevokeToken", ["Token": refreshToken, "ClientId": clientId]) {
                _ = try? await http.send(request)
            }
        }
    }

    /// A current access token, refreshed first if it has to be, or nil when the session is over: for
    /// the user pool API's calls about the account itself (`CustomerAccount`), which take it as a
    /// parameter.
    public func currentAccessToken() async -> String? {
        try? await accessToken()
    }

    /// When the refresh token goes without Face ID (`refreshTokenLifetime` after the sign-in), or
    /// nil when it does not (behind Face ID, or not known).
    public var refreshTokenForgottenAt: Date? {
        guard !refreshTokenBehindBiometrics, let current = tokens, current.refreshToken != nil,
              let start = Self.signInTime(current) else { return nil }
        return start.addingTimeInterval(Self.refreshTokenLifetime)
    }

    private func forget() {
        tokens = nil
        try? store.clear()
    }

    // MARK: Face ID (BiometricLock)

    /// Without Face ID, the refresh token goes 60 minutes after the sign-in: the access token works
    /// on to its own end, and then the person signs in again. Asked at every access token, at launch,
    /// and when the app comes and goes.
    public func forgetRefreshTokenIfDue() {
        guard !refreshTokenBehindBiometrics, var current = tokens, Self.refreshTokenIsDue(current, now: now()) else { return }
        current.refreshToken = nil
        try? store.save(current)
        tokens = current
    }

    /// The refresh token in memory, to be put behind Face ID. Nil when there is none: forgotten, or
    /// not released yet.
    public func refreshTokenForBiometrics() -> String? {
        tokens?.refreshToken
    }

    /// From now on the refresh token is behind Face ID: it leaves `store`.
    public func keepRefreshTokenBehindBiometrics() throws {
        refreshTokenBehindBiometrics = true
        if let current = tokens { try keep(current) }
    }

    /// From now on the refresh token is kept with the tokens again, for what is left of its 60
    /// minutes, if anything.
    public func keepRefreshTokenWithTokens() throws {
        refreshTokenBehindBiometrics = false
        forgetRefreshTokenIfDue()
        if let current = tokens { try keep(current) }
    }

    /// The refresh token that Face ID released: in memory, for this run of the app, never in `store`.
    public func release(refreshToken: String) {
        guard var current = tokens else { return }
        current.refreshToken = refreshToken
        tokens = current
    }
}
