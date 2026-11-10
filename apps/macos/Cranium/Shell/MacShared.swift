import CraniumKit
import Foundation

/// What every window of the app shares, so a board's own window does not make a second of anything: the serial
/// bridge (a port is busy in every window once one has it), the one Bluetooth radio (its events go to the
/// window that used it last) and the Mac's keep-awake (held while any page asks for it).
@MainActor
final class MacShared {
    let serial: MacSerial
    private let awake = MacKeepAwake()
    private var awakeFor: Set<ObjectIdentifier> = []
    private weak var radioUser: MacBridgeHost?
    private(set) lazy var radio = ShellRadio { [weak self] name, data in self?.radioUser?.send(name, data) }

    init(serial: MacSerial? = nil) {
        self.serial = serial ?? MacSerial(choose: { await MacSerialPicker.choose(from: $0) })
    }

    /// The radio, for a window's bridge; its events go to that window from now on.
    func radio(for host: MacBridgeHost) -> ShellRadio {
        radioUser = host
        return radio
    }

    /// app.keepAwake from a page: the Mac stays awake while any page asks.
    func keepAwake(_ on: Bool, for host: MacBridgeHost) {
        if on { awakeFor.insert(ObjectIdentifier(host)) } else { awakeFor.remove(ObjectIdentifier(host)) }
        awake.set(!awakeFor.isEmpty)
    }

    var isAwake: Bool { awake.isHeld }
}
