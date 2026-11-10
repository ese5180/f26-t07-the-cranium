import CraniumKit
import SwiftUI
import UIKit
import WebKit

/// The shell (docs/mobile-apps.md, "The app shell"): which bundle the web view is served from, the check for a
/// newer one, the two sign-ins behind the bridge, and the native pieces around the page (its lock screen,
/// the biometric offer, the settings sheet).
@MainActor
final class ShellModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready(LoadedBundle)
    }

    enum Cover: Equatable {
        /// In the app switcher, while a sign-in is behind the biometric.
        case privacy
        /// Back after 5 minutes: the biometric first.
        case lock
    }

    /// The biometric offer after a sign-in on the page.
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
    /// A newer iPhone build on the console than the app that runs (`AppUpdate`), and the sheet with its two ways.
    @Published private(set) var appUpdate: AppUpdate.Release?
    @Published var showAppUpdate = false
    @Published private(set) var appUpdateBusy = false
    @Published private(set) var appUpdateMessage: String?
    /// SideStore did not open: the sheet says how to get it.
    @Published private(set) var sideStoreMissing = false

    let loaded: LoadedConfig?
    let store: BundleStore
    private(set) var pools: [ShellAuthPool.Pool: ShellAuthPool] = [:]
    lazy var host = ShellBridgeHost(model: self)
    weak var webView: WKWebView?

    /// The console is asked for a newer bundle at most this often when the app comes back.
    static let checkEvery: TimeInterval = 10 * 60
    private var lastCheck: Date?
    private var started = false

    init() {
        loaded = try? CraniumConfig.load(from: .main)
        let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
                                                     create: true)) ?? FileManager.default.temporaryDirectory
        store = BundleStore(root: support.appendingPathComponent("WebBundle", isDirectory: true),
                            builtIn: Bundle.main.url(forResource: "WebBundle", withExtension: nil))
        if let config = loaded?.config {
            makePools(config)
        }
    }

    var config: CraniumConfig? { loaded?.config }

    var bundle: LoadedBundle? {
        if case .ready(let bundle) = phase { return bundle }
        return nil
    }

    private func makePools(_ config: CraniumConfig) {
        let adminSettings = DefaultsBiometricSettings()
        let admin = AuthSession(config: config, http: URLSession.shared, store: KeychainTokenStore(),
                                refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(adminSettings))
        pools[.admin] = ShellAuthPool(pool: .admin, session: admin,
                                      lock: BiometricLock(gate: KeychainBiometricGate(), settings: adminSettings, session: admin))
        if let customer = config.customer {
            let settings = DefaultsBiometricSettings.customer()
            let session = AuthSession(customer: customer, http: URLSession.shared, store: CustomerStorage.tokenStore(),
                                      refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(settings))
            pools[.customer] = ShellAuthPool(pool: .customer, session: session,
                                             lock: BiometricLock(gate: KeychainBiometricGate.customer(), settings: settings, session: session))
        }
    }

    // MARK: Starting

    func start() async {
        guard !started else { return }
        started = true
        guard loaded != nil else {
            ShellChoice.shared.fallBack("This build has no configuration, so the new app cannot start.")
            return
        }
        guard let bundle = await store.launch() else {
            ShellChoice.shared.fallBack("No copy of the console's pages could be opened on this iPhone.")
            return
        }
        phase = .ready(bundle)
        needsNewerApp = await store.needsNewerApp()
        Task { await checkForUpdate(force: true) }
    }

    /// The page started: its bundle is good.
    func pageReady() async {
        guard let bundle else { return }
        await store.markReady(bundle.id)
        // The page has asked for its sign-in by now, so the check of the app's own version can use it.
        Task { await checkForAppUpdate() }
    }

    /// Asks the console for a newer bundle; a new one is kept for the next start, and the page is told.
    func checkForUpdate(force: Bool) async {
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
            host.send("app.bundleReady", ["id": .string(manifest.id), "console": .string(manifest.consoleVersion)])
        case .needsNewerApp:
            updateNote = "The console's newest pages need a newer version of this app. Update it with SideStore."
        case .refused:
            updateNote = "The console's newest pages did not start on this iPhone, so they are not used."
        case .failed(let why):
            updateNote = why
        }
        await checkForAppUpdate()
    }

    // MARK: The app's own update

    /// Asks the console's `GET /api/apps` whether it has a newer iPhone build than this one. Only with a console
    /// sign-in that is open already: the check never asks for Face ID, and a customer's sign-in has no Apps page.
    func checkForAppUpdate() async {
        guard let config, let pool = pools[.admin], pool.isUnlocked,
              let access = try? await pool.access() else { return }
        guard let data = try? await Self.consoleGET(AppUpdate.appsURL(console: config.consoleURL), token: access.token)
        else { return }
        appUpdate = AppUpdate.offer(fromApps: data, runningVersion: shellVersion, build: shellBuild)
    }

    /// Install with SideStore: a fresh download link from the console, handed to SideStore as
    /// `sidestore://install?url=<link>`. When nothing opens it, SideStore is not on this iPhone.
    func installWithSideStore() async {
        guard let config, let release = appUpdate, !appUpdateBusy else { return }
        appUpdateBusy = true
        appUpdateMessage = nil
        sideStoreMissing = false
        defer { appUpdateBusy = false }
        do {
            guard let pool = pools[.admin], let access = try await pool.access() else {
                appUpdateMessage = "Sign in to the console in the app first: the download link is for members."
                return
            }
            guard let address = AppUpdate.downloadURL(console: config.consoleURL, version: release.version) else { return }
            let data = try await Self.consoleGET(address, token: access.token)
            guard let ipa = AppUpdate.link(fromDownload: data, for: release, console: config.consoleURL),
                  let install = AppUpdate.installLink(ipa: ipa),
                  ShellPolicy.mayOpenOutside(install, console: config.consoleURL) else {
                appUpdateMessage = "The console's answer was not a link to Cranium \(release.version), so nothing was opened."
                return
            }
            if await UIApplication.shared.open(install) {
                appUpdateMessage = "SideStore is installing Cranium \(release.version). This app closes when it is done; open it again."
            } else {
                sideStoreMissing = true
            }
        } catch let error as BridgeError {
            appUpdateMessage = error.message
        } catch {
            appUpdateMessage = "The console could not be reached: \(error.localizedDescription)"
        }
    }

    /// The console's Apps page, in Safari.
    func openAppsPage() {
        guard let config else { return }
        UIApplication.shared.open(AppUpdate.appsPage(console: config.consoleURL))
    }

    /// A GET of the console with the console's token, and nothing else: ephemeral, no cookies, no cache, 15 s.
    private static func consoleGET(_ url: URL, token: String) async throws -> Data {
        guard url.scheme == "https" else { throw URLError(.unsupportedURL) }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSessionBundleFetcher.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        guard data.count <= 1 << 20 else { throw URLError(.dataLengthExceedsMaximum) }
        return data
    }

    /// The newest good bundle, at the page the web view is on.
    func reload() async {
        if let newest = await store.newest(), newest.id != bundle?.id {
            phase = .ready(newest)
        }
        webView?.reload()
    }

    // MARK: The scene

    func scene(_ phase: ScenePhase) async {
        switch phase {
        case .background:
            host.send("app.lifecycle", ["state": "background"])
            host.leaveBackgroundState()
            for pool in pools.values { await pool.enteredBackground() }
            if await anyBiometric() { cover = cover ?? .privacy }
        case .inactive:
            if cover == nil, await anyBiometric() { cover = .privacy }
        case .active:
            var locked = false
            for (name, pool) in pools {
                guard await pool.becameActive() else { continue }
                locked = true
                host.send("auth.locked", ["pool": .string(name.rawValue)])
            }
            if locked {
                cover = .lock
                await unlock()
            } else if cover == .privacy {
                cover = nil
            }
            host.send("app.lifecycle", ["state": "foreground"])
            Task { await checkForUpdate(force: false) }
        @unknown default:
            break
        }
    }

    private func anyBiometric() async -> Bool {
        for pool in pools.values {
            if await pool.biometricState().enabled { return true }
        }
        return false
    }

    /// The lock screen's Face ID: each pool that waits for it.
    func unlock() async {
        lockMessage = nil
        do {
            for pool in pools.values {
                if await pool.needsUnlock { _ = try await pool.unlockIfNeeded() }
            }
            cover = nil
        } catch let error as BridgeError {
            lockMessage = error.code == .cancelled ? nil : error.message
            // The saved sign-in is gone: nothing to unlock any more.
            if error.code == .locked {
                let waiting = await anyWaiting()
                if !waiting { cover = nil }
            }
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

    /// "Sign out" on the lock screen: each pool that waits for the biometric is signed out, and the page,
    /// told by auth.locked already, asks for a sign-in.
    func signOutLocked() async {
        for pool in pools.values {
            if await pool.needsUnlock { await pool.signOut() }
        }
        cover = nil
    }

    // MARK: The biometric offer

    func offerBiometric(_ pool: ShellAuthPool.Pool, _ state: ShellAuthPool.BiometricState) {
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
