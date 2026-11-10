import CoreBluetooth
import CraniumKit
import Foundation

/// A direct link to one board for offline mode (firmware 1.19.0): connect, read its status, accept the
/// update that waits. Reading the status needs a link paired with the board's own passkey, so the
/// first read is what makes iOS ask for it: the system's pairing box takes the passkey that Board
/// setup showed, and the read goes through once it is right. Nothing is bonded by the board, so the
/// next window asks again. The passkey never passes through this app. Everything runs on the main
/// queue, where CoreBluetooth calls back.
public final class OfflineLink: NSObject, @unchecked Sendable {
    public enum State: Equatable, Sendable {
        case connecting
        /// Waiting for the person to type the passkey into the system's box.
        case pairing
        case ready(OfflineStatus)
        /// The write was accepted by the board; the next status says how it went.
        case accepted
        case failed(String)
    }

    /// How long a step may take before the person is told, in seconds.
    static let stepTimeout: TimeInterval = 40
    /// How often the status is read again while the link is up.
    static let refresh: TimeInterval = 3

    public var onState: ((State) -> Void)?
    /// Each status as the board sent it, for the console's Offline page (bridge.json, ble.offline.*), which reads it itself.
    public var onPayload: ((Data) -> Void)?
    /// The status the board sent last, as it sent it.
    public private(set) var lastPayload: Data?
    private var accepting: ((String?) -> Void)?
    public let name: String

    private unowned let radio: BoardRadio
    private let peripheral: CBPeripheral
    private var statusCharacteristic: CBCharacteristic?
    private var controlCharacteristic: CBCharacteristic?
    private var timer: Timer?
    private var attempt = 0
    private var done = false
    private var last: OfflineStatus?

    private static let serviceUUID = CBUUID(string: OfflineStatus.serviceUUID)
    private static let statusUUID = CBUUID(string: OfflineStatus.statusUUID)
    private static let controlUUID = CBUUID(string: OfflineStatus.controlUUID)

    init(name: String, peripheral: CBPeripheral, radio: BoardRadio) {
        self.name = name
        self.peripheral = peripheral
        self.radio = radio
        super.init()
    }

    public func connect() {
        guard radio.isReady else {
            finish(.failed(RadioState.off.problem ?? "Bluetooth is not ready."))
            return
        }
        onState?(.connecting)
        radio.register(self, for: peripheral)
        peripheral.delegate = self
        radio.connect(peripheral)
        armTimeout(because: "The board did not answer. Hold its button 1 for five seconds to open Bluetooth again.")
    }

    /// Accept the update that waits, naming the version the person saw. Asks again for the status after.
    /// `done` is called once the board answered: nil when it took it, else why not, in words.
    public func accept(version: String, done: @escaping (String?) -> Void = { _ in }) {
        guard let control = controlCharacteristic, let request = OfflineStatus.acceptRequest(version: version) else {
            done("This board cannot take that.")
            return
        }
        guard accepting == nil else {
            done("The board is answering the last one.")
            return
        }
        accepting = done
        peripheral.writeValue(request, for: control, type: .withResponse)
    }

    /// Reads the status again now; the answer comes as the next state and payload.
    public func refresh() {
        readStatus()
    }

    public func close() {
        done = true
        accepting?("The link to the board was closed.")
        accepting = nil
        timer?.invalidate()
        timer = nil
        peripheral.delegate = nil
        radio.unregister(peripheral)
        radio.cancel(peripheral)
    }

    // MARK: -

    private func armTimeout(because text: String) {
        attempt += 1
        let token = attempt
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stepTimeout) { [weak self] in
            guard let self, self.attempt == token, !self.done else { return }
            self.finish(.failed(text))
        }
    }

    private func finish(_ state: State) {
        if case .failed = state { close() }
        onState?(state)
    }

    private func readStatus() {
        guard !done, let characteristic = statusCharacteristic else { return }
        peripheral.readValue(for: characteristic)
    }

    private func startRefreshing() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.refresh, repeats: true) { [weak self] _ in
            self?.readStatus()
        }
    }

    /// What to tell the person for a read the board refused.
    static func words(for error: Error) -> String {
        let code = (error as NSError).code
        if (error as NSError).domain == CBATTErrorDomain {
            switch CBATTError.Code(rawValue: code) {
            case .insufficientAuthentication, .insufficientEncryption:
                return "The board needs its passkey. Try again and type the passkey that Board setup showed."
            default: break
            }
        }
        if (error as NSError).domain == CBErrorDomain, code == CBError.peerRemovedPairingInformation.rawValue {
            return "This phone has an old pairing with the board. Forget it in Settings, Bluetooth, and try again."
        }
        return "The board refused: \(error.localizedDescription)"
    }
}

extension OfflineLink: RadioLink {
    func radioDidConnect() {
        guard !done else { return }
        onState?(.pairing)
        peripheral.discoverServices([Self.serviceUUID])
        armTimeout(because: "The board did not pair. Check the passkey, and open Bluetooth on the board again.")
    }

    func radioDidFailToConnect(_ error: Error?) {
        finish(.failed("Could not connect to the board."))
    }

    func radioDidDisconnect(_ error: Error?) {
        guard !done else { return }
        finish(.failed("The board closed the link. It does that when its Bluetooth window ends."))
    }

    func radioWentAway(_ state: RadioState) {
        finish(.failed(state.problem ?? "Bluetooth went away."))
    }
}

extension OfflineLink: CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard !done else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            finish(.failed("This board's firmware has no offline mode. It needs 1.19.0 or later."))
            return
        }
        peripheral.discoverCharacteristics([Self.statusUUID, Self.controlUUID], for: service)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard !done else { return }
        statusCharacteristic = service.characteristics?.first { $0.uuid == Self.statusUUID }
        controlCharacteristic = service.characteristics?.first { $0.uuid == Self.controlUUID }
        guard error == nil, statusCharacteristic != nil, controlCharacteristic != nil else {
            finish(.failed("This board's offline mode is not what this app expects."))
            return
        }
        // The first read is what makes the phone pair: iOS asks for the passkey and retries it.
        readStatus()
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard !done, characteristic.uuid == Self.statusUUID else { return }
        if let error {
            finish(.failed(Self.words(for: error)))
            return
        }
        guard let value = characteristic.value, let status = OfflineStatus.parse(value) else {
            finish(.failed("The board sent something this app cannot read. Update the app."))
            return
        }
        attempt += 1
        if last == nil { startRefreshing() }
        last = status
        lastPayload = value
        onPayload?(value)
        onState?(.ready(status))
    }

    public func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard !done, characteristic.uuid == Self.controlUUID else { return }
        if let error {
            let code = (error as NSError).code
            // The board answers 'unlikely error' when nothing waits or another version does.
            let text = code == Int(CBATTError.unlikelyError.rawValue)
                ? "That update no longer waits. Look at the board's status again."
                : Self.words(for: error)
            let answer = accepting
            accepting = nil
            if let answer { answer(text) } else { onState?(.failed(text)) }
            return
        }
        let answer = accepting
        accepting = nil
        answer?(nil)
        onState?(.accepted)
        readStatus()
    }
}
