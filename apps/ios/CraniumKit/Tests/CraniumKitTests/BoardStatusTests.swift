import Foundation
import Testing
@testable import CraniumKit

/// The board's status characteristic, as the firmware writes it: firmware/tests/host/test_bt_status.c
/// makes this same payload (`build/bt_status_tests --print`). The Android app's BoardStatusTest has the
/// same cases.
@Suite struct BoardStatusTests {
    /// An offer of 1.14.1+0 on a board that runs 1.14.0+0 on trial, after an update over Bluetooth before.
    static let sample = "010302010300384e0d00010e0100000000000000010e00000000000007010100010e000000000000010d020007000000deadbeef010203040300040302010000"

    @Test func theFirmwaresSample() throws {
        let status = try #require(BoardStatus.parse(Data(hexDigits: Self.sample)))
        #expect(status.window == .offer)
        #expect(status.secondsLeft == 258)
        #expect(status.image == .verified)
        #expect(status.refusal == BoardStatus.Refusal.none)
        #expect(status.imageBytes == 0x000d_4e38)
        #expect(status.imageVersion == "1.14.1+0")
        #expect(status.result == BoardStatus.Result.none)
        #expect(status.closedReason == 0)
        #expect(status.running == "1.14.0+0")
        #expect(status.onTrial)
        #expect(status.swap == .revert)
        #expect(status.lastVia == .bluetooth)
        #expect(status.lastOutcome == .pending)
        #expect(status.lastProof == BoardStatus.Proof.none)
        #expect(status.lastTarget == "1.14.0+0")
        #expect(status.lastFrom == "1.13.2+7")
        #expect(status.lastHash == "deadbeef01020304")
        #expect(status.lastCount == 3)
        #expect(status.uptime == 0x0102_0304)
    }

    @Test func whatCannotBeRead() {
        // Too short, as a read on a link of the default MTU would be if it were not a long read.
        #expect(BoardStatus.parse(Data(hexDigits: String(Self.sample.prefix(40)))) == nil)
        // Another format.
        #expect(BoardStatus.parse(Data(hexDigits: "02" + Self.sample.dropFirst(2))) == nil)
        #expect(BoardStatus.parse(Data()) == nil)
        // Longer is fine: a later firmware may add to the end.
        #expect(BoardStatus.parse(Data(hexDigits: Self.sample + "ffff")) != nil)
    }

    @Test func nothingToSay() throws {
        var bytes = [UInt8](repeating: 0, count: 64)
        bytes[0] = 1
        bytes[20] = 1
        bytes[21] = 14
        let status = try #require(BoardStatus.parse(Data(bytes)))
        #expect(status.window == .closed && status.image == BoardStatus.Image.none)
        #expect(status.imageVersion == nil && status.lastTarget == nil && status.lastFrom == nil && status.lastHash == nil)
        #expect(status.running == "1.14.0+0")
        #expect(!status.onTrial && status.swap == BoardStatus.Swap.none && status.lastVia == BoardStatus.Via.none)
    }

    @Test func numbersFromALaterFirmware() throws {
        var bytes = [UInt8](Data(hexDigits: Self.sample))
        bytes[1] = 9
        bytes[5] = 42
        bytes[30] = 99
        let status = try #require(BoardStatus.parse(Data(bytes)))
        #expect(status.window == .unknown && status.refusal == .unknown && status.lastOutcome == .unknown)
        #expect(!status.lastOutcome.isEnd)
    }

    @Test func whatCountsAsNews() throws {
        let status = try #require(BoardStatus.parse(Data(hexDigits: Self.sample)))
        var bytes = [UInt8](Data(hexDigits: Self.sample))
        bytes[2] = 1      // seconds left
        bytes[7] = 0x50   // bytes
        bytes[58] = 9     // uptime
        let counted = try #require(BoardStatus.parse(Data(bytes)))
        #expect(!counted.isNews(after: status))
        bytes[18] = 1     // installing
        let installing = try #require(BoardStatus.parse(Data(bytes)))
        #expect(installing.isNews(after: status))
        #expect(installing.result == .installing)
        #expect(status.isNews(after: nil))
    }

    @Test func wordsForEachRefusalAndOutcome() {
        #expect(BoardStatus.words(.older) == "It is not newer than what the board runs.")
        #expect(BoardStatus.words(.incompatibleBoard) == "It is for another kind of board.")
        #expect(BoardStatus.words(.incompatibleLayout) == "It is for another flash layout.")
        #expect(BoardStatus.words(.unknown) == "The board did not say why.")
        #expect(BoardStatus.Outcome.kept.word == "succeeded")
        #expect(BoardStatus.Outcome.rolledBack.word == "rolled_back")
        #expect(BoardStatus.Outcome.notInstalled.word == "not_installed")
        #expect(BoardStatus.Outcome.pending.isEnd == false && BoardStatus.Outcome.kept.isEnd)
        #expect(BoardStatus.Proof.cloud.word == "cloud" && BoardStatus.Proof.unknown.word == "none")
    }

    @Test func theUUIDsAreTheFirmwares() {
        #expect(BoardStatus.serviceUUID == "9112B1B4-2A51-40F0-94D3-A76440F0E6CC")
        #expect(BoardStatus.characteristicUUID == "9112B1B5-2A51-40F0-94D3-A76440F0E6CC")
    }

    /// The image's own hash, which the board keeps: from the TLV area, not the SHA-256 of the file.
    @Test func theImagesOwnHash() throws {
        var file = Data(count: 32)
        file.replaceSubrange(0..<4, with: [0x3d, 0xb8, 0xf3, 0x96])
        file[8] = 32        // header size
        file[12] = 16       // image size
        file.append(Data(count: 16))
        // The TLV area: magic 0x6907, its length, a key hash entry (0x01) and then the SHA-256 (0x10).
        let digest = (0..<32).map { UInt8($0 + 0xa0) }
        var tlv: [UInt8] = [0x07, 0x69, 0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 1, 2, 3, 4, 0x10, 0x00, 0x20, 0x00] + digest
        tlv[2] = UInt8(tlv.count)
        file.append(contentsOf: tlv)
        let header = try #require(MCUbootHeader(file))
        #expect(ImageCheck.imageHash(file, header: header) == digest.map { String(format: "%02x", $0) }.joined())

        // No TLV area where the header says.
        #expect(ImageCheck.imageHash(file.prefix(60), header: header) == nil)
        var wrong = file
        wrong[48] = 0x08
        #expect(ImageCheck.imageHash(wrong, header: header) == nil)
    }
}

extension Data {
    /// Bytes from hex digits, two at a time, for the tests.
    init(hexDigits: String) {
        var bytes: [UInt8] = []
        var index = hexDigits.startIndex
        while index < hexDigits.endIndex, let next = hexDigits.index(index, offsetBy: 2, limitedBy: hexDigits.endIndex) {
            bytes.append(UInt8(hexDigits[index..<next], radix: 16) ?? 0)
            index = next
        }
        self.init(bytes)
    }
}
