import Foundation
import Testing
@testable import CraniumKit

/// What the pages keep through storage.* (PageStore): the customer site's journal, which the shell's web view
/// would forget at the app's next start, and the contract's limits.
@Suite struct PageStoreTests {
    static let key = "cranium.mixes.journal.v1:person@example.invalid"

    func folder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("cranium-pages-\(UUID().uuidString)", isDirectory: true)
    }

    @Test func keepsReplacesAndForgets() throws {
        let place = folder()
        defer { try? FileManager.default.removeItem(at: place) }
        let store = PageStore(folder: place)
        #expect(try store.get(Self.key) == nil)
        try store.set(Self.key, #"{"sessions":[],"moments":[]}"#)
        #expect(try store.get(Self.key) == #"{"sessions":[],"moments":[]}"#)
        try store.set(Self.key, "second, with ünïcödé")
        // A new store on the same folder, as at the app's next start, finds it.
        #expect(try PageStore(folder: place).get(Self.key) == "second, with ünïcödé")
        try store.remove(Self.key)
        #expect(try store.get(Self.key) == nil)
        try store.remove(Self.key)
        // Kept on this phone only: the folder is left out of backups.
        #expect(try place.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    @Test func aKeyIsNeverAPath() throws {
        let place = folder()
        defer { try? FileManager.default.removeItem(at: place) }
        let store = PageStore(folder: place)
        try store.set("cranium.../../escape", "x")
        let names = try FileManager.default.contentsOfDirectory(atPath: place.path)
        #expect(names.count == 1)
        #expect(names.first?.count == 64 && names.first?.allSatisfy { $0.isHexDigit && !$0.isUppercase } == true)
        #expect(try store.get("cranium.../../escape") == "x")
    }

    @Test func pastTheLimitsNothingIsChanged() throws {
        let place = folder()
        defer { try? FileManager.default.removeItem(at: place) }
        let store = PageStore(folder: place)
        try store.set(Self.key, "kept")
        #expect(throws: BridgeError.self) { try store.set(Self.key, String(repeating: "x", count: PageStore.maxValueBytes + 1)) }
        #expect(try store.get(Self.key) == "kept")
        // Bytes, not characters: two bytes each.
        #expect(throws: BridgeError.self) { try store.set(Self.key, String(repeating: "é", count: PageStore.maxValueBytes / 2 + 1)) }

        for index in 1..<PageStore.maxItems { try store.set("cranium.item.\(index)", "v") }
        #expect(throws: BridgeError.self) { try store.set("cranium.one.more", "v") }
        #expect(try store.get("cranium.one.more") == nil)
        // Replacing one that is there is not one more.
        try store.set("cranium.item.1", "again")
        #expect(try store.get("cranium.item.1") == "again")
    }

    @Test func theTotalIsCapped() throws {
        let place = folder()
        defer { try? FileManager.default.removeItem(at: place) }
        let store = PageStore(folder: place)
        let big = String(repeating: "y", count: PageStore.maxValueBytes)
        for index in 1...4 { try store.set("cranium.big.\(index)", big) }
        #expect(throws: BridgeError.self) { try store.set("cranium.big.5", "z") }
        try store.set("cranium.big.4", "small")
        try store.set("cranium.big.5", "z")
        #expect(try store.get("cranium.big.5") == "z")
    }

    @Test func theContractNamesTheSameLimits() throws {
        let method = try #require(BridgeSpec.methods["storage.set"])
        #expect(method.params["value"] == .string(max: PageStore.maxValueBytes))
        #expect(BridgeSpec.features.contains("storage"))
    }
}
