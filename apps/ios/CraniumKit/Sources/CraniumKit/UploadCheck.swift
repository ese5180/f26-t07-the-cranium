import Foundation

/// What the app reads from a chosen file before it is uploaded, as the website does (core.js,
/// "Firmware images, as far as the browser looks at them"). This is a preview, so that a wrong file
/// is noticed before it is sent: the server checks the signature, and decides.
public struct ImagePreview: Equatable, Sendable {
    public let ok: Bool
    /// Why it cannot be an image, when it cannot.
    public let message: String
    public let headerSize: Int
    public let payloadSize: Int
    /// `1.8.0+0`, from the header.
    public let version: String

    /// Reads MCUboot's fixed header: magic at 0, header size at 8, payload size at 12, version at 20.
    public init(_ data: Data) {
        let bytes = [UInt8](data.prefix(32))
        guard bytes.count == 32 else {
            self.init(failed: "The file is too small to be a firmware image.")
            return
        }
        func u16(_ at: Int) -> Int { Int(bytes[at]) | Int(bytes[at + 1]) << 8 }
        func u32(_ at: Int) -> UInt32 {
            UInt32(bytes[at]) | UInt32(bytes[at + 1]) << 8 | UInt32(bytes[at + 2]) << 16 | UInt32(bytes[at + 3]) << 24
        }
        guard u32(0) == MCUbootHeader.magic else {
            self.init(failed: "This is not an MCUboot image. Choose the *.signed.bin file from the build.")
            return
        }
        self.init(ok: true, message: "", headerSize: u16(8), payloadSize: Int(u32(12)),
                  version: FirmwareVersion(major: bytes[20], minor: bytes[21], revision: UInt16(u16(22)),
                                           build: u32(24)).description)
    }

    private init(failed message: String) {
        self.init(ok: false, message: message, headerSize: 0, payloadSize: 0, version: "")
    }

    private init(ok: Bool, message: String, headerSize: Int, payloadSize: Int, version: String) {
        self.ok = ok
        self.message = message
        self.headerSize = headerSize
        self.payloadSize = payloadSize
        self.version = version
    }
}

/// A note about a chosen file, with its tone: good, warn or bad.
public struct ReviewNote: Equatable, Sendable, Hashable {
    public let tone: Tone
    public let text: String

    public init(_ tone: Tone, _ text: String) {
        self.tone = tone
        self.text = text
    }
}

/// What can be said about a chosen file before it is uploaded. `blocked`: it cannot be firmware for
/// the board. `doomed`: the server is certain to refuse it because of what is registered already,
/// which only ever grows, so the way on is another file.
public struct ImageReview: Equatable, Sendable {
    public let blocked: Bool
    public let doomed: Bool
    public let notes: [ReviewNote]
}

public enum UploadCheck {
    /// What the server checks before it stores an image, in its order. It answers 201 only when all
    /// of them passed, and otherwise names the first that did not, by its code.
    public struct Check: Sendable {
        public let name: String
        public let passed: String
        public let passedFirst: String?
        public let codes: [String]
    }

    public static let checks: [Check] = [
        Check(name: "Image format", passed: "It is an MCUboot image, and it fits the board’s update slot.", passedFirst: nil,
              codes: ["not_an_image", "too_small", "too_large", "bad_magic", "bad_header", "truncated"]),
        Check(name: "Flash layout", passed: "It was built for this product’s flash layout.", passedFirst: nil,
              codes: ["unsupported_flags", "wrong_target"]),
        Check(name: "Signature area", passed: "Its signature area is well formed, with nothing after it.", passedFirst: nil,
              codes: ["malformed_tlv", "unexpected_tlv", "trailing_data", "unsigned"]),
        Check(name: "Image hash", passed: "The image matches its own SHA-256 hash, so the file is not damaged.",
              passedFirst: nil, codes: ["hash_mismatch"]),
        Check(name: "Signing key", passed: "It is signed with this project’s key.", passedFirst: nil, codes: ["wrong_key"]),
        Check(name: "Signature", passed: "Its ECDSA P-256 signature is valid.", passedFirst: nil,
              codes: ["bad_signature", "bad_signature_encoding"]),
        Check(name: "Version", passed: "Its version is newer than every release before it.",
              passedFirst: "Its version has a number, and no release came before it.",
              codes: ["version_zero", "version_exists", "version_not_newer"]),
    ]

    /// The name of the check that an image failed, from the code of the server's refusal.
    public static func failedCheck(_ code: String) -> String? {
        checks.first { $0.codes.contains(code) }?.name
    }

    /// Said of the signature before the server has looked at it.
    public static let signatureUnchecked = ReviewNote(.wait, "Signature: not checked yet. The server checks it against the project key when you upload.")

    /// Whether sending the same file once more could end differently. A refusal of the image
    /// cannot; being throttled, or meeting another upload at the same moment, can.
    public static func canRetry(_ error: Error) -> Bool {
        guard let error = error as? APIError else { return true }
        return !error.isRefusal || error.status == 429 || error.code == "upload_conflict"
    }

    public static func review(_ header: ImagePreview, size: Int, digest: String, firmware: FirmwareList?) -> ImageReview {
        guard header.ok else { return ImageReview(blocked: true, doomed: false, notes: [ReviewNote(.bad, header.message)]) }
        var notes: [ReviewNote] = []
        var blocked = false
        if let slot = firmware?.slotSize {
            if size > slot {
                blocked = true
                notes.append(ReviewNote(.bad, "Too large: the board’s slot holds \(Words.exactBytes(slot))."))
            } else {
                notes.append(ReviewNote(.good, "Fits the board’s \(Words.fileSize(slot)) slot."))
            }
        }
        if header.version == "0.0.0+0" {
            notes.append(ReviewNote(.warn, "Version 0.0.0+0 is never accepted. Give the build a version first."))
            return ImageReview(blocked: blocked, doomed: true, notes: notes)
        }
        // Nothing is said about other releases until the list of them has arrived.
        guard let firmware, let version = FirmwareVersion(release: header.version) else {
            return ImageReview(blocked: blocked, doomed: false, notes: notes)
        }
        let same = firmware.releases.first { $0.sha256 == digest }
        let taken = firmware.releases.first { $0.version == header.version }
        let highest = firmware.releases.compactMap(\.parsedVersion).max()
        let notNewer = highest.map { version <= $0 } ?? false
        if let same {
            notes.append(ReviewNote(.warn, "This exact file is already registered as \(same.version)."))
        } else if let taken {
            notes.append(ReviewNote(.warn, "\(taken.version) is already registered with different contents. A version can be used once."))
        } else if let highest, notNewer {
            notes.append(ReviewNote(.warn, "Not newer than \(highest), the highest version registered so far. The server will refuse it."))
        } else if let highest {
            notes.append(ReviewNote(.good, "Newer than every registered release (highest so far: \(highest))."))
        } else {
            notes.append(ReviewNote(.good, "This will be the first release."))
        }
        return ImageReview(blocked: blocked, doomed: same != nil || taken != nil || notNewer, notes: notes)
    }

    /// The name recorded for an upload: the file's name in the characters the API accepts.
    public static func recordedFilename(_ name: String) -> String {
        let cleaned = String(name.unicodeScalars.map { scalar -> Character in
            let allowed = ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
                || scalar == "." || scalar == "_" || scalar == "-"
            return allowed ? Character(scalar) : "_"
        })
        let tail = String(cleaned.suffix(64))
        return tail.isEmpty ? "image.signed.bin" : tail
    }

    /// Free text as the API takes it: on one line, without control characters. A line break or
    /// another control character becomes a space; characters that cannot be seen are left out.
    public static func singleLine(_ text: String) -> String {
        var out = ""
        var lastWasSpace = false
        for scalar in text.unicodeScalars {
            let value = scalar.value
            if value < 0x20 || (0x7F...0x9F).contains(value) || value == 0x2028 || value == 0x2029 {
                if !lastWasSpace { out.unicodeScalars.append(" ") }
                lastWasSpace = true
                continue
            }
            switch scalar.properties.generalCategory {
            case .format, .privateUse, .surrogate, .unassigned, .control:
                continue
            default:
                out.unicodeScalars.append(scalar)
                lastWasSpace = false
            }
        }
        return out.trimmingCharacters(in: .whitespaces)
    }
}
