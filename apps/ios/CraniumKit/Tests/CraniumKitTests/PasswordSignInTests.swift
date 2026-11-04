import Foundation
import Testing
@testable import CraniumKit

/// The app's own sign-in against a stand-in for Cognito (CognitoStub), after the website's
/// cloud/web/test/signin.test.mjs. Nothing here reaches AWS.
@Suite struct PasswordSignInTests {
    static let pool = "xx-test-1_Pool0Tests"
    static let client = "client1"
    static let config = CraniumConfig(consoleURL: URL(string: "https://console.test")!,
                                      loginDomain: URL(string: "https://login.test")!,
                                      mobileClientId: client,
                                      userPool: CognitoUserPool(id: pool, region: "xx-test-1"))
    static let now = Date(timeIntervalSince1970: 1_793_588_645)  // 2026-11-02T03:04:05Z
    // Made up for these tests, as are the addresses: a reserved domain that cannot receive mail.
    static let password = "Correct-Horse-B4ttery"
    static let user = CognitoStub.User(email: "person@example.invalid", userId: "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b",
                                       password: password, code: "246810")

    struct Phone {
        let signIn: PasswordSignIn
        let cognito: CognitoStub
        let store: MemoryTokenStore
        let session: AuthSession
    }

    /// A phone whose clock says `phoneNow`, signing in against a Cognito whose clock says `cognitoNow`.
    static func phone(users: [CognitoStub.User] = [user], phoneNow: Date = now, cognitoNow: Date = now, sendsDate: Bool = false,
                      fail: @escaping @Sendable (String, [String: Any]) -> String? = { _, _ in nil }) -> Phone {
        let cognito = CognitoStub(userPoolId: pool, clientId: client, users: users, now: cognitoNow, sendsDate: sendsDate, fail: fail)
        let store = MemoryTokenStore()
        let session = AuthSession(config: config, http: cognito, store: store, now: { phoneNow })
        let signIn = PasswordSignIn(config: config, http: cognito, session: session, now: { phoneNow })!
        return Phone(signIn: signIn, cognito: cognito, store: store, session: session)
    }

    static func steps(_ phone: Phone) -> [String] {
        phone.cognito.calls.map { $0.challenge ?? $0.operation }
    }

    @Test func addressPasswordAndCodeKeepTheTokensAndSendThePasswordNowhere() async throws {
        let phone = Self.phone()
        #expect(await phone.signIn.signIn(email: "  Person@Example.INVALID ", password: Self.password) == .code(nil))
        #expect(await phone.signIn.waitsForCode)
        #expect(await phone.signIn.sendCode(Self.user.code) == .done)
        #expect(Self.steps(phone) == ["InitiateAuth", "PASSWORD_VERIFIER", "SOFTWARE_TOKEN_MFA"])

        // Each call is to the user pool API, as Cognito's JSON protocol has it, and carries no
        // cookie and no authorization.
        let calls = phone.cognito.calls
        for (call, operation) in zip(calls, ["InitiateAuth", "RespondToAuthChallenge", "RespondToAuthChallenge"]) {
            #expect(call.request.url?.absoluteString == "https://cognito-idp.xx-test-1.amazonaws.com/")
            #expect(call.request.httpMethod == "POST")
            #expect(call.request.value(forHTTPHeaderField: "Content-Type") == "application/x-amz-json-1.1")
            #expect(call.request.value(forHTTPHeaderField: "X-Amz-Target") == "AWSCognitoIdentityProviderService.\(operation)")
            #expect(call.request.value(forHTTPHeaderField: "Authorization") == nil)
            #expect(call.request.httpShouldHandleCookies == false)
        }
        let sent = calls.map(\.body)
        #expect(Set(sent[0].keys) == ["AuthFlow", "AuthParameters", "ClientId"])
        #expect(sent[0]["AuthFlow"] as? String == "USER_SRP_AUTH")
        #expect(sent[0]["ClientId"] as? String == Self.client)
        let start = try #require(sent[0]["AuthParameters"] as? [String: String])
        // The address as the account has it: trimmed and in lower case.
        #expect(start["USERNAME"] == Self.user.email)
        #expect(start["SRP_A"]?.allSatisfy { "0123456789abcdef".contains($0) } == true)
        let proof = try #require(sent[1]["ChallengeResponses"] as? [String: String])
        #expect(Set(proof.keys) == ["PASSWORD_CLAIM_SECRET_BLOCK", "PASSWORD_CLAIM_SIGNATURE", "TIMESTAMP", "USERNAME"])
        // Cognito's own name for the user, not what was typed.
        #expect(proof["USERNAME"] == Self.user.userId)
        #expect(proof["TIMESTAMP"] == "Mon Nov 2 03:04:05 UTC 2026")
        #expect(sent[2]["ChallengeResponses"] as? [String: String] == ["USERNAME": Self.user.userId, "SOFTWARE_TOKEN_MFA_CODE": "246810"])
        #expect(sent[2]["Session"] is String)

        // The password itself went nowhere: not in a request, not in an address, not in a header.
        for call in calls {
            let request = call.request
            let text = (request.url?.absoluteString ?? "") + String(decoding: request.httpBody ?? Data(), as: UTF8.self)
                + "\(request.allHTTPHeaderFields ?? [:])"
            #expect(!text.contains(Self.password))
            // Never the flow that sends it.
            #expect(!text.contains("USER_PASSWORD_AUTH"))
        }

        // The same session as the AWS sign-in page leaves, in the same store.
        let kept = try #require(try phone.store.load())
        #expect(kept == Tokens(accessToken: "SRP-ACCESS-1", refreshToken: "SRP-REFRESH-1", expiresAt: Self.now.addingTimeInterval(3600)))
        let stored = String(decoding: try JSONEncoder().encode(kept), as: UTF8.self)
        #expect(!stored.contains(Self.password) && !stored.contains("SRP-ID-1"))
        #expect(try await phone.session.accessToken() == "SRP-ACCESS-1")
        #expect(await phone.session.isSignedIn)
        #expect(await !phone.signIn.waitsForCode)
    }

    @Test func aWrongPasswordAndAnUnknownAddressGetTheSameAnswerAndNothingIsKept() async throws {
        let wrong = Self.phone(), unknown = Self.phone()
        #expect(await wrong.signIn.signIn(email: Self.user.email, password: "Not-The-Password-1") == .password(.wrongPassword))
        #expect(await unknown.signIn.signIn(email: "nobody@example.invalid", password: Self.password) == .password(.wrongPassword))
        for phone in [wrong, unknown] {
            #expect(Self.steps(phone) == ["InitiateAuth", "PASSWORD_VERIFIER"])
            #expect(try phone.store.load() == nil)
            // There is no step of the code to send one to.
            #expect(await phone.signIn.sendCode(Self.user.code) == .password(.expired))
        }
        #expect(SignInProblem.wrongPassword.words == "The e-mail address or password is wrong.")
    }

    @Test func anEmptyAddressOrPasswordIsNotSent() async {
        for (email, password) in [("", Self.password), ("   ", Self.password), (Self.user.email, "")] {
            let phone = Self.phone()
            #expect(await phone.signIn.signIn(email: email, password: password) == .password(.missing))
            #expect(phone.cognito.calls.isEmpty)
        }
    }

    @Test func aWrongCodeWaitsForTheNextAndASignInCognitoEndedStartsAgain() async throws {
        let phone = Self.phone()
        _ = await phone.signIn.signIn(email: Self.user.email, password: Self.password)
        #expect(await phone.signIn.sendCode("000000") == .code(.wrongCode))
        #expect(await phone.signIn.sendCode("12345") == .code(.wrongCode), "not six digits: not sent")
        #expect(await phone.signIn.sendCode(Self.user.code) == .done)
        #expect(Self.steps(phone).filter { $0 == "SOFTWARE_TOKEN_MFA" }.count == 2)

        // The third wrong code ends Cognito's session: what follows starts with the password.
        let unlucky = Self.phone()
        _ = await unlucky.signIn.signIn(email: Self.user.email, password: Self.password)
        for _ in 0..<3 {
            #expect(await unlucky.signIn.sendCode("000000") == .code(.wrongCode))
        }
        #expect(await unlucky.signIn.sendCode(Self.user.code) == .password(.expired))
        #expect(await unlucky.signIn.sendCode(Self.user.code) == .password(.expired), "and stays ended")
        #expect(try unlucky.store.load() == nil)

        // So does one that waited too long.
        let slow = Self.phone()
        _ = await slow.signIn.signIn(email: Self.user.email, password: Self.password)
        slow.cognito.now = Self.now.addingTimeInterval(16 * 60)
        #expect(await slow.signIn.sendCode(Self.user.code) == .password(.expired))
    }

    @Test func everyAnswerOfCognitoIsPutInTheConsolesWords() {
        let table: [(String, PasswordSignIn.Step, SignInProblem?)] = [
            ("NotAuthorizedException", .password, .wrongPassword),
            ("UserNotFoundException", .password, .wrongPassword),
            ("NotAuthorizedException", .code, .expired),
            ("CodeMismatchException", .code, .wrongCode),
            ("CodeMismatchException", .password, .failed),
            ("ExpiredCodeException", .code, .expired),
            ("TooManyRequestsException", .password, .tooMany),
            ("LimitExceededException", .code, .tooMany),
            ("TooManyFailedAttemptsException", .code, .tooMany),
            ("PasswordResetRequiredException", .password, nil),
            ("InternalErrorException", .password, .failed),
            ("", .code, .failed),
        ]
        for (name, step, problem) in table {
            #expect(SignInProblem.of(name, at: step) == problem, "\(name) at \(step)")
        }
        // The website's words, never Cognito's.
        #expect(SignInProblem.wrongCode.words == "That code is not right. Try the next one from your authenticator app.")
        #expect(SignInProblem.tooMany.words == "Too many tries. Wait a minute.")
        for problem in SignInProblem.allCases {
            #expect(!problem.words.contains("Exception") && !problem.words.contains("Cognito"))
        }
        // How Cognito names an error: in the body, perhaps with a namespace, or in a header.
        #expect(PasswordSignIn.errorName(["__type": "NotAuthorizedException", "message": "x"], header: nil) == "NotAuthorizedException")
        #expect(PasswordSignIn.errorName(["__type": "com.amazon.coral.service#UnknownOperationException"], header: nil) == "UnknownOperationException")
        #expect(PasswordSignIn.errorName(nil, header: "CodeMismatchException:http://internal.amazon.com/coral/") == "CodeMismatchException")
        #expect(PasswordSignIn.errorName(["__type": "<script>"], header: nil) == "")
        #expect(PasswordSignIn.errorName(nil, header: nil) == "")
    }

    @Test func refusalsAndLimitsAtEachStep() async throws {
        func at(_ operation: String, _ challenge: String?, _ name: String) -> @Sendable (String, [String: Any]) -> String? {
            { op, body in op == operation && (challenge == nil || body["ChallengeName"] as? String == challenge) ? name : nil }
        }
        let cases: [(@Sendable (String, [String: Any]) -> String?, Bool, PasswordSignInOutcome)] = [
            (at("InitiateAuth", nil, "TooManyRequestsException"), false, .password(.tooMany)),
            (at("RespondToAuthChallenge", "PASSWORD_VERIFIER", "LimitExceededException"), false, .password(.tooMany)),
            (at("InitiateAuth", nil, "PasswordResetRequiredException"), false, .elsewhere(challenge: "PASSWORD_RESET_REQUIRED")),
            (at("InitiateAuth", nil, "InternalErrorException"), false, .password(.failed)),
            (at("RespondToAuthChallenge", "SOFTWARE_TOKEN_MFA", "TooManyRequestsException"), true, .code(.tooMany)),
            (at("RespondToAuthChallenge", "SOFTWARE_TOKEN_MFA", "ExpiredCodeException"), true, .password(.expired)),
            (at("RespondToAuthChallenge", "SOFTWARE_TOKEN_MFA", "NotAuthorizedException"), true, .password(.expired)),
        ]
        for (fail, atCode, expected) in cases {
            let phone = Self.phone(fail: fail)
            var outcome = await phone.signIn.signIn(email: Self.user.email, password: Self.password)
            if atCode { outcome = await phone.signIn.sendCode(Self.user.code) }
            #expect(outcome == expected)
            #expect(try phone.store.load() == nil)
        }
    }

    @Test func theNetworkAndAnswersThatCannotBeRead() async throws {
        let offline = Self.phone()
        offline.cognito.raw = { _ in throw URLError(.notConnectedToInternet) }
        #expect(await offline.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.network))
        let garbled = Self.phone()
        garbled.cognito.raw = { _ in (200, Data("<html>".utf8)) }
        #expect(await garbled.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.failed))
        let bare = Self.phone()
        bare.cognito.raw = { _ in (500, Data("{}".utf8)) }
        #expect(await bare.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.failed))
        let odd = Self.phone()
        odd.cognito.raw = { _ in (200, json(["ChallengeName": "PASSWORD_VERIFIER", "ChallengeParameters": ["SRP_B": "zz"]])) }
        #expect(await odd.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.failed))

        // A code that went out but whose answer never came back keeps the step of the code.
        let flaky = Self.phone()
        _ = await flaky.signIn.signIn(email: Self.user.email, password: Self.password)
        flaky.cognito.raw = { _ in throw URLError(.timedOut) }
        #expect(await flaky.signIn.sendCode(Self.user.code) == .code(.network))
        flaky.cognito.raw = nil
        #expect(await flaky.signIn.sendCode(Self.user.code) == .done)
    }

    @Test func aStepThisScreenDoesNotDoGoesToTheAWSSignInPageWithNothingKept() async throws {
        for next in ["NEW_PASSWORD_REQUIRED", "MFA_SETUP", "CUSTOM_CHALLENGE"] {
            var user = Self.user
            user.next = next
            let phone = Self.phone(users: [user])
            #expect(await phone.signIn.signIn(email: Self.user.email, password: Self.password) == .elsewhere(challenge: next))
            #expect(try phone.store.load() == nil)
            #expect(await phone.signIn.sendCode(Self.user.code) == .password(.expired))
        }
        // A name that is not a name is not repeated.
        let strange = Self.phone()
        strange.cognito.raw = { _ in (200, json(["ChallengeName": "<b>x</b>", "Session": "s"])) }
        #expect(await strange.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.failed))
        // Nor are tokens that are not usable kept.
        let unusable = Self.phone()
        unusable.cognito.raw = { _ in (200, json(["AuthenticationResult": ["AccessToken": "a", "ExpiresIn": 3600, "TokenType": "MAC"]])) }
        #expect(await unusable.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.failed))
        #expect(try unusable.store.load() == nil)
    }

    @Test func theTimeInTheClaimGoesByCognitosClockWhereItsAnswerSaysIt() async {
        // This phone's clock is an hour behind.
        let behind = Self.now.addingTimeInterval(-3600)
        let told = Self.phone(phoneNow: behind, cognitoNow: Self.now, sendsDate: true)
        #expect(await told.signIn.signIn(email: Self.user.email, password: Self.password) == .code(nil))
        // Without the header the claim carries this phone's time, which Cognito refuses.
        let untold = Self.phone(phoneNow: behind, cognitoNow: Self.now)
        #expect(await untold.signIn.signIn(email: Self.user.email, password: Self.password) == .password(.wrongPassword))
    }

    @Test func cancellingDropsASignInThatWaitsForItsCode() async {
        let phone = Self.phone()
        _ = await phone.signIn.signIn(email: Self.user.email, password: Self.password)
        await phone.signIn.cancel()
        #expect(await phone.signIn.sendCode(Self.user.code) == .password(.expired))
        #expect(phone.cognito.calls.count == 2)
    }

    @Test func withoutAUserPoolInTheConfigurationThereIsNoOwnSignIn() {
        let session = AuthSession(config: testConfig, http: FakeHTTP { _ in (500, Data()) }, store: MemoryTokenStore())
        #expect(PasswordSignIn(config: testConfig, http: FakeHTTP { _ in (500, Data()) }, session: session) == nil)
    }

    /// One refresh path for both sign-ins: the token endpoint, as for the AWS sign-in page.
    @Test func tokensFromThisSignInAreRefreshedAtTheTokenEndpoint() async throws {
        final class Clock: @unchecked Sendable { var now = PasswordSignInTests.now }
        let clock = Clock()
        let cognito = CognitoStub(userPoolId: Self.pool, clientId: Self.client, users: [Self.user], now: Self.now)
        let refreshes = FakeHTTP { _ in (200, json(["access_token": "REFRESHED", "expires_in": 3600, "token_type": "Bearer"])) }
        let store = MemoryTokenStore()
        let session = AuthSession(config: Self.config, http: refreshes, store: store, now: { clock.now })
        let made = PasswordSignIn(config: Self.config, http: cognito, session: session, now: { clock.now })
        let signIn = try #require(made)
        _ = await signIn.signIn(email: Self.user.email, password: Self.password)
        #expect(await signIn.sendCode(Self.user.code) == .done)

        clock.now = clock.now.addingTimeInterval(3550)
        #expect(try await session.accessToken() == "REFRESHED")
        #expect(refreshes.requests.map { $0.url?.absoluteString } == ["https://login.test/oauth2/token"])
        #expect(formFields(refreshes.requests[0]) == ["grant_type": "refresh_token", "client_id": Self.client, "refresh_token": "SRP-REFRESH-1"])
        #expect(try store.load()?.refreshToken == "SRP-REFRESH-1")
    }
}

@Suite struct AuthSessionSignInAgainTests {
    /// A sign-in again that finishes while a refresh of the old session is on its way keeps its own
    /// tokens: their auth_time is the one a change from the phone needs.
    @Test func aSignInThatFinishesDuringARefreshWins() async throws {
        let gate = AsyncStream<Void>.makeStream()
        let http = FakeHTTP { _ in
            for await _ in gate.stream { break }
            return (200, json(["access_token": "old-refreshed", "expires_in": 3600, "token_type": "Bearer"]))
        }
        let store = MemoryTokenStore(Tokens(accessToken: "old", refreshToken: "r-old", expiresAt: Date(timeIntervalSince1970: 0)))
        let session = AuthSession(config: testConfig, http: http, store: store)
        async let refreshed = session.accessToken()
        while http.requests.isEmpty { await Task.yield() }
        let fresh = Tokens(accessToken: "new", refreshToken: "r-new", expiresAt: Date().addingTimeInterval(3600))
        try await session.completeSignIn(tokens: fresh)
        gate.continuation.yield()
        #expect(try await refreshed == "new")
        #expect(try store.load() == fresh)
        #expect(try await session.accessToken() == "new")

        // And a refused refresh of the old session does not sign the new one out.
        let gate2 = AsyncStream<Void>.makeStream()
        let slowRefusing = FakeHTTP { _ in
            for await _ in gate2.stream { break }
            return (400, json(["error": "invalid_grant"]))
        }
        let store2 = MemoryTokenStore(Tokens(accessToken: "old", refreshToken: "r-old", expiresAt: Date(timeIntervalSince1970: 0)))
        let session2 = AuthSession(config: testConfig, http: slowRefusing, store: store2)
        async let refused = session2.accessToken()
        while slowRefusing.requests.isEmpty { await Task.yield() }
        try await session2.completeSignIn(tokens: fresh)
        gate2.continuation.yield()
        #expect(try await refused == "new")
        #expect(try store2.load() == fresh)
    }
}
