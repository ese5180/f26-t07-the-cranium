import Foundation

/// Cognito's user pool API, as far as the customer side uses it outside the sign-in itself
/// (docs/mobile-apps.md, "Customers"): the refresh and the revocation of a customer's tokens, which
/// have no managed login to go to, and the calls a customer makes about their own account
/// (`CustomerAccount`). One address for every operation, the operation in a header, JSON both ways:
/// the website's core.js `cognitoCall`.
///
/// What comes back is kept as bytes (`Answer`), so that it can pass between actors; each caller
/// reads the object it expects.
public enum CognitoUserPoolAPI {
    /// How long one call may take, as on the website.
    static let timeout: TimeInterval = 15

    /// Where a call ended.
    public enum Answer: Equatable, Sendable {
        /// A JSON object, as it came, and the Date header.
        case reply(Data, date: String?)
        /// An error of Cognito's, by name ("" if it did not say).
        case error(String)
        /// Nothing came back: no connection, or no answer in time.
        case network
        /// Something came back that is not a JSON object.
        case unreadable
    }

    /// POST https://cognito-idp.{region}.amazonaws.com/ with the operation in a header. No cookies,
    /// no cache.
    static func request(_ pool: CognitoUserPool, _ operation: String, _ body: [String: Any]) throws -> URLRequest {
        var request = URLRequest(url: pool.endpoint)
        request.httpMethod = "POST"
        request.setValue(CognitoUserPool.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(CognitoUserPool.targetPrefix + operation, forHTTPHeaderField: "X-Amz-Target")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes])
        return request
    }

    /// One call, never throwing.
    static func send(_ http: HTTPClient, _ request: URLRequest) async -> Answer {
        let data: Data, response: HTTPURLResponse
        do {
            (data, response) = try await http.send(request)
        } catch {
            return .network
        }
        guard (200...299).contains(response.statusCode) else {
            return .error(errorName(data, response))
        }
        guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return .unreadable }
        return .reply(data, date: response.value(forHTTPHeaderField: "Date"))
    }

    /// The reply's object.
    static func object(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    /// What Cognito's error answer is called, such as NotAuthorizedException; "" if it does not say.
    static func errorName(_ data: Data, _ response: HTTPURLResponse) -> String {
        PasswordSignIn.errorName((try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                                 header: response.value(forHTTPHeaderField: "X-Amzn-ErrorType"))
    }

    /// The answer to InitiateAuth with REFRESH_TOKEN_AUTH: new tokens with the refresh token in use
    /// (Cognito sends none back unless it rotates them), or why not. A refresh token Cognito no
    /// longer takes (revoked, past its 30 days, the account switched off) ends the session.
    static func refreshed(_ data: Data, response: HTTPURLResponse, keeping refreshToken: String, now: Date) throws -> Tokens {
        guard (200...299).contains(response.statusCode) else {
            switch errorName(data, response) {
            case "NotAuthorizedException", "UserNotFoundException", "UserNotConfirmedException", "PasswordResetRequiredException":
                throw AuthError.sessionExpired
            default:
                throw AuthError.badTokenResponse(status: response.statusCode)
            }
        }
        guard let result = object(data)["AuthenticationResult"] as? [String: Any],
              var tokens = PasswordSignIn.tokens(from: result, now: now) else {
            throw AuthError.badTokenResponse(status: response.statusCode)
        }
        if tokens.refreshToken == nil { tokens.refreshToken = refreshToken }
        return tokens
    }
}
