import Foundation

/// An MCUboot image version: major, minor, revision and build number, compared in that order.
///
/// The board compares all four, the build number too (`fw_version_compare()` in the firmware), so
/// "newer" here means the same as it does on the board.
public struct FirmwareVersion: Hashable, Comparable, Sendable, CustomStringConvertible {
    public let major: UInt8
    public let minor: UInt8
    public let revision: UInt16
    public let build: UInt32

    public init(major: UInt8, minor: UInt8, revision: UInt16, build: UInt32) {
        self.major = major
        self.minor = minor
        self.revision = revision
        self.build = build
    }

    /// The console's form, `1.8.0+0`: the build number is always there, after a plus sign.
    public init?(release text: String) {
        guard let plus = text.firstIndex(of: "+") else { return nil }
        let main = text[..<plus].split(separator: ".", omittingEmptySubsequences: false)
        let build = text[text.index(after: plus)...]
        guard main.count == 3 else { return nil }
        self.init(parts: main + [build])
    }

    /// The board's form in an image list, as Zephyr's img_mgmt writes it: `1.8.0`, or `1.8.0.5`
    /// when the build number is not 0. `1.8.0+5` is taken too.
    public init?(imageList text: String) {
        if text.contains("+") {
            self.init(release: text)
            return
        }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        switch parts.count {
        case 3: self.init(parts: parts + ["0"])
        case 4: self.init(parts: parts)
        default: return nil
        }
    }

    private init?(parts: [Substring]) {
        guard parts.count == 4,
              let major = Self.number(parts[0], max: UInt64(UInt8.max)),
              let minor = Self.number(parts[1], max: UInt64(UInt8.max)),
              let revision = Self.number(parts[2], max: UInt64(UInt16.max)),
              let build = Self.number(parts[3], max: UInt64(UInt32.max)) else {
            return nil
        }
        self.init(major: UInt8(major), minor: UInt8(minor), revision: UInt16(revision), build: UInt32(build))
    }

    /// Decimal digits only, no sign, no leading zero, at most `max`.
    private static func number(_ text: Substring, max: UInt64) -> UInt64? {
        guard !text.isEmpty, text.count <= 10,
              text.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }),
              text == "0" || !text.hasPrefix("0"),
              let value = UInt64(text), value <= max else {
            return nil
        }
        return value
    }

    /// `1.8.0+0`, the console's form.
    public var description: String { "\(major).\(minor).\(revision)+\(build)" }

    public static func < (lhs: FirmwareVersion, rhs: FirmwareVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.revision, lhs.build) < (rhs.major, rhs.minor, rhs.revision, rhs.build)
    }
}
