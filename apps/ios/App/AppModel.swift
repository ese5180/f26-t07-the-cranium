import CraniumKit
import Foundation
import SwiftUI
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
    /// Help: every topic, or one.
    case help(String?)
    /// A board's sub-screens.
    case boardHistory(String)
    case boardBoots(String)
    case boardCharts(String)
    case boardSlots(String)
    case boardCertificates(String)
    /// A release's digests and sizes.
    case releaseDetails(String)
    /// One board's part in a deployment: the deployment's id and the board.
    case execution(String, String)
    case token(String)
    case upload
    case signingKey
    /// The tabs' own screens, for a link from Search.
    case overview
    case boardsList
    case firmwareList
    case eventsList
    /// Events narrowed to one board, with its board log: a board page's "All lines", and Search.
    case boardLog(String)
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
        /// Face ID is on: nothing of the console until it passes (LockScreen).
        case locked
        case signedIn
    }

    /// What covers the console while it runs (in its own window, over every sheet): the mark while the
    /// app is in the app switcher, and the lock screen when it is back after 5 minutes or more.
    enum Cover: Equatable {
        case privacy
        case lock
    }

    @Published private(set) var stage: Stage = .loading
    @Published private(set) var cover: Cover?
    /// Face ID is being asked.
    @Published private(set) var unlocking = false
    /// One line on the lock screen: why it did not open.
    @Published private(set) var lockMessage: String?
    /// After a full sign-in: "Use Face ID to open Cranium?" (BiometricOfferSheet).
    @Published var offeringBiometrics = false
    /// Face ID is on for the person signed in (the Account screen's switch).
    @Published private(set) var biometricOn = false
    /// It is being turned on or off.
    @Published private(set) var biometricBusy = false
    /// Turning it on needs a sign-in with password and code first: the sheet for it is open.
    @Published private(set) var biometricSignInOpen = false
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
    /// The app's own sign-in (SignInScreen): the e-mail address, the password, then the code in six
    /// boxes. Nil when the configuration names no user pool: then the AWS sign-in page is the only way.
    private(set) var passwordSignIn: PasswordSignIn?
    private var callbackScheme = "cranium"
    /// Application Support/firmware, out of the iCloud backup (docs/mobile-apps.md, "Cache").
    let cache = FirmwareCache.standard()
    private let webSignIn = WebSignIn()
    private var toastTask: Task<Void, Never>?
    /// When to ask for Face ID, and the item behind it (BiometricLock, in CraniumKit).
    private(set) var lock: BiometricLock?
    private var biometricSignInEnd: CheckedContinuation<SignInEnding, Never>?

    /// The phone's Face ID or Touch ID; nil with neither, and then nothing about it is shown.
    var biometry: Biometry? { lock?.biometry }
    /// Whether it can be used now (enrolled, allowed for the app, not locked out).
    var biometryUsable: Bool { lock?.gate.isUsable() ?? false }

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
            let signedOut = UserDefaults.standard.bool(forKey: "CraniumSignedOut")
            let settings = Demo.biometricSettings
            let demo = AuthSession(config: loaded.config, http: DemoHTTP(),
                                   store: MemoryTokenStore(signedOut ? nil : Demo.sessionTokens),
                                   refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(settings))
            auth = demo
            passwordSignIn = PasswordSignIn(config: loaded.config, http: DemoCognito(), session: demo)
            api = ConsoleAPI(config: loaded.config, http: DemoHTTP(), tokens: demo)
            let lock = BiometricLock(gate: Demo.biometricGate, settings: settings, session: demo)
            self.lock = lock
            await open(await lock.launch())
            if Demo.biometric == "offer", lock.biometry != nil, stage == .signedIn {
                offeringBiometrics = true
            }
            if UserDefaults.standard.string(forKey: "CraniumBiometricCheck") != nil {
                Task { await Demo.checkBiometricGate() }
            }
            return
        }
        #endif
        let settings = DefaultsBiometricSettings()
        let auth = AuthSession(config: loaded.config, http: URLSession.shared, store: KeychainTokenStore(),
                               refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(settings))
        self.auth = auth
        passwordSignIn = PasswordSignIn(config: loaded.config, http: URLSession.shared, session: auth)
        api = ConsoleAPI(config: loaded.config, http: URLSession.shared, tokens: auth)
        let lock = BiometricLock(gate: KeychainBiometricGate(), settings: settings, session: auth)
        self.lock = lock
        await open(await lock.launch())
    }

    /// Where the app opens: the sign-in screen, the console, or the lock screen.
    private func open(_ launch: BiometricLock.Launch) async {
        switch launch {
        case .signedOut:
            stage = .signedOut
            // A signed-out phone keeps nothing from the console, even after a sign-out cut short.
            await forgetFirmware()
        case .open:
            stage = .signedIn
            await loadMe()
        case .locked:
            // LockScreen asks for Face ID as soon as it shows.
            stage = .locked
        case .signIn(let reason):
            signInMessage = reason
            stage = .signedOut
            await forgetFirmware()
        }
    }

    // MARK: Face ID

    /// Asks for Face ID: on the lock screen as it shows, and from its button.
    func unlock() async {
        guard let lock, !unlocking, stage == .locked || cover == .lock else { return }
        unlocking = true
        lockMessage = nil
        defer { unlocking = false }
        switch await lock.unlock() {
        case .unlocked:
            #if DEBUG
            if Demo.isOn, Demo.biometric == "relock" { (lock.gate as? MemoryBiometricGate)?.releaseAnswer = .cancelled }
            #endif
            cover = nil
            if stage == .locked {
                stage = .signedIn
                await loadMe()
            }
        case .stay(let message):
            lockMessage = message
        case .password:
            await signInWithPassword()
        case .signIn(let reason):
            // The saved sign-in is forgotten (BiometricLock): the rest of the session goes too.
            await signOut(message: reason)
        }
    }

    /// "Sign in with password" on the lock screen: the sign-in screen, with nothing of the console
    /// behind it. The saved sign-in stays until a new sign-in replaces it.
    func signInWithPassword() async {
        await bluetooth?.leaveBoard()
        cover = nil
        lockMessage = nil
        me = nil
        forgetData()
        stage = .signedOut
    }

    /// The app went to the background: the 5 minutes start, and the console is covered for the app
    /// switcher.
    func enteredBackground() async {
        guard let lock else { return }
        lock.enteredBackground()
        await auth?.forgetRefreshTokenIfDue()
        if stage == .signedIn, lock.isOn, cover == nil { cover = .privacy }
    }

    /// Control Centre, a call, the app switcher, Face ID's own prompt: covered, not locked.
    func becameInactive() {
        guard let lock, stage == .signedIn, lock.isOn, cover == nil else { return }
        cover = .privacy
    }

    /// Back: after 5 minutes or more the lock screen asks for Face ID before anything shows.
    func becameActive() async {
        guard let lock else { return }
        await auth?.forgetRefreshTokenIfDue()
        let ask = lock.becameActive()
        guard stage == .signedIn else {
            cover = nil
            return
        }
        if ask {
            cover = .lock
        } else if cover == .privacy {
            cover = nil
        }
    }

    /// After a full sign-in with password and code: a new refresh token goes behind Face ID while it
    /// is on for this person, and it is offered, once, to someone it is not on for.
    private func afterFullSignIn(offer: Bool) async {
        guard let lock, let account = me?.sub, !account.isEmpty else { return }
        await lock.afterFullSignIn(account: account)
        if offer, lock.shouldOffer(account: account) {
            lock.markOffered(account: account)
            offeringBiometrics = true
        }
        noteBiometrics()
    }

    /// The offer's answer.
    func answerBiometricOffer(_ yes: Bool) async {
        offeringBiometrics = false
        if yes { await turnOnBiometrics() }
    }

    /// From the offer, or the Account screen's switch. Asks for Face ID once; without a refresh token
    /// left to protect (after its 60 minutes), asks for the password and code first.
    func turnOnBiometrics() async {
        guard let lock, let account = me?.sub, let biometry = lock.biometry, !biometricBusy else { return }
        biometricBusy = true
        defer {
            biometricBusy = false
            noteBiometrics()
        }
        var outcome = await lock.turnOn(account: account)
        if outcome == .needsSignIn {
            do {
                try await signInAgain(asking: passwordSignIn == nil ? nil : { await self.askBiometricSignIn() })
            } catch AuthError.cancelled {
                return
            } catch {
                say(UserMessage.text(for: error))
                return
            }
            outcome = await lock.turnOn(account: me?.sub ?? account)
        }
        switch outcome {
        case .on: say(BiometricWords.turnedOn(biometry))
        case .notNow, .needsSignIn: break
        case .failed(let text): say(text)
        }
    }

    func turnOffBiometrics() async {
        guard let lock, let biometry = lock.biometry, !biometricBusy else { return }
        biometricBusy = true
        await lock.turnOff()
        biometricBusy = false
        noteBiometrics()
        say(BiometricWords.turnedOff(biometry))
    }

    /// The sign-in again that turning it on needs (AccountView shows it).
    private func askBiometricSignIn() async -> SignInEnding {
        biometricSignInOpen = true
        return await withCheckedContinuation { continuation in
            biometricSignInEnd = continuation
        }
    }

    func endBiometricSignIn(_ ending: SignInEnding) {
        guard biometricSignInOpen else { return }
        biometricSignInOpen = false
        biometricSignInEnd?.resume(returning: ending)
        biometricSignInEnd = nil
    }

    private func noteBiometrics() {
        biometricOn = me.map { lock?.isOn(for: $0.sub) ?? false } ?? false
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
            await afterFullSignIn(offer: true)
        } catch AuthError.cancelled {
            // The person closed the sheet: nothing to say.
        } catch {
            signInMessage = UserMessage.text(for: error)
        }
    }

    /// The app's own sign-in screen kept the tokens: open the console.
    func signedInHere() async {
        signInMessage = nil
        stage = .signedIn
        await loadMe()
        await afterFullSignIn(offer: true)
    }

    /// The managed login in the system's web sheet, with `prompt=login`: password and code each time.
    private func webSignIn(_ auth: AuthSession) async throws {
        let pending = try await auth.beginSignIn()
        let callback = try await webSignIn.signIn(url: pending.url, callbackScheme: callbackScheme,
                                                  anchor: WebSignIn.currentAnchor())
        try await auth.completeSignIn(callback: callback, pending: pending)
    }

    /// A sign-in again for a change (docs/mobile-apps.md: a change from the phone needs a sign-in
    /// in the last 15 minutes). Throws when it was cancelled, and when another account signed in:
    /// then nothing is changed in that account's name, and the app starts over as that account.
    ///
    /// `ask` shows the app's own sign-in (password and code) and says how it ended. Without it, or
    /// when it ends with "Use the AWS sign-in page", the AWS sign-in page signs in.
    func signInAgain(asking ask: (() async -> SignInEnding)? = nil) async throws {
        guard let auth, let api else { throw AuthError.notSignedIn }
        let before = me?.sub
        switch await ask?() ?? .awsPage(reason: nil) {
        case .signedIn:
            break
        case .cancelled:
            throw AuthError.cancelled
        case .awsPage:
            // Let the sign-in sheet go first: the web sheet opens over the window.
            if ask != nil { try? await Task.sleep(nanoseconds: 600_000_000) }
            try await webSignIn(auth)
        }
        let now = try await api.me()
        // A full sign-in: its refresh token goes behind Face ID if that is on for this person.
        await lock?.afterFullSignIn(account: now.sub)
        if let before, !before.isEmpty, now.sub != before {
            forgetData()
            me = now
            await refreshAfterAccountChange()
            noteBiometrics()
            throw FreshSignInError.otherAccount
        }
        me = now
        noteBiometrics()
    }

    func signOut(message: String? = nil) async {
        await bluetooth?.leaveBoard()
        await auth?.signOut()
        // The item behind Face ID goes with the tokens.
        lock?.signedOut()
        cover = nil
        lockMessage = nil
        offeringBiometrics = false
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
            noteBiometrics()
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
    /// The app's own sign-in is open in a sheet (FreshSignInPrompt), and the change waits for it.
    @Published private(set) var signingIn = false
    /// What that sheet signs in with, and whose address it is.
    private(set) var signInFlow: PasswordSignIn?
    private(set) var signInEmail: String?
    private var signInEnd: CheckedContinuation<SignInEnding, Never>?

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
                try await app.signInAgain(asking: app.passwordSignIn == nil ? nil : { await self.signInHere(app) })
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

    /// Opens the sign-in sheet and waits for how it ends.
    private func signInHere(_ app: AppModel) async -> SignInEnding {
        signInFlow = app.passwordSignIn
        signInEmail = app.me?.email
        signingIn = true
        return await withCheckedContinuation { continuation in
            signInEnd = continuation
        }
    }

    /// How the sign-in sheet ended: signed in, closed, or "Use the AWS sign-in page".
    func endSignIn(_ ending: SignInEnding) {
        guard signingIn else { return }
        signingIn = false
        signInEnd?.resume(returning: ending)
        signInEnd = nil
    }

    /// The person's answer to "sign in again first".
    func answer(_ yes: Bool) {
        asking = false
        answer?.resume(returning: yes)
        answer = nil
    }

    func reset() {
        if asking { answer(false) }
        if signingIn { endSignIn(.cancelled) }
        error = nil
        errorRef = nil
        lastError = nil
    }
}
