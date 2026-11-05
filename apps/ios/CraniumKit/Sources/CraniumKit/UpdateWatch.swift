import Foundation

/// What became of an image sent over Bluetooth, step by step, from what the phone can see: the board's
/// own status over Bluetooth, the link to the board while it lasts, then the console (docs/mobile-apps.md,
/// "What a person does"). A pure function of what was seen, so that both apps say the same thing at the
/// same point: the Android app's core/UpdateWatch.kt is the same, case for case, and so are the tests.
///
/// What the board tells, and how (firmware/app/src/bt_ota.c):
///
/// - From 1.14.0, its status characteristic (`BoardStatus`), on the link of the send and, after the
///   restart, to any phone for 2 minutes with no pairing: the window and its seconds, the image, the
///   button, and the last update's outcome as the board recorded it. The board's word comes first.
/// - Button 1: it records the update, tells the phone (result `installing`), and restarts into the
///   bootloader once AWS IoT has its last report, 2 s at most. From 1.14.0 the line it prints for it
///   ("restarting into the bootloader: …") reaches the console first; before, it was lost with the
///   restart, and the press showed as the board closing the link and leaving AWS IoT (an event of kind
///   connection). After the restart: "on trial: <new> from <old>, …", and once it is kept or not,
///   "update over Bluetooth: <new> from <old>, <result>, proof <who>, …".
/// - Button 2: "closed: by Button 2" (result `discarded`), and the link closes. The board stays online.
/// - The 2 minutes running out: "closed: no image to install" (result `timed_out`), and the link closes.
public enum UpdateWatch {
    /// The board keeps an image that has arrived for this long, for a button (BT_OTA_OFFER_SECONDS).
    public static let offerSeconds: TimeInterval = 120
    /// After the link drops, the console is followed for this long at most.
    public static let followSeconds: TimeInterval = 300
    /// How often the console is asked while it is followed, and the most that is backed off to on a 429.
    public static let pollSeconds: TimeInterval = 3
    public static let slowestPollSeconds: TimeInterval = 30
    /// While the link is up, the image list is read this often: an answer says the link is still there.
    public static let linkReadSeconds: TimeInterval = 3
    /// The board closes the link when its 2 minutes are up: a drop this close to the end, or after it,
    /// is taken for that rather than for Button 1.
    public static let endSlack: TimeInterval = 3
    /// Lines and events from this long before the send count: the phone's clock and AWS's differ a little.
    public static let clockSlack: TimeInterval = 30
    /// A boot this long before the send still counts as after it: the board's uptime is in whole seconds.
    static let bootSlack: TimeInterval = 10
    /// A flow reopened this soon after its board was last followed shows how it went.
    public static let keepSeconds: TimeInterval = 300
    /// After the board was last seen over Bluetooth on trial with the new image, it is followed this much
    /// longer: its trial's 5 minutes, and the restart back into the old image, which says how it ended.
    public static let trialFollowSeconds: TimeInterval = 600

    public enum Step: String, Sendable { case sent, button, installing, trial, end }

    public enum State: String, Sendable {
        case waiting
        /// Reached, and where things stand now.
        case current
        case done
        /// Reached by the app's reading of the link only: not the board's word yet.
        case likely
        case failed
    }

    public enum Outcome: String, Sendable {
        case kept
        case rolledBack = "rolled_back"
        /// Button 2.
        case declined
        /// The 2 minutes ran out.
        case expired
        /// The board did not take the image it got.
        case refused
    }

    public struct Row: Equatable, Sendable {
        public let step: Step
        public let state: State
        public let title: String
        public let detail: String?
        /// When it happened, on the board's clock where the board said so.
        public let at: Date?

        public init(_ step: Step, _ state: State, _ title: String, _ detail: String? = nil, at: Date? = nil) {
            self.step = step
            self.state = state
            self.title = title
            self.detail = detail
            self.at = at
        }
    }

    /// One read of the board's status characteristic (firmware 1.14.0 on), and when the phone got it.
    public struct Reading: Equatable, Sendable {
        public let status: BoardStatus
        public let at: Date
        /// Read after the board restarted, on a link with no pairing; else on the link of the send.
        public let afterRestart: Bool

        public init(_ status: BoardStatus, at: Date, afterRestart: Bool = false) {
            self.status = status
            self.at = at
            self.afterRestart = afterRestart
        }
    }

    /// Everything seen since the send.
    public struct Facts: Equatable, Sendable {
        /// The release sent, `1.13.0+0`.
        public var version: String
        /// What the board ran when it was sent, `1.12.0+0`.
        public var from: String?
        /// When the upload ended, on the phone's clock.
        public var sentAt: Date
        /// The board in the console, from the pairing call. Nil: the console did not say which board this is.
        public var thing: String?
        /// Whether the console had the board online right after the send; nil when not known.
        public var onConsole: Bool?
        /// When the phone saw the Bluetooth link go.
        public var linkDroppedAt: Date?
        /// The board's log since the send (`GET /api/events/log`).
        public var lines: [BoardLine]
        /// Its events since the send (`GET /api/events`): those of kind connection are used.
        public var events: [BoardEvent]
        /// The newest read of the board (`GET /api/devices/{thing}`).
        public var device: Device?
        /// The last time the console was asked, it could not be reached.
        public var consoleFailed: Bool
        /// The board has been followed until `followUntil`.
        public var gaveUp: Bool
        /// The board's status, each read that said something new: on the link, and after the restart.
        public var readings: [Reading]
        /// The image's own hash, as the board records it (`VerifiedImage.imageHashPrefix`).
        public var sentHash: String?

        public init(version: String, from: String? = nil, sentAt: Date, thing: String? = nil, onConsole: Bool? = nil,
                    linkDroppedAt: Date? = nil, lines: [BoardLine] = [], events: [BoardEvent] = [], device: Device? = nil,
                    consoleFailed: Bool = false, gaveUp: Bool = false, readings: [Reading] = [], sentHash: String? = nil) {
            self.version = version
            self.from = from
            self.sentAt = sentAt
            self.thing = thing
            self.onConsole = onConsole
            self.linkDroppedAt = linkDroppedAt
            self.lines = lines
            self.events = events
            self.device = device
            self.consoleFailed = consoleFailed
            self.gaveUp = gaveUp
            self.readings = readings
            self.sentHash = sentHash
        }

        /// The console can follow this board: it knows which board it is, and did not have it offline.
        public var followable: Bool { thing != nil && onConsole != false }

        /// The board has the status characteristic (firmware 1.14.0 on): it is followed over Bluetooth too.
        public var tellsOverBluetooth: Bool { readings.contains { !$0.afterRestart } }

        /// A status read after the restart is this board's, about this send: its last update over
        /// Bluetooth is the version sent, and its image, where both hashes are known.
        public func isAboutThisSend(_ status: BoardStatus) -> Bool {
            guard status.lastVia == .bluetooth, UpdateWatch.same(status.lastTarget, version) else { return false }
            guard let sentHash, let theirs = status.lastHash else { return true }
            return sentHash == theirs
        }
    }

    public struct Timeline: Equatable, Sendable {
        public let rows: [Row]
        public let outcome: Outcome?
        /// The outcome is the app's reading of the link alone, not the board's word.
        public let tentative: Bool
        /// When the board's 2 minutes end.
        public let deadline: Date
        /// No button is known yet and the link is up: the countdown shows.
        public let waitingForButton: Bool
        /// One plain line under the steps.
        public let note: String?
        /// Nothing more can be learned: stop asking the console.
        public let finished: Bool
        /// The version the board went back to.
        public let rolledBackTo: String?
        /// When Button 1 was taken, where that is known.
        public let acceptedAt: Date?
    }

    /// The last update a phone followed on a board, for the board's page.
    public struct Record: Equatable, Sendable {
        public let thing: String
        public let version: String
        /// When Button 1 was taken, or else when the image was sent.
        public let at: Date
        public let outcome: Outcome?
        public let tentative: Bool
        public let rolledBackTo: String?

        public init(thing: String, version: String, at: Date, outcome: Outcome?, tentative: Bool = false,
                    rolledBackTo: String? = nil) {
            self.thing = thing
            self.version = version
            self.at = at
            self.outcome = outcome
            self.tentative = tentative
            self.rolledBackTo = rolledBackTo
        }
    }

    // MARK: Words

    public static func sentTitle(_ version: String) -> String { "Sent \(version)" }
    public static let sentDetail = "Press Button 1 on the board within 2 minutes to install it (Button 2 throws it away)."
    public static let buttonTitle = "Button 1 pressed, accepted"
    public static let linkClosed = "The board closed the link: it is installing."
    public static let declinedTitle = "Button 2 pressed: the image was thrown away"
    public static let expiredTitle = "The 2 minutes ran out: the image was thrown away"
    public static let likelyExpiredTitle = "The 2 minutes ran out"
    public static let likelyExpiredDetail = "The board closed the link at the end of its 2 minutes: it has most likely thrown the image away."
    public static let refusedTitle = "The board did not take the image"
    public static let installingTitle = "Installing and restarting"
    public static let installingDetail = "The board is offline on the console while it installs."
    public static func trialTitle(_ version: String) -> String { "Running \(version) on trial" }
    public static let trialDetail = "Back online with the new version, not yet kept."
    public static func keptTitle(_ version: String) -> String { "Kept \(version)" }
    public static func rolledBackTitle(_ old: String?) -> String { old.map { "Rolled back to \($0)" } ?? "Rolled back" }
    public static let cannotFollow = "The board is not on the console, so the app can't follow it from here. After it restarts, check its version over Bluetooth."
    public static let gaveUpNote = "5 minutes have passed, so the app has stopped following it. The board's page shows how it ends."
    public static let consoleFailedNote = "The console could not be reached just now. The app keeps asking."
    public static let timeUp = "The 2 minutes are up."
    public static let boardSaid = "The board said so over Bluetooth."
    public static let buttonFromBoard = "The board said so over Bluetooth, and is restarting to install it."
    public static let installingOverBluetooth = "The board is restarting into the bootloader, which checks the image and swaps it in."
    public static let trialOverBluetooth = "The board says so over Bluetooth: not yet kept."
    public static let lookingNote = "Looking for the board over Bluetooth: for 2 minutes after its restart, a phone can read how it went with no pairing."
    public static let gaveUpBluetoothNote = "The board was not seen over Bluetooth again, so the app has stopped looking for it. Its version shows when Button 1 opens its window again."

    /// Who kept it, from the board's record.
    public static func keptDetail(_ proof: String?) -> String {
        switch proof {
        case "cloud": return "It reached AWS IoT, so the board keeps it."
        case "person": return "A person at the board proved it."
        default: return "The board keeps it."
        }
    }

    /// Why it went back, from the board's record; "Back on the old version." when the board only shows it.
    public static func rolledBackDetail(_ result: String?) -> String {
        switch result {
        case "rolled_back": return "The new image was not kept: the bootloader put the old one back."
        case "not_installed": return "The bootloader did not install the new image."
        case "trial_lost": return "The new image lost its trial."
        case "flash_error": return "The new image could not be written to flash."
        case "superseded": return "A cloud update replaced it."
        case "incompatible_board": return "The image is for another kind of board."
        case "incompatible_layout": return "The image is for another flash layout."
        default: return "Back on the old version."
        }
    }

    /// "1:42 left", then "The 2 minutes are up."
    public static func countdown(_ secondsLeft: Int) -> String {
        guard secondsLeft > 0 else { return timeUp }
        let seconds = secondsLeft % 60
        return "\(secondsLeft / 60):\(seconds < 10 ? "0" : "")\(seconds) left"
    }

    /// How long to wait before asking the console again, after `throttled` answers of 429 in a row.
    public static func nextPoll(throttled: Int) -> TimeInterval {
        min(slowestPollSeconds, pollSeconds * pow(2, Double(min(max(throttled, 0), 8))))
    }

    /// Until when the board is followed, once the link has gone: `followSeconds` after the drop, and
    /// `trialFollowSeconds` after the board last said over Bluetooth that it runs the new image on trial.
    /// Nil while the link is up.
    public static func followUntil(_ facts: Facts) -> Date? {
        guard let dropped = facts.linkDroppedAt else { return nil }
        var until = dropped.addingTimeInterval(followSeconds)
        if let trial = facts.readings.last(where: {
            $0.afterRestart && $0.status.onTrial && same($0.status.running, facts.version) && facts.isAboutThisSend($0.status)
        }) {
            until = max(until, trial.at.addingTimeInterval(trialFollowSeconds))
        }
        return until
    }

    // MARK: What the board said

    /// One of the board's records of an update: "<what>: <to> from <from>, <result>, proof <who>, update N of this board".
    struct Said: Equatable {
        let what: String
        let to: String
        let from: String
        let result: String
        let proof: String
    }

    static let recordKinds = ["restarting into the bootloader", "on trial", "last update over Bluetooth", "update over Bluetooth"]

    static func parseRecord(_ text: String) -> Said? {
        guard let what = recordKinds.first(where: { text.hasPrefix($0 + ": ") }) else { return nil }
        let parts = text.dropFirst(what.count + 2).components(separatedBy: ", ")
        guard parts.count >= 3, parts[2].hasPrefix("proof ") else { return nil }
        let versions = parts[0].components(separatedBy: " from ")
        guard versions.count == 2 else { return nil }
        return Said(what: what, to: versions[0], from: versions[1], result: parts[1], proof: String(parts[2].dropFirst(6)))
    }

    static func same(_ a: String?, _ b: String) -> Bool {
        guard let a, let left = FirmwareVersion(release: a), let right = FirmwareVersion(release: b) else { return false }
        return left == right
    }

    // MARK: The timeline

    public static func timeline(_ facts: Facts) -> Timeline {
        let since = facts.sentAt.addingTimeInterval(-clockSlack)
        let version = facts.version

        // The board's own word, over Bluetooth: on the link of the send, then after the restart.
        let onLink = facts.readings.filter { !$0.afterRestart }
        let windowEnd = onLink.first { $0.status.result != .none && $0.status.result != .unknown }
        let installing = windowEnd?.status.result == .installing ? windowEnd : nil
        let afterRestart = facts.readings.filter { $0.afterRestart && facts.isAboutThisSend($0.status) }
        let boardTrial = afterRestart.first { $0.status.onTrial && same($0.status.running, version) }
        let boardEnd = afterRestart.first { $0.status.lastOutcome.isEnd }
        // The board counts its 2 minutes down itself.
        let offer = onLink.last { $0.status.window == .offer }
        let deadline = offer.map { $0.at.addingTimeInterval(Double($0.status.secondsLeft)) }
            ?? facts.sentAt.addingTimeInterval(offerSeconds)

        let lines = facts.lines
            .filter { ($0.tag == "BT" || $0.tag == "bt_ota") && ($0.date.map { $0 >= since } ?? false) }
            .sorted { a, b in
                let (x, y) = (a.date ?? .distantPast, b.date ?? .distantPast)
                return x != y ? x < y : (a.boot ?? 0, a.seq ?? 0) < (b.boot ?? 0, b.seq ?? 0)
            }
        func first(_ what: String) -> (Said, Date?)? {
            for line in lines {
                if let said = parseRecord(line.text), said.what == what, same(said.to, version) { return (said, line.date) }
            }
            return nil
        }
        func firstLine(_ test: (String) -> Bool) -> BoardLine? { lines.first { test($0.text) } }

        let restarting = first("restarting into the bootloader")
        let onTrial = first("on trial")
        let finished = first("update over Bluetooth") ?? first("last update over Bluetooth")
        let button2 = firstLine { $0.hasPrefix("closed: by Button 2") }
        let refused = firstLine {
            $0.hasPrefix("refused the image") || $0.hasPrefix("what arrived cannot be installed") || $0.hasPrefix("the image could not be installed")
        }
        let noImage = firstLine { $0.hasPrefix("closed: no image to install") }

        let connections = facts.events
            .filter { $0.kind == "connection" && ($0.date.map { $0 >= since } ?? false) }
            .compactMap { event in event.date.map { (event.what, $0) } }
            .sorted { $0.1 < $1.1 }
        let offlineAt = connections.first { $0.0 == "disconnected" }?.1
        let backAt = connections.first { $0.0 == "connected" && $0.1 > (offlineAt ?? since) }?.1

        // The board as the console last read it: a boot after the send, and what that boot runs.
        let device = facts.device
        var bootAt: Date?
        if let device, let seen = ConsoleTime.date(device.lastSeen), let up = device.uptime {
            let boot = seen.addingTimeInterval(-Double(up))
            if boot >= facts.sentAt.addingTimeInterval(-bootSlack) { bootAt = boot }
        }
        let runs = bootAt == nil ? nil : device?.fw
        let record = device?.bt.flatMap { same($0.to, version) ? $0 : nil }

        // How it ended, the board's own word first: over Bluetooth, then in its log.
        var outcome: Outcome?
        var endAt: Date?
        var proof: String?
        var reason: String?
        var old: String?
        var refusal: String?
        var fromBoard = false
        let endedOnLink = windowEnd.map { [.discarded, .timedOut].contains($0.status.result) || $0.status.image == .refused } ?? false
        if let end = boardEnd {
            let said = end.status
            if said.lastOutcome == .kept {
                outcome = .kept
                proof = said.lastProof.word
            } else {
                outcome = .rolledBack
                reason = said.lastOutcome.word
                old = same(said.running, version) ? said.lastFrom : said.running
            }
            endAt = end.at
        } else if let end = windowEnd, endedOnLink {
            switch end.status.result {
            case .discarded: outcome = .declined
            case .timedOut: outcome = .expired
            default:
                outcome = .refused
                refusal = BoardStatus.words(end.status.refusal)
            }
            endAt = end.at
            fromBoard = true
        } else if let end = finished, end.0.result != "pending" {
            let said = end.0
            if said.result == "succeeded" {
                outcome = .kept
                proof = said.proof
            } else {
                outcome = .rolledBack
                reason = said.result
                old = said.from
            }
            endAt = end.1
        } else if let line = button2 {
            outcome = .declined
            endAt = line.date
        } else if let line = refused {
            outcome = .refused
            endAt = line.date
            refusal = line.text
        } else if let line = noImage {
            outcome = .expired
            endAt = line.date
        } else if let runs, same(runs.version, version), runs.confirmed {
            outcome = .kept
            endAt = backAt ?? bootAt
            proof = record?.proof
        } else if let runs, !same(runs.version, version) {
            outcome = .rolledBack
            endAt = backAt ?? bootAt
            old = runs.version
            reason = record.flatMap { Telemetry.badBluetoothResults.contains($0.result) ? $0.result : nil }
        }

        let dropped = facts.linkDroppedAt
        let ranOnTrial = onTrial != nil || boardTrial != nil || (runs.map { same($0.version, version) } ?? false)
            || outcome == .kept
        let acceptedSure = installing != nil || !afterRestart.isEmpty || restarting != nil || ranOnTrial
            || outcome == .rolledBack || (dropped != nil && offlineAt != nil)
        let acceptedAt = installing?.at ?? restarting?.1 ?? offlineAt ?? dropped
        let likelyAccepted = !acceptedSure && outcome == nil && dropped.map { $0 < deadline.addingTimeInterval(-endSlack) } == true
        let likelyExpired = !acceptedSure && outcome == nil && dropped.map { $0 >= deadline.addingTimeInterval(-endSlack) } == true

        var rows = [Row(.sent, .done, sentTitle(version), sentDetail, at: facts.sentAt)]
        var tentative = false
        var stopped = false

        switch outcome {
        case .declined:
            rows.append(Row(.button, .failed, declinedTitle, fromBoard ? boardSaid : nil, at: endAt))
            stopped = true
        case .expired:
            rows.append(Row(.button, .failed, expiredTitle, fromBoard ? boardSaid : nil, at: endAt))
            stopped = true
        case .refused:
            rows.append(Row(.button, .failed, refusedTitle, refusal, at: endAt))
            stopped = true
        default:
            if likelyExpired {
                rows.append(Row(.button, .likely, likelyExpiredTitle, likelyExpiredDetail, at: dropped))
                outcome = .expired
                tentative = true
                stopped = true
            } else if let installing {
                rows.append(Row(.button, .done, buttonTitle, buttonFromBoard, at: installing.at))
            } else if acceptedSure {
                rows.append(Row(.button, .done, buttonTitle, at: acceptedAt))
            } else if likelyAccepted {
                rows.append(Row(.button, .likely, buttonTitle, linkClosed, at: dropped))
            } else {
                rows.append(Row(.button, .current, buttonTitle))
            }
        }

        if !stopped {
            let offline = offlineAt != nil || (dropped != nil && device?.online == false) || installing != nil
            let pastInstall = backAt != nil || ranOnTrial || outcome != nil || !afterRestart.isEmpty
            let installedAt = offlineAt ?? installing?.at
            if pastInstall {
                rows.append(Row(.installing, .done, installingTitle, at: installedAt))
            } else if offline {
                let detail = offlineAt == nil && installing != nil ? installingOverBluetooth : installingDetail
                rows.append(Row(.installing, .current, installingTitle, detail, at: installedAt))
            } else {
                rows.append(Row(.installing, .waiting, installingTitle))
            }

            let trialAt = onTrial?.1 ?? boardTrial?.at ?? backAt ?? bootAt
            let trialDone = onTrial != nil || boardTrial != nil
            switch outcome {
            case .kept: rows.append(Row(.trial, .done, trialTitle(version), at: trialAt))
            case .rolledBack:
                rows.append(Row(.trial, trialDone ? .done : .waiting, trialTitle(version), at: onTrial?.1 ?? boardTrial?.at))
            default:
                let detail = onTrial == nil && boardTrial != nil ? trialOverBluetooth : trialDetail
                rows.append(ranOnTrial ? Row(.trial, .current, trialTitle(version), detail, at: trialAt)
                                       : Row(.trial, .waiting, trialTitle(version)))
            }

            switch outcome {
            case .kept: rows.append(Row(.end, .done, keptTitle(version), keptDetail(proof), at: endAt))
            case .rolledBack: rows.append(Row(.end, .failed, rolledBackTitle(old ?? facts.from), rolledBackDetail(reason), at: endAt))
            default: rows.append(Row(.end, .waiting, keptTitle(version)))
            }
        }

        // Once the link is gone, what the console can still tell.
        var note: String?
        var done = outcome != nil && !tentative
        if outcome == nil || tentative {
            if dropped != nil && !facts.followable && !facts.tellsOverBluetooth {
                note = cannotFollow
                done = true
            } else if facts.gaveUp {
                note = facts.followable ? gaveUpNote : gaveUpBluetoothNote
                done = true
            } else if facts.consoleFailed {
                note = consoleFailedNote
            } else if dropped != nil && !facts.followable && afterRestart.isEmpty {
                note = lookingNote
            }
        }

        return Timeline(rows: rows, outcome: outcome, tentative: tentative, deadline: deadline,
                        waitingForButton: dropped == nil && !acceptedSure && outcome == nil, note: note, finished: done,
                        rolledBackTo: outcome == .rolledBack ? old ?? facts.from : nil,
                        acceptedAt: acceptedSure || likelyAccepted ? acceptedAt : nil)
    }

    /// What a board's page keeps of a followed update.
    public static func record(_ facts: Facts, _ timeline: Timeline) -> Record? {
        guard let thing = facts.thing else { return nil }
        return Record(thing: thing, version: facts.version, at: timeline.acceptedAt ?? facts.sentAt, outcome: timeline.outcome,
                      tentative: timeline.tentative, rolledBackTo: timeline.rolledBackTo)
    }

    // MARK: On the board's page

    /// "1.13.0+0 over Bluetooth at 12:14, kept": what this phone followed, else the board's own record
    /// (without a time, which it does not keep). Nil when there is neither.
    public static func summary(record: Record?, bt: Device.BluetoothRecord?, time: (Date) -> String) -> String? {
        if let record {
            let head = "\(record.version) over Bluetooth at \(time(record.at))"
            if let bt, same(bt.to, record.version), record.outcome == nil || record.tentative, let words = words(of: bt) {
                return "\(head), \(words)"
            }
            return "\(head), \(words(record.outcome, rolledBackTo: record.rolledBackTo))"
        }
        guard let bt, let words = words(of: bt) else { return nil }
        return "\(bt.to) over Bluetooth, \(words)"
    }

    static func words(_ outcome: Outcome?, rolledBackTo: String?) -> String {
        switch outcome {
        case .kept: return "kept"
        case .rolledBack: return rolledBackTo.map { "rolled back to \($0)" } ?? "rolled back"
        case .declined: return "thrown away with Button 2"
        case .expired: return "not installed: the 2 minutes ran out"
        case .refused: return "not taken by the board"
        case nil: return "not followed to the end"
        }
    }

    static func words(of bt: Device.BluetoothRecord) -> String? {
        switch bt.result {
        case "succeeded": return "kept"
        case "pending": return "on trial"
        case "superseded": return "replaced by a cloud update"
        default: return Telemetry.badBluetoothResults.contains(bt.result) ? "rolled back to \(bt.from)" : nil
        }
    }
}
