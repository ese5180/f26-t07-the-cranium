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
    /// What the iPhone offers: everything but the Android app's own updater and USB, and the camera (Scan
    /// board) where the iPhone has one. Offline mode (bleOffline) is the board's own GATT service on the same radio.
    static var features: Set<String> {
        var offered: Set<String> = ["auth", "biometric", "ble", "clipboard", "haptics", "share", "open", "keepAwake", "settings",
                                    "storage", "bleOffline"]
        if BoardScanner.hasCamera { offered.insert("camera") }
        return offered
    }
    /// What the pages keep through storage.*: the web view itself keeps nothing between runs.
    private let pages = PageStore.standard()

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
        registerStorage()
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
        dispatcher.register("app.open") { [unowned self] params in
            let console = try model.config?.consoleURL
            guard let url = URL(string: params.string("url")), ShellPolicy.mayOpenOutside(url, console: console) else {
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
        // Scan board: the camera only now, when the person tapped it; the link checked against this app's console.
        dispatcher.register("camera.scan") { [unowned self] _ in
            guard let loaded = try model.loaded else { throw BridgeError.failed("This build has no configuration.") }
            return ["thing": .string(try await BoardScanner.scan(console: loaded.config.consoleURL))]
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

    // MARK: storage.*

    /// The pages' own items, such as the customer site's journal, in the app's PageStore: off the main
    /// thread, as a value may be a few megabytes.
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
        // Offline mode: the console's Offline page, on the same radio (never with ble.connect's link at once).
        dispatcher.register("ble.offline.connect") { [unowned self] params in try await radio.offlineConnect(params.string("id")) }
        dispatcher.register("ble.offline.status") { [unowned self] _ in try radio.offlineStatus() }
        dispatcher.register("ble.offline.accept") { [unowned self] params in
            try await radio.offlineAccept(params.string("version"))
            return [:]
        }
        dispatcher.register("ble.offline.disconnect") { [unowned self] _ in
            radio.offlineDisconnect()
            return [:]
        }
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
