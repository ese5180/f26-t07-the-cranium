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
}
