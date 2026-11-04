#if DEBUG
import CraniumKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// A Debug build started with the launch argument `-CraniumDemo` shows the console with made-up
/// boards, releases and deployments, answered here without any network: for screenshots and the
/// Simulator, where nobody signs in. A Release build has none of this. `-CraniumTab 0…5` opens a
/// tab, `-CraniumRoute …` a screen on it (RootView, `Stack.firstRoute`), `-CraniumSearch` types a
/// search, `-CraniumSignedOut YES` starts at the app's own sign-in, `-CraniumDemoPassword` goes on
/// to its code step, and `-CraniumSheet signin-again` opens the sign-in again.
///
/// Face ID, with no Face ID asked: `-CraniumBiometric lock` opens on the lock screen (the prompt is
/// "cancelled", so it stays), `-CraniumBiometric offer` shows "Use Face ID to open Cranium?", and
/// `-CraniumBiometric on` has it on (More, Account), and `-CraniumBiometric relock` too, with every ask
/// after the first cancelled, so that the lock stays after 5 minutes away. `-CraniumBiometry touchID`
/// says Touch ID instead.
/// `-CraniumBiometric real` uses the real Keychain item and LocalAuthentication, for the Simulator
/// with Features > Face ID > Enrolled: turn it on in Account, then launch again.
enum Demo {
    static var isOn: Bool { ProcessInfo.processInfo.arguments.contains("-CraniumDemo") }

    static let tokens = Tokens(accessToken: "demo", refreshToken: nil, expiresAt: Date().addingTimeInterval(365 * 86_400))

    static var biometric: String? { UserDefaults.standard.string(forKey: "CraniumBiometric") }
    static var biometry: Biometry { UserDefaults.standard.string(forKey: "CraniumBiometry") == "touchID" ? .touchID : .faceID }

    /// With a refresh token when Face ID is shown, so that it has something to keep.
    static var sessionTokens: Tokens {
        guard biometric != nil else { return tokens }
        return Tokens(accessToken: "demo", refreshToken: "demo-refresh", expiresAt: tokens.expiresAt, signedInAt: Date())
    }

    static let biometricSettings: BiometricSettingsStore = {
        switch biometric {
        case "lock", "on", "relock": return MemoryBiometricSettings(BiometricSettings(owner: BiometricSettings.key(for: alice["sub"]!)))
        case "real": return DefaultsBiometricSettings()
        default: return MemoryBiometricSettings()
        }
    }()

    /// `-CraniumBiometricCheck YES`: the real Keychain item and Face ID, step by step, for the
    /// Simulator (Features > Face ID > Enrolled, then Matching Face or Non-matching Face when it asks).
    /// Prints what each step answered, never the token.
    @MainActor
    static func checkBiometricGate() async {
        func say(_ line: String) { print("[faceid-check] \(line)") }
        let gate = KeychainBiometricGate()
        if UserDefaults.standard.string(forKey: "CraniumBiometricCheck") == "changed" {
            // Turned on (with a match), then the enrolled faces change, then asked again.
            gate.forget()
            say("turning on: \(await gate.enroll("probe-token", reason: "Check Face ID").map { "no, \($0)" } ?? "yes")")
            say("change the enrolled faces now")
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            say("asking after the change…")
            switch await gate.release(reason: "Check Face ID") {
            case .success: say("released after the change (not expected)")
            case .failure(let failure): say("not released after the change: \(failure)")
            }
            gate.forget()
            say("done")
            return
        }
        say("biometry: \(gate.biometry()?.name ?? "none"), usable now: \(gate.isUsable())")
        gate.forget()
        say("before: item there: \(gate.hasRefreshToken())")
        say("kept without asking: \(gate.replace("probe-token").map { "no, \($0)" } ?? "yes")")
        say("after: item there: \(gate.hasRefreshToken())")
        // As the lock screen does: a prompt asked for before the app is active comes back cancelled.
        #if canImport(UIKit)
        for _ in 0..<50 where UIApplication.shared.applicationState != .active {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        say("app active: \(UIApplication.shared.applicationState == .active)")
        #endif
        for attempt in 1...2 {
            say("asking (\(attempt))…")
            switch await gate.release(reason: "Check Face ID") {
            case .success(let token): say("released (\(attempt)): \(token == "probe-token" ? "the token that was kept" : "another token")")
            case .failure(let failure): say("not released (\(attempt)): \(failure)")
            }
        }
        gate.forget()
        say("forgotten: item there: \(gate.hasRefreshToken())")
        say("done")
    }

    static let biometricGate: BiometricGate = {
        switch biometric {
        case "lock": return MemoryBiometricGate(biometry: biometry, kept: "demo-refresh", releaseAnswer: .cancelled)
        case "on", "relock": return MemoryBiometricGate(biometry: biometry, kept: "demo-refresh")
        case "real": return KeychainBiometricGate()
        default: return MemoryBiometricGate(biometry: biometry)
        }
    }()

    static let boards = ["cranium-3f2a9c1e5b7d4a60", "cranium-8b1d6e0f2c4a9e73", "cranium-c05e7a1b3d9f2468"]
    static let newDeployment = "cranium-1-12-0-b0-\(stamp(-600))-4c2b"
    static let oldDeployment = "cranium-1-11-4-b0-\(stamp(-2 * 86_400))-9a1f"

    static func iso(_ seconds: TimeInterval) -> String { ConsoleTime.text(Date().addingTimeInterval(seconds)) }

    static func stamp(_ seconds: TimeInterval) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.string(from: Date().addingTimeInterval(seconds))
    }

    static let alice = ["sub": "4c1e8a5e-7f1d-4b8e-9a51-1c2d3e4f5a6b", "email": "vihaan@cranium.test"]
    static let sha = { (seed: String) in ImageCheck.sha256Hex(Data(seed.utf8)) }

    static func device(_ index: Int) -> [String: Any] {
        switch index {
        case 0:
            return ["thing": boards[0], "name": "CRVIHAAN01", "online": true, "lastSeen": iso(-12),
                    "fw": ["version": "1.12.0+0", "confirmed": true],
                    "ota": ["state": "idle", "job": NSNull(), "progress": 0, "last": "succeeded", "error": ""],
                    "rssi": -58, "uptime": 15_840, "stuck": ["count": 0, "reason": "none"],
                    "diag": ["mac": "f4:ce:36:12:34:56", "channel": 6, "heap": ["free": 21_312, "least": 9_840, "size": 44_240], "at": iso(-140)],
                    "diary": ["boots": 42, "entries": [
                        ["version": "1.12.0+0", "cause": "2", "causes": ["software"], "stage": 4],
                        ["version": "1.11.4+0", "cause": "10", "causes": ["watchdog"], "stage": 4],
                        ["version": "1.11.4+0", "cause": "0", "causes": ["power_on"], "stage": 3],
                    ]],
                    "bt": ["from": "1.11.4+0", "to": "1.12.0+0", "result": "succeeded", "proof": "person", "count": 3]]
        case 1:
            return ["thing": boards[1], "name": "CRLAB02", "online": true, "lastSeen": iso(-25),
                    "fw": ["version": "1.11.4+0", "confirmed": true],
                    "ota": ["state": "downloading", "job": newDeployment, "progress": 64, "last": "succeeded", "error": ""],
                    "rssi": -71, "uptime": 420, "stuck": ["count": 1, "reason": "no_cloud"],
                    "diag": ["mac": "f4:ce:36:ab:cd:ef", "channel": 11, "heap": ["free": 8_200, "least": 5_100, "size": 44_240], "at": iso(-200)]]
        default:
            return ["thing": boards[2], "online": false, "lastSeen": iso(-3 * 3600),
                    "fw": ["version": "1.10.1+0", "confirmed": true],
                    "ota": ["state": "idle", "progress": 0, "last": "none", "error": ""], "rssi": -80, "uptime": 86_000]
        }
    }

    static func release(_ version: String, ago: TimeInterval, notes: String, revoked: Bool = false) -> [String: Any] {
        var release: [String: Any] = [
            "version": version, "size": 612_480, "sha256": sha(version), "imageHash": sha("i" + version), "keyHash": sha("key"),
            "payloadSize": 611_900, "headerSize": 512, "loadAddress": 0x8200, "filename": "latest.signed.bin", "notes": notes,
            "uploadedBy": alice, "uploadedAt": iso(-ago), "status": revoked ? "revoked" : "active",
        ]
        if revoked {
            release["revoked"] = ["by": alice, "at": iso(-ago + 3600), "reason": "Drops the Wi-Fi after a restart.",
                                  "enforcedAt": iso(-ago + 3602)]
        }
        return release
    }

    static var firmware: [String: Any] {
        ["releases": [
            // The notes are the first paragraphs of firmware/CHANGELOG.md, as upload-to-console.sh sends them.
            release("1.12.0+0", ago: 1200, notes: "Every line the board prints from its own code now also goes to the console's Board log, never a passkey or a secret, with network names and links replaced. Lines wait in memory while offline. A change in what the heartbeat carries (version, update step, stuck restarts, Wi-Fi) is reported at once instead of at the next 30 s heartbeat. Needs the console's device policy from 662e305 or later."),
            release("1.11.4+0", ago: 2 * 86_400, notes: "The board now tells the console its own device ID, the name given with INIT or SET_ID, so the console shows it as the board's name. It goes out in the diagnostics report as soon as it changes, and every five minutes."),
            release("1.11.3+0", ago: 4 * 86_400, notes: "Bluetooth updates hold: the board no longer asks the phone for other connection timing while it pairs, which dropped an iPhone's link (reason 0x22). The phone's timing is kept. This is the version the first Bluetooth update installed from."),
            release("1.11.2+1", ago: 5 * 86_400, notes: "Faster reconnect.", revoked: true),
            release("1.11.2+0", ago: 6 * 86_400, notes: "More time for a person over Bluetooth: a paired but quiet link lasts 120 s instead of 30, and the Bluetooth window 180 s instead of 120. The serial console also explains the link: its timing, PHY and packet sizes, and why it ended."),
         ],
         "signingKey": ["fingerprint": sha("key")], "slotSize": 794_624]
    }

    static var deploymentList: [[String: Any]] {
        [["id": newDeployment, "version": "1.12.0+0", "status": "IN_PROGRESS", "createdAt": iso(-600), "createdBy": alice,
          "note": "Roll out the board log", "things": [boards[1], boards[2]], "counts": ["inProgress": 1, "queued": 1]],
         ["id": oldDeployment, "version": "1.11.4+0", "status": "COMPLETED", "createdAt": iso(-2 * 86_400),
          "completedAt": iso(-2 * 86_400 + 900), "createdBy": alice, "note": "",
          "things": [boards[0], boards[1]], "counts": ["succeeded": 2]]]
    }

    static func deployment(_ id: String) -> [String: Any] {
        var detail = deploymentList.first { $0["id"] as? String == id } ?? deploymentList[0]
        if id == newDeployment {
            detail["executions"] = [
                ["thing": boards[1], "status": "IN_PROGRESS", "phase": "downloading", "progress": 64, "online": true,
                 "queuedAt": iso(-600), "startedAt": iso(-540), "lastUpdatedAt": iso(-540), "secondsLeft": 1_260, "reported": "1.11.4+0"],
                ["thing": boards[2], "status": "QUEUED", "phase": "waiting_for_device", "online": false, "queuedAt": iso(-600),
                 "lastUpdatedAt": iso(-600), "reported": "1.10.1+0"],
            ]
        } else {
            detail["executions"] = boards.prefix(2).map { thing in
                ["thing": thing, "status": "SUCCEEDED", "phase": "succeeded", "online": true, "queuedAt": iso(-2 * 86_400),
                 "startedAt": iso(-2 * 86_400 + 60), "lastUpdatedAt": iso(-2 * 86_400 + 600), "ranAtEnd": "1.11.4+0"] as [String: Any]
            }
        }
        return ["deployment": detail]
    }

    static var audit: [String: Any] {
        ["entries": [
            // A command at a board's serial console, over USB from the Android app.
            ["at": iso(-120), "actor": alice, "action": "serial.command", "target": "CRVIHAAN01", "outcome": "ok",
             "detail": ["command": "WIFI", "version": "1.12.0+0", "from": "phone"], "requestId": "Kq3xYh4AoAMEf2Q="],
            ["at": iso(-300), "actor": alice, "action": "account.sign_in", "target": "", "outcome": "ok",
             "detail": ["client": "phone"], "requestId": "signin.4c1e8a5e.phone.1793700000"],
            ["at": iso(-600), "actor": alice, "action": "deployment.create", "target": newDeployment, "outcome": "ok",
             "detail": ["version": "1.12.0+0", "things": "2", "boards": "\(boards[1]) \(boards[2])", "from": "phone"],
             "requestId": "Kq3vZh1AoAMEb5Q="],
            ["at": iso(-1200), "actor": alice, "action": "firmware.upload", "target": "1.12.0+0", "outcome": "ok",
             "detail": ["filename": "latest.signed.bin", "size": "612480", "sha256": sha("1.12.0+0")], "requestId": "Kq3tWh2AoAMEb7w="],
            ["at": iso(-1500), "actor": alice, "action": "firmware.upload", "target": "", "outcome": "rejected",
             "detail": ["code": "version_not_newer", "filename": "old.signed.bin"], "requestId": "Kq3sQh0AoAMEa1A="],
            ["at": iso(-1800), "actor": alice, "action": "account.sign_in", "target": "", "outcome": "ok",
             "detail": ["client": "web"], "requestId": "signin.4c1e8a5e.web.1793698000"],
            ["at": iso(-9 * 3600 - 300), "actor": alice, "action": "firmware.download", "target": "1.12.0+0", "outcome": "ok",
             "detail": ["sha256": sha("1.12.0+0")], "requestId": "Kq1aAh0AoAMEc1Q="],
            ["at": iso(-9 * 3600 - 240), "actor": alice, "action": "firmware.bluetooth_send", "target": "1.12.0+0", "outcome": "ok",
             "detail": ["board": "Cranium-1A2B", "sha256": sha("1.12.0+0")], "requestId": "Kq1aBh0AoAMEc3Q="],
            ["at": iso(-2 * 86_400 + 3600), "actor": alice, "action": "firmware.revoke", "target": "1.11.2+1", "outcome": "ok",
             "detail": ["reason": "Drops the Wi-Fi after a restart.", "cancelled": "0"], "requestId": "Kp9aBh0AoAMEc9Q="],
            ["at": iso(-2 * 86_400), "actor": alice, "action": "deployment.create", "target": oldDeployment, "outcome": "ok",
             "detail": ["version": "1.11.4+0", "things": "2", "boards": "\(boards[0]) \(boards[1])"], "requestId": "Kp8aBh0AoAMEd1Q="],
         ], "next": NSNull()]
    }

    /// What CRVIHAAN01, on 1.12.0, printed on its serial console: as the API sends it, newest first.
    static var boardLines: [[String: Any]] {
        var lines: [[String: Any]] = []
        var seq = 60
        func add(_ ago: TimeInterval, _ tag: String, _ kind: String, _ text: String, boot: Int = 42, dropped: Int? = nil) {
            let warn = text.hasPrefix("WRN: ") || text.hasPrefix("ERR: ") || tag == "STUCK"
            var line: [String: Any] = ["thing": boards[0], "at": iso(-ago), "id": "\(boot).\(seq)", "kind": kind, "tag": tag,
                                       "level": warn ? "warn" : "info", "text": text, "boot": boot, "seq": seq]
            if let dropped { line["dropped"] = dropped }
            lines.append(line)
            seq -= 1
        }
        add(35, "health", "health", "Heap 21312 of 44240 bytes free, 9840 at its lowest")
        add(95, "CONSOLE", "setting", "Wi-Fi network set; joining it now")
        add(110, "cloud", "log", "Connected to AWS IoT")
        add(116, "cloud", "log", "Connecting to AWS IoT as cranium-3f2a9c1e5b7d4a60", dropped: 2)
        add(118, "net", "health", "Network is up")
        add(120, "net", "health", "Network is down")
        add(900, "WIFI", "health", "WRN: Connection request failed: -116")
        add(3 * 3600, "health", "health", "Heap 20480 of 44240 bytes free, 9840 at its lowest")
        add(9 * 3600 - 190, "identity", "log", "Device ID CRVIHAAN01")
        add(9 * 3600 - 200, "ota", "update", "Confirmed 1.12.0+0")
        add(9 * 3600 - 260, "app", "log", "Cranium 1.12.0+0 running, on trial")
        add(9 * 3600 - 270, "boot_diary", "restart", "Boot 42: software reset after an update")
        seq = 31
        add(9 * 3600 - 280, "ota", "update", "Installing 1.12.0+0 on trial; restarting", boot: 41)
        add(9 * 3600 - 300, "bt_ota", "bluetooth", "Image 1.12.0+0 received, 611900 bytes; press Button 1 to install", boot: 41)
        add(9 * 3600 - 420, "BT", "bluetooth", "Paired with a phone; link 7.5 ms, 2M PHY", boot: 41)
        add(9 * 3600, "BT", "bluetooth", "Bluetooth window open for 180 s", boot: 41)
        add(12 * 3600, "STUCK", "restart", "No cloud for 300 s: restarting", boot: 41)
        add(12 * 3600 + 5, "ui", "log", "LED1 blinking: offline", boot: 41)
        return lines
    }

    /// `GET /api/events/log`, filtered as the API filters it.
    static func boardLog(_ query: [URLQueryItem]) -> [String: Any] {
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        let from = value("from").flatMap(ConsoleTime.date) ?? .distantPast
        let to = value("to").flatMap(ConsoleTime.date) ?? .distantFuture
        let kinds = value("kinds").map { Set($0.split(separator: ",").map(String.init)) }
        let tags = value("tags").map { Set($0.split(separator: ",").map(String.init)) }
        let limit = value("limit").flatMap(Int.init) ?? 500
        let lines = boardLines.filter { line in
            guard let at = ConsoleTime.date(line["at"] as? String) else { return false }
            return at >= from && at <= to
                && (value("thing") == nil || value("thing") == line["thing"] as? String)
                && (kinds?.contains(line["kind"] as? String ?? "") ?? true)
                && (tags?.contains(line["tag"] as? String ?? "") ?? true)
        }
        return ["lines": Array(lines.prefix(limit)), "cursor": NSNull(), "from": iso(-86_400), "to": iso(0)]
    }

    static var events: [String: Any] {
        var list: [[String: Any]] = []
        func add(_ thing: String, _ ago: TimeInterval, _ kind: String, _ what: String, _ text: String, warn: Bool = false,
                 extra: [String: Any] = [:]) {
            var event: [String: Any] = ["thing": thing, "at": iso(-ago), "id": String(format: "%06x", list.count + 0xa1),
                                        "kind": kind, "what": what, "level": warn ? "warn" : "info", "text": text]
            event.merge(extra) { $1 }
            list.append(event)
        }
        add(boards[1], 540, "update", "started", "Started the update to 1.12.0+0", extra: ["job": newDeployment])
        add(boards[1], 3 * 3600, "health", "heap_low", "Free memory ran low: 5 KiB of 43 KiB", warn: true)
        add(boards[2], 3 * 3600, "connection", "disconnected", "Disconnected from AWS IoT")
        add(boards[1], 4 * 3600, "restart", "booted", "Restarted after the stuck timer (no cloud)", warn: true)
        add(boards[1], 4 * 3600 - 60, "connection", "connected", "Connected to AWS IoT")
        add(boards[1], 4 * 3600 + 30, "connection", "disconnected", "Disconnected from AWS IoT")
        add(boards[0], 9 * 3600, "bluetooth", "opened", "Bluetooth window opened at the board")
        add(boards[0], 9 * 3600 - 200, "firmware", "confirmed", "Confirmed 1.12.0+0", extra: ["version": "1.12.0+0"])
        add(boards[2], 14 * 3600, "connection", "connected", "Connected to AWS IoT")
        add(boards[0], 20 * 3600, "connection", "connected", "Connected to AWS IoT")
        return ["events": list.sorted { ($0["at"] as? String ?? "") > ($1["at"] as? String ?? "") }, "cursor": NSNull()]
    }

    static func samples(hours: Int) -> [String: Any] {
        var samples: [[String: Any]] = []
        let count = min(hours * 12, 600)
        for index in 0..<count {
            let ago = Double(hours * 3600) * (1 - Double(index) / Double(count))
            if ago > 4 * 3600 && ago < 4.6 * 3600 { continue }  // a gap: the board was not reporting
            let wave = sin(Double(index) / 9)
            samples.append(["at": iso(-ago), "rssi": Int(-60 + 6 * wave + Double(index % 3)), "uptime": index * 300,
                            "heapFree": Int(21_000 + 2_500 * cos(Double(index) / 14)), "heapLeast": 9_840])
        }
        return ["thing": boards[0], "hours": hours, "from": iso(-Double(hours) * 3600), "to": iso(0),
                "samples": samples, "bucketSeconds": count == 600 ? hours * 6 : 0]
    }

    static var tokenList: [String: Any] {
        ["tokens": [
            ["id": "0a1b2c3d4e5f6a7b", "name": "MacBook ota.sh", "createdAt": iso(-5 * 86_400), "expiresAt": iso(25 * 86_400),
             "revokedAt": NSNull(), "status": "active"],
            ["id": "9f8e7d6c5b4a3f2e", "name": "CI bench", "createdAt": iso(-40 * 86_400), "expiresAt": iso(-10 * 86_400),
             "revokedAt": NSNull(), "status": "expired"],
        ], "limit": 10, "maxDays": 90]
    }

    /// The answer to one request, as the console would give it.
    static func answer(_ request: URLRequest) -> (Int, Any) {
        guard let url = request.url else { return (404, [:]) }
        let parts = url.path.split(separator: "/").map(String.init)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        switch parts {
        case ["api", "me"]:
            return (200, ["sub": alice["sub"]!, "email": alice["email"]!, "groups": ["release-managers"], "canWrite": true,
                          "expiresAt": Date().addingTimeInterval(3000).timeIntervalSince1970])
        case ["api", "devices"]:
            return (200, ["devices": (0..<3).map(device), "generatedAt": iso(0)])
        case _ where parts.count == 3 && parts[1] == "devices":
            let index = boards.firstIndex(of: parts[2]) ?? 0
            return (200, ["device": device(index), "certificates": ["5d0c2b7e9a14f3c8"],
                          "executions": deploymentList.filter { ($0["things"] as? [String] ?? []).contains(parts[2]) }.map { item in
                              ["deployment": item["id"]!, "version": item["version"]!,
                               "status": item["status"] as? String == "COMPLETED" ? "SUCCEEDED" : (index == 0 ? "IN_PROGRESS" : "QUEUED"),
                               "queuedAt": item["createdAt"]!, "lastUpdatedAt": item["createdAt"]!]
                          }, "olderExecutions": 0])
        case _ where parts.count == 4 && parts[3] == "samples":
            return (200, samples(hours: Int(query.first { $0.name == "hours" }?.value ?? "24") ?? 24))
        case ["api", "events"]:
            return (200, events)
        case ["api", "events", "log"]:
            return (200, boardLog(query))
        case ["api", "firmware"]:
            return (200, firmware)
        case ["api", "deployments"]:
            return (200, ["deployments": deploymentList])
        case _ where parts.count == 3 && parts[1] == "deployments":
            return (200, deployment(parts[2]))
        case ["api", "audit"]:
            return (200, audit)
        case ["api", "tokens"]:
            return (200, tokenList)
        default:
            return (403, ["error": ["code": "phone_sign_in_again", "message": FreshSignIn.ask, "requestId": "demo"]])
        }
    }
}

/// Cognito's sign-in, answered with no network: any password, then any six digits. Only for
/// screenshots of the app's own sign-in in demo mode (`-CraniumSignedOut YES`).
struct DemoCognito: HTTPClient {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard let url = request.url else { throw URLError(.badURL) }
        let target = request.value(forHTTPHeaderField: "X-Amz-Target") ?? ""
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        func hex(_ count: Int) -> String { (0..<count).map { _ in String(format: "%02x", UInt8.random(in: 1...255)) }.joined() }
        let answer: [String: Any]
        if target.hasSuffix("InitiateAuth") {
            answer = ["ChallengeName": "PASSWORD_VERIFIER", "ChallengeParameters": [
                "SALT": hex(16), "SECRET_BLOCK": Data(hex(48).utf8).base64EncodedString(), "SRP_B": hex(32),
                "USERNAME": "demo-user", "USER_ID_FOR_SRP": "demo-user",
            ]]
        } else if body["ChallengeName"] as? String == "PASSWORD_VERIFIER" {
            answer = ["ChallengeName": "SOFTWARE_TOKEN_MFA", "Session": Data(hex(24).utf8).base64EncodedString(),
                      "ChallengeParameters": [String: String]()]
        } else {
            answer = ["AuthenticationResult": ["TokenType": "Bearer", "AccessToken": "demo", "ExpiresIn": 3600,
                                               "RefreshToken": "demo-refresh", "IdToken": "demo-id"] as [String: Any],
                      "ChallengeParameters": [String: String]()]
        }
        let headers = ["Content-Type": "application/x-amz-json-1.1"]
        return (try JSONSerialization.data(withJSONObject: answer),
                HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!)
    }
}

/// The console, answered from `Demo` with no network at all.
struct DemoHTTP: HTTPClient {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try? await Task.sleep(nanoseconds: 150_000_000)
        guard let url = request.url else { throw URLError(.badURL) }
        if url.path == "/" || url.path.hasSuffix("history.json") {
            let page = Data(#"<script src="/assets/demo/app.js"></script>"#.utf8)
            let history = try JSONSerialization.data(withJSONObject: [
                "deployment": ["commit": "4c2b5ef0a1b2c3d4e5f60718293a4b5c6d7e8f90", "tree": "clean", "deployedAt": Demo.iso(-3600)],
                "commits": [["hash": "4c2b5ef0a1b2c3d4e5f60718293a4b5c6d7e8f90", "short": "4c2b5ef", "date": Demo.iso(-3600),
                             "subject": "Let the phone apps do everything the website does", "tags": ["cloud", "docs"]],
                            ["hash": "368b8440a1b2c3d4e5f60718293a4b5c6d7e8f90", "short": "368b844", "date": Demo.iso(-7200),
                             "subject": "Fix the findings of the security review", "tags": ["website"]]],
            ])
            return (url.path == "/" ? page : history, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let (status, body) = Demo.answer(request)
        let data = try JSONSerialization.data(withJSONObject: body)
        return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
#endif
