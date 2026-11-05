import Foundation
import Testing
@testable import CraniumKit

@Suite struct PKCETests {
    @Test func theRFC7636Example() {
        // RFC 7636, appendix B.
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func aNewVerifierIs43UnreservedCharactersAndNeverTheSame() {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let a = PKCE.generate(), b = PKCE.generate()
        #expect(a.verifier.count == 43)
        #expect(a.verifier.allSatisfy(allowed.contains))
        #expect(a.challenge.count == 43)
        #expect(a.verifier != b.verifier)
        #expect(PKCE.randomURLSafe(byteCount: 16) != PKCE.randomURLSafe(byteCount: 16))
    }
}

@Suite struct OAuthTests {
    let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")

    @Test func theAuthorizeURLIsTheContractsOwn() {
        let pending = OAuth.begin(testConfig, pkce: pkce, state: "s-1")
        #expect(pending.url.absoluteString ==
            "https://login.test/oauth2/authorize?response_type=code&client_id=testclient123" +
            "&redirect_uri=cranium://signin&scope=openid+cranium/console" +
            "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=s-1" +
            "&prompt=login")
    }

    func pending() -> PendingSignIn { OAuth.begin(testConfig, pkce: pkce, state: "s-1") }

    @Test func theCodeComesBackWithTheState() throws {
        let code = try OAuth.code(from: URL(string: "cranium://signin?code=abc-123&state=s-1")!,
                                  expecting: pending(), config: testConfig)
        #expect(code == "abc-123")
    }

    @Test func anotherStateIsRefused() {
        #expect(throws: AuthError.stateMismatch) {
            try OAuth.code(from: URL(string: "cranium://signin?code=abc&state=other")!, expecting: pending(), config: testConfig)
        }
        #expect(throws: AuthError.stateMismatch) {
            try OAuth.code(from: URL(string: "cranium://signin?code=abc")!, expecting: pending(), config: testConfig)
        }
    }

    @Test func anErrorAnswerIsShown() {
        #expect(throws: AuthError.refused("User is not allowed")) {
            try OAuth.code(from: URL(string: "cranium://signin?error=access_denied&error_description=User+is+not+allowed&state=s-1")!,
                           expecting: pending(), config: testConfig)
        }
    }

    @Test func otherCallbacksAreRefused() {
        for text in ["other://signin?code=a&state=s-1", "cranium://elsewhere?code=a&state=s-1", "cranium://signin?state=s-1"] {
            #expect(throws: AuthError.badCallback) {
                try OAuth.code(from: URL(string: text)!, expecting: pending(), config: testConfig)
            }
        }
    }

    @Test func theTokenRequest() {
        let request = OAuth.tokenRequest(testConfig, code: "c/1+2", verifier: pkce.verifier)
        #expect(request.url?.absoluteString == "https://login.test/oauth2/token")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)  // a public client
        #expect(formFields(request) == [
            "grant_type": "authorization_code", "client_id": "testclient123", "code": "c/1+2",
            "redirect_uri": "cranium://signin", "code_verifier": pkce.verifier,
        ])
        let body = String(data: request.httpBody!, encoding: .utf8)!
        #expect(body.contains("code=c%2F1%2B2"))
    }

    @Test func theRefreshAndRevokeRequests() {
        let refresh = OAuth.refreshRequest(testConfig, refreshToken: "r-1")
        #expect(refresh.url?.absoluteString == "https://login.test/oauth2/token")
        #expect(formFields(refresh) == ["grant_type": "refresh_token", "client_id": "testclient123", "refresh_token": "r-1"])
        let revoke = OAuth.revokeRequest(testConfig, refreshToken: "r-1")
        #expect(revoke.url?.absoluteString == "https://login.test/oauth2/revoke")
        #expect(formFields(revoke) == ["token": "r-1", "client_id": "testclient123"])
    }

    @Test func tokenAnswers() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let first = try OAuth.tokens(from: json(["access_token": "a", "refresh_token": "r", "id_token": "i", "expires_in": 3600]),
                                     status: 200, keeping: nil, now: now)
        #expect(first == Tokens(accessToken: "a", refreshToken: "r", expiresAt: now.addingTimeInterval(3600)))
        // A refresh answer has no refresh token: the one in use stays.
        let refreshed = try OAuth.tokens(from: json(["access_token": "b", "expires_in": 60]), status: 200, keeping: "r", now: now)
        #expect(refreshed.refreshToken == "r")
        #expect(throws: AuthError.sessionExpired) {
            try OAuth.tokens(from: json(["error": "invalid_grant"]), status: 400, keeping: "r", now: now)
        }
        #expect(throws: AuthError.badTokenResponse(status: 502)) {
            try OAuth.tokens(from: Data("<html>".utf8), status: 502, keeping: "r", now: now)
        }
    }

    @Test func tokensAreNeverPrinted() {
        let tokens = Tokens(accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: Date())
        #expect(!"\(tokens)".contains("secret"))
        #expect(!String(reflecting: tokens).contains("secret"))
    }
}

@Suite struct AuthSessionTests {
    final class Clock: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 10_000)
    }

    func tokenAnswer(_ access: String, refresh: String? = nil) -> Data {
        var object: [String: Any] = ["access_token": access, "expires_in": 3600, "token_type": "Bearer"]
        if let refresh { object["refresh_token"] = refresh }
        return json(object)
    }

    @Test func signInStoresTheTokens() async throws {
        let http = FakeHTTP { _ in (200, tokenAnswer("a1", refresh: "r1")) }
        let store = MemoryTokenStore()
        let session = AuthSession(config: testConfig, http: http, store: store)
        let pending = try await session.beginSignIn()
        let callback = URL(string: "cranium://signin?code=xyz&state=\(pending.state)")!
        try await session.completeSignIn(callback: callback, pending: pending)
        #expect(try await session.accessToken() == "a1")
        #expect(try store.load()?.refreshToken == "r1")
        #expect(formFields(http.requests[0])["code_verifier"] == pending.pkce.verifier)
        #expect(await session.isSignedIn)
    }

    @Test func aForgedCallbackSendsNothing() async throws {
        let http = FakeHTTP { _ in (200, tokenAnswer("a1", refresh: "r1")) }
        let session = AuthSession(config: testConfig, http: http, store: MemoryTokenStore())
        let pending = try await session.beginSignIn()
        await #expect(throws: AuthError.stateMismatch) {
            try await session.completeSignIn(callback: URL(string: "cranium://signin?code=xyz&state=forged")!, pending: pending)
        }
        #expect(http.requests.isEmpty)
    }

    @Test func refreshesBeforeTheTokenRunsOut() async throws {
        let clock = Clock()
        let http = FakeHTTP { _ in (200, tokenAnswer("a2")) }
        let store = MemoryTokenStore(Tokens(accessToken: "a1", refreshToken: "r1", expiresAt: clock.now.addingTimeInterval(120)))
        let session = AuthSession(config: testConfig, http: http, store: store, now: { clock.now })
        #expect(try await session.accessToken() == "a1")
        #expect(http.requests.isEmpty)
        clock.now = clock.now.addingTimeInterval(61)  // 59 s left: under the margin
        #expect(try await session.accessToken() == "a2")
        #expect(formFields(http.requests[0])["refresh_token"] == "r1")
        #expect(try store.load()?.refreshToken == "r1")
    }

    @Test func callersWaitingOnOneRefreshShareIt() async throws {
        let http = FakeHTTP { _ in
            try await Task.sleep(nanoseconds: 50_000_000)
            return (200, tokenAnswer("fresh"))
        }
        let store = MemoryTokenStore(Tokens(accessToken: "old", refreshToken: "r1", expiresAt: Date(timeIntervalSince1970: 0)))
        let session = AuthSession(config: testConfig, http: http, store: store)
        async let a = session.accessToken()
        async let b = session.accessToken()
        async let c = session.accessToken(replacing: "old")
        let tokens = try await [a, b, c]
        #expect(tokens == ["fresh", "fresh", "fresh"])
        #expect(http.requests.count == 1)
    }

    @Test func aRejectedRefreshSignsOut() async throws {
        let http = FakeHTTP { _ in (400, json(["error": "invalid_grant"])) }
        let store = MemoryTokenStore(Tokens(accessToken: "old", refreshToken: "r1", expiresAt: Date(timeIntervalSince1970: 0)))
        let session = AuthSession(config: testConfig, http: http, store: store)
        await #expect(throws: AuthError.sessionExpired) { try await session.accessToken() }
        #expect(try store.load() == nil)
        #expect(await !session.isSignedIn)
    }

    @Test func aNetworkFailureKeepsTheTokens() async throws {
        let http = FakeHTTP { _ in throw URLError(.notConnectedToInternet) }
        let store = MemoryTokenStore(Tokens(accessToken: "old", refreshToken: "r1", expiresAt: Date(timeIntervalSince1970: 0)))
        let session = AuthSession(config: testConfig, http: http, store: store)
        await #expect(throws: URLError.self) { try await session.accessToken() }
        #expect(try store.load() != nil)
    }

    @Test func signOutForgetsAndRevokes() async throws {
        let http = FakeHTTP { _ in (200, Data()) }
        let store = MemoryTokenStore(Tokens(accessToken: "a", refreshToken: "r1", expiresAt: Date.distantFuture))
        let session = AuthSession(config: testConfig, http: http, store: store)
        await session.signOut()
        #expect(try store.load() == nil)
        #expect(http.requests.map { $0.url?.path } == ["/oauth2/revoke"])
        #expect(formFields(http.requests[0]) == ["token": "r1", "client_id": "testclient123"])
        await #expect(throws: AuthError.notSignedIn) { try await session.accessToken() }
    }
}
