import CoreBluetooth
import Foundation
import iOSMcuManagerLibrary
import Testing
@testable import CraniumBLE
@testable import CraniumKit

@Suite struct BoardErrorsTests {
    /// The board's refusals at the start of an upload (bt_ota.c): EBADSTATE for an image that is
    /// not newer or has no good header, EACCESSDENIED once one has arrived or the window closed.
    @Test func refusalsDuringAnUpload() {
        #expect(BoardErrors.map(McuMgrError.returnCode(.badState), duringUpload: true) == .uploadRefused)
        #expect(BoardErrors.map(McuMgrError.returnCode(.accessDenied), duringUpload: true) == .uploadRefused)
    }

    @Test func refusalsOfAnythingElse() {
        #expect(BoardErrors.map(McuMgrError.returnCode(.accessDenied), duringUpload: false) == .refused)
        #expect(BoardErrors.map(McuMgrError.returnCode(.badState), duringUpload: false) == .refused)
    }

    @Test func otherReturnCodesKeepTheLibrarysWords() {
        guard case .failed(let text) = BoardErrors.map(McuMgrError.returnCode(.noMemory), duringUpload: true) else {
            Issue.record("not .failed")
            return
        }
        #expect(!text.isEmpty)
    }

    @Test func theLinkDropping() {
        #expect(BoardErrors.map(McuMgrTransportError.disconnected, duringUpload: true) == .disconnected)
        #expect(BoardErrors.map(McuMgrTransportError.sendTimeout, duringUpload: true) == .timedOut)
        #expect(BoardErrors.map(NSError(domain: CBErrorDomain, code: CBError.Code.peripheralDisconnected.rawValue),
                                duringUpload: false) == .disconnected)
    }

    @Test func pairingFailures() {
        let auth = NSError(domain: CBATTErrorDomain, code: CBATTError.Code.insufficientAuthentication.rawValue)
        let encryption = NSError(domain: CBATTErrorDomain, code: CBATTError.Code.insufficientEncryption.rawValue)
        let removed = NSError(domain: CBErrorDomain, code: CBError.Code.peerRemovedPairingInformation.rawValue)
        for error in [auth, encryption, removed] {
            #expect(BoardErrors.map(error, duringUpload: false) == .pairingFailed)
        }
        // While pairing, a drop is a failed pairing: the board drops a phone with a wrong passkey.
        let dropped = NSError(domain: CBErrorDomain, code: CBError.Code.peripheralDisconnected.rawValue)
        #expect(BoardErrors.map(dropped, duringUpload: false, pairing: true) == .pairingFailed)
    }

    @Test func bluetoothOff() {
        guard case .bluetoothUnavailable = BoardErrors.map(McuMgrBleTransportError.centralManagerPoweredOff, duringUpload: false) else {
            Issue.record("not .bluetoothUnavailable")
            return
        }
    }

    @Test func aBoardErrorPassesThrough() {
        #expect(BoardErrors.map(BoardError.notFound, duringUpload: true) == .notFound)
    }
}

@Suite struct SMPTests {
    /// The contract's UUIDs are the library's defaults, and the ones handed to it.
    @Test func uuids() {
        let library = DefaultTransportConfiguration()
        let ours = SMPUUIDs()
        #expect(ours.serviceUUID == library.serviceUUID)
        #expect(ours.characteristicUUUID == library.characteristicUUUID)
        #expect(ours.serviceUUID == CBUUID(string: "8D53DC1D-1DB7-4CD3-868B-8A527460AA84"))
        #expect(ours.characteristicUUUID == CBUUID(string: "DA2E7828-FBCE-4E01-AE9E-261174997C48"))
    }

    @Test func hex() {
        #expect(Data(hex: "3db8f396") == Data([0x3D, 0xB8, 0xF3, 0x96]))
        #expect(Data(hex: "3DB8F396") == Data([0x3D, 0xB8, 0xF3, 0x96]))
        #expect(Data(hex: "") == Data())
    }
}
