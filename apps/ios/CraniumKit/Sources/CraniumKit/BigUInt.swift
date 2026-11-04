import Foundation

/// A whole number of 0 or more, of any size, with only what Cognito's SRP needs (CognitoSRP.swift):
/// hex and bytes in and out, comparison, +, -, *, the remainder, and powers modulo an odd number
/// (`Montgomery`). Swift has no big integers of its own, and this keeps the app free of a package
/// for them. The tests check it against numbers that Node's BigInt worked out
/// (Tests/srp-vectors.mjs).
///
/// It is not constant-time, any more than the website's JavaScript BigInt is: the one secret it
/// works with, SRP's `a`, is new for every sign-in and never leaves the phone.
struct BigUInt: Sendable, Hashable, Comparable, CustomStringConvertible {
    /// 64-bit limbs, the least significant first. The top one is never 0, so zero has none.
    private(set) var limbs: [UInt64]

    init(_ value: UInt64 = 0) {
        limbs = value == 0 ? [] : [value]
    }

    init(limbs: [UInt64]) {
        self.limbs = limbs
        while let last = self.limbs.last, last == 0 { self.limbs.removeLast() }
    }

    /// Hex digits in either case, with no prefix and no sign. Nil for anything else, and for "".
    init?<Text: StringProtocol>(hex text: Text) {
        let digits = Array(text.utf8)
        guard !digits.isEmpty else { return nil }
        var limbs: [UInt64] = []
        limbs.reserveCapacity(digits.count / 16 + 1)
        var end = digits.count
        while end > 0 {
            let start = Swift.max(0, end - 16)
            var limb: UInt64 = 0
            for digit in digits[start..<end] {
                guard let value = Self.hexValue(digit) else { return nil }
                limb = limb << 4 | value
            }
            limbs.append(limb)
            end = start
        }
        self.init(limbs: limbs)
    }

    /// Big-endian bytes, as a hash gives them. Leading zero bytes change nothing.
    init<Bytes: Collection>(bigEndian bytes: Bytes) where Bytes.Element == UInt8 {
        var limbs = [UInt64](repeating: 0, count: (bytes.count + 7) / 8)
        for (offset, byte) in bytes.reversed().enumerated() {
            limbs[offset / 8] |= UInt64(byte) << UInt64(8 * (offset % 8))
        }
        self.init(limbs: limbs)
    }

    private static func hexValue(_ digit: UInt8) -> UInt64? {
        switch digit {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return UInt64(digit - UInt8(ascii: "0"))
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return UInt64(digit - UInt8(ascii: "a") + 10)
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return UInt64(digit - UInt8(ascii: "A") + 10)
        default: return nil
        }
    }

    var isZero: Bool { limbs.isEmpty }

    /// How many bits it takes: 0 for zero.
    var bitWidth: Int {
        guard let top = limbs.last else { return 0 }
        return limbs.count * 64 - top.leadingZeroBitCount
    }

    /// Bit `index`, counted from the least significant, which is 0.
    func bit(_ index: Int) -> Bool {
        let limb = index / 64
        guard limb < limbs.count else { return false }
        return (limbs[limb] >> UInt64(index % 64)) & 1 == 1
    }

    /// Lower-case hex with no leading zeros, and "0" for zero: JavaScript's `toString(16)`.
    var hex: String {
        guard let top = limbs.last else { return "0" }
        var text = String(top, radix: 16)
        for limb in limbs.dropLast().reversed() {
            let part = String(limb, radix: 16)
            text += String(repeating: "0", count: 16 - part.count) + part
        }
        return text
    }

    /// The shortest big-endian bytes: none for zero.
    var bytes: [UInt8] {
        guard let top = limbs.last else { return [] }
        let topBytes = (64 - top.leadingZeroBitCount + 7) / 8
        var out: [UInt8] = []
        out.reserveCapacity(topBytes + 8 * (limbs.count - 1))
        for shift in stride(from: topBytes - 1, through: 0, by: -1) {
            out.append(UInt8(truncatingIfNeeded: top >> UInt64(8 * shift)))
        }
        for limb in limbs.dropLast().reversed() {
            for shift in stride(from: 7, through: 0, by: -1) {
                out.append(UInt8(truncatingIfNeeded: limb >> UInt64(8 * shift)))
            }
        }
        return out
    }

    /// As Java's `BigInteger.toByteArray()` writes it, which is what Cognito hashes: the shortest
    /// bytes with room for a sign, so a 00 byte in front when the top bit is set, and 00 for zero.
    /// The website's `srpHex`.
    var signedBytes: [UInt8] {
        let plain = bytes
        guard let first = plain.first, first & 0x80 == 0 else { return [0] + plain }
        return plain
    }

    /// Its size only: one of these may be a secret, and descriptions end up in logs.
    var description: String { "BigUInt(\(bitWidth) bits)" }

    static func < (lhs: BigUInt, rhs: BigUInt) -> Bool {
        if lhs.limbs.count != rhs.limbs.count { return lhs.limbs.count < rhs.limbs.count }
        for index in stride(from: lhs.limbs.count - 1, through: 0, by: -1) where lhs.limbs[index] != rhs.limbs[index] {
            return lhs.limbs[index] < rhs.limbs[index]
        }
        return false
    }

    static func + (lhs: BigUInt, rhs: BigUInt) -> BigUInt {
        let (long, short) = lhs.limbs.count >= rhs.limbs.count ? (lhs.limbs, rhs.limbs) : (rhs.limbs, lhs.limbs)
        var out = long
        out.append(0)
        var carry: UInt64 = 0
        for index in 0..<long.count {
            let (sum, overflow) = out[index].addingReportingOverflow(index < short.count ? short[index] : 0)
            let (total, overflow2) = sum.addingReportingOverflow(carry)
            out[index] = total
            carry = (overflow ? 1 : 0) + (overflow2 ? 1 : 0)
        }
        out[long.count] = carry
        return BigUInt(limbs: out)
    }

    /// `lhs` must be at least `rhs`.
    static func - (lhs: BigUInt, rhs: BigUInt) -> BigUInt {
        precondition(lhs >= rhs, "a BigUInt cannot go below zero")
        var out = lhs.limbs
        var borrow: UInt64 = 0
        for index in 0..<out.count {
            let (difference, under) = out[index].subtractingReportingOverflow(index < rhs.limbs.count ? rhs.limbs[index] : 0)
            let (result, under2) = difference.subtractingReportingOverflow(borrow)
            out[index] = result
            borrow = (under ? 1 : 0) + (under2 ? 1 : 0)
        }
        return BigUInt(limbs: out)
    }

    static func * (lhs: BigUInt, rhs: BigUInt) -> BigUInt {
        if lhs.isZero || rhs.isZero { return BigUInt() }
        var out = [UInt64](repeating: 0, count: lhs.limbs.count + rhs.limbs.count)
        for i in 0..<lhs.limbs.count {
            let left = lhs.limbs[i]
            var carry: UInt64 = 0
            for j in 0..<rhs.limbs.count {
                let (high, low) = left.multipliedFullWidth(by: rhs.limbs[j])
                let (sum, overflow) = out[i + j].addingReportingOverflow(low)
                let (total, overflow2) = sum.addingReportingOverflow(carry)
                out[i + j] = total
                // At most 2^64 - 1: a product of two limbs plus two limbs fits in 128 bits.
                carry = high &+ (overflow ? 1 : 0) &+ (overflow2 ? 1 : 0)
            }
            out[i + rhs.limbs.count] = carry
        }
        return BigUInt(limbs: out)
    }

    /// The remainder, one bit at a time. It is only used a few times in a sign-in, on numbers of a
    /// few thousand bits; the powers, where the time goes, use `Montgomery`.
    static func % (value: BigUInt, modulus: BigUInt) -> BigUInt {
        precondition(!modulus.isZero, "a remainder needs a modulus above zero")
        if value < modulus { return value }
        let count = modulus.limbs.count + 1
        var rest = [UInt64](repeating: 0, count: count)
        let limit = modulus.limbs + [0]
        rest.withUnsafeMutableBufferPointer { rest in
            limit.withUnsafeBufferPointer { limit in
                let r = rest.baseAddress!, m = limit.baseAddress!
                for index in stride(from: value.bitWidth - 1, through: 0, by: -1) {
                    // rest < modulus, so 2 * rest + 1 < 2 * modulus fits in count limbs.
                    Limbs.double(r, count, plus: value.bit(index) ? 1 : 0)
                    if Limbs.compare(r, m, count) >= 0 { Limbs.subtract(r, m, count) }
                }
            }
        }
        return BigUInt(limbs: rest)
    }
}

/// Arithmetic on limbs in place, through pointers: no copies and no bounds checks in the loops
/// that a power runs thousands of times.
enum Limbs {
    /// r = 2r + plus, over `count` limbs, where plus is 0 or 1. What is shifted out of the top is lost.
    static func double(_ r: UnsafeMutablePointer<UInt64>, _ count: Int, plus: UInt64) {
        var carry = plus
        for index in 0..<count {
            let limb = r[index]
            r[index] = limb << 1 | carry
            carry = limb >> 63
        }
    }

    /// -1, 0 or 1, as a is below, equal to or above b, both `count` limbs long.
    static func compare(_ a: UnsafePointer<UInt64>, _ b: UnsafePointer<UInt64>, _ count: Int) -> Int {
        var index = count - 1
        while index >= 0 {
            if a[index] != b[index] { return a[index] < b[index] ? -1 : 1 }
            index -= 1
        }
        return 0
    }

    /// a -= b over `count` limbs; returns the borrow out of the top (1 if b was the larger).
    @discardableResult
    static func subtract(_ a: UnsafeMutablePointer<UInt64>, _ b: UnsafePointer<UInt64>, _ count: Int) -> UInt64 {
        var borrow: UInt64 = 0
        for index in 0..<count {
            let (difference, under) = a[index].subtractingReportingOverflow(b[index])
            let (result, under2) = difference.subtractingReportingOverflow(borrow)
            a[index] = result
            borrow = (under ? 1 : 0) | (under2 ? 1 : 0)
        }
        return borrow
    }
}

/// Powers modulo one odd number, by Montgomery multiplication (CIOS, 64-bit limbs) and a window of
/// four bits. Made once per modulus: it works out R mod n and R² mod n, where R = 2^(64·limbs).
struct Montgomery: Sendable {
    let modulus: BigUInt
    /// The modulus's limbs, `count` of them.
    private let n: [UInt64]
    private let count: Int
    /// -n⁻¹ mod 2^64.
    private let inverse: UInt64
    /// R mod n: 1 in Montgomery form.
    private let one: [UInt64]
    /// R² mod n: what turns a number into Montgomery form.
    private let rSquared: [UInt64]

    init(modulus: BigUInt) {
        precondition(modulus.bitWidth > 1 && modulus.limbs[0] & 1 == 1, "Montgomery needs an odd modulus above 1")
        self.modulus = modulus
        n = modulus.limbs
        count = n.count
        // Newton's iteration: each step doubles the bits that are right, from 3 (n·n ≡ 1 mod 8).
        var inverse = n[0]
        for _ in 0..<5 { inverse = inverse &* (2 &- n[0] &* inverse) }
        self.inverse = 0 &- inverse
        one = Self.powerOfTwo(64 * count, modulo: n)
        rSquared = Self.powerOfTwo(128 * count, modulo: n)
    }

    /// 2^exponent mod n, as `n.count` limbs, by doubling.
    private static func powerOfTwo(_ exponent: Int, modulo n: [UInt64]) -> [UInt64] {
        let count = n.count + 1
        var rest = [UInt64](repeating: 0, count: count)
        rest[0] = 1
        let limit = n + [0]
        rest.withUnsafeMutableBufferPointer { rest in
            limit.withUnsafeBufferPointer { limit in
                let r = rest.baseAddress!, m = limit.baseAddress!
                for _ in 0..<exponent {
                    Limbs.double(r, count, plus: 0)
                    if Limbs.compare(r, m, count) >= 0 { Limbs.subtract(r, m, count) }
                }
            }
        }
        return Array(rest.prefix(n.count))
    }

    /// base^exponent mod n.
    func power(_ base: BigUInt, _ exponent: BigUInt) -> BigUInt {
        if exponent.isZero { return BigUInt(1) % modulus }
        let s = count
        let reduced = base % modulus
        // The table of base^0 … base^15, the running power, the plain number, and the scratch.
        let table = 16 * s, running = table, plain = running + s, scratch = plain + s
        let buffer = UnsafeMutablePointer<UInt64>.allocate(capacity: scratch + s + 2)
        defer { buffer.deallocate() }
        buffer.initialize(repeating: 0, count: scratch + s + 2)
        n.withUnsafeBufferPointer { modulusLimbs in
            one.withUnsafeBufferPointer { oneLimbs in
                rSquared.withUnsafeBufferPointer { squaredLimbs in
                    let m = modulusLimbs.baseAddress!
                    let t = buffer + scratch
                    func entry(_ index: Int) -> UnsafeMutablePointer<UInt64> { buffer + index * s }
                    func multiply(_ a: UnsafePointer<UInt64>, _ b: UnsafePointer<UInt64>, into out: UnsafeMutablePointer<UInt64>) {
                        Self.multiply(a, b, m, s, inverse, t, out)
                    }

                    let x = buffer + plain
                    for (index, limb) in reduced.limbs.enumerated() { x[index] = limb }
                    entry(0).update(from: oneLimbs.baseAddress!, count: s)
                    multiply(x, squaredLimbs.baseAddress!, into: entry(1))
                    for index in 2..<16 { multiply(entry(index - 1), entry(1), into: entry(index)) }

                    let windows = (exponent.bitWidth + 3) / 4
                    func window(_ index: Int) -> Int {
                        Int((exponent.limbs[index / 16] >> UInt64((index % 16) * 4)) & 0xF)
                    }
                    let acc = buffer + running
                    acc.update(from: entry(window(windows - 1)), count: s)
                    var index = windows - 2
                    while index >= 0 {
                        for _ in 0..<4 { multiply(acc, acc, into: acc) }
                        let digit = window(index)
                        if digit != 0 { multiply(acc, entry(digit), into: acc) }
                        index -= 1
                    }
                    // Out of Montgomery form: times plain 1.
                    x.update(repeating: 0, count: s)
                    x[0] = 1
                    multiply(acc, x, into: acc)
                }
            }
        }
        return BigUInt(limbs: Array(UnsafeBufferPointer(start: buffer + running, count: s)))
    }

    /// out = a·b/R mod n, for a and b below n, each `s` limbs. `t` is scratch of s + 2 limbs. `out`
    /// may be `a` or `b`: it is written only at the end.
    private static func multiply(_ a: UnsafePointer<UInt64>, _ b: UnsafePointer<UInt64>, _ n: UnsafePointer<UInt64>,
                                 _ s: Int, _ inverse: UInt64, _ t: UnsafeMutablePointer<UInt64>,
                                 _ out: UnsafeMutablePointer<UInt64>) {
        t.update(repeating: 0, count: s + 2)
        for i in 0..<s {
            // t += a · b[i]
            let factor = b[i]
            var carry: UInt64 = 0
            for j in 0..<s {
                let (high, low) = a[j].multipliedFullWidth(by: factor)
                let (sum, overflow) = t[j].addingReportingOverflow(low)
                let (total, overflow2) = sum.addingReportingOverflow(carry)
                t[j] = total
                carry = high &+ (overflow ? 1 : 0) &+ (overflow2 ? 1 : 0)
            }
            let (top, topOverflow) = t[s].addingReportingOverflow(carry)
            t[s] = top
            t[s + 1] = topOverflow ? 1 : 0

            // t = (t + m · n) / 2^64, where m makes the lowest limb 0.
            let m = t[0] &* inverse
            let (high0, low0) = m.multipliedFullWidth(by: n[0])
            let (_, overflow0) = t[0].addingReportingOverflow(low0)
            carry = high0 &+ (overflow0 ? 1 : 0)
            var j = 1
            while j < s {
                let (high, low) = m.multipliedFullWidth(by: n[j])
                let (sum, overflow) = t[j].addingReportingOverflow(low)
                let (total, overflow2) = sum.addingReportingOverflow(carry)
                t[j - 1] = total
                carry = high &+ (overflow ? 1 : 0) &+ (overflow2 ? 1 : 0)
                j += 1
            }
            let (shifted, shiftedOverflow) = t[s].addingReportingOverflow(carry)
            t[s - 1] = shifted
            t[s] = t[s + 1] &+ (shiftedOverflow ? 1 : 0)
            t[s + 1] = 0
        }
        // t < 2n: one subtraction at most.
        if t[s] != 0 || Limbs.compare(t, n, s) >= 0 {
            Limbs.subtract(t, n, s)
        }
        out.update(from: t, count: s)
    }
}
