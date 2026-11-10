import CraniumKit
import Foundation

/// The bridge's usb.* on the Mac (apps/shared/bridge.json), as the Android app has it (`ShellUsb`): the page
/// uses it as its Web Serial (bridge.js createBridgeSerial) for the Serial console and Board setup. The page
/// runs the flows; this only carries bytes both ways, with no pacing of its own, so the bootloader's
/// half-second window after ENTER_BOOTLOADER is the page's to meet.
///
/// One of these serves the whole app: every window's bridge asks it, each port belongs to the window that
/// opened it (its `owner`, a window's stable id, which gets that port's usb.data and usb.closed), and a port open in one window is
/// busy in the others. The first usb.open asks the person which SEGGER J-Link to use (`choose`, a sheet);
/// after that the next free port of the same device opens, the console's (the last) first.
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
        let owner: String
        let emit: Emit
    }

    private let lister: SerialPortLister
    private let choose: ([SerialBoard]) async -> SerialBoard?
    private var chosen: String?
    private var open: [Int: Open] = [:]
    private var asking = false
    /// Goes up when a window's page is left; an open that began before is not finished.
    private var generations: [String: Int] = [:]
    private let feed: AsyncStream<Event>.Continuation

    init(lister: SerialPortLister = IOKitSerialLister(), choose: @escaping ([SerialBoard]) async -> SerialBoard?) {
        self.lister = lister
        self.choose = choose
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

    /// The next free port of the chosen device, for `owner`; `{port, ports}`.
    func open(baudRate: Int, owner: String, emit: @escaping Emit) async throws -> [String: JSONValue] {
        let who = owner
        // The sheet is waiting for the person; a second request meanwhile would stack another.
        if asking { throw BridgeError(.busy, "The board's USB port is being chosen already.") }
        asking = true
        defer { asking = false }
        let generation = generations[who, default: 0]
        let boards = SerialBoard.group(lister.list())
        if boards.isEmpty {
            throw BridgeError.failed("No SEGGER J-Link found on the USB cable. Connect the DK's J-Link USB port to the Mac, switch the DK on, and try again.")
        }
        let board: SerialBoard
        if let chosen, let again = boards.first(where: { $0.key == chosen }) {
            board = again
        } else {
            chosen = nil
            let picked = await choose(boards)
            // The page was reloaded or closed while the sheet was up: nothing opens for it.
            guard generations[who, default: 0] == generation else {
                throw BridgeError(.cancelled, "The page was left before a board was chosen.")
            }
            guard let picked else {
                throw BridgeError(.cancelled, "No board was chosen. Choose the board's USB port when the app asks.")
            }
            chosen = picked.key
            board = picked
        }
        // The console (VCOM1, the last) first, then the other one.
        guard let index = stride(from: board.ports.count - 1, through: 0, by: -1).first(where: { open[$0] == nil }) else {
            throw BridgeError(.busy, "Every port of the board is open already, in this app or another window.")
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
        open[index] = Open(line: line, token: token, owner: who, emit: emit)
        return ["port": .int(index), "ports": .int(board.ports.count)]
    }

    /// The bytes (base64) to a port `owner` opened, once they are written.
    func write(port: Int, base64: String, owner: String) async throws {
        guard let line = open[port], line.owner == owner else { throw BridgeError.failed("That port is not open.") }
        guard let bytes = Data(base64Encoded: base64) else { throw BridgeError.badRequest("data: not base64") }
        do {
            try await line.line.write(bytes)
        } catch {
            throw BridgeError.failed("The write to the board did not go.")
        }
    }

    /// Closes a port `owner` opened; nothing if it is not open. usb.closed is not sent for this.
    func close(port: Int, owner: String) {
        guard let entry = open[port], entry.owner == owner else { return }
        open.removeValue(forKey: port)
        entry.line.close()
    }

    /// The owner's page went away: its ports are closed, and an open still waiting for the person is dropped.
    func closeAll(owner: String) {
        let who = owner
        generations[who, default: 0] += 1
        for (index, entry) in open where entry.owner == who {
            entry.line.close()
            open.removeValue(forKey: index)
        }
    }

    var openPorts: [Int] { open.keys.sorted() }

    private func handle(_ event: Event) {
        switch event {
        case .data(let index, let token, let bytes):
            guard let entry = open[index], entry.token == token, !bytes.isEmpty else { return }
            entry.emit("usb.data", ["port": .int(index), "data": .string(bytes.base64EncodedString())])
        case .ended(let index, let token, let reason):
            guard let entry = open[index], entry.token == token else { return }
            open.removeValue(forKey: index)
            entry.line.close()
            entry.emit("usb.closed", ["port": .int(index), "reason": .string(reason.rawValue)])
        }
    }
}
