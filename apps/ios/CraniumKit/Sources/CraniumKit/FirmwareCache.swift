import Foundation

/// Where the image that is sent came from.
public enum ImageOrigin: Equatable, Sendable {
    /// Already on the phone, and checked again.
    case phone
    /// Downloaded from the console just now, and checked.
    case downloaded
}

/// A checked image, and where it came from.
public struct ObtainedImage: Equatable, Sendable {
    public let image: VerifiedImage
    public let origin: ImageOrigin

    public init(image: VerifiedImage, origin: ImageOrigin) {
        self.image = image
        self.origin = origin
    }

    public var size: Int { image.data.count }

    /// True if this is still the image of `release`: same version, SHA-256 and size.
    public func isImage(of release: FirmwareRelease) -> Bool {
        image.release == release.version && image.sha256 == release.sha256.lowercased()
            && image.data.count == release.size
    }
}

/// What the phone holds: the keys (SHA-256) of the images, and their bytes in all.
public struct CacheSummary: Equatable, Sendable {
    public let keys: Set<String>
    public let bytes: Int

    public init(keys: Set<String>, bytes: Int) {
        self.keys = keys
        self.bytes = bytes
    }

    public static let empty = CacheSummary(keys: [], bytes: 0)

    public var count: Int { keys.count }

    public func holds(_ release: FirmwareRelease) -> Bool {
        FirmwareCachePolicy.key(for: release).map(keys.contains) ?? false
    }
}

/// Checked firmware images kept on the phone, as `<sha256>.bin` in one folder (docs/mobile-apps.md,
/// "Cache"). A cached image is checked again in full before every use; a download is kept only once
/// it has passed the same check, written to a temporary file and renamed into place. The rules are
/// in `FirmwareCachePolicy`; this does the files. Nothing here throws for a file it cannot write
/// or delete: the cache only saves a download.
public actor FirmwareCache {
    public nonisolated let directory: URL
    private let limit: Int
    private let now: @Sendable () -> Date
    /// Moves on with every `clear`, so that a download that was under way then is not kept.
    private var generation = 0

    public init(directory: URL, limit: Int = FirmwareCachePolicy.limit,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.limit = limit
        self.now = now
    }

    /// Application Support/firmware, which the app keeps out of the iCloud backup.
    public static func standard() -> FirmwareCache {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return FirmwareCache(directory: support.appendingPathComponent("firmware", isDirectory: true))
    }

    /// The image of `release`: from the phone if it holds one that passes the check, else from
    /// `download`, checked (`ImageCheckError` if it fails), and kept. `onDownload` is called just
    /// before the download starts.
    public func image(for release: FirmwareRelease,
                      onDownload: @Sendable () async -> Void = {},
                      download: @Sendable () async throws -> Data) async throws -> ObtainedImage {
        let key = FirmwareCachePolicy.key(for: release)
        let startedIn = generation
        if let key {
            let file = url(for: key)
            switch FirmwareCachePolicy.decide(cached: read(file, upTo: release.size + 1), for: release) {
            case .use(let image):
                touch(file)
                return ObtainedImage(image: image, origin: .phone)
            case .replace:
                try? FileManager.default.removeItem(at: file)
            case .download:
                break
            }
        }
        await onDownload()
        let data = try await download()
        let image = try ImageCheck.verify(data, for: release)
        if let key, startedIn == generation {
            store(data, key: key)
        }
        return ObtainedImage(image: image, origin: .downloaded)
    }

    /// Deletes what belongs to no active release in `releases` (the whole list), and any extra.
    @discardableResult
    public func prune(keepingActiveIn releases: [FirmwareRelease]) -> CacheSummary {
        for file in FirmwareCachePolicy.toRemove(files(), releases: releases) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file.name))
        }
        evict(protecting: nil)
        return summary()
    }

    /// Deletes everything, and keeps nothing from a download that is under way.
    public func clear() {
        generation += 1
        try? FileManager.default.removeItem(at: directory)
    }

    public func summary() -> CacheSummary {
        let images = files().filter { $0.key != nil }
        return CacheSummary(keys: Set(images.compactMap(\.key)), bytes: images.reduce(0) { $0 + $1.size })
    }

    /// Every file in the cache's folder, cached images and anything else.
    public func files() -> [CachedFile] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)
        else { return [] }
        return urls.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else {
                return nil
            }
            return CachedFile(name: url.lastPathComponent, size: values.fileSize ?? 0,
                              lastUsed: values.contentModificationDate ?? .distantPast)
        }
    }

    // MARK: -

    private func url(for key: String) -> URL {
        directory.appendingPathComponent(FirmwareCachePolicy.fileName(for: key), isDirectory: false)
    }

    /// At most `limit` bytes of `file`, or nil if there is no such file. An unreadable file reads
    /// as empty, which fails the size check and is replaced.
    private func read(_ file: URL, upTo limit: Int) -> Data? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        guard let handle = try? FileHandle(forReadingFrom: file) else { return Data() }
        defer { try? handle.close() }
        return (try? handle.read(upToCount: max(limit, 0))) ?? Data()
    }

    /// Makes `file` the last used.
    private func touch(_ file: URL) {
        try? FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: file.path)
    }

    /// Keeps a checked image: a temporary file in the same folder, then renamed over the final name.
    private func store(_ data: Data, key: String) {
        let manager = FileManager.default
        let temporary = directory.appendingPathComponent(".\(key).\(UUID().uuidString).tmp", isDirectory: false)
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
            try Self.excludeFromBackup(directory)
            try data.write(to: temporary, options: [.withoutOverwriting])
            let target = url(for: key)
            guard rename(temporary.path, target.path) == 0 else {
                try? manager.removeItem(at: temporary)
                return
            }
            try? Self.excludeFromBackup(target)
            touch(target)
            evict(protecting: key)
        } catch {
            // Not kept (a full disk, say). The image is still sent; the next update downloads it.
            try? manager.removeItem(at: temporary)
        }
    }

    /// The images can be downloaded again, and a signed-out phone keeps nothing: no iCloud backup.
    static func excludeFromBackup(_ url: URL) throws {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func evict(protecting key: String?) {
        for file in FirmwareCachePolicy.toEvict(files(), limit: limit, protecting: key) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file.name))
        }
    }
}
