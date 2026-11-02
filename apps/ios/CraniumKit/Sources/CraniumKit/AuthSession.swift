import Foundation

/// What the API client needs from sign-in.
public protocol AccessTokenProvider: Sendable {
    /// A token that is good for at least another minute, refreshed first if it is not.
    func accessToken() async throws -> String
    /// The API said 401 to `rejected`: refresh, unless another call already has.
    func accessToken(replacing rejected: String) async throws -> String
}

/// The signed-in state: the tokens, their refresh, and sign-out.
public actor AuthSession: AccessTokenProvider {
    private let config: CraniumConfig
    private let http: HTTPClient
    private let store: TokenStore
    private let now: @Sendable () -> Date
    private var tokens: Tokens?
    private var refreshing: Task<Tokens, Error>?

    /// Refresh this long before the access token runs out.
    static let margin: TimeInterval = 60

    public init(config: CraniumConfig, http: HTTPClient, store: TokenStore,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.config = config
        self.http = http
        self.store = store
        self.now = now
        self.tokens = try? store.load()
    }

    public var isSignedIn: Bool { tokens != nil }

    public func beginSignIn() -> PendingSignIn {
        OAuth.begin(config)
    }

    /// Takes the callback URL from the web authentication session, checks it, and trades the
    /// code for tokens.
    public func completeSignIn(callback: URL, pending: PendingSignIn) async throws {
        let code = try OAuth.code(from: callback, expecting: pending, config: config)
        let request = OAuth.tokenRequest(config, code: code, verifier: pending.pkce.verifier)
        let (data, response) = try await http.send(request)
        let fresh = try OAuth.tokens(from: data, status: response.statusCode, keeping: nil, now: now())
        try store.save(fresh)
        tokens = fresh
    }

    public func accessToken() async throws -> String {
        guard let current = tokens else { throw AuthError.notSignedIn }
        if current.expiresAt.timeIntervalSince(now()) > Self.margin {
            return current.accessToken
        }
        return try await refresh().accessToken
    }

    public func accessToken(replacing rejected: String) async throws -> String {
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
        let request = OAuth.refreshRequest(config, refreshToken: refreshToken)
        let task = Task { [http, now] () throws -> Tokens in
            let (data, response) = try await http.send(request)
            return try OAuth.tokens(from: data, status: response.statusCode, keeping: refreshToken, now: now())
        }
        refreshing = task
        defer { refreshing = nil }
        do {
            let fresh = try await task.value
            try store.save(fresh)
            tokens = fresh
            return fresh
        } catch AuthError.sessionExpired {
            forget()
            throw AuthError.sessionExpired
        }
    }

    /// Forgets the tokens, then asks Cognito to revoke the refresh token. The revoke is best
    /// effort: the tokens are gone from the phone whatever it answers.
    public func signOut() async {
        let refreshToken = tokens?.refreshToken
        forget()
        if let refreshToken {
            _ = try? await http.send(OAuth.revokeRequest(config, refreshToken: refreshToken))
        }
    }

    private func forget() {
        tokens = nil
        try? store.clear()
    }
}
