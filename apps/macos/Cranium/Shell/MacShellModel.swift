import AppKit
import Combine
import CraniumKit
import SwiftUI
import WebKit

/// The Mac app's shell, the iPhone app's `ShellModel` for a Mac (docs/mac-app.md): which bundle the web view
/// is served from, the check for a newer one, the two sign-ins behind the bridge, and the native pieces
/// around the page (the lock screen, the Touch ID offer, the settings sheet). Everything with logic is
/// CraniumKit's: `BundleStore`, `ShellAuthPool`, `ShellPolicy` and the bridge's `BridgeDispatcher`.
@MainActor
final class MacShellModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready(LoadedBundle)
        case failed(String)
    }

    enum Cover: Equatable {
        /// While the app is in the background with a sign-in behind Touch ID.
        case privacy
        /// Back after 5 minutes: Touch ID first.
        case lock
    }

    struct Offer: Identifiable {
        let id = UUID()
        let pool: ShellAuthPool.Pool
        let biometry: Biometry
    }

    @Published private(set) var phase: Phase = .loading
    @Published var showSettings = false
    @Published private(set) var cover: Cover?
    @Published private(set) var lockMessage: String?
    @Published var offer: Offer?
    @Published private(set) var checking = false
    @Published private(set) var updateNote: String?
    @Published private(set) var needsNewerApp = false

    let loaded: LoadedConfig?
    let store: BundleStore
    private(set) var pools: [ShellAuthPool.Pool: ShellAuthPool] = [:]
    /// The serial bridge, the radio and keep-awake of the whole app (MacShared).
    let shared: MacShared
    /// The app's first window. It alone watches the Mac, holds the Touch ID lock and writes the bundle store; a
    /// board's own window is one of its `secondaries`, shares its sign-ins, store and services, shows its cover,
    /// and sends what needs the lock or the store to it.
    private(set) weak var primary: MacShellModel?
    private var secondaries: [WeakModel] = []
    private var following: [AnyCancellable] = []
    static weak var main: MacShellModel?

    private struct WeakModel {
        weak var model: MacShellModel?
        init(_ model: MacShellModel) { self.model = model }
    }

    /// The windows other than the first.
    private var others: [MacShellModel] { secondaries.compactMap(\.model) }
    /// Every window: this one and, for the first, the others.
    var windows: [MacShellModel] { [self] + others }
    lazy var host = MacBridgeHost(model: self)
    weak var webView: WKWebView?
    /// Where this window's page is now (hash changes included), for the menus.
    @Published private(set) var currentURL: URL?
    /// Another start address than the default, for a board's own window.
    let startURL: URL?

    /// The console is asked for a newer bundle at most this often when the app comes back.
    static let checkEvery: TimeInterval = 10 * 60
    private var lastCheck: Date?
    private var started = false
    private var slept = false
    private var observers: [NSObjectProtocol] = []

    init(startURL: URL? = nil, primary: MacShellModel? = nil) {
        self.startURL = startURL
        if let primary {
            self.primary = primary
            loaded = primary.loaded
            store = primary.store
            pools = primary.pools
            shared = primary.shared
            phase = primary.phase
            cover = primary.cover
            needsNewerApp = primary.needsNewerApp
            primary.secondaries.append(WeakModel(self))
            following = [
                primary.$phase.sink { [weak self] in self?.phase = $0 },
                primary.$cover.sink { [weak self] in self?.cover = $0 },
                primary.$lockMessage.sink { [weak self] in self?.lockMessage = $0 },
                primary.$needsNewerApp.sink { [weak self] in self?.needsNewerApp = $0 },
            ]
            return
        }
        shared = MacShared()
        loaded = try? CraniumConfig.load(from: .main)
        let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
                                                     create: true)) ?? FileManager.default.temporaryDirectory
        store = BundleStore(root: support.appendingPathComponent("WebBundle", isDirectory: true),
                            builtIn: Bundle.main.url(forResource: "WebBundle", withExtension: nil))
        if let config = loaded?.config {
            makePools(config)
        }
        Self.main = self
        #if DEBUG
        // A smoke run may have no window to start it (see smokeIfAsked).
        if ProcessInfo.processInfo.environment["CRANIUM_MAC_SMOKE"] != nil { Task { await start() } }
        #endif
    }

    var config: CraniumConfig? { loaded?.config }

    var bundle: LoadedBundle? {
        if case .ready(let bundle) = phase { return bundle }
        return nil
    }

    private func makePools(_ config: CraniumConfig) {
        let interval = MacLockPreferences.load().relock.interval
        let adminSettings = DefaultsBiometricSettings()
        let admin = AuthSession(config: config, http: URLSession.shared, store: KeychainTokenStore(),
                                refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(adminSettings))
        let adminLock = BiometricLock(gate: MacBiometricGate.standard(), settings: adminSettings, session: admin)
        adminLock.relockInterval = interval
        pools[.admin] = ShellAuthPool(pool: .admin, session: admin, lock: adminLock)
        if let customer = config.customer {
            let settings = DefaultsBiometricSettings.customer()
            let session = AuthSession(customer: customer, http: URLSession.shared, store: CustomerStorage.tokenStore(),
                                      refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(settings))
            let lock = BiometricLock(gate: MacBiometricGate.customer(), settings: settings, session: session)
            lock.relockInterval = interval
            pools[.customer] = ShellAuthPool(pool: .customer, session: session, lock: lock)
        }
    }

    // MARK: Starting

    func start() async {
        guard !started else { return }
        started = true
        // A board's window uses the first window's bundle and watches nothing itself.
        if primary != nil { return }
        observeTheMac()
        guard loaded != nil else {
            phase = .failed("This build has no configuration, so the pages cannot start.")
            return
        }
        guard let bundle = await store.launch() else {
            phase = .failed("No copy of the console's pages could be opened on this Mac.")
            return
        }
        phase = .ready(bundle)
        #if DEBUG
        smokeIfAsked()
        #endif
        needsNewerApp = await store.needsNewerApp()
        Task { await checkForUpdate(force: true) }
    }

    /// The page started: its bundle is good.
    func pageReady() async {
        guard primary == nil, let bundle else { return }
        await store.markReady(bundle.id)
    }

    /// Asks the console for a newer bundle; a new one is kept for the next start, and the page is told.
    func checkForUpdate(force: Bool) async {
        if let primary { return await primary.checkForUpdate(force: force) }
        guard let config, !checking else { return }
        if !force, let lastCheck, Date().timeIntervalSince(lastCheck) < Self.checkEvery { return }
        lastCheck = Date()
        checking = true
        defer { checking = false }
        let outcome = await store.update(consoleURL: config.consoleURL, fetcher: URLSessionBundleFetcher(), keeping: bundle)
        needsNewerApp = outcome == .needsNewerApp
        switch outcome {
        case .upToDate:
            updateNote = "The pages are the console's newest."
        case .updated(let manifest):
            updateNote = "Newer pages are ready (\(manifest.consoleVersion.map { "console \($0)" } ?? manifest.id)): they open at the next start, or with Reload."
            broadcast("app.bundleReady", ["id": .string(manifest.id), "console": .string(manifest.consoleVersion)])
        case .needsNewerApp:
            updateNote = "The console's newest pages need a newer version of this app."
        case .refused:
            updateNote = "The console's newest pages did not start on this Mac, so they are not used."
        case .failed(let why):
            updateNote = why
        }
    }

    /// The newest good bundle, at the page the web view is on.
    func reload() async {
        if primary != nil {
            webView?.reload()
            return
        }
        if let newest = await store.newest(), newest.id != bundle?.id {
            phase = .ready(newest)
        }
        webView?.reload()
    }

    #if DEBUG
    /// `CRANIUM_MAC_SMOKE=<file.png>`: a picture of the page a few seconds after it loaded, then quit, as the
    /// desktop app's CRANIUM_DESKTOP_SMOKE does. For comparing the two apps and the docs' screenshots.
    func smokeIfAsked() {
        guard let path = ProcessInfo.processInfo.environment["CRANIUM_MAC_SMOKE"] else { return }
        let wait = UInt64(ProcessInfo.processInfo.environment["CRANIUM_MAC_SMOKE_MS"].flatMap(Double.init) ?? 7000) * 1_000_000
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: wait)
            if self.webView == nil { self.makeOffscreenWindow() }
            guard let webView = self.webView else { NSApplication.shared.terminate(nil); return }
            let configuration = WKSnapshotConfiguration()
            webView.takeSnapshot(with: configuration) { image, _ in
                if let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    // The app is sandboxed: the file goes to its own temporary folder when the path is out of reach.
                    let own = FileManager.default.temporaryDirectory.appendingPathComponent("cranium-smoke.png")
                    do { try png.write(to: URL(fileURLWithPath: path)) } catch { try? png.write(to: own) }
                    print("smoke: done \(webView.url?.absoluteString ?? "") \(own.path)")
                } else {
                    print("smoke: no picture")
                }
                NSApplication.shared.terminate(nil)
            }
        }
    }
    #endif

    private var offscreen: (NSWindow, MacWebView.Coordinator)?

    /// With no screen to show the window on (a Mac asleep, a CI runner), the page in a window that is never shown.
    private func makeOffscreenWindow() {
        let coordinator = MacWebView.Coordinator(model: self)
        let view = MacWebView.make(model: self, coordinator: coordinator)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        window.orderBack(nil)
        offscreen = (window, coordinator)
    }

    func pageMoved(_ url: URL?) { currentURL = url }

    /// The console's pages (not the customer site) are on screen.
    var onConsolePage: Bool {
        guard let url = currentURL, ShellPolicy.isBundle(url) else { return false }
        return url.path == "/admin" || url.path.hasPrefix("/admin/")
    }

    /// The board whose page is on screen (`#/devices/<thing>`), if one is.
    var boardThing: String? {
        onConsolePage ? MacRoutes.thing(inFragment: currentURL?.fragment) : nil
    }

    static func boardURL(_ thing: String) -> URL? { MacRoutes.boardURL(thing) }

    /// A section of the console's pages (`overview`, `devices`, ...) or of the customer site's (`help`).
    /// On the page already it is a change of the hash; otherwise the page is loaded at it.
    func go(to route: String, customer: Bool = false) {
        guard let webView, route.range(of: "^[a-z]{1,20}$", options: .regularExpression) != nil else { return }
        let base = customer ? "\(ShellPolicy.origin)/" : "\(ShellPolicy.origin)/admin"
        let onSide = customer ? (currentURL.map(ShellPolicy.isBundle) ?? false) && !onConsolePage : onConsolePage
        if onSide {
            webView.callAsyncJavaScript("window.location.hash = hash;", arguments: ["hash": "#/\(route)"], in: nil, in: .page, completionHandler: nil)
        } else if let url = URL(string: "\(base)#/\(route)") {
            webView.load(URLRequest(url: url))
        }
    }

    /// Signs out of both sign-ins and shows the pages of every window again, now signed out.
    func signOutEverywhere() async {
        if let primary { return await primary.signOutEverywhere() }
        for pool in pools.values { await pool.signOut() }
        for window in windows { window.webView?.reload() }
    }

    /// An event to the page of every window.
    func broadcast(_ event: String, _ data: [String: JSONValue]) {
        for window in windows { window.host.send(event, data) }
    }

    /// The settings sheet is the first window's.
    func openSettings() {
        (primary ?? self).showSettings = true
    }

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    var canGoBack: Bool { webView?.canGoBack ?? false }

    // MARK: The Mac's events

    private func observeTheMac() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.wentAway() }
        })
        observers.append(center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.cameBack() }
        })
        let sleeping: [(NotificationCenter, Notification.Name)] = [
            (NSWorkspace.shared.notificationCenter, NSWorkspace.willSleepNotification),
            (NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidSleepNotification),
            (DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsLocked")),
        ]
        for (center, name) in sleeping {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.macSlept() }
            })
        }
    }

    private func wentAway() async {
        broadcast("app.lifecycle", ["state": "background"])
        for pool in pools.values { await pool.enteredBackground() }
    }

    private func cameBack() async {
        let force = slept
        slept = false
        let locked = await checkLocks(force: force)
        if locked {
            cover = .lock
            await unlock()
        } else if cover == .privacy {
            cover = nil
        }
        broadcast("app.lifecycle", ["state": "foreground"])
        Task { await checkForUpdate(force: false) }
    }

    /// Whether any pool must ask for Touch ID again; `force` ignores how long the Mac was away.
    private func checkLocks(force: Bool) async -> Bool {
        var locked = false
        for (name, pool) in pools {
            let interval = pool.lock.relockInterval
            if force { pool.lock.relockInterval = 0 }
            let again = await pool.becameActive()
            pool.lock.relockInterval = interval
            guard again else { continue }
            locked = true
            broadcast("auth.locked", ["pool": .string(name.rawValue)])
        }
        return locked
    }

    /// The Mac sleeping or the screen locking: with "lock when the Mac sleeps" on, the saved sign-in goes back
    /// behind Touch ID when the Mac wakes.
    private func macSlept() async {
        guard MacLockPreferences.load().lockWhenMacSleeps else { return }
        slept = true
        for pool in pools.values { await pool.enteredBackground() }
    }

    /// Console > Lock Now.
    func lockNow() async {
        if let primary { return await primary.lockNow() }
        for pool in pools.values { await pool.enteredBackground() }
        if await checkLocks(force: true) { cover = .lock }
    }

    // MARK: Touch ID

    /// The lock screen's Touch ID: each pool that waits for it.
    func unlock() async {
        if let primary { return await primary.unlock() }
        lockMessage = nil
        do {
            for pool in pools.values {
                if await pool.needsUnlock { _ = try await pool.unlockIfNeeded() }
            }
            cover = nil
        } catch let error as BridgeError {
            lockMessage = error.code == .cancelled ? nil : error.message
            if error.code == .locked, !(await anyWaiting()) { cover = nil }
        } catch {
            lockMessage = error.localizedDescription
        }
    }

    private func anyWaiting() async -> Bool {
        for pool in pools.values {
            if await pool.needsUnlock { return true }
        }
        return false
    }

    /// "Sign out" on the lock screen: each pool that waits for Touch ID is signed out, and the page, told by
    /// auth.locked already, asks for a sign-in.
    func signOutLocked() async {
        if let primary { return await primary.signOutLocked() }
        for pool in pools.values {
            if await pool.needsUnlock { await pool.signOut() }
        }
        cover = nil
    }

    func offerBiometric(_ pool: ShellAuthPool.Pool, _ state: ShellAuthPool.BiometricState) {
        if let primary { return primary.offerBiometric(pool, state) }
        guard state.offer, state.available, let kind = state.kind else { return }
        offer = Offer(pool: pool, biometry: kind)
    }

    func answerOffer(_ offer: Offer, yes: Bool) async {
        self.offer = nil
        guard yes, let pool = pools[offer.pool] else { return }
        _ = try? await pool.setBiometric(true)
    }

    // MARK: About

    var shellVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
    var shellBuild: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?" }
}

/// The console's bundle over HTTPS, and nothing else: no cookies, no cache, 15 s.
struct URLSessionBundleFetcher: BundleFetcher {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 60
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    func fetch(_ url: URL, limit: Int) async throws -> Data {
        guard url.scheme == "https" else { throw URLError(.unsupportedURL) }
        var request = URLRequest(url: url)
        request.setValue("application/json, */*", forHTTPHeaderField: "Accept")
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        guard data.count <= limit else { throw URLError(.dataLengthExceedsMaximum) }
        return data
    }
}
