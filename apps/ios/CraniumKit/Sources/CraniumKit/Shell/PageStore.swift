import CryptoKit
import Foundation

/// What the pages keep on the phone through the bridge (apps/shared/bridge.json, storage.*), such as the
/// customer site's journal of sessions and its choices (Explore demo or My journal, the date range).
///
/// The shell's web view keeps nothing on disk between runs (`WKWebsiteDataStore.nonPersistent()`), so a page's
/// own localStorage is gone at the next start of the app. What a page means to keep comes here instead: one
/// file per key, named by the SHA-256 of the key (a key is never a path), in a folder of the app's own that is
/// not backed up, so it stays on this phone. The limits are the contract's: a value of at most
/// `maxValueBytes` bytes of UTF-8, `maxItems` keys and `maxTotalBytes` bytes in all; past them the call fails
/// and nothing is changed. Safe to use from any thread.
public final class PageStore: @unchecked Sendable {
    public static let maxValueBytes = 3_000_000
    public static let maxItems = 64
    public static let maxTotalBytes = 12_000_000

    private let folder: URL
    private let lock = NSLock()

    public init(folder: URL) {
        self.folder = folder
    }

    /// The app's own: Application Support/PageStore, left out of backups.
    public static func standard() -> PageStore {
        let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil,
                                                    create: true)) ?? FileManager.default.temporaryDirectory
        return PageStore(folder: support.appendingPathComponent("PageStore", isDirectory: true))
    }

    public func get(_ key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = try? Data(contentsOf: file(key)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(_ key: String, _ value: String) throws {
        let data = Data(value.utf8)
        guard data.count <= Self.maxValueBytes else {
            throw BridgeError.failed("The app keeps at most 3 MB for one item of the pages.")
        }
        lock.lock()
        defer { lock.unlock() }
        try prepare()
        let target = file(key)
        let kept = items()
        let others = kept.filter { $0.url.lastPathComponent != target.lastPathComponent }
        guard others.count < Self.maxItems else {
            throw BridgeError.failed("The app keeps at most \(Self.maxItems) items of the pages.")
        }
        guard others.reduce(0, { $0 + $1.size }) + data.count <= Self.maxTotalBytes else {
            throw BridgeError.failed("The app keeps at most 12 MB of the pages' items.")
        }
        do {
            #if os(iOS)
            try data.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: target, options: [.atomic])
            #endif
        } catch {
            throw BridgeError.failed("The app could not keep it: \(error.localizedDescription)")
        }
    }

    public func remove(_ key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let target = file(key)
        guard FileManager.default.fileExists(atPath: target.path) else { return }
        do {
            try FileManager.default.removeItem(at: target)
        } catch {
            throw BridgeError.failed("The app could not forget it: \(error.localizedDescription)")
        }
    }

    // MARK: Files

    func file(_ key: String) -> URL {
        let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return folder.appendingPathComponent(name, isDirectory: false)
    }

    private func items() -> [(url: URL, size: Int)] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return urls.compactMap { url in
            guard url.lastPathComponent.count == 64 else { return nil }
            return (url, (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
    }

    private func prepare() throws {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var url = folder
            try url.setResourceValues(values)
        } catch {
            throw BridgeError.failed("The app could not keep it: \(error.localizedDescription)")
        }
    }
}
