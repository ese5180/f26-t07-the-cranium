import CoreBluetooth
import CraniumKit
import Foundation

/// After a send, the board's status once it has restarted: from firmware 1.14.0 it advertises its
/// status service for 2 minutes after the restart that the update asked for, into the new image or back
/// into the old one, and any phone may read it with no pairing (docs/mobile-apps.md, "The status
/// characteristic"). Its name and its address are new by then, so each board that advertises it is
/// read once, and only the one whose status is about this send (`accept`) is followed: its status is
/// read, and each change is notified, until the link goes. Then this looks again, because a board on
/// trial restarts once more if the trial fails.
///
/// Nothing here pairs, or writes anything but the notifications' descriptor. Everything runs on the main
/// queue, where CoreBluetooth calls back.
public final class StatusWatcher: NSObject, @unchecked Sendable {
    /// How long a connection or a first read may take before the next board gets its turn.
    static let stepTimeout: TimeInterval = 10

    private unowned let radio: BoardRadio
    private let accept: @Sendable (BoardStatus) -> Bool
    private let onStatus: @Sendable (BoardStatus) -> Void

    private enum Phase { case idle, scanning, connecting, reading, following }
    private var phase: Phase = .idle
    private var peripheral: CBPeripheral?
    /// Boards whose status was about something else, for as long as this watcher looks.
    private var rejected: Set<UUID> = []
    private var attempt = 0

    private static let characteristicUUID = CBUUID(string: BoardStatus.characteristicUUID)

    /// `accept` says whether a status is about this send; `onStatus` gets every one of those.
    public init(radio: BoardRadio, accept: @escaping @Sendable (BoardStatus) -> Bool,
                onStatus: @escaping @Sendable (BoardStatus) -> Void) {
        self.radio = radio
        self.accept = accept
        self.onStatus = onStatus
    }

    public func start() {
        DispatchQueue.main.async { self.look() }
    }

    public func stop() {
        DispatchQueue.main.async {
            self.phase = .idle
            self.attempt += 1
            self.radio.stopStatusScan()
            self.letGo()
        }
    }

    // MARK: -

    private func look() {
        letGo()
        phase = .scanning
        radio.startStatusScan { [weak self] found in self?.found(found) }
    }

    private func found(_ candidate: CBPeripheral) {
        guard phase == .scanning, !rejected.contains(candidate.identifier) else { return }
        radio.stopStatusScan()
        phase = .connecting
        peripheral = candidate
        radio.register(self, for: candidate)
        radio.connectForStatus(candidate)
        armTimeout()
    }

    /// The step under way gives up after `stepTimeout`, and the next board gets its turn.
    private func armTimeout() {
        attempt += 1
        let token = attempt
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stepTimeout) { [weak self] in
            guard let self, self.attempt == token, self.phase == .connecting || self.phase == .reading else { return }
            self.look()
        }
    }

    /// Its link, if any, goes, and what CoreBluetooth says of it after that is no longer heard.
    private func letGo() {
        if let peripheral {
            peripheral.delegate = nil
            radio.unregister(peripheral)
            radio.cancel(peripheral)
        }
        peripheral = nil
    }

    private func reject() {
        if let peripheral { rejected.insert(peripheral.identifier) }
        look()
    }
}

extension StatusWatcher: RadioLink {
    func radioDidConnect() {
        guard phase == .connecting, let peripheral else { return }
        phase = .reading
        peripheral.delegate = self
        peripheral.discoverServices([BoardRadio.statusServiceUUID])
        armTimeout()
    }

    func radioDidFailToConnect(_ error: Error?) {
        guard phase == .connecting else { return }
        look()
    }

    func radioDidDisconnect(_ error: Error?) {
        guard phase != .idle else { return }
        look()
    }

    /// Bluetooth went off: the radio looks again by itself once it is back.
    func radioWentAway(_ state: RadioState) {
        guard phase != .idle else { return }
        peripheral?.delegate = nil
        peripheral = nil
        phase = .scanning
        attempt += 1
    }
}

extension StatusWatcher: CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard phase == .reading else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == BoardRadio.statusServiceUUID }) else {
            reject()
            return
        }
        peripheral.discoverCharacteristics([Self.characteristicUUID], for: service)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard phase == .reading else { return }
        guard error == nil, let characteristic = service.characteristics?.first(where: { $0.uuid == Self.characteristicUUID }) else {
            reject()
            return
        }
        peripheral.readValue(for: characteristic)
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard phase == .reading || phase == .following, characteristic.uuid == Self.characteristicUUID else { return }
        guard error == nil, let value = characteristic.value, let status = BoardStatus.parse(value) else {
            if phase == .reading { reject() }
            return
        }
        if phase == .reading {
            guard accept(status) else {
                reject()
                return
            }
            phase = .following
            attempt += 1
            if characteristic.properties.contains(.notify) { peripheral.setNotifyValue(true, for: characteristic) }
        }
        onStatus(status)
    }
}
