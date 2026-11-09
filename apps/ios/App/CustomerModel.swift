import CraniumKit
import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The customer side of the app (docs/mobile-apps.md, "Customers"), as the customer site has it
/// (cloud/web/src/customer/assets/customer.js): a customer's own sign-in, their boards, their
/// account, and the way into admin mode for whoever is signed in as an admin as well.
///
/// The two sessions are kept apart as the site keeps them: a customer's in Keychain items of its own
/// (`CustomerStorage`), with its own Face ID item and setting, renewed through the customer pool; an
/// admin's as before, in AppModel. A customer's token only ever goes to the customer API, an admin's
/// only to the console's.
@MainActor
final class CustomerModel: ObservableObject {
    enum Stage: Equatable {
        case loading
        /// The build has no customer pool in its configuration: admins only.
        case notSetUp
        case signedOut
        /// Face ID is on: nothing until it passes (LockScreen).
        case locked
        case signedIn
    }

    /// What the signed-out side shows: the one sign-in (team pool first, then the customer pool), or a reset.
    enum Gate: Equatable {
        case signIn
        case forgot
    }

    @Published private(set) var stage: Stage = .loading
    @Published var gate: Gate = .signIn
    /// Admin mode is on screen: the console's own screens (AppModel).
    @Published var adminMode = false
    @Published private(set) var cover: AppModel.Cover?
    @Published private(set) var unlocking = false
    @Published private(set) var lockMessage: String?
    @Published var offeringBiometrics = false
    @Published private(set) var biometricOn = false
    @Published private(set) var biometricBusy = false
    /// Why the sign-in screen is shown: a session that ended, a saved sign-in that is gone.
    @Published private(set) var signInLead: String?
    @Published var toast: String?

    @Published var me = Loadable<CustomerMe>()
    @Published var boards = Loadable<[CustomerBoard]>()
    @Published var activity = Loadable<[CustomerEvent]>()
    @Published var details: [String: Loadable<CustomerBoardDetail>] = [:]
    @Published var profile = Loadable<AccountProfile>()

    /// The address last typed, for the sign-in and the reset, as the site keeps `lastEmail`.
    var lastEmail = ""

    private(set) var api: CustomerAPI?
    private(set) var account: CustomerAccount?
    /// The team's pool, for the one "Forgot your password?": asked first, as the sign-in asks it.
    private(set) var teamAccount: CustomerAccount?
    private(set) var passwordSignIn: PasswordSignIn?
    private var auth: AuthSession?
    private(set) var lock: BiometricLock?
    private var toastTask: Task<Void, Never>?
    private var subject: String?

    var biometry: Biometry? { lock?.biometry }
    var biometryUsable: Bool { lock?.gate.isUsable() ?? false }
    var isSignedIn: Bool { stage == .signedIn }

    // MARK: Start

    /// After AppModel's own start: the customer's session, and which side opens. A customer who is
    /// signed in comes first; else an admin who is, in admin mode as before; else the sign-in.
    func start(admin: AppModel) async {
        guard stage == .loading else { return }
        let loaded = (try? CraniumConfig.load(from: .main))?.config
        let customer = loaded?.customer
        if let loaded, let pool = loaded.userPool {
            teamAccount = CustomerAccount(teamPool: pool, clientId: loaded.mobileClientId, http: URLSession.shared)
        }
        #if DEBUG
        // Demo mode is the console's: made-up boards and no network (DemoData.swift).
        if Demo.isOn {
            stage = .notSetUp
            decide(admin)
            return
        }
        #endif
        guard let customer else {
            stage = .notSetUp
            decide(admin)
            return
        }
        let settings = DefaultsBiometricSettings.customer()
        let auth = AuthSession(customer: customer, http: URLSession.shared, store: CustomerStorage.tokenStore(),
                               refreshTokenBehindBiometrics: BiometricLock.refreshTokenBehindBiometrics(settings))
        self.auth = auth
        passwordSignIn = PasswordSignIn(customer: customer, http: URLSession.shared, session: auth)
        api = CustomerAPI(config: customer, http: URLSession.shared, tokens: auth)
        account = CustomerAccount(config: customer, http: URLSession.shared) { await auth.currentAccessToken() }
        let lock = BiometricLock(gate: KeychainBiometricGate.customer(), settings: settings, session: auth)
        self.lock = lock
        switch await lock.launch() {
        case .signedOut:
            stage = .signedOut
        case .open:
            await opened()
        case .locked:
            stage = .locked
        case .signIn(let reason):
            signInLead = reason
            stage = .signedOut
        }
        decide(admin)
    }

    private func decide(_ admin: AppModel) {
        guard stage != .signedIn && stage != .locked else { return }
        if admin.holdsSession { adminMode = true }
    }

    private func opened() async {
        stage = .signedIn
        subject = await auth?.subject
        noteBiometrics()
    }

    // MARK: Signing in and out

    /// The customer's sign-in screen kept the tokens.
    func signedInHere() async {
        signInLead = nil
        gate = .signIn
        await opened()
        guard let lock, let account = subject else { return }
        await lock.afterFullSignIn(account: account)
        if lock.shouldOffer(account: account) {
            lock.markOffered(account: account)
            offeringBiometrics = true
        }
        noteBiometrics()
    }

    /// Admin mode, from the customer side.
    func openAdminMode() {
        adminMode = true
    }

    /// "Leave admin mode": the customer side, the admin still signed in.
    func leaveAdminMode() {
        adminMode = false
    }

    /// The admin's session ended (a sign-out in admin mode, a session that ran out, "Sign in with
    /// password" on its lock screen): back to the customer side, and to the one sign-in.
    func adminEnded(from old: AppModel.Stage, message: String?) {
        let wasShown = adminMode
        adminMode = false
        guard wasShown, stage != .signedIn, stage != .locked else { return }
        gate = .signIn
    }

    /// The customer's sign-out, and the admin's too if one is signed in, as the site's Sign out does.
    func signOutEverything(admin: AppModel) async {
        if admin.holdsSession { await admin.signOut() }
        await signOut()
        gate = .signIn
    }

    func signOut(message: String? = nil) async {
        await auth?.signOut()
        lock?.signedOut()
        cover = nil
        lockMessage = nil
        offeringBiometrics = false
        forgetData()
        subject = nil
        signInLead = message
        if stage != .notSetUp { stage = .signedOut }
    }

    private func forgetData() {
        me = Loadable()
        boards = Loadable()
        activity = Loadable()
        details = [:]
        profile = Loadable()
    }

    /// A refusal that ends the session goes back to the sign-in, saying why.
    func handle(_ error: Error) async {
        switch error {
        case AuthError.sessionExpired, AuthError.notSignedIn:
            if stage == .signedIn { await signOut(message: CustomerWords.sessionEnded) }
        default:
            break
        }
    }

    // MARK: Reading

    private func load<Value>(_ path: ReferenceWritableKeyPath<CustomerModel, Loadable<Value>>,
                             _ fetch: (CustomerAPI) async throws -> Value) async {
        guard let api, stage == .signedIn else { return }
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

    func loadMe() async { await load(\.me) { try await $0.me() } }
    func loadBoards() async { await load(\.boards) { try await $0.boards() } }
    func loadActivity() async { await load(\.activity) { try await $0.activity() } }

    /// The overview: who, the boards, the last week.
    func refreshOverview() async {
        async let me: Void = self.me.value == nil ? loadMe() : ()
        async let boards: Void = loadBoards()
        async let activity: Void = loadActivity()
        _ = await (me, boards, activity)
    }

    func loadBoard(_ id: String) async {
        guard let api, stage == .signedIn else { return }
        var entry = details[id] ?? Loadable()
        entry.loading = true
        details[id] = entry
        do {
            details[id] = Loadable(value: try await api.board(id: id), loadedAt: Date())
        } catch {
            entry.loading = false
            if !(error is CancellationError) { entry.error = error }
            details[id] = entry
            await handle(error)
        }
    }

    func loadProfile() async {
        guard let account, stage == .signedIn else { return }
        profile.loading = true
        switch await account.profile() {
        case .ok(let value):
            profile = Loadable(value: value, loadedAt: Date())
        case .problem(let problem):
            profile.loading = false
            profile.error = CustomerAPIError(status: 0, code: problem.rawValue,
                                             message: problem == .sessionEnded ? CustomerWords.accountSessionEnded : CustomerWords.accountUnreadable)
            if problem == .sessionEnded { await handle(AuthError.sessionExpired) }
        }
    }

    // MARK: Face ID

    func unlock() async {
        guard let lock, !unlocking, stage == .locked || cover == .lock else { return }
        unlocking = true
        lockMessage = nil
        defer { unlocking = false }
        switch await lock.unlock() {
        case .unlocked:
            cover = nil
            if stage == .locked { await opened() }
        case .stay(let message):
            lockMessage = message
        case .password:
            await signInWithPassword()
        case .signIn(let reason):
            await signOut(message: reason)
        }
    }

    /// "Sign in with password" on the lock screen: the sign-in, with nothing behind it. The saved
    /// sign-in stays until a new sign-in replaces it.
    func signInWithPassword() async {
        cover = nil
        lockMessage = nil
        forgetData()
        stage = .signedOut
        gate = .signIn
    }

    func enteredBackground() async {
        guard let lock else { return }
        lock.enteredBackground()
        await auth?.forgetRefreshTokenIfDue()
        if stage == .signedIn, lock.isOn, cover == nil { cover = .privacy }
    }

    func becameInactive() {
        guard let lock, stage == .signedIn, lock.isOn, cover == nil else { return }
        cover = .privacy
    }

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

    func answerBiometricOffer(_ yes: Bool) async {
        offeringBiometrics = false
        if yes { await turnOnBiometrics() }
    }

    func turnOnBiometrics() async {
        guard let lock, let account = subject, let biometry = lock.biometry, !biometricBusy else { return }
        biometricBusy = true
        defer {
            biometricBusy = false
            noteBiometrics()
        }
        switch await lock.turnOn(account: account) {
        case .on: say(BiometricWords.turnedOn(biometry))
        case .needsSignIn: say(CustomerWords.biometricNeedsSignIn(biometry))
        case .notNow: break
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

    private func noteBiometrics() {
        biometricOn = subject.map { lock?.isOn(for: $0) ?? false } ?? false
    }

    // MARK: Messages

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

extension CustomerModel: LockingModel {
    var lockSubtitle: String { CustomerWords.yourStudio }
    var lockHelpTopic: String? { nil }
}

extension AppModel {
    /// An admin is signed in, open or behind Face ID.
    var holdsSession: Bool { stage == .signedIn || stage == .locked }
}
