import Foundation
import Testing
@testable import CraniumKit

/// The offline status, parsed from the payload that firmware/tests/host/test_bt_offline.c makes
/// (`build/bt_offline_tests --print`).
@Suite struct OfflineStatusTests {
    static let sample = "010101040200011202010d0c0b0a040302010113"

    func data(_ hex: String) -> Data {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return Data(bytes)
    }

    @Test func theBoardsPayloadIsRead() throws {
        let status = try #require(OfflineStatus.parse(data(Self.sample)))
        #expect(status.wifi == .down && status.cloud == .down)
        #expect(status.update == .waiting)
        #expect(status.rebootCode == 2 && status.rebootWord == "Watchdog")
        #expect(status.running == "1.18.258+168496141")
        #expect(status.uptime == 0x01020304)
        #expect(status.waiting == "1.19")
        #expect(status.canAccept)
        #expect(status.updateWord == "Version 1.19 has arrived and waits for you")
    }

    @Test func aPayloadThatIsShortOrOfAnotherFormatSaysNothing() {
        #expect(OfflineStatus.parse(Data()) == nil)
        #expect(OfflineStatus.parse(data(String(Self.sample.dropLast(2)))) == nil)
        #expect(OfflineStatus.parse(data("02" + Self.sample.dropFirst(2))) == nil)
    }

    @Test func nothingWaitsUnlessTheBoardSaysSo() throws {
        var hex = Array(Self.sample)
        hex[6] = "0"
        hex[7] = "0"
        let idle = try #require(OfflineStatus.parse(data(String(hex))))
        #expect(idle.update == .idle && idle.waiting == nil && !idle.canAccept)
        #expect(idle.updateWord == "No update")
    }

    @Test func numbersThisAppDoesNotKnowAreUnknownNotWrong() throws {
        let odd = try #require(OfflineStatus.parse(data("01090903ff00" + String(Self.sample.dropFirst(12)))))
        #expect(odd.wifi == .unknown && odd.cloud == .unknown)
        #expect(odd.rebootWord == "Not known")
    }

    @Test func theAcceptWriteNamesTheVersionThePersonSaw() {
        #expect(OfflineStatus.acceptRequest(version: "1.19") == Data([1, 1, 19]))
        #expect(OfflineStatus.acceptRequest(version: "1.19.0+4") == Data([1, 1, 19]))
        #expect(OfflineStatus.acceptRequest(version: "1") == nil)
        #expect(OfflineStatus.acceptRequest(version: "1.300") == nil)
    }

    @Test func uptimeReadsInTheLargestUnits() {
        func word(_ seconds: Int) -> String {
            let b = [UInt8](data(Self.sample))
            var bytes = b
            for i in 0..<4 { bytes[14 + i] = UInt8(truncatingIfNeeded: seconds >> (8 * i)) }
            return OfflineStatus.parse(Data(bytes))!.uptimeWord
        }
        #expect(word(75) == "1 min 15 s")
        #expect(word(3_700) == "1 h 1 min")
        #expect(word(90_000) == "1 d 1 h")
    }
}
