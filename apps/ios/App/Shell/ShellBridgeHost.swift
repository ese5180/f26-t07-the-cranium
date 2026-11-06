import CraniumBLE
import CraniumKit
import UIKit
import UniformTypeIdentifiers
import WebKit

/// The app's side of the bridge (apps/shared/bridge.json): every method the iPhone offers, each a thin
/// call into what the classic app already has. `BridgeDispatcher` checks each request against the
/// contract before a handler here sees it.
@MainActor
final class ShellBridgeHost {
    /// What the iPhone offers: everything but the Android app's own updater.
    static let features: Set<String> = ["auth", "biometric", "ble", "clipboard", "haptics", "share", "open", "keepAwake", "settings"]

    /// Weak: a request may still be under way while the shell goes, for the classic app.
    private weak var owner: ShellModel?
    private var model: ShellModel {
        get throws {
            guard let owner else { throw BridgeError.failed("The app is closing.") }
            return owner
        }
    }
    let dispatcher = BridgeDispatcher(features: ShellBridgeHost.features)
    private lazy var radio = ShellRadio { [weak self] name, data in self?.send(name, data) }

    init(model: ShellModel) {
        self.owner = model
        registerApp()
        registerAuth()
        registerDevice()
        registerBluetooth()
    }

    // MARK: To the page

    /// A request's text from the page; the answer goes back the way events do.
    func receive(_ text: String) {
        Task {
            if let answer = await dispatcher.handle(text) { deliver(answer) }
        }
    }

    func send(_ event: String, _ data: [String: JSONValue]) {
        deliver(BridgeEnvelope.event(event, data))
    }

    /// Into the page, as an argument and never as code: `cranium-native` with the text as its detail.
    private func deliver(_ text: String) {
        guard let webView = owner?.webView, let url = webView.url, ShellPolicy.isBundle(url) else { return }
        webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('cranium-native', { detail: text }));",
                                    arguments: ["text": text], in: nil, in: .page, completionHandler: nil)
    }

    /// Leaving the foreground: the screen may sleep again.
    func leaveBackgroundState() {
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // MARK: app.*

    private func registerApp() {
        dispatcher.register("app.hello") { [unowned self] _ in
            let model = try model
            let bundle = model.bundle
            return [
                "bridge": .int(Bridge.version),
                "platform": "ios",
                "shell": ["version": .string(model.shellVersion), "build": .string(model.shellBuild)],
                "bundle": ["id": .string(bundle?.id), "console": .string(bundle?.manifest.consoleVersion),
                           "source": .string(bundle?.source.rawValue)],
                "features": .array(dispatcher.featureList.map { .string($0) }),
                // The console's newest bundle needs a newer bridge than this app has (bridge.json, "update").
                "needsNewerApp": .bool(model.needsNewerApp),
            ]
        }
        dispatcher.register("app.config") { [unowned self] _ in
            guard let loaded = try model.loaded else { throw BridgeError.failed("This build has no configuration.") }
            let config = loaded.config
            let customer = config.customer
            return [
                "consoleUrl": .string(Self.trimmed(config.consoleURL)),
                "region": .string(config.userPool?.region),
                "userPoolId": .string(config.userPool?.id),
                "mobileClientId": .string(config.mobileClientId),
                "customerApiUrl": .string(customer.map { Self.trimmed($0.apiURL) }),
                "customerRegion": .string(customer?.pool.region),
                "customerUserPoolId": .string(customer?.pool.id),
                "customerClientId": .string(customer?.clientId),
                // The live API's WebSocket (docs/live.md); null for a build whose configuration has none.
                "liveUrl": .string(config.liveURL?.absoluteString),
                "example": .bool(loaded.source == .example),
            ]
        }
        dispatcher.register("app.ready") { [unowned self] _ in
            try await model.pageReady()
            return [:]
        }
        dispatcher.register("app.reload") { [unowned self] _ in
            let model = try model
            Task { await model.reload() }
            return [:]
        }
        dispatcher.register("app.open") { params in
            guard let url = URL(string: params.string("url")), ShellPolicy.mayOpenOutside(url) else {
                throw BridgeError(.notAllowed, "The app opens https:, sidestore: and otpauth: addresses only.")
            }
            let opened = await UIApplication.shared.open(url)
            if !opened { throw BridgeError.failed("Nothing on this iPhone opens that address.") }
            return [:]
        }
        dispatcher.register("app.settings") { [unowned self] _ in
            try model.showSettings = true
            return [:]
        }
        dispatcher.register("app.keepAwake") { params in
            UIApplication.shared.isIdleTimerDisabled = params.bool("on")
            return [:]
        }
    }

    static func trimmed(_ url: URL) -> String {
        var text = url.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    // MARK: auth.*, biometric.*

    private func pool(_ params: BridgeParams) throws -> (ShellAuthPool.Pool, ShellAuthPool) {
        guard let name = ShellAuthPool.Pool(rawValue: params.string("pool")) else { throw BridgeError.badRequest("No such pool.") }
        guard let pool = try model.pools[name] else {
            throw BridgeError(.unavailable, name == .customer ? "This build has no customer sign-in." : "This build has no sign-in.")
        }
        return (name, pool)
    }

    private func registerAuth() {
        dispatcher.register("auth.store") { [unowned self] params in
            let (name, pool) = try pool(params)
            let state = try await pool.store(refreshToken: params.string("refreshToken"), accessToken: params.string("accessToken"),
                                             expiresIn: params.int("expiresIn"))
            // The offer comes after the answer, over the page.
            let model = try model
            Task { @MainActor in model.offerBiometric(name, state) }
            return ["biometric": state.json]
        }
        dispatcher.register("auth.session") { [unowned self] params in
            let (_, pool) = try pool(params)
            guard let access = try await pool.access() else { return ["signedIn": false] }
            return ["signedIn": true, "accessToken": .string(access.token), "expiresIn": .int(access.expiresIn)]
        }
        dispatcher.register("auth.signOut") { [unowned self] params in
            let (_, pool) = try pool(params)
            await pool.signOut()
            return [:]
        }
        dispatcher.register("biometric.status") { [unowned self] params in
            let (_, pool) = try pool(params)
            return (await pool.biometricState()).json.objectValue ?? [:]
        }
        dispatcher.register("biometric.set") { [unowned self] params in
            let (_, pool) = try pool(params)
            return ["enabled": .bool(try await pool.setBiometric(params.bool("enabled")))]
        }
    }

    // MARK: clipboard, haptics, share

    private func registerDevice() {
        dispatcher.register("clipboard.write") { params in
            let item = [UTType.utf8PlainText.identifier: params.string("text")]
            if let seconds = params.optionalInt("expiresIn") {
                // As 0.6.2 put the passkey there: this phone only, and gone after that time.
                UIPasteboard.general.setItems([item], options: [.localOnly: true,
                                                                .expirationDate: Date().addingTimeInterval(TimeInterval(seconds))])
            } else {
                UIPasteboard.general.setItems([item])
            }
            return [:]
        }
        dispatcher.register("haptics.play") { params in
            switch params.string("kind") {
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            case "selection": UISelectionFeedbackGenerator().selectionChanged()
            default: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            }
            return [:]
        }
        dispatcher.register("file.share") { params in
            guard let data = Data(base64Encoded: params.string("data")) else { throw BridgeError.badRequest("The file is not base64.") }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            // The name passed the contract's pattern: letters, digits, dots, spaces and dashes, no slash.
            let file = folder.appendingPathComponent(params.string("name"), isDirectory: false)
            try data.write(to: file, options: .completeFileProtection)
            return ["shared": .bool(await Self.share(file))]
        }
    }

    /// The share sheet, over whatever is on screen: true if the person sent or saved the file.
    static func share(_ file: URL) async -> Bool {
        guard let top = UIApplication.shared.topViewController else { return false }
        return await withCheckedContinuation { continuation in
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, _ in continuation.resume(returning: completed) }
            sheet.popoverPresentationController?.sourceView = top.view
            top.present(sheet, animated: true)
        }
    }

    // MARK: ble.*

    private func registerBluetooth() {
        dispatcher.register("ble.state") { [unowned self] _ in ["state": .string(await radio.state())] }
        dispatcher.register("ble.scan") { [unowned self] params in
            radio.scan(params.bool("on"))
            return [:]
        }
        dispatcher.register("ble.connect") { [unowned self] params in ["name": .string(try await radio.connect(params.string("id")))] }
        dispatcher.register("ble.images") { [unowned self] _ in try await radio.images() }
        dispatcher.register("ble.upload") { [unowned self] params in
            try await radio.upload(base64: params.string("image"), sha256: params.string("sha256"))
            return [:]
        }
        dispatcher.register("ble.cancel") { [unowned self] _ in
            radio.cancel()
            return [:]
        }
        dispatcher.register("ble.status") { [unowned self] _ in try radio.status() }
        dispatcher.register("ble.disconnect") { [unowned self] _ in
            await radio.disconnect()
            return [:]
        }
        dispatcher.register("ble.watch") { [unowned self] params in
            if params.bool("on") {
                guard let version = params.optionalString("version") else { throw BridgeError.badRequest("version is missing.") }
                radio.watch(version: version, hash: params.optionalString("hash"))
            } else {
                radio.stopWatching()
            }
            return [:]
        }
    }
}

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

extension UIApplication {
    /// What is on screen now, to present over.
    var topViewController: UIViewController? {
        let window = connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
