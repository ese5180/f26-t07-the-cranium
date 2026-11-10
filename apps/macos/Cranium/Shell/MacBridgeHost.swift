import AppKit
import CraniumKit
import UniformTypeIdentifiers
import WebKit

/// The Mac app's side of the bridge (apps/shared/bridge.json), the iPhone app's `ShellBridgeHost` without
/// what only a phone has (haptics, the camera, the screen's idle timer, the share sheet). The method
/// handlers are thin calls into CraniumKit; `BridgeDispatcher` checks each request against the contract
/// before one of them sees it. Bluetooth is the iPhone's `ShellRadio`, compiled here as it is.
@MainActor
final class MacBridgeHost {
    static let features: Set<String> = ["auth", "biometric", "ble", "clipboard", "open", "settings", "storage", "share", "usb"]

    private let pages = PageStore.standard()
    private weak var owner: MacShellModel?
    private var model: MacShellModel {
        get throws {
            guard let owner else { throw BridgeError.failed("The app is closing.") }
            return owner
        }
    }
    let dispatcher = BridgeDispatcher(features: MacBridgeHost.features)
    private lazy var radio = ShellRadio { [weak self] name, data in self?.send(name, data) }
    /// The board's USB serial port, for the Serial console and Board setup (usb.*).
    private lazy var serial = MacSerial(choose: { await MacSerialPicker.choose(from: $0) }, emit: { [weak self] name, data in self?.send(name, data) })

    init(model: MacShellModel) {
        self.owner = model
        registerApp()
        registerAuth()
        registerDevice()
        registerStorage()
        registerBluetooth()
        registerSerial()
    }

    /// The page went away (a reload or a new document): the board's ports are closed, as Android does.
    func pageLeft() {
        serial.closeAll()
    }

    // MARK: To the page

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

    // MARK: app.*

    private func registerApp() {
        dispatcher.register("app.hello") { [unowned self] _ in
            let model = try model
            let bundle = model.bundle
            return [
                "bridge": .int(Bridge.version),
                // Pages that do not know `macos` take the transport's platform, ios, as they did.
                "platform": "macos",
                "shell": ["version": .string(model.shellVersion), "build": .string(model.shellBuild)],
                "bundle": ["id": .string(bundle?.id), "console": .string(bundle?.manifest.consoleVersion),
                           "source": .string(bundle?.source.rawValue)],
                "features": .array(dispatcher.featureList.map { .string($0) }),
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
        dispatcher.register("app.open") { [unowned self] params in
            let console = try model.config?.consoleURL
            guard let url = URL(string: params.string("url")), ShellPolicy.mayOpenOutside(url, console: console) else {
                throw BridgeError(.notAllowed, "The app opens https:, sidestore: and otpauth: addresses only.")
            }
            if !NSWorkspace.shared.open(url) { throw BridgeError.failed("Nothing on this Mac opens that address.") }
            return [:]
        }
        dispatcher.register("app.settings") { [unowned self] _ in
            try model.showSettings = true
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

    // MARK: clipboard, share

    private func registerDevice() {
        dispatcher.register("clipboard.write") { params in
            let board = NSPasteboard.general
            board.clearContents()
            let text = params.string("text")
            board.setString(text, forType: .string)
            if let seconds = params.optionalInt("expiresIn") {
                // Gone after that time, if nothing else was copied meanwhile (as the phone's passkey copy is).
                let count = board.changeCount
                DispatchQueue.main.asyncAfter(deadline: .now() + TimeInterval(seconds)) {
                    if NSPasteboard.general.changeCount == count { NSPasteboard.general.clearContents() }
                }
            }
            return [:]
        }
        // The Mac's share is a save panel: the person picks where the file goes.
        dispatcher.register("file.share") { params in
            guard let data = Data(base64Encoded: params.string("data")) else { throw BridgeError.badRequest("The file is not base64.") }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = params.string("name")
            guard panel.runModal() == .OK, let target = panel.url else { return ["shared": .bool(false)] }
            do {
                try data.write(to: target, options: .atomic)
            } catch {
                throw BridgeError.failed("The file could not be saved.")
            }
            return ["shared": .bool(true)]
        }
    }

    // MARK: storage.*

    private func registerStorage() {
        let pages = pages
        dispatcher.register("storage.get") { params in
            let key = params.string("key")
            let value = try await Task.detached { try pages.get(key) }.value
            return ["value": value.map { .string($0) } ?? .null]
        }
        dispatcher.register("storage.set") { params in
            let key = params.string("key")
            let value = params.string("value")
            try await Task.detached { try pages.set(key, value) }.value
            return [:]
        }
        dispatcher.register("storage.remove") { params in
            let key = params.string("key")
            try await Task.detached { try pages.remove(key) }.value
            return [:]
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

extension MacBridgeHost {
    // MARK: usb.*

    /// The Android app's usb.* (ShellUsb), over the Mac's serial ports (MacSerial).
    fileprivate func registerSerial() {
        dispatcher.register("usb.open") { [unowned self] params in try await serial.open(baudRate: params.int("baudRate")) }
        dispatcher.register("usb.write") { [unowned self] params in
            try await serial.write(port: params.int("port"), base64: params.string("data"))
            return [:]
        }
        dispatcher.register("usb.close") { [unowned self] params in
            serial.close(port: params.int("port"))
            return [:]
        }
    }
}
