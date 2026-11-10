import Darwin
import Foundation

/// One open serial port: 8N1, no flow control, raw, read and written with POSIX termios. What arrives goes to
/// `onData` in chunks of at most `readChunk` bytes, in order. When the port goes away (the cable came out, or
/// reading failed) `onEnd` is called once and the port is closed; it is not called after `close()`.
final class SerialLine {
    enum Ending: String {
        case unplugged
        case failed
    }

    struct PortError: Error, Equatable {
        let errno: Int32
    }

    static let readChunk = 4096
    private static let writeTimeout: TimeInterval = 5

    private let fd: Int32
    private let path: String
    private let readQueue = DispatchQueue(label: "cranium.serial.read")
    private let writeQueue = DispatchQueue(label: "cranium.serial.write")
    private var source: DispatchSourceRead?
    private var watcher: DispatchSourceTimer?
    private let lock = NSLock()
    private var finished = false
    private let onData: (Data) -> Void
    private let onEnd: (Ending) -> Void

    init(path: String, baudRate: Int, onData: @escaping (Data) -> Void, onEnd: @escaping (Ending) -> Void) throws {
        let fd = Darwin.open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard fd >= 0 else { throw PortError(errno: errno) }
        // Another program holds it: refuse rather than share the bytes (best effort).
        _ = ioctl(fd, UInt(TIOCEXCL))
        guard Self.configure(fd, baudRate: baudRate) else {
            let code = errno
            Darwin.close(fd)
            throw PortError(errno: code)
        }
        var dtr = TIOCM_DTR
        _ = ioctl(fd, UInt(TIOCMBIS), &dtr)
        self.fd = fd
        self.path = path
        self.onData = onData
        self.onEnd = onEnd
        start()
    }

    /// Raw 8N1, no flow control, no echo, at the speed asked for. A speed the driver does not take in
    /// termios goes through IOSSIOSPEED.
    static func configure(_ fd: Int32, baudRate: Int) -> Bool {
        var attributes = termios()
        guard tcgetattr(fd, &attributes) == 0 else { return false }
        cfmakeraw(&attributes)
        attributes.c_cflag &= ~tcflag_t(CSIZE | PARENB | CSTOPB | CRTSCTS)
        attributes.c_cflag |= tcflag_t(CS8 | CLOCAL | CREAD)
        withUnsafeMutableBytes(of: &attributes.c_cc) { codes in
            codes[Int(VMIN)] = 1
            codes[Int(VTIME)] = 0
        }
        cfsetspeed(&attributes, speed_t(baudRate))
        if tcsetattr(fd, TCSANOW, &attributes) == 0 { return true }
        cfsetspeed(&attributes, speed_t(B115200))
        guard tcsetattr(fd, TCSANOW, &attributes) == 0 else { return false }
        var speed = speed_t(baudRate)
        // IOSSIOSPEED = _IOW('T', 2, speed_t)
        return ioctl(fd, 0x8008_5402, &speed) == 0
    }

    private func start() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: readQueue)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        // The descriptor closes once the source is done with it, and after any write in flight, so its number
        // is never read or written after it was reused.
        let fd = fd
        let writes = writeQueue
        source.setCancelHandler { writes.async { Darwin.close(fd) } }
        // A port that went away may not wake the reader: look for its path now and then.
        let watcher = DispatchSource.makeTimerSource(queue: readQueue)
        watcher.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
        watcher.setEventHandler { [weak self] in
            guard let self else { return }
            if access(self.path, F_OK) != 0 { self.end(.unplugged) }
        }
        // Both are kept before either runs, so an ending in the first moments (a port gone at open) can cancel them.
        lock.lock()
        self.source = source
        self.watcher = watcher
        lock.unlock()
        source.resume()
        watcher.resume()
    }

    private func readAvailable() {
        lock.lock()
        let done = finished
        lock.unlock()
        if done { return }
        var buffer = [UInt8](repeating: 0, count: Self.readChunk)
        let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, Self.readChunk) }
        if count > 0 {
            lock.lock()
            let live = !finished
            lock.unlock()
            if live { onData(Data(buffer[0..<count])) }
        } else if count == 0 {
            end(.unplugged)
        } else if errno != EAGAIN, errno != EINTR {
            end(errno == ENXIO || errno == EIO || errno == ENODEV ? .unplugged : .failed)
        }
    }

    private func end(_ ending: Ending) {
        guard finish() else { return }
        onEnd(ending)
    }

    /// Stops reading and closes the descriptor, once; false when it was done already.
    private func finish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished { return false }
        finished = true
        watcher?.cancel()
        source?.cancel()
        return true
    }

    /// Writes all of `data`, in order with the writes before it; throws if the port is closed or the board
    /// does not take the bytes within five seconds.
    func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writeQueue.async {
                do {
                    try self.writeNow(data)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func writeNow(_ data: Data) throws {
        var offset = 0
        let deadline = Date().addingTimeInterval(Self.writeTimeout)
        let bytes = [UInt8](data)
        while offset < bytes.count {
            lock.lock()
            let closed = finished
            lock.unlock()
            if closed { throw PortError(errno: EBADF) }
            let written = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + offset, bytes.count - offset) }
            if written > 0 {
                offset += written
            } else if written < 0, errno == EAGAIN || errno == EINTR {
                guard Date() < deadline else { throw PortError(errno: ETIMEDOUT) }
                var wait = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = poll(&wait, 1, 100)
            } else {
                throw PortError(errno: errno)
            }
        }
    }

    /// Closes the port; `onEnd` is not called.
    func close() {
        _ = finish()
    }

    deinit {
        _ = finish()
    }
}
