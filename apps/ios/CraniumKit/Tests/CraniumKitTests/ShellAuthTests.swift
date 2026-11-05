import Foundation
import Testing
@testable import CraniumKit

/// The shell's sign-in for the bridge: the page hands the tokens over once, then gets access tokens only, behind
/// Face ID where that is on, by the classic app's rules.
@MainActor
@Suite struct ShellAuthTests {
    nonisolated static let start = Date(timeIntervalSince1970: 1_793_588_645)
    nonisolated static let pool = CognitoUserPool(id: "xx-test-1_Customers", region: "xx-test-1")!
    nonisolated static let customer = CustomerConfig(apiURL: URL(string: "https://customer.test")!, clientId: "customerclient", pool: pool)

    final class Clock: @unchecked Sendable {
        var now = ShellAuthTests.start
    }

    /// A JWT whose payload has `sub` and `auth_time`; nothing checks its signature.
    nonisolated static func jwt(sub: String, authTime: Date, marker: String = "a") -> String {
        func part(_ object: [String: Any]) -> String {
            try! JSONSerialization.data(withJSONObject: object).base64EncodedString()
                .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        }
        return "\(part(["alg": "none"])).\(part(["sub": sub, "auth_time": Int(authTime.timeIntervalSince1970), "m": marker])).sig"
    }

    struct Made {
        let pool: ShellAuthPool
        let gate: MemoryBiometricGate
        let settings: MemoryBiometricSettings
        let http: FakeHTTP
        let clock: Clock
    }

    /// A customer's pool, refreshed through the user pool API by `http`.
    func make(biometricOn: Bool = false, store: MemoryTokenStore = MemoryTokenStore(), refreshes: Int = 0,
              answer: (@Sendable (URLRequest) async throws -> (Int, Data))? = nil) -> Made {
        let clock = Clock()
        let settings = MemoryBiometricSettings(biometricOn ? BiometricSettings(owner: BiometricSettings.key(for: "person-1")) : BiometricSettings())
        let http = FakeHTTP(answer ?? { _ in
            (200, json(["AuthenticationResult": ["AccessToken": Self.jwt(sub: "person-1", authTime: Self.start, marker: "refreshed"),
                                                 "ExpiresIn": 3600, "TokenType": "Bearer"]]))
        })
        let session = AuthSession(customer: Self.customer, http: http, store: store,
                                  refreshTokenBehindBiometrics: biometricOn, now: { clock.now })
        let gate = MemoryBiometricGate()
        let lock = BiometricLock(gate: gate, settings: settings, session: session, now: { clock.now })
        return Made(pool: ShellAuthPool(pool: .customer, session: session, lock: lock, now: { clock.now }),
                    gate: gate, settings: settings, http: http, clock: clock)
    }

    @Test func aSignInIsKeptAndTheOfferIsMadeOnce() async throws {
        let made = make()
        let token = Self.jwt(sub: "person-1", authTime: Self.start)
        let state = try await made.pool.store(refreshToken: "refresh-1", accessToken: token, expiresIn: 3600)
        #expect(state.available && state.kind == .faceID && !state.enabled && state.offer)
        let access = try #require(try await made.pool.access())
        #expect(access.token == token && access.expiresIn == 3600)
        #expect(made.http.requests.isEmpty)
        // Once per person.
        let again = try await made.pool.store(refreshToken: "refresh-2", accessToken: token, expiresIn: 3600)
        #expect(!again.offer)
    }

    @Test func aTokenNearItsEndIsRefreshedFirst() async throws {
        let made = make()
        _ = try await made.pool.store(refreshToken: "refresh-1", accessToken: Self.jwt(sub: "person-1", authTime: Self.start),
                                      expiresIn: 3600)
        made.clock.now = Self.start.addingTimeInterval(3600 - 100)
        let access = try #require(try await made.pool.access())
        #expect(access.token.contains(".") && access.expiresIn == 3600)
        #expect(made.http.requests.count == 1)
        let body = try #require(made.http.requests[0].httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(sent["AuthFlow"] as? String == "REFRESH_TOKEN_AUTH" && sent["ClientId"] as? String == "customerclient")
    }

    @Test func withoutFaceIDTheSignInLastsAnHour() async throws {
        let made = make()
        _ = try await made.pool.store(refreshToken: "refresh-1", accessToken: Self.jwt(sub: "person-1", authTime: Self.start),
                                      expiresIn: 3600)
        // 61 minutes later the refresh token is gone, and so is the access token's hour.
        made.clock.now = Self.start.addingTimeInterval(61 * 60)
        #expect(try await made.pool.access() == nil)
        #expect(made.http.requests.isEmpty)
    }

    @Test func refusedRefreshIsSignedOutAndNoNetworkIsSaid() async throws {
        let refused = make(answer: { _ in (400, json(["__type": "NotAuthorizedException"])) })
        _ = try await refused.pool.store(refreshToken: "r", accessToken: Self.jwt(sub: "person-1", authTime: Self.start), expiresIn: 60)
        #expect(try await refused.pool.access() == nil)

        let offline = make(answer: { _ in throw URLError(.notConnectedToInternet) })
        _ = try await offline.pool.store(refreshToken: "r", accessToken: Self.jwt(sub: "person-1", authTime: Self.start), expiresIn: 60)
        await #expect(throws: BridgeError.self) { _ = try await offline.pool.access() }
        do {
            _ = try await offline.pool.access()
        } catch let error as BridgeError {
            #expect(error.code == .network)
        }
    }

    @Test func withFaceIDTheTokenIsReleasedByItOncePerRun() async throws {
        // A sign-in from before, kept behind Face ID: the store has no refresh token, the gate has it.
        let kept = Tokens(accessToken: Self.jwt(sub: "person-1", authTime: Self.start), refreshToken: nil,
                          expiresAt: Self.start.addingTimeInterval(3600), signedInAt: Self.start)
        let made = make(biometricOn: true, store: MemoryTokenStore(kept))
        _ = made.gate.replace("refresh-kept")
        let access = try #require(try await made.pool.access())
        #expect(access.expiresIn == 3600)
        #expect(made.gate.prompts.count == 1)
        _ = try await made.pool.access()
        #expect(made.gate.prompts.count == 1)

        // 5 minutes in the background: asked again.
        await made.pool.enteredBackground()
        made.clock.now = Self.start.addingTimeInterval(6 * 60)
        #expect(await made.pool.becameActive())
        #expect(await made.pool.needsUnlock)
        _ = try await made.pool.access()
        #expect(made.gate.prompts.count == 2)
        // Back after less than that: not.
        await made.pool.enteredBackground()
        made.clock.now = Self.start.addingTimeInterval(7 * 60)
        #expect(await !made.pool.becameActive())
    }

    @Test func aCancelledPromptIsCancelledAndAChangedFaceIsLocked() async throws {
        let kept = Tokens(accessToken: Self.jwt(sub: "person-1", authTime: Self.start), refreshToken: nil,
                          expiresAt: Self.start.addingTimeInterval(3600), signedInAt: Self.start)
        let made = make(biometricOn: true, store: MemoryTokenStore(kept))
        _ = made.gate.replace("refresh-kept")
        made.gate.releaseAnswer = .cancelled
        do {
            _ = try await made.pool.access()
            Issue.record("a cancelled prompt gave a token")
        } catch let error as BridgeError {
            #expect(error.code == .cancelled)
        }
        made.gate.releaseAnswer = .changed
        do {
            _ = try await made.pool.access()
            Issue.record("a changed face gave a token")
        } catch let error as BridgeError {
            #expect(error.code == .locked)
            #expect(error.message.contains("Face ID changed"))
        }
        // The saved sign-in is gone with it.
        #expect(try await made.pool.access() == nil)
    }

    @Test func turningItOnAndOffAndSigningOut() async throws {
        let made = make()
        _ = try await made.pool.store(refreshToken: "refresh-1", accessToken: Self.jwt(sub: "person-1", authTime: Self.start),
                                      expiresIn: 3600)
        #expect(try await made.pool.setBiometric(true))
        #expect(made.gate.refreshToken == "refresh-1")
        #expect(await made.pool.biometricState().enabled)
        #expect(try await made.pool.setBiometric(false) == false)
        #expect(made.gate.refreshToken == nil)
        await made.pool.signOut()
        #expect(try await made.pool.access() == nil)
        await #expect(throws: BridgeError.self) { _ = try await made.pool.setBiometric(true) }
    }
}

/// The bridge's Bluetooth rules: which board's status after the restart is this send's, and the image it takes.
@Suite struct ShellBluetoothTests {
    static let sample = "010302010300384e0d00010e0100000000000000010e00000000000007010100010e000000000000010d020007000000deadbeef010203040300040302010000"

    @Test func onlyThisSendsBoard() throws {
        let status = try #require(BoardStatus.parse(Data(hexDigits: Self.sample)))
        // The sample's last update: over Bluetooth, to 1.14.0+0, image hash deadbeef01020304.
        #expect(ShellBluetooth.isAboutThisSend(status, version: "1.14.0+0", hash: "deadbeef01020304"))
        #expect(ShellBluetooth.isAboutThisSend(status, version: "1.14.0+0", hash: nil))
        #expect(!ShellBluetooth.isAboutThisSend(status, version: "1.14.0+0", hash: "0000000000000001"))
        #expect(!ShellBluetooth.isAboutThisSend(status, version: "1.14.1+0", hash: nil))
    }

    @Test func theImageIsCheckedAgain() throws {
        let image = makeImage(version: FirmwareVersion(major: 1, minor: 14, revision: 1, build: 0))
        let digest = ImageCheck.sha256Hex(image)
        let verified = try ShellBluetooth.image(base64: image.base64EncodedString(), sha256: digest)
        #expect(verified.release == "1.14.1+0" && verified.data == image)
        #expect(throws: BridgeError.self) { try ShellBluetooth.image(base64: image.base64EncodedString(), sha256: String(repeating: "0", count: 64)) }
        #expect(throws: BridgeError.self) { try ShellBluetooth.image(base64: "not base64!", sha256: digest) }
        let notAnImage = Data(repeating: 1, count: 64)
        #expect(throws: BridgeError.self) {
            try ShellBluetooth.image(base64: notAnImage.base64EncodedString(), sha256: ImageCheck.sha256Hex(notAnImage))
        }
        let tooBig = Data(count: ShellBluetooth.maxImageBytes + 1)
        #expect(throws: BridgeError.self) { try ShellBluetooth.image(base64: tooBig.base64EncodedString(), sha256: ImageCheck.sha256Hex(tooBig)) }
    }

    @Test func theImageList() throws {
        let answer = ShellBluetooth.images([ImageSlot(image: 0, slot: 0, version: "1.14.0", active: true, confirmed: true)])
        let text = JSONValue.object(answer).text
        #expect(text.contains("\"version\":\"1.14.0\"") && text.contains("\"active\":true") && text.contains("\"pending\":false"))
    }
}
