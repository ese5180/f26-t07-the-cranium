import CoreBluetooth
import CraniumKit
import Foundation

/// A board seen advertising the SMP service as `Cranium-XXXX`.
public struct DiscoveredBoard: Identifiable, Hashable, Sendable {
    /// CoreBluetooth's identifier for it on this phone. The board's address is a resolvable
    /// private one, so this can change between windows.
    public let id: UUID
    public let name: String
    public var rssi: Int
    public var lastSeen: Date
}

public enum RadioState: Equatable, Sendable {
    case starting
    case ready
    case off
    case unauthorized
    case unsupported

    /// What to tell the person, or nil when Bluetooth can be used.
    public var problem: String? {
        switch self {
        case .starting, .ready: return nil
        case .off: return "Bluetooth is off. Turn it on in Control Center or Settings."
        case .unauthorized: return "Cranium may not use Bluetooth. Allow it in Settings, Privacy & Security, Bluetooth."
        case .unsupported: return "This phone has no Bluetooth LE."
        }
    }
}

/// The app's one `CBCentralManager`: it scans for boards by the SMP service UUID, and connects to
/// the one picked so that it can pair. Everything runs on the main queue.
public final class BoardRadio: NSObject, @unchecked Sendable {
    public private(set) var state: RadioState = .starting
    public private(set) var boards: [DiscoveredBoard] = []

    /// Called on the main queue.
    public var onChange: (() -> Void)?

    /// A board not heard for this long drops off the list: its window has closed, or a phone
    /// has connected to it, which stops its advertising.
    public var forgetAfter: TimeInterval = 10

    private var central: CBCentralManager!
    private var peripherals: [UUID: CBPeripheral] = [:]
    private var links: [UUID: WeakLink] = [:]
    private var wantsScan = false
    private var pruneTimer: Timer?

    private struct WeakLink { weak var link: McuMgrBoardTransport? }

    private static let serviceUUID = CBUUID(string: SMP.serviceUUID)

    public override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: true])
    }

    /// Starts looking, with an empty list. Call on the main queue.
    public func startScanning() {
        wantsScan = true
        boards = []
        onChange?()
        scanIfReady()
        pruneTimer?.invalidate()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.prune()
        }
    }

    public func stopScanning() {
        wantsScan = false
        pruneTimer?.invalidate()
        pruneTimer = nil
        if central.state == .poweredOn {
            central.stopScan()
        }
    }

    /// The transport for a board on the list. Connecting stops the scan.
    public func transport(for board: DiscoveredBoard) -> McuMgrBoardTransport? {
        guard let peripheral = peripherals[board.id] else { return nil }
        let link = McuMgrBoardTransport(name: board.name, peripheral: peripheral, radio: self)
        links[board.id] = WeakLink(link: link)
        return link
    }

    // MARK: Used by McuMgrBoardTransport, on the main queue

    var isReady: Bool { central.state == .poweredOn }

    func connect(_ peripheral: CBPeripheral) {
        stopScanning()
        central.connect(peripheral, options: nil)
    }

    func cancel(_ peripheral: CBPeripheral) {
        if peripheral.state == .connected || peripheral.state == .connecting {
            central.cancelPeripheralConnection(peripheral)
        }
    }

    // MARK: -

    private func scanIfReady() {
        guard wantsScan, central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [Self.serviceUUID],
                                   options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    private func prune() {
        let cutoff = Date().addingTimeInterval(-forgetAfter)
        let kept = boards.filter { $0.lastSeen >= cutoff }
        if kept.count != boards.count {
            boards = kept
            onChange?()
        }
    }
}

extension BoardRadio: CBCentralManagerDelegate {
    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: state = .ready
        case .poweredOff, .resetting: state = .off
        case .unauthorized: state = .unauthorized
        case .unsupported: state = .unsupported
        case .unknown: state = .starting
        @unknown default: state = .starting
        }
        if state == .ready {
            scanIfReady()
        } else {
            boards = []
            for entry in links.values { entry.link?.radioWentAway(state) }
        }
        onChange?()
    }

    public func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                               advertisementData: [String: Any], rssi RSSI: NSNumber) {
        // The name is what identifies a board in its window; anything else is not one of ours.
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name
        guard let name, BoardName.isValid(name) else { return }
        let rssi = RSSI.intValue == 127 ? -127 : RSSI.intValue  // 127: not available
        peripherals[peripheral.identifier] = peripheral
        let seen = DiscoveredBoard(id: peripheral.identifier, name: name, rssi: rssi, lastSeen: Date())
        if let index = boards.firstIndex(where: { $0.id == peripheral.identifier }) {
            boards[index] = seen
        } else {
            boards.append(seen)
            boards.sort { $0.name < $1.name }
        }
        onChange?()
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        links[peripheral.identifier]?.link?.radioDidConnect()
    }

    public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        links[peripheral.identifier]?.link?.radioDidFailToConnect(error)
    }

    public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        links[peripheral.identifier]?.link?.radioDidDisconnect(error)
    }
}
