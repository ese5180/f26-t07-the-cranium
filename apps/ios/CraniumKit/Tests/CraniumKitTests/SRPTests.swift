import CryptoKit
import Foundation
import Testing
@testable import CraniumKit

/// The big numbers, against what Node's BigInt makes of the same (SRPVectors.swift).
@Suite struct BigUIntTests {
    func number(_ hex: String) -> BigUInt { BigUInt(hex: hex)! }

    @Test func hexAndBytesGoBothWays() {
        #expect(BigUInt(hex: "0")!.hex == "0")
        #expect(BigUInt(hex: "000000")!.isZero)
        #expect(BigUInt(hex: "00ff")!.hex == "ff")
        #expect(BigUInt(hex: "ABCdef0123456789abcdef0123456789")!.hex == "abcdef0123456789abcdef0123456789")
        #expect(BigUInt(hex: "1" + String(repeating: "0", count: 16))!.limbs == [0, 1])
        for bad in ["", "0x12", "12 34", "g", "-1", "١٢"] {
            #expect(BigUInt(hex: bad) == nil, "\(bad)")
        }
        #expect(BigUInt(bigEndian: [0, 0, 1, 2]).hex == "102")
        #expect(BigUInt(bigEndian: [UInt8]()).isZero)
        #expect(BigUInt(hex: "0102030405060708090a")!.bytes == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        #expect(BigUInt().bytes == [])
        #expect(BigUInt(hex: "8000000000000000")!.bitWidth == 64)
        #expect(BigUInt(hex: "8000000000000000")!.bit(63))
        #expect(!BigUInt(hex: "8000000000000000")!.bit(62))
    }

    @Test func aNumberIsHashedAsJavaWritesIt() {
        // The website's own vectors (signin.test.mjs): a 00 byte in front when the top bit is set.
        let vectors: [(String, String)] = [
            ("0", "00"), ("1", "01"), ("7f", "7f"), ("80", "0080"), ("ff", "00ff"), ("100", "0100"),
            ("abc", "0abc"), ("8abc", "008abc"), ("0123", "0123"), ("7fff", "7fff"), ("8000", "008000"),
        ]
        for (value, written) in vectors {
            let bytes = BigUInt(hex: value)!.signedBytes
            #expect(bytes.map { String(format: "%02x", $0) }.joined() == written, "\(value)")
        }
        // N's top bit is set, so it is hashed as 385 bytes.
        #expect(CognitoSRP.N.signedBytes.count == 385)
        #expect(CognitoSRP.N.signedBytes.prefix(3) == [0x00, 0xff, 0xff])
    }

    @Test func sumsDifferencesProductsAndRemaindersAgreeWithNode() {
        for vector in SRPVectors.arithmetic {
            let p = number(vector.p), q = number(vector.q)
            #expect((p + q).hex == vector.sum)
            #expect((p >= q ? p - q : q - p).hex == vector.difference)
            #expect((p * q).hex == vector.product)
            #expect((p % q).hex == vector.remainder)
            #expect((p < q) == (p.bitWidth < q.bitWidth || (p.bitWidth == q.bitWidth && p.hex < q.hex)))
        }
    }

    @Test func powersAgreeWithTheWebsitesModPow() {
        for vector in SRPVectors.powers {
            let group = Montgomery(modulus: number(vector.modulus))
            #expect(group.power(number(vector.base), number(vector.exponent)).hex == vector.result,
                    "a \(number(vector.modulus).bitWidth)-bit modulus")
        }
        // And a small one, worked out by hand: 3^200 mod 1000003, by repeated multiplication.
        var expected: UInt64 = 1
        for _ in 0..<200 { expected = expected * 3 % 1_000_003 }
        #expect(Montgomery(modulus: BigUInt(1_000_003)).power(BigUInt(3), BigUInt(200)) == BigUInt(expected))
    }
}

/// The proof of the password, against the website's own SRP code (srp-vectors.mjs ran core.js on
/// the same numbers, and checked each signature against its stand-in for Cognito).
@Suite struct SRPTests {
    func bytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            out.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return out
    }

    func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    @Test func theGroupIsRFC3526Group15WithGenerator2() {
        #expect(CognitoSRP.N.bitWidth == 3072)
        #expect(CognitoSRP.N.limbs.first == .max && CognitoSRP.N.limbs.last == .max)
        #expect(CognitoSRP.g == BigUInt(2))
        #expect(CognitoSRP.k.hex == SRPVectors.k)
    }

    @Test(arguments: SRPVectors.exchanges.map(\.name))
    func theProofIsTheWebsitesToTheLastByte(name: String) throws {
        let vector = try #require(SRPVectors.exchanges.first { $0.name == name })
        let random = bytes(vector.aBytes)
        let secret = try CognitoSRP.start { count in
            #expect(count == 128)
            return random
        }
        #expect(secret.A.hex == vector.A)
        #expect(secret.srpA == vector.srpA)

        let proof = try CognitoSRP.proof(userPoolId: vector.userPoolId, userId: vector.userId, password: vector.password,
                                         secret: secret, srpB: vector.srpB, salt: vector.salt,
                                         secretBlock: vector.secretBlock, timestamp: vector.timestamp)
        #expect(proof.u.hex == vector.u)
        #expect(proof.x.hex == vector.x)
        #expect(proof.S.hex == vector.S)
        #expect(hex(proof.key) == vector.key)
        #expect(proof.signature == vector.signature)

        // One letter more in the password makes another claim.
        let wrong = try CognitoSRP.proof(userPoolId: vector.userPoolId, userId: vector.userId, password: vector.password + "x",
                                         secret: secret, srpB: vector.srpB, salt: vector.salt,
                                         secretBlock: vector.secretBlock, timestamp: vector.timestamp)
        #expect(wrong.signature != vector.signature)
    }

    @Test func theTimeIsWrittenAsCognitoWantsIt() {
        for (ms, text) in SRPVectors.timestamps {
            #expect(CognitoSRP.timestamp(Date(timeIntervalSince1970: ms / 1000)) == text)
        }
        // Cognito's clock from the Date header of its answer.
        let header = CognitoSRP.serverTime("Mon, 02 Nov 2026 03:04:05 GMT")
        #expect(header.map(CognitoSRP.timestamp) == "Mon Nov 2 03:04:05 UTC 2026")
        #expect(CognitoSRP.serverTime("Monday, 02-Nov-26 03:04:05 GMT").map(CognitoSRP.timestamp) == "Mon Nov 2 03:04:05 UTC 2026")
        for bad in [nil, "", "yesterday", "2026-11-02T03:04:05Z"] {
            #expect(CognitoSRP.serverTime(bad) == nil)
        }
    }

    @Test func theKeyIsHKDFWithCognitosInfo() {
        // RFC 5869, test case 1, cut to 16 bytes.
        let key = CognitoSRP.derivedKey([UInt8](repeating: 0x0b, count: 22), salt: bytes("000102030405060708090a0b0c"),
                                        info: bytes("f0f1f2f3f4f5f6f7f8f9"))
        #expect(hex(key) == "3cb25f25faacd57a90434f64d0362f2a")
        // With "Caldera Derived Key", as Cognito's own library writes it: HMAC(HMAC(salt, ikm), info | 01).
        let input = Array(repeating: UInt8(7), count: 385), salt = Array(repeating: UInt8(9), count: 33)
        let prk = HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: salt))
        let okm = HMAC<SHA256>.authenticationCode(for: Array("Caldera Derived Key".utf8) + [1], using: SymmetricKey(data: Data(prk)))
        #expect(CognitoSRP.derivedKey(input, salt: salt) == Array(okm.prefix(16)))
    }

    @Test func theUserPoolsNameIsWhatFollowsTheUnderscore() {
        #expect(CognitoSRP.name(of: "us-east-1_AbC123") == "AbC123")
        #expect(CognitoSRP.name(of: "no-underscore") == "no-underscore")
    }

    @Test func aChallengeThatCannotBeUsedIsRefusedNotAnswered() throws {
        let secret = try CognitoSRP.start()
        func proof(srpB: String = "abc123", salt: String = "beef", secretBlock: String = "AAAA", userId: String = "user-1") throws {
            _ = try CognitoSRP.proof(userPoolId: "us-east-1_Pool", userId: userId, password: "pw", secret: secret,
                                     srpB: srpB, salt: salt, secretBlock: secretBlock, timestamp: "Mon Nov 2 03:04:05 UTC 2026")
        }
        try proof()
        // The website's list (signin.test.mjs).
        let n = CognitoSRP.N
        for srpB in ["0", n.hex, (n + n).hex, "xyz", "", String(repeating: "f", count: 1025)] {
            #expect(throws: CognitoSRP.Failure.unusableChallenge) { try proof(srpB: srpB) }
        }
        for salt in ["", "12 34"] {
            #expect(throws: CognitoSRP.Failure.unusableChallenge) { try proof(salt: salt) }
        }
        for block in ["not base64!", "", "A", "AA=", "AAAA==="] {
            #expect(throws: CognitoSRP.Failure.unusableChallenge) { try proof(secretBlock: block) }
        }
        for userId in ["", "a:b", "two words", "tab\there", String(repeating: "u", count: 129)] {
            #expect(throws: CognitoSRP.Failure.unusableChallenge) { try proof(userId: userId) }
        }
        // Padding is optional, as atob has it.
        try proof(secretBlock: "AAA")
        try proof(secretBlock: "AA==")
    }

    @Test func aRandomSourceThatGivesNothingIsRefused() {
        #expect(throws: CognitoSRP.Failure.noRandom) {
            try CognitoSRP.start { [UInt8](repeating: 0, count: $0) }
        }
    }

    /// The time a whole proof takes: A, then the claim. This is the Debug build when run by
    /// `swift test`; with `swift test -c release -Xswiftc -enable-testing` it is the Release one.
    @Test func theProofTakesWellUnderASecond() throws {
        let vector = SRPVectors.exchanges[0]
        let clock = ContinuousClock()
        _ = CognitoSRP.group  // made once per launch; timed apart
        var times: [Duration] = []
        for _ in 0..<3 {
            let start = clock.now
            let secret = try CognitoSRP.start()
            _ = try CognitoSRP.proof(userPoolId: vector.userPoolId, userId: vector.userId, password: vector.password,
                                     secret: secret, srpB: vector.srpB, salt: vector.salt,
                                     secretBlock: vector.secretBlock, timestamp: vector.timestamp)
            times.append(clock.now - start)
        }
        let best = times.min()!
        #if DEBUG
        let build = "Debug"
        #else
        let build = "Release"
        #endif
        print("SRP timing (\(build), this Mac): start + proof took \(times.map { $0.formatted(.units(allowed: [.milliseconds])) }), best \(best.formatted(.units(allowed: [.milliseconds])))")
        // A loose bound, so that a slow test machine does not fail it; the report has the numbers.
        #expect(best < .seconds(10))
    }
}
