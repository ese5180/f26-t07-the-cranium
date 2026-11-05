import CoreBluetooth
import CraniumKit
import Foundation
import iOSMcuManagerLibrary

/// `BoardTransport` over Bluetooth LE, with Nordic's iOSMcuManagerLibrary for SMP.
///
/// Pairing is done here, before MCUmgr is involved: the app's own central connects, finds the
/// SMP characteristic, and turns on its notifications. The board only lets an authenticated
/// link do that, so iOS pairs first and shows its passkey prompt, and this waits for as long as
/// the board does (45 s), where the library would give up after 20. Once the link is
/// authenticated, the library's transport (which has a central of its own) uses the same link.
///
/// After that only two commands are sent: image list, and image upload through
/// `ImageManager.upload`, which sends nothing but upload packets. The library's
/// `FirmwareUpgradeManager` is not used: it asks for parameters, may erase or reset, and ends with
/// a test, all of which the board refuses.
///
/// From firmware 1.14.0 the board also has its status characteristic (`BoardStatus`), in a service of
/// its own. Once paired, this reads it and asks for its notifications, which needs no pairing, and hands
/// each one to `observeStatus`. A board without it is followed as before.
///
/// All state is touched on the main queue only, where CoreBluetooth and the library call back.
public final class McuMgrBoardTransport: NSObject, BoardTransport, @unchecked Sendable {
    public let name: String
    private let peripheral: CBPeripheral
    private unowned let radio: BoardRadio

    /// How long to wait for the connection itself. A board whose window has closed does not
    /// advertise, and iOS would wait for it forever.
    static let connectTimeout: TimeInterval = 15
    /// How long to wait for pairing, from the first touch of the characteristic. The board drops
    /// a phone that has not finished pairing after 45 s.
    static let pairingTimeout: TimeInterval = 50

    private enum Phase { case idle, connecting, discovering, pairing, ready, closed }
    private var phase: Phase = .idle
    private var attempt = 0
    private var pending: CheckedContinuation<Void, Error>?
    private var uploadDone: CheckedContinuation<Void, Error>?
    private var progress: (@Sendable (UploadProgress) -> Void)?

    private var smp: McuMgrBleTransport?
    private var images: ImageManager?
    private var statusService: CBService?
    private var statusHandler: (@Sendable (BoardStatus) -> Void)?

    init(name: String, peripheral: CBPeripheral, radio: BoardRadio) {
        self.name = name
        self.peripheral = peripheral
        self.radio = radio
    }

    // MARK: BoardTransport

    public func connect() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.main.async { self.beginConnect(continuation) }
        }
    }

    public func readImageState() async throws -> [ImageSlot] {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[ImageSlot], Error>) in
            DispatchQueue.main.async {
                guard let images = self.images, self.phase == .ready else {
                    continuation.resume(throwing: BoardError.disconnected)
                    return
                }
                images.list { response, error in
                    if let error {
                        continuation.resume(throwing: BoardErrors.map(error, duringUpload: false))
                    } else if let response, let failure = response.getError() {
                        continuation.resume(throwing: BoardErrors.map(failure, duringUpload: false))
                    } else if let response {
                        continuation.resume(returning: (response.images ?? []).map(Self.slot))
                    } else {
                        continuation.resume(throwing: BoardError.failed("The board's image list was empty."))
                    }
                }
            }
        }
    }

    public func upload(_ image: VerifiedImage, progress: @escaping @Sendable (UploadProgress) -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.main.async { self.beginUpload(image, progress: progress, continuation) }
        }
    }

    public func disconnect() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async {
                self.close(with: BoardError.disconnected)
                continuation.resume()
            }
        }
    }

    public func observeStatus(_ handler: @escaping @Sendable (BoardStatus) -> Void) {
        DispatchQueue.main.async { self.statusHandler = handler }
    }

    // MARK: Connecting and pairing

    private func beginConnect(_ continuation: CheckedContinuation<Void, Error>) {
        guard phase == .idle else {
            continuation.resume(throwing: BoardError.failed("This board has already been connected. Pick it again from the list."))
            return
        }
        guard radio.isReady else {
            continuation.resume(throwing: BoardError.bluetoothUnavailable(radio.state.problem ?? "Bluetooth is not ready."))
            return
        }
        pending = continuation
        phase = .connecting
        radio.connect(peripheral)
        armTimeout(Self.connectTimeout, phase: .connecting, error: .notFound)
    }

    /// Fails the step under way if it is still the same one after `seconds`.
    private func armTimeout(_ seconds: TimeInterval, phase expected: Phase, error: BoardError) {
        attempt += 1
        let token = attempt
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.attempt == token, self.phase == expected else { return }
            self.close(with: error)
        }
    }

    func radioDidConnect() {
        guard phase == .connecting else { return }
        phase = .discovering
        peripheral.delegate = self
        peripheral.discoverServices([CBUUID(string: SMP.serviceUUID), BoardRadio.statusServiceUUID])
        armTimeout(Self.connectTimeout, phase: .discovering, error: .timedOut)
    }

    func radioDidFailToConnect(_ error: Error?) {
        close(with: .notFound)
    }

    func radioDidDisconnect(_ error: Error?) {
        switch phase {
        case .connecting: close(with: .notFound)
        // The board drops a phone that fails to pair: a wrong passkey, or too slow.
        case .discovering, .pairing: close(with: .pairingFailed)
        default: close(with: .disconnected)
        }
    }

    func radioWentAway(_ state: RadioState) {
        close(with: .bluetoothUnavailable(state.problem ?? "Bluetooth stopped."))
    }

    private func characteristicFound(_ characteristic: CBCharacteristic) {
        guard characteristic.properties.contains(.notify),
              characteristic.properties.contains(.writeWithoutResponse) else {
            close(with: .failed("The board's SMP characteristic is not write-without-response and notify."))
            return
        }
        phase = .pairing
        // The board's characteristic and its notifications need an authenticated link, so this is
        // where iOS pairs, and asks for the passkey.
        peripheral.setNotifyValue(true, for: characteristic)
        armTimeout(Self.pairingTimeout, phase: .pairing, error: .pairingFailed)
    }

    private func paired() {
        guard phase == .pairing else { return }
        let configuration = SMPUUIDs()
        let transport = McuMgrBleTransport(peripheral.identifier, configuration)
        smp = transport
        images = ImageManager(transport: transport)
        phase = .ready
        resumePending(with: nil)
        if let statusService {
            peripheral.discoverCharacteristics([CBUUID(string: BoardStatus.characteristicUUID)], for: statusService)
        }
    }

    // MARK: Upload

    private func beginUpload(_ image: VerifiedImage, progress: @escaping @Sendable (UploadProgress) -> Void,
                             _ continuation: CheckedContinuation<Void, Error>) {
        guard let images, phase == .ready else {
            continuation.resume(throwing: BoardError.disconnected)
            return
        }
        guard uploadDone == nil else {
            continuation.resume(throwing: UpdateError.busy)
            return
        }
        uploadDone = continuation
        self.progress = progress
        // Image 0, to the secondary slot. No pipelining, no reassembly (the board has none), so
        // each SMP packet fits in one write of the negotiated MTU. The mode is upload-only;
        // ImageManager does not look at it, but nothing here may ever test, confirm or reset.
        let configuration = FirmwareUpgradeConfiguration(
            eraseAppSettings: false, pipelineDepth: 1, byteAlignment: .disabled,
            reassemblyBufferSize: 0, upgradeMode: .uploadOnly)
        let upload = ImageManager.Image(name: image.release, image: 0, slot: 1,
                                        hash: Data(hex: image.sha256), data: image.data)
        progress(UploadProgress(sent: 0, total: image.data.count))
        if !images.upload(images: [upload], using: configuration, delegate: self) {
            finishUpload(with: BoardError.failed("The upload could not start."))
        }
    }

    private func finishUpload(with error: Error?) {
        guard let continuation = uploadDone else { return }
        uploadDone = nil
        progress = nil
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }

    // MARK: Closing

    private func resumePending(with error: BoardError?) {
        guard let continuation = pending else { return }
        pending = nil
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }

    /// Ends everything under way with `error`, and lets go of the link.
    private func close(with error: BoardError) {
        guard phase != .closed else { return }
        let wasUploading = uploadDone != nil
        phase = .closed
        attempt += 1
        resumePending(with: error)
        if wasUploading {
            // Resume first: cancelUpload() calls uploadDidCancel() at once, which would end the
            // upload with a vaguer error.
            finishUpload(with: error)
            images?.cancelUpload()
        }
        smp?.close()
        statusHandler = nil
        radio.cancel(peripheral)
        peripheral.delegate = nil
    }

    private static func slot(_ slot: McuMgrImageStateResponse.ImageSlot) -> ImageSlot {
        ImageSlot(image: Int(slot.image), slot: Int(slot.slot), version: slot.version,
                  active: slot.active, confirmed: slot.confirmed, pending: slot.pending,
                  permanent: slot.permanent)
    }
}

// MARK: - CBPeripheralDelegate

extension McuMgrBoardTransport: CBPeripheralDelegate {
    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard phase == .discovering else { return }
        guard error == nil,
              let service = peripheral.services?.first(where: { $0.uuid == CBUUID(string: SMP.serviceUUID) }) else {
            close(with: error.map { BoardErrors.map($0, duringUpload: false) } ?? .failed("The board has no SMP service."))
            return
        }
        // Firmware 1.13 and older has none: nothing changes for it.
        statusService = peripheral.services?.first { $0.uuid == BoardRadio.statusServiceUUID }
        peripheral.discoverCharacteristics([CBUUID(string: SMP.characteristicUUID)], for: service)
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if service.uuid == BoardRadio.statusServiceUUID {
            // Read, and notified of each change: no pairing needed for it, and none asked for.
            guard error == nil, phase == .ready, let characteristic = service.characteristics?.first(where: {
                $0.uuid == CBUUID(string: BoardStatus.characteristicUUID)
            }) else { return }
            peripheral.readValue(for: characteristic)
            if characteristic.properties.contains(.notify) { peripheral.setNotifyValue(true, for: characteristic) }
            return
        }
        guard phase == .discovering else { return }
        guard error == nil,
              let characteristic = service.characteristics?.first(where: { $0.uuid == CBUUID(string: SMP.characteristicUUID) }) else {
            close(with: error.map { BoardErrors.map($0, duringUpload: false) } ?? .failed("The board has no SMP characteristic."))
            return
        }
        characteristicFound(characteristic)
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == CBUUID(string: BoardStatus.characteristicUUID),
              let value = characteristic.value, let status = BoardStatus.parse(value) else { return }
        statusHandler?(status)
    }

    public func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                           error: Error?) {
        guard phase == .pairing, characteristic.uuid == CBUUID(string: SMP.characteristicUUID) else { return }
        if let error {
            close(with: BoardErrors.map(error, duringUpload: false, pairing: true))
        } else if characteristic.isNotifying {
            paired()
        } else {
            close(with: .pairingFailed)
        }
    }
}

// MARK: - ImageUploadDelegate

extension McuMgrBoardTransport: ImageUploadDelegate {
    public func uploadProgressDidChange(bytesSent: Int, imageSize: Int, timestamp: Date) {
        progress?(UploadProgress(sent: bytesSent, total: imageSize))
    }

    public func uploadDidFail(with error: Error) {
        finishUpload(with: BoardErrors.map(error, duringUpload: true))
    }

    public func uploadDidCancel() {
        finishUpload(with: BoardError.disconnected)
    }

    public func uploadDidFinish() {
        finishUpload(with: nil)
    }
}

extension McuMgrBoardTransport: RadioLink {}

/// The contract's UUIDs, handed to the library rather than relying on its defaults.
struct SMPUUIDs: McuMgrBleTransport.Configuration {
    let serviceUUID = CBUUID(string: SMP.serviceUUID)
    let characteristicUUUID = CBUUID(string: SMP.characteristicUUID)
}

extension Data {
    /// Bytes from hex text; whatever does not read as hex is skipped.
    init(hex: String) {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
            if let byte = UInt8(hex[index..<next], radix: 16) { bytes.append(byte) }
            index = next
        }
        self.init(bytes)
    }
}
