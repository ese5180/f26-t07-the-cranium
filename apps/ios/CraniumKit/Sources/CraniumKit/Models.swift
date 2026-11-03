import Foundation

/// `GET /api/me`.
public struct Me: Decodable, Equatable, Sendable {
    /// The account id: what the activity log files this person's actions under.
    public let sub: String
    public let email: String?
    public let groups: [String]
    /// True for a release manager: the role that can upload, deploy, revoke and download firmware.
    public let canWrite: Bool
    /// When the session's access token ends, in epoch seconds.
    public let expiresAt: Double?

    public init(sub: String = "", email: String?, groups: [String], canWrite: Bool, expiresAt: Double? = nil) {
        self.sub = sub
        self.email = email
        self.groups = groups
        self.canWrite = canWrite
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey { case sub, email, groups, canWrite, expiresAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sub = c.text(.sub, limit: 128)
        email = c.optionalText(.email, limit: 320)
        groups = c.texts(.groups)
        canWrite = c.bool(.canWrite)
        expiresAt = c.lenient(Double.self, .expiresAt)
    }

    /// "Release manager" or "Viewer", as the website's account box says it.
    public var role: String { canWrite ? "Release manager" : "Viewer" }
}

/// Who did something: the account id, and the address it showed at the time.
public struct Person: Decodable, Equatable, Hashable, Sendable {
    public let sub: String
    public let email: String

    public init(sub: String, email: String) {
        self.sub = sub
        self.email = email
    }

    private enum CodingKeys: String, CodingKey { case sub, email }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sub = c.text(.sub, limit: 128)
        email = c.text(.email, limit: 320)
    }
}

/// The revocation of a release: who, when, why, and when the steps after the mark were done.
public struct Revocation: Decodable, Equatable, Sendable {
    public let by: Person?
    public let at: String?
    public let reason: String
    /// When the server finished what follows the mark: the image refused, the open deployments
    /// cancelled. Nil until then.
    public let enforcedAt: String?
    /// False for a server that keeps no record of `enforcedAt` at all.
    public let recordsEnforcement: Bool

    public init(by: Person?, at: String?, reason: String, enforcedAt: String?, recordsEnforcement: Bool = true) {
        self.by = by
        self.at = at
        self.reason = reason
        self.enforcedAt = enforcedAt
        self.recordsEnforcement = recordsEnforcement
    }

    private enum CodingKeys: String, CodingKey { case by, at, reason, enforcedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        by = c.lenient(Person.self, .by)
        at = c.instant(.at)
        reason = c.text(.reason)
        recordsEnforcement = c.contains(.enforcedAt)
        enforcedAt = c.instant(.enforcedAt)
    }
}

/// One entry of `GET /api/firmware`.
public struct FirmwareRelease: Decodable, Equatable, Sendable, Identifiable {
    /// `1.8.0+0`. This text, URL-encoded, names the release in `/api/firmware/{version}/…`.
    public let version: String
    public let size: Int
    /// Lower-case hex SHA-256 of the whole file.
    public let sha256: String
    /// `active` or `revoked`. Only active releases are offered.
    public let status: String
    public let uploadedAt: String?
    public let notes: String?
    public let filename: String?
    /// What the signature covers and the bootloader verifies.
    public let imageHash: String
    /// The fingerprint of the key that signed it.
    public let keyHash: String
    public let payloadSize: Int?
    public let headerSize: Int?
    public let loadAddress: Int?
    public let uploadedBy: Person?
    public let revoked: Revocation?

    public var id: String { version }
    public var isActive: Bool { status == "active" }
    public var parsedVersion: FirmwareVersion? { FirmwareVersion(release: version) }

    public init(version: String, size: Int, sha256: String, status: String = "active",
                uploadedAt: String? = nil, notes: String? = nil, filename: String? = nil,
                imageHash: String = "", keyHash: String = "", payloadSize: Int? = nil, headerSize: Int? = nil,
                loadAddress: Int? = nil, uploadedBy: Person? = nil, revoked: Revocation? = nil) {
        self.version = version
        self.size = size
        self.sha256 = sha256
        self.status = status
        self.uploadedAt = uploadedAt
        self.notes = notes
        self.filename = filename
        self.imageHash = imageHash
        self.keyHash = keyHash
        self.payloadSize = payloadSize
        self.headerSize = headerSize
        self.loadAddress = loadAddress
        self.uploadedBy = uploadedBy
        self.revoked = revoked
    }

    private enum CodingKeys: String, CodingKey {
        case version, size, sha256, status, uploadedAt, notes, filename, imageHash, keyHash, payloadSize, headerSize,
             loadAddress, uploadedBy, revoked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.text(.version, limit: 32)
        size = c.whole(.size, 0, 1 << 32) ?? 0
        sha256 = c.text(.sha256, limit: 64)
        status = c.lenient(String.self, .status) == "active" ? "active" : "revoked"
        uploadedAt = c.instant(.uploadedAt)
        notes = c.optionalText(.notes, limit: 500)
        filename = c.optionalText(.filename, limit: 64)
        imageHash = c.text(.imageHash, limit: 64)
        keyHash = c.text(.keyHash, limit: 64)
        payloadSize = c.whole(.payloadSize, 0, 1 << 32)
        headerSize = c.whole(.headerSize, 0, 0xFFFF)
        loadAddress = c.whole(.loadAddress, 0, 1 << 32)
        uploadedBy = c.lenient(Person.self, .uploadedBy)
        revoked = c.lenient(Revocation.self, .revoked)
    }
}

/// `GET /api/firmware`: every release, active and revoked, newest first, the size of a board's
/// update slot, and the fingerprint of the project's signing key.
public struct FirmwareList: Decodable, Equatable, Sendable {
    public let releases: [FirmwareRelease]
    public let slotSize: Int?
    public let fingerprint: String

    public init(releases: [FirmwareRelease], slotSize: Int? = nil, fingerprint: String = "") {
        self.releases = releases
        self.slotSize = slotSize
        self.fingerprint = fingerprint
    }

    private enum CodingKeys: String, CodingKey { case releases, slotSize, signingKey }
    private enum KeyKeys: String, CodingKey { case fingerprint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        releases = try c.decode(LenientList<FirmwareRelease>.self, forKey: .releases).items.filter { !$0.version.isEmpty }
        slotSize = c.whole(.slotSize, 1, 1 << 32)
        let key = try? c.nestedContainer(keyedBy: KeyKeys.self, forKey: .signingKey)
        fingerprint = key?.text(.fingerprint, limit: 64) ?? ""
    }

    /// The newest release that can be deployed.
    public var newestActive: FirmwareRelease? { releases.first(where: \.isActive) }
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

/// The part of `GET /api/devices/{thing}` the Bluetooth flow shows after an update: is the board
/// back, and on which version.
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
