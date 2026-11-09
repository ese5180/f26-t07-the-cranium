import Foundation
import Testing
@testable import CraniumKit

/// The activity log in the website's words: the examples of cloud/web/test/core.test.mjs, case by
/// case, against the port of core.js's `describeAudit`, `auditBoards` and `auditSentence`.
@Suite struct ActivityWordsTests {
    static let deployment = "cranium-1-1-0-b7-20261010T221500Z-9f3a"

    func entry(_ action: String, _ target: String, _ outcome: String = "ok", _ detail: [(String, String)] = [],
               actor: Person? = nil, requestId: String = "") -> AuditEntry {
        AuditEntry(at: "2026-10-10T12:00:00Z", actor: actor, action: action, target: target, outcome: outcome,
                   detail: detail.map { AuditEntry.Detail($0.0, $0.1) }, requestId: requestId)
    }

    func line(_ action: String, _ target: String, _ outcome: String = "ok", _ detail: [(String, String)] = []) -> AuditWords {
        Words.describeAudit(entry(action, target, outcome, detail))
    }

    /// verb, label, tail and boards, as the web test's `said` joins them.
    func said(_ words: AuditWords) -> String { Words.auditWhat(words) }

    func facts(_ words: AuditWords) -> [String] {
        words.facts.map { "\($0.label)\($0.phrase ? "" : ":") \($0.value)" }
    }

    @Test func anEntryReadsAsASentenceAndLinksOnlyToWhatExists() {
        let upload = line("firmware.upload", "1.1.0+7")
        #expect(upload == AuditWords(icon: "upload", verb: "uploaded firmware", label: "1.1.0+7", tail: "", outcome: nil,
                                     link: .firmware, facts: [], scripted: false, boards: [], boardCount: 0, byName: false))
        // What a script sent past the gateway is told apart. A request through the gateway cannot carry this id.
        #expect(Words.describeAudit(entry("firmware.revoke", "1.1.0+7", requestId: "bench-0123")).scripted)
        #expect(!Words.describeAudit(entry("firmware.revoke", "1.1.0+7", requestId: "LvC5hbench-=")).scripted)
        #expect(said(line("firmware.revoke", "1.1.0+7")) == "revoked firmware 1.1.0+7")

        // A deployment is called by the version it installs; which boards it went to follows.
        let started = line("deployment.create", Self.deployment, "ok", [("version", "1.1.0+7"), ("things", "2")])
        #expect(said(started) == "deployed 1.1.0+7 to 2 boards")
        #expect(started.link == .deployment(Self.deployment))
        #expect(started.facts.map { [$0.label, $0.value, "\($0.code)"] } == [["Deployment", Self.deployment, "true"]])
        #expect(said(line("deployment.cancel", Self.deployment)) == "cancelled the deployment of 1.1.0+7")
        #expect(said(line("deployment.cancel", Self.deployment, "rejected")) == "tried to cancel the deployment of 1.1.0+7")
        #expect(said(line("deployment.create", "1.1.0+7", "rejected")) == "tried to deploy 1.1.0+7")
        #expect(said(line("deployment.create", Self.deployment, "rejected")) == "tried to deploy 1.1.0+7")
        #expect(said(line("deployment.create", Self.deployment)) == "deployed 1.1.0+7")
        let odd = "cranium-999-0-0-b1-20261010T221500Z-ffff"
        #expect(line("deployment.cancel", odd).label == odd)
        // Without a target no sentence ends in "of", nor stops short.
        #expect(said(line("deployment.cancel", "", "rejected")) == "tried to cancel a deployment")
        #expect(said(line("deployment.create", "")) == "started a deployment")
        #expect(said(line("deployment.create", "", "rejected")) == "tried to start a deployment")
        #expect(said(line("firmware.upload", "", "rejected")) == "tried to upload a file")
        #expect(said(line("firmware.revoke", "", "denied")) == "tried to revoke a release")

        let refused = line("firmware.upload", "zephyr.signed.bin", "rejected")
        #expect(refused.link == nil)
        #expect(said(refused) == "tried to upload zephyr.signed.bin")
        #expect(refused.outcome?.label == "Refused")
        #expect(line("deployment.create", "1.1.0+7", "denied").outcome?.label == "Not allowed")
        #expect(line("deployment.create", "1.1.0+7", "error").outcome?.label == "Server error")
        #expect(line("something.new", "javascript:alert(1)", "odd").link == nil)
        #expect(line("something.new", "x", "odd").verb == "something.new")
    }

    @Test func theDetailsArePutInTheConsolesWords() {
        let digest = String(repeating: "ab", count: 32)
        let upload = line("firmware.upload", "1.1.0+7", "rejected",
                          [("sha256", digest), ("size", "1264"), ("filename", "zephyr.signed.bin"), ("code", "wrong_key")])
        #expect(facts(upload) == ["Refused with wrong_key", "File zephyr.signed.bin", "Size 1,264 bytes", "SHA-256 \(digest)"])
        #expect(upload.facts.map(\.code) == [true, true, false, true])
        #expect(upload.facts[0].words == "Signed with a different key than this project’s")
        #expect(line("firmware.upload", "1.1.0+7", "rejected", [("code", "something_new")]).facts[0].words == nil)
        #expect(line("firmware.upload", "x.bin", "rejected", [("filename", "x.bin")]).facts.isEmpty)

        let reason = "Pads stop responding after a few minutes of use."
        let revoke = line("firmware.revoke", "1.1.0+7", "ok", [("reason", reason), ("cancelled", "1")])
        #expect(facts(revoke) == ["Reason: \(reason)", "Deployments cancelled 1"])
        #expect(!revoke.facts[0].code)
        #expect(facts(line("deployment.cancel", "1.1.0+7", "ok", [("force", "true")]))
                == ["Asked to withdraw the offer and stop boards that had started"])
        #expect(facts(line("deployment.cancel", "1.1.0+7", "error", [("force", "false"), ("cancelled", "true"), ("code", "internal")]))
                == ["Failed with internal", "Asked to withdraw the offer", "Cancelled all the same"])
        #expect(facts(line("deployment.create", "1.1.0+7", "rejected", [("version", "1.1.0+7"), ("things", "2"), ("code", "device_busy")]))
                == ["Refused with device_busy"])
        #expect(facts(line("deployment.create", "1.1.0+7", "ok", [("version", "9.9.9+9")])) == ["Version 9.9.9+9"])
        #expect(facts(line("firmware.revoke", "1.1.0+7", "error", [("reason", "A fault."), ("cancelled", "0"),
                                                                      ("incomplete", "tag cancel record"), ("code", "revoke_incomplete")])) == [
            "Failed with revoke_incomplete",
            "Left undone: refusing the image, cancelling the deployments, recording that it is done",
            "Reason: A fault.", "Deployments cancelled 0",
        ])
        #expect(facts(line("firmware.revoke", "1.1.0+7", "error", [("incomplete", "a_new_step")])) == ["Left undone: a_new_step"])
        let finished = line("firmware.revoke", "1.1.0+7", "ok", [("cancelled", "1"), ("resumed", "true")])
        #expect(finished.verb == "finished revoking firmware")
        #expect(facts(finished) == ["Deployments cancelled 1"])
        #expect(facts(line("firmware.upload", "1.1.0+7", "ok", [("somethingNew", "x"), ("size", "unknown"), ("constructor", "y")]))
                == ["Size unknown", "somethingNew: x", "constructor: y"])
    }

    @Test func theCheckBeforeABluetoothSendReadsAsWhatItWas() {
        let sha = String(repeating: "ab", count: 32)
        let cleared = line("firmware.bluetooth_send", "1.1.0+7", "ok", [("sha256", sha), ("board", "Cranium-1A2B")])
        #expect(cleared.icon == "chip")
        #expect(said(cleared) == "was cleared to send 1.1.0+7 over Bluetooth")
        #expect(cleared.link == .firmware)
        #expect(cleared.facts.map { [$0.label, $0.value, "\($0.code)"] } == [["SHA-256", sha, "true"], ["To board", "Cranium-1A2B", "true"]])
        let refused = line("firmware.bluetooth_send", "1.1.0+7", "rejected", [("code", "release_revoked"), ("sha256", sha)])
        #expect(said(refused) == "tried to send 1.1.0+7 over Bluetooth")
        #expect(refused.facts[0].words == "The release is revoked")
        #expect(said(line("firmware.bluetooth_send", "", "rejected", [("code", "invalid_version")])) == "tried to send firmware over Bluetooth")
        #expect(line("firmware.bluetooth_send", "1.1.0+7", "rejected", [("code", "sha256_mismatch")]).facts[0].words
                == "The phone’s image is not the release’s")
        #expect(line("deployment.create", "1.1.0+7", "denied", [("code", "phone_not_allowed")]).facts[0].words
                == "The phone app’s sign-in cannot be used for that")
    }

    @Test func aDeploymentSaysWhichBoardsItWentToAndADownloadReadsAsOne() {
        let a = "cranium-0123456789abcdef", b = "cranium-fedcba9876543210", c = "cranium-00000000000000aa"
        let devices = [Device(thing: a, name: "CRVIHAAN01"), Device(thing: b)]
        let vihaan = Person(sub: "s", email: "vihaan@example.invalid")
        func deployed(_ boards: [String], _ things: String? = nil) -> AuditEntry {
            entry("deployment.create", Self.deployment, "ok",
                  [("version", "1.1.0+7"), ("things", things ?? String(boards.count))] + (boards.isEmpty ? [] : [("boards", boards.joined(separator: " "))]),
                  actor: vihaan)
        }
        #expect(Words.auditSentence(deployed([a]), devices: devices) == "vihaan@example.invalid deployed 1.1.0+7 to CRVIHAAN01")
        #expect(Words.auditSentence(deployed([a, b]), devices: devices) == "vihaan@example.invalid deployed 1.1.0+7 to CRVIHAAN01 and \(b)")
        // Three and more: how many in the sentence, and every one among the details.
        #expect(Words.auditSentence(deployed([a, b, c]), devices: devices) == "vihaan@example.invalid deployed 1.1.0+7 to 3 boards")
        #expect(Words.describeAudit(deployed([a, b, c])).facts.map { [$0.key, $0.value] } == [["boards", "\(a) \(b) \(c)"], ["target", Self.deployment]])
        #expect(Words.auditSentence(deployed([], "12"), devices: devices) == "vihaan@example.invalid deployed 1.1.0+7 to 12 boards")
        #expect(Words.auditBoards(Words.describeAudit(deployed([], "x"))) == "")
        // A name that is not a thing name is not taken for one.
        #expect(Words.describeAudit(deployed(["CRVIHAAN01"])).boards == [])

        let ab = Person(sub: "", email: "a@b")
        #expect(Words.auditSentence(entry("firmware.download", "1.1.0+7", actor: ab)) == "a@b downloaded 1.1.0+7 to a phone")
        #expect(Words.auditSentence(entry("firmware.download", "", actor: ab)) == "a@b downloaded firmware to a phone")
        #expect(Words.auditSentence(entry("firmware.download", "1.1.0+7", "denied", actor: ab)) == "a@b tried to download 1.1.0+7")
        let fromPhone = Words.describeAudit(entry("deployment.create", Self.deployment, "ok", [("things", "1"), ("boards", a), ("from", "phone")]))
        #expect(fromPhone.facts.map { [$0.label, $0.value] } == [["From", "the phone app"], ["Deployment", Self.deployment]])
    }

    @Test func aSignInSaysWhereItWasMadeAndNothingMore() {
        func signIn(_ client: String) -> AuditEntry {
            entry("account.sign_in", "", "ok", [("client", client)], actor: Person(sub: "s", email: "vihaan@example.invalid"),
                  requestId: "signin.s.\(client).1793700000")
        }
        #expect(Words.auditSentence(signIn("web")) == "vihaan@example.invalid signed in on the website")
        #expect(Words.auditSentence(signIn("phone")) == "vihaan@example.invalid signed in on the phone app")
        #expect(Words.auditSentence(signIn("tv")) == "vihaan@example.invalid signed in")
        let words = Words.describeAudit(signIn("web"))
        #expect(words.icon == "user" && words.label.isEmpty && words.facts.isEmpty && words.link == nil && !words.scripted)
        // Its request id is made of the sign-in itself: not shown.
        #expect(!Words.showsRequestId(signIn("web")))
        #expect(Words.showsRequestId(entry("firmware.upload", "1.1.0+7", requestId: "Kq3tWh2AoAMEb7w=")))
    }

    @Test func aCommandAtASerialConsoleReadsAsWhatItDidNeverWithAValue() {
        func command(_ name: String, _ device: String = "CRVIHAAN01", _ outcome: String = "ok", _ extra: [(String, String)] = []) -> AuditEntry {
            entry("serial.command", device, outcome, [("command", name), ("version", "1.12.0+0")] + extra, actor: Person(sub: "", email: "a@b"))
        }
        #expect(Words.auditSentence(command("WIFI")) == "a@b set the Wi-Fi network of CRVIHAAN01 over USB")
        #expect(Words.auditSentence(command("SET_ID")) == "a@b changed the device ID of CRVIHAAN01 over USB")
        #expect(Words.auditSentence(command("INIT", "")) == "a@b set up a board from factory mode over USB")
        #expect(Words.auditSentence(command("ENTER_BOOTLOADER")) == "a@b restarted CRVIHAAN01 into its bootloader over USB")
        #expect(Words.auditSentence(command("NEWER_ONE")) == "a@b ran a command on CRVIHAAN01 over USB")
        #expect(Words.auditSentence(command("WIFI", "CRVIHAAN01", "rejected", [("code", "unexpected_field")]))
                == "a@b tried to put on record a command on CRVIHAAN01 over USB")
        #expect(Words.auditSentence(command("WIFI", "", "denied")) == "a@b tried to put on record a command run over USB")
        for name in ["INIT", "SET_ID", "RESET_CONFIG", "FACTORY_RESET", "WIFI", "WIFI_SEC", "CLEAR_WIFI", "CLOUD", "KEYGEN",
                     "MQTT_HOST", "MQTT_RECONNECT", "BUTTON", "REBOOT", "ENTER_BOOTLOADER"] {
            #expect(Words.serialWords[name]?.contains("{}") == true, "\(name)")
        }
        let wifi = Words.describeAudit(command("WIFI", "CRVIHAAN01", "ok", [("from", "phone")]))
        #expect(wifi.byName)
        #expect(wifi.facts.map { [$0.label, $0.value, "\($0.code)"] }
                == [["Running", "1.12.0+0", "true"], ["Command", "WIFI", "true"], ["From", "the phone app", "false"]])
        #expect(!Words.describeAudit(command("WIFI", "")).byName)
        // VoiceOver hears how it ended; the plain sentence, as on the website, does not say it.
        #expect(Words.auditSpoken(command("WIFI", "", "denied")) == "a@b tried to put on record a command run over USB (not allowed)")
    }

    /// The Customers page's entries (cloud/web/test/customer.test.mjs): a customer by their address,
    /// a board by its name and then whose it is now.
    @Test func aCustomerReadsAsTheirAddressAndABoardAsWhoseItIs() {
        let sub = "7ec17d2e-9ee4-4734-8901-33c8fec73372"
        let thing = "cranium-fe5b26c0c5b1dcd7"
        let actor = Person(sub: "s", email: "a@b")
        func customer(_ action: String, _ target: String, _ outcome: String, _ detail: [(String, String)]) -> AuditEntry {
            entry(action, target, outcome, detail, actor: actor)
        }
        let email = ("email", "ada@example.invalid")
        #expect(Words.auditSentence(customer("customer.create", sub, "ok", [email])) == "a@b invited the customer ada@example.invalid")
        #expect(Words.describeAudit(customer("customer.create", sub, "ok", [email])).facts.isEmpty)
        #expect(Words.auditSentence(customer("customer.create", "", "rejected", [email, ("code", "customer_exists")]))
                == "a@b tried to invite the customer ada@example.invalid")
        let given = customer("customer.assign", thing, "ok", [("customer", sub), email, ("label", "Deck")])
        #expect(Words.auditSentence(given) == "a@b gave \(thing) to ada@example.invalid")
        #expect(Words.describeAudit(given).facts.map { [$0.label, $0.value] } == [["Customer", sub], ["Called", "Deck"]])
        #expect(Words.auditSentence(customer("customer.unassign", thing, "ok", [("customer", sub)])) == "a@b took \(thing) back from a customer")
        #expect(Words.auditSentence(customer("customer.assign", "", "denied", [("code", "release_manager_required")]))
                == "a@b tried to give a board to a customer")
        #expect(Words.auditSentence(customer("customer.resend", "", "ok", [])) == "a@b sent an invitation again")
        #expect(Words.auditSentence(customer("customer.disable", sub, "ok", [email])) == "a@b switched off the customer account of ada@example.invalid")
        #expect(Words.auditSentence(customer("customer.enable", "", "denied", [])) == "a@b tried to switch on a customer account")
        #expect(Words.describeAudit(customer("customer.assign", thing, "rejected", [("code", "board_taken")])).facts.first?.words
                == "That board belongs to another customer")
    }

    /// The word lists themselves, read out of the website's core.js: a code or a command the website
    /// has words for and the app does not fails here.
    @Test func theWordListsAreTheWebsitesOwn() throws {
        let core = ConfigTests.configDir.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("cloud/web/src/site/assets/core.js")
        let source = try String(contentsOf: core, encoding: .utf8)
        func map(_ name: String) throws -> [String: String] {
            let start = try #require(source.range(of: "\(name) = {"))
            // On one line, or over many.
            let end = try #require(source.range(of: "};", range: start.upperBound..<source.endIndex))
            let body = String(source[start.upperBound..<end.lowerBound])
            let pattern = try NSRegularExpression(pattern: "([A-Za-z_0-9]+): '((?:[^'\\\\]|\\\\.)*)'")
            var found: [String: String] = [:]
            for match in pattern.matches(in: body, range: NSRange(body.startIndex..., in: body)) {
                let key = String(body[Range(match.range(at: 1), in: body)!])
                found[key] = String(body[Range(match.range(at: 2), in: body)!]).replacingOccurrences(of: "\\'", with: "'")
            }
            return found
        }
        let refusals = try map("export const REFUSAL_WORDS")
        #expect(refusals.count > 60)
        #expect(refusals == Words.refusalWords)
        #expect(try map("export const SERIAL_WORDS") == Words.serialWords)
        #expect(try map("const SIGNED_IN_ON") == Words.signedInOn)
        for action in ["firmware.upload", "firmware.revoke", "deployment.create", "deployment.cancel", "firmware.download",
                       "pairing.read", "firmware.bluetooth_send", "token.create", "token.revoke", "account.sign_in", "serial.command",
                       "customer.create", "customer.resend", "customer.assign", "customer.unassign", "customer.disable",
                       "customer.enable", "device.register", "setup.wifi_defaults"] {
            #expect(source.contains("'\(action)': {"), "\(action) on the website")
            #expect(Words.auditActions[action] != nil, "\(action) in the app")
        }
    }
}

/// The boards' own log (`GET /api/events/log`), read as the website reads it.
@Suite struct BoardLogTests {
    let thing = "cranium-0123456789abcdef"

    func api(_ body: Any) -> (ConsoleAPI, FakeHTTP) {
        let data = json(body)
        let http = FakeHTTP { _ in (200, data) }
        return (ConsoleAPI(config: testConfig, http: http, tokens: FixedToken()), http)
    }

    @Test func aPageOfLinesWithItsRangeBoardKindsSourcesAndCursor() async throws {
        let (api, http) = api(["lines": [
            ["thing": thing, "at": "2026-11-03T11:00:00.000Z", "id": "42.7", "kind": "setting", "tag": "CONSOLE",
             "level": "info", "text": "Wi-Fi network set; joining it now", "boot": 42, "seq": 7],
            ["thing": thing, "at": "2026-11-03T10:59:00.000Z", "id": "42.6", "kind": "health", "tag": "WIFI",
             "level": "warn", "text": "WRN: Connection request failed: -116", "boot": 42, "seq": 6, "dropped": 3],
            // From firmware 1.13.0: a board's answer to a command from the console.
            ["thing": thing, "at": "2026-11-03T10:58:00.000Z", "id": "42.5", "kind": "setting", "tag": "CMD", "text": "OK"],
            ["thing": thing, "at": "2026-11-03T10:58:00.000Z", "id": "42.4", "kind": "setting", "tag": "NOPE", "text": "x"],
            ["thing": thing, "at": "2026-11-03T10:58:00.000Z", "id": "42.3", "kind": "connection", "tag": "net", "text": "x"],
            ["thing": thing, "at": "2026-11-03T10:58:00.000Z", "id": "42.0", "kind": "log", "tag": "app", "text": "x"],
            ["thing": "not-a-board", "at": "2026-11-03T10:58:00.000Z", "id": "1.1", "kind": "log", "tag": "app", "text": "x"],
            ["thing": thing, "at": "yesterday", "id": "1.2", "kind": "log", "tag": "app", "text": "x"],
        ], "cursor": "abc_DEF-1", "from": "2026-11-02T12:00:00.000Z", "to": "2026-11-03T12:00:00.000Z"])
        let from = Date(timeIntervalSince1970: 1_793_620_800)
        let page = try await api.boardLog(from: from, to: from.addingTimeInterval(3600), thing: thing, kinds: ["setting", "log"],
                                          tags: ["CONSOLE"], limit: 5, cursor: "abc")
        let url = try #require(http.requests[0].url?.absoluteString)
        #expect(url.hasPrefix("https://console.test/api/events/log?from=2026-11-02T12:00:00.000Z&to=2026-11-02T13:00:00.000Z"))
        #expect(url.contains("&thing=\(thing)&kinds=setting%2Clog&tags=CONSOLE&limit=5&cursor=abc"))
        #expect(page.lines.map(\.lineId) == ["42.7", "42.6", "42.5"])
        #expect(page.cursor == "abc_DEF-1")
        let warning = page.lines[1]
        #expect(warning.warn && warning.dropped == 3 && warning.boot == 42 && warning.seq == 6)
        #expect(!page.lines[0].warn && page.lines[0].dropped == nil)
        #expect(page.lines[0].id == "\(thing)-42.7")
        #expect(BoardLog.place(page.lines[0]) == "Boot 42, line 7 of that boot")
        #expect(BoardLog.place(page.lines[2]) == nil)
    }

    @Test func whatABoardSentIsMadeSafeToShow() throws {
        let long = String(repeating: "x", count: 300)
        let data = json(["lines": [
            ["thing": thing, "at": "2026-11-03T11:00:00.000Z", "id": "1.1", "kind": "log", "tag": "app", "text": "caf\u{e9}\n\u{1b}[31m"],
            ["thing": thing, "at": "2026-11-03T11:00:00.000Z", "id": "1.2", "kind": "log", "tag": "app", "text": long],
        ]])
        let page = try JSONDecoder().decode(LinePage.self, from: data)
        #expect(page.lines[0].text.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value < 0x7f })
        #expect(page.lines[1].text.count == BoardLine.textLimit)
    }

    @Test func whatIsAskedForAndTheWordsAroundIt() {
        #expect(BoardLog.query(hidden: [], tag: "") == (nil, nil, false))
        let some = BoardLog.query(hidden: ["log", "connection"], tag: "CONSOLE")
        #expect(some.kinds == ["bluetooth", "update", "restart", "health", "setting"])
        #expect(some.tags == ["CONSOLE"])
        #expect(BoardLog.query(hidden: Set(BoardLine.kinds), tag: "").none)
        #expect(BoardLog.query(hidden: [], tag: "nonsense").tags == nil)

        let lines = [
            BoardLine(thing: thing, at: "2026-11-03T11:00:00.000Z", id: "1.3", kind: "health", tag: "WIFI", level: "warn", text: "WRN: x"),
            BoardLine(thing: thing, at: "2026-11-03T11:00:00.000Z", id: "1.2", kind: "log", tag: "app", text: "y"),
            BoardLine(thing: thing, at: "2026-11-03T11:00:00.000Z", id: "1.1", kind: "setting", tag: "CONSOLE", text: "z"),
        ]
        #expect(BoardLog.count(lines, more: true) == "3 lines · 1 warning · more in this range")
        #expect(BoardLog.count(Array(lines.dropFirst()), more: false) == "2 lines")
        #expect(BoardLog.shown(lines, hidden: ["log"]).map(\.lineId) == ["1.3", "1.1"])
        #expect(BoardLog.dropped(1) == "1 line lost before this one")
        #expect(BoardLog.dropped(3) == "3 lines lost before this one")
    }

    @Test func theTwoKindsOfTheBoardLogHaveTheWebsitesWordsAndLook() {
        #expect(Telemetry.kind("setting") == Telemetry.Kind(id: "setting", label: "Settings", shape: "plus", hue: "b"))
        #expect(Telemetry.kind("log") == Telemetry.Kind(id: "log", label: "Other lines", shape: "dot", hue: "quiet"))
        #expect(Telemetry.kinds.map(\.id) == ["update", "firmware", "restart", "health", "bluetooth", "console", "setting", "log", "connection"])
        // Every kind a line can have is a kind of the legend.
        #expect(BoardLine.kinds.allSatisfy { kind in Telemetry.kinds.contains { $0.id == kind } })
    }

    @Test func eachBoardsLinesAreTicksOnItsOwnLane() {
        let other = "cranium-fedcba9876543210"
        let lines = [
            BoardLine(thing: thing, at: "2026-11-03T11:00:00.000Z", id: "1.2", kind: "log", tag: "app", text: "a"),
            BoardLine(thing: other, at: "2026-11-03T11:00:00.000Z", id: "1.1", kind: "log", tag: "app", text: "b"),
        ]
        let lanes = Telemetry.lanes(events: [], devices: [Device(thing: thing)], console: [], lines: lines)
        // A board with lines and no longer listed keeps its lane for them; the Console lane has none.
        #expect(lanes.map(\.id) == [thing, other, "console"])
        #expect(lanes.map { $0.lines.count } == [1, 1, 0])
        #expect(Telemetry.lanes(events: [], devices: [], thing: thing, console: nil, lines: lines).map { $0.lines.count } == [1])
    }

    @Test func linesAndReleaseNotesCanBeSearched() {
        let devices = [Device(thing: thing, name: "CRVIHAAN01")]
        let line = BoardLine(thing: thing, at: "2026-11-03T11:00:00.000Z", id: "1.2", kind: "setting", tag: "CONSOLE",
                             text: "Wi-Fi network set; joining it now")
        let items = Search.items(lines: [line], devices: devices)
        #expect(items.map(\.kind) == [.line])
        #expect(items[0].target == .boardLog(thing: thing))
        #expect(items[0].subtitle.hasPrefix("CRVIHAAN01 · CONSOLE · "))
        #expect(Search.rank("joining", in: items).map(\.item.id) == [items[0].id])
        #expect(SearchItem.Kind.line.heading == "Board log")

        let release = FirmwareRelease(version: "1.12.0+0", size: 1, sha256: String(repeating: "a", count: 64), status: "active",
                                      notes: "Every line the board prints now also goes to the console's Board log.")
        let found = Search.rank("board log", in: Search.items(releases: [release]))
        #expect(found.map(\.item.key) == ["1.12.0+0"])
    }
}

/// A release's note, changed after its upload.
@Suite struct ReleaseNoteTests {
    @Test func aNoteIsPutWholeAsOneLine() async throws {
        let answer = json(["release": ["version": "1.12.0+0", "size": 612_480, "sha256": String(repeating: "a", count: 64),
                                       "status": "active", "notes": "Every line the board prints."]])
        let http = FakeHTTP { _ in (200, answer) }
        let api = ConsoleAPI(config: testConfig, http: http, tokens: FixedToken())
        let release = try await api.setNotes(version: "1.12.0+0", notes: "Every line\nthe board prints.")
        let request = try #require(http.requests.first)
        #expect(request.httpMethod == "PUT")
        #expect(request.url?.absoluteString == "https://console.test/api/firmware/1.12.0%2B0/notes")
        let body = try #require(try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String])
        // One line, as the server takes it; "" takes a note away.
        #expect(body == ["notes": "Every line the board prints."])
        #expect(release.notes == "Every line the board prints.")
        _ = try await api.setNotes(version: "1.12.0+0", notes: String(repeating: "x", count: 600))
        let long = try #require(try JSONSerialization.jsonObject(with: http.requests[1].httpBody ?? Data()) as? [String: String])
        #expect(long["notes"]?.count == ConsoleAPI.notesLimit)
    }
}

/// Why the app has no Board setup, in the website's words (setup.js APP_WORDS).
@Suite struct BoardSetupWordsTests {
    @Test func theWordsAreTheWebsitesOwn() throws {
        let file = ConfigTests.configDir.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("cloud/web/src/site/assets/setup.js")
        let source = try String(contentsOf: file, encoding: .utf8)
        let start = try #require(source.range(of: "export const APP_WORDS = Object.freeze({"))
        let end = try #require(source.range(of: "});", range: start.upperBound..<source.endIndex))
        let block = String(source[start.upperBound..<end.lowerBound])
        let joined = try NSRegularExpression(pattern: "'\\s*\\+\\s*'")
            .stringByReplacingMatches(in: block, range: NSRange(block.startIndex..., in: block), withTemplate: "")
        func value(_ key: String) throws -> String {
            let pattern = try NSRegularExpression(pattern: "\(key):\\s*'([^']*)'")
            let match = try #require(pattern.firstMatch(in: joined, range: NSRange(joined.startIndex..., in: joined)))
            return String(joined[try #require(Range(match.range(at: 1), in: joined))])
        }
        #expect(try value("title") == BoardSetupWords.title)
        #expect(try value("ios") == BoardSetupWords.ios)
    }
}
