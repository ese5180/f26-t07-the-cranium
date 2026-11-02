import Foundation
import Testing
@testable import CraniumKit

private func hex(_ c: Character) -> String { String(repeating: c, count: 64) }

private func file(_ key: String, _ lastUsed: TimeInterval, size: Int = 100) -> CachedFile {
    CachedFile(name: key + ".bin", size: size, lastUsed: Date(timeIntervalSince1970: lastUsed))
}

@Suite struct FirmwareCachePolicyTests {
    let data = makeImage(version: FirmwareVersion(release: "1.8.0+0")!)
    var entry: FirmwareRelease { release(for: data, version: "1.8.0+0") }
    var key: String { entry.sha256 }

    // MARK: Keys and names

    @Test func anImageIsKeptUnderItsReleasesSHA256InLowerCase() {
        #expect(FirmwareCachePolicy.key(for: entry) == key)
        let upper = FirmwareRelease(version: "1.8.0+0", size: data.count, sha256: key.uppercased())
        #expect(FirmwareCachePolicy.key(for: upper) == key)
        #expect(FirmwareCachePolicy.fileName(for: key) == key + ".bin")
        #expect(FirmwareCachePolicy.key(fileName: key + ".bin") == key)
    }

    @Test func aSHA256ThatIsNot64HexDigitsNamesNoFile() {
        for bad in ["", "00", "../../Library/x", hex("g"), String(repeating: "a", count: 63),
                    String(repeating: "a", count: 65), String(repeating: "a", count: 62) + "/x"] {
            let other = FirmwareRelease(version: "1.8.0+0", size: 1, sha256: bad)
            #expect(FirmwareCachePolicy.key(for: other) == nil, "\(bad)")
        }
    }

    @Test func onlyAKeyAndBinIsACachedImage() {
        for name in [".\(key).1.tmp", key + ".bin.tmp", key + ".BIN", key.uppercased() + ".bin", "notes.txt", key] {
            #expect(FirmwareCachePolicy.key(fileName: name) == nil, "\(name)")
        }
    }

    // MARK: What to do with what the phone holds

    @Test func nothingOnThePhoneMeansADownload() {
        #expect(FirmwareCachePolicy.decide(cached: nil, for: entry) == .download)
    }

    @Test func anImageThatPassesTheWholeCheckIsUsed() throws {
        let decision = FirmwareCachePolicy.decide(cached: data, for: entry)
        #expect(decision == .use(try ImageCheck.verify(data, for: entry)))
    }

    @Test func anImageThatFailsAnyPartOfTheCheckIsReplaced() {
        #expect(FirmwareCachePolicy.decide(cached: data.prefix(data.count - 1), for: entry)
                == .replace(.wrongSize(expected: data.count, actual: data.count - 1)))
        #expect(FirmwareCachePolicy.decide(cached: Data(), for: entry)
                == .replace(.wrongSize(expected: data.count, actual: 0)))
        var flipped = data
        flipped[100] &+= 1
        #expect(FirmwareCachePolicy.decide(cached: flipped, for: entry) == .replace(.wrongHash))
        // The same bytes listed as another release: right hash, wrong header version.
        let other = FirmwareRelease(version: "1.8.1+0", size: data.count, sha256: key)
        #expect(FirmwareCachePolicy.decide(cached: data, for: other)
                == .replace(.wrongVersion(header: FirmwareVersion(release: "1.8.0+0")!, release: "1.8.1+0")))
        let noMagic = makeImage(version: FirmwareVersion(release: "1.8.0+0")!, magic: 0)
        #expect(FirmwareCachePolicy.decide(cached: noMagic, for: release(for: noMagic, version: "1.8.0+0"))
                == .replace(.notAnImage))
    }

    // MARK: At most five, oldest by last use first

    @Test func fiveOrFewerAreAllKept() {
        let files = Array("abcde").enumerated().map { file(hex($1), TimeInterval($0)) }
        #expect(FirmwareCachePolicy.toEvict(files).isEmpty)
        #expect(FirmwareCachePolicy.toEvict([]).isEmpty)
    }

    @Test func beyondFiveTheLeastRecentlyUsedGoOldestFirst() {
        let files = [file(hex("a"), 5), file(hex("b"), 1), file(hex("c"), 7), file(hex("d"), 3),
                     file(hex("e"), 6), file(hex("f"), 2), file(hex("0"), 4)]
        #expect(FirmwareCachePolicy.toEvict(files).map(\.key) == [hex("b"), hex("f")])
        #expect(FirmwareCachePolicy.toEvict(files, limit: 2).map(\.key)
                == [hex("b"), hex("f"), hex("d"), hex("0"), hex("a")])
    }

    @Test func theImageJustStoredOrUsedStaysWhateverItsTimeSays() {
        // A clock that went back: the new one looks oldest.
        let files = Array("012345").enumerated().map { file(hex($1), 100 - TimeInterval($0)) }
        #expect(FirmwareCachePolicy.toEvict(files, protecting: hex("5")).map(\.key) == [hex("4")])
    }

    @Test func filesThatAreNotCachedImagesAreNotCountedAgainstTheFive() {
        let files = Array("abcde").enumerated().map { file(hex($1), TimeInterval($0)) }
            + [CachedFile(name: ".\(key).1.tmp", size: 1, lastUsed: .distantPast),
               CachedFile(name: "other", size: 1, lastUsed: .distantPast)]
        #expect(FirmwareCachePolicy.toEvict(files).isEmpty)
    }

    // MARK: Revoked releases

    @Test func anImageWhoseReleaseIsRevokedOrGoneIsRemovedWhenTheListLoads() {
        let otherData = makeImage(version: FirmwareVersion(release: "1.9.0+0")!)
        let revoked = release(for: otherData, version: "1.9.0+0", status: "revoked")
        let files = [file(key, 1), file(revoked.sha256, 2), file(hex("9"), 3)]
        let removed = FirmwareCachePolicy.toRemove(files, releases: [entry, revoked])
        #expect(Set(removed.compactMap(\.key)) == [revoked.sha256, hex("9")])
    }

    @Test func anActiveReleasesImageStaysWhateverTheCaseOfItsSHA256() {
        let upper = FirmwareRelease(version: "1.8.0+0", size: data.count, sha256: key.uppercased())
        #expect(FirmwareCachePolicy.toRemove([file(key, 1)], releases: [upper]).isEmpty)
    }

    @Test func withNoActiveReleaseNothingStaysAndStrayFilesGoToo() {
        let files = [file(key, 1), CachedFile(name: ".\(key).1.tmp", size: 1, lastUsed: .distantPast),
                     CachedFile(name: "notes.txt", size: 1, lastUsed: .distantPast)]
        #expect(FirmwareCachePolicy.toRemove(files, releases: []) == files)
        #expect(FirmwareCachePolicy.toRemove(files, releases: [entry]).map(\.name) == [".\(key).1.tmp", "notes.txt"])
    }

    // MARK: What the person reads

    @Test func whereTheImageCameFromAndItsSize() throws {
        let image = try ImageCheck.verify(data, for: entry)
        #expect(UserMessage.origin(of: ObtainedImage(image: image, origin: .phone)).hasPrefix("Already on this phone (0 KB)"))
        #expect(UserMessage.origin(of: ObtainedImage(image: image, origin: .downloaded)).hasPrefix("Downloaded from the console"))
        #expect(UserMessage.kilobytes(412 * 1024 + 100) == "412 KB")
        #expect(UserMessage.kilobytes(1536) == "2 KB")
        #expect(UserMessage.firmwareOnPhone(.empty) == "No firmware kept on this phone")
        #expect(UserMessage.firmwareOnPhone(CacheSummary(keys: [hex("a"), hex("b")], bytes: 2048))
                == "2 firmware images on this phone, 2 KB")
    }
}

// MARK: - The cache on real files

/// A clock the test moves.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

/// Counts downloads.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}

@Suite struct FirmwareCacheTests {
    private let clock = TestClock()
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("cranium-firmware-\(UUID().uuidString)", isDirectory: true)
    var cache: FirmwareCache { FirmwareCache(directory: dir, now: { [clock] in clock.now }) }

    func image(_ minor: Int) -> Data { makeImage(version: FirmwareVersion(release: "1.\(minor).0+0")!) }
    func listed(_ data: Data, minor: Int, status: String = "active") -> FirmwareRelease {
        release(for: data, version: "1.\(minor).0+0", status: status)
    }
    func fileOf(_ entry: FirmwareRelease) -> URL { dir.appendingPathComponent(entry.sha256 + ".bin") }
    func names() -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted() }
    func cleanUp() { try? FileManager.default.removeItem(at: dir) }

    @Test func nothingOnThePhoneDownloadsChecksAndKeepsItUnderItsSHA256() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        let entry = listed(data, minor: 8)
        let downloads = Counter()
        let started = Counter()

        let result = try await cache.image(for: entry, onDownload: { started.add() }) {
            downloads.add()
            return data
        }

        #expect(downloads.value == 1 && started.value == 1)
        #expect(result.origin == .downloaded && result.image.data == data && result.size == data.count)
        #expect(try Data(contentsOf: fileOf(entry)) == data)
        #expect(names() == [entry.sha256 + ".bin"])
        #expect(await cache.summary() == CacheSummary(keys: [entry.sha256], bytes: data.count))
        #expect(await cache.summary().holds(entry))
    }

    @Test func onThePhoneAndPassingTheCheckItIsUsedWithNoDownload() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        let entry = listed(data, minor: 8)
        _ = try await cache.image(for: entry) { data }
        clock.advance(60)

        let downloads = Counter()
        let started = Counter()
        let result = try await cache.image(for: entry, onDownload: { started.add() }) {
            downloads.add()
            return Data()
        }

        #expect(downloads.value == 0 && started.value == 0)
        #expect(result.origin == .phone && result.image.data == data)
        let lastUsed = try #require(await cache.files().first?.lastUsed)
        #expect(abs(lastUsed.timeIntervalSince(clock.now)) < 0.01, "using it makes it the last used")
    }

    @Test func onThePhoneButChangedItIsDeletedDownloadedAgainAndReplaced() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        let entry = listed(data, minor: 8)
        _ = try await cache.image(for: entry) { data }
        var changed = data
        changed[100] &+= 1  // Same size: only the SHA-256 tells.
        try changed.write(to: fileOf(entry))

        let downloads = Counter()
        let result = try await cache.image(for: entry) {
            downloads.add()
            return data
        }

        #expect(downloads.value == 1 && result.origin == .downloaded)
        #expect(try Data(contentsOf: fileOf(entry)) == data)
    }

    @Test func onThePhoneButCutShortOrTooLongItIsReplaced() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        let entry = listed(data, minor: 8)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for bad in [data.prefix(10), data + Data(count: 5000), Data()] {
            try Data(bad).write(to: fileOf(entry))
            let downloads = Counter()
            let result = try await cache.image(for: entry) {
                downloads.add()
                return data
            }
            #expect(downloads.value == 1 && result.origin == .downloaded)
            #expect(try Data(contentsOf: fileOf(entry)) == data)
        }
    }

    @Test func aDownloadThatFailsTheCheckIsNotKeptAndNotSent() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let entry = listed(image(8), minor: 8)
        let wrong = image(9)
        await #expect(throws: ImageCheckError.wrongHash) {
            try await cache.image(for: entry) { wrong }
        }
        #expect(names().isEmpty)
        #expect(await cache.summary() == .empty)
    }

    @Test func aDownloadThatThrowsKeepsNothing() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let entry = listed(image(8), minor: 8)
        await #expect(throws: URLError.self) {
            try await cache.image(for: entry) { throw URLError(.notConnectedToInternet) }
        }
        #expect(await cache.summary() == .empty)
    }

    @Test func noTemporaryFileIsLeftAndTheFolderIsOutOfTheBackup() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        _ = try await cache.image(for: listed(data, minor: 8)) { data }
        #expect(await cache.files().allSatisfy { $0.key != nil })
        let values = try dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }

    @Test func atMostFiveAreKeptAndTheLeastRecentlyUsedGoes() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let images = (1...6).map(image)
        let entries = images.enumerated().map { listed($1, minor: $0 + 1) }
        for i in 0..<5 {
            let data = images[i]
            _ = try await cache.image(for: entries[i]) { data }
            clock.advance(1)
        }
        // Use the first again: now the second is the least recently used.
        #expect(try await cache.image(for: entries[0]) { Data() }.origin == .phone)
        clock.advance(1)

        let last = images[5]
        _ = try await cache.image(for: entries[5]) { last }

        #expect(await cache.summary().count == 5)
        #expect(!FileManager.default.fileExists(atPath: fileOf(entries[1]).path))
        for i in [0, 2, 3, 4, 5] {
            #expect(FileManager.default.fileExists(atPath: fileOf(entries[i]).path), "\(entries[i].version)")
        }
    }

    @Test func loadingTheListRemovesRevokedAndVanishedReleasesAndStrayFiles() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let images = (1...3).map(image)
        let entries = images.enumerated().map { listed($1, minor: $0 + 1) }
        for (data, entry) in zip(images, entries) {
            _ = try await cache.image(for: entry) { data }
        }
        try Data([1, 2, 3]).write(to: dir.appendingPathComponent(".\(entries[0].sha256).1.tmp"))

        // 1.1.0 stays active, 1.2.0 is revoked, 1.3.0 is gone from the list.
        let revoked = FirmwareRelease(version: entries[1].version, size: entries[1].size,
                                      sha256: entries[1].sha256, status: "revoked")
        let summary = await cache.prune(keepingActiveIn: [entries[0], revoked])

        #expect(names() == [entries[0].sha256 + ".bin"])
        #expect(summary == CacheSummary(keys: [entries[0].sha256], bytes: images[0].count))
    }

    @Test func clearRemovesEverything() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        _ = try await cache.image(for: listed(data, minor: 8)) { data }
        await cache.clear()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
        #expect(await cache.summary() == .empty)
    }

    @Test func aDownloadUnderWayWhenTheCacheIsClearedIsSentButNotKept() async throws {
        defer { cleanUp() }
        let cache = self.cache
        let data = image(8)
        let entry = listed(data, minor: 8)
        // Sign-out, or "Clear downloaded firmware", during the download.
        let result = try await cache.image(for: entry, onDownload: { await cache.clear() }) { data }
        #expect(result.origin == .downloaded)
        #expect(!FileManager.default.fileExists(atPath: fileOf(entry).path))
    }

    @Test func anImageHeldInMemoryIsOnlyForTheSameRelease() async throws {
        defer { cleanUp() }
        let data = image(8)
        let entry = listed(data, minor: 8)
        let held = ObtainedImage(image: try ImageCheck.verify(data, for: entry), origin: .downloaded)
        #expect(held.isImage(of: entry))
        #expect(!held.isImage(of: FirmwareRelease(version: entry.version, size: entry.size, sha256: hex("0"))))
        #expect(!held.isImage(of: FirmwareRelease(version: "1.8.0+1", size: entry.size, sha256: entry.sha256)))
    }
}
