import CraniumKit
import Foundation

/// The bridge's usb.* on the Mac (apps/shared/bridge.json), as the Android app has it (`ShellUsb`): the page
/// uses it as its Web Serial (bridge.js createBridgeSerial) for the Serial console and Board setup. The page
/// runs the flows; this only carries bytes both ways, with no pacing of its own, so the bootloader's
/// half-second window after ENTER_BOOTLOADER is the page's to meet.
///
/// The first usb.open asks the person which USB device to use (`choose`, a sheet in the app); after that the
/// next free port of the same device opens, the console's (the last) first. A port that closes by itself
/// (the cable came out, or reading failed) is told to the page as usb.closed.
@MainActor
final class MacSerial {
    typealias Emit = (String, [String: JSONValue]) -> Void

    private enum Event {
        case data(index: Int, token: UUID, bytes: Data)
        case ended(index: Int, token: UUID, reason: SerialLine.Ending)
    }

    private struct Open {
        let line: SerialLine
        let token: UUID
    }

    private let lister: SerialPortLister
    private let choose: ([SerialBoard]) async -> SerialBoard?
    private let emit: Emit
    private var chosen: String?
    private var open: [Int: Open] = [:]
    private var asking = false
    private let feed: AsyncStream<Event>.Continuation

    init(lister: SerialPortLister = IOKitSerialLister(), choose: @escaping ([SerialBoard]) async -> SerialBoard?, emit: @escaping Emit) {
        self.lister = lister
        self.choose = choose
        self.emit = emit
        var continuation: AsyncStream<Event>.Continuation!
        let events = AsyncStream<Event> { continuation = $0 }
        feed = continuation
        // One reader, so what the board sent reaches the page in the order it came.
        Task { @MainActor [weak self] in
            for await event in events {
                guard let self else { return }
                self.handle(event)
            }
        }
    }

    deinit {
        feed.finish()
    }

    // MARK: usb.*

    /// The next free port of the chosen device; `{port, ports}`.
    func open(baudRate: Int) async throws -> [String: JSONValue] {
        // The sheet is waiting for the person; a second request meanwhile would stack another.
        if asking { throw BridgeError(.busy, "The board's USB port is being chosen already.") }
        asking = true
        defer { asking = false }
        let boards = SerialBoard.group(lister.list())
        if boards.isEmpty {
            throw BridgeError.failed("No board found on the USB cable. Connect the DK's J-Link USB port to the Mac, switch the DK on, and try again.")
        }
        let board: SerialBoard
        if let chosen, let again = boards.first(where: { $0.key == chosen }) {
            board = again
        } else {
            chosen = nil
            guard let picked = await choose(boards) else {
                throw BridgeError(.cancelled, "No board was chosen. Choose the board's USB port when the app asks.")
            }
            chosen = picked.key
            board = picked
        }
        // The console (VCOM1, the last) first, then the other one.
        guard let index = stride(from: board.ports.count - 1, through: 0, by: -1).first(where: { open[$0] == nil }) else {
            throw BridgeError(.busy, "Every port of the board is open already.")
        }
        let token = UUID()
        let feed = feed
        let line: SerialLine
        do {
            line = try SerialLine(path: board.ports[index].path, baudRate: baudRate,
                                  onData: { feed.yield(.data(index: index, token: token, bytes: $0)) },
                                  onEnd: { feed.yield(.ended(index: index, token: token, reason: $0)) })
        } catch {
            throw BridgeError.failed("The port could not be opened. Another app may have it: close that app, unplug the board and plug it in again.")
        }
        open[index] = Open(line: line, token: token)
        return ["port": .int(index), "ports": .int(board.ports.count)]
    }

    /// The bytes (base64) to the port, once they are written.
    func write(port: Int, base64: String) async throws {
        guard let line = open[port]?.line else { throw BridgeError.failed("That port is not open.") }
        guard let bytes = Data(base64Encoded: base64) else { throw BridgeError.badRequest("data: not base64") }
        do {
            try await line.write(bytes)
        } catch {
            throw BridgeError.failed("The write to the board did not go.")
        }
    }

    /// Closes the port; nothing if it is not open. usb.closed is not sent for this.
    func close(port: Int) {
        open.removeValue(forKey: port)?.line.close()
    }

    /// Every port closed: the page went away.
    func closeAll() {
        for entry in open.values { entry.line.close() }
        open.removeAll()
    }

    var openPorts: [Int] { open.keys.sorted() }

    private func handle(_ event: Event) {
        switch event {
        case .data(let index, let token, let bytes):
            guard open[index]?.token == token, !bytes.isEmpty else { return }
            emit("usb.data", ["port": .int(index), "data": .string(bytes.base64EncodedString())])
        case .ended(let index, let token, let reason):
            guard let entry = open[index], entry.token == token else { return }
            open.removeValue(forKey: index)
            entry.line.close()
            emit("usb.closed", ["port": .int(index), "reason": .string(reason.rawValue)])
        }
    }
}
