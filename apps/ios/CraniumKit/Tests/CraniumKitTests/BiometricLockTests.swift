import Foundation
import LocalAuthentication
import Security
import Testing
@testable import CraniumKit

/// A JWT whose payload says when the person signed in. Unsigned: the app only reads its own token.
func accessToken(signedInAt: Date, sub: String = "user-1") -> String {
    func part(_ object: [String: Any]) -> String {
        try! JSONSerialization.data(withJSONObject: object).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    return part(["alg": "RS256", "kid": "test"]) + "." +
        part(["sub": sub, "auth_time": Int(signedInAt.timeIntervalSince1970), "scope": "cranium/console"]) + ".c2lnbmF0dXJl"
}

final class PhoneClock: @unchecked Sendable {
    var now: Date
    init(_ now: Date) { self.now = now }
}

/// A phone: the token store, the gate, the setting, the session and the lock, with a clock.
@MainActor
struct Phone {
    nonisolated static let start = Date(timeIntervalSince1970: 1_793_588_645)  // 2026-11-02T03:04:05Z
    nonisolated static let account = "4c1e8a5e-7f1d-4b8e-9a51-1c2d3e4f5a6b"

    let clock: PhoneClock
    let store: MemoryTokenStore
    let gate: MemoryBiometricGate
    let settings: MemoryBiometricSettings
    let refreshes: FakeHTTP
    let session: AuthSession
    let lock: BiometricLock

    /// Signed in at `start` (refresh token "r1") unless `signedIn` is false; Face ID on for `account`
    /// when `on`, with "r1" behind it and none in the store.
    init(signedIn: Bool = true, on: Bool = false, at now: Date = Phone.start, gate: MemoryBiometricGate = MemoryBiometricGate()) {
        clock = PhoneClock(now)
        let tokens = Tokens(accessToken: accessToken(signedInAt: Phone.start), refreshToken: on ? nil : "r1",
                            expiresAt: Phone.start.addingTimeInterval(3600), signedInAt: Phone.start)
        store = MemoryTokenStore(signedIn ? tokens : nil)
        self.gate = gate
        if on { _ = gate.replace("r1") }
        settings = MemoryBiometricSettings(BiometricSettings(owner: on ? BiometricSettings.key(for: Phone.account) : nil,
                                                             offered: on ? [BiometricSettings.key(for: Phone.account)] : []))
        refreshes = FakeHTTP { request in
            let token = formFields(request)["refresh_token"] ?? ""
            return (200, json(["access_token": "refreshed-with-\(token)", "expires_in": 3600, "token_type": "Bearer"]))
        }
        let clock = clock
        session = AuthSession(config: testConfig, http: refreshes, store: store,
                              refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(settings),
                              now: { clock.now })
        lock = BiometricLock(gate: gate, settings: settings, session: session, now: { clock.now })
    }

    var setting: BiometricSettings { settings.load() }
    var storedRefreshToken: String? { (try? store.load())??.refreshToken }
}

@MainActor
@Suite struct BiometricLockTests {
    // MARK: Opening the app

    @Test func signedOutOpensOnTheSignInScreenAndKeepsNothingBehindFaceID() async throws {
        let phone = Phone(signedIn: false, gate: MemoryBiometricGate(kept: "left-over"))
        #expect(await phone.lock.launch() == .signedOut)
        #expect(!phone.gate.hasRefreshToken())
    }

    @Test func withFaceIDOffASignedInPhoneOpensAsBefore() async throws {
        let phone = Phone(gate: MemoryBiometricGate(kept: "left-from-a-reinstall"))
        #expect(await phone.lock.launch() == .open)
        #expect(!phone.gate.hasRefreshToken(), "an item it did not make is deleted")
        #expect(phone.storedRefreshToken == "r1")
        #expect(phone.gate.prompts.isEmpty)
    }

    @Test func withFaceIDOnNothingOpensUntilFaceIDPassesThenTheRefreshTokenIsInMemoryOnly() async throws {
        let phone = Phone(on: true, at: Phone.start.addingTimeInterval(2 * 86_400))
        #expect(await phone.lock.launch() == .locked)
        #expect(await phone.session.refreshTokenForBiometrics() == nil, "not before Face ID")
        #expect(await phone.lock.unlock() == .unlocked)
        #expect(phone.gate.prompts == ["Open Cranium"])
        #expect(await phone.session.refreshTokenForBiometrics() == "r1")
        #expect(phone.storedRefreshToken == nil, "never in the store")

        // Then the session refreshes with it as before, and the store still has no refresh token.
        #expect(try await phone.session.accessToken() == "refreshed-with-r1")
        #expect(phone.refreshes.requests.count == 1)
        #expect(phone.storedRefreshToken == nil)
        #expect(try phone.store.load()?.accessToken == "refreshed-with-r1")
        // A refresh keeps the time of the sign-in: the 15-minute rule still sees the old auth_time.
        #expect(try phone.store.load()?.signedInAt == Phone.start)
        // Days later, Face ID on: the refresh token is not forgotten after 60 minutes.
        #expect(await phone.session.hasRefreshToken)
    }

    @Test func aRefreshTokenAlsoInTheStoreGoesBehindFaceIDAtLaunch() async throws {
        let phone = Phone(on: true)
        try? phone.store.save(Tokens(accessToken: "a", refreshToken: "r-newer", expiresAt: Phone.start.addingTimeInterval(60)))
        let session = AuthSession(config: testConfig, http: phone.refreshes, store: phone.store,
                                  refreshTokenBehindBiometrics: true, now: { Phone.start })
        let lock = BiometricLock(gate: phone.gate, settings: phone.settings, session: session, now: { Phone.start })
        #expect(await lock.launch() == .locked)
        #expect(phone.gate.refreshToken == "r-newer")
        #expect(phone.storedRefreshToken == nil)
    }

    @Test func anItemThatIsGoneForgetsTheSessionTurnsItOffAndSaysWhy() async throws {
        let phone = Phone(on: true)
        phone.gate.lose()  // the passcode was turned off
        #expect(await phone.lock.launch() == .signIn(reason: "The saved sign-in is gone from this iPhone, as happens when its passcode is turned off. Sign in with your password and code."))
        #expect(phone.setting.owner == nil)
        #expect(phone.setting.offered.isEmpty, "offered again at the next sign-in")
        #expect(try phone.store.load() == nil, "the access token would open the app without Face ID")
        #expect(await !phone.session.isSignedIn)
    }

    // MARK: Asking

    @Test(arguments: [
        (BiometricFailure.cancelled, BiometricLock.Unlock.stay(message: nil), false),
        (.notRecognised, .stay(message: "Face ID didn’t recognise you. Try again, or sign in with your password."), false),
        (.lockedOut, .stay(message: "Face ID is locked after too many tries. Unlock the iPhone with its passcode, then try again."), false),
        (.passwordChosen, .password, false),
        (.changed, .signIn(reason: "Face ID changed on this iPhone, so the saved sign-in can’t be opened. Sign in with your password and code."), true),
        (.unavailable, .signIn(reason: "Face ID isn’t available to Cranium now, so the saved sign-in can’t be opened. Sign in with your password and code."), true),
        (.gone, .signIn(reason: "The saved sign-in is gone from this iPhone, as happens when its passcode is turned off. Sign in with your password and code."), true),
        (.unreadable(-34018), .signIn(reason: "The saved sign-in couldn’t be read. Sign in with your password and code."), true),
    ])
    func whatEachAnswerOfFaceIDLeadsTo(failure: BiometricFailure, expected: BiometricLock.Unlock, forgets: Bool) async throws {
        let phone = Phone(on: true)
        #expect(await phone.lock.launch() == .locked)
        phone.gate.releaseAnswer = failure
        #expect(await phone.lock.unlock() == expected)
        #expect(await phone.session.refreshTokenForBiometrics() == nil)
        if forgets {
            #expect(!phone.gate.hasRefreshToken())
            #expect(phone.setting.owner == nil)
            #expect(try phone.store.load() == nil)
        } else {
            // The saved sign-in stays: another try, or the password and code.
            #expect(phone.gate.refreshToken == "r1")
            #expect(phone.lock.isOn)
            #expect(try phone.store.load() != nil)
        }
    }

    @Test func aFailedTryCanBeFollowedByOneThatWorks() async throws {
        let phone = Phone(on: true)
        _ = await phone.lock.launch()
        phone.gate.releaseAnswer = .notRecognised
        _ = await phone.lock.unlock()
        phone.gate.releaseAnswer = nil
        #expect(await phone.lock.unlock() == .unlocked)
        #expect(phone.gate.prompts.count == 2)
    }

    @Test func touchIDIsCalledTouchID() async throws {
        let phone = Phone(on: true, gate: MemoryBiometricGate(biometry: .touchID))
        _ = await phone.lock.launch()
        phone.gate.releaseAnswer = .notRecognised
        #expect(await phone.lock.unlock() == .stay(message: "Touch ID didn’t recognise you. Try again, or sign in with your password."))
        #expect(BiometricWords.offerTitle(.touchID) == "Use Touch ID to open Cranium?")
        #expect(BiometricWords.offerTitle(.faceID) == "Use Face ID to open Cranium?")
        #expect(BiometricWords.unlock(.faceID) == "Unlock with Face ID")
        #expect(BiometricWords.password == "Sign in with password")
    }

    // MARK: The 5 minutes

    @Test func backAfterFiveMinutesAsksAgainUnderFiveDoesNot() {
        let phone = Phone(on: true)
        phone.lock.enteredBackground()
        phone.clock.now += 4 * 60 + 59
        #expect(!phone.lock.becameActive())
        phone.lock.enteredBackground()
        phone.clock.now += 5 * 60
        #expect(phone.lock.becameActive())
        // Inactive only (the prompt itself, Control Centre): no time in the background, no asking.
        phone.clock.now += 3600
        #expect(!phone.lock.becameActive())
        // Face ID off: never.
        let off = Phone()
        off.lock.enteredBackground()
        off.clock.now += 3600
        #expect(!off.lock.becameActive())
    }

    @Test func theMacChoosesHowLongAwayBeforeItAsksAgain() {
        let mac = Phone(on: true, gate: MemoryBiometricGate(biometry: .touchID))
        #expect(mac.lock.relockInterval == BiometricLock.relockAfter)
        mac.lock.relockInterval = 60
        mac.lock.enteredBackground()
        mac.clock.now += 59
        #expect(!mac.lock.becameActive())
        mac.lock.enteredBackground()
        mac.clock.now += 60
        #expect(mac.lock.becameActive())
        // 0: each time it comes back, however soon.
        mac.lock.relockInterval = 0
        mac.lock.enteredBackground()
        #expect(mac.lock.becameActive())
    }

    // MARK: Without Face ID: 60 minutes

    @Test func withoutFaceIDTheRefreshTokenIsForgotten60MinutesAfterTheSignIn() async throws {
        let phone = Phone(at: Phone.start.addingTimeInterval(59 * 60))
        #expect(await phone.lock.launch() == .open)
        #expect(phone.storedRefreshToken == "r1")
        // Under a minute left on the first access token: refreshed as before.
        phone.clock.now = Phone.start.addingTimeInterval(59 * 60 + 30)
        #expect(try await phone.session.accessToken() == "refreshed-with-r1")
        // The hour counts from the sign-in, not from the refresh: at 60 minutes the refresh token goes,
        // and the access token works on to its own end.
        phone.clock.now = Phone.start.addingTimeInterval(60 * 60)
        #expect(try await phone.session.accessToken() == "refreshed-with-r1")
        #expect(phone.storedRefreshToken == nil)
        #expect(await !phone.session.hasRefreshToken)
        #expect(await phone.session.signedInAt == Phone.start)
        // Then the session ends: no refresh is tried, and the app asks for the password and code.
        phone.clock.now = Phone.start.addingTimeInterval(119 * 60 + 30)
        await #expect(throws: AuthError.sessionExpired) { try await phone.session.accessToken() }
        #expect(phone.refreshes.requests.count == 1)

        // At launch, before anything can use it.
        let later = Phone(at: Phone.start.addingTimeInterval(3 * 3600))
        #expect(later.storedRefreshToken == nil)
        #expect(await later.lock.launch() == .open)
    }

    @Test func aSignInRecordsWhenAndTheTokensAuthTimeWins() async throws {
        let store = MemoryTokenStore()
        let session = AuthSession(config: testConfig, http: FakeHTTP { _ in (500, Data()) }, store: store, now: { Phone.start })
        try await session.completeSignIn(tokens: Tokens(accessToken: "not-a-jwt", refreshToken: "r", expiresAt: Phone.start))
        #expect(try store.load()?.signedInAt == Phone.start)
        let earlier = Phone.start.addingTimeInterval(-120)
        try await session.completeSignIn(tokens: Tokens(accessToken: accessToken(signedInAt: earlier), refreshToken: "r", expiresAt: Phone.start))
        #expect(await session.signedInAt == earlier)
        // A token kept before this version, with no time recorded, still decodes.
        let old = Data(#"{"accessToken":"a","refreshToken":"r","expiresAt":800000000}"#.utf8)
        let decoded = try JSONDecoder().decode(Tokens.self, from: old)
        #expect(decoded.signedInAt == nil && decoded.refreshToken == "r")
    }

    // MARK: Offering, turning on and off

    @Test func itIsOfferedOncePerPersonAndOnlyWithABiometricThatWorks() {
        let phone = Phone()
        #expect(phone.lock.shouldOffer(account: Phone.account))
        phone.lock.markOffered(account: Phone.account)
        #expect(!phone.lock.shouldOffer(account: Phone.account))
        #expect(phone.lock.shouldOffer(account: "someone-else"))
        #expect(!Phone(gate: MemoryBiometricGate(biometry: nil)).lock.shouldOffer(account: Phone.account), "neither: nothing offered")
        #expect(!Phone(gate: MemoryBiometricGate(usable: false)).lock.shouldOffer(account: Phone.account))
        #expect(!Phone(on: true).lock.shouldOffer(account: "someone-else"), "not while it is on")
        // The setting holds no account ID, only its hash.
        #expect(!phone.setting.offered.contains(Phone.account))
    }

    @Test func turningItOnAsksOnceAndMovesTheRefreshTokenOutOfTheStore() async throws {
        let phone = Phone()
        #expect(await phone.lock.turnOn(account: Phone.account) == .on)
        #expect(phone.gate.prompts == ["Turn on Face ID for Cranium"])
        #expect(phone.gate.refreshToken == "r1")
        #expect(phone.storedRefreshToken == nil)
        #expect(phone.lock.isOn(for: Phone.account))
        #expect(!phone.lock.isOn(for: "someone-else"))
        #expect(!phone.lock.shouldOffer(account: Phone.account))
    }

    @Test func notNowAndFailuresLeaveItOff() async throws {
        let cancelled = Phone(gate: MemoryBiometricGate(enrollAnswer: .cancelled))
        #expect(await cancelled.lock.turnOn(account: Phone.account) == .notNow)
        #expect(cancelled.storedRefreshToken == "r1")
        #expect(!cancelled.gate.hasRefreshToken() && !cancelled.lock.isOn)
        let failed = Phone(gate: MemoryBiometricGate(enrollAnswer: .notRecognised))
        #expect(await failed.lock.turnOn(account: Phone.account) == .failed("Face ID didn’t recognise you, so it is still off."))
        #expect(failed.storedRefreshToken == "r1")
    }

    @Test func afterItsHourThereIsNothingToProtectSoItAsksForASignIn() async throws {
        let phone = Phone(at: Phone.start.addingTimeInterval(2 * 3600))
        #expect(await phone.lock.turnOn(account: Phone.account) == .needsSignIn)
        #expect(phone.gate.prompts.isEmpty)
    }

    @Test func turningItOffPutsTheRefreshTokenBackForWhatIsLeftOfItsHour() async throws {
        let phone = Phone()
        _ = await phone.lock.turnOn(account: Phone.account)
        phone.clock.now = Phone.start.addingTimeInterval(30 * 60)
        await phone.lock.turnOff()
        #expect(!phone.gate.hasRefreshToken() && !phone.lock.isOn)
        #expect(phone.storedRefreshToken == "r1")

        let late = Phone()
        _ = await late.lock.turnOn(account: Phone.account)
        late.clock.now = Phone.start.addingTimeInterval(3 * 3600)
        await late.lock.turnOff()
        #expect(late.storedRefreshToken == nil)
        #expect(await !late.session.hasRefreshToken)
    }

    @Test func aFullSignInWhileItIsOnGoesBehindFaceIDAnotherPersonsTurnsItOff() async throws {
        let phone = Phone(on: true)
        _ = await phone.lock.launch()
        try await phone.session.completeSignIn(tokens: Tokens(accessToken: "a2", refreshToken: "r2", expiresAt: Phone.start.addingTimeInterval(3600)))
        #expect(phone.storedRefreshToken == nil, "kept out of the store from the start")
        await phone.lock.afterFullSignIn(account: Phone.account)
        #expect(phone.gate.refreshToken == "r2")
        #expect(phone.gate.prompts.isEmpty, "nothing asked: the password and code were just given")

        try await phone.session.completeSignIn(tokens: Tokens(accessToken: "a3", refreshToken: "r3", expiresAt: Phone.start.addingTimeInterval(3600)))
        await phone.lock.afterFullSignIn(account: "someone-else")
        #expect(!phone.lock.isOn && !phone.gate.hasRefreshToken())
        #expect(phone.storedRefreshToken == "r3")
    }

    @Test func signOutDeletesTheItemAndTheSamePersonsNextSignInGoesBehindFaceIDAgain() async throws {
        let phone = Phone(on: true)
        _ = await phone.lock.launch()
        _ = await phone.lock.unlock()
        await phone.session.signOut()
        phone.lock.signedOut()
        #expect(!phone.gate.hasRefreshToken())
        #expect(try phone.store.load() == nil)
        #expect(await phone.lock.launch() == .signedOut)

        try await phone.session.completeSignIn(tokens: Tokens(accessToken: "a2", refreshToken: "r2", expiresAt: Phone.start.addingTimeInterval(3600)))
        await phone.lock.afterFullSignIn(account: Phone.account)
        #expect(phone.gate.refreshToken == "r2")
        #expect(phone.storedRefreshToken == nil)
        #expect(await phone.lock.launch() == .locked)
    }
}

/// The real gate's Keychain item and how it reads the system's answers. Its prompts and the
/// Keychain's access control can only be tried on a phone or in the Simulator.
@Suite struct KeychainBiometricGateTests {
    @Test func theItemIsThisPhonesOnlyBehindTheCurrentFacesAndNeverSynced() throws {
        let item = try #require(KeychainBiometricGate.newItem("token-1"))
        #expect(item[kSecClass as String] as? String == kSecClassGenericPassword as String)
        #expect(item[kSecAttrService as String] as? String == "com.craniumiot.cranium.console")
        #expect(item[kSecAttrAccount as String] as? String == "refresh-token.biometric")
        #expect(item[kSecAttrSynchronizable as String] as? Bool == false)
        #expect(item[kSecAttrAccessControl as String] != nil)
        // The accessibility is in the access control; an item may not have both.
        #expect(item[kSecAttrAccessible as String] == nil)
        #expect(item[kSecValueData as String] as? Data == Data("token-1".utf8))
        // Not the access token's item.
        #expect(KeychainBiometricGate.account != "tokens")
    }

    @Test func whatLocalAuthenticationsAnswersMean() {
        let table: [(LAError.Code, BiometricFailure)] = [
            (.userCancel, .cancelled), (.appCancel, .cancelled), (.systemCancel, .cancelled),
            (.authenticationFailed, .notRecognised), (.userFallback, .passwordChosen), (.biometryLockout, .lockedOut),
            (.biometryNotAvailable, .unavailable), (.biometryNotEnrolled, .unavailable), (.passcodeNotSet, .unavailable),
        ]
        for (code, failure) in table {
            #expect(KeychainBiometricGate.failure(LAError(code)) == failure, "\(code)")
            #expect(KeychainBiometricGate.failure(NSError(domain: LAErrorDomain, code: code.rawValue)) == failure)
        }
        #expect(KeychainBiometricGate.failure(URLError(.timedOut)) == .cancelled, "not LocalAuthentication's: nothing forgotten")
    }

    @Test func whatTheKeychainsAnswersMean() {
        #expect(KeychainBiometricGate.failure(errSecItemNotFound) == .gone)
        #expect(KeychainBiometricGate.failure(errSecAuthFailed) == .changed)
        #expect(KeychainBiometricGate.failure(errSecUserCanceled) == .cancelled)
        #expect(KeychainBiometricGate.failure(errSecInteractionNotAllowed) == .cancelled)
        #expect(KeychainBiometricGate.failure(errSecMissingEntitlement) == .unreadable(errSecMissingEntitlement))
    }

    @Test func theSettingIsKeptInUserDefaultsWithNoAccountIDInIt() throws {
        let suite = "cranium-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = DefaultsBiometricSettings(defaults: defaults)
        #expect(store.load() == BiometricSettings())
        let settings = BiometricSettings(owner: BiometricSettings.key(for: "acct"), offered: [BiometricSettings.key(for: "acct")])
        store.save(settings)
        #expect(DefaultsBiometricSettings(defaults: defaults).load() == settings)
        let raw = String(decoding: defaults.data(forKey: "cranium.biometric.settings") ?? Data(), as: UTF8.self)
        #expect(!raw.contains("acct"))
        #expect(BiometricSettings.key(for: "acct").count == 64)
    }

    @Test func theAccessTokensSignInTime() {
        let at = Date(timeIntervalSince1970: 1_793_588_645)
        #expect(JWTClaims.authTime(accessToken(signedInAt: at)) == at)
        for notOne in ["", "demo", "a.b", "a.%%%.c", "a.\(Data("[]".utf8).base64EncodedString()).c"] {
            #expect(JWTClaims.authTime(notOne) == nil)
        }
    }
}
