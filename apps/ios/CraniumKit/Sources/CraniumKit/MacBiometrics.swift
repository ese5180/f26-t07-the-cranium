#if os(macOS)
import Foundation
import LocalAuthentication
import Security

/// What asks for Touch ID: LAContext on a Mac, a stand-in in the tests.
public protocol BiometricAsking: Sendable {
    /// The Mac's Touch ID, whether or not it can be used right now; nil on a Mac without it.
    func biometry() -> Biometry?
    /// Whether it can be used now: a finger enrolled, not locked out.
    func isUsable() -> Bool
    /// Asks. `fallbackTitle` is the prompt's own button for the password, nil for none.
    func ask(reason: String, cancelTitle: String?, fallbackTitle: String?) async -> Result<BiometricPass, BiometricFailure>
}

/// A Touch ID that passed: the context to read the Keychain item with, and the enrolled fingers' state.
public struct BiometricPass: @unchecked Sendable {
    public let context: LAContext?
    public let domainState: Data?

    public init(context: LAContext?, domainState: Data?) {
        self.context = context
        self.domainState = domainState
    }
}

/// Who holds Touch ID to the saved sign-in (docs/mac-app.md, "Touch ID").
public enum SecretGuard: String, Equatable, Sendable {
    /// The Keychain item itself opens only for the Mac's current fingers (the data protection
    /// keychain, which needs an app signed with a team).
    case keychain
    /// The app asks for Touch ID before it reads an ordinary Keychain item: a build signed to run
    /// locally, or unsigned, cannot use the data protection keychain.
    case app
}

/// Where the refresh token is kept while Touch ID is on.
public protocol SecretKeeping: Sendable {
    var guarded: SecretGuard { get }
    func has() -> Bool
    func write(_ secret: String) -> BiometricFailure?
    func read(with pass: BiometricPass) -> Result<String, BiometricFailure>
    func delete()
}

/// The Mac's gate: the iPhone's `KeychainBiometricGate`, with Touch ID asked through `BiometricAsking`
/// and the token in a `SecretKeeping`. The same rules (BiometricLock decides when), the same words.
public final class MacBiometricGate: BiometricGate, @unchecked Sendable {
    private let asking: BiometricAsking
    public let keeper: SecretKeeping
    private let defaults: UserDefaults
    private let stateKey: String

    public init(asking: BiometricAsking, keeper: SecretKeeping, defaults: UserDefaults = .standard,
                domainStateKey: String = "cranium.mac.biometric.domainState") {
        self.asking = asking
        self.keeper = keeper
        self.defaults = defaults
        stateKey = domainStateKey
    }

    /// The console's gate on this Mac: Touch ID, and the best Keychain this build may use.
    public static func standard(defaults: UserDefaults = .standard) -> MacBiometricGate {
        MacBiometricGate(asking: SystemBiometricAsking(),
                         keeper: KeychainSecret.best(service: KeychainBiometricGate.service, account: KeychainBiometricGate.account),
                         defaults: defaults)
    }

    /// A customer's: its own item and its own state, never the admin's.
    public static func customer(defaults: UserDefaults = .standard) -> MacBiometricGate {
        MacBiometricGate(asking: SystemBiometricAsking(),
                         keeper: KeychainSecret.best(service: KeychainBiometricGate.customerService,
                                                     account: KeychainBiometricGate.account),
                         defaults: defaults, domainStateKey: "cranium.mac.customer.biometric.domainState")
    }

    public var guarded: SecretGuard { keeper.guarded }

    public func biometry() -> Biometry? { asking.biometry() }

    public func isUsable() -> Bool { asking.isUsable() }

    public func hasRefreshToken() -> Bool { keeper.has() }

    public func enroll(_ refreshToken: String, reason: String) async -> BiometricFailure? {
        switch await asking.ask(reason: reason, cancelTitle: BiometricWords.notNow, fallbackTitle: nil) {
        case .failure(let failure):
            return failure
        case .success(let pass):
            if let state = pass.domainState { defaults.set(state, forKey: stateKey) }
            return keeper.write(refreshToken)
        }
    }

    public func replace(_ refreshToken: String) -> BiometricFailure? {
        keeper.write(refreshToken)
    }

    public func release(reason: String) async -> Result<String, BiometricFailure> {
        guard keeper.has() else { return .failure(.gone) }
        switch await asking.ask(reason: reason, cancelTitle: nil, fallbackTitle: BiometricWords.password) {
        case .failure(let failure):
            return .failure(failure)
        case .success(let pass):
            // A finger added or removed since it was turned on: the item is not opened, as on the iPhone,
            // where the Keychain itself refuses. Here the app refuses too, whoever guards the item.
            if let kept = defaults.data(forKey: stateKey), let state = pass.domainState, kept != state {
                return .failure(.changed)
            }
            return keeper.read(with: pass)
        }
    }

    public func forget() {
        keeper.delete()
        defaults.removeObject(forKey: stateKey)
    }
}

/// LAContext, asked for Touch ID only (`.deviceOwnerAuthenticationWithBiometrics`), as the iPhone asks
/// for Face ID: the Mac's password is the prompt's fallback, which ends in the app's own sign-in.
public final class SystemBiometricAsking: BiometricAsking, @unchecked Sendable {
    public init() {}

    public func biometry() -> Biometry? {
        let context = LAContext()
        // Sets biometryType, also when it fails (no finger enrolled, locked out).
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return context.biometryType == .touchID ? .touchID : nil
    }

    public func isUsable() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }

    public func ask(reason: String, cancelTitle: String?, fallbackTitle: String?) async -> Result<BiometricPass, BiometricFailure> {
        let context = LAContext()
        if let cancelTitle { context.localizedCancelTitle = cancelTitle }
        // An empty title hides the button; nil keeps the system's own.
        context.localizedFallbackTitle = fallbackTitle ?? ""
        do {
            try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch {
            return .failure(KeychainBiometricGate.failure(error))
        }
        return .success(BiometricPass(context: context, domainState: context.evaluatedPolicyDomainState))
    }
}

/// One generic-password item in the Keychain, never synchronised, only on this Mac.
public final class KeychainSecret: SecretKeeping, @unchecked Sendable {
    public let guarded: SecretGuard
    private let service: String
    private let account: String

    public init(service: String, account: String, guarded: SecretGuard) {
        self.service = service
        self.account = account
        self.guarded = guarded
    }

    /// The data protection keychain with `.biometryCurrentSet` where this build may use it (signed with
    /// a team); else an ordinary item, which the app opens only after Touch ID.
    public static func best(service: String, account: String) -> KeychainSecret {
        KeychainSecret(service: service, account: account, guarded: dataProtectionAvailable() ? .keychain : .app)
    }

    /// Whether this build may use the data protection keychain: an app without a team's
    /// application identifier gets errSecMissingEntitlement. Writes and deletes one empty probe item.
    public static func dataProtectionAvailable() -> Bool {
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.craniumiot.cranium.probe",
            kSecAttrAccount as String: "data-protection",
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        var item = probe
        item[kSecValueData as String] = Data()
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        return status == errSecSuccess || status == errSecDuplicateItem
    }

    private func identity() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if guarded == .keychain { query[kSecUseDataProtectionKeychain as String] = true }
        return query
    }

    public func has() -> Bool {
        var query = identity()
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        // Never a prompt for this: only whether it is there.
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    /// Delete, then add: adding asks nothing, where changing a protected item could.
    public func write(_ secret: String) -> BiometricFailure? {
        SecItemDelete(identity() as CFDictionary)
        var item = identity()
        item[kSecValueData as String] = Data(secret.utf8)
        switch guarded {
        case .keychain:
            guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                               .biometryCurrentSet, nil) else { return .unavailable }
            item[kSecAttrAccessControl as String] = access
        case .app:
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        let status = SecItemAdd(item as CFDictionary, nil)
        return status == errSecSuccess ? nil : KeychainBiometricGate.failure(status)
    }

    public func read(with pass: BiometricPass) -> Result<String, BiometricFailure> {
        var query = identity()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if guarded == .keychain, let context = pass.context { query[kSecUseAuthenticationContext as String] = context }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return .failure(KeychainBiometricGate.failure(status)) }
        guard let data = result as? Data, let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            return .failure(.unreadable(errSecDecode))
        }
        return .success(token)
    }

    public func delete() {
        SecItemDelete(identity() as CFDictionary)
    }
}

/// A secret in memory, for the tests: what a keeper would hold.
public final class MemorySecret: SecretKeeping, @unchecked Sendable {
    private let lock = NSLock()
    private var kept: String?
    public let guarded: SecretGuard
    /// What the next read answers instead of the secret, if set.
    public var readFailure: BiometricFailure?

    public init(_ secret: String? = nil, guarded: SecretGuard = .app) {
        kept = secret
        self.guarded = guarded
    }

    public var secret: String? { lock.withLock { kept } }

    public func has() -> Bool { lock.withLock { kept != nil } }

    public func write(_ secret: String) -> BiometricFailure? {
        lock.withLock { kept = secret }
        return nil
    }

    public func read(with pass: BiometricPass) -> Result<String, BiometricFailure> {
        lock.withLock {
            if let readFailure { return .failure(readFailure) }
            return kept.map { .success($0) } ?? .failure(.gone)
        }
    }

    public func delete() { lock.withLock { kept = nil } }
}
#endif
