import CraniumKit
import Darwin
import XCTest

/// The serial layer against a pseudo-terminal pair, never a real device: the slave side is the "port" the app
/// opens, the master side is the board.
final class SerialPortsTests: XCTestCase {
    private func properties(_ path: String, vendor: Int? = 0x1366, product: String? = "J-Link", serial: String? = "000683123456") -> [String: Any] {
        var found: [String: Any] = ["IOCalloutDevice": path]
        if let vendor { found["idVendor"] = vendor }
        found["idProduct"] = 0x1055
        if let product { found["USB Product Name"] = product }
        if let serial { found["USB Serial Number"] = serial }
        found["locationID"] = 0x1410_0000
        return found
    }

    func testAPortIsReadFromItsRegistryProperties() throws {
        let port = try XCTUnwrap(SerialPortInfo(properties: properties("/dev/cu.usbmodem0006831234561")))
        XCTAssertEqual(port.path, "/dev/cu.usbmodem0006831234561")
        XCTAssertEqual(port.vendorID, 0x1366)
        XCTAssertEqual(port.product, "J-Link")
        XCTAssertEqual(port.serialNumber, "000683123456")
    }

    func testOnlyCalloutPortsCount() {
        XCTAssertNil(SerialPortInfo(properties: properties("/dev/tty.usbmodem1")))
        XCTAssertNil(SerialPortInfo(properties: ["idVendor": 1]))
        XCTAssertNil(SerialPortInfo(properties: ["IOCalloutDevice": 5]))
    }

    func testTextIsTrimmedAndBounded() throws {
        let port = try XCTUnwrap(SerialPortInfo(properties: properties("/dev/cu.x", product: "  J-Link \n", serial: String(repeating: "9", count: 200))))
        XCTAssertEqual(port.product, "J-Link")
        XCTAssertEqual(port.serialNumber?.count, 80)
        XCTAssertNil(SerialPortInfo(properties: properties("/dev/cu.x", product: "   "))?.product)
    }

    func testPortsOfOneDeviceAreOneBoardWithTheConsoleLast() {
        let ports = [
            SerialPortInfo(path: "/dev/cu.usbmodem0006831234563", vendorID: 0x1366, productID: 0x1055, product: "J-Link", serialNumber: "000683123456"),
            SerialPortInfo(path: "/dev/cu.usbmodem0006831234561", vendorID: 0x1366, productID: 0x1055, product: "J-Link", serialNumber: "000683123456"),
        ]
        let boards = SerialBoard.group(ports)
        XCTAssertEqual(boards.count, 1)
        XCTAssertEqual(boards[0].title, "J-Link (000683123456)")
        XCTAssertEqual(boards[0].ports.map(\.path), ["/dev/cu.usbmodem0006831234561", "/dev/cu.usbmodem0006831234563"])
    }

    func testOnlySeggerJLinksAreOffered() {
        let ports = [
            SerialPortInfo(path: "/dev/cu.usbserial-1", vendorID: 0x0403, productID: 0x6001, product: "FT232R", serialNumber: "A1"),
            SerialPortInfo(path: "/dev/cu.Bluetooth-Incoming-Port", vendorID: nil),
            SerialPortInfo(path: "/dev/cu.usbmodem1", vendorID: 0x1366, productID: 0x1055, product: "J-Link", serialNumber: "S1"),
            SerialPortInfo(path: "/dev/cu.usbmodem9", vendorID: 0x2341, productID: 0x0043, product: "Uno", serialNumber: "U9"),
        ]
        XCTAssertEqual(SerialBoard.group(ports).map(\.title), ["J-Link (S1)"])
        XCTAssertTrue(SerialBoard.group(Array(ports.prefix(2))).isEmpty)
    }

    func testTwoBoardsWithoutSerialNumbersStayApartByWhereTheyArePlugged() {
        let first = SerialPortInfo(path: "/dev/cu.a", vendorID: 0x1366, productID: 1, product: "J-Link", locationID: 0x100)
        let second = SerialPortInfo(path: "/dev/cu.b", vendorID: 0x1366, productID: 1, product: "J-Link", locationID: 0x200)
        XCTAssertEqual(SerialBoard.group([first, second]).count, 2)
    }

    func testAtMostEightPortsOfABoardAreKept() {
        let ports = (0..<12).map { SerialPortInfo(path: String(format: "/dev/cu.m%02d", $0), vendorID: 0x1366, productID: 1, serialNumber: "S") }
        XCTAssertEqual(SerialBoard.group(ports)[0].ports.count, 8)
    }

    func testTheRealRegistryAnswersWithoutOpeningAnything() {
        // Whatever is plugged in, listing only reads the registry and every entry is a callout path.
        for port in IOKitSerialLister().list() { XCTAssertTrue(port.path.hasPrefix("/dev/cu.")) }
    }
}

/// A pty pair: `slavePath` is opened by the code under test, `master` is the other end.
private final class Pty {
    let master: Int32
    let slavePath: String
    private(set) var slave: Int32

    init() throws {
        var master: Int32 = 0
        var slave: Int32 = 0
        var name = [CChar](repeating: 0, count: 128)
        guard openpty(&master, &slave, &name, nil, nil) == 0 else { throw NSError(domain: "openpty", code: Int(errno)) }
        self.master = master
        self.slave = slave
        slavePath = String(cString: name)
        // Keep the slave open (so the master does not see a hangup before the port is opened) until closeSlave.
        _ = fcntl(master, F_SETFL, O_NONBLOCK)
    }

    func closeSlave() {
        if slave >= 0 { Darwin.close(slave) }
        slave = -1
    }

    func send(_ bytes: [UInt8]) {
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { Darwin.write(master, $0.baseAddress! + offset, bytes.count - offset) }
            if written > 0 { offset += written } else { usleep(1000) }
        }
    }

    /// What the port wrote, read until `count` bytes or the time is up.
    func receive(count: Int, within seconds: TimeInterval = 5) -> [UInt8] {
        var got: [UInt8] = []
        let end = Date().addingTimeInterval(seconds)
        var buffer = [UInt8](repeating: 0, count: 4096)
        while got.count < count, Date() < end {
            let n = buffer.withUnsafeMutableBytes { Darwin.read(master, $0.baseAddress, 4096) }
            if n > 0 { got += buffer[0..<n] } else { usleep(2000) }
        }
        return got
    }

    func closeMaster() { Darwin.close(master) }
}

final class SerialLineTests: XCTestCase {
    private final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var chunks: [Data] = []
        private var endings: [SerialLine.Ending] = []
        func add(_ data: Data) { lock.lock(); chunks.append(data); lock.unlock() }
        func end(_ ending: SerialLine.Ending) { lock.lock(); endings.append(ending); lock.unlock() }
        var all: [Data] { lock.lock(); defer { lock.unlock() }; return chunks }
        var bytes: [UInt8] { all.flatMap { [UInt8]($0) } }
        var ended: [SerialLine.Ending] { lock.lock(); defer { lock.unlock() }; return endings }
    }

    private func wait(_ what: String, _ condition: () -> Bool) {
        let end = Date().addingTimeInterval(5)
        while !condition(), Date() < end { usleep(5000) }
        XCTAssertTrue(condition(), what)
    }

    private func open(_ pty: Pty, _ collector: Collector, baud: Int = 115_200) throws -> SerialLine {
        try SerialLine(path: pty.slavePath, baudRate: baud, onData: collector.add, onEnd: collector.end)
    }

    func testWhatTheBoardSendsArrivesInOrder() throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        defer { line.close(); pty.closeMaster(); pty.closeSlave() }
        pty.send(Array("uart:~$ ".utf8))
        pty.send(Array("help\r\n".utf8))
        wait("the bytes arrive") { collector.bytes.count == 14 }
        XCTAssertEqual(String(decoding: collector.bytes, as: UTF8.self), "uart:~$ help\r\n")
    }

    func testBytesAreRawNotTranslated() throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        defer { line.close(); pty.closeMaster(); pty.closeSlave() }
        let all = (0...255).map { UInt8($0) }
        pty.send(all)
        wait("all 256 values arrive") { collector.bytes.count == 256 }
        XCTAssertEqual(collector.bytes, all)
    }

    func testALongStreamComesInChunksOfAtMostTheReadSize() throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        defer { line.close(); pty.closeMaster(); pty.closeSlave() }
        let big = (0..<20_000).map { UInt8(truncatingIfNeeded: $0 &* 7) }
        DispatchQueue.global().async { pty.send(big) }
        wait("20000 bytes arrive") { collector.bytes.count == big.count }
        XCTAssertEqual(collector.bytes, big)
        XCTAssertTrue(collector.all.allSatisfy { $0.count <= SerialLine.readChunk && !$0.isEmpty })
    }

    func testWritesReachTheBoardWholeAndInOrder() async throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        defer { line.close(); pty.closeMaster(); pty.closeSlave() }
        let first = (0..<12_288).map { UInt8(truncatingIfNeeded: $0 / 3) }
        let second: [UInt8] = [0, 1, 2, 255, 13, 10]
        let reader = Task.detached { pty.receive(count: first.count + second.count) }
        try await line.write(Data(first))
        try await line.write(Data(second))
        let got = await reader.value
        XCTAssertEqual(got, first + second)
    }

    func testClosingStopsTheReadingAndIsNotAnEnding() throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        defer { pty.closeMaster(); pty.closeSlave() }
        line.close()
        line.close()
        pty.send(Array("late".utf8))
        usleep(300_000)
        XCTAssertTrue(collector.bytes.isEmpty)
        XCTAssertTrue(collector.ended.isEmpty)
    }

    func testAWriteAfterCloseFails() async throws {
        let pty = try Pty()
        let line = try open(pty, Collector())
        defer { pty.closeMaster(); pty.closeSlave() }
        line.close()
        do {
            try await line.write(Data([1]))
            XCTFail("a closed port took a write")
        } catch {
            // Expected.
        }
    }

    func testTheBoardGoingAwayEndsThePortOnce() throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        defer { line.close() }
        pty.closeMaster()
        wait("the ending comes") { !collector.ended.isEmpty }
        usleep(700_000)
        XCTAssertEqual(collector.ended.count, 1)
        XCTAssertEqual(collector.ended.first, .unplugged)
        pty.closeSlave()
    }

    func testAPathThatIsNotThereDoesNotOpen() {
        XCTAssertThrowsError(try SerialLine(path: "/dev/cu.cranium-test-none", baudRate: 115_200, onData: { _ in }, onEnd: { _ in })) { error in
            XCTAssertEqual((error as? SerialLine.PortError)?.errno, ENOENT)
        }
    }

    func testTheLineIsRaw8N1WithoutFlowControl() throws {
        let pty = try Pty()
        let line = try open(pty, Collector(), baud: 9_600)
        defer { line.close(); pty.closeMaster(); pty.closeSlave() }
        var attributes = termios()
        XCTAssertEqual(tcgetattr(pty.master, &attributes), 0)
        XCTAssertEqual(attributes.c_cflag & tcflag_t(CSIZE), tcflag_t(CS8))
        XCTAssertEqual(attributes.c_cflag & tcflag_t(PARENB | CSTOPB | CRTSCTS), 0)
        XCTAssertEqual(attributes.c_lflag & tcflag_t(ECHO | ICANON | ISIG), 0)
    }

    // A close (the page's Disconnect) lets go of the port: the descriptor closes and the port opens again.

    private func fileOf(_ fd: Int32) -> stat {
        var info = stat()
        XCTAssertEqual(fstat(fd, &info), 0)
        return info
    }

    private func assertLetGo(_ line: SerialLine, _ was: stat, _ path: String) {
        wait("the descriptor is closed") { !stillOpen(line.fd, as: was) }
        XCTAssertNoThrow(try SerialLine(path: path, baudRate: 115_200, onData: { _ in }, onEnd: { _ in }).close(), "the port opens again")
    }

    func testACloseRightAfterOpenClosesTheDescriptor() throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        let line = try open(pty, Collector())
        let was = fileOf(line.fd)
        line.close()
        assertLetGo(line, was, pty.slavePath)
    }

    func testACloseDuringAWriteClosesTheDescriptor() async throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        let line = try open(pty, Collector())
        let was = fileOf(line.fd)
        // Nobody reads the other end, so the write waits for room that never comes.
        let writing = Task.detached { try await line.write(Data(count: 256 * 1024)) }
        try await Task.sleep(nanoseconds: 300_000_000)
        line.close()
        do {
            try await writing.value
            XCTFail("a write went through a closed port")
        } catch {
            // Expected.
        }
        assertLetGo(line, was, pty.slavePath)
    }

    func testACloseWhileTheBoardTalksClosesTheDescriptor() throws {
        let pty = try Pty()
        let collector = Collector()
        let line = try open(pty, collector)
        let was = fileOf(line.fd)
        let master = pty.master
        let talking = DispatchGroup()
        DispatchQueue.global().async(group: talking) {
            let chunk = [UInt8](repeating: 0x41, count: 512)
            for _ in 0..<2_000 {
                _ = chunk.withUnsafeBytes { Darwin.write(master, $0.baseAddress, chunk.count) }
                usleep(100)
            }
        }
        defer { talking.wait(); pty.closeMaster(); pty.closeSlave() }
        wait("the board's bytes arrive") { !collector.all.isEmpty }
        line.close()
        assertLetGo(line, was, pty.slavePath)
    }
}

/// Whether `fd` is still the descriptor that was open on the file `was` (its fstat then): a closed one, or
/// its number given to another file since, is not.
private func stillOpen(_ fd: Int32, as was: stat) -> Bool {
    var now = stat()
    guard fstat(fd, &now) == 0 else { return false }
    return now.st_dev == was.st_dev && now.st_ino == was.st_ino
}

/// This process's descriptors open on `path`, but for those in `except`.
private func descriptors(on path: String, except: Set<Int32> = []) -> [Int32] {
    var found: [Int32] = []
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    for fd in 0..<getdtablesize() where !except.contains(fd) {
        if fcntl(fd, F_GETPATH, &buffer) == 0, String(cString: buffer) == path { found.append(fd) }
    }
    return found
}

@MainActor
final class MacSerialTests: XCTestCase {
    private final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [(String, [String: JSONValue])] = []
        func add(_ name: String, _ data: [String: JSONValue]) { lock.lock(); items.append((name, data)); lock.unlock() }
        var all: [(String, [String: JSONValue])] { lock.lock(); defer { lock.unlock() }; return items }
        func named(_ name: String) -> [[String: JSONValue]] { all.filter { $0.0 == name }.map(\.1) }
    }

    private let owner = "window-1"
    private let events = Events()

    private func open(_ serial: MacSerial, _ baud: Int = 115_200, as who: String? = nil) async throws -> [String: JSONValue] {
        try await serial.open(baudRate: baud, owner: who ?? owner, emit: events.add)
    }

    private struct FakeLister: SerialPortLister {
        var ports: [SerialPortInfo]
        func list() -> [SerialPortInfo] { ports }
    }

    private func info(_ path: String, serial: String = "S1") -> SerialPortInfo {
        SerialPortInfo(path: path, vendorID: 0x1366, productID: 0x1055, product: "J-Link", serialNumber: serial)
    }

    private func wait(_ what: String, _ condition: () -> Bool) async {
        let end = Date().addingTimeInterval(5)
        while !condition(), Date() < end { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(condition(), what)
    }

    func testTheFirstOpenAsksAndTheConsolePortOpensFirst() async throws {
        let first = try Pty(), second = try Pty()
        defer { [first, second].forEach { $0.closeMaster(); $0.closeSlave() } }
        // Sorted by path, the second is the last: the console.
        let paths = [first.slavePath, second.slavePath].sorted()
        let byPath = [first.slavePath: first, second.slavePath: second]
        var asked = 0
        let serial = MacSerial(lister: FakeLister(ports: paths.map { info($0) }), choose: { boards in
            asked += 1
            return boards.first
        })
        defer { serial.closeAll(owner: owner) }

        let one = try await open(serial, 115_200)
        XCTAssertEqual(one["port"], .int(1))
        XCTAssertEqual(one["ports"], .int(2))
        let two = try await open(serial, 115_200)
        XCTAssertEqual(two["port"], .int(0))
        XCTAssertEqual(asked, 1, "the person is asked the first time only")
        do {
            _ = try await open(serial, 115_200)
            XCTFail("a third open of two ports")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .busy)
        }

        let consolePty = try XCTUnwrap(byPath[paths[1]])
        consolePty.send(Array("hello".utf8))
        await wait("usb.data arrives") { !events.named("usb.data").isEmpty }
        let data = try XCTUnwrap(events.named("usb.data").first)
        XCTAssertEqual(data["port"], .int(1))
        XCTAssertEqual(data["data"], .string(Data("hello".utf8).base64EncodedString()))
    }

    func testWritesGoToThePortAndBadOnesAreRefused() async throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        let serial = MacSerial(lister: FakeLister(ports: [info(pty.slavePath)]), choose: { $0.first })
        defer { serial.closeAll(owner: owner) }
        _ = try await open(serial, 115_200)
        try await serial.write(port: 0, base64: Data("ping\n".utf8).base64EncodedString(), owner: owner)
        XCTAssertEqual(pty.receive(count: 5), Array("ping\n".utf8))
        do {
            try await serial.write(port: 0, base64: "***", owner: owner)
            XCTFail("not base64")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .badRequest)
        }
        do {
            try await serial.write(port: 3, base64: "AA==", owner: owner)
            XCTFail("not open")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .failed)
        }
    }

    func testCloseFreesThePortAndSendsNothing() async throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        let serial = MacSerial(lister: FakeLister(ports: [info(pty.slavePath)]), choose: { $0.first })
        defer { serial.closeAll(owner: owner) }
        _ = try await open(serial, 115_200)
        serial.close(port: 0, owner: owner)
        serial.close(port: 0, owner: owner)
        XCTAssertEqual(serial.openPorts, [])
        let again = try await open(serial, 9_600)
        XCTAssertEqual(again["port"], .int(0))
        XCTAssertTrue(events.named("usb.closed").isEmpty)
    }

    func testUnpluggingTellsThePageAndFreesThePort() async throws {
        let pty = try Pty()
        let serial = MacSerial(lister: FakeLister(ports: [info(pty.slavePath)]), choose: { $0.first })
        defer { serial.closeAll(owner: owner); pty.closeSlave() }
        _ = try await open(serial, 115_200)
        pty.closeMaster()
        await wait("usb.closed arrives") { !events.named("usb.closed").isEmpty }
        let closed = try XCTUnwrap(events.named("usb.closed").first)
        XCTAssertEqual(closed["port"], .int(0))
        XCTAssertEqual(closed["reason"], .string("unplugged"))
        XCTAssertEqual(serial.openPorts, [])
        XCTAssertEqual(events.named("usb.closed").count, 1)
    }

    func testNoBoardAndNoChoiceAreSaidInWords() async {
        let none = MacSerial(lister: FakeLister(ports: []), choose: { $0.first })
        do {
            _ = try await open(none, 115_200)
            XCTFail("no board")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .failed)
            XCTAssertTrue(error.message.contains("No SEGGER J-Link found"))
        } catch {
            XCTFail("\(error)")
        }
        let refused = MacSerial(lister: FakeLister(ports: [info("/dev/cu.cranium-test-none")]), choose: { _ in nil })
        do {
            _ = try await open(refused, 115_200)
            XCTFail("the person said no")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .cancelled)
        } catch {
            XCTFail("\(error)")
        }
    }

    func testAPortThatWillNotOpenIsFailedNotCrashed() async {
        let serial = MacSerial(lister: FakeLister(ports: [info("/dev/cu.cranium-test-none")]), choose: { $0.first })
        do {
            _ = try await open(serial, 115_200)
            XCTFail("no such port")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .failed)
        } catch {
            XCTFail("\(error)")
        }
    }

    func testAPortBelongsToTheWindowThatOpenedItAndIsBusyInTheOthers() async throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        let serial = MacSerial(lister: FakeLister(ports: [info(pty.slavePath)]), choose: { $0.first })
        let other = "window-2"
        defer { serial.closeAll(owner: owner); serial.closeAll(owner: other) }
        _ = try await open(serial, 115_200)
        do {
            _ = try await open(serial, 115_200, as: other)
            XCTFail("the only port is open in the first window")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .busy)
        }
        // The other window can neither write to it nor close it.
        do {
            try await serial.write(port: 0, base64: "AA==", owner: other)
            XCTFail("not its port")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .failed)
        }
        serial.close(port: 0, owner: other)
        XCTAssertEqual(serial.openPorts, [0])
        serial.closeAll(owner: other)
        XCTAssertEqual(serial.openPorts, [0])
        // The first window's page is left: its port is free for the other.
        serial.closeAll(owner: owner)
        let taken = try await open(serial, 115_200, as: other)
        XCTAssertEqual(taken["port"], .int(0))
    }

    func testAPageLeftWhileTheSheetIsUpOpensNothing() async throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        var release: CheckedContinuation<SerialBoard?, Never>?
        let serial = MacSerial(lister: FakeLister(ports: [info(pty.slavePath)]), choose: { boards in
            await withCheckedContinuation { release = $0 }
        })
        let asked = Task { try await self.open(serial, 115_200) }
        await wait("the sheet is up") { release != nil }
        // The page reloads while the person is still choosing, then the person chooses.
        serial.closeAll(owner: owner)
        release?.resume(returning: SerialBoard.group([info(pty.slavePath)]).first)
        do {
            _ = try await asked.value
            XCTFail("the port opened for a page that was gone")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .cancelled)
        }
        XCTAssertEqual(serial.openPorts, [])
    }

    func testDisconnectClosesThePortsDescriptor() async throws {
        let pty = try Pty()
        defer { pty.closeMaster(); pty.closeSlave() }
        let serial = MacSerial(lister: FakeLister(ports: [info(pty.slavePath)]), choose: { $0.first })
        defer { serial.closeAll(owner: owner) }
        _ = try await open(serial, 115_200)
        XCTAssertEqual(descriptors(on: pty.slavePath, except: [pty.slave]).count, 1)
        // A write the board is not taking is under way when Disconnect is pressed.
        let who = owner
        let big = Data(count: 256 * 1024).base64EncodedString()
        let writing = Task { try await serial.write(port: 0, base64: big, owner: who) }
        try await Task.sleep(nanoseconds: 200_000_000)
        // usb.close, as the page's Disconnect sends it.
        serial.close(port: 0, owner: owner)
        await wait("the descriptor is closed") { descriptors(on: pty.slavePath, except: [pty.slave]).isEmpty }
        do {
            try await writing.value
            XCTFail("a write went through a closed port")
        } catch {
            // Expected.
        }
        let again = try await open(serial, 115_200)
        XCTAssertEqual(again["port"], .int(0))
    }

    /// Disconnect while another program also has the port open (pyserial and screen open a port shared): the
    /// kernel keeps a port's exclusive use until the last descriptor on it closes, so up to 0.4.0 the port then
    /// refused every open, the app's own too, until that program let go (issue #289). A pseudo-terminal does
    /// not enforce exclusive use for a user who is not root, so this takes a real serial device: the Mac's own
    /// Bluetooth incoming port, opened and closed with nothing written. Skipped on a Mac without one.
    func testDisconnectEndsExclusiveUseWhileAnotherProgramHasThePort() async throws {
        let path = "/dev/cu.Bluetooth-Incoming-Port"
        let other = Darwin.open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        try XCTSkipIf(other < 0, "no serial device to try on this Mac")
        defer { Darwin.close(other) }
        let serial = MacSerial(lister: FakeLister(ports: [info(path)]), choose: { $0.first })
        defer { serial.closeAll(owner: owner) }
        _ = try await open(serial, 115_200)
        XCTAssertEqual(descriptors(on: path, except: [other]).count, 1)
        serial.close(port: 0, owner: owner)
        await wait("the app's descriptor is closed") { descriptors(on: path, except: [other]).isEmpty }
        let fresh = Darwin.open(path, O_RDWR | O_NOCTTY | O_NONBLOCK)
        let code = errno
        XCTAssertGreaterThanOrEqual(fresh, 0, "the port refused another program after Disconnect (errno \(code))")
        if fresh >= 0 { Darwin.close(fresh) }
        let again = try await open(serial, 115_200)
        XCTAssertEqual(again["port"], .int(0), "the app opens it again itself")
    }
}

final class MacRoutesTests: XCTestCase {
    func testTheFirstNineSectionsHaveCommandKeys() {
        XCTAssertEqual(MacRoutes.shortcuts.count, 9)
        XCTAssertEqual((0..<9).compactMap(MacRoutes.key(at:)).map(String.init), ["1", "2", "3", "4", "5", "6", "7", "8", "9"])
        XCTAssertNil(MacRoutes.key(at: 9))
        XCTAssertEqual(MacRoutes.shortcuts.map(\.route).prefix(3), ["overview", "devices", "map"])
        XCTAssertTrue(MacRoutes.shortcuts.map(\.route).contains("serial"))
        let all = (MacRoutes.shortcuts + MacRoutes.others).map(\.route)
        XCTAssertEqual(Set(all).count, all.count)
        XCTAssertTrue(all.allSatisfy { $0.range(of: "^[a-z]{1,20}$", options: .regularExpression) != nil })
    }

    func testABoardsPageIsFoundAndNothingElseIs() {
        XCTAssertEqual(MacRoutes.thing(inFragment: "/devices/cranium-0123456789abcdef"), "cranium-0123456789abcdef")
        XCTAssertNil(MacRoutes.thing(inFragment: "/devices"))
        XCTAssertNil(MacRoutes.thing(inFragment: "/serial"))
        XCTAssertNil(MacRoutes.thing(inFragment: "/devices/a b"))
        XCTAssertNil(MacRoutes.thing(inFragment: "/devices/x?y=1"))
        XCTAssertNil(MacRoutes.thing(inFragment: nil))
        XCTAssertEqual(MacRoutes.boardURL("cranium-1")?.absoluteString, "cranium-app://bundle/admin#/devices/cranium-1")
        XCTAssertNil(MacRoutes.boardURL("../x"))
    }
}

final class MacKeepAwakeTests: XCTestCase {
    func testTheAssertionIsTakenOnceAndLetGo() {
        let awake = MacKeepAwake()
        awake.set(false)
        XCTAssertFalse(awake.isHeld)
        awake.set(true)
        awake.set(true)
        XCTAssertTrue(awake.isHeld)
        awake.set(false)
        awake.set(false)
        XCTAssertFalse(awake.isHeld)
    }
}

@MainActor
final class MacRadioHubTests: XCTestCase {
    private final class Inbox: @unchecked Sendable {
        var items: [String] = []
        func add(_ name: String, _ data: [String: JSONValue]) { items.append(name) }
    }

    private func make() -> (MacRadioHub, Inbox, Inbox) {
        let hub = MacRadioHub()
        let one = Inbox(), two = Inbox()
        hub.register("one", emit: one.add)
        hub.register("two", emit: two.add)
        return (hub, one, two)
    }

    func testTheHolderKeepsTheEventsAndTheOtherGetsNone() throws {
        let (hub, one, two) = make()
        try hub.claim("one")
        hub.deliver("ble.progress", ["sent": 1, "total": 2])
        hub.deliver("ble.boards", ["boards": []])
        XCTAssertEqual(one.items, ["ble.progress", "ble.boards"])
        XCTAssertTrue(two.items.isEmpty)
        // Another window cannot take it, or use it.
        XCTAssertThrowsError(try hub.claim("two")) { XCTAssertEqual(($0 as? BridgeError)?.code, .busy) }
        hub.deliver("ble.progress", ["sent": 2, "total": 2])
        XCTAssertEqual(one.items.count, 3)
        XCTAssertTrue(two.items.isEmpty)
    }

    func testAnotherWindowCannotCancelOrDisconnectTheHoldersUpload() throws {
        let (hub, _, _) = make()
        try hub.claim("one")
        XCTAssertThrowsError(try hub.require("two")) { XCTAssertEqual(($0 as? BridgeError)?.code, .busy) }
        XCTAssertNoThrow(try hub.require("one"))
        // Nobody else's release counts either.
        XCTAssertFalse(hub.release("two"))
        XCTAssertTrue(hub.owns("one"))
    }

    func testNobodyHoldingMeansAnyWindowMayClaim() throws {
        let (hub, _, _) = make()
        XCTAssertNoThrow(try hub.require("two"))
        try hub.claim("two")
        XCTAssertTrue(hub.owns("two"))
        try hub.claim("two")
    }

    func testLetGoOnPageLeaveOrCloseFreesItForTheOther() throws {
        let (hub, one, two) = make()
        try hub.claim("one")
        XCTAssertTrue(hub.release("one"))
        XCTAssertNoThrow(try hub.claim("two"))
        hub.deliver("ble.progress", [:])
        XCTAssertTrue(one.items.isEmpty)
        XCTAssertEqual(two.items, ["ble.progress"])
        // A closed window holds nothing and hears nothing.
        XCTAssertTrue(hub.release("two"))
        hub.unregister("two")
        try hub.claim("one")
        hub.deliver("ble.boards", [:])
        XCTAssertEqual(one.items, ["ble.boards"])
    }

    func testALinkThatDropsLetsTheRadioGoAndStoppingAScanDoesNotDropALink() throws {
        let (hub, one, _) = make()
        try hub.claim("one")
        hub.deliver("ble.link", ["state": "connected", "name": "x", "error": .null])
        hub.stoppedUsing("one")
        XCTAssertTrue(hub.owns("one"), "a scan stopped while linked keeps the radio")
        hub.deliver("ble.link", ["state": "disconnected", "name": "x", "error": .null])
        XCTAssertEqual(one.items, ["ble.link", "ble.link"])
        XCTAssertNil(hub.owner)
        XCTAssertNoThrow(try hub.claim("two"))
        hub.stoppedUsing("two")
        XCTAssertNil(hub.owner, "a scan alone is let go when stopped")
    }
}
