import Foundation
import Testing
@testable import CraniumKit

@Suite struct ImageCheckTests {
    let version = FirmwareVersion(release: "1.8.0+3")!

    @Test func headerFields() throws {
        let data = makeImage(version: version, body: 200)
        let header = try #require(MCUbootHeader(data))
        #expect([UInt8](data.prefix(4)) == [0x3D, 0xB8, 0xF3, 0x96])
        #expect(header.version == version)
        #expect(header.headerSize == 32)
        #expect(header.imageSize == 200)
        #expect(header.loadAddress == 0x0001_0000)
    }

    @Test func aGoodImagePasses() throws {
        let data = makeImage(version: version)
        let checked = try ImageCheck.verify(data, for: release(for: data, version: "1.8.0+3"))
        #expect(checked.version == version)
        #expect(checked.release == "1.8.0+3")
        #expect(checked.data == data)
    }

    @Test func upperCaseHashFromTheListIsFine() throws {
        let data = makeImage(version: version)
        let entry = FirmwareRelease(version: "1.8.0+3", size: data.count, sha256: ImageCheck.sha256Hex(data).uppercased())
        _ = try ImageCheck.verify(data, for: entry)
    }

    @Test func wrongSize() {
        let data = makeImage(version: version)
        let entry = FirmwareRelease(version: "1.8.0+3", size: data.count + 1, sha256: ImageCheck.sha256Hex(data))
        #expect(throws: ImageCheckError.wrongSize(expected: data.count + 1, actual: data.count)) {
            try ImageCheck.verify(data, for: entry)
        }
    }

    @Test func wrongHash() {
        let data = makeImage(version: version)
        let entry = FirmwareRelease(version: "1.8.0+3", size: data.count, sha256: String(repeating: "0", count: 64))
        #expect(throws: ImageCheckError.wrongHash) {
            try ImageCheck.verify(data, for: entry)
        }
    }

    @Test func wrongMagic() {
        let data = makeImage(version: version, magic: 0x96F3_B83C)
        #expect(throws: ImageCheckError.notAnImage) {
            try ImageCheck.verify(data, for: release(for: data, version: "1.8.0+3"))
        }
    }

    @Test func tooShortForAHeader() {
        let data = Data([0x3D, 0xB8, 0xF3, 0x96, 0, 0, 0, 0])
        #expect(throws: ImageCheckError.notAnImage) {
            try ImageCheck.verify(data, for: release(for: data, version: "1.8.0+3"))
        }
    }

    @Test func headerVersionMustEqualTheRelease() {
        let data = makeImage(version: version)
        // Same bytes, listed as another version: the header wins, and says no.
        #expect(throws: ImageCheckError.wrongVersion(header: version, release: "1.8.0+4")) {
            try ImageCheck.verify(data, for: release(for: data, version: "1.8.0+4"))
        }
    }

    @Test func sizesInTheHeaderMustFit() {
        let data = makeImage(version: version, body: 200, tlvs: 0, imageSizeOverride: 10_000)
        #expect(throws: ImageCheckError.badSizes) {
            try ImageCheck.verify(data, for: release(for: data, version: "1.8.0+3"))
        }
    }

    @Test func unreadableReleaseVersion() {
        let data = makeImage(version: version)
        #expect(throws: ImageCheckError.unreadableReleaseVersion("1.8.0")) {
            try ImageCheck.verify(data, for: release(for: data, version: "1.8.0"))
        }
    }

    static let binaries = ConfigTests.configDir
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // repository
        .appendingPathComponent("binaries")
    static let latestImage = binaries.appendingPathComponent("latest.signed.bin")
    static let latestMetadata = binaries.appendingPathComponent("latest.json")
    static var haveLatest: Bool {
        FileManager.default.fileExists(atPath: latestImage.path)
            && FileManager.default.fileExists(atPath: latestMetadata.path)
    }

    /// The real thing, when this checkout has a built image (binaries/ is not in git).
    @Test(.enabled(if: haveLatest, "needs binaries/latest.signed.bin, from scripts/build.sh"))
    func theLatestBuiltImageInTheRepository() throws {
        struct Latest: Decodable { let version: String; let size: Int; let sha256: String }
        let latest = try JSONDecoder().decode(Latest.self, from: Data(contentsOf: Self.latestMetadata))
        let data = try Data(contentsOf: Self.latestImage)
        let checked = try ImageCheck.verify(data, for: FirmwareRelease(version: latest.version, size: latest.size, sha256: latest.sha256))
        #expect(checked.version.description == latest.version)
        #expect(checked.header.headerSize > 0)
    }
}
