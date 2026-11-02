import CoreBluetooth
import CraniumKit
import Foundation
import iOSMcuManagerLibrary

/// Turns CoreBluetooth's and the library's errors into `BoardError`, so that the app says what
/// docs/mobile-apps.md says it should.
public enum BoardErrors {
    /// - Parameters:
    ///   - duringUpload: the error answered an upload packet. The board refuses an upload at its
    ///     start with `EBADSTATE` (not newer than what runs, or not a good header) or
    ///     `EACCESSDENIED` (one has already arrived in this window, or the window has closed).
    ///   - pairing: the error came while the link was being authenticated.
    public static func map(_ error: Error, duringUpload: Bool, pairing: Bool = false) -> BoardError {
        if let error = error as? BoardError { return error }

        if let error = error as? McuMgrError {
            switch error {
            case .returnCode(let rc):
                return refusal(rc, duringUpload: duringUpload) ?? .failed(error.localizedDescription)
            case .groupCode(let group):
                return refusal(group.rc, duringUpload: duringUpload) ?? .failed(error.localizedDescription)
            }
        }

        if let error = error as? McuMgrTransportError {
            switch error {
            case .disconnected, .connectionFailed: return .disconnected
            case .connectionTimeout, .sendTimeout, .sendFailed, .waitAndRetry: return .timedOut
            default: return .failed(error.localizedDescription)
            }
        }

        if let error = error as? McuMgrBleTransportError {
            switch error {
            case .centralManagerPoweredOff, .centralManagerNotReady:
                return .bluetoothUnavailable(RadioState.off.problem!)
            default:
                return .failed(error.localizedDescription)
            }
        }

        let ns = error as NSError
        if ns.domain == CBATTErrorDomain {
            switch CBATTError.Code(rawValue: ns.code) {
            case .insufficientAuthentication, .insufficientEncryption, .insufficientEncryptionKeySize,
                 .insufficientAuthorization:
                return .pairingFailed
            default:
                break
            }
        }
        if ns.domain == CBErrorDomain {
            switch CBError.Code(rawValue: ns.code) {
            case .peerRemovedPairingInformation, .encryptionTimedOut:
                return .pairingFailed
            case .connectionTimeout, .peripheralDisconnected, .connectionFailed:
                return pairing ? .pairingFailed : .disconnected
            default:
                break
            }
        }
        return pairing ? .pairingFailed : .failed(error.localizedDescription)
    }

    private static func refusal(_ rc: McuMgrReturnCode, duringUpload: Bool) -> BoardError? {
        switch rc {
        case .badState, .accessDenied:
            return duringUpload ? .uploadRefused : .refused
        default:
            return nil
        }
    }
}
