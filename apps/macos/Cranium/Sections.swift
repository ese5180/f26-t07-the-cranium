import CraniumKit
import Foundation

/// The sidebar's sections, for a member of the team: the console's pages (cloud/web/src/site/assets/app.js)
/// and the iPhone app's screens, and what a Mac can do with a board in the room. Pure, so that
/// CraniumMacTests can check it.
enum TeamSection: String, CaseIterable, Identifiable, Hashable, Codable {
    case overview
    case boards
    case firmware
    case deployments
    case events
    case activity
    case bluetooth
    case serial
    case search
    case tokens
    case history
    case schedules
    case reports
    case help

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .boards: return "Boards"
        case .firmware: return "Firmware"
        case .deployments: return "Deployments"
        case .events: return "Events"
        case .activity: return "Activity"
        case .bluetooth: return "Bluetooth update"
        case .serial: return "Serial console"
        case .search: return "Search"
        case .tokens: return "API tokens"
        case .history: return "History"
        case .schedules: return "Scheduled deployments"
        case .reports: return "Weekly report"
        case .help: return "Help"
        }
    }

    var symbol: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .boards: return "cpu"
        case .firmware: return "shippingbox"
        case .deployments: return "paperplane"
        case .events: return "waveform.path.ecg"
        case .activity: return "list.bullet.rectangle"
        case .bluetooth: return "dot.radiowaves.left.and.right"
        case .serial: return "terminal"
        case .search: return "magnifyingglass"
        case .tokens: return "key"
        case .history: return "clock.arrow.circlepath"
        case .schedules: return "calendar.badge.clock"
        case .reports: return "chart.bar.doc.horizontal"
        case .help: return "questionmark.circle"
        }
    }

    /// Which group of the sidebar it is in.
    var group: Group {
        switch self {
        case .overview, .boards, .firmware, .deployments, .schedules, .events, .activity, .reports: return .console
        case .bluetooth, .serial: return .inTheRoom
        case .search, .tokens, .history, .help: return .more
        }
    }

    enum Group: String, CaseIterable {
        case console = "Console"
        case inTheRoom = "In the room"
        case more = "More"
    }

    /// The sections someone sees. A viewer has no Bluetooth update (the console refuses a viewer the
    /// pairing passkey and the send check) and no API tokens (only a release manager makes them), as on
    /// the website and the phones.
    static func visible(canWrite: Bool) -> [TeamSection] {
        allCases.filter { canWrite || ($0 != .bluetooth && $0 != .tokens) }
    }

    /// ⌘1 … ⌘9, for the first nine in the sidebar's order.
    var shortcut: Character? {
        guard let index = TeamSection.allCases.firstIndex(of: self), index < 9 else { return nil }
        return Character(String(index + 1))
    }

    /// A screen of the search catalogue (SearchCatalog, CraniumKit), by its key.
    static func forScreen(_ key: String) -> TeamSection? {
        switch key {
        case "overview": return .overview
        case "boards", "devices": return .boards
        case "firmware", "upload", "signing-key": return .firmware
        case "deployments": return .deployments
        case "events": return .events
        case "activity", "audit": return .activity
        case "bluetooth": return .bluetooth
        case "serial": return .serial
        case "tokens": return .tokens
        case "history": return .history
        case "schedules": return .schedules
        case "reports": return .reports
        case "help": return .help
        default: return TeamSection(rawValue: key)
        }
    }
}

/// The customer side's sections, as the customer site has them.
enum CustomerSection: String, CaseIterable, Identifiable, Hashable, Codable {
    case boards
    case activity
    case listening
    case account
    case help

    var id: String { rawValue }

    var title: String {
        switch self {
        case .boards: return "Your boards"
        case .activity: return "Activity"
        case .listening: return "Your listening"
        case .account: return "Account"
        case .help: return "Help"
        }
    }

    var symbol: String {
        switch self {
        case .boards: return "cpu"
        case .activity: return "clock.arrow.circlepath"
        case .listening: return "clock"
        case .account: return "person.crop.circle"
        case .help: return "questionmark.circle"
        }
    }
}

/// What a board window shows: one board, by thing name. A board's own window opens for it from the
/// board's toolbar or its row's menu, and comes back when Cranium opens again (window restoration).
struct BoardWindowID: Hashable, Codable {
    let thing: String

    /// Only a board's thing name: never anything else as a window's value.
    static func valid(_ thing: String) -> Bool {
        thing.range(of: #"^cranium-[0-9a-f]{16}$"#, options: .regularExpression) != nil
    }
}

/// The Boards page's filter, as the console's Devices page filters.
enum BoardFilter: String, CaseIterable, Identifiable {
    case all
    case online
    case offline
    case updating
    case onTrial
    case behind

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All boards"
        case .online: return "Online"
        case .offline: return "Offline"
        case .updating: return "Updating"
        case .onTrial: return "On trial"
        case .behind: return "Not on the newest release"
        }
    }

    /// Whether the filter keeps `device`; `newest` is the newest active release.
    func keeps(_ device: Device, newest: String?) -> Bool {
        switch self {
        case .all: return true
        case .online: return Words.isUp(device)
        case .offline: return !Words.isUp(device)
        case .updating: return (device.ota?.state ?? "idle") != "idle"
        case .onTrial: return device.fw?.confirmed == false
        case .behind: return newest != nil && device.fw?.version != newest
        }
    }
}
