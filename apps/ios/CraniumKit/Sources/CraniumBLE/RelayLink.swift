import CoreBluetooth
import CraniumKit
import Foundation
import Network

/// The Bluetooth relay for one board (firmware 1.21.0, docs/ble-relay.md): this phone carries the board's own
/// TLS connection to AWS IoT. It finds a board advertising the relay service, reads the PSM, opens the L2CAP
/// channel, and lets `RelayPump` decide; TCP goes with `NWConnection`, with no TLS of its own, since the bytes
/// are the board's TLS already. Bounded both ways: past 64 KB waiting, the other side is not read until it
/// drains, and L2CAP's credits or TCP's window hold the sender back.
///
/// Everything runs on the main queue. A board that turns out to be another one is let go, and the next one
/// tried; a board that goes out of reach is looked for again until `stop()`.
public final class RelayLink: NSObject {
    public struct Status: Equatable, Sendable {
        /// "looking", "connecting", "ready" (channel open, no stream), "relaying", or "stopped".
        public var state: String
        public var thing: String?
        public var bytesUp: Int
        public var bytesDown: Int
        /// Why the last channel ended, in words, if it did.
        public var error: String?
    }

    public var onStatus: ((Status) -> Void)?
    public private(set) var status = Status(state: "looking", thing: nil, bytesUp: 0, bytesDown: 0, error: nil)

    private unowned let radio: BoardRadio
    private let thing: String?
    private let region: String
    private var stopped = false

    private var candidates: [CBPeripheral] = []
    private var tried: Set<UUID> = []
    private var peripheral: CBPeripheral?
    private var channel: CBL2CAPChannel?
    private var pump: RelayPump?
    private var server: NWConnection?

    private var toBoard = RelayBuffer()
    private var toServerPending = 0
    private var readingServer = false
    private var readingBoard = true

    private static let serviceUUID = CBUUID(string: RelayProtocol.serviceUUID)
    private static let psmUUID = CBUUID(string: RelayProtocol.psmUUID)
    /// A board must get from connected to an open channel in this time.
    private static let stepTimeout: TimeInterval = 15
    private var attempt = 0

    init(radio: BoardRadio, thing: String?, region: String) {
        self.radio = radio
        self.thing = thing
        self.region = region
        super.init()
    }

    /// Starts looking for the board. Call on the main queue.
    public func start() {
        stopped = false
        look()
    }

    /// Ends the relay: the board hears that the channel went, and reconnects as it can.
    public func stop() {
        stopped = true
        radio.stopRelayScan()
        perform(pump?.stop() ?? [])
        teardown(error: nil)
        update(state: "stopped")
    }

    // MARK: Finding and connecting

    private func look() {
        guard !stopped else { return }
        update(state: "looking")
        radio.startRelayScan { [weak self] found in self?.found(found) }
    }

    private func found(_ candidate: CBPeripheral) {
        guard !stopped, !tried.contains(candidate.identifier),
              !candidates.contains(where: { $0.identifier == candidate.identifier }) else { return }
        candidates.append(candidate)
        if peripheral == nil { tryNext() }
    }

    private func tryNext() {
        guard !stopped, peripheral == nil else { return }
        guard !candidates.isEmpty else {
            // Every board in range was tried: start over, as a board can come back or change its mind.
            tried.removeAll()
            look()
            return
        }
        let next = candidates.removeFirst()
        tried.insert(next.identifier)
        peripheral = next
        next.delegate = self
        radio.register(self, for: next)
        radio.stopRelayScan()
        update(state: "connecting")
        radio.connectForRelay(next)
        armTimeout()
    }

    private func armTimeout() {
        attempt += 1
        let token = attempt
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stepTimeout) { [weak self] in
            guard let self, self.attempt == token, self.channel == nil, self.peripheral != nil else { return }
            self.teardown(error: "The board did not open the relay in time.")
            self.tryNext()
        }
    }

    // MARK: The pump's actions

    private func perform(_ actions: [RelayPump.Action]) {
        for action in actions {
            switch action {
            case .toBoard(let bytes):
                if toBoard.append(bytes) { pauseServer() }
                flushToBoard()
            case .connect(let host, let port):
                openServer(host: host, port: port)
            case .toServer(let bytes):
                sendToServer(bytes)
            case .closeServer:
                closeServer()
            case .closeChannel:
                let words: String?
                if case .ended(let text) = pump?.state { words = text } else { words = nil }
                teardown(error: words)
                tryNext()
            }
        }
        report()
    }

    private func flushToBoard() {
        guard let output = channel?.outputStream else { return }
        while !toBoard.isEmpty && output.hasSpaceAvailable {
            let chunk = toBoard.peek(max: 4096)
            let written = chunk.withUnsafeBytes { raw -> Int in
                guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return output.write(base, maxLength: chunk.count)
            }
            guard written > 0 else { break }
            if toBoard.drop(written) { resumeServer() }
        }
    }

    private func readBoard() {
        guard readingBoard, let input = channel?.inputStream else { return }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while input.hasBytesAvailable {
            let count = input.read(&buffer, maxLength: buffer.count)
            guard count > 0, let pump else { break }
            perform(pump.fromBoard(Data(buffer[0..<count])))
            guard readingBoard else { break }
        }
    }

    // MARK: TCP

    private func openServer(host: String, port: UInt16) {
        closeServer()
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            perform(pump?.serverFailed() ?? [])
            return
        }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: .tcp)
        server = connection
        toServerPending = 0
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection, self.server === connection, let pump = self.pump else { return }
            switch state {
            case .ready:
                self.perform(pump.serverConnected())
                self.readingServer = true
                self.receiveFromServer(connection)
            case .failed, .waiting:
                connection.cancel()
                self.server = nil
                self.perform(pump.serverFailed())
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    private func receiveFromServer(_ connection: NWConnection) {
        guard readingServer, server === connection else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self, weak connection] data, _, done, error in
            guard let self, let connection, self.server === connection, let pump = self.pump else { return }
            if let data, !data.isEmpty { self.perform(pump.fromServer(data)) }
            if done || error != nil {
                connection.cancel()
                self.server = nil
                self.perform(pump.serverClosed())
                return
            }
            self.receiveFromServer(connection)
        }
    }

    private func sendToServer(_ bytes: Data) {
        guard let connection = server else { return }
        toServerPending += bytes.count
        if toServerPending >= RelayBuffer.high { readingBoard = false }
        connection.send(content: bytes, completion: .contentProcessed { [weak self, weak connection] error in
            guard let self, let connection, self.server === connection else { return }
            self.toServerPending -= bytes.count
            if error != nil {
                connection.cancel()
                self.server = nil
                self.perform(self.pump?.serverClosed() ?? [])
            } else if !self.readingBoard && self.toServerPending <= RelayBuffer.low {
                self.readingBoard = true
                self.readBoard()
            }
        })
    }

    private func pauseServer() {
        readingServer = false
    }

    private func resumeServer() {
        guard !readingServer, let server else { return }
        readingServer = true
        receiveFromServer(server)
    }

    private func closeServer() {
        server?.stateUpdateHandler = nil
        server?.cancel()
        server = nil
        readingServer = false
        toServerPending = 0
        readingBoard = true
    }

    // MARK: Ending

    private func teardown(error: String?) {
        closeServer()
        if let channel {
            for stream in [channel.inputStream as Stream?, channel.outputStream as Stream?] {
                stream?.delegate = nil
                stream?.close()
                stream?.remove(from: .main, forMode: .default)
            }
        }
        channel = nil
        pump = nil
        toBoard.clear()
        if let peripheral {
            peripheral.delegate = nil
            radio.unregister(peripheral)
            radio.cancel(peripheral)
        }
        peripheral = nil
        attempt += 1
        status.error = error
    }

    private func update(state: String) {
        status.state = state
        report()
    }

    private func report() {
        if let pump {
            switch pump.state {
            case .relaying: status.state = "relaying"
            case .ready, .connecting: status.state = "ready"
            default: break
            }
            status.thing = pump.thing ?? status.thing
            status.bytesUp = pump.bytesUp
            status.bytesDown = pump.bytesDown
        }
        onStatus?(status)
    }
}

extension RelayLink: RadioLink {
    func radioDidConnect() {
        peripheral?.discoverServices([Self.serviceUUID])
    }

    func radioDidFailToConnect(_ error: Error?) {
        teardown(error: "The board could not be reached.")
        tryNext()
    }

    func radioDidDisconnect(_ error: Error?) {
        let actions = pump?.channelClosed() ?? []
        perform(actions)
        teardown(error: "The board went out of reach.")
        tryNext()
    }

    func radioWentAway(_ state: RadioState) {
        teardown(error: state.problem)
        candidates.removeAll()
        update(state: "looking")
    }
}

extension RelayLink: CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            teardown(error: "That board does not offer the relay.")
            tryNext()
            return
        }
        peripheral.discoverCharacteristics([Self.psmUUID], for: service)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let psm = service.characteristics?.first(where: { $0.uuid == Self.psmUUID }) else {
            teardown(error: "That board does not offer the relay.")
            tryNext()
            return
        }
        peripheral.readValue(for: psm)
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == Self.psmUUID, let value = characteristic.value, value.count >= 2 else { return }
        let psm = CBL2CAPPSM(value[value.startIndex]) | CBL2CAPPSM(value[value.startIndex + 1]) << 8
        guard psm != 0 else {
            teardown(error: "The board's relay is not listening yet.")
            tryNext()
            return
        }
        peripheral.openL2CAPChannel(psm)
    }

    public func peripheral(_ peripheral: CBPeripheral, didOpen channel: CBL2CAPChannel?, error: Error?) {
        guard let channel, error == nil else {
            teardown(error: "The board refused the relay channel.")
            tryNext()
            return
        }
        self.channel = channel
        pump = RelayPump(expectedThing: thing, region: region)
        for stream in [channel.inputStream as Stream, channel.outputStream as Stream] {
            stream.delegate = self
            stream.schedule(in: .main, forMode: .default)
            stream.open()
        }
        report()
    }
}

extension RelayLink: StreamDelegate {
    public func stream(_ stream: Stream, handle eventCode: Stream.Event) {
        guard let channel else { return }
        switch eventCode {
        case .hasBytesAvailable where stream === channel.inputStream:
            readBoard()
        case .hasSpaceAvailable where stream === channel.outputStream:
            flushToBoard()
        case .errorOccurred, .endEncountered:
            perform(pump?.channelClosed() ?? [])
            teardown(error: "The relay channel closed.")
            tryNext()
        default:
            break
        }
    }
}
