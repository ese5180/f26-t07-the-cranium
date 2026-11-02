import Foundation

/// The console's tokens. Kept in the Keychain, never in plain storage, and never printed: the
/// descriptions below leave the tokens out.
public struct Tokens: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String?, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }

    public var description: String {
        "Tokens(expiresAt: \(expiresAt), refreshToken: \(refreshToken == nil ? "none" : "kept"))"
    }

    public var debugDescription: String { description }
}

public enum AuthError: Error, Equatable, LocalizedError {
    case notSignedIn
    /// The person closed the sign-in sheet.
    case cancelled
    /// The callback's `state` is not the one sent. Possibly a forged callback: nothing is used.
    case stateMismatch
    /// The callback had no code, or was not `cranium://signin`.
    case badCallback
    /// Cognito answered the sign-in with an error, with its description.
    case refused(String)
    /// The refresh token is no longer good. The person has to sign in again.
    case sessionExpired
    /// The token endpoint answered something that is not tokens.
    case badTokenResponse(status: Int)

    public var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Sign in first."
        case .cancelled: return "Sign-in was cancelled."
        case .stateMismatch: return "The sign-in answer did not match the request, so it was not used. Try again."
        case .badCallback: return "The sign-in page came back without a code. Try again."
        case .refused(let text): return "Sign-in failed: \(text)"
        case .sessionExpired: return "Your sign-in has expired. Sign in again."
        case .badTokenResponse(let status): return "The sign-in service answered \(status). Try again."
        }
    }
}

/// A sign-in that has been started: what to open, and what to check the answer against.
public struct PendingSignIn: Equatable, Sendable {
    public let pkce: PKCE
    public let state: String
    public let url: URL
}

/// OAuth 2.0 authorization code with PKCE against Cognito's managed login, as in
/// docs/mobile-apps.md, "Signing in". These build requests and read answers; `AuthSession`
/// sends them.
public enum OAuth {
    public static let scope = "openid cranium/console"

    public static func begin(_ config: CraniumConfig, pkce: PKCE = .generate(),
                             state: String = PKCE.randomURLSafe(byteCount: 16)) -> PendingSignIn {
        PendingSignIn(pkce: pkce, state: state, url: authorizeURL(config, challenge: pkce.challenge, state: state))
    }

    /// `{loginDomain}/oauth2/authorize?response_type=code&client_id=…&redirect_uri=cranium://signin
    /// &scope=openid+cranium/console&code_challenge=…&code_challenge_method=S256&state=…`
    public static func authorizeURL(_ config: CraniumConfig, challenge: String, state: String) -> URL {
        let query = FormEncoding.query([
            ("response_type", "code"),
            ("client_id", config.mobileClientId),
            ("redirect_uri", config.redirectURI),
            ("scope", scope),
            ("code_challenge", challenge),
            ("code_challenge_method", PKCE.method),
            ("state", state),
        ])
        // The pieces are checked or encoded, so this cannot fail.
        return URL(string: config.loginDomain.absoluteString + "/oauth2/authorize?" + query)!
    }

    /// The code from `cranium://signin?code=…&state=…`, after checking the state.
    public static func code(from callback: URL, expecting pending: PendingSignIn, config: CraniumConfig) throws -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == config.callbackScheme,
              components.host?.lowercased() == "signin" else {
            throw AuthError.badCallback
        }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.replacingOccurrences(of: "+", with: " ")
        }
        // An error answer carries the state too; check it first, so that a forged one is not shown.
        guard value("state") == pending.state else {
            throw AuthError.stateMismatch
        }
        if let error = value("error") {
            throw AuthError.refused(value("error_description") ?? error)
        }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw AuthError.badCallback
        }
        return code
    }

    /// `POST {loginDomain}/oauth2/token` with `grant_type=authorization_code`.
    public static func tokenRequest(_ config: CraniumConfig, code: String, verifier: String) -> URLRequest {
        formPost(config, path: "/oauth2/token", [
            ("grant_type", "authorization_code"),
            ("client_id", config.mobileClientId),
            ("code", code),
            ("redirect_uri", config.redirectURI),
            ("code_verifier", verifier),
        ])
    }

    /// `POST {loginDomain}/oauth2/token` with `grant_type=refresh_token`.
    public static func refreshRequest(_ config: CraniumConfig, refreshToken: String) -> URLRequest {
        formPost(config, path: "/oauth2/token", [
            ("grant_type", "refresh_token"),
            ("client_id", config.mobileClientId),
            ("refresh_token", refreshToken),
        ])
    }

    /// `POST {loginDomain}/oauth2/revoke` with the refresh token, on sign-out.
    public static func revokeRequest(_ config: CraniumConfig, refreshToken: String) -> URLRequest {
        formPost(config, path: "/oauth2/revoke", [
            ("token", refreshToken),
            ("client_id", config.mobileClientId),
        ])
    }

    private static func formPost(_ config: CraniumConfig, path: String, _ items: [(String, String)]) -> URLRequest {
        var request = URLRequest(url: URL(string: config.loginDomain.absoluteString + path)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = FormEncoding.body(items)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    private struct TokenAnswer: Decodable {
        let access_token: String?
        let refresh_token: String?
        let expires_in: Double?
        let error: String?
        let error_description: String?
    }

    /// Reads the token endpoint's answer. A refresh answer has no refresh token, so the one in
    /// use is kept.
    public static func tokens(from data: Data, status: Int, keeping refreshToken: String?, now: Date) throws -> Tokens {
        let answer = try? JSONDecoder().decode(TokenAnswer.self, from: data)
        if status == 200, let access = answer?.access_token, !access.isEmpty {
            let lifetime = answer?.expires_in ?? 3600
            return Tokens(accessToken: access, refreshToken: answer?.refresh_token ?? refreshToken,
                          expiresAt: now.addingTimeInterval(lifetime))
        }
        if answer?.error == "invalid_grant" {
            throw AuthError.sessionExpired
        }
        if let error = answer?.error {
            throw AuthError.refused(answer?.error_description ?? error)
        }
        throw AuthError.badTokenResponse(status: status)
    }
}
