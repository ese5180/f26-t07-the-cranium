import Foundation

/// The board's console over USB, read only (docs/mac-app.md, "Serial console"), as the console's
/// serial page reads it by default: the J-Link's virtual COM port at 115200 baud, 8N1. Nothing is ever
/// written to the board from here.

/// Bytes as they come, into whole lines: a line ends at \n, \r\n or \r; colour codes are taken out; a
/// line longer than `maxLine` is cut there; at most `keep` lines are kept.
public struct SerialLineBuffer: Sendable {
    public static let maxLine = 1024
    public static let keep = 5000

    public private(set) var lines: [String] = []
    private var pending: [UInt8] = []
    private var lastWasCR = false

    public init() {}

    /// Takes `bytes`; returns the lines they finished.
    @discardableResult
    public mutating func take(_ bytes: [UInt8]) -> [String] {
        var finished: [String] = []
        for byte in bytes {
            if byte == 0x0A {
                // The \n of a \r\n ends nothing more.
                if !lastWasCR { finished.append(flush()) }
                lastWasCR = false
            } else if byte == 0x0D {
                finished.append(flush())
                lastWasCR = true
            } else {
                lastWasCR = false
                if pending.count < Self.maxLine { pending.append(byte) }
            }
        }
        lines.append(contentsOf: finished)
        if lines.count > Self.keep { lines.removeFirst(lines.count - Self.keep) }
        return finished
    }

    public mutating func clear() {
        lines = []
        pending = []
        lastWasCR = false
    }

    private mutating func flush() -> String {
        let text = Self.plain(String(decoding: pending, as: UTF8.self))
        pending = []
        return text
    }

    /// The line without ANSI colour and cursor codes (ESC [ … letter), and without other control characters.
    public static func plain(_ text: String) -> String {
        var out = ""
        var scalars = text.unicodeScalars.makeIterator()
        while let scalar = scalars.next() {
            if scalar == "\u{1B}" {
                // ESC [ parameters final-byte; a lone ESC is dropped.
                guard let next = scalars.next() else { break }
                if next == "[" {
                    while let code = scalars.next(), !(0x40...0x7E).contains(code.value) {}
                }
                continue
            }
            if scalar.value < 0x20 && scalar != "\t" { continue }
            if scalar.value == 0x7F { continue }
            out.unicodeScalars.append(scalar)
        }
        return out
    }
}

#if os(macOS)
import Darwin

/// The serial ports a board can be on: the J-Link's /dev/cu.usbmodem…, two per board (the second is
/// the application's console, VCOM1, on the nRF7002 DK).
public enum SerialPorts {
    public static func list(in directory: String = "/dev") -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
        return names.filter { $0.hasPrefix("cu.usbmodem") }.sorted().map { "\(directory)/\($0)" }
    }

    /// The application's console of a board: the port whose name ends in the higher number, of a pair.
    public static func likelyConsole(_ ports: [String]) -> String? {
        ports.count >= 2 ? ports.sorted()[1] : ports.first
    }
}

public enum SerialError: Error, Equatable, LocalizedError {
    case open(String, Int32)
    case settings(Int32)

    public var errorDescription: String? {
        switch self {
        case .open(let path, let code):
            return "\(path) could not be opened: \(String(cString: strerror(code))). Is another program reading it?"
        case .settings(let code):
            return "The port's settings could not be made: \(String(cString: strerror(code)))."
        }
    }
}

/// One port, open for reading only, raw, 115200 8N1, no flow control. `onBytes` and `onEnd` are called on
/// the main queue.
public final class SerialPort: @unchecked Sendable {
    public static let baud = speed_t(B115200)
    public let path: String
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?

    public init(path: String) {
        self.path = path
    }

    public var isOpen: Bool { fd >= 0 }

    public func open(onBytes: @escaping ([UInt8]) -> Void, onEnd: @escaping (String?) -> Void) throws {
        guard fd < 0 else { return }
        let opened = Darwin.open(path, O_RDONLY | O_NOCTTY | O_NONBLOCK)
        guard opened >= 0 else { throw SerialError.open(path, errno) }
        var settings = termios()
        guard tcgetattr(opened, &settings) == 0 else {
            let code = errno
            Darwin.close(opened)
            throw SerialError.settings(code)
        }
        cfmakeraw(&settings)
        cfsetispeed(&settings, Self.baud)
        cfsetospeed(&settings, Self.baud)
        settings.c_cflag |= tcflag_t(CLOCAL | CREAD)
        settings.c_cflag &= ~tcflag_t(CRTSCTS | PARENB | CSTOPB)
        guard tcsetattr(opened, TCSANOW, &settings) == 0 else {
            let code = errno
            Darwin.close(opened)
            throw SerialError.settings(code)
        }
        fd = opened
        let source = DispatchSource.makeReadSource(fileDescriptor: opened, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, self.fd >= 0 else { return }
            var buffer = [UInt8](repeating: 0, count: 4096)
            let count = read(self.fd, &buffer, buffer.count)
            if count > 0 {
                onBytes(Array(buffer.prefix(count)))
            } else if count == 0 || (errno != EAGAIN && errno != EINTR) {
                // Unplugged, or the board reset its USB.
                let why = count == 0 ? nil : String(cString: strerror(errno))
                self.close()
                onEnd(why)
            }
        }
        source.setCancelHandler { [opened] in Darwin.close(opened) }
        self.source = source
        source.resume()
    }

    public func close() {
        guard fd >= 0 else { return }
        fd = -1
        source?.cancel()
        source = nil
    }

    deinit {
        close()
    }
}
#endif
