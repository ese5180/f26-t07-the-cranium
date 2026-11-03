import Foundation
import Testing
@testable import CraniumKit

/// The check right before every Bluetooth send: `POST /api/firmware/{version}/bluetooth`.
@Suite struct SendCheckTests {
    let data = makeImage(version: FirmwareVersion(major: 1, minor: 8, revision: 0, build: 0))
    var sha256: String { ImageCheck.sha256Hex(data) }
    var verified: VerifiedImage { try! ImageCheck.verify(data, for: release(for: data, version: "1.8.0+0")) }

    /// The answer cloud/api/src/handlers/firmware.mjs gives when the image may be sent.
    func answer(version: String = "1.8.0+0", sha256: String? = nil, status: String = "active") -> Data {
        json(["version": version, "sha256": sha256 ?? self.sha256, "status": status])
    }

    func fields(_ body: Data) -> [String: String] {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: String] ?? [:]
    }

    @Test func theBodyCarriesTheDigestAndTheBoardOnlyIfItIsOne() {
        #expect(fields(SendCheck.body(sha256: sha256, board: "Cranium-1A2B")) == ["sha256": sha256, "board": "Cranium-1A2B"])
        // A board under another name is not named: the console would refuse it.
        for board in [nil, "", "Cranium-1a2b", "Cranium-12345", "My iPhone"] as [String?] {
            #expect(fields(SendCheck.body(sha256: sha256, board: board)) == ["sha256": sha256])
        }
    }

    @Test func onlyTheSameReleaseDigestAndActiveClearIt() throws {
        try SendCheck.requireCleared(answer(), release: "1.8.0+0", sha256: sha256)
        let refusals: [Data] = [
            answer(sha256: String(repeating: "0", count: 64)),
            answer(sha256: sha256.uppercased()),
            answer(version: "1.8.0+1"),
            answer(status: "revoked"),
            json(["version": "1.8.0+0", "sha256": sha256]),
            json(["version": "1.8.0+0", "sha256": sha256, "status": true]),
            json(["error": ["code": "release_revoked", "message": "Release 1.8.0+0 is revoked."]]),
            Data(), Data("{".utf8), Data("null".utf8), Data("[]".utf8),
        ]
        for refused in refusals {
            #expect(throws: SendCheckError.notConfirmed(release: "1.8.0+0")) {
                try SendCheck.requireCleared(refused, release: "1.8.0+0", sha256: sha256)
            }
        }
        #expect(throws: SendCheckError.notConfirmed(release: "1.8.0+0")) {
            try SendCheck.requireCleared(answer(), release: "1.8.0+0", sha256: String(repeating: "0", count: 64))
        }
    }

    @Test func theAppAsksWithThePOSTOfTheContract() async throws {
        let http = FakeHTTP { _ in (200, answer()) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        try await api.confirmSend(verified, board: "Cranium-1A2B")
        let request = http.requests[0]
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://console.test/api/firmware/1.8.0%2B0/bluetooth")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8")
        #expect(fields(request.httpBody ?? Data()) == ["sha256": sha256, "board": "Cranium-1A2B"])
    }

    @Test func offlineIsNoAndSaysWhy() async {
        let http = FakeHTTP { _ in throw URLError(.notConnectedToInternet) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        await #expect(throws: SendCheckError.unreachable(release: "1.8.0+0")) {
            try await api.confirmSend(verified, board: nil)
        }
        let text = UserMessage.text(for: SendCheckError.unreachable(release: "1.8.0+0"))
        #expect(text.hasPrefix("Could not reach the console to check that 1.8.0+0 may still be sent, so nothing was sent."))
        #expect(text.contains("An image kept on this phone is only sent once the console says the release is still active."))
    }

    @Test func aRefusalIsShownInTheConsolesWords() async {
        for (status, code, message) in [(409, "release_revoked", "Release 1.8.0+0 is revoked. Do not send it to a board."),
                                        (409, "sha256_mismatch", "That image is not the one of release 1.8.0+0."),
                                        (404, "unknown_version", "There is no release 1.8.0+0."),
                                        (403, "release_manager_required", "Only release managers can do this.")] {
            let http = FakeHTTP { _ in (status, json(["error": ["code": code, "message": message]])) }
            let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
            await #expect(throws: SendCheckError.refused(release: "1.8.0+0", message: message)) {
                try await api.confirmSend(verified, board: "Cranium-1A2B")
            }
        }
        #expect(UserMessage.text(for: SendCheckError.refused(release: "1.8.0+0", message: "Release 1.8.0+0 is revoked."))
            == "The console did not clear 1.8.0+0 for sending, so nothing was sent. Release 1.8.0+0 is revoked.")
    }

    @Test func anAnswerThatDoesNotMatchIsNo() async {
        let http = FakeHTTP { _ in (200, answer(sha256: String(repeating: "f", count: 64))) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        await #expect(throws: SendCheckError.notConfirmed(release: "1.8.0+0")) {
            try await api.confirmSend(verified, board: nil)
        }
        #expect(UserMessage.text(for: SendCheckError.notConfirmed(release: "1.8.0+0")).hasSuffix("so nothing was sent."))
    }

    @Test func aSignInThatHasEndedIsNotTakenForARefusal() async {
        let http = FakeHTTP { _ in (401, json(["error": ["code": "unauthorized", "message": "Sign in again."]])) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        await #expect(throws: APIError(status: 401, code: "unauthorized", message: "Sign in again.")) {
            try await api.confirmSend(verified, board: nil)
        }
        #expect(http.requests.count == 2)
    }

    @Test func theBoardTheConsoleNamesIsShownAsItIs() {
        #expect(UserMessage.boardInConsole("cranium-0123456789abcdef") == "Board in the console: cranium-0123456789abcdef")
        #expect(BoardName.isThing("cranium-0123456789abcdef"))
        for odd in ["", "cranium-0123456789ABCDEF", "cranium-0123456789abcde", "cranium-0123456789abcdef0",
                    "Cranium-1A2B", "cranium-0123456789abcdeg", " cranium-0123456789abcdef"] {
            #expect(!BoardName.isThing(odd))
        }
    }
}
