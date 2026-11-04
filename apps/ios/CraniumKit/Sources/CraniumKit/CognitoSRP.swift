import CryptoKit
import Foundation

/// The proof of a password that Cognito asks for: SRP, as Cognito does it. A port of the website's
/// own (cloud/web/src/site/assets/core.js: `startSrp`, `srpClaim`, `cognitoTimestamp`), step for
/// step, and checked against it: Tests/srp-vectors.mjs runs the website's code in Node on fixed
/// numbers, and SRPTests expects the same A, u, x, S, key and signature here.
///
/// Cognito's USER_SRP_AUTH is SRP-6a (RFC 5054) with choices of its own:
///
/// - N is the 3072-bit prime of RFC 3526 (group 15), and g = 2.
/// - A number is hashed as its shortest big-endian bytes with room for a sign, the way Java writes
///   a BigInteger (`BigUInt.signedBytes`). It is not padded to the length of N.
/// - k = H(N | g), u = H(A | B), x = H(salt | H(poolName | userId | ":" | password)), where
///   poolName is the part of the pool ID after the underscore and userId is the USER_ID_FOR_SRP
///   that Cognito sends back, not the address that was typed.
/// - S = (B - k · g^x) ^ (a + u · x) mod N.
/// - The key is the first 16 bytes of HKDF-SHA-256 (RFC 5869) with S as the input, u as the salt
///   and "Caldera Derived Key" as the info.
/// - The claim is HMAC-SHA-256 under that key of poolName | userId | the bytes of SECRET_BLOCK |
///   the time, written as "Mon Nov 2 03:04:05 UTC 2026".
///
/// `a` is 128 random bytes from the system's secure generator and lives for one sign-in, in
/// memory. The password is used for x and nothing else.
enum CognitoSRP {
    static let N = BigUInt(hex: [
        "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1",
        "29024E088A67CC74020BBEA63B139B22514A08798E3404DD",
        "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245",
        "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED",
        "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D",
        "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F",
        "83655D23DCA3AD961C62F356208552BB9ED529077096966D",
        "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B",
        "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9",
        "DE2BCBF6955817183995497CEA956AE515D2261898FA0510",
        "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64",
        "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7",
        "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B",
        "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C",
        "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31",
        "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
    ].joined())!
    static let g = BigUInt(2)
    /// Powers modulo N. Made on first use, in a few milliseconds.
    static let group = Montgomery(modulus: N)
    static let k = hashOfNumbers(N, g)
    static let info = Array("Caldera Derived Key".utf8)
    static let keyBytes = 16
    static let secretBytes = 128

    enum Failure: Error, Equatable {
        /// The random source gave nothing usable.
        case noRandom
        /// What Cognito sent in its challenge cannot be used. Nothing is answered.
        case unusableChallenge
    }

    /// The phone's half of an exchange: the secret a and the A that goes to Cognito.
    struct Secret: Sendable {
        let a: BigUInt
        let A: BigUInt
        /// SRP_A as the website sends it: `A.toString(16)`.
        var srpA: String { A.hex }
    }

    /// What the proof is made of, for the tests; a sign-in sends only the signature.
    struct Proof: Sendable {
        let u: BigUInt
        let x: BigUInt
        let S: BigUInt
        let key: [UInt8]
        /// PASSWORD_CLAIM_SIGNATURE: base64 of 32 bytes.
        let signature: String
    }

    /// `random(count)` gives that many bytes from a secure source.
    static func start(random: (Int) -> [UInt8] = systemRandom) throws -> Secret {
        let a = BigUInt(bigEndian: random(secretBytes))
        let A = group.power(g, a)
        // Only a broken random source gets here.
        if a.isZero || A.isZero { throw Failure.noRandom }
        return Secret(a: a, A: A)
    }

    static func systemRandom(_ count: Int) -> [UInt8] {
        // A cryptographically secure source on Apple's systems.
        var generator = SystemRandomNumberGenerator()
        return (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    }

    /// The PASSWORD_CLAIM_SIGNATURE for Cognito's PASSWORD_VERIFIER challenge: proof that this
    /// phone knows the password, made without sending it. Throws if what Cognito sent cannot be
    /// used, as the website does.
    static func proof(userPoolId: String, userId: String, password: String, secret: Secret,
                      srpB: String, salt: String, secretBlock: String, timestamp: String) throws -> Proof {
        guard isNumber(srpB), isNumber(salt), isUser(userId),
              let block = blockBytes(secretBlock),
              let B = BigUInt(hex: srpB), let saltNumber = BigUInt(hex: salt) else {
            throw Failure.unusableChallenge
        }
        let reducedB = B % N
        if reducedB.isZero { throw Failure.unusableChallenge }
        let u = hashOfNumbers(secret.A, B)
        if u.isZero { throw Failure.unusableChallenge }
        let poolName = name(of: userPoolId)
        let inner = sha256(Array("\(poolName)\(userId):\(password)".utf8))
        let x = BigUInt(bigEndian: sha256(saltNumber.signedBytes + inner))
        // (B - k·g^x) mod N, kept at 0 or more.
        let kv = (k * group.power(g, x)) % N
        let base = reducedB >= kv ? reducedB - kv : reducedB + N - kv
        let S = group.power(base, secret.a + u * x)
        let key = derivedKey(S.signedBytes, salt: u.signedBytes)
        let message = Array(poolName.utf8) + Array(userId.utf8) + block + Array(timestamp.utf8)
        let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key))
        return Proof(u: u, x: x, S: S, key: key, signature: Data(mac).base64EncodedString())
    }

    /// The part of a pool ID after the underscore: "AbC123" of "us-east-1_AbC123". The whole ID if
    /// it has none, as `slice(indexOf('_') + 1)` has it.
    static func name(of userPoolId: String) -> String {
        guard let underscore = userPoolId.firstIndex(of: "_") else { return userPoolId }
        return String(userPoolId[userPoolId.index(after: underscore)...])
    }

    /// The first 16 bytes of HKDF-SHA-256 (RFC 5869), with "Caldera Derived Key" as the info.
    static func derivedKey(_ input: [UInt8], salt: [UInt8], info: [UInt8] = info) -> [UInt8] {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: input), salt: salt, info: info,
                                         outputByteCount: keyBytes)
        return key.withUnsafeBytes { Array($0) }
    }

    /// H of numbers written one after the other, as a number.
    static func hashOfNumbers(_ values: BigUInt...) -> BigUInt {
        BigUInt(bigEndian: sha256(values.flatMap(\.signedBytes)))
    }

    static func sha256(_ bytes: [UInt8]) -> [UInt8] {
        Array(SHA256.hash(data: bytes))
    }

    // What Cognito sends in its challenge, checked before it is used, as the website checks it.

    /// /^[0-9a-fA-F]{1,1024}$/
    static func isNumber(_ text: String) -> Bool {
        let digits = text.utf8
        return (1...1024).contains(digits.count) && digits.allSatisfy {
            (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0)
                || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains($0)
        }
    }

    /// /^[^\s:]{1,128}$/, with JavaScript's \s and its count of UTF-16 units.
    static func isUser(_ text: String) -> Bool {
        (1...128).contains(text.utf16.count) && !text.unicodeScalars.contains { $0 == ":" || javaScriptSpace($0) }
    }

    private static func javaScriptSpace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    /// /^[A-Za-z0-9+/]{1,8192}={0,2}$/, then decoded as `atob` would: nil if either refuses it.
    static func blockBytes(_ text: String) -> [UInt8]? {
        let characters = Array(text.utf8)
        var body = characters[...]
        var padding = 0
        while padding < 2, body.last == UInt8(ascii: "=") {
            body = body.dropLast()
            padding += 1
        }
        guard (1...8192).contains(body.count), body.allSatisfy(isBase64), padding == 0 || characters.count % 4 == 0 else {
            return nil
        }
        // atob: padding is optional, but a lone character in the last group is not base64.
        guard body.count % 4 != 1 else { return nil }
        let padded = String(decoding: body, as: UTF8.self) + String(repeating: "=", count: (4 - body.count % 4) % 4)
        return Data(base64Encoded: padded).map { Array($0) }
    }

    private static func isBase64(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
            || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || byte == UInt8(ascii: "+") || byte == UInt8(ascii: "/")
    }

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// The time as Cognito wants it in a PASSWORD_VERIFIER answer: "Mon Nov 2 03:04:05 UTC 2026",
    /// English names whatever the phone's language, the day without a leading zero, the time in UTC
    /// to the second (cut, not rounded).
    static func timestamp(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let whole = Date(timeIntervalSince1970: (date.timeIntervalSince1970).rounded(.down))
        let parts = calendar.dateComponents([.weekday, .month, .day, .hour, .minute, .second, .year], from: whole)
        func two(_ value: Int?) -> String {
            let text = String(value ?? 0)
            return text.count < 2 ? "0" + text : text
        }
        return "\(weekdays[(parts.weekday ?? 1) - 1]) \(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1) "
            + "\(two(parts.hour)):\(two(parts.minute)):\(two(parts.second)) UTC \(parts.year ?? 1970)"
    }

    /// The time in an HTTP Date header ("Mon, 02 Nov 2026 03:04:05 GMT"), or nil. The proof goes by
    /// Cognito's clock where its answer says it, as the website's does, so that a phone whose
    /// clock is wrong can still sign in.
    static func serverTime(_ header: String?) -> Date? {
        guard let header, !header.isEmpty else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        for format in ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, d MMM yyyy HH:mm:ss zzz", "EEEE, dd-MMM-yy HH:mm:ss zzz"] {
            formatter.dateFormat = format
            if let date = formatter.date(from: header) { return date }
        }
        return nil
    }
}
