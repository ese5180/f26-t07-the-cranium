import Foundation
import Security

/// Where the tokens are kept between launches.
public protocol TokenStore: Sendable {
    func load() throws -> Tokens?
    func save(_ tokens: Tokens) throws
    func clear() throws
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public let status: OSStatus
    public var errorDescription: String? { "The Keychain answered \(status)." }
}

/// The tokens as one generic-password item in the Keychain, readable only while the phone is
/// unlocked and never copied to another device or a backup.
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String

    public init(service: String = "com.craniumiot.cranium.console", account: String = "tokens") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if os(iOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    public func load() throws -> Tokens? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status: status)
        }
        // An item that does not decode is of no use: drop it rather than fail every launch.
        guard let tokens = try? JSONDecoder().decode(Tokens.self, from: data) else {
            try? clear()
            return nil
        }
        return tokens
    }

    public func save(_ tokens: Tokens) throws {
        let data = try JSONEncoder().encode(tokens)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }
}

/// Tokens in memory only: for tests and SwiftUI previews.
public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: Tokens?

    public init(_ tokens: Tokens? = nil) {
        self.tokens = tokens
    }

    public func load() throws -> Tokens? {
        lock.lock(); defer { lock.unlock() }
        return tokens
    }

    public func save(_ tokens: Tokens) throws {
        lock.lock(); defer { lock.unlock() }
        self.tokens = tokens
    }

    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        tokens = nil
    }
}
