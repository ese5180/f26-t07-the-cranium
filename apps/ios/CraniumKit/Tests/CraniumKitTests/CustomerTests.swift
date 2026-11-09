import Foundation
import Security
import Testing
@testable import CraniumKit

/// Made-up values for the customer side. Nothing here names the real stack.
let customerPool = CognitoUserPool(id: "us-east-1_customers", region: "us-east-1")!
let customerConfig = CustomerConfig(apiURL: URL(string: "https://customer.test")!, clientId: "customerphone1", pool: customerPool)

/// The customer side's configuration: four keys, all or none (docs/mobile-apps.md, "Configuration").
@Suite struct CustomerConfigTests {
    let staff: [String: String] = ["consoleUrl": "https://console.test", "loginDomain": "https://login.test",
                                   "mobileClientId": "abc123", "redirectUri": "cranium://signin",
                                   "region": "us-east-1", "userPoolId": "us-east-1_staff"]
    let customer: [String: String] = ["customerApiUrl": "https://customer.test/", "customerClientId": "phone123",
                                      "customerRegion": "us-east-1", "customerUserPoolId": "us-east-1_customers"]

    @Test func theFourKeysMakeTheCustomerSide() throws {
        let config = try CraniumConfig.parse(json(staff.merging(customer) { $1 }))
        let side = try #require(config.customer)
        #expect(side.apiURL.absoluteString == "https://customer.test")
        #expect(side.clientId == "phone123")
        #expect(side.pool.id == "us-east-1_customers")
        #expect(side.pool.endpoint.absoluteString == "https://cognito-idp.us-east-1.amazonaws.com/")
        // The staff pool is another one.
        #expect(config.userPool?.id == "us-east-1_staff")
    }

    @Test func withoutThemTheAppSignsInAdminsOnly() throws {
        #expect(try CraniumConfig.parse(json(staff)).customer == nil)
    }

    @Test func theExampleHasACustomerSide() throws {
        let example = ConfigTests.configDir.appendingPathComponent("cranium.example.json")
        let loaded = try CraniumConfig.load(deployed: nil, example: example)
        #expect(loaded.config.customer != nil)
        #expect(loaded.config.customer?.pool.id != loaded.config.userPool?.id)
    }

    @Test(arguments: ["customerApiUrl", "customerClientId", "customerRegion", "customerUserPoolId"])
    func oneMissingIsNamed(key: String) throws {
        var object = staff.merging(customer) { $1 }
        object[key] = nil
        #expect(throws: ConfigError.self) { try CraniumConfig.parse(json(object)) }
        do {
            _ = try CraniumConfig.parse(json(object))
        } catch let ConfigError.invalid(named, _) {
            #expect(named == key)
        }
    }

    @Test(arguments: [
        ("customerApiUrl", "http://secret-value.test"),
        ("customerApiUrl", "https://secret-value.test/api"),
        ("customerClientId", "secret value"),
        ("customerRegion", "secret-value"),
        ("customerUserPoolId", "eu-west-1_secretvalue"),
    ])
    func badValuesAreNamedButNeverRepeated(key: String, value: String) throws {
        var object = staff.merging(customer) { $1 }
        object[key] = value
        do {
            _ = try CraniumConfig.parse(json(object))
            Issue.record("\(key) = \(value) was accepted")
        } catch let error as ConfigError {
            guard case .invalid(let named, _) = error else {
                Issue.record("unexpected \(error)")
                return
            }
            #expect(named == key)
            #expect(!(error.errorDescription ?? "").contains("secret"))
        }
    }
}

/// What the customer API sends, read with the site's checks (cloud/web/test/customer.test.mjs).
@Suite struct CustomerReadTests {
    static var board: [String: Any] { [
        "id": "0123456789abcdef", "name": "Living room deck", "boardName": "CRADA01", "status": "online", "online": true,
        "lastSeen": "2026-11-04T11:59:40.000Z", "firmware": ["version": "1.11.2+0", "confirmed": true],
        "update": ["state": "idle", "progress": 0, "last": "succeeded"], "rssi": -58, "uptime": 600, "location": NSNull(),
        "since": "2026-11-01T10:00:00.000Z",
    ] }

    static func with(_ changes: [String: Any]) -> [String: Any] {
        board.merging(changes) { $1 }
    }

    @Test func aBoardIsReadIntoAKnownShape() throws {
        let read = try #require(CustomerRead.board(Self.board))
        #expect(read == CustomerBoard(id: "0123456789abcdef", name: "Living room deck", boardName: "CRADA01", status: "online",
                                      online: true, lastSeen: "2026-11-04T11:59:40.000Z",
                                      firmware: .init(version: "1.11.2+0", confirmed: true),
                                      update: .init(state: "idle", progress: 0, last: "succeeded"), rssi: -58, uptime: 600,
                                      since: "2026-11-01T10:00:00.000Z"))
        // Addressed by the assignment id only: a thing name is not one.
        #expect(CustomerRead.board(Self.with(["id": "cranium-0123456789abcdef"])) == nil)
        #expect(CustomerRead.board(Self.with(["id": "0123456789ABCDEF"])) == nil)
        #expect(CustomerRead.board(Self.with(["status": "hacked"])) == nil)
        #expect(CustomerRead.board("not an object") == nil)
    }

    @Test func anythingElseFromTheAPIIsLeftOutOrDropped() throws {
        let odd = try #require(CustomerRead.board(Self.with([
            "name": "Deck\u{0}\u{202E}<b>", "firmware": ["version": "1.2"], "rssi": 5, "thing": "cranium-x", "mac": "aa",
            "uptime": -1, "online": 1, "lastSeen": "yesterday", "boardName": "not a name!",
            "update": ["state": "downloading", "progress": 140, "last": "exploded"],
        ])))
        #expect(odd.name == "Deck<b>")
        #expect(odd.firmware == nil && odd.rssi == nil && odd.uptime == nil && odd.lastSeen == nil && odd.boardName == nil)
        #expect(odd.online == false)
        #expect(odd.update == .init(state: "downloading", progress: 0, last: "none"))
        #expect(CustomerRead.board(Self.with(["name": NSNull()]))?.name == nil)
        #expect(CustomerRead.board(Self.with(["name": String(repeating: "x", count: 60)]))?.name?.count == 40)
    }

    @Test func eventsAreTheirTypedFieldsOnly() throws {
        let at = "2026-11-04T11:59:40.000Z"
        #expect(CustomerRead.event(["at": at, "board": "0123456789abcdef", "kind": "health", "what": "memory"]) == nil)
        let changed = try #require(CustomerRead.event([
            "at": at, "board": "0123456789abcdef", "kind": "firmware", "what": "changed", "version": "1.11.3+0",
            "from": "1.11.2+0", "confirmed": false, "text": "x", "job": "cranium-1-11-3",
        ]))
        #expect(changed == CustomerEvent(at: at, board: "0123456789abcdef", kind: "firmware", what: "changed",
                                         version: "1.11.3+0", from: "1.11.2+0", confirmed: false))
        #expect(CustomerRead.event(["at": at, "board": "cranium-x", "kind": "firmware", "what": "changed"]) == nil)
        #expect(CustomerRead.event(["at": "2026-11-04", "board": "0123456789abcdef", "kind": "firmware", "what": "changed"]) == nil)
        let step = try #require(CustomerRead.event(["at": "2026-11-04T11:59:40Z", "board": "0123456789abcdef", "kind": "update",
                                                    "what": "step", "state": "downloading", "progress": 40, "result": "BAD!"]))
        #expect(step.state == "downloading" && step.progress == 40 && step.result == nil)
    }
}

/// The customer API's client: the customer's token, the customer API's address, and a board by its id.
@Suite struct CustomerAPITests {
    @Test func itReadsTheCustomerAPIWithTheCustomersTokenOnly() async throws {
        let http = FakeHTTP { request in
            switch request.url!.path {
            case "/api/c/boards": return (200, json(["boards": [CustomerReadTests.board, ["id": "nope"]], "generatedAt": "x"]))
            case "/api/c/me": return (200, json(["email": "ada@example.invalid", "name": "Ada", "boards": 1]))
            case "/api/c/activity": return (200, json(["activity": [] as [Any]]))
            case "/api/c/boards/0123456789abcdef": return (200, json(["board": CustomerReadTests.board, "activity": [] as [Any]]))
            default: return (404, json(["error": ["code": "not_found", "message": "There is nothing at this address."]]))
            }
        }
        let api = CustomerAPI(config: customerConfig, http: http, tokens: FixedToken(token: "CUSTOMER-TOKEN"))
        #expect(try await api.boards().map(\.id) == ["0123456789abcdef"])
        #expect(try await api.me() == CustomerMe(email: "ada@example.invalid", name: "Ada", boards: 1))
        #expect(try await api.activity().isEmpty)
        #expect(try await api.board(id: "0123456789abcdef").board.name == "Living room deck")
        for request in http.requests {
            #expect(request.url!.host == "customer.test", "never the console's address")
            #expect(request.url!.path.hasPrefix("/api/c/"))
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer CUSTOMER-TOKEN")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        }
    }

    @Test func aBoardIsAskedForOnlyByItsAssignmentId() async {
        let http = FakeHTTP { _ in (200, json([:])) }
        let api = CustomerAPI(config: customerConfig, http: http, tokens: FixedToken())
        for id in ["cranium-00000000000000aa", "../me", "0123456789ABCDEF", ""] {
            await #expect(throws: CustomerAPIError.notYours) { try await api.board(id: id) }
        }
        #expect(http.requests.isEmpty)
    }

    @Test func aRefusalIsTheServersWordsCleanedAndA401RefreshesOnce() async throws {
        let refused = FakeHTTP { _ in
            (404, json(["error": ["code": "not_your_board", "message": "There is no board of yours at this address.\u{0}\u{202E}"]]))
        }
        let api = CustomerAPI(config: customerConfig, http: refused, tokens: FixedToken())
        await #expect(throws: CustomerAPIError(status: 404, code: "not_your_board", message: "There is no board of yours at this address.")) {
            try await api.board(id: "0123456789abcdef")
        }
        let odd = FakeHTTP { _ in (500, json(["error": ["code": "Not A Word", "message": ""]])) }
        await #expect(throws: CustomerAPIError(status: 500, code: "http", message: "Something went wrong.")) {
            try await CustomerAPI(config: customerConfig, http: odd, tokens: FixedToken()).boards()
        }
        let garbage = FakeHTTP { _ in (502, Data("<html>".utf8)) }
        await #expect(throws: CustomerAPIError.unreadable) {
            try await CustomerAPI(config: customerConfig, http: garbage, tokens: FixedToken()).boards()
        }
        let noList = FakeHTTP { _ in (200, json(["boards": "x"])) }
        await #expect(throws: CustomerAPIError.unreadable) {
            try await CustomerAPI(config: customerConfig, http: noList, tokens: FixedToken()).boards()
        }
        let offline = FakeHTTP { _ in throw URLError(.notConnectedToInternet) }
        await #expect(throws: CustomerAPIError.network) {
            try await CustomerAPI(config: customerConfig, http: offline, tokens: FixedToken()).boards()
        }
        #expect(CustomerAPIError.network.message == "Cranium could not be reached. Check the connection.")

        let once = FakeHTTP { request in
            request.value(forHTTPHeaderField: "Authorization") == "Bearer token-2" ? (200, json(["boards": [] as [Any]])) : (401, json([:]))
        }
        #expect(try await CustomerAPI(config: customerConfig, http: once, tokens: FixedToken()).boards().isEmpty)
        #expect(once.requests.count == 2)
        let never = FakeHTTP { _ in (401, json([:])) }
        await #expect(throws: AuthError.sessionExpired) {
            try await CustomerAPI(config: customerConfig, http: never, tokens: FixedToken()).boards()
        }
        #expect(never.requests.count == 2)
    }
}

/// A customer's session and an admin's never share anything that is kept, and a customer's is
/// renewed and revoked through the user pool API, which is all the customer pool has.
@Suite struct CustomerSessionTests {
    func stub(next: String? = "NONE", code: String = "") -> CognitoStub {
        CognitoStub(userPoolId: customerPool.id, clientId: customerConfig.clientId,
                    users: [.init(email: "ada@example.invalid", userId: "ada-id", password: "first password", code: code, next: next)],
                    now: Date())
    }

    @Test func theCustomersTokensAreKeptApartFromTheAdmins() async throws {
        let cognito = stub()
        let staffStore = MemoryTokenStore(Tokens(accessToken: "STAFF", refreshToken: "STAFF-REFRESH", expiresAt: Date().addingTimeInterval(3000)))
        let customerStore = MemoryTokenStore()
        let customer = AuthSession(customer: customerConfig, http: cognito, store: customerStore)
        let flow = PasswordSignIn(customer: customerConfig, http: cognito, session: customer)
        #expect(await flow.signIn(email: " Ada@Example.invalid ", password: "first password") == .done)
        #expect(try customerStore.load()?.accessToken == "SRP-ACCESS-1")
        #expect(try staffStore.load()?.accessToken == "STAFF", "the admin's session is untouched")
        // Signed in on the customer pool with the phone apps' client of it, never the staff one's.
        #expect(cognito.calls.allSatisfy { $0.body["ClientId"] as? String == customerConfig.clientId })
        #expect(cognito.calls.allSatisfy { $0.request.url == customerPool.endpoint })

        await customer.signOut()
        #expect(try customerStore.load() == nil)
        #expect(try staffStore.load()?.accessToken == "STAFF", "a customer's sign-out leaves the admin signed in")
        #expect(cognito.revoked == ["SRP-REFRESH-1"])
        #expect(cognito.calls.last?.operation == "RevokeToken")
        // In the Keychain: a service of its own.
        #expect(CustomerStorage.service != KeychainBiometricGate.service)
        #expect(KeychainBiometricGate.customerService == CustomerStorage.service)
        let item = try #require(KeychainBiometricGate.newItem("t", service: KeychainBiometricGate.customerService))
        #expect(item[kSecAttrService as String] as? String == "com.craniumiot.cranium.customer")
        #expect(DefaultsBiometricSettings.customerKey != DefaultsBiometricSettings.key)
        #expect(KeychainBiometricGate.customerDomainStateKey != KeychainBiometricGate.domainStateKey)
    }

    @Test func aCustomersSessionIsRenewedThroughTheUserPoolAPI() async throws {
        let clock = CustomerClock()
        let cognito = CognitoStub(userPoolId: customerPool.id, clientId: customerConfig.clientId,
                                  users: [.init(email: "ada@example.invalid", userId: "ada-id", password: "first password", code: "", next: "NONE")],
                                  now: clock.now)
        let customer = AuthSession(customer: customerConfig, http: cognito, store: MemoryTokenStore(), now: { clock.now })
        let flow = PasswordSignIn(customer: customerConfig, http: cognito, session: customer, now: { clock.now })
        #expect(await flow.signIn(email: "ada@example.invalid", password: "first password") == .done)
        clock.now = clock.now.addingTimeInterval(3590)
        #expect(try await customer.accessToken() == "SRP-ACCESS-2")
        let refresh = try #require(cognito.calls.last)
        #expect(refresh.operation == "InitiateAuth")
        #expect(refresh.body["AuthFlow"] as? String == "REFRESH_TOKEN_AUTH")
        #expect((refresh.body["AuthParameters"] as? [String: Any])?["REFRESH_TOKEN"] as? String == "SRP-REFRESH-1")
        // The refresh token is kept: Cognito sends none back.
        #expect(await customer.hasRefreshToken)
        // A refresh token Cognito no longer takes ends the session.
        await customer.signOut()
        let again = AuthSession(customer: customerConfig, http: cognito,
                                store: MemoryTokenStore(Tokens(accessToken: "old", refreshToken: "SRP-REFRESH-1",
                                                               expiresAt: clock.now.addingTimeInterval(-1), signedInAt: clock.now)),
                                now: { clock.now })
        await #expect(throws: AuthError.sessionExpired) { try await again.accessToken() }
        #expect(await !again.isSignedIn)
        // And it has no AWS sign-in page.
        await #expect(throws: AuthError.self) { try await again.beginSignIn() }
    }

    @Test func aFirstSignInChoosesItsPasswordOnTheScreen() async throws {
        let cognito = stub(next: "NEW_PASSWORD_REQUIRED", code: "")
        let customer = AuthSession(customer: customerConfig, http: cognito, store: MemoryTokenStore())
        let flow = PasswordSignIn(customer: customerConfig, http: cognito, session: customer)
        #expect(await flow.signIn(email: "ada@example.invalid", password: "first password") == .newPassword(nil))
        #expect(await flow.sendCode("123456") == .password(.expired), "not the step of the code")
        // Signing in again starts over, with a new session for the new password.
        #expect(await flow.signIn(email: "ada@example.invalid", password: "first password") == .newPassword(nil))
        #expect(await flow.sendNewPassword("") == .newPassword(.missingNew))
        #expect(await flow.sendNewPassword("short") == .newPassword(.weakPassword))
        #expect(await flow.sendNewPassword("a much longer one") == .done)
        #expect(cognito.chosen["ada-id"] == "a much longer one")
        let answer = try #require(cognito.calls.last(where: { $0.challenge == "NEW_PASSWORD_REQUIRED" }))
        #expect((answer.body["ChallengeResponses"] as? [String: Any])?["USERNAME"] as? String == "ada-id")
        #expect(await customer.isSignedIn)
    }

    @Test func aNewPasswordThenTheCode() async throws {
        let cognito = stub(next: "NEW_PASSWORD_REQUIRED", code: "246810")
        let customer = AuthSession(customer: customerConfig, http: cognito, store: MemoryTokenStore())
        let flow = PasswordSignIn(customer: customerConfig, http: cognito, session: customer)
        #expect(await flow.signIn(email: "ada@example.invalid", password: "first password") == .newPassword(nil))
        #expect(await flow.sendNewPassword("a much longer one") == .code(nil))
        #expect(await flow.sendCode("246810") == .done)
    }

    @Test func theStaffSignInStillLeavesANewPasswordToTheAWSPage() async {
        let cognito = CognitoStub(userPoolId: "us-east-1_staff", clientId: "testclient123",
                                  users: [.init(email: "a@b.test", userId: "a", password: "pw", code: "1", next: "NEW_PASSWORD_REQUIRED")],
                                  now: Date())
        let config = CraniumConfig(consoleURL: testConfig.consoleURL, loginDomain: testConfig.loginDomain, mobileClientId: "testclient123",
                                   userPool: CognitoUserPool(id: "us-east-1_staff", region: "us-east-1"))
        let session = AuthSession(config: config, http: cognito, store: MemoryTokenStore())
        let flow = PasswordSignIn(config: config, http: cognito, session: session)!
        #expect(await flow.signIn(email: "a@b.test", password: "pw") == .elsewhere(challenge: "NEW_PASSWORD_REQUIRED"))
    }

    @Test func theProblemsOfANewPasswordAreTheWebsites() {
        #expect(SignInProblem.of("InvalidPasswordException", at: .newPassword) == .weakPassword)
        #expect(SignInProblem.of("InvalidPasswordException", at: .password) == .failed)
        #expect(SignInProblem.of("NotAuthorizedException", at: .newPassword) == .expired)
        #expect(SignInProblem.of("NotAuthorizedException", at: .password) == .wrongPassword)
        #expect(SignInProblem.weakPassword.words == "That password is not accepted. Choose one of at least 10 characters.")
    }
}

final class CustomerClock: @unchecked Sendable {
    private let lock = NSLock()
    private var _now = Date(timeIntervalSince1970: 1_793_534_400)
    var now: Date {
        get { lock.withLock { _now } }
        set { lock.withLock { _now = newValue } }
    }
}

/// The customer's sign-in screen and "Forgot your password?", step by step.
@MainActor @Suite struct CustomerSignInModelTests {
    @Test func passwordThenCode() async {
        let cognito = CognitoStub(userPoolId: customerPool.id, clientId: customerConfig.clientId,
                                  users: [.init(email: "ada@example.invalid", userId: "ada-id", password: "pw", code: "135790")],
                                  now: Date())
        let session = AuthSession(customer: customerConfig, http: cognito, store: MemoryTokenStore())
        let model = CustomerSignInModel(flow: PasswordSignIn(customer: customerConfig, http: cognito, session: session))
        #expect(model.isSetUp)
        model.email = "ada@example.invalid"
        await model.submitPassword("wrong")
        #expect(model.step == .password && model.problemWords == "The e-mail address or password is wrong.")
        await model.submitPassword("pw")
        #expect(model.step == .code && model.problem == nil)
        model.editCode("13579")
        await model.submitCode()
        #expect(model.problemWords == "Type all six digits of the code.")
        model.editCode("135790")
        await model.pendingSubmission?.value
        #expect(model.signedIn)
    }

    @Test func aFirstSignInsNewPasswordIsCheckedHereFirst() async {
        let cognito = CognitoStub(userPoolId: customerPool.id, clientId: customerConfig.clientId,
                                  users: [.init(email: "ada@example.invalid", userId: "ada-id", password: "pw", code: "", next: "NEW_PASSWORD_REQUIRED")],
                                  now: Date())
        let session = AuthSession(customer: customerConfig, http: cognito, store: MemoryTokenStore())
        let model = CustomerSignInModel(flow: PasswordSignIn(customer: customerConfig, http: cognito, session: session),
                                        email: "ada@example.invalid")
        await model.submitPassword("pw")
        #expect(model.step == .newPassword)
        await model.submitNewPassword("short", again: "short")
        #expect(model.problemWords == "A password needs at least 10 characters.")
        await model.submitNewPassword("long enough", again: "long enougj")
        #expect(model.problemWords == "The two new passwords are not the same.")
        #expect(!cognito.calls.contains { $0.challenge == "NEW_PASSWORD_REQUIRED" }, "nothing sent until it will do")
        await model.submitNewPassword("long enough", again: "long enough")
        #expect(model.signedIn)
    }

    @Test func anotherStepSaysToResetThePassword() async {
        let cognito = CognitoStub(userPoolId: customerPool.id, clientId: customerConfig.clientId,
                                  users: [.init(email: "ada@example.invalid", userId: "ada-id", password: "pw", code: "", next: "MFA_SETUP")],
                                  now: Date())
        let session = AuthSession(customer: customerConfig, http: cognito, store: MemoryTokenStore())
        let model = CustomerSignInModel(flow: PasswordSignIn(customer: customerConfig, http: cognito, session: session),
                                        email: "ada@example.invalid")
        await model.submitPassword("pw")
        #expect(model.step == .elsewhere)
        #expect(CustomerWords.elsewhereLead == "Your account needs a new password first. Choose one with \"Forgot your password?\".")
        model.startOver()
        #expect(model.step == .password)
        #expect(!CustomerSignInModel(flow: nil).isSetUp)
    }

    @Test func forgotYourPassword() async {
        let http = FakeHTTP { request in
            let target = request.value(forHTTPHeaderField: "X-Amz-Target") ?? ""
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            if target.hasSuffix("ConfirmForgotPassword") {
                return body["ConfirmationCode"] as? String == "111111" ? (200, json([:])) : (400, json(["__type": "CodeMismatchException"]))
            }
            return (200, json(["CodeDeliveryDetails": [:] as [String: Any]]))
        }
        let model = ForgotPasswordModel(account: CustomerAccount(config: customerConfig, http: http, accessToken: { nil }))
        await model.submitEmail()
        #expect(model.problem == .missingEmail)
        model.email = "  Ada@Example.invalid "
        await model.submitEmail()
        #expect(model.step == .code)
        let asked = (try? JSONSerialization.jsonObject(with: http.requests.last?.httpBody ?? Data())) as? [String: Any]
        #expect(asked?["Username"] as? String == "ada@example.invalid")
        #expect(asked?["ClientId"] as? String == customerConfig.clientId)
        await model.submitReset(password: "long enough", again: "long enough")
        #expect(model.problem == .shortCode)
        model.editCode("222222")
        await model.submitReset(password: "long enough", again: "long enough")
        #expect(model.problem == .wrongCode && model.digits.isEmpty)
        model.editCode("111111")
        await model.submitReset(password: "long enough", again: "long enough")
        #expect(model.step == .done)
    }
}

/// One sign-in for everybody (OneSignIn, customer-core.js `signInEither`): the team's pool first, then the customer pool.
@MainActor @Suite struct OneSignInTests {
    static let teamPool = CognitoUserPool(id: "us-east-1_staff", region: "us-east-1")!
    static let teamConfig = CraniumConfig(consoleURL: testConfig.consoleURL, loginDomain: testConfig.loginDomain,
                                          mobileClientId: "testclient123", userPool: teamPool)

    /// Two pools, each behind its own stand-in: the team's (code always) and the customer pool's.
    func pools(customerNext: String? = "NONE") -> (team: CognitoStub, customers: CognitoStub, model: CustomerSignInModel,
                                                   teamStore: MemoryTokenStore, customerStore: MemoryTokenStore) {
        let team = CognitoStub(userPoolId: Self.teamPool.id, clientId: "testclient123",
                               users: [.init(email: "manager@example.invalid", userId: "m-id", password: "team pw", code: "135790")],
                               now: Date())
        let customers = CognitoStub(userPoolId: customerPool.id, clientId: customerConfig.clientId,
                                    users: [.init(email: "ada@example.invalid", userId: "ada-id", password: "her pw", code: "246810",
                                                  next: customerNext)],
                                    now: Date())
        let teamStore = MemoryTokenStore(), customerStore = MemoryTokenStore()
        let teamFlow = PasswordSignIn(config: Self.teamConfig, http: team,
                                      session: AuthSession(config: Self.teamConfig, http: team, store: teamStore))!
        let customerFlow = PasswordSignIn(customer: customerConfig, http: customers,
                                          session: AuthSession(customer: customerConfig, http: customers, store: customerStore))
        return (team, customers, CustomerSignInModel(flow: customerFlow, team: teamFlow), teamStore, customerStore)
    }

    func initiations(_ stub: CognitoStub) -> [CognitoStub.Call] { stub.calls.filter { $0.operation == "InitiateAuth" } }

    @Test func aTeamAccountSignsInAtTheTeamPoolWithItsCodeAndTheCustomerPoolIsNeverAsked() async throws {
        let world = pools()
        // Typed with capitals: the team pool's names are lower case.
        world.model.email = " Manager@Example.INVALID "
        await world.model.submitPassword("team pw")
        #expect(world.model.step == .code && world.model.account == .team)
        #expect(initiations(world.team).first?.body["AuthParameters"].flatMap { ($0 as? [String: Any])?["USERNAME"] as? String }
                == "manager@example.invalid")
        world.model.editCode("000000")
        await world.model.pendingSubmission?.value
        #expect(world.model.problem == "wrong-code")
        world.model.editCode("135790")
        await world.model.pendingSubmission?.value
        #expect(world.model.signedIn && world.model.account == .team)
        #expect(try world.teamStore.load() != nil && world.customerStore.load() == nil)
        #expect(initiations(world.customers).isEmpty)
    }

    @Test func aCustomerIsRefusedByTheTeamPoolThenSignedInByTheirOwnOneTryEach() async throws {
        let world = pools()
        world.model.email = "ada@example.invalid"
        await world.model.submitPassword("her pw")
        #expect(world.model.signedIn && world.model.account == .customer)
        #expect(initiations(world.team).count == 1 && initiations(world.customers).count == 1)
        #expect(try world.customerStore.load() != nil && world.teamStore.load() == nil)
        // A first sign-in's new password stays the customer pool's step.
        let invited = pools(customerNext: "NEW_PASSWORD_REQUIRED")
        invited.model.email = "ada@example.invalid"
        await invited.model.submitPassword("her pw")
        #expect(invited.model.step == .newPassword && invited.model.account == .customer)
    }

    @Test func aWrongPasswordAndAnUnknownAddressGetTheSameWordsAndOneTryAtEachPool() async {
        for (email, password) in [("manager@example.invalid", "wrong"), ("ada@example.invalid", "wrong"), ("nobody@example.invalid", "x")] {
            let world = pools()
            world.model.email = email
            await world.model.submitPassword(password)
            #expect(world.model.step == .password && world.model.problemWords == "The e-mail address or password is wrong.")
            #expect(initiations(world.team).count == 1 && initiations(world.customers).count == 1)
        }
        // The team pool's throttling stops there, with its words.
        let throttled = await OneSignIn.first(team: { _, _ in .password(.tooMany) }, customer: { _, _ in .done },
                                              email: "a@b", password: "p")
        #expect(throttled.account == .team && throttled.outcome == .password(.tooMany))
        // Only one pool in the build: that one.
        let only = await OneSignIn.first(team: nil, customer: { _, _ in .password(.wrongPassword) }, email: "a@b", password: "p")
        #expect(only.outcome == .password(.wrongPassword))
        #expect(!CustomerSignInModel(flow: nil, team: nil).isSetUp)
    }

    @Test func forgotYourPasswordAsksBothPoolsOnceAndSaysTheSameEitherWay() async {
        // The team pool hides unknown names: a code "went out", and any code is not right.
        let team = FakeHTTP { request in
            let target = request.value(forHTTPHeaderField: "X-Amz-Target") ?? ""
            return target.hasSuffix("ConfirmForgotPassword") ? (400, json(["__type": "CodeMismatchException"]))
                : (200, json(["CodeDeliveryDetails": [:] as [String: Any]]))
        }
        let customers = FakeHTTP { request in
            let target = request.value(forHTTPHeaderField: "X-Amz-Target") ?? ""
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            if target.hasSuffix("ConfirmForgotPassword") {
                if body["ConfirmationCode"] as? String == "999999" { return (400, json(["__type": "ExpiredCodeException"])) }
                return body["ConfirmationCode"] as? String == "111111" ? (200, json([:])) : (400, json(["__type": "CodeMismatchException"]))
            }
            return (200, json(["CodeDeliveryDetails": [:] as [String: Any]]))
        }
        let model = ForgotPasswordModel(account: CustomerAccount(config: customerConfig, http: customers, accessToken: { nil }),
                                        team: CustomerAccount(teamPool: Self.teamPool, clientId: "testclient123", http: team))
        await model.submitEmail()
        #expect(model.problem == .missingEmail && team.requests.isEmpty && customers.requests.isEmpty)
        model.email = " Ada@Example.invalid"
        await model.submitEmail()
        #expect(model.step == .code && team.requests.count == 1 && customers.requests.count == 1)
        let asked = (try? JSONSerialization.jsonObject(with: team.requests[0].httpBody ?? Data())) as? [String: Any]
        #expect(asked?["Username"] as? String == "ada@example.invalid" && asked?["ClientId"] as? String == "testclient123")
        model.editCode("222222")
        await model.submitReset(password: "long enough", again: "long enough")
        #expect(model.problem == .wrongCode)
        model.editCode("999999")
        await model.submitReset(password: "long enough", again: "long enough")
        #expect(model.problem == .expiredCode, "the specific refusal, not the other pool's vague one")
        model.editCode("111111")
        await model.submitReset(password: "long enough", again: "long enough")
        #expect(model.step == .done)
        #expect(team.requests.count == 4 && customers.requests.count == 4)
        #expect(OneSignIn.plainest([.wrongCode, .tooMany]) == .tooMany)
        #expect(OneSignIn.plainest([.failed, .wrongCode]) == .wrongCode)
    }

    @Test func aTeamAccountsResetSettlesAtTheTeamPool() async {
        let team = FakeHTTP { _ in (200, json([:])) }
        let customers = FakeHTTP { _ in (400, json(["__type": "CodeMismatchException"])) }
        let result = await OneSignIn.confirmForgotPassword(
            team: CustomerAccount(teamPool: Self.teamPool, clientId: "testclient123", http: team),
            customer: CustomerAccount(config: customerConfig, http: customers, accessToken: { nil }),
            email: "manager@example.invalid", code: "123456", password: "long enough")
        #expect(result == .ok(true) && customers.requests.isEmpty)
    }
}

/// A customer's own account at Cognito, with their own access token.
@Suite struct CustomerAccountTests {
    @Test func theCallsCarryTheCustomersAccessTokenAndCognitosAnswerCounts() async {
        let http = FakeHTTP { request in
            let target = (request.value(forHTTPHeaderField: "X-Amz-Target") ?? "").replacingOccurrences(of: "AWSCognitoIdentityProviderService.", with: "")
            switch target {
            case "GetUser":
                return (200, json(["UserAttributes": [["Name": "email", "Value": "ada@example.invalid"], ["Name": "name", "Value": "Ada"]],
                                   "UserMFASettingList": ["SOFTWARE_TOKEN_MFA"]]))
            case "ChangePassword": return (400, json(["__type": "NotAuthorizedException"]))
            case "AssociateSoftwareToken": return (200, json(["SecretCode": "ABCDEFGHIJKLMNOP"]))
            case "VerifySoftwareToken": return (200, json(["Status": "SUCCESS"]))
            case "SetUserMFAPreference": return (200, json([:]))
            default: return (400, json(["__type": "UnknownOperationException"]))
            }
        }
        let account = CustomerAccount(config: customerConfig, http: http, accessToken: { "CUSTOMER-ACCESS" })
        #expect(await account.profile() == .ok(AccountProfile(email: "ada@example.invalid", name: "Ada", authenticator: true)))
        #expect(await account.changePassword(current: "x", next: "long enough") == .problem(.wrongPassword))
        #expect(await account.changePassword(current: "", next: "long enough") == .problem(.wrongPassword))
        #expect(await account.startAuthenticator() == .ok("ABCDEFGHIJKLMNOP"))
        #expect(await account.confirmAuthenticator(code: "12345") == .problem(.shortCode))
        #expect(await account.confirmAuthenticator(code: "123456") == .ok(true))
        #expect(await account.stopAuthenticator() == .ok(true))
        for request in http.requests {
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
            #expect(body?["AccessToken"] as? String == "CUSTOMER-ACCESS")
            #expect(request.url == customerPool.endpoint)
        }
        let verify = http.requests.first { $0.value(forHTTPHeaderField: "X-Amz-Target")?.hasSuffix("VerifySoftwareToken") == true }
        let verifyBody = (try? JSONSerialization.jsonObject(with: verify?.httpBody ?? Data())) as? [String: Any]
        #expect(verifyBody?["FriendlyDeviceName"] as? String == "Cranium")
        let ended = CustomerAccount(config: customerConfig, http: http, accessToken: { nil })
        #expect(await ended.profile() == .problem(.sessionEnded))
    }

    @Test func theSiteWordsAndHelpers() {
        #expect(AccountProblem.ofNewPassword("short", again: "short") == .tooShort)
        #expect(AccountProblem.ofNewPassword("long enough", again: "long enougj") == .mismatch)
        #expect(AccountProblem.ofNewPassword("long enough", again: "long enough") == nil)
        #expect(CustomerAccount.groupSecret("ABCDEFGHIJKLMNOP") == "ABCD EFGH IJKL MNOP")
        #expect(CustomerAccount.groupSecret("not a secret") == "")
        #expect(CustomerAccount.otpauthURI(secret: "ABCDEFGHIJKLMNOP", email: "ada@example.invalid")
                == "otpauth://totp/Cranium%3Aada%40example.invalid?secret=ABCDEFGHIJKLMNOP&issuer=Cranium")
        #expect(CustomerAccount.otpauthURI(secret: "javascript:alert(1)", email: "x") == nil)
        #expect(AccountProblem.of("NotAuthorizedException", step: "change") == .wrongPassword)
        #expect(AccountProblem.of("NotAuthorizedException", step: "forgot") == .notYet)
        #expect(AccountProblem.of("NotAuthorizedException") == .sessionEnded)
        #expect(AccountProblem.of("CodeMismatchException") == .wrongCode)
        #expect(AccountProblem.of("Whatever") == .failed)
        for problem in AccountProblem.allCases { #expect(problem.words.hasSuffix(".")) }
    }
}
