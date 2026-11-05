import CryptoKit
import Foundation

/// The 32-byte header at the start of a signed MCUboot image (`struct image_header`).
public struct MCUbootHeader: Equatable, Sendable {
    /// `IMAGE_MAGIC`, 0x96f3b83d, little-endian: the file starts `3d b8 f3 96`.
    public static let magic: UInt32 = 0x96F3_B83D
    public static let length = 32

    public let loadAddress: UInt32
    public let headerSize: UInt16
    public let protectedTLVSize: UInt16
    public let imageSize: UInt32
    public let flags: UInt32
    /// Bytes 20 to 27: major, minor, little-endian 16-bit revision, little-endian 32-bit build.
    public let version: FirmwareVersion

    /// Reads the header at the start of `data`. Nil when it is too short or the magic is wrong.
    public init?(_ data: Data) {
        let bytes = [UInt8](data.prefix(Self.length))
        guard bytes.count == Self.length else { return nil }
        func u16(_ at: Int) -> UInt16 { UInt16(bytes[at]) | UInt16(bytes[at + 1]) << 8 }
        func u32(_ at: Int) -> UInt32 {
            UInt32(bytes[at]) | UInt32(bytes[at + 1]) << 8 | UInt32(bytes[at + 2]) << 16 | UInt32(bytes[at + 3]) << 24
        }
        guard u32(0) == Self.magic else { return nil }
        loadAddress = u32(4)
        headerSize = u16(8)
        protectedTLVSize = u16(10)
        imageSize = u32(12)
        flags = u32(16)
        version = FirmwareVersion(major: bytes[20], minor: bytes[21], revision: u16(22), build: u32(24))
    }
}

/// Why a downloaded image is not sent. Nothing has gone to the board when one of these is thrown.
public enum ImageCheckError: Error, Equatable, LocalizedError {
    case wrongSize(expected: Int, actual: Int)
    case wrongHash
    case notAnImage
    case wrongVersion(header: FirmwareVersion, release: String)
    case badSizes
    case unreadableReleaseVersion(String)

    public var errorDescription: String? {
        switch self {
        case .wrongSize(let expected, let actual):
            return "The image is \(actual) bytes, and the release says \(expected)."
        case .wrongHash:
            return "The image's SHA-256 is not the release's."
        case .notAnImage:
            return "The file does not start with an MCUboot image header (3d b8 f3 96)."
        case .wrongVersion(let header, let release):
            return "The image's header says \(header), and the release is \(release)."
        case .badSizes:
            return "The sizes in the image's header add up to more than the file."
        case .unreadableReleaseVersion(let text):
            return "The release's version, \(text), is not of the form 1.2.3+4."
        }
    }
}

/// An image that has passed every check in docs/mobile-apps.md. Only `ImageCheck.verify` makes
/// one, and only a `VerifiedImage` can be handed to a board.
public struct VerifiedImage: Equatable, Sendable {
    /// The release's version text, `1.8.0+0`.
    public let release: String
    public let version: FirmwareVersion
    public let data: Data
    /// Lower-case hex.
    public let sha256: String
    public let header: MCUbootHeader

    init(release: String, version: FirmwareVersion, data: Data, sha256: String, header: MCUbootHeader) {
        self.release = release
        self.version = version
        self.data = data
        self.sha256 = sha256
        self.header = header
    }

    /// The first 8 bytes of the image's own SHA-256, from its TLV area, in lower-case hex: what the board
    /// keeps in its record of an update over Bluetooth, and shows in its status (`BoardStatus.lastHash`).
    /// Not the SHA-256 of the file. Nil when the TLV area cannot be read.
    public var imageHashPrefix: String? { ImageCheck.imageHash(data, header: header).map { String($0.prefix(16)) } }
}

public enum ImageCheck {
    /// Checks a downloaded image against its entry in the release list, in the contract's order:
    /// size, SHA-256, MCUboot's magic, and the version in the header against the release's. It
    /// also checks that the header's sizes fit in the file, which the board checks on the first
    /// piece of an upload too.
    public static func verify(_ data: Data, for release: FirmwareRelease) throws -> VerifiedImage {
        guard let releaseVersion = FirmwareVersion(release: release.version) else {
            throw ImageCheckError.unreadableReleaseVersion(release.version)
        }
        guard data.count == release.size else {
            throw ImageCheckError.wrongSize(expected: release.size, actual: data.count)
        }
        let digest = sha256Hex(data)
        guard digest == release.sha256.lowercased() else {
            throw ImageCheckError.wrongHash
        }
        guard let header = MCUbootHeader(data) else {
            throw ImageCheckError.notAnImage
        }
        guard header.version == releaseVersion else {
            throw ImageCheckError.wrongVersion(header: header.version, release: release.version)
        }
        let declared = UInt64(header.headerSize) + UInt64(header.protectedTLVSize) + UInt64(header.imageSize)
        guard declared <= UInt64(data.count) else {
            throw ImageCheckError.badSizes
        }
        return VerifiedImage(release: release.version, version: releaseVersion, data: data,
                             sha256: digest, header: header)
    }

    /// MCUboot's `IMAGE_TLV_SHA256` (type 0x10) in the TLV area after the protected one, as hex. Nil when
    /// the area is not there or has no such entry.
    public static func imageHash(_ data: Data, header: MCUbootHeader) -> String? {
        let bytes = [UInt8](data)
        func u16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }
        var at = Int(header.headerSize) + Int(header.imageSize) + Int(header.protectedTLVSize)
        guard at + 4 <= bytes.count, u16(at) == 0x6907 else { return nil }
        let end = min(bytes.count, at + u16(at + 2))
        at += 4
        while at + 4 <= end {
            let type = u16(at)
            let length = u16(at + 2)
            at += 4
            if type == 0x10, length == 32, at + 32 <= end {
                return bytes[at..<(at + 32)].map { String(format: "%02x", $0) }.joined()
            }
            at += length
        }
        return nil
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
