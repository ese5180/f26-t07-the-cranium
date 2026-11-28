import Foundation

/// The relay's decisions for one board, with no Bluetooth and no sockets in it (docs/ble-relay.md): what the
/// app does with what the board sends on the L2CAP channel and what the server sends on TCP. `RelayLink`
/// (CraniumBLE) carries out its actions; RelayPumpTests drives it with a fake channel and a fake socket.
///
/// The app reads nothing of the stream: DATA from the board goes to TCP as it is, and TCP's bytes go back as
/// DATA. It opens TCP only to the host the board names, only if `RelayProtocol.allowed` says so, and only for
/// the board the person picked.
public final class RelayPump {
    public enum State: Equatable, Sendable {
        /// The channel is open; HELLO has not come.
        case waitingHello
        /// HELLO came from the right board; no stream.
        case ready(thing: String)
        /// OPEN came; TCP is being made.
        case connecting(thing: String, host: String)
        case relaying(thing: String, host: String)
        /// The relay is over for this channel, and why, in words for the page.
        case ended(String)
    }

    public enum Action: Equatable, Sendable {
        /// Bytes for the board, on the channel.
        case toBoard(Data)
        case connect(host: String, port: UInt16)
        /// Bytes for the server, on TCP.
        case toServer(Data)
        case closeServer
        /// Let the channel go, and the Bluetooth link with it.
        case closeChannel
    }

    public private(set) var state: State = .waitingHello
    public private(set) var bytesUp = 0
    public private(set) var bytesDown = 0

    private let expectedThing: String?
    private let region: String
    private var reader = RelayReader()
    private var dataMax = RelayProtocol.payloadMax

    /// `expectedThing`: the board the person turned the relay on for, or nil for whichever board answers.
    /// `region`: the app's configured AWS region (`CraniumConfig.region`).
    public init(expectedThing: String?, region: String) {
        self.expectedThing = expectedThing
        self.region = region
    }

    public var thing: String? {
        switch state {
        case .ready(let thing), .connecting(let thing, _), .relaying(let thing, _): return thing
        default: return nil
        }
    }

    /// Bytes from the channel.
    public func fromBoard(_ bytes: Data) -> [Action] {
        if case .ended = state { return [] }
        var actions: [Action] = []
        for message in reader.feed(bytes) {
            actions += handle(message)
            if case .ended = state { return actions }
        }
        if reader.broken { return end("The board sent something the app cannot read.", closing: actions) }
        return actions
    }

    private func handle(_ message: RelayMessage) -> [Action] {
        switch (message, state) {
        case (.hello(let hello), .waitingHello):
            guard hello.version == RelayProtocol.version else {
                return end("The board speaks another version of the relay (\(hello.version)). Update the app.")
            }
            if let expectedThing, expectedThing.caseInsensitiveCompare(hello.thing) != .orderedSame {
                return end("That is another board.")
            }
            dataMax = max(1, min(hello.dataMax, RelayProtocol.payloadMax))
            state = .ready(thing: hello.thing)
            return []
        case (.open(let host, let port), .ready(let thing)):
            guard RelayProtocol.allowed(host: host.lowercased(), port: port, region: region) else {
                return [.toBoard(RelayProtocol.close(.refused))]
            }
            state = .connecting(thing: thing, host: host)
            return [.connect(host: host, port: port)]
        case (.data(let bytes), .relaying):
            bytesUp += bytes.count
            return bytes.isEmpty ? [] : [.toServer(bytes)]
        case (.data, .ready):
            // What was on its way when the stream was closed.
            return []
        case (.close, .connecting(let thing, _)), (.close, .relaying(let thing, _)):
            state = .ready(thing: thing)
            return [.closeServer]
        case (.close, .ready):
            return []
        default:
            return end("The board broke the relay's rules.")
        }
    }

    /// TCP is up.
    public func serverConnected() -> [Action] {
        guard case .connecting(let thing, let host) = state else { return [.closeServer] }
        state = .relaying(thing: thing, host: host)
        return [.toBoard(RelayProtocol.opened())]
    }

    /// TCP could not be made.
    public func serverFailed() -> [Action] {
        guard case .connecting(let thing, _) = state else { return [] }
        state = .ready(thing: thing)
        return [.toBoard(RelayProtocol.close(.connectFailed))]
    }

    /// Bytes from the server.
    public func fromServer(_ bytes: Data) -> [Action] {
        guard case .relaying = state, !bytes.isEmpty else { return [] }
        bytesDown += bytes.count
        return [.toBoard(RelayProtocol.data(bytes, max: dataMax))]
    }

    /// The server, or the network, ended TCP.
    public func serverClosed() -> [Action] {
        switch state {
        case .connecting(let thing, _):
            state = .ready(thing: thing)
            return [.toBoard(RelayProtocol.close(.connectFailed))]
        case .relaying(let thing, _):
            state = .ready(thing: thing)
            return [.toBoard(RelayProtocol.close(.peerClosed))]
        default:
            return []
        }
    }

    /// The channel or the Bluetooth link went.
    public func channelClosed() -> [Action] {
        if case .ended = state { return [] }
        let wasStreaming = isStreaming
        state = .ended("The board went out of reach.")
        return wasStreaming ? [.closeServer] : []
    }

    /// The person turned the relay off.
    public func stop() -> [Action] {
        end("Relay turned off.")
    }

    private var isStreaming: Bool {
        switch state {
        case .connecting, .relaying: return true
        default: return false
        }
    }

    private func end(_ words: String, closing earlier: [Action] = []) -> [Action] {
        let wasStreaming = isStreaming
        state = .ended(words)
        return earlier + (wasStreaming ? [.closeServer] : []) + [.closeChannel]
    }
}

/// What waits to go out on one side of the relay, bounded: past `high` bytes the other side stops being
/// read, and it is read again once this is down to `low`. 64 KB, as docs/ble-relay.md says.
public struct RelayBuffer: Sendable {
    public static let high = 64 * 1024
    public static let low = 16 * 1024

    private var bytes = Data()
    public private(set) var paused = false

    public init() {}

    public var count: Int { bytes.count }
    public var isEmpty: Bool { bytes.isEmpty }

    /// Adds bytes; true when the other side should stop being read now.
    public mutating func append(_ more: Data) -> Bool {
        bytes.append(more)
        if !paused && bytes.count >= Self.high {
            paused = true
            return true
        }
        return false
    }

    /// The next bytes to write, at most `max`, still here until `drop` says they went.
    public func peek(max: Int) -> Data {
        Data(bytes.prefix(max))
    }

    /// `count` bytes went out; true when the other side may be read again now.
    public mutating func drop(_ count: Int) -> Bool {
        bytes.removeFirst(min(count, bytes.count))
        if paused && bytes.count <= Self.low {
            paused = false
            return true
        }
        return false
    }

    public mutating func clear() {
        bytes.removeAll()
        paused = false
    }
}
