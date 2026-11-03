import CraniumKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Something read from the console: its value, the error of the last try, and when it was read.
struct Loadable<Value> {
    var value: Value?
    var error: Error?
    var loadedAt: Date?
    var loading = false

    /// Read long enough ago that a full refresh reads it again.
    func due(_ full: Bool, every: TimeInterval = Words.idleRefresh) -> Bool {
        full || loadedAt == nil || Date().timeIntervalSince(loadedAt!) > every
    }
}

/// Where a link inside the app leads.
enum Route: Hashable {
    case board(String)
    case deployment(String)
    case release(String)
    case deployments
    case activity
    case tokens
    case history
    case serial
    case account
}

/// The signed-in console: who, the configuration, the API, and what several screens share (the
/// boards, the releases, the deployments). Each screen reads what the website's page of the same
/// name reads (cloud/web/src/site/assets/app.js, `pages`).
@MainActor
final class AppModel: ObservableObject {
    enum Stage: Equatable {
        case loading
        /// The configuration in the app cannot be used. Nothing works until it is rebuilt.
        case broken(String)
        case signedOut
        case signedIn
    }

    @Published private(set) var stage: Stage = .loading
    @Published private(set) var configSource: ConfigSource?
    @Published private(set) var me: Me?
    @Published private(set) var signingIn = false
    @Published var signInMessage: String?
    /// A short message at the foot of the screen: "Copied the token."
    @Published var toast: String?

    @Published var devices = Loadable<DeviceList>()
    @Published var firmware = Loadable<FirmwareList>()
    @Published var deployments = Loadable<[Deployment]>()
    @Published var recent = Loadable<AuditPage>()
    /// Each deployment's own record, where it has been read: who does what is only in there.
    @Published var deploymentDetails: [String: Loadable<Deployment>] = [:]
    @Published var deviceDetails: [String: Loadable<DeviceDetail>] = [:]
    /// The newest page of the activity log, for who cancelled a deployment.
    @Published var audit = Loadable<AuditPage>()

    /// What the phone keeps of firmware, for the account screen.
    @Published private(set) var firmwareOnPhone: CacheSummary = .empty
    /// The release a deployment wizard was opened for, or "" for none chosen; nil when closed.
    @Published var deploying: String?
    /// The boards a deployment wizard was opened for, ticked from the start.
    @Published var deployingThings: Set<String> = []
    /// The release the Bluetooth update was opened for.
    @Published var bluetoothRelease: String?
    @Published var bluetoothOpen = false

    private(set) var api: ConsoleAPI?
    private var auth: AuthSession?
    private var callbackScheme = "cranium"
    /// Application Support/firmware, out of the iCloud backup (docs/mobile-apps.md, "Cache").
    let cache = FirmwareCache.standard()
    private let webSignIn = WebSignIn()
    private var toastTask: Task<Void, Never>?

    var canWrite: Bool { me?.canWrite == true }
    var deviceList: [Device]? { devices.value?.devices }
    var releases: [FirmwareRelease]? { firmware.value?.releases }

    // MARK: Start, sign-in and sign-out

    func start() async {
        guard stage == .loading else { return }
        let loaded: LoadedConfig
        do {
            loaded = try CraniumConfig.load(from: .main)
        } catch {
            stage = .broken(UserMessage.text(for: error))
            return
        }
        configSource = loaded.source
        callbackScheme = loaded.config.callbackScheme
        #if DEBUG
        if Demo.isOn {
            // Made-up data, with no network at all: see DemoData.swift.
            let demo = AuthSession(config: loaded.config, http: DemoHTTP(), store: MemoryTokenStore(Demo.tokens))
            auth = demo
            api = ConsoleAPI(config: loaded.config, http: DemoHTTP(), tokens: demo)
            stage = .signedIn
            await loadMe()
            return
        }
        #endif
        let auth = AuthSession(config: loaded.config, http: URLSession.shared, store: KeychainTokenStore())
        self.auth = auth
        api = ConsoleAPI(config: loaded.config, http: URLSession.shared, tokens: auth)
        if await auth.isSignedIn {
            stage = .signedIn
            await loadMe()
        } else {
            stage = .signedOut
            // A signed-out phone keeps nothing from the console, even after a sign-out cut short.
            await forgetFirmware()
        }
    }

    func signIn() async {
        guard let auth, !signingIn else { return }
        signingIn = true
        signInMessage = nil
        defer { signingIn = false }
        do {
            try await webSignIn(auth)
            stage = .signedIn
            await loadMe()
        } catch AuthError.cancelled {
            // The person closed the sheet: nothing to say.
        } catch {
            signInMessage = UserMessage.text(for: error)
        }
    }

    /// The managed login in the system's web sheet, with `prompt=login`: password and code each time.
    private func webSignIn(_ auth: AuthSession) async throws {
        let pending = await auth.beginSignIn()
        let callback = try await webSignIn.signIn(url: pending.url, callbackScheme: callbackScheme,
                                                  anchor: WebSignIn.currentAnchor())
        try await auth.completeSignIn(callback: callback, pending: pending)
    }

    /// A sign-in again for a change (docs/mobile-apps.md: a change from the phone needs a sign-in
    /// in the last 15 minutes). Throws when it was cancelled, and when another account signed in:
    /// then nothing is changed in that account's name, and the app starts over as that account.
    func signInAgain() async throws {
        guard let auth, let api else { throw AuthError.notSignedIn }
        let before = me?.sub
        try await webSignIn(auth)
        let now = try await api.me()
        if let before, !before.isEmpty, now.sub != before {
            forgetData()
            me = now
            await refreshAfterAccountChange()
            throw FreshSignInError.otherAccount
        }
        me = now
    }

    func signOut(message: String? = nil) async {
        await bluetooth?.leaveBoard()
        await auth?.signOut()
        await forgetFirmware()
        me = nil
        forgetData()
        signInMessage = message
        stage = .signedOut
    }

    private func forgetData() {
        devices = Loadable()
        firmware = Loadable()
        deployments = Loadable()
        recent = Loadable()
        audit = Loadable()
        deploymentDetails = [:]
        deviceDetails = [:]
        deploying = nil
        bluetoothOpen = false
    }

    private func refreshAfterAccountChange() async {
        await refreshOverview(full: true)
    }

    func loadMe() async {
        guard let api else { return }
        do {
            me = try await api.me()
            if me?.canWrite != true { await forgetFirmware() }
        } catch {
            await handle(error)
        }
    }

    // MARK: The Bluetooth update

    /// Made when first needed: making its radio is what has iOS ask for Bluetooth.
    private(set) var bluetooth: BluetoothModel?

    func bluetoothModel() -> BluetoothModel {
        if let bluetooth { return bluetooth }
        let made = BluetoothModel(app: self)
        bluetooth = made
        return made
    }

    func openBluetooth(release: String?) {
        bluetoothRelease = release
        bluetoothOpen = true
    }

    // MARK: Firmware on the phone

    func pruneFirmware(_ list: FirmwareList) async {
        if canWrite {
            firmwareOnPhone = await cache.prune(keepingActiveIn: list.releases)
        } else {
            await forgetFirmware()
        }
    }

    func noteFirmwareOnPhone() async {
        firmwareOnPhone = await cache.summary()
    }

    /// "Clear downloaded firmware": the next update downloads its image again.
    func clearFirmware() async {
        await forgetFirmware()
        say("Downloaded firmware cleared.")
    }

    private func forgetFirmware() async {
        await cache.clear()
        bluetooth?.forgetImages()
        firmwareOnPhone = .empty
    }

    var isSignedIn: Bool {
        get async { await auth?.isSignedIn ?? false }
    }

    // MARK: Reading the console

    /// Reads one shared resource, keeping what was read before when a refresh fails.
    func load<Value>(_ path: ReferenceWritableKeyPath<AppModel, Loadable<Value>>,
                     _ fetch: (ConsoleAPI) async throws -> Value) async {
        guard let api else { return }
        self[keyPath: path].loading = true
        do {
            let value = try await fetch(api)
            self[keyPath: path] = Loadable(value: value, error: nil, loadedAt: Date(), loading: false)
        } catch {
            self[keyPath: path].loading = false
            if !(error is CancellationError) { self[keyPath: path].error = error }
            await handle(error)
        }
    }

    func loadFirmware() async {
        await load(\.firmware) { try await $0.firmware() }
        if let list = firmware.value { await pruneFirmware(list) }
    }

    func loadDeployment(_ id: String) async {
        guard let api else { return }
        var entry = deploymentDetails[id] ?? Loadable()
        entry.loading = true
        deploymentDetails[id] = entry
        do {
            let value = try await api.deployment(id: id)
            deploymentDetails[id] = Loadable(value: value, loadedAt: Date())
        } catch {
            entry.loading = false
            entry.error = error
            deploymentDetails[id] = entry
            await handle(error)
        }
    }

    func loadDevice(_ thing: String) async {
        guard let api else { return }
        var entry = deviceDetails[thing] ?? Loadable()
        entry.loading = true
        deviceDetails[thing] = entry
        do {
            let value = try await api.deviceDetail(thing: thing)
            deviceDetails[thing] = Loadable(value: value, loadedAt: Date())
        } catch {
            entry.loading = false
            entry.error = error
            deviceDetails[thing] = entry
            await handle(error)
        }
    }

    /// The list says how many boards are in each state, not which board is doing what. That comes
    /// from each unfinished deployment's own record.
    func readActiveDeployments() async {
        let now = Date()
        let active = (deployments.value ?? []).filter {
            Words.isUnderWay($0) || Words.stillFinishing($0, devices: deviceList, now: now)
        }
        await withTaskGroup(of: Void.self) { group in
            for deployment in active {
                group.addTask { await self.loadDeployment(deployment.id) }
            }
        }
    }

    // The pages' refreshes, as app.js has them. Each read is a method of its own, so that the key
    // paths are formed on the main actor.

    func loadDevices() async { await load(\.devices) { try await $0.devices() } }
    func loadDeployments() async { await load(\.deployments) { try await $0.deployments() } }
    func loadRecent() async { await load(\.recent) { try await $0.audit(limit: 10) } }
    func loadAudit() async { await load(\.audit) { try await $0.audit(limit: 50) } }

    func refreshOverview(full: Bool) async {
        async let devices: Void = loadDevices()
        async let deployments: Void = loadDeployments()
        async let firmware: Void = self.firmware.due(full) ? loadFirmware() : ()
        async let recent: Void = self.recent.due(full) ? loadRecent() : ()
        _ = await (devices, deployments, firmware, recent)
        await readActiveDeployments()
    }

    func refreshDevices(full: Bool) async {
        async let devices: Void = loadDevices()
        async let deployments: Void = loadDeployments()
        async let firmware: Void = self.firmware.due(full) ? loadFirmware() : ()
        _ = await (devices, deployments, firmware)
        await readActiveDeployments()
    }

    func refreshFirmware(full: Bool) async {
        async let firmware: Void = loadFirmware()
        async let devices: Void = self.devices.due(full) ? loadDevices() : ()
        async let deployments: Void = self.deployments.due(full) ? loadDeployments() : ()
        _ = await (firmware, devices, deployments)
    }

    func refreshDeployments(full: Bool) async {
        async let deployments: Void = loadDeployments()
        async let firmware: Void = self.firmware.due(full) ? loadFirmware() : ()
        _ = await (deployments, firmware)
        // Which waiting board needs its button pressed, and which boards are online.
        if (self.deployments.value ?? []).contains(where: Words.isUnderWay) || self.devices.due(full) {
            await loadDevices()
        }
    }

    func refreshDeployment(_ id: String, full: Bool) async {
        let before = deploymentDetails[id]?.value?.executions.map(\.phase)
        async let detail: Void = loadDeployment(id)
        async let firmware: Void = self.firmware.due(full) ? loadFirmware() : ()
        _ = await (detail, firmware)
        let detailValue = deploymentDetails[id]?.value
        let moved = detailValue?.executions.map(\.phase) != before
        if full || devices.loadedAt == nil || moved || devices.due(false, every: 25) {
            await loadDevices()
        }
        // A board that runs what was cancelled may have got it from another deployment.
        if let detailValue {
            for execution in detailValue.executions where execution.status == "CANCELED" && execution.reported == detailValue.version {
                let known = deviceDetails[execution.thing]
                if full || known?.value?.device.fw?.version != execution.reported || known?.error != nil {
                    await loadDevice(execution.thing)
                }
            }
            // Who cancelled it is in the log and not in the deployment's record.
            if detailValue.status == "CANCELED" && audit.due(full) {
                await loadAudit()
            }
        }
    }

    /// How often the Deployments list is read again.
    var deploymentsInterval: TimeInterval {
        let devices = deviceList ?? []
        return Words.pollInterval((deployments.value ?? []).map { Words.summaryActivity($0, devices: devices) })
    }

    /// How often a page that shows the fleet is read again.
    var fleetInterval: TimeInterval {
        let devices = deviceList ?? []
        var statuses: [String?] = devices.map(Words.deviceActivity)
        statuses += (deployments.value ?? []).map { Words.summaryActivity($0, devices: devices) }
        let interval = Words.pollInterval(statuses)
        return interval > 0 ? interval : Words.idleRefresh
    }

    // MARK: Changes

    /// Who a refusal should be told to.
    func handle(_ error: Error) async {
        switch error {
        case AuthError.sessionExpired, AuthError.notSignedIn:
            if stage == .signedIn { await signOut(message: UserMessage.text(for: AuthError.sessionExpired)) }
        default:
            break
        }
    }

    /// A message at the foot of the screen for a few seconds.
    func say(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
        #if canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: text)
        #endif
    }
}

/// One change from a form or a dialog: busy while it runs, its failure in the console's words,
/// and, when the console asks for a fresh sign-in, the question to the person, then the change
/// once more with what they had entered (docs/mobile-apps.md, "Signing in").
@MainActor
final class ChangeRunner: ObservableObject {
    @Published private(set) var busy = false
    @Published var error: String?
    @Published var errorRef: String?
    /// The error of the last change that did not go through.
    @Published private(set) var lastError: Error?
    /// The console asked for a fresh sign-in, and the person is being asked.
    @Published private(set) var asking = false
    private var answer: CheckedContinuation<Bool, Never>?

    /// Runs `change`. Returns its value, or nil when it did not go through (the reason is in `error`).
    /// `refusal` is what did not happen: "Not revoked.", "No token was made."
    func run<T>(_ app: AppModel, refusal: String, _ change: @escaping (ConsoleAPI) async throws -> T) async -> T? {
        guard let api = app.api, !busy else { return nil }
        busy = true
        error = nil
        errorRef = nil
        lastError = nil
        defer { busy = false }
        do {
            return try await FreshSignIn.run({ try await change(api) }, signInAgain: { [weak self] in
                guard let self, await self.ask() else { return false }
                try await app.signInAgain()
                return true
            })
        } catch AuthError.cancelled {
            lastError = FreshSignInError.declined
            error = FreshSignInError.declined.errorDescription
        } catch {
            lastError = error
            self.error = Words.failure(refusal, error)
            errorRef = Words.problemRef(error)
            await app.handle(error)
        }
        return nil
    }

    private func ask() async -> Bool {
        asking = true
        return await withCheckedContinuation { continuation in
            answer = continuation
        }
    }

    /// The person's answer to "sign in again first".
    func answer(_ yes: Bool) {
        asking = false
        answer?.resume(returning: yes)
        answer = nil
    }

    func reset() {
        if asking { answer(false) }
        error = nil
        errorRef = nil
        lastError = nil
    }
}
