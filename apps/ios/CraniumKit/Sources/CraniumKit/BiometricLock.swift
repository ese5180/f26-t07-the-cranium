import Foundation

/// How the app opens, and when it asks for Face ID (docs/mobile-apps.md, "Unlocking with Face ID
/// (iPhone) or a fingerprint (Android)"). The app (AppModel) calls this at each step and shows what
/// it says; everything that decides is here, so that the tests can go through every case.
///
/// | Event | Face ID off | Face ID on |
/// | --- | --- | --- |
/// | Launch, signed out | the sign-in screen | the sign-in screen |
/// | Launch, signed in | the console; a refresh token older than 60 minutes is forgotten first | the lock screen: nothing of the console until Face ID passes |
/// | Launch, the item is gone | — | it is forgotten with the session, the setting goes off, and the sign-in screen says why |
/// | Back after under 5 minutes | the console | the console |
/// | Back after 5 minutes or more | the console | the lock screen over everything |
/// | Face ID passes | — | the refresh token goes into memory, and the console opens |
/// | Cancel, or a face that does not match | — | the lock screen stays, with why, and Sign in with password |
/// | Locked out after too many tries | — | the same, saying the passcode comes first |
/// | Sign in with password (on the lock screen or in the prompt) | — | the sign-in screen; the saved sign-in stays until a new one replaces it |
/// | Face ID changed, turned off for the app, the passcode removed | — | as when the item is gone |
/// | A full sign-in with password and code | offered once per person, if the phone has Face ID or Touch ID | the new refresh token goes behind Face ID; another person's sign-in turns it off |
/// | Sign-out | as before | as before, and the item is deleted |
@MainActor
public final class BiometricLock {
    /// Back from the background after this long, the app asks again.
    public static let relockAfter: TimeInterval = 5 * 60

    public enum Launch: Equatable, Sendable {
        /// The sign-in screen.
        case signedOut
        /// The console, without asking.
        case open
        /// The lock screen: ask for Face ID before anything shows.
        case locked
        /// The saved sign-in could not be used, and is forgotten: the sign-in screen, with why.
        case signIn(reason: String)
    }

    public enum Unlock: Equatable, Sendable {
        /// The console opens.
        case unlocked
        /// The lock screen stays, with this line if there is one, Unlock, and Sign in with password.
        case stay(message: String?)
        /// The person chose the password and code.
        case password
        /// The saved sign-in could not be used, and is forgotten: the sign-in screen, with why.
        case signIn(reason: String)
    }

    public enum TurnOn: Equatable, Sendable {
        case on
        /// No refresh token to put behind it (forgotten after its 60 minutes): sign in again first.
        case needsSignIn
        /// The person cancelled the prompt.
        case notNow
        case failed(String)
    }

    public let gate: BiometricGate
    private let settings: BiometricSettingsStore
    private let session: AuthSession
    private let now: () -> Date
    private var backgroundedAt: Date?

    public init(gate: BiometricGate, settings: BiometricSettingsStore, session: AuthSession,
                now: @escaping () -> Date = { Date() }) {
        self.gate = gate
        self.settings = settings
        self.session = session
        self.now = now
    }

    /// Where the session should keep its refresh token when it is made, from the setting.
    public static func refreshTokenBehindBiometrics(_ settings: BiometricSettingsStore) -> Bool {
        settings.load().owner != nil
    }

    /// The phone's biometric; nil when it has neither, and then nothing is offered.
    public var biometry: Biometry? { gate.biometry() }

    /// Whether it is on (for whoever signed in last).
    public var isOn: Bool { settings.load().owner != nil }

    public func isOn(for account: String) -> Bool {
        settings.load().owner == BiometricSettings.key(for: account)
    }

    // MARK: Opening the app

    public func launch() async -> Launch {
        guard await session.isSignedIn else {
            // Nothing to keep behind it while signed out.
            gate.forget()
            return .signedOut
        }
        guard isOn else {
            // An item left from before (the app deleted and put back) is not wanted.
            gate.forget()
            await session.forgetRefreshTokenIfDue()
            return .open
        }
        guard gate.hasRefreshToken() else {
            return .signIn(reason: await forgetSavedSignIn(.gone))
        }
        // A refresh token in the store as well: the app stopped between a sign-in and moving it.
        // The newer one goes behind Face ID.
        if let newer = await session.refreshTokenForBiometrics(), gate.replace(newer) == nil {
            try? await session.keepRefreshTokenBehindBiometrics()
        }
        return .locked
    }

    /// Asks for Face ID, and releases the refresh token into the session.
    public func unlock() async -> Unlock {
        let name = gate.biometry() ?? .faceID
        switch await gate.release(reason: BiometricWords.unlockReason) {
        case .success(let token):
            await session.release(refreshToken: token)
            return .unlocked
        case .failure(let failure):
            switch failure {
            case .cancelled, .notRecognised, .lockedOut:
                return .stay(message: BiometricWords.line(failure, name))
            case .passwordChosen:
                return .password
            case .unavailable, .changed, .gone, .unreadable:
                return .signIn(reason: await forgetSavedSignIn(failure))
            }
        }
    }

    /// The item cannot be read: it is forgotten with the session (whose access token would otherwise
    /// open the app without Face ID for up to an hour), and the setting goes off. The next sign-in
    /// offers it again. Returns the one line that says why.
    private func forgetSavedSignIn(_ failure: BiometricFailure) async -> String {
        let name = gate.biometry() ?? .faceID
        gate.forget()
        var current = settings.load()
        if let owner = current.owner { current.offered.removeAll { $0 == owner } }
        current.owner = nil
        settings.save(current)
        await session.signOut()
        try? await session.keepRefreshTokenWithTokens()
        return BiometricWords.line(failure, name) ?? BiometricWords.line(.gone, name)!
    }

    // MARK: The 5 minutes

    public func enteredBackground() {
        backgroundedAt = now()
    }

    /// Back in the foreground: whether to ask for Face ID before anything shows. Only a time in the
    /// background counts; the prompt itself, Control Centre and a call make the app inactive only.
    public func becameActive() -> Bool {
        defer { backgroundedAt = nil }
        guard isOn, let since = backgroundedAt else { return false }
        return now().timeIntervalSince(since) >= Self.relockAfter
    }

    // MARK: Turning it on and off

    /// After a full sign-in: offered once per person, when the phone has a biometric that works.
    public func shouldOffer(account: String) -> Bool {
        let current = settings.load()
        return current.owner == nil && !current.offered.contains(BiometricSettings.key(for: account)) && gate.isUsable()
    }

    public func markOffered(account: String) {
        var current = settings.load()
        let key = BiometricSettings.key(for: account)
        if !current.offered.contains(key) { current.offered.append(key) }
        settings.save(current)
    }

    /// Asks for Face ID once, then moves the refresh token behind it.
    public func turnOn(account: String) async -> TurnOn {
        guard let name = gate.biometry() else { return .failed("This iPhone has no Face ID or Touch ID.") }
        guard let token = await session.refreshTokenForBiometrics() else { return .needsSignIn }
        if let failure = await gate.enroll(token, reason: BiometricWords.enrollReason(name)) {
            return failure == .cancelled ? .notNow : .failed(BiometricWords.enrollFailed(failure, name))
        }
        do {
            try await session.keepRefreshTokenBehindBiometrics()
        } catch {
            gate.forget()
            return .failed(BiometricWords.enrollFailed(.unreadable(0), name))
        }
        var current = settings.load()
        current.owner = BiometricSettings.key(for: account)
        if !current.offered.contains(current.owner!) { current.offered.append(current.owner!) }
        settings.save(current)
        return .on
    }

    /// The item is deleted, and the refresh token is kept with the tokens for what is left of its 60
    /// minutes.
    public func turnOff() async {
        gate.forget()
        var current = settings.load()
        current.owner = nil
        settings.save(current)
        try? await session.keepRefreshTokenWithTokens()
    }

    /// After a full sign-in with password and code (on the app's own screen, the AWS page, or a
    /// sign-in again): while it is on for this person, the new refresh token goes behind Face ID,
    /// asking nothing; another person's sign-in turns it off.
    public func afterFullSignIn(account: String) async {
        let current = settings.load()
        guard let owner = current.owner else { return }
        if owner == BiometricSettings.key(for: account), let token = await session.refreshTokenForBiometrics(),
           gate.replace(token) == nil {
            try? await session.keepRefreshTokenBehindBiometrics()
            return
        }
        if owner == BiometricSettings.key(for: account), await session.refreshTokenForBiometrics() == nil {
            // Nothing new to keep: what is behind it stays.
            return
        }
        await turnOff()
    }

    /// Sign-out: the item is deleted with the tokens. The setting is kept, so that this person's next
    /// sign-in goes behind Face ID again.
    public func signedOut() {
        gate.forget()
    }
}
