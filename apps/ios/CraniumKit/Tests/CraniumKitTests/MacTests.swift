import Foundation
import Testing
@testable import CraniumKit

// The Mac app's pieces in CraniumKit (docs/mac-app.md): the lock's settings and, on macOS, the Touch ID gate with a stand-in for LAContext.

@MainActor
struct MacLockTests {
    @Test func theChoicesAndTheirTimes() {
        #expect(RelockChoice.allCases.map(\.interval) == [0, 60, 300, 900, 3600])
        #expect(RelockChoice.fiveMinutes.interval == BiometricLock.relockAfter)
        #expect(RelockChoice.immediately.title == "Immediately")
        #expect(MacLockWords.requireTouchID == "Require Touch ID")
    }

    @Test func thePreferencesAreKeptAndDefaultToThePhones() throws {
        let defaults = try #require(UserDefaults(suiteName: "cranium.mac.test.\(UUID().uuidString)"))
        #expect(MacLockPreferences.load(defaults) == MacLockPreferences(relock: .fiveMinutes, lockWhenMacSleeps: true))
        MacLockPreferences(relock: .oneMinute, lockWhenMacSleeps: false).save(defaults)
        #expect(MacLockPreferences.load(defaults) == MacLockPreferences(relock: .oneMinute, lockWhenMacSleeps: false))
        // Something unknown left in the defaults is the default.
        defaults.set("fortnight", forKey: MacLockPreferences.relockKey)
        #expect(MacLockPreferences.load(defaults).relock == .fiveMinutes)
    }
}

#if os(macOS)
/// LAContext, played: what the "person" does when asked, and the enrolled fingers' state.
final class FakeAsking: BiometricAsking, @unchecked Sendable {
    var touchID: Biometry? = .touchID
    var usable = true
    var answer: BiometricFailure?
    var state = Data([1])
    private(set) var reasons: [String] = []
    private(set) var fallbacks: [String?] = []

    func biometry() -> Biometry? { touchID }
    func isUsable() -> Bool { usable }

    func ask(reason: String, cancelTitle: String?, fallbackTitle: String?) async -> Result<BiometricPass, BiometricFailure> {
        reasons.append(reason)
        fallbacks.append(fallbackTitle)
        if let answer { return .failure(answer) }
        return .success(BiometricPass(context: nil, domainState: state))
    }
}

struct MacBiometricGateTests {
    func made() throws -> (gate: MacBiometricGate, asking: FakeAsking, secret: MemorySecret) {
        let defaults = try #require(UserDefaults(suiteName: "cranium.mac.gate.\(UUID().uuidString)"))
        let asking = FakeAsking()
        let secret = MemorySecret()
        return (MacBiometricGate(asking: asking, keeper: secret, defaults: defaults), asking, secret)
    }

    @Test func turningItOnAsksThenKeepsTheToken() async throws {
        let (gate, asking, secret) = try made()
        #expect(gate.biometry() == .touchID)
        #expect(!gate.hasRefreshToken())
        #expect(await gate.enroll("refresh-1", reason: BiometricWords.enrollReason(.touchID)) == nil)
        #expect(secret.secret == "refresh-1")
        #expect(asking.reasons == ["Turn on Touch ID for Cranium"])
        // Turning it on offers no password: only Not now.
        #expect(asking.fallbacks == [nil])
        #expect(gate.hasRefreshToken())
    }

    @Test func aCancelledPromptKeepsNothing() async throws {
        let (gate, asking, secret) = try made()
        asking.answer = .cancelled
        #expect(await gate.enroll("refresh-1", reason: "x") == .cancelled)
        #expect(secret.secret == nil)
    }

    @Test func openingAsksForTouchIDWithThePasswordAsItsOtherWay() async throws {
        let (gate, asking, _) = try made()
        _ = await gate.enroll("refresh-1", reason: "x")
        #expect(await gate.release(reason: BiometricWords.unlockReason) == .success("refresh-1"))
        #expect(asking.fallbacks.last == "Sign in with password")
        asking.answer = .notRecognised
        #expect(await gate.release(reason: "x") == .failure(.notRecognised))
        asking.answer = .passwordChosen
        #expect(await gate.release(reason: "x") == .failure(.passwordChosen))
    }

    @Test func aFingerAddedSinceStopsTheSavedSignIn() async throws {
        let (gate, asking, _) = try made()
        _ = await gate.enroll("refresh-1", reason: "x")
        asking.state = Data([2])
        #expect(await gate.release(reason: "x") == .failure(.changed))
    }

    @Test func nothingKeptIsGoneAndForgettingDeletesIt() async throws {
        let (gate, asking, secret) = try made()
        #expect(await gate.release(reason: "x") == .failure(.gone))
        // Nothing to open: Touch ID is not even asked.
        #expect(asking.reasons.isEmpty)
        _ = await gate.enroll("refresh-1", reason: "x")
        #expect(gate.replace("refresh-2") == nil)
        #expect(secret.secret == "refresh-2")
        gate.forget()
        #expect(!gate.hasRefreshToken())
    }

    @Test func aMacWithoutTouchIDIsOfferedNothing() async throws {
        let (gate, asking, _) = try made()
        asking.touchID = nil
        asking.usable = false
        #expect(gate.biometry() == nil)
        #expect(!gate.isUsable())
        #expect(MacLockWords.noTouchID.hasPrefix("This Mac has no Touch ID"))
    }

    /// The whole lock on the Mac's gate, signed in as the iPhone's tests are (Phone, BiometricLockTests).
    @MainActor
    @Test func theLockTurnsOnAndOpensWithTouchID() async throws {
        let (gate, _, secret) = try made()
        let defaults = try #require(UserDefaults(suiteName: "cranium.mac.lock.\(UUID().uuidString)"))
        let phone = Phone()
        let lock = BiometricLock(gate: gate, settings: DefaultsBiometricSettings(defaults: defaults), session: phone.session)
        #expect(lock.biometry == .touchID)
        #expect(await lock.turnOn(account: Phone.account) == .on)
        #expect(lock.isOn(for: Phone.account))
        #expect(secret.secret == "r1")
        #expect(await lock.launch() == .locked)
        #expect(await lock.unlock() == .unlocked)
        lock.relockInterval = RelockChoice.oneMinute.interval
        lock.enteredBackground()
        #expect(!lock.becameActive())
    }
}
#endif
