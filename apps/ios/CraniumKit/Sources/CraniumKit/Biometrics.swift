import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The phone's own biometric: Face ID, or Touch ID on an iPhone with a Home button.
public enum Biometry: String, Equatable, Sendable {
    case faceID
    case touchID

    /// "Face ID", "Touch ID": the phone's own name for it, in every word the app says about it.
    public var name: String {
        switch self {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        }
    }

    /// The SF Symbol.
    public var symbol: String {
        switch self {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        }
    }
}

/// Why the biometric did not release the refresh token, or did not take it.
public enum BiometricFailure: Error, Equatable, Sendable {
    /// Cancel, or the system took the prompt away (a call, the app sent to the background).
    case cancelled
    /// The face or finger did not match, after the system's own tries.
    case notRecognised
    /// The prompt's own "Sign in with password".
    case passwordChosen
    /// Too many tries: the phone's passcode first.
    case lockedOut
    /// Not usable for the app now: turned off for it in Settings, none enrolled, no passcode.
    case unavailable
    /// A face or finger was added or removed since it was turned on: the item cannot be opened.
    case changed
    /// The item is not there: the passcode was turned off (iOS deletes it then), or it was deleted.
    case gone
    /// Anything else the Keychain answered.
    case unreadable(Int32)
}

/// Where the refresh token is kept while Face ID is on, and what releases it. `KeychainBiometricGate`
/// is the real one; `MemoryBiometricGate` stands in for it in the tests and in demo mode.
public protocol BiometricGate: Sendable {
    /// The phone's biometric, whether or not it can be used right now; nil on a phone with neither,
    /// and then nothing about it is offered.
    func biometry() -> Biometry?
    /// Whether it can be used now: enrolled, allowed for the app, not locked out.
    func isUsable() -> Bool
    /// Whether a refresh token is kept behind it. Asks nothing.
    func hasRefreshToken() -> Bool
    /// Asks for the biometric, then keeps `refreshToken` behind it in place of any before. Nil when
    /// it is kept.
    func enroll(_ refreshToken: String, reason: String) async -> BiometricFailure?
    /// Keeps `refreshToken` behind it in place of the one before, without asking: the new token of a
    /// sign-in with password and code, while it is on. Nil when it is kept.
    func replace(_ refreshToken: String) -> BiometricFailure?
    /// Asks for the biometric, then hands back the refresh token kept behind it.
    func release(reason: String) async -> Result<String, BiometricFailure>
    /// Deletes what is kept behind it. Asks nothing.
    func forget()
}

/// The refresh token as one generic-password item in the Keychain that only the phone's current
/// faces or fingers open (docs/mobile-apps.md, "Unlocking with Face ID"):
///
/// - `kSecClass` `kSecClassGenericPassword`, `kSecAttrService` "com.craniumiot.cranium.console",
///   `kSecAttrAccount` "refresh-token.biometric"; the access token's item is the same service with
///   the account "tokens" (KeychainTokenStore).
/// - `kSecAttrAccessControl`: `SecAccessControlCreateWithFlags` with
///   `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` and `.biometryCurrentSet`. So: only on this
///   phone, never in a backup or on another device, gone when the passcode is turned off, and no
///   longer readable once a face or finger is added or removed.
/// - `kSecAttrSynchronizable` false: never in iCloud Keychain. `kSecUseDataProtectionKeychain` on iOS.
/// - `kSecValueData`: the refresh token, UTF-8. Nothing else is in it.
///
/// Reading it asks for the biometric first (LAContext, `.deviceOwnerAuthenticationWithBiometrics`),
/// then reads with that context, so that the person sees one prompt and the app gets its reason.
public final class KeychainBiometricGate: BiometricGate, @unchecked Sendable {
    public static let service = "com.craniumiot.cranium.console"
    public static let account = "refresh-token.biometric"
    /// LAContext's `evaluatedPolicyDomainState` when it was turned on, to tell "a face was added" from
    /// other failures. Not a secret: it only changes when the enrolled faces or fingers do.
    static let domainStateKey = "cranium.biometric.domainState"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func biometry() -> Biometry? {
        let context = LAContext()
        // Sets biometryType, also when it fails (none enrolled, locked out).
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        default: return nil
        }
    }

    public func isUsable() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }

    /// The item: the app's own, on this device only, never synchronised.
    static var identity: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        #if os(iOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    /// A new item holding `token`. The accessibility is in the access control: an item may not have
    /// both `kSecAttrAccessible` and `kSecAttrAccessControl`.
    static func newItem(_ token: String) -> [String: Any]? {
        guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                           .biometryCurrentSet, nil) else {
            return nil
        }
        var item = identity
        item[kSecAttrAccessControl as String] = access
        item[kSecValueData as String] = Data(token.utf8)
        return item
    }

    public func hasRefreshToken() -> Bool {
        var query = Self.identity
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        // Never a prompt for this: only whether it is there.
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    public func enroll(_ refreshToken: String, reason: String) async -> BiometricFailure? {
        let context = LAContext()
        context.localizedCancelTitle = BiometricWords.notNow
        do {
            try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch {
            return Self.failure(error)
        }
        if let state = context.evaluatedPolicyDomainState {
            defaults.set(state, forKey: Self.domainStateKey)
        }
        return write(refreshToken)
    }

    public func replace(_ refreshToken: String) -> BiometricFailure? {
        write(refreshToken)
    }

    /// Delete, then add: adding asks nothing, where changing a protected item could.
    private func write(_ token: String) -> BiometricFailure? {
        SecItemDelete(Self.identity as CFDictionary)
        guard let item = Self.newItem(token) else { return .unavailable }
        let status = SecItemAdd(item as CFDictionary, nil)
        return status == errSecSuccess ? nil : Self.failure(status)
    }

    public func release(reason: String) async -> Result<String, BiometricFailure> {
        guard hasRefreshToken() else { return .failure(.gone) }
        let context = LAContext()
        context.localizedFallbackTitle = BiometricWords.password
        do {
            try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch {
            return .failure(Self.failure(error))
        }
        if let kept = defaults.data(forKey: Self.domainStateKey), let state = context.evaluatedPolicyDomainState, kept != state {
            return .failure(.changed)
        }
        var query = Self.identity
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return .failure(Self.failure(status)) }
        guard let data = result as? Data, let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            return .failure(.unreadable(errSecDecode))
        }
        return .success(token)
    }

    public func forget() {
        SecItemDelete(Self.identity as CFDictionary)
        defaults.removeObject(forKey: Self.domainStateKey)
    }

    /// What LocalAuthentication's answer means here.
    static func failure(_ error: Error) -> BiometricFailure {
        let raw = error as NSError
        guard let code = (error as? LAError)?.code ?? (raw.domain == LAErrorDomain ? LAError.Code(rawValue: raw.code) : nil) else {
            return .cancelled
        }
        switch code {
        case .userCancel, .appCancel, .systemCancel, .notInteractive, .invalidContext: return .cancelled
        case .authenticationFailed: return .notRecognised
        case .userFallback: return .passwordChosen
        case .biometryLockout: return .lockedOut
        case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet: return .unavailable
        default: return .cancelled
        }
    }

    /// What the Keychain's answer means here.
    static func failure(_ status: OSStatus) -> BiometricFailure {
        switch status {
        case errSecItemNotFound: return .gone
        // What a `.biometryCurrentSet` item answers once the faces or fingers have changed.
        case errSecAuthFailed: return .changed
        case errSecUserCanceled, errSecInteractionNotAllowed: return .cancelled
        default: return .unreadable(status)
        }
    }
}

/// A gate in memory: for the tests, and for demo mode, where there is no Face ID to ask.
public final class MemoryBiometricGate: BiometricGate, @unchecked Sendable {
    private let lock = NSLock()
    private var kept: String?
    private var _biometry: Biometry?
    private var _usable: Bool
    private var _enrollAnswer: BiometricFailure?
    private var _releaseAnswer: BiometricFailure?
    private var _prompts: [String] = []

    /// `releaseAnswer`, `enrollAnswer`: what the "person" does when asked; nil is a match.
    public init(biometry: Biometry? = .faceID, usable: Bool = true, kept: String? = nil,
                enrollAnswer: BiometricFailure? = nil, releaseAnswer: BiometricFailure? = nil) {
        _biometry = biometry
        _usable = usable
        self.kept = kept
        _enrollAnswer = enrollAnswer
        _releaseAnswer = releaseAnswer
    }

    /// What is kept behind it now, for the tests.
    public var refreshToken: String? { lock.withLock { kept } }
    /// The reasons it was asked with, one per prompt.
    public var prompts: [String] { lock.withLock { _prompts } }
    public var releaseAnswer: BiometricFailure? {
        get { lock.withLock { _releaseAnswer } }
        set { lock.withLock { _releaseAnswer = newValue } }
    }
    public var usable: Bool {
        get { lock.withLock { _usable } }
        set { lock.withLock { _usable = newValue } }
    }
    /// What the system does to the item: deletes it (the passcode turned off).
    public func lose() { lock.withLock { kept = nil } }

    public func biometry() -> Biometry? { lock.withLock { _biometry } }
    public func isUsable() -> Bool { lock.withLock { _biometry != nil && _usable } }
    public func hasRefreshToken() -> Bool { lock.withLock { kept != nil } }

    public func enroll(_ refreshToken: String, reason: String) async -> BiometricFailure? {
        lock.withLock {
            _prompts.append(reason)
            if let answer = _enrollAnswer { return answer }
            kept = refreshToken
            return nil
        }
    }

    public func replace(_ refreshToken: String) -> BiometricFailure? {
        lock.withLock {
            kept = refreshToken
            return nil
        }
    }

    public func release(reason: String) async -> Result<String, BiometricFailure> {
        lock.withLock {
            guard let token = kept else { return .failure(.gone) }
            _prompts.append(reason)
            if let answer = _releaseAnswer { return .failure(answer) }
            return .success(token)
        }
    }

    public func forget() { lock.withLock { kept = nil } }
}

/// Whose sign-in Face ID is on for, and who has been offered it. Per phone and per person: the
/// accounts are kept as SHA-256 of their ID, not the ID itself. No token is ever in here.
public struct BiometricSettings: Codable, Equatable, Sendable {
    /// The account it is on for; nil when it is off. It stays across a sign-out, so that the same
    /// person's next sign-in with password and code goes behind Face ID again.
    public var owner: String?
    /// The accounts it has been offered to after a sign-in.
    public var offered: [String]

    public init(owner: String? = nil, offered: [String] = []) {
        self.owner = owner
        self.offered = offered
    }

    public static func key(for account: String) -> String {
        SHA256.hash(data: Data("cranium-account:\(account)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public protocol BiometricSettingsStore: Sendable {
    func load() -> BiometricSettings
    func save(_ settings: BiometricSettings)
}

/// In UserDefaults, under "cranium.biometric.settings".
public final class DefaultsBiometricSettings: BiometricSettingsStore, @unchecked Sendable {
    static let key = "cranium.biometric.settings"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> BiometricSettings {
        guard let data = defaults.data(forKey: Self.key),
              let settings = try? JSONDecoder().decode(BiometricSettings.self, from: data) else {
            return BiometricSettings()
        }
        return settings
    }

    public func save(_ settings: BiometricSettings) {
        defaults.set(try? JSONEncoder().encode(settings), forKey: Self.key)
    }
}

public final class MemoryBiometricSettings: BiometricSettingsStore, @unchecked Sendable {
    private let lock = NSLock()
    private var settings: BiometricSettings

    public init(_ settings: BiometricSettings = BiometricSettings()) {
        self.settings = settings
    }

    public func load() -> BiometricSettings { lock.withLock { settings } }
    public func save(_ settings: BiometricSettings) { lock.withLock { self.settings = settings } }
}

/// What the app says about Face ID. Every line names the phone's own biometric.
public enum BiometricWords {
    public static let password = "Sign in with password"
    public static let notNow = "Not now"

    public static func offerTitle(_ biometry: Biometry) -> String { "Use \(biometry.name) to open Cranium?" }
    public static func offerText(_ biometry: Biometry) -> String {
        "Cranium then opens with \(biometry.name) for up to 30 days, instead of your password and code. Changes still ask for them."
    }
    public static func offerYes(_ biometry: Biometry) -> String { "Use \(biometry.name)" }
    public static func unlock(_ biometry: Biometry) -> String { "Unlock with \(biometry.name)" }
    public static func locked(_ biometry: Biometry) -> String { "Cranium is locked with \(biometry.name)." }
    /// What the system's prompt says (Touch ID shows it; Face ID shows NSFaceIDUsageDescription the first time).
    public static let unlockReason = "Open Cranium"
    public static func enrollReason(_ biometry: Biometry) -> String { "Turn on \(biometry.name) for Cranium" }
    public static func toggleFooter(_ biometry: Biometry) -> String {
        "Open Cranium with \(biometry.name) for up to 30 days, instead of your password and code. Changes still ask for them."
    }
    public static func cannotUse(_ biometry: Biometry) -> String {
        "Set up \(biometry.name) in Settings, and allow it for Cranium, to turn this on."
    }
    public static func turnedOn(_ biometry: Biometry) -> String { "\(biometry.name) is on." }
    public static func turnedOff(_ biometry: Biometry) -> String { "\(biometry.name) is off." }

    /// One line for what happened when it was asked: on the lock screen, or on the sign-in screen
    /// when the saved sign-in is gone.
    public static func line(_ failure: BiometricFailure, _ biometry: Biometry) -> String? {
        let name = biometry.name
        switch failure {
        case .cancelled, .passwordChosen:
            return nil
        case .notRecognised:
            return "\(name) didn’t recognise you. Try again, or sign in with your password."
        case .lockedOut:
            return "\(name) is locked after too many tries. Unlock the iPhone with its passcode, then try again."
        case .changed:
            return "\(name) changed on this iPhone, so the saved sign-in can’t be opened. Sign in with your password and code."
        case .gone:
            return "The saved sign-in is gone from this iPhone, as happens when its passcode is turned off. Sign in with your password and code."
        case .unavailable:
            return "\(name) isn’t available to Cranium now, so the saved sign-in can’t be opened. Sign in with your password and code."
        case .unreadable:
            return "The saved sign-in couldn’t be read. Sign in with your password and code."
        }
    }

    /// When turning it on did not work.
    public static func enrollFailed(_ failure: BiometricFailure, _ biometry: Biometry) -> String {
        switch failure {
        case .notRecognised: return "\(biometry.name) didn’t recognise you, so it is still off."
        case .lockedOut: return "\(biometry.name) is locked after too many tries. Unlock the iPhone with its passcode, then try again."
        case .unavailable: return cannotUse(biometry)
        default: return "\(biometry.name) couldn’t be turned on. Try again."
        }
    }
}
