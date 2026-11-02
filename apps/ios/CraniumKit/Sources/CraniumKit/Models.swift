import Foundation

/// `GET /api/me`.
public struct Me: Decodable, Equatable, Sendable {
    public let email: String?
    public let groups: [String]
    /// True for a release manager, the only role that can download firmware.
    public let canWrite: Bool
    public let expiresAt: Double?

    public init(email: String?, groups: [String], canWrite: Bool, expiresAt: Double? = nil) {
        self.email = email
        self.groups = groups
        self.canWrite = canWrite
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey { case email, groups, canWrite, expiresAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        groups = try c.decodeIfPresent([String].self, forKey: .groups) ?? []
        canWrite = try c.decodeIfPresent(Bool.self, forKey: .canWrite) ?? false
        expiresAt = try? c.decodeIfPresent(Double.self, forKey: .expiresAt)
    }
}

/// One entry of `GET /api/firmware`.
public struct FirmwareRelease: Decodable, Equatable, Sendable, Identifiable {
    /// `1.8.0+0`. This text, URL-encoded, names the release in `/api/firmware/{version}/image`.
    public let version: String
    public let size: Int
    /// Lower-case hex SHA-256 of the whole file.
    public let sha256: String
    /// `active` or `revoked`. Only active releases are offered.
    public let status: String
    public let uploadedAt: String?
    public let notes: String?
    public let filename: String?

    public var id: String { version }
    public var isActive: Bool { status == "active" }
    public var parsedVersion: FirmwareVersion? { FirmwareVersion(release: version) }

    public init(version: String, size: Int, sha256: String, status: String = "active",
                uploadedAt: String? = nil, notes: String? = nil, filename: String? = nil) {
        self.version = version
        self.size = size
        self.sha256 = sha256
        self.status = status
        self.uploadedAt = uploadedAt
        self.notes = notes
        self.filename = filename
    }
}

/// `GET /api/firmware`: the releases, newest first, and the size of an image slot.
public struct FirmwareList: Decodable, Equatable, Sendable {
    public let releases: [FirmwareRelease]
    public let slotSize: Int?

    public init(releases: [FirmwareRelease], slotSize: Int? = nil) {
        self.releases = releases
        self.slotSize = slotSize
    }
}

/// `GET /api/pairing/{name}`: the passkey of the board advertising as `name`, while it pairs.
public struct Pairing: Decodable, Equatable, Sendable {
    /// The board's AWS IoT thing name, for `GET /api/devices/{thing}` afterwards.
    public let thing: String
    public let name: String
    /// Six digits, leading zeros kept.
    public let passkey: String
    public let reportedAt: String?

    public init(thing: String, name: String, passkey: String, reportedAt: String? = nil) {
        self.thing = thing
        self.name = name
        self.passkey = passkey
        self.reportedAt = reportedAt
    }
}

/// The part of `GET /api/devices/{thing}` the app shows after an update: is the board back, and
/// on which version.
public struct DeviceStatus: Decodable, Equatable, Sendable {
    public struct Firmware: Decodable, Equatable, Sendable {
        public let version: String
        public let confirmed: Bool
    }

    public let thing: String
    public let online: Bool
    public let lastSeen: String?
    public let fw: Firmware?

    public init(thing: String, online: Bool, lastSeen: String? = nil, fw: Firmware? = nil) {
        self.thing = thing
        self.online = online
        self.lastSeen = lastSeen
        self.fw = fw
    }
}
