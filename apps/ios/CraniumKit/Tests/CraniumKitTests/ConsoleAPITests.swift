import Foundation
import Testing
@testable import CraniumKit

@Suite struct ConsoleAPITests {
    @Test func meWithTheBearerToken() async throws {
        let http = FakeHTTP { _ in (200, json(["email": "a@b.test", "groups": ["release-managers"], "canWrite": true, "expiresAt": 123])) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        let me = try await api.me()
        #expect(me.canWrite)
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/me")
        #expect(http.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
    }

    @Test func theReleaseList() async throws {
        let http = FakeHTTP { _ in
            (200, json(["releases": [
                ["version": "1.8.0+0", "size": 10, "sha256": String(repeating: "a", count: 64), "status": "active",
                 "uploadedAt": "2026-11-02T18:00:00Z", "notes": "LEDs take turns", "imageHash": "x", "revoked": NSNull()],
                ["version": "1.7.0+0", "size": 9, "sha256": String(repeating: "b", count: 64), "status": "revoked"],
            ], "slotSize": 794_624, "signingKey": ["fingerprint": "f"]]))
        }
        let list = try await ConsoleAPI(config: testConfig, http: http, tokens: FixedToken()).firmware()
        #expect(list.releases.map(\.version) == ["1.8.0+0", "1.7.0+0"])
        #expect(list.releases[0].notes == "LEDs take turns")
        #expect(list.slotSize == 794_624)
    }

    @Test func theImageURLEncodesTheVersion() async throws {
        let bytes = Data([0x3D, 0xB8, 0xF3, 0x96])
        let http = FakeHTTP { _ in (200, bytes) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        let data = try await api.image(of: FirmwareRelease(version: "1.8.0+0", size: 4, sha256: ""))
        #expect(data == bytes)
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/firmware/1.8.0%2B0/image")
        #expect(http.requests[0].value(forHTTPHeaderField: "Accept") == "application/octet-stream")
    }

    @Test func errorsCarryTheConsolesMessage() async {
        let http = FakeHTTP { _ in
            (403, json(["error": ["code": "forbidden", "message": "Only a release manager can download firmware."]]))
        }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        do {
            _ = try await api.image(of: FirmwareRelease(version: "1.8.0+0", size: 4, sha256: ""))
            Issue.record("no error")
        } catch let error as APIError {
            #expect(error == APIError(status: 403, code: "forbidden", message: "Only a release manager can download firmware."))
            #expect(UserMessage.text(for: error) == "Only a release manager can download firmware. Ask an administrator for the role.")
        } catch {
            Issue.record("unexpected \(error)")
        }
    }

    @Test func anErrorWithoutJSONStillSaysSomething() {
        let error = ConsoleAPI.error(from: Data("Bad Gateway".utf8), status: 502)
        #expect(error.status == 502)
        #expect(error.message == "The console answered 502.")
    }

    @Test func a401RefreshesOnceAndTriesAgain() async throws {
        let http = FakeHTTP { request in
            request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1"
                ? (401, json(["error": ["code": "unauthorized", "message": "expired"]]))
                : (200, json(["groups": [], "canWrite": false]))
        }
        let me = try await ConsoleAPI(config: testConfig, http: http, tokens: FixedToken()).me()
        #expect(!me.canWrite)
        #expect(http.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer token-1", "Bearer token-2"])
    }

    @Test func a401AfterTheRefreshIsAnError() async {
        let http = FakeHTTP { _ in (401, json(["error": ["code": "unauthorized", "message": "Sign in again."]])) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        await #expect(throws: APIError(status: 401, code: "unauthorized", message: "Sign in again.")) { try await api.me() }
        #expect(http.requests.count == 2)
    }

    @Test func pairing() async throws {
        let http = FakeHTTP { _ in
            (200, json(["thing": "cranium-0123456789abcdef", "name": "Cranium-1A2B", "passkey": "012345",
                        "reportedAt": "2026-11-02T18:00:00.000Z"]))
        }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        let pairing = try await api.pairing(name: "Cranium-1A2B")
        #expect(pairing?.passkey == "012345")
        #expect(pairing?.thing == "cranium-0123456789abcdef")
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/pairing/Cranium-1A2B")
    }

    @Test func noPairingIsNilNotAnError() async throws {
        let http = FakeHTTP { _ in (404, json(["error": ["code": "no_pairing", "message": "No board online is pairing."]])) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        #expect(try await api.pairing(name: "Cranium-1A2B") == nil)
    }

    @Test func aPairingForAnotherNameOrABadPasskeyIsIgnored() async throws {
        for answer in [["thing": "t", "name": "Cranium-FFFF", "passkey": "012345"],
                       ["thing": "t", "name": "Cranium-1A2B", "passkey": "12345"],
                       ["thing": "t", "name": "Cranium-1A2B", "passkey": "12345x"]] {
            let http = FakeHTTP { _ in (200, json(answer)) }
            let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
            #expect(try await api.pairing(name: "Cranium-1A2B") == nil)
        }
    }

    @Test func aBadNameIsNeverSent() async throws {
        let http = FakeHTTP { _ in (200, Data()) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        #expect(try await api.pairing(name: "../me") == nil)
        #expect(try await api.pairing(name: "Cranium-1a2b") == nil)
        #expect(http.requests.isEmpty)
    }

    @Test func device() async throws {
        let http = FakeHTTP { _ in
            (200, json(["device": ["thing": "cranium-0123456789abcdef", "online": true, "lastSeen": "2026-11-02T18:00:00Z",
                                   "fw": ["version": "1.8.0+0", "confirmed": false], "ota": NSNull(), "rssi": -50],
                        "certificates": [], "executions": [], "olderExecutions": 0]))
        }
        let device = try await ConsoleAPI(config: testConfig, http: http, tokens: FixedToken()).device(thing: "cranium-0123456789abcdef")
        #expect(device.online)
        #expect(device.fw == DeviceStatus.Firmware(version: "1.8.0+0", confirmed: false))
    }
}
