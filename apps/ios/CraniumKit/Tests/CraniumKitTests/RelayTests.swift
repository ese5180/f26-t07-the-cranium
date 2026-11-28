import Foundation
import Testing
@testable import CraniumKit

private func hex(_ text: String) -> Data {
    var bytes: [UInt8] = []
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        bytes.append(UInt8(text[index..<next], radix: 16)!)
        index = next
    }
    return Data(bytes)
}

/// The relay's frames, against the bytes that firmware/tests/host/test_ble_relay.c makes
/// (`build/ble_relay_tests --print`). The Android app's RelayProtocolTest holds the same: change all three
/// together.
@Suite struct RelayProtocolTests {
    static let hello = "011c000100f0006372616e69756d2d30313233343536373839616263646566"
    static let open = "022900b3226578616d706c652d6174732e696f742e75732d656173742d312e616d617a6f6e6177732e636f6d"
    static let data = "0405001603030001"
    static let opened = "030000"
    static let close = "05010001"

    @Test func theBoardsFramesAreRead() {
        var reader = RelayReader()
        let messages = reader.feed(hex(Self.hello + Self.open + Self.data))
        #expect(messages == [
            .hello(RelayHello(version: 1, flags: 0, dataMax: 240, thing: "cranium-0123456789abcdef")),
            .open(host: "example-ats.iot.us-east-1.amazonaws.com", port: 8883),
            .data(Data([0x16, 0x03, 0x03, 0x00, 0x01])),
        ])
        #expect(!reader.broken)
    }

    @Test func theAppWritesWhatTheBoardReads() {
        #expect(RelayProtocol.opened() == hex(Self.opened))
        #expect(RelayProtocol.close(.refused) == hex(Self.close))
        #expect(RelayProtocol.data(Data([0x16, 0x03, 0x03, 0x00, 0x01])) == hex(Self.data))
        #expect(RelayProtocol.serviceUUID == "D38F3C14-34A8-4CDD-8E9A-BDB7FE83A2F0")
        #expect(RelayProtocol.psmUUID == "D38F3C15-34A8-4CDD-8E9A-BDB7FE83A2F0")
    }

    @Test func anyPiecesGiveTheSameMessages() {
        let stream = hex(Self.hello + Self.open + Self.data + "7e020061620403000a0b0c" + Self.close)
        for step in [1, 2, 3, 5, 64, stream.count] {
            var reader = RelayReader()
            var messages: [RelayMessage] = []
            var at = 0
            while at < stream.count {
                let end = min(at + step, stream.count)
                messages += reader.feed(stream.subdata(in: at..<end))
                at = end
            }
            // The unknown 0x7e frame is skipped.
            #expect(messages.count == 5)
            #expect(messages[3] == .data(Data([0x0a, 0x0b, 0x0c])))
            #expect(messages[4] == .close(1))
        }
    }

    @Test func tooLongBreaksTheStream() {
        var reader = RelayReader()
        let tooLong = reader.feed(Data([0x04, 0x01, 0x02]))
        #expect(tooLong.isEmpty)
        #expect(reader.broken)
        let after = reader.feed(hex(Self.data))
        #expect(after.isEmpty)

        var opened = RelayReader()
        _ = opened.feed(Data([0x03, 0x01, 0x00, 0x00]))
        #expect(opened.broken)
    }

    @Test func dataIsSplitAtTheBoardsLimit() {
        let frames = RelayProtocol.data(Data(repeating: 7, count: 500), max: 240)
        var reader = RelayReader()
        let messages = reader.feed(frames)
        #expect(messages.map { if case .data(let d) = $0 { return d.count } else { return -1 } } == [240, 240, 20])
    }

    @Test func onlyAWSIoTInTheAppsRegionOn8883() {
        let ok = "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"
        #expect(RelayProtocol.allowed(host: ok, port: 8883, region: "us-east-1"))
        #expect(!RelayProtocol.allowed(host: ok, port: 443, region: "us-east-1"))
        #expect(!RelayProtocol.allowed(host: ok, port: 8883, region: "eu-west-1"))
        #expect(!RelayProtocol.allowed(host: ok, port: 8883, region: ""))
        #expect(!RelayProtocol.allowed(host: "a1b2-ats.iot.us-east-1.amazonaws.com.example.net", port: 8883, region: "us-east-1"))
        #expect(!RelayProtocol.allowed(host: "a1b2.iot.us-east-1.amazonaws.com", port: 8883, region: "us-east-1"))
        #expect(!RelayProtocol.allowed(host: "example.com", port: 8883, region: "us-east-1"))
        #expect(!RelayProtocol.allowed(host: "a1b2-ats.iot.us-east-1xamazonaws.com", port: 8883, region: "us-east-1"))
        #expect(!RelayProtocol.allowed(host: ok, port: 8883, region: "us-east-1|.*"))
    }
}

/// The pump between a fake board and a fake server.
@Suite struct RelayPumpTests {
    let host = "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"
    let thing = "cranium-0123456789abcdef"

    func helloFrame(_ thing: String, version: UInt8 = 1, dataMax: Int = 240) -> Data {
        var payload = Data([version, 0, UInt8(dataMax & 0xff), UInt8(dataMax >> 8)])
        payload.append(Data(thing.utf8))
        return RelayProtocol.frame(.hello, payload)
    }

    func openFrame(_ host: String, port: UInt16 = 8883) -> Data {
        var payload = Data([UInt8(port & 0xff), UInt8(port >> 8)])
        payload.append(Data(host.utf8))
        return RelayProtocol.frame(.open, payload)
    }

    func relaying() -> RelayPump {
        let pump = RelayPump(expectedThing: thing, region: "us-east-1")
        _ = pump.fromBoard(helloFrame(thing))
        _ = pump.fromBoard(openFrame(host))
        _ = pump.serverConnected()
        return pump
    }

    @Test func aStreamFromHelloToClose() {
        let pump = RelayPump(expectedThing: thing, region: "us-east-1")
        #expect(pump.fromBoard(helloFrame(thing)).isEmpty)
        #expect(pump.state == .ready(thing: thing))
        #expect(pump.fromBoard(openFrame(host)) == [.connect(host: host, port: 8883)])
        #expect(pump.serverConnected() == [.toBoard(RelayProtocol.opened())])
        #expect(pump.state == .relaying(thing: thing, host: host))

        let clientHello = Data([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5])
        #expect(pump.fromBoard(RelayProtocol.data(clientHello)) == [.toServer(clientHello)])
        #expect(pump.fromServer(Data(repeating: 9, count: 300)) ==
                [.toBoard(RelayProtocol.data(Data(repeating: 9, count: 300), max: 240))])
        #expect(pump.bytesUp == 10 && pump.bytesDown == 300)

        // The server ends it: the board hears, and may open again on the same channel.
        #expect(pump.serverClosed() == [.toBoard(RelayProtocol.close(.peerClosed))])
        #expect(pump.state == .ready(thing: thing))
        #expect(pump.fromBoard(openFrame(host)) == [.connect(host: host, port: 8883)])

        // The board ends it.
        _ = pump.serverConnected()
        #expect(pump.fromBoard(RelayProtocol.close(.handback)) == [.closeServer])
        #expect(pump.fromBoard(RelayProtocol.data(Data([1]))).isEmpty)
    }

    @Test func anotherBoardIsLetGo() {
        let pump = RelayPump(expectedThing: thing, region: "us-east-1")
        #expect(pump.fromBoard(helloFrame("cranium-ffffffffffffffff")) == [.closeChannel])
        #expect(pump.state == .ended("That is another board."))
        #expect(pump.fromBoard(openFrame(host)).isEmpty)
    }

    @Test func aHostOutsideTheRuleIsRefused() {
        let pump = RelayPump(expectedThing: nil, region: "us-east-1")
        _ = pump.fromBoard(helloFrame(thing))
        #expect(pump.fromBoard(openFrame("example.com")) == [.toBoard(RelayProtocol.close(.refused))])
        #expect(pump.fromBoard(openFrame(host, port: 443)) == [.toBoard(RelayProtocol.close(.refused))])
        #expect(pump.state == .ready(thing: thing))
    }

    @Test func aFailedConnectionIsSaid() {
        let pump = RelayPump(expectedThing: thing, region: "us-east-1")
        _ = pump.fromBoard(helloFrame(thing))
        _ = pump.fromBoard(openFrame(host))
        #expect(pump.serverFailed() == [.toBoard(RelayProtocol.close(.connectFailed))])
        #expect(pump.state == .ready(thing: thing))
    }

    @Test func brokenRulesEndTheRelay() {
        let pump = relaying()
        #expect(pump.fromBoard(helloFrame(thing)) == [.closeServer, .closeChannel])
        if case .ended = pump.state {} else { Issue.record("not ended") }

        let early = RelayPump(expectedThing: thing, region: "us-east-1")
        _ = early.fromBoard(helloFrame(thing))
        _ = early.fromBoard(openFrame(host))
        // DATA before OPENED.
        #expect(early.fromBoard(RelayProtocol.data(Data([1]))) == [.closeServer, .closeChannel])

        let garbled = relaying()
        #expect(garbled.fromBoard(Data([0x04, 0xff, 0xff])) == [.closeServer, .closeChannel])

        let newer = RelayPump(expectedThing: thing, region: "us-east-1")
        #expect(newer.fromBoard(helloFrame(thing, version: 2)) == [.closeChannel])
    }

    @Test func theLinkOrThePersonEndsIt() {
        let pump = relaying()
        #expect(pump.channelClosed() == [.closeServer])
        #expect(pump.channelClosed().isEmpty)

        let stopped = relaying()
        #expect(stopped.stop() == [.closeServer, .closeChannel])
        #expect(stopped.fromServer(Data([1])).isEmpty)
    }

    @Test func theBufferPausesAndResumes() {
        var buffer = RelayBuffer()
        let belowHigh = buffer.append(Data(count: RelayBuffer.high - 1))
        #expect(!belowHigh)
        let atHigh = buffer.append(Data(count: 1))
        #expect(atHigh)
        #expect(buffer.paused)
        let pastHigh = buffer.append(Data(count: 10))
        #expect(!pastHigh)
        #expect(buffer.peek(max: 100).count == 100)
        let aboveLow = buffer.drop(RelayBuffer.high - RelayBuffer.low)
        #expect(!aboveLow)
        let atLow = buffer.drop(10)
        #expect(atLow)
        #expect(!buffer.paused)
        buffer.clear()
        #expect(buffer.isEmpty)
    }
}
