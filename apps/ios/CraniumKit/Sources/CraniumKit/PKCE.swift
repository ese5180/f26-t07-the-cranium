import CryptoKit
import Foundation

/// Proof Key for Code Exchange (RFC 7636), S256 only.
public struct PKCE: Equatable, Sendable {
    /// 43 characters of base64url: 32 random bytes.
    public let verifier: String
    /// base64url(SHA-256(verifier)), no padding.
    public let challenge: String
    public static let method = "S256"

    /// A new verifier from the system's secure random generator.
    public static func generate() -> PKCE {
        PKCE(verifier: randomURLSafe(byteCount: 32))
    }

    /// A known verifier, for tests. RFC 7636 allows 43 to 128 unreserved characters.
    public init(verifier: String) {
        precondition((43...128).contains(verifier.count), "a PKCE verifier has 43 to 128 characters")
        self.verifier = verifier
        self.challenge = Self.challenge(for: verifier)
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// `byteCount` random bytes as base64url, for the verifier and the `state`.
    /// `SystemRandomNumberGenerator` is a cryptographically secure source on Apple platforms.
    public static func randomURLSafe(byteCount: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return base64URL(Data(bytes))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
