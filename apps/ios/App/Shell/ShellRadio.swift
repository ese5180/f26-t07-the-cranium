import CraniumBLE
import CraniumKit
import Foundation

/// Bluetooth for the bridge, with the classic app's pieces: `BoardRadio` (made only when the page first
/// asks, so that the iPhone asks for Bluetooth then), `McuMgrBoardTransport` (pairing, image list, upload
/// only) and `StatusWatcher` (the board after its restart). One board at a time.
@MainActor
final class ShellRadio {
    private let send: (String, [String: JSONValue]) -> Void
    private var made: BoardRadio?
    private var transport: McuMgrBoardTransport?
    private var watcher: StatusWatcher?
    private var scanning = false
    private var forwardStatus = false
    private var uploading = false
    private var lastBoards: [String] = []
    private var lastBoardsSent = Date.distantPast
    private var lastProgress = Date.distantPast

    init(send: @escaping (String, [String: JSONValue]) -> Void) {
        self.send = send
    }

    private var radio: BoardRadio {
        if let made { return made }
        let radio = BoardRadio()
        radio.onChange = { [weak self] in Task { @MainActor in self?.changed() } }
        made = radio
        return radio
    }

    /// The radio's state, once CoreBluetooth has said it (2 s at most).
    func state() async -> String {
        if Self.offlineDemo { return "on" }
        let radio = radio
        for _ in 0..<20 where radio.state == .starting {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        switch radio.state {
        case .ready: return "on"
        case .off: return "off"
        case .unauthorized: return "unauthorized"
        case .unsupported: return "unsupported"
        case .starting: return "unknown"
        }
    }

    func scan(_ on: Bool) {
        if Self.offlineDemo {
            scanning = on
            if on { demoBoards() }
            return
        }
        scanning = on
        if on {
            lastBoards = []
            radio.startScanning()
        } else {
            made?.stopScanning()
        }
    }

    /// The list of boards when it changes; an RSSI that changed alone, once a second at most.
    private func changed() {
        guard scanning, let radio = made else { return }
        let names = radio.boards.map { "\($0.id.uuidString) \($0.name)" }
        guard names != lastBoards || Date().timeIntervalSince(lastBoardsSent) >= 1 else { return }
        lastBoards = names
        lastBoardsSent = Date()
        send("ble.boards", ["boards": .array(radio.boards.map {
            ["id": .string($0.id.uuidString), "name": .string($0.name), "rssi": .int($0.rssi)]
        })])
    }

    func connect(_ id: String) async throws -> String {
        guard transport == nil else { throw BridgeError(.busy, "A board is connected already. Let it go first.") }
        guard offline == nil else { throw BridgeError(.busy, "A board is connected in offline mode. Let it go first.") }
        guard let board = made?.boards.first(where: { $0.id.uuidString.caseInsensitiveCompare(id) == .orderedSame }),
              let link = made?.transport(for: board) else {
            throw BridgeError.failed("That board is not in the list any more. Look for it again.")
        }
        transport = link
        scanning = false
        forwardStatus = false
        let name = board.name
        link.onClose = { [weak self, weak link] error in
            guard let self else { return }
            if let link, self.transport === link { self.transport = nil }
            self.send("ble.link", ["state": "disconnected", "name": .string(name), "error": .string(error.localizedDescription)])
        }
        link.observeStatusPayload { [weak self] payload in
            guard let self, self.forwardStatus else { return }
            self.send("ble.status", ["payload": .string(payload.base64EncodedString()), "afterRestart": false])
        }
        do {
            // Connects and pairs: the iPhone asks for the passkey while this runs.
            try await link.connect()
        } catch {
            if transport === link { transport = nil }
            throw BridgeError.failed(UserMessage.text(for: error))
        }
        send("ble.link", ["state": "connected", "name": .string(name), "error": nil])
        return name
    }

    private func linked() throws -> McuMgrBoardTransport {
        guard let transport else { throw BridgeError.failed("No board is connected.") }
        return transport
    }

    func images() async throws -> [String: JSONValue] {
        let link = try linked()
        do {
            return ShellBluetooth.images(try await link.readImageState())
        } catch {
            throw BridgeError.failed(UserMessage.text(for: error))
        }
    }

    func upload(base64: String, sha256: String) async throws {
        let link = try linked()
        guard !uploading else { throw BridgeError(.busy, "An upload is under way.") }
        let image = try ShellBluetooth.image(base64: base64, sha256: sha256)
        uploading = true
        defer { uploading = false }
        do {
            try await link.upload(image) { [weak self] progress in
                Task { @MainActor in self?.progress(progress) }
            }
        } catch {
            throw BridgeError.failed(UserMessage.text(for: error))
        }
        send("ble.progress", ["sent": .int(image.data.count), "total": .int(image.data.count)])
    }

    private func progress(_ progress: UploadProgress) {
        guard progress.sent >= progress.total || Date().timeIntervalSince(lastProgress) >= 0.15 else { return }
        lastProgress = Date()
        send("ble.progress", ["sent": .int(progress.sent), "total": .int(progress.total)])
    }

    func cancel() {
        transport?.cancelUpload()
    }

    func status() throws -> [String: JSONValue] {
        let link = try linked()
        forwardStatus = true
        return ["supported": .bool(link.hasStatus), "payload": .string(link.lastStatusPayload?.base64EncodedString())]
    }

    func disconnect() async {
        let link = transport
        transport = nil
        forwardStatus = false
        await link?.disconnect()
    }

    func watch(version: String, hash: String?) {
        stopWatching()
        let watcher = StatusWatcher(radio: radio, accept: { ShellBluetooth.isAboutThisSend($0, version: version, hash: hash) },
                                    onStatus: { _ in }, onPayload: { [weak self] payload in
                                        Task { @MainActor in
                                            self?.send("ble.status", ["payload": .string(payload.base64EncodedString()),
                                                                      "afterRestart": true])
                                        }
                                    })
        self.watcher = watcher
        watcher.start()
    }

    func stopWatching() {
        watcher?.stop()
        watcher = nil
    }

    // MARK: Offline mode (ble.offline.*)

    /// Offline mode's link (firmware 1.19.0): `OfflineLink`, which classic 0.9.0 drew a screen of its own
    /// for. The console's Offline page reads the status bytes itself; this connects, pairs (the system's
    /// passkey box), hands over each status and writes the one accept. Never at the same time as `transport`.
    private var offline: OfflineLink?
    private var offlineConnecting: CheckedContinuation<[String: JSONValue], Error>?

    var offlineIsUp: Bool { offline != nil }

    func offlineConnect(_ id: String) async throws -> [String: JSONValue] {
        if Self.offlineDemo { return try await demoConnect(id) }
        guard transport == nil else {
            throw BridgeError(.busy, "An update over Bluetooth has a board. Let it finish first.")
        }
        guard offline == nil else { throw BridgeError(.busy, "A board is connected already. Let it go first.") }
        guard let board = made?.boards.first(where: { $0.id.uuidString.caseInsensitiveCompare(id) == .orderedSame }),
              let link = made?.offlineLink(for: board) else {
            throw BridgeError.failed("That board is not in the list any more. Look for it again.")
        }
        offline = link
        scanning = false
        let name = board.name
        return try await withCheckedThrowingContinuation { continuation in
            offlineConnecting = continuation
            link.onPayload = { [weak self, weak link] payload in
                guard let self, let link, self.offline === link else { return }
                let text = JSONValue.string(payload.base64EncodedString())
                if let waiting = self.offlineConnecting {
                    self.offlineConnecting = nil
                    waiting.resume(returning: ["name": .string(name), "payload": text])
                } else {
                    self.send("ble.offline.status", ["payload": text])
                }
            }
            link.onState = { [weak self, weak link] state in
                guard let self, let link, self.offline === link, case .failed(let words) = state else { return }
                self.offline = nil
                if let waiting = self.offlineConnecting {
                    self.offlineConnecting = nil
                    waiting.resume(throwing: BridgeError.failed(words))
                } else {
                    self.send("ble.offline.link", ["state": "disconnected", "error": .string(words)])
                }
            }
            link.connect()
        }
    }

    private func offlineLinked() throws -> OfflineLink {
        guard let offline else { throw BridgeError.failed("No board is connected in offline mode.") }
        return offline
    }

    /// The status read last (at most a few seconds old), and a read now, which comes as ble.offline.status.
    func offlineStatus() throws -> [String: JSONValue] {
        if Self.offlineDemo, demoLinked { return ["payload": .string(Self.demoPayload(waiting: demoWaiting))] }
        let link = try offlineLinked()
        guard let payload = link.lastPayload else { throw BridgeError.failed("The board has not answered yet.") }
        link.refresh()
        return ["payload": .string(payload.base64EncodedString())]
    }

    func offlineAccept(_ version: String) async throws {
        if Self.offlineDemo, demoLinked {
            try await Task.sleep(nanoseconds: 600_000_000)
            demoWaiting = false
            return
        }
        let link = try offlineLinked()
        let problem: String? = await withCheckedContinuation { continuation in
            link.accept(version: version) { continuation.resume(returning: $0) }
        }
        if let problem { throw BridgeError.failed(problem) }
    }

    func offlineDisconnect() {
        demoLinked = false
        let link = offline
        offline = nil
        link?.onPayload = nil
        link?.onState = nil
        link?.close()
        if let waiting = offlineConnecting {
            offlineConnecting = nil
            waiting.resume(throwing: BridgeError(.cancelled, "The board was let go."))
        }
    }

    // MARK: A made-up board for the Simulator (Debug only)

    /// The Simulator has no Bluetooth. A Debug build started with `-CraniumOfflineDemo` answers the radio's state,
    /// the scan and ble.offline.* with one made-up board (firmware 1.19.0, version 1.20 waiting), so that the
    /// Offline page can be looked at there. A Release build has none of this.
    #if DEBUG
    static let offlineDemo = ProcessInfo.processInfo.arguments.contains("-CraniumOfflineDemo")
    #else
    static let offlineDemo = false
    #endif
    private var demoLinked = false
    private var demoWaiting = true

    private func demoBoards() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard scanning else { return }
            send("ble.boards", ["boards": [["id": "6F1A2B3C-0000-4000-8000-00000000C0DE", "name": "Cranium-3F9C", "rssi": -58]]])
        }
    }

    private func demoConnect(_ id: String) async throws -> [String: JSONValue] {
        scanning = false
        try await Task.sleep(nanoseconds: 1_500_000_000)
        demoLinked = true
        demoWaiting = true
        return ["name": "Cranium-3F9C", "payload": .string(Self.demoPayload(waiting: true))]
    }

    /// Format 1 of firmware/app/src/policy/bt_offline_policy.h: Wi-Fi up, cloud down, 1.19.0 running for 1 h 2 min.
    static func demoPayload(waiting: Bool) -> String {
        var bytes = [UInt8](repeating: 0, count: OfflineStatus.length)
        bytes[0] = OfflineStatus.format
        bytes[1] = 2
        bytes[2] = 1
        bytes[3] = waiting ? 4 : 0
        bytes[4] = 1
        bytes[6] = 1
        bytes[7] = 19
        bytes[14] = 0x8d
        bytes[15] = 0x0e
        if waiting {
            bytes[18] = 1
            bytes[19] = 20
        }
        return Data(bytes).base64EncodedString()
    }
}
