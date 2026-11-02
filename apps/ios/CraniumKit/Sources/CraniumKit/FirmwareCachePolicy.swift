import Foundation

/// A file in the firmware cache: its name, size, and when it was last used.
public struct CachedFile: Equatable, Sendable {
    public let name: String
    public let size: Int
    public let lastUsed: Date

    public init(name: String, size: Int, lastUsed: Date) {
        self.name = name
        self.size = size
        self.lastUsed = lastUsed
    }

    /// The SHA-256 it is kept under, or nil for a file that is not a cached image.
    public var key: String? { FirmwareCachePolicy.key(fileName: name) }
}

/// What to do with what the phone holds for a release.
public enum CacheDecision: Equatable, Sendable {
    /// Nothing on the phone for it: download.
    case download
    /// What the phone holds passed every check against the release: send it, with no download.
    case use(VerifiedImage)
    /// What the phone holds fails a check: delete it, then download.
    case replace(ImageCheckError)
}

/// The rules of the firmware cache (docs/mobile-apps.md, "Cache"), apart from the files: images
/// are kept under their release's SHA-256, checked again in full before each use, at most
/// `limit` of them, and only for active releases.
public enum FirmwareCachePolicy {
    public static let limit = 5

    /// The name the image of `release` is kept under, or nil if its SHA-256 is not 64 hex digits.
    public static func key(for release: FirmwareRelease) -> String? {
        let text = release.sha256.trimmingCharacters(in: .whitespaces).lowercased()
        return isKey(text) ? text : nil
    }

    public static func fileName(for key: String) -> String { key + ".bin" }

    /// The key of a cached image's file name, or nil for anything else (a temporary file).
    public static func key(fileName: String) -> String? {
        guard fileName.hasSuffix(".bin") else { return nil }
        let key = String(fileName.dropLast(4))
        return isKey(key) ? key : nil
    }

    /// `cached` is what the phone holds under the release's key, or nil if nothing.
    public static func decide(cached: Data?, for release: FirmwareRelease) -> CacheDecision {
        guard let cached else { return .download }
        do {
            return .use(try ImageCheck.verify(cached, for: release))
        } catch let error as ImageCheckError {
            return .replace(error)
        } catch {
            return .replace(.notAnImage)
        }
    }

    /// The images to delete so that at most `limit` stay, oldest by last use first. `protecting`,
    /// the one just stored or used, stays whatever its time says.
    public static func toEvict(_ files: [CachedFile], limit: Int = FirmwareCachePolicy.limit,
                               protecting: String? = nil) -> [CachedFile] {
        let images = files.filter { $0.key != nil }
        let newestFirst = images.sorted { a, b in
            let aKept = protecting != nil && a.key == protecting
            let bKept = protecting != nil && b.key == protecting
            if aKept != bKept { return aKept }
            if a.lastUsed != b.lastUsed { return a.lastUsed > b.lastUsed }
            return a.name < b.name
        }
        return Array(newestFirst.dropFirst(max(limit, 0)).reversed())
    }

    /// The files to delete once the release list is in: any whose release is no longer active
    /// (revoked, or gone from the list), and anything that is not a cached image.
    public static func toRemove(_ files: [CachedFile], releases: [FirmwareRelease]) -> [CachedFile] {
        let keep = Set(releases.filter(\.isActive).compactMap { key(for: $0) })
        return files.filter { file in
            guard let key = file.key else { return true }
            return !keep.contains(key)
        }
    }

    private static func isKey(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }
}
