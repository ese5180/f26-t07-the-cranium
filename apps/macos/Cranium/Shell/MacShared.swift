import CraniumKit
import Foundation

/// What every window of the app shares, so a board's own window does not make a second of anything: the serial
/// bridge (a port is busy in every window once one has it), the one Bluetooth radio (held by one window at a time, MacRadioHub) and the Mac's keep-awake (held while any page asks for it).
@MainActor
final class MacShared {
    let serial: MacSerial
    private let awake = MacKeepAwake()
    private var awakeFor: Set<String> = []
    /// Who holds the Bluetooth radio, and where its events go.
    let hub = MacRadioHub()
    private(set) lazy var radio = ShellRadio { [weak self] name, data in self?.hub.deliver(name, data) }

    init() {
        serial = MacSerial(choose: { await MacSerialPicker.choose(from: $0) })
    }

    /// app.keepAwake from a page: the Mac stays awake while any page asks.
    func keepAwake(_ on: Bool, for window: String) {
        if on { awakeFor.insert(window) } else { awakeFor.remove(window) }
        awake.set(!awakeFor.isEmpty)
    }

    var isAwake: Bool { awake.isHeld }
}
