import Foundation

// The sentences of the Overview and Devices pages (views.js), where they say something about the
// fleet as a whole rather than about one board.

extension Words {
    public static let neverReported = "Has not reported to the console yet."
    public static let neverReportedHelp = "Power it up and check that it was provisioned."
    public static let notRegistered = "Not a registered release"

    /// The state of a board and when its last heartbeat arrived, or nil for one that never had one.
    public static func heartbeatWords(_ device: Device, now: Date) -> String? {
        var words = ("Offline", "last heartbeat")
        if isRestarting(device) { words = ("Restarting", "last heartbeat") }
        else if device.online { words = ("Online", "heartbeat") }
        if device.lastSeen != nil { return "\(words.0), \(words.1) \(timeAgo(device.lastSeen, now: now))" }
        return device.online ? words.0 : nil
    }

    /// The line under a board's name.
    public static func seenLine(_ device: Device, now: Date) -> String {
        heartbeatWords(device, now: now) ?? neverReported
    }

    /// That what is said of these boards is what they last said, and when, for those that are offline.
    public static func offlineWords(_ boards: [Device], now: Date, alone: Bool? = nil) -> String? {
        let quiet = boards.filter { !$0.online && $0.lastSeen != nil }
        guard let oldest = quiet.min(by: { (ConsoleTime.date($0.lastSeen) ?? .distantFuture) < (ConsoleTime.date($1.lastSeen) ?? .distantFuture) })
        else { return nil }
        let seen = timeAgo(oldest.lastSeen, now: now)
        if alone ?? (boards.count == 1) { return "As last reported: the board is offline, last seen \(seen)." }
        if boards.count == 1 { return "As last reported: that board is offline, last seen \(seen)." }
        return quiet.count == 1
            ? "As last reported: 1 of them is offline, last seen \(seen)."
            : "As last reported: \(quiet.count) of them are offline, the oldest report \(seen)."
    }

    /// The same in a few words, under a figure that counts boards by what they run.
    public static func asReported(_ devices: [Device], now: Date) -> String? {
        let quiet = devices.filter { $0.fw != nil && !$0.online && $0.lastSeen != nil }
        guard let oldest = quiet.min(by: { (ConsoleTime.date($0.lastSeen) ?? .distantFuture) < (ConsoleTime.date($1.lastSeen) ?? .distantFuture) })
        else { return nil }
        let seen = timeAgo(oldest.lastSeen, now: now)
        return quiet.count == 1 ? "As last reported \(seen)." : "As last reported, the oldest \(seen)."
    }

    /// Boards that report an update, for when no deployment of this console is under way: a job made
    /// directly in AWS IoT is not among the deployments.
    public static func workWords(_ devices: [Device]) -> String? {
        let busy = devices.filter { $0.ota != nil && $0.ota?.state != "idle" }
        guard !busy.isEmpty else { return nil }
        let count = busy.count
        let alone = devices.count == 1
        let heard = busy.allSatisfy(\.online)
        let opening = heard ? "" : "When last seen, "
        let who = alone ? "\(heard ? "The" : "the") board" : plural(count, "board")
        let update = count == 1 ? "an update" : "updates"
        if busy.allSatisfy({ $0.ota?.job == nil }) {
            let verb = count == 1 ? (heard ? "is" : "was") : (heard ? "are" : "were")
            return "\(opening)\(who) \(verb) working on \(update) that this console did not start."
        }
        if !heard { return "\(opening)\(who) reported \(update) in progress." }
        return "\(who) \(count == 1 ? "reports" : "report") \(update) in progress."
    }

    /// The headline for boards that run something that is not a release.
    public static func unregisteredWords(_ strangers: [Device], devices: [Device]) -> String {
        let heard = strangers.allSatisfy(\.online)
        if devices.count == 1, let version = strangers.first?.fw?.version {
            return "The board \(heard ? "runs" : "last reported") \(version), which is not a registered release."
        }
        let count = strangers.count
        if !heard { return "\(plural(count, "board")) last reported firmware that is not a registered release." }
        return "\(plural(count, "board runs", "boards run")) firmware that is not a registered release."
    }

    /// Boards that left what the last deployment installed. How they got there is not on record.
    public static func movedWords(moved: [Device], deployment: Deployment, now: Date) -> String {
        if deployment.things.count > 1 {
            return "\(moved.count) of \(deployment.things.count) boards \(moved.count == 1 ? "has" : "have") moved to other firmware since."
        }
        guard let board = moved.first, let version = board.fw?.version else { return "" }
        return board.online
            ? "The board has since moved to \(version)."
            : "When last seen, \(timeAgo(board.lastSeen, now: now)), the board had moved to \(version)."
    }

    /// Said when no board that has reported runs the newest release.
    public static func unusedReleaseWords(_ release: FirmwareRelease, devices: [Device]?) -> String? {
        let reporting = (devices ?? []).filter { $0.fw != nil }
        guard !reporting.isEmpty, !reporting.contains(where: { $0.fw?.version == release.version }) else { return nil }
        if reporting.count > 1 { return "No board runs this release." }
        let board = reporting[0]
        return "The board \(board.online ? "runs" : "last reported") \(board.fw?.version ?? ""), not this release."
    }

    /// The boards that report a version that is not in the list of releases.
    public static func offList(_ devices: [Device], releases: [FirmwareRelease]?) -> [Device] {
        devices.filter { isUnregistered($0.fw?.version, releases: releases) }
    }

    /// "Started 3 min ago by a@b.c".
    public static func startedBy(_ deployment: Deployment, now: Date) -> String {
        var words = "Started \(timeAgo(deployment.createdAt, now: now))"
        if let by = deployment.createdBy { words += " by \(nameOf(by))" }
        return words
    }
}
