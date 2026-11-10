import CraniumKit
import Foundation

/// The console's sections the menus go to (cloud/web/src/site/assets/views.js SECTIONS), by the hash route each
/// one has. Command-1 to Command-9 are the first nine; the rest are in the Go menu without a key.
enum MacRoutes {
    struct Section: Equatable {
        let route: String
        let title: String
    }

    static let shortcuts: [Section] = [
        Section(route: "overview", title: "Overview"),
        Section(route: "devices", title: "Devices"),
        Section(route: "map", title: "Map"),
        Section(route: "diagnostics", title: "Diagnostics"),
        Section(route: "events", title: "Events"),
        Section(route: "firmware", title: "Firmware"),
        Section(route: "deployments", title: "Deployments"),
        Section(route: "serial", title: "Serial Console"),
        Section(route: "setup", title: "Board Setup"),
    ]

    static let others: [Section] = [
        Section(route: "bluetooth", title: "Bluetooth"),
        Section(route: "fleet", title: "Fleet"),
        Section(route: "memfault", title: "Memfault"),
        Section(route: "alerts", title: "Alerts"),
        Section(route: "reports", title: "Reports"),
        Section(route: "activity", title: "Activity"),
        Section(route: "apps", title: "Apps"),
        Section(route: "customers", title: "Customers"),
        Section(route: "team", title: "Team"),
        Section(route: "developer", title: "Developer"),
    ]

    /// The key of the nth section (0-based) of `shortcuts`: "1" to "9".
    static func key(at index: Int) -> Character? {
        (0..<9).contains(index) ? Character(String(index + 1)) : nil
    }

    /// A board's name as the console writes it in an address.
    static func isThing(_ text: String) -> Bool {
        text.range(of: "^[A-Za-z0-9_:-]{1,128}$", options: .regularExpression) != nil
    }

    /// The board in `/devices/<thing>`, the fragment of a board's page; nil for any other.
    static func thing(inFragment fragment: String?) -> String? {
        guard let fragment, fragment.hasPrefix("/devices/") else { return nil }
        let thing = String(fragment.dropFirst("/devices/".count))
        return isThing(thing) ? thing : nil
    }

    static func boardURL(_ thing: String) -> URL? {
        isThing(thing) ? URL(string: "\(ShellPolicy.origin)/admin#/devices/\(thing)") : nil
    }
}
