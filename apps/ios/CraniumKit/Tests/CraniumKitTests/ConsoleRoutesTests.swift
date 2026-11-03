import Foundation
import Testing
@testable import CraniumKit

/// Every route the website uses, as the app calls it: the address, the method, the body.
@Suite struct ConsoleRoutesTests {
    func api(_ status: Int = 200, _ body: Any) -> (ConsoleAPI, FakeHTTP) {
        let data = json(body)
        let http = FakeHTTP { _ in (status, data) }
        return (ConsoleAPI(config: testConfig, http: http, tokens: FixedToken()), http)
    }

    func bodyOf(_ request: URLRequest) -> [String: Any] {
        guard let data = request.httpBody, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    let device: [String: Any] = [
        "thing": "cranium-0123456789abcdef", "name": "CRVIHAAN01", "online": true, "lastSeen": "2026-11-03T12:00:00.000Z",
        "fw": ["version": "1.11.3+0", "confirmed": true],
        "ota": ["state": "downloading", "job": "cranium-1-11-4-b0-20261103T110000Z-1a2b", "progress": 42, "last": "none", "error": ""],
        "rssi": -61, "uptime": 3600, "stuck": ["count": 0, "reason": "none"],
        "diag": ["mac": "f4:ce:36:12:34:56", "channel": 6, "heap": ["free": 21312, "least": 9840, "size": 44240], "at": "2026-11-03T11:58:00.000Z"],
        "diary": ["boots": 42, "entries": [["version": "1.11.3+0", "cause": "10", "causes": ["watchdog"], "stage": 4],
                                          ["version": "bad", "cause": "1", "causes": [], "stage": 1]]],
        "bt": ["from": "1.11.2+0", "to": "1.11.3+0", "result": "succeeded", "proof": "person", "count": 3],
    ]

    @Test func theBoardsWithEverythingTheyReport() async throws {
        let (api, http) = api(200, ["devices": [device, ["thing": ""], ["thing": "cranium-fedcba9876543210", "name": NSNull()]],
                                    "generatedAt": "2026-11-03T12:00:01.000Z"])
        let list = try await api.devices()
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/devices")
        #expect(list.devices.count == 2)
        let board = list.devices[0]
        #expect(board.name == "CRVIHAAN01")
        #expect(board.label == "CRVIHAAN01")
        #expect(board.ota?.progress == 42)
        #expect(board.ota?.job == "cranium-1-11-4-b0-20261103T110000Z-1a2b")
        #expect(board.diag?.heap == Device.Heap(free: 21312, least: 9840, size: 44240))
        #expect(board.diary?.boots == 42)
        #expect(board.diary?.entries.count == 1, "an entry with a bad version is left out")
        #expect(board.bt?.proof == "person")
        // Before firmware 1.11.4, and before the API has it: the thing name stands in.
        #expect(list.devices[1].name == nil)
        #expect(list.devices[1].label == "cranium-fedcba9876543210")
    }

    @Test func aNameThatIsNotADeviceIdIsNone() throws {
        for name in ["", "has space", String(repeating: "A", count: 33), "Ünï", "<b>"] {
            var raw = device
            raw["name"] = name
            let decoded = try JSONDecoder().decode(Device.self, from: json(raw))
            #expect(decoded.name == nil, "\(name)")
        }
        var raw = device
        raw["name"] = String(repeating: "Z9", count: 16)
        #expect(try JSONDecoder().decode(Device.self, from: json(raw)).name?.count == 32)
    }

    @Test func aBoardsPageAndItsHistory() async throws {
        let (api, http) = api(200, [
            "device": device, "certificates": ["0123456789abcdef"],
            "executions": [["deployment": "cranium-1-11-3-b0-20261102T110000Z-1a2b", "version": "1.11.3+0", "status": "SUCCEEDED",
                            "queuedAt": "2026-11-02T11:00:00.000Z", "lastUpdatedAt": "2026-11-02T11:10:00.000Z"]],
            "olderExecutions": 2,
        ])
        let detail = try await api.deviceDetail(thing: "cranium-0123456789abcdef")
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/devices/cranium-0123456789abcdef")
        #expect(detail.certificates == ["0123456789abcdef"])
        #expect(detail.executions.first?.status == "SUCCEEDED")
        #expect(detail.olderExecutions == 2)
        #expect(detail.device.name == "CRVIHAAN01")
    }

    @Test func samplesAskForHoursWithinTheAPIsBounds() async throws {
        let (api, http) = api(200, ["thing": "cranium-0123456789abcdef", "hours": 168, "bucketSeconds": 300,
                                    "samples": [["at": "2026-11-03T11:00:00.000Z", "rssi": -60, "heapFree": 20000],
                                                ["rssi": -50]]])
        let samples = try await api.samples(thing: "cranium-0123456789abcdef", hours: 500)
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/devices/cranium-0123456789abcdef/samples?hours=168")
        #expect(samples.samples.count == 1, "a sample without a time is left out")
        #expect(samples.bucketSeconds == 300)
    }

    @Test func eventsWithTheirRangeBoardKindsAndCursor() async throws {
        let (api, http) = api(200, ["events": [
            ["thing": "cranium-0123456789abcdef", "at": "2026-11-03T11:00:00.000Z", "id": "a1b2c3", "kind": "update",
             "what": "started", "level": "info", "text": "Started 1.11.4+0", "job": "cranium-1-11-4-b0-20261103T110000Z-1a2b", "progress": 3],
            ["thing": "not-a-board", "at": "2026-11-03T11:00:00.000Z", "kind": "update"],
            ["thing": "cranium-0123456789abcdef", "at": "2026-11-03T11:00:00.000Z", "kind": "gossip"],
        ], "cursor": "abc_DEF-1", "from": "2026-11-02T12:00:00.000Z", "to": "2026-11-03T12:00:00.000Z"])
        let from = Date(timeIntervalSince1970: 1_793_620_800)
        let page = try await api.events(from: from, to: from.addingTimeInterval(3600), thing: "cranium-0123456789abcdef",
                                        kinds: ["connection", "update"], cursor: "abc")
        let url = try #require(http.requests[0].url?.absoluteString)
        #expect(url.hasPrefix("https://console.test/api/events?from=2026-11-02T12:00:00.000Z&to=2026-11-02T13:00:00.000Z"))
        #expect(url.contains("&thing=cranium-0123456789abcdef&kinds=connection%2Cupdate&cursor=abc"))
        #expect(page.events.count == 1)
        #expect(page.events[0].job == "cranium-1-11-4-b0-20261103T110000Z-1a2b")
        #expect(page.cursor == "abc_DEF-1")
    }

    @Test func theUploadIsTheWebsitesBase64Body() async throws {
        let image = makeImage(version: FirmwareVersion(major: 1, minor: 12, revision: 0, build: 0))
        let (api, http) = api(201, ["release": ["version": "1.12.0+0", "size": image.count, "sha256": ImageCheck.sha256Hex(image),
                                                "status": "active", "uploadedBy": ["sub": "s", "email": "a@b.test"]]])
        let made = try await api.upload(filename: "my build (2).signed.bin", notes: "Faster\nLEDs\u{200B}", data: image)
        let request = http.requests[0]
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "https://console.test/api/firmware")
        #expect(request.timeoutInterval == 120)
        let body = bodyOf(request)
        #expect(body["filename"] as? String == "my_build__2_.signed.bin")
        #expect(body["notes"] as? String == "Faster LEDs")
        #expect(Data(base64Encoded: body["data"] as? String ?? "") == image)
        #expect(made.version == "1.12.0+0")
        #expect(made.uploadedBy?.email == "a@b.test")
    }

    @Test func revokingSendsTheReasonAndReadsWhatWasCancelled() async throws {
        let (api, http) = api(200, ["release": ["version": "1.8.0+0", "size": 10, "sha256": String(repeating: "a", count: 64),
                                                "status": "revoked",
                                                "revoked": ["by": ["sub": "s", "email": "a@b.test"], "at": "2026-11-03T12:00:00.000Z",
                                                            "reason": "Bricks the LEDs", "enforcedAt": "2026-11-03T12:00:02.000Z"]],
                                    "cancelled": ["cranium-1-8-0-b0-20261102T110000Z-1a2b"]])
        let result = try await api.revoke(version: "1.8.0+0", reason: " Bricks the LEDs ")
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/firmware/1.8.0%2B0/revoke")
        #expect(bodyOf(http.requests[0])["reason"] as? String == "Bricks the LEDs")
        #expect(result.cancelled == ["cranium-1-8-0-b0-20261102T110000Z-1a2b"])
        #expect(Words.revocationState(result.release) == .complete)
    }

    @Test func deployingToSeveralBoardsWithANote() async throws {
        let (api, http) = api(201, ["deployment": ["id": "cranium-1-8-0-b0-20261103T120000Z-abcd", "version": "1.8.0+0",
                                                   "status": "IN_PROGRESS", "things": ["cranium-0123456789abcdef"],
                                                   "counts": ["queued": 1], "executions": []]])
        let made = try await api.deploy(version: "1.8.0+0", things: ["cranium-0123456789abcdef", "cranium-fedcba9876543210"],
                                        note: "Try it")
        let body = bodyOf(http.requests[0])
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/deployments")
        #expect(body["version"] as? String == "1.8.0+0")
        #expect(body["things"] as? [String] == ["cranium-0123456789abcdef", "cranium-fedcba9876543210"])
        #expect(body["note"] as? String == "Try it")
        #expect(made.counts.queued == 1)
    }

    @Test func cancellingWithAndWithoutForce() async throws {
        let (api, http) = api(200, ["deployment": ["id": "cranium-1-8-0-b0-20261103T120000Z-abcd", "status": "CANCELED"]])
        _ = try await api.cancel(deployment: "cranium-1-8-0-b0-20261103T120000Z-abcd", force: true)
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/deployments/cranium-1-8-0-b0-20261103T120000Z-abcd/cancel")
        #expect(bodyOf(http.requests[0])["force"] as? Bool == true)
    }

    @Test func aDeploymentWithEachBoard() async throws {
        let (api, _) = api(200, ["deployment": [
            "id": "cranium-1-8-0-b0-20261103T120000Z-abcd", "version": "1.8.0+0", "status": "IN_PROGRESS",
            "createdAt": "2026-11-03T12:00:00.000Z", "createdBy": ["sub": "s", "email": "a@b.test"], "note": "n",
            "things": ["cranium-0123456789abcdef"], "counts": ["inProgress": 1],
            "executions": [["thing": "cranium-0123456789abcdef", "status": "IN_PROGRESS", "phase": "downloading", "progress": 40,
                            "online": true, "secondsLeft": 500, "reason": "bad\u{7}text"]],
        ]])
        let deployment = try await api.deployment(id: "cranium-1-8-0-b0-20261103T120000Z-abcd")
        #expect(deployment.executions[0].progress == 40)
        #expect(deployment.executions[0].reason == "bad?text", "a board's text is printable ASCII only")
        #expect(Words.describeExecution(deployment.executions[0], version: "1.8.0+0").title == "Downloading 40%")
    }

    @Test func theActivityLogAPageAtATime() async throws {
        let (api, http) = api(200, ["entries": [["at": "2026-11-03T12:00:00.000Z", "actor": ["sub": "s", "email": "a@b.test"],
                                                 "action": "firmware.upload", "target": "1.8.0+0", "outcome": "ok",
                                                 "detail": ["size": 1264, "filename": "x.bin"], "requestId": "r1"]],
                                    "next": "bmV4dA"])
        let page = try await api.audit(limit: 500, before: "abc")
        #expect(http.requests[0].url?.absoluteString == "https://console.test/api/audit?limit=100&before=abc")
        #expect(page.next == "bmV4dA")
        #expect(page.entries[0].detail.contains(AuditEntry.Detail("size", "1264")))
    }

    @Test func apiTokensMadeOnceAndRevoked() async throws {
        let secret = "crn_" + String(repeating: "A", count: 43)
        let (made, http) = api(201, ["token": secret, "id": "0123456789abcdef", "name": "laptop",
                                     "createdAt": "2026-11-03T12:00:00.000Z", "expiresAt": "2026-12-03T12:00:00.000Z"])
        let token = try await made.createToken(name: "  laptop ", days: 30)
        #expect(token.token == secret)
        #expect(bodyOf(http.requests[0])["name"] as? String == "laptop")
        #expect(bodyOf(http.requests[0])["days"] as? Int == 30)

        let (revoke, revoked) = api(200, ["token": ["id": "0123456789abcdef", "name": "laptop", "status": "revoked"]])
        let after = try await revoke.revokeToken(id: "0123456789abcdef")
        #expect(revoked.requests[0].url?.absoluteString == "https://console.test/api/tokens/0123456789abcdef/revoke")
        #expect(revoked.requests[0].httpMethod == "POST")
        #expect(after.status == "revoked")

        let (list, _) = api(200, ["tokens": [["id": "0123456789abcdef", "name": "a", "status": "active"],
                                             ["id": "nope", "name": "b", "status": "active"],
                                             ["id": "fedcba9876543210", "name": "c", "status": "weird"]], "limit": 10, "maxDays": 90])
        let listing = try await list.tokens()
        #expect(listing.tokens.map(\.status) == ["active", "expired"])
        #expect(listing.active == 1)
    }

    @Test func aTokenThatIsNotOneIsNotShown() async {
        let (api, _) = api(201, ["token": "crn_short", "id": "0123456789abcdef", "name": "x"])
        await #expect(throws: APIError.self) { try await api.createToken(name: "x", days: 1) }
    }

    @Test func refusalsKeepTheirRequestIdAndBusyBoards() {
        let error = ConsoleAPI.error(from: json(["error": [
            "code": "device_busy", "message": "cranium-0123456789abcdef still has an update that is not finished.",
            "requestId": "req-1", "details": [["thing": "cranium-0123456789abcdef", "deployment": "cranium-1-8-0-b0-20261103T120000Z-abcd"],
                                              ["thing": "nope"]],
        ]]), status: 409)
        #expect(error.requestId == "req-1")
        #expect(error.busyBoards == [APIError.BusyBoard(thing: "cranium-0123456789abcdef",
                                                        deployment: "cranium-1-8-0-b0-20261103T120000Z-abcd")])
        #expect(error.isRefusal)
        #expect(Words.problemRef(error) == "Code device_busy · Request req-1")
    }

    @Test func theGatewaysOwnAnswerIsSaid() {
        let error = ConsoleAPI.error(from: json(["message": "Too Many Requests"]), status: 429)
        #expect(error.message == "Too Many Requests (HTTP 429).")
    }

    @Test func historyComesFromBesideTheConsolesScripts() async throws {
        let http = FakeHTTP { request in
            if request.url?.path == "/" {
                return (200, Data(#"<script type="module" src="/assets/b-123.x/app.js"></script>"#.utf8))
            }
            #expect(request.url?.absoluteString == "https://console.test/assets/b-123.x/history.json")
            return (200, json(["deployment": ["commit": "3b5764c441d48dc64fab49738c9dfed1fbecc32a", "tree": "clean"],
                               "commits": [["hash": "3b5764c441d48dc64fab49738c9dfed1fbecc32a", "short": "3b5764c",
                                            "date": "2026-11-01T16:21:27-05:00", "subject": "Give the sizes", "tags": ["docs", "x"]]]]))
        }
        let history = try #require(try await ConsoleAPI(config: testConfig, http: http, tokens: FixedToken()).history())
        #expect(history.commits[0].tags == ["docs"])
        #expect(history.builtFrom == "3b5764c441d48dc64fab49738c9dfed1fbecc32a")
        #expect(history.commits[0].link?.absoluteString == "https://github.com/ese5180/f26-t07-the-cranium/commit/3b5764c441d48dc64fab49738c9dfed1fbecc32a")
        #expect(http.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil }, "the website's files need no token")
    }

    @Test func aDeploymentIdNamesItsVersion() {
        #expect(DeploymentId.version(of: "cranium-1-11-4-b0-20261103T110000Z-1a2b") == "1.11.4+0")
        #expect(DeploymentId.version(of: "cranium-1-8-0-b12-20261103T110000Z-1a2b") == "1.8.0+12")
        #expect(DeploymentId.version(of: "AWS-job-1") == nil)
        #expect(CommitHistory.buildId(inIndex: "<link href=\"/assets/../app.js\">") == nil)
    }
}

/// A change from the phone needs a sign-in in the last 15 minutes: ask, sign in, try once more.
@Suite struct FreshSignInTests {
    let stale = APIError(status: 403, code: "phone_sign_in_again", message: FreshSignIn.ask)

    final class Counter: @unchecked Sendable {
        var changes = 0
        var asks = 0
    }

    @Test func afterASignInTheChangeRunsOnceMore() async throws {
        let counter = Counter()
        let result = try await FreshSignIn.run({ () async throws -> String in
            counter.changes += 1
            if counter.changes == 1 { throw stale }
            return "made"
        }, signInAgain: {
            counter.asks += 1
            return true
        })
        #expect(result == "made")
        #expect(counter.changes == 2)
        #expect(counter.asks == 1)
    }

    @Test func whoDeclinesChangesNothing() async {
        let counter = Counter()
        await #expect(throws: FreshSignInError.declined) {
            try await FreshSignIn.run({ () async throws -> Int in
                counter.changes += 1
                throw stale
            }, signInAgain: { false })
        }
        #expect(counter.changes == 1)
    }

    @Test func aSecondRefusalIsNotAskedAgain() async {
        let counter = Counter()
        await #expect(throws: APIError.self) {
            try await FreshSignIn.run({ () async throws -> Int in
                counter.changes += 1
                throw stale
            }, signInAgain: {
                counter.asks += 1
                return true
            })
        }
        #expect(counter.changes == 2)
        #expect(counter.asks == 1)
    }

    @Test func otherRefusalsAreNotAboutTheSignIn() async {
        let counter = Counter()
        await #expect(throws: APIError.self) {
            try await FreshSignIn.run({ () async throws -> Int in
                throw APIError(status: 403, code: "release_manager_required", message: "Only release managers can do this.")
            }, signInAgain: {
                counter.asks += 1
                return true
            })
        }
        #expect(counter.asks == 0)
    }

    @Test func thePersonIsToldWhatTheConsoleWants() {
        #expect(UserMessage.text(for: stale) == FreshSignIn.ask)
        #expect(FreshSignIn.isNeeded(stale))
        #expect(Words.failure("Not revoked.", stale).hasPrefix("Not revoked. To change anything from the phone, sign in again first"))
        #expect(Words.refusalWords["phone_sign_in_again"] == "A change from the phone needs a sign-in in the last 15 minutes")
    }

    @Test func theSignInAsksForThePasswordEveryTime() {
        let pending = OAuth.begin(testConfig, pkce: PKCE(verifier: String(repeating: "v", count: 43)), state: "s")
        #expect(pending.url.absoluteString.hasSuffix("&prompt=login"))
    }
}
