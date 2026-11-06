import Foundation
import Testing
@testable import CraniumKit

// The Mac app's pieces in CraniumKit (docs/mac-app.md): the lock's settings, the serial console's
// lines, and, on macOS, the Touch ID gate with a stand-in for LAContext.

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

struct SerialLineTests {
    @Test func bytesBecomeLinesWhateverTheEnding() {
        var buffer = SerialLineBuffer()
        #expect(buffer.take(Array("one\r\ntwo\nthr".utf8)) == ["one", "two"])
        #expect(buffer.take(Array("ee\rfour\r".utf8)) == ["three", "four"])
        // The \n of a \r\n that came apart is no empty line.
        #expect(buffer.take(Array("\n".utf8)) == [])
        #expect(buffer.take(Array("\n".utf8)) == [""])
        #expect(buffer.lines == ["one", "two", "three", "four", ""])
    }

    @Test func colourCodesAndControlCharactersAreTakenOut() {
        #expect(SerialLineBuffer.plain("\u{1B}[1;32muart:~$ \u{1B}[m") == "uart:~$ ")
        #expect(SerialLineBuffer.plain("a\u{07}b\tc\u{7F}") == "ab\tc")
        #expect(SerialLineBuffer.plain("[00:00:01.234,000] <inf> cranium: Connected") == "[00:00:01.234,000] <inf> cranium: Connected")
    }

    @Test func aLongLineIsCutAndOnlyTheNewestLinesAreKept() {
        var buffer = SerialLineBuffer()
        let line = buffer.take(Array(repeating: UInt8(ascii: "x"), count: SerialLineBuffer.maxLine + 500) + [0x0A])
        #expect(line.first?.count == SerialLineBuffer.maxLine)
        for number in 0..<(SerialLineBuffer.keep + 10) { buffer.take(Array("\(number)\n".utf8)) }
        #expect(buffer.lines.count == SerialLineBuffer.keep)
        #expect(buffer.lines.last == "\(SerialLineBuffer.keep + 9)")
        buffer.clear()
        #expect(buffer.lines.isEmpty)
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

/// A live socket, played: the texts it receives, then a close.
final class FakeSocket: LiveSocket, @unchecked Sendable {
    var incoming: [String]
    var openFails = false
    private(set) var sent: [String] = []
    private(set) var cancelled = false

    init(_ incoming: [String], openFails: Bool = false) {
        self.incoming = incoming
        self.openFails = openFails
    }

    func send(_ text: String) async throws {
        if openFails { throw URLError(.badServerResponse) }
        sent.append(text)
    }

    func receive() async throws -> String {
        if incoming.isEmpty { throw URLError(.networkConnectionLost) }
        return incoming.removeFirst()
    }

    func cancel() { cancelled = true }
}

final class FakeConnector: LiveConnecting, @unchecked Sendable {
    var sockets: [FakeSocket]
    private(set) var opened: [(URL, String)] = []

    init(_ sockets: [FakeSocket]) { self.sockets = sockets }

    func open(_ url: URL, token: String) -> LiveSocket {
        opened.append((url, token))
        return sockets.isEmpty ? FakeSocket([], openFails: true) : sockets.removeFirst()
    }
}
#endif

struct LiveChangeTests {
    @Test func aChangedMessageIsReadAndAnythingElseIsNot() {
        let team = LiveChange.parse(#"{"type":"changed","things":["cranium-0011223344556677"],"what":["board"],"at":"2026-11-06T21:00:00.000Z"}"#)
        #expect(team == LiveChange(things: ["cranium-0011223344556677"], what: ["board"], at: "2026-11-06T21:00:00.000Z"))
        #expect(team?.concerns(thing: "cranium-0011223344556677") == true)
        #expect(team?.concerns(thing: "cranium-ffffffffffffffff") == false)
        let customer = LiveChange.parse(#"{"type":"changed","boards":["0123456789abcdef"],"what":["board","updates"]}"#)
        #expect(customer?.boards == ["0123456789abcdef"])
        // No board named: every page reads again.
        #expect(LiveChange.parse(#"{"type":"changed","what":["releases"]}"#)?.concerns(thing: "anything") == true)
        #expect(LiveChange.parse(#"{"type":"pong"}"#) == nil)
        #expect(LiveChange.parse(#"{"type":"changed","what":[]}"#) == nil)
        #expect(LiveChange.parse("not json") == nil)
        #expect(LiveChange.parse(String(repeating: " ", count: 20_000)) == nil)
    }

    @Test func theWaitsGrowToAMinuteWithJitter() {
        #expect(LiveBackoff.delay(after: 1, jitter: 1) == 1)
        #expect(LiveBackoff.delay(after: 3, jitter: 1) == 4)
        #expect(LiveBackoff.delay(after: 3, jitter: 0) == 2)
        #expect(LiveBackoff.delay(after: 30, jitter: 1) == 60)
        #expect(LiveBackoff.delay(after: 0, jitter: 5) == 1)
    }
}

#if os(macOS)
@MainActor
struct LiveClientTests {
    let url = URL(string: "wss://abc123def4.execute-api.us-east-1.amazonaws.com/live")!

    @Test func itConnectsWithTheTokenHandsOnEachChangeAndComesBackAfterAClose() async throws {
        let first = FakeSocket([#"{"type":"changed","things":["cranium-0011223344556677"],"what":["board"]}"#, "junk",
                                #"{"type":"changed","what":["releases"]}"#])
        let second = FakeSocket([])
        let connector = FakeConnector([first, second])
        var changes: [LiveChange] = []
        var waits: [TimeInterval] = []
        var client: LiveClient!
        client = LiveClient(url: url, connector: connector, token: { "token-1" }, onChange: { changes.append($0) },
                            sleep: { seconds in
                                await MainActor.run {
                                    // The pinger's 5 minutes never pass here; the reconnect waits are counted.
                                    if seconds < LiveProtocol.pingEvery { waits.append(seconds) }
                                    if waits.count >= 2 { client.stop() }
                                }
                                if seconds >= LiveProtocol.pingEvery { try await Task.sleep(nanoseconds: 10_000_000_000) }
                                try Task.checkCancellation()
                            },
                            random: { 1 })
        client.start()
        for _ in 0..<200 where client.isRunning { try await Task.sleep(nanoseconds: 5_000_000) }
        #expect(!client.isRunning)
        #expect(client.state == .off)
        #expect(changes.map(\.what) == [["board"], ["releases"]])
        #expect(connector.opened.map(\.1) == ["token-1", "token-1"])
        #expect(first.sent == [LiveProtocol.ping])
        #expect(first.cancelled)
        // A close right away, then a socket that would not open: 1 s, then 2 s.
        #expect(waits == [1, 2])
    }

    @Test func withoutATokenItWaitsAndOpensNothing() async throws {
        let connector = FakeConnector([])
        var asked = 0
        var client: LiveClient!
        client = LiveClient(url: url, connector: connector, token: { asked += 1; return nil }, onChange: { _ in },
                            sleep: { _ in
                                await MainActor.run { if asked >= 3 { client.stop() } }
                                try Task.checkCancellation()
                            })
        client.start()
        for _ in 0..<200 where client.isRunning { try await Task.sleep(nanoseconds: 5_000_000) }
        #expect(asked == 3)
        #expect(connector.opened.isEmpty)
    }

    @Test func withoutALiveAPIItNeverStarts() {
        let client = LiveClient(url: nil, connector: FakeConnector([]), token: { "t" }, onChange: { _ in })
        client.start()
        #expect(!client.isRunning)
        #expect(client.state == .off)
    }
}
#endif
