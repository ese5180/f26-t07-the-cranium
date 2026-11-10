import CraniumKit
import Foundation

/// Who holds the app's one Bluetooth radio. A window that scans, connects or watches holds it until its link
/// is gone, it lets go, or its page leaves or its window closes; the radio's events go to that window alone, and
/// another window's request to use or stop it is refused with `busy`, so a second window cannot take its
/// progress or cancel its upload. Windows are told apart by a stable id (`MacShellModel.windowID`).
@MainActor
final class MacRadioHub {
    typealias Emit = (String, [String: JSONValue]) -> Void

    private(set) var owner: String?
    private var sinks: [String: Emit] = [:]
    private var linked = false

    /// Where this window's events go; safe to call again.
    func register(_ window: String, emit: @escaping Emit) {
        sinks[window] = emit
    }

    /// The window is gone. Whether it held the radio is the caller's to deal with first (`release`).
    func unregister(_ window: String) {
        sinks.removeValue(forKey: window)
    }

    func owns(_ window: String) -> Bool { owner == window }

    /// A window starts using the radio (scan, connect, watch): it takes it if nobody holds it.
    func claim(_ window: String) throws {
        if let owner, owner != window { throw Self.busy }
        owner = window
    }

    /// A window acts on a radio it does not need to claim (cancel, disconnect, upload, status, stop scanning):
    /// fine if it holds the radio, or nobody does; refused if another window does.
    func require(_ window: String) throws {
        if let owner, owner != window { throw Self.busy }
    }

    /// The window lets go (disconnected, or its page left). Nothing if it did not hold it.
    @discardableResult
    func release(_ window: String) -> Bool {
        guard owner == window else { return false }
        owner = nil
        linked = false
        return true
    }

    /// An offline link came up for the holder (ble.offline.connect): the radio stays held until it goes.
    func linkUp(_ window: String) {
        if owner == window { linked = true }
    }

    /// Scanning or watching stopped: the radio is let go unless a link is up.
    func stoppedUsing(_ window: String) {
        if owner == window, !linked { owner = nil }
    }

    /// An event from the radio, to the holder only. A link that went away lets the radio go.
    func deliver(_ name: String, _ data: [String: JSONValue]) {
        guard let owner else { return }
        let isLink = name == "ble.link" || name == "ble.offline.link"
        if isLink {
            if case .string("connected")? = data["state"] { linked = true }
            if case .string("disconnected")? = data["state"] { linked = false }
        }
        sinks[owner]?(name, data)
        if isLink, !linked { self.owner = nil }
    }

    static var busy: BridgeError {
        BridgeError(.busy, "The Bluetooth radio is in use in another window of this app.")
    }
}
