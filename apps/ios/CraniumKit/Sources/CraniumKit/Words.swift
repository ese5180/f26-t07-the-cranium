import Foundation

// The console's words, from cloud/web/src/site/assets/core.js: what a board is doing, said the way
// one would say it to a teammate, with a tone and an icon so that no state is told apart by colour
// alone. The app says exactly what the website says.

/// How a state is drawn. `act` is the one state in which an update waits for a person.
public enum Tone: String, Sendable, CaseIterable {
    case act, wait, live, good, warn, bad, idle
}

/// A badge: a tone, an icon (the website's icon name) and a word.
public struct Look: Equatable, Sendable {
    public let tone: Tone
    public let icon: String
    public let label: String
    /// For a deployment that is over and has something to tell, the sentence that says it.
    public var said: String?

    public init(_ tone: Tone, _ icon: String, _ label: String, said: String? = nil) {
        self.tone = tone
        self.icon = icon
        self.label = label
        self.said = said
    }
}

/// One step of an update, as the step indicator draws it.
public struct Step: Equatable, Sendable {
    public enum State: String, Sendable {
        case done, current, failed, stopped, skipped, upcoming, unknown
    }

    public let label: String
    public let state: State
    /// "last seen here", where the step is only where an offline board was last heard of.
    public let word: String?

    /// What the state is called next to the step.
    public var stateWord: String {
        if let word { return word }
        switch state {
        case .done: return "done"
        case .current: return "in progress"
        case .failed, .stopped: return "stopped here"
        case .skipped: return "not reached"
        case .upcoming: return "not started"
        case .unknown: return "not known"
        }
    }
}

/// One board's part in a deployment, in words (`Words.describeExecution`).
public struct ExecutionWords: Equatable, Sendable {
    public var tone: Tone
    public var icon: String
    public var title: String
    public var text: String
    /// The first sentence of `text`.
    public var brief: String
    public var steps: [Step]
    /// The download in percent, while the board reports it.
    public var progress: Int? = nil
    /// The title without the percentage, where the percentage is drawn beside it.
    public var said: String? = nil
    /// The board's own reason, when the console has no words for it.
    public var code: String? = nil
    /// What to do about an update that ended short.
    public var next: String? = nil
    /// Offering the same release again makes sense.
    public var retry = false
    /// The other deployment that installed this version.
    public var installedBy: String? = nil
    /// A cancelled update went through all the same.
    public var installed = false
    /// How it ended cannot be told yet.
    public var unsure = false
}

/// What a board last said about updates (`Words.describeUpdate`).
public struct UpdateWords: Equatable, Sendable {
    public var tone: Tone
    public var icon: String
    public var title: String
    public var text: String = ""
    public var progress: Int? = nil
    /// The deployment it is working on, if any.
    public var deployment: String? = nil
    /// An absence of news, drawn as less than news.
    public var quiet = false
}

/// A count of boards in one state, with its words.
public struct CountLine: Equatable, Sendable, Identifiable {
    public let name: String
    public let count: Int
    public let label: String
    public let tone: Tone
    public let icon: String
    public var id: String { name }
}

/// One line of the activity log, in words (`Words.describeAudit`).
public struct AuditWords: Equatable, Sendable {
    public enum Link: Hashable, Sendable {
        case deployment(String)
        case firmware
    }

    public struct Fact: Equatable, Sendable, Identifiable {
        public let key: String
        public let label: String
        public let value: String
        /// The value is an identifier, set in the monospace face.
        public let code: Bool
        /// The label reads on into the value ("Size 1,264 bytes"); otherwise a colon sets it off.
        public let phrase: Bool
        /// A refusal in words, where there are words for its code.
        public let words: String?
        public var id: String { key }
    }

    public let icon: String
    /// Before the label.
    public let verb: String
    /// What the entry is about: a version, a board, a token.
    public let label: String
    /// After the label: "over USB", "to a phone".
    public let tail: String
    public let outcome: Look?
    public let link: Link?
    public let facts: [Fact]
    /// Sent by a script with AWS credentials, directly to the API function.
    public let scripted: Bool
    /// The thing names of the boards a deployment went to, as far as the entry names them, and how
    /// many there were. `Words.auditBoards` puts them into words.
    public let boards: [String]
    public let boardCount: Int
    /// The label is a board's own name, its device ID (a command at its serial console).
    public let byName: Bool
}

public enum Words {
    // MARK: Numbers and times as people read them

    static let minute: TimeInterval = 60
    static let hour: TimeInterval = 3600
    static let day: TimeInterval = 86_400
    /// From this age on a time is told by its date, not by how long ago it was.
    static let datedFrom: TimeInterval = 14 * 86_400

    /// "3 min ago". Empty if there is no time.
    public static func timeAgo(_ iso: String?, now: Date) -> String {
        guard let then = ConsoleTime.date(iso) else { return "" }
        let elapsed = now.timeIntervalSince(then)
        if elapsed < 5 { return "just now" }
        if elapsed < minute { return "\(Int(elapsed)) s ago" }
        if elapsed < hour { return "\(Int(elapsed / minute)) min ago" }
        if elapsed < day { return "\(Int(elapsed / hour)) h ago" }
        if elapsed < datedFrom { return "\(Int(elapsed / day)) d ago" }
        return then.formatted(.dateTime.day().month(.abbreviated).year())
    }

    /// The full local date and time.
    public static func exactTime(_ iso: String?) -> String {
        guard let then = ConsoleTime.date(iso) else { return "" }
        return then.formatted(date: .abbreviated, time: .standard)
    }

    /// The time of day, with the day as well when it is another day.
    public static func clockTime(_ iso: String?, now: Date) -> String {
        guard let then = ConsoleTime.date(iso) else { return "" }
        if Calendar.current.isDate(then, inSameDayAs: now) {
            return then.formatted(date: .omitted, time: .shortened)
        }
        return then.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }

    /// The date and the time of day, for a time so old that "ago" says nothing.
    public static func dateAndTime(_ iso: String?) -> String {
        guard let then = ConsoleTime.date(iso) else { return "" }
        return then.formatted(.dateTime.day().month(.abbreviated).year().hour().minute())
    }

    /// The time of day alone, for an entry under a heading that already names its day.
    public static func timeOfDay(_ iso: String?) -> String {
        guard let then = ConsoleTime.date(iso) else { return "" }
        return then.formatted(date: .omitted, time: .shortened)
    }

    /// "Today", "Yesterday" or a date: the heading a log entry is filed under.
    public static func dayLabel(_ iso: String?, now: Date) -> String {
        guard let then = ConsoleTime.date(iso) else { return "Undated" }
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: then), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        return then.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
    }

    /// "Started 3 min ago", or the date and time for an old one: the way the website writes `when`.
    public static func when(_ iso: String?, now: Date, prefix: String = "") -> String {
        guard ConsoleTime.date(iso) != nil else { return "" }
        return prefix + timeAgo(iso, now: now)
    }

    /// "3 min ago (14:02)": where the exact moment matters.
    public static func whenAt(_ iso: String?, now: Date) -> String {
        guard let then = ConsoleTime.date(iso) else { return "" }
        if now.timeIntervalSince(then) >= datedFrom { return dateAndTime(iso) }
        return "\(timeAgo(iso, now: now)) (\(clockTime(iso, now: now)))"
    }

    /// A length of time: "42 s", "5 min", "2 h 14 min", "3 d 4 h".
    public static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "" }
        let total = Int(seconds)
        if total < 60 { return "\(total) s" }
        let minutes = total / 60
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 24 { return minutes % 60 > 0 ? "\(hours) h \(minutes % 60) min" : "\(hours) h" }
        let days = hours / 24
        return hours % 24 > 0 ? "\(days) d \(hours % 24) h" : "\(days) d"
    }

    /// A size in the binary units the flash layout is described in.
    public static func fileSize(_ bytes: Int) -> String {
        guard bytes >= 0 else { return "" }
        if bytes < 1024 { return "\(bytes) bytes" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KiB" }
        return String(format: "%.2f MiB", Double(bytes) / (1024 * 1024))
    }

    /// "1,264 bytes".
    public static func exactBytes(_ bytes: Int) -> String {
        "\(grouped(bytes)) bytes"
    }

    static func grouped(_ value: Int) -> String {
        let digits = String(abs(value))
        var out = ""
        for (index, character) in digits.enumerated() {
            if index > 0 && (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(character)
        }
        return value < 0 ? "-" + out : out
    }

    /// A size in bytes, and in larger units where that says something else.
    public static func sizeWords(_ bytes: Int) -> String {
        let short = fileSize(bytes)
        return short == exactBytes(bytes) ? short : "\(exactBytes(bytes)) (\(short))"
    }

    /// Wi-Fi signal strength in words and as a number of bars out of four.
    public static func signalQuality(_ rssi: Int?) -> (bars: Int, label: String)? {
        guard let rssi else { return nil }
        if rssi >= -55 { return (4, "Excellent") }
        if rssi >= -67 { return (3, "Good") }
        if rssi >= -75 { return (2, "Fair") }
        return (1, "Weak")
    }

    /// A number with a true minus sign: "−67".
    public static func signed(_ number: Int) -> String {
        number < 0 ? "\u{2212}\(abs(number))" : String(number)
    }

    public static func plural(_ count: Int, _ one: String, _ many: String? = nil) -> String {
        "\(count) \(count == 1 ? one : (many ?? one + "s"))"
    }

    /// A message as a sentence: some of the server's come without their full stop.
    public static func sentence(_ message: String) -> String {
        let words = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = words.last else { return words }
        return ".!?…".contains(last) ? words : words + "."
    }

    // MARK: People

    /// The start of an account id: enough to tell a handful of accounts apart at a glance.
    public static func shortAccount(_ sub: String?) -> String {
        let id = sub ?? ""
        return id.count > 8 ? "\(id.prefix(8))…" : id
    }

    /// What to call a person: the address, or failing that the start of the account id.
    public static func nameOf(_ person: Person?) -> String {
        if let email = person?.email, !email.isEmpty { return email }
        if let sub = person?.sub, !sub.isEmpty { return "account \(shortAccount(sub))" }
        return "an unknown account"
    }

    /// A board's name, shortened for a title: `cranium-0123abcd…`.
    public static func shortThing(_ thing: String) -> String {
        thing.count > 12 ? "\(thing.prefix(12))…" : thing
    }

    // MARK: Versions and boards

    static func version(_ text: String?) -> FirmwareVersion? {
        text.flatMap(FirmwareVersion.init(release:))
    }

    /// True if a board reports that it runs this version or a newer one: it will refuse the offer.
    public static func alreadyRuns(_ device: Device, version: String?) -> Bool {
        guard let target = self.version(version), let runs = self.version(device.fw?.version) else { return false }
        return runs >= target
    }

    /// The first firmware that starts an update by itself. Older images wait for Button 1.
    public static let firstWithNoButton = "1.7.2"

    /// True if a board reports firmware that holds an update until Button 1 is pressed.
    public static func asksForButton(_ device: Device) -> Bool {
        guard let runs = version(device.fw?.version) else { return false }
        return runs < FirmwareVersion(major: 1, minor: 7, revision: 2, build: 0)
    }

    /// True for a version that is not in the list of releases: it reached the board some other way.
    /// Nothing is said while the list has not been read, or while it is empty.
    public static func isUnregistered(_ version: String?, releases: [FirmwareRelease]?) -> Bool {
        guard let version, !version.isEmpty, let releases, !releases.isEmpty else { return false }
        return !releases.contains { $0.version == version }
    }

    /// A board that said that it is restarting, and has not been written off yet.
    public static func isRestarting(_ device: Device) -> Bool {
        device.online && device.ota?.state == "rebooting"
    }

    /// Online and not restarting.
    public static func isUp(_ device: Device) -> Bool {
        device.online && !isRestarting(device)
    }

    public static func isUnfinished(_ status: String) -> Bool {
        status == "QUEUED" || status == "IN_PROGRESS"
    }

    /// Whether a deployment still has a board waiting or at work. The status of the job does not
    /// say: a deployment cancelled without force keeps the boards that had started.
    public static func isUnderWay(_ deployment: Deployment) -> Bool {
        deployment.status == "IN_PROGRESS" || deployment.counts.inProgress + deployment.counts.queued > 0
    }

    static let settling: TimeInterval = 5 * 60

    /// True while a board that a cancellation found restarting or on trial still reports this deployment.
    public static func stillFinishing(_ deployment: Deployment, devices: [Device]?, now: Date) -> Bool {
        guard deployment.status == "CANCELED" else { return false }
        return (devices ?? []).contains { device in
            guard let ota = device.ota, ota.job == deployment.id, ota.state == "rebooting" || ota.state == "testing" else {
                return false
            }
            if device.online { return true }
            guard let since = ConsoleTime.date(device.lastSeen) else { return false }
            return now.timeIntervalSince(since) < settling
        }
    }

    /// True while a cancelled update may still change what a board runs.
    public static func stillSettling(_ execution: Execution, board: Device?, deployment: String, now: Date) -> Bool {
        guard execution.status == "CANCELED", execution.startedAt != nil, let ota = board?.ota,
              ota.job == deployment, ota.state != "idle", let since = ConsoleTime.date(execution.lastUpdatedAt) else {
            return false
        }
        return now.timeIntervalSince(since) < settling
    }

    /// Board counts as the overview's tiles draw them.
    public static func boardsCounted(_ devices: [Device]) -> (online: Int, quiet: Int, never: Int) {
        let online = devices.filter(isUp).count
        let quiet = devices.filter { !isUp($0) && $0.lastSeen != nil }.count
        return (online, quiet, devices.count - online - quiet)
    }

    /// The boards by the version they report: newest first, boards that have not said last.
    public static func versionGroups(_ devices: [Device]) -> [(version: String, members: [Device])] {
        var groups: [String: [Device]] = [:]
        for device in devices { groups[device.fw?.version ?? "", default: []].append(device) }
        let versions = groups.keys.sorted { a, b in
            if a.isEmpty || b.isEmpty { return !a.isEmpty }
            return (version(a) ?? FirmwareVersion(major: 0, minor: 0, revision: 0, build: 0))
                > (version(b) ?? FirmwareVersion(major: 0, minor: 0, revision: 0, build: 0))
        }
        return versions.map { ($0, groups[$0] ?? []) }
    }

    /// The deployment that is waiting for a board, from the deployments whose record has been read.
    public static func openOffer(for device: Device, deployments: [Deployment], details: [String: Deployment])
        -> (deployment: String, version: String?)? {
        for deployment in deployments where isUnderWay(deployment) {
            guard let detail = details[deployment.id] else { continue }
            if detail.executions.first(where: { $0.thing == device.thing })?.status == "QUEUED" {
                return (deployment.id, deployment.version)
            }
        }
        return nil
    }

    // MARK: Polling

    public static let pollInstalling: TimeInterval = 3
    public static let pollWaiting: TimeInterval = 10
    /// How often a page with nothing in flight is read again.
    public static let idleRefresh: TimeInterval = 60

    /// The polling interval for a set of execution statuses; 0 means do not poll.
    public static func pollInterval(_ statuses: [String?]) -> TimeInterval {
        var waiting = false
        for status in statuses {
            if status == "IN_PROGRESS" { return pollInstalling }
            if status == "QUEUED" { waiting = true }
        }
        return waiting ? pollWaiting : 0
    }

    /// An online board that waits is watched closely.
    public static func executionActivity(_ execution: Execution) -> String {
        execution.status == "QUEUED" && execution.online ? "IN_PROGRESS" : execution.status
    }

    public static func summaryActivity(_ deployment: Deployment, devices: [Device]) -> String? {
        if deployment.counts.inProgress > 0 { return "IN_PROGRESS" }
        if deployment.counts.queued == 0 { return nil }
        let online = devices.contains { $0.online && deployment.things.contains($0.thing) }
        return online ? "IN_PROGRESS" : "QUEUED"
    }

    /// An offline board is not waited on.
    public static func deviceActivity(_ device: Device) -> String? {
        guard device.online, let ota = device.ota, ota.state != "idle" else { return nil }
        return "IN_PROGRESS"
    }

    // MARK: The steps of an update

    /// In a heading and in the name of a step, "Button 1" is held together by a no-break space.
    public static let button1 = "Button\u{00A0}1"

    /// The steps of an update, in order: their name, what a step is called while the board is at
    /// it, and what it is called when the update stopped there.
    public static let steps: [(name: String, doing: String?, failed: String?)] = [
        ("Offered", nil, nil),
        ("Accepted by the board", "Waiting for \(button1)", "Not accepted"),
        ("Downloading", nil, "Download failed"),
        ("Download checked", "Checking the download", "Check failed"),
        ("Restarting", nil, "Did not start"),
        ("On trial", nil, "Rolled back"),
        ("Confirmed", nil, nil),
    ]
    static let accepted = 1
    static let downloaded = 2
    static let verified = 3
    static let restarted = 4
    static let tested = 5

    /// Told in the past: every one of these is about an update that is over.
    public static let refusals: [String: String] = [
        "not_newer": "the board already ran this version or a newer one",
        "too_large": "the image was larger than the board’s update slot",
        "bad_document": "the board could not read the update instructions",
        "unsupported": "the board did not support this kind of update",
        "url_not_allowed": "the download address was not one the board accepts",
    ]

    struct Failure {
        let at: Int?
        let title: String
        let text: String
        var replaced = false
    }

    static let failures: [String: Failure] = [
        "download_failed": Failure(at: 2, title: "The download failed", text: "The board could not download the image."),
        "digest_mismatch": Failure(at: 3, title: "The download was damaged",
                                   text: "What the board downloaded did not match the SHA-256 digest of the release, so the board discarded it."),
        "header_mismatch": Failure(at: 3, title: "Not the announced version",
                                   text: "The image the board downloaded does not carry the version that was announced, so the board discarded it."),
        "flash_error": Failure(at: nil, title: "The board could not store the update",
                               text: "Writing to the board’s flash memory failed."),
        "interrupted": Failure(at: nil, title: "Interrupted", text: "The board restarted before the update was complete."),
        "not_installed": Failure(at: 4, title: "Not installed",
                                 text: "The board restarted, but the bootloader did not start the new image. It turns away an image with a wrong signature or an older version."),
        "trial_lost": Failure(at: 5, title: "Its trial was cut short",
                              text: "The board runs this image with nothing left to bring the old one back, because a restore of the golden image was interrupted right after it began. The image has proved nothing. Repeat the gesture at the board to finish the restore.",
                              replaced: true),
    ]

    static func stepList(_ done: Int, current: Int? = nil, failed: Int? = nil, stopped: Int? = nil, ended: Bool = false,
                         refusal: String? = nil, unknown: Bool = false, lastSeen: Bool = false) -> [Step] {
        steps.enumerated().map { index, step in
            var state: Step.State = unknown ? .unknown : .upcoming
            if index < done { state = .done }
            else if index == failed { state = .failed }
            else if index == stopped { state = .stopped }
            else if index == current { state = .current }
            else if ended { state = .skipped }
            var label = step.name
            if state == .current || state == .stopped { label = step.doing ?? step.name }
            else if state == .failed { label = refusal ?? step.failed ?? step.name }
            return Step(label: label, state: state, word: lastSeen && state == .stopped ? "last seen here" : nil)
        }
    }

    /// The steps of an update with nothing done, for a list of what every update goes through.
    public static var stepsPreview: [Step] {
        steps.map { Step(label: $0.name, state: .upcoming, word: nil) }
    }

    static func firstSentence(_ text: String) -> String {
        guard let range = text.range(of: ". ") else { return text }
        return String(text[..<range.lowerBound]) + "."
    }

    static func describe(_ tone: Tone, _ icon: String, _ title: String, _ text: String, _ steps: [Step],
                         _ extra: (inout ExecutionWords) -> Void = { _ in }) -> ExecutionWords {
        var words = ExecutionWords(tone: tone, icon: icon, title: title, text: text, brief: firstSentence(text), steps: steps)
        extra(&words)
        return words
    }

    static let stillOpen = " The update stays open until the board reports back or the time limit ends."
    static let trialRule = "It is kept once the board has reconnected to AWS IoT; if it cannot, the bootloader puts the previous firmware back."

    static func mayHaveInstalled(_ entry: ExecutionSummary) -> Bool {
        entry.status == "SUCCEEDED" || entry.status == "IN_PROGRESS"
    }

    /// The other deployment that put this version on a board, from the board's own list of updates.
    static func otherInstall(_ history: [ExecutionSummary]?, deployment: String?, version: String?) -> String? {
        (history ?? []).first { entry in
            entry.deployment != deployment && (entry.version ?? DeploymentId.version(of: entry.deployment)) == version
                && mayHaveInstalled(entry)
        }?.deployment
    }

    /// True if a job that this console did not start may have put a version on a board.
    static func outsideInstall(_ history: [ExecutionSummary]) -> Bool {
        history.contains { ($0.version ?? DeploymentId.version(of: $0.deployment)) == nil && mayHaveInstalled($0) }
    }

    static func movedSince(_ board: Device?, _ ranAtEnd: String?) -> String {
        guard let now = board?.fw?.version, let ranAtEnd, now != ranAtEnd else { return "" }
        return board?.online == true ? " It has since moved to \(now)." : " When last seen, it had moved to \(now)."
    }

    /// Describe one board's part in a deployment.
    ///
    /// - Parameters:
    ///   - board: the board as the board list has it, where that was read
    ///   - deployment: the id of the deployment
    ///   - version: the version the deployment installs
    ///   - history: the board's own list of updates; nil while it has not been read
    ///   - historyCut: that list leaves older updates out
    ///   - unread: the board list has not been read yet
    public static func describeExecution(_ execution: Execution, board: Device? = nil, deployment: String? = nil,
                                         version: String? = nil, history: [ExecutionSummary]? = nil,
                                         historyCut: Bool = false, unread: Bool = false) -> ExecutionWords {
        let ranAtEnd = execution.ranAtEnd
        let reported = execution.reported
        let online = execution.online
        let progress = execution.progress
        let ranThen = ranAtEnd.map { " The board was running \($0) at the time." } ?? ""
        let kept = ranAtEnd.map { " It kept running the firmware it had, \($0)." } ?? " It kept running the firmware it had."
        let since = movedSince(board, ranAtEnd)
        var reports = ""
        if let reported {
            reports = online ? " The board reports that it runs \(reported)." : " When last seen, the board reported \(reported)."
        }
        let mayRetry = !unread && !(board.map { alreadyRuns($0, version: version) } ?? false)
        func again(_ next: String = "To try again, start a new deployment.") -> (inout ExecutionWords) -> Void {
            { words in
                if mayRetry {
                    words.next = next
                    words.retry = true
                }
            }
        }
        let target = version ?? "an update"
        func underWay(_ icon: String, _ at: Int, title: String, text: String, was: String, quiet: String,
                      extra: @escaping (inout ExecutionWords) -> Void = { _ in }) -> ExecutionWords {
            online
                ? describe(.live, icon, title, text, stepList(at, current: at), extra)
                : describe(.idle, icon, "Was \(was) when last seen", quiet, stepList(at, stopped: at, unknown: true, lastSeen: true))
        }

        switch execution.phase {
        case "waiting_for_device":
            if !online, let board, board.lastSeen == nil {
                return describe(.wait, "minus-circle", "Never connected",
                                "Power it up and check that it was provisioned; it will see this update when it first connects.",
                                stepList(0, current: 0))
            }
            if !online {
                return describe(.wait, "offline", "Board offline",
                                "The board is offline; it will see this update when it reconnects.", stepList(0, current: 0))
            }
            return describe(.wait, "clock", "Not picked up yet",
                            "The board is online but has not picked up the offer yet. That normally takes a few seconds.",
                            stepList(0, current: 0))
        case "waiting_for_button":
            return describe(.act, "press", "Press \(button1) on the board",
                            "The board has the offer and waits for someone to press \(button1). LED1 blinks quickly while the offer is open; Button 2 declines it.",
                            stepList(1, current: 1))
        case "starting":
            return underWay("download", 2, title: "Starting",
                            text: "The board has told AWS IoT that it starts this update, and downloads the image as soon as AWS IoT agrees. The firmware it runs is not touched yet.",
                            was: "starting \(target)", quiet: "The board went offline as it started this update.\(stillOpen)")
        case "downloading":
            return underWay("download", 2, title: progress.map { "Downloading \($0)%" } ?? "Downloading",
                            text: "The board is downloading the image into its spare flash slot. The firmware it runs is not touched yet.",
                            was: "downloading \(target)",
                            quiet: "The board went offline \(progress.map { "with the download at \($0)%" } ?? "during the download").\(stillOpen)") {
                $0.progress = progress
                $0.said = "Downloading"
            }
        case "verifying":
            return underWay("shield", 3, title: "Checking the download",
                            text: "The board is checking the size, the SHA-256 digest and the version in the signed header before it installs anything.",
                            was: "checking the download of \(target)",
                            quiet: "The board went offline while it was checking the download.\(stillOpen)")
        case "rebooting":
            return underWay("restart", 4, title: "Restarting",
                            text: "The board is restarting. The bootloader checks the signature before it starts the new firmware.",
                            was: "restarting into \(target)", quiet: "The board went offline while it was restarting.\(stillOpen)")
        case "testing":
            return underWay("pulse", 5, title: "On trial", text: "The new firmware is running on trial. \(trialRule)",
                            was: "on trial with \(target)", quiet: "The board went offline with the new firmware on trial. \(trialRule)")
        case "succeeded":
            let holds = ranAtEnd != nil && board?.online == true && board?.fw?.version == ranAtEnd && board?.fw?.confirmed == true
            var told = "The board confirmed the new firmware."
            if holds, let ranAtEnd { told = "The board runs \(ranAtEnd) and has confirmed it." }
            else if let ranAtEnd { told = "The board confirmed \(ranAtEnd) when this update ended.\(since)" }
            return describe(.good, "check-circle", "Installed and confirmed", told, stepList(steps.count))
        case "rolled_back":
            return describe(.bad, "undo", "Rolled back",
                            "The bootloader put the previous firmware back. The new firmware started but did not reconnect to AWS IoT, so it was never confirmed.\(ranAtEnd.map { " That left the board on \($0)." } ?? "")\(since)",
                            stepList(5, failed: 5, ended: true)) {
                if mayRetry { $0.next = "Fix the build, then upload a newer version and deploy that." }
            }
        case "declined":
            return describe(.warn, "minus-circle", "Declined on the board",
                            "Someone pressed Button 2 on the board to decline this update. Nothing was installed.\(ranThen)\(since)",
                            stepList(1, failed: 1, ended: true), again())
        case "refused":
            guard let reason = execution.reason else {
                return describe(.warn, "ban", "Refused or declined",
                                "This update was turned down on the board before anything was installed.\(ranThen)\(since)",
                                stepList(1, failed: 1, ended: true), again())
            }
            let why = refusals[reason]
            let said = why.map { "Refused: \($0)." } ?? "The board refused this update before installing anything."
            return describe(.warn, "ban", "Refused by the board", "\(said)\(ranThen)\(since)",
                            stepList(1, failed: 1, ended: true, refusal: "Refused")) { words in
                words.code = why == nil ? reason : nil
                if reason == "not_newer" {
                    words.next = "To put something else on it, upload a newer version and deploy that."
                } else {
                    again("Deal with that first, then start a new deployment.")(&words)
                }
            }
        case "failed":
            if let reason = execution.reason, let failure = failures[reason] {
                let timeline = failure.at.map { stepList($0, failed: $0, ended: true) }
                    ?? stepList(downloaded, stopped: downloaded, ended: true)
                return describe(.bad, "x-circle", failure.title, "\(failure.text)\(failure.replaced ? "" : kept)\(since)",
                                timeline, again())
            }
            let why = execution.reason.flatMap { refusals[$0] }
            let said = why.map { "The board stopped: \($0)." } ?? "The board reported that the update failed."
            let timeline = execution.reason != nil
                ? stepList(downloaded, stopped: downloaded, ended: true) : stepList(downloaded, unknown: true)
            return describe(.bad, "x-circle", "Failed", "\(said)\(kept)\(since)", timeline) { words in
                words.code = why == nil ? execution.reason : nil
                again()(&words)
            }
        case "cancelled":
            return describeCancelled(execution, board: board, deployment: deployment, version: version, history: history,
                                     historyCut: historyCut, unread: unread, reports: reports, again: again(), target: target)
        case "timed_out":
            return describe(.bad, "hourglass", "Timed out",
                            "The board started but did not report a result before the time limit.\(reports)",
                            stepList(downloaded, stopped: downloaded, ended: true),
                            again("Check that the board is powered and online, then start a new deployment."))
        case "removed":
            return describe(.idle, "minus", "Removed", "This board was taken out of the deployment.", stepList(0, ended: true))
        default:
            return describe(.idle, "minus", "Unknown state", "The server reported a state this console does not know.",
                            stepList(0)) { $0.code = execution.phase.isEmpty ? nil : execution.phase }
        }
    }

    private static func describeCancelled(_ execution: Execution, board: Device?, deployment: String?, version: String?,
                                          history: [ExecutionSummary]?, historyCut: Bool, unread: Bool, reports: String,
                                          again: @escaping (inout ExecutionWords) -> Void, target: String) -> ExecutionWords {
        let reported = execution.reported
        let online = execution.online
        let now = self.version(reported)
        let offered = self.version(version)
        let movedOn = now != nil && offered != nil && now! > offered!
        let runsIt = reported != nil && reported == version
        if execution.startedAt == nil {
            if runsIt || movedOn {
                let installedBy = runsIt ? otherInstall(history, deployment: deployment, version: version) : nil
                return describe(.idle, "stop", "Cancelled",
                                "Cancelled before the board started, so this deployment installed nothing.\(reports)",
                                stepList(accepted, ended: true)) { $0.installedBy = installedBy }
            }
            return describe(.idle, "stop", "Cancelled", "Cancelled before the board started. Nothing was installed.\(reports)",
                            stepList(accepted, ended: true), again)
        }
        if runsIt, let installedBy = otherInstall(history, deployment: deployment, version: version) {
            return describe(.idle, "stop", "Cancelled",
                            "Cancelled after the board had started, and it stopped there. Another deployment installed \(reported ?? "it").",
                            stepList(downloaded, stopped: downloaded, ended: true)) { $0.installedBy = installedBy }
        }
        if movedOn {
            return describe(.idle, "stop", "Cancelled",
                            "Cancelled after the board had started.\(reports) This page cannot tell how this update ended.",
                            stepList(downloaded, unknown: true)) { $0.unsure = true }
        }
        let wentThrough = runsIt && board?.fw?.confirmed == true && board?.ota?.last == "succeeded"
            && history != nil && !historyCut && !outsideInstall(history ?? [])
        if wentThrough {
            return describe(.warn, "alert", "Installed despite the cancellation",
                            "This deployment was cancelled, but the board had gone too far to be stopped. \(online ? "It now runs" : "When last seen, it ran") \(reported ?? "").",
                            stepList(steps.count)) {
                $0.next = "To replace it, upload a newer version and deploy that."
                $0.installed = true
            }
        }
        let reached = board?.ota.flatMap { $0.job == deployment ? $0.state : nil }
        if reached == "rebooting" || reached == "testing" {
            let at = reached == "rebooting" ? restarted : tested
            if !online {
                return describe(.idle, "restart",
                                "Was \(reached == "rebooting" ? "restarting into \(target)" : "on trial with \(target)") when last seen",
                                "This deployment was cancelled, but the board was already restarting into the new firmware, and it has gone offline since. What it ends up running will show here.",
                                stepList(at, stopped: at, unknown: true, lastSeen: true))
            }
            return describe(.live, "restart", "Finishing despite the cancellation",
                            "This deployment was cancelled, but the board was already restarting into the new firmware and cannot be stopped. What it ends up running will show here.",
                            stepList(at, current: at, ended: true))
        }
        if runsIt {
            return describe(.idle, "stop", "Cancelled",
                            "Cancelled after the board had started. \(online ? "The board now runs" : "When last seen, the board ran") \(reported ?? ""); how it got there is not on record.",
                            stepList(downloaded, unknown: true)) { $0.unsure = true }
        }
        if unread {
            return describe(.idle, "stop", "Cancelled",
                            "Cancelled after the board had started. What the board did next is still being read.",
                            stepList(downloaded, unknown: true)) { $0.unsure = true }
        }
        let at = reached == "verifying" ? verified : downloaded
        return describe(.idle, "stop", "Cancelled",
                        "Cancelled after the board had started. A board asks AWS before it installs, so it stops there and keeps the firmware it had.\(reports)",
                        stepList(at, stopped: at, ended: true), again)
    }

    /// The words for an execution status alone, where no phase is known (a board's history).
    public static func describeStatus(_ status: String) -> Look {
        switch status {
        case "QUEUED": return Look(.wait, "clock", "Waiting")
        case "IN_PROGRESS": return Look(.live, "restart", "Updating")
        case "SUCCEEDED": return Look(.good, "check-circle", "Installed")
        case "FAILED": return Look(.bad, "x-circle", "Failed")
        case "TIMED_OUT": return Look(.bad, "hourglass", "Timed out")
        case "REJECTED": return Look(.warn, "ban", "Refused or declined")
        case "REMOVED": return Look(.idle, "minus", "Removed")
        case "CANCELED": return Look(.idle, "stop", "Cancelled")
        default: return Look(.idle, "minus", "Unknown")
        }
    }

    /// The words for an entry of a board's history. `last` is how the board says its newest update
    /// ended, for that entry; the others only have their status.
    public static func describeHistory(_ status: String, last: String? = nil) -> Look {
        switch (status, last) {
        case ("FAILED", "rolled_back"): return Look(.bad, "undo", "Rolled back")
        case ("REJECTED", "declined"): return Look(.warn, "minus-circle", "Declined on the board")
        case ("REJECTED", "refused"): return Look(.warn, "ban", "Refused by the board")
        default: return describeStatus(status)
        }
    }

    // MARK: Every update of a board (GET /api/updates)

    /// How an update came: "over Bluetooth from Vihaan’s phone", "deployment cranium-1-14-0-…", "USB or another tool".
    public static func howWords(_ update: BoardUpdate) -> String {
        switch update.how {
        case .bluetooth:
            let name = update.who?.name ?? ""
            return name.isEmpty ? "over Bluetooth from a phone" : "over Bluetooth from \(name)\u{2019}s phone"
        case .deployment:
            return update.deployment.map { "deployment \($0)" } ?? "a deployment"
        case .usbOrOther:
            return "USB or another tool"
        }
    }

    /// How an update ended, as a badge.
    public static func updateOutcome(_ outcome: BoardUpdate.Outcome) -> Look {
        switch outcome {
        case .kept: return Look(.good, "check-circle", "Kept")
        case .rolledBack: return Look(.bad, "undo", "Rolled back")
        case .notInstalled: return Look(.warn, "minus-circle", "Not installed")
        case .pending: return Look(.wait, "clock", "Pending")
        }
    }

    /// An update's title: the version it installs.
    public static func updateTitle(_ update: BoardUpdate) -> String {
        update.to ?? "Unknown version"
    }

    /// The line under an update's title: "from 1.13.0+0 · over Bluetooth from Vihaan’s phone · 2 h ago".
    public static func updateDetail(_ update: BoardUpdate, now: Date) -> String {
        var parts: [String] = []
        if let from = update.from { parts.append("from \(from)") }
        parts.append(howWords(update))
        let time = timeAgo(update.time, now: now)
        if !time.isEmpty { parts.append(time) }
        return parts.joined(separator: " · ")
    }

    /// The Overview's line for the newest update, while none is in progress:
    /// "Last: 1.14.0+0 · over Bluetooth from Vihaan’s phone · 2 h ago".
    public static func lastUpdateLine(_ update: BoardUpdate, now: Date) -> String {
        var parts = [updateTitle(update), howWords(update)]
        let time = timeAgo(update.time, now: now)
        if !time.isEmpty { parts.append(time) }
        return "Last: " + parts.joined(separator: " · ")
    }

    static let lastUpdate: [String: UpdateWords] = [
        "none": UpdateWords(tone: .idle, icon: "minus", title: "No update in progress", quiet: true),
        "succeeded": UpdateWords(tone: .good, icon: "check-circle", title: "Last update succeeded"),
        "failed": UpdateWords(tone: .bad, icon: "x-circle", title: "Last update failed"),
        "rolled_back": UpdateWords(tone: .bad, icon: "undo", title: "Last update was rolled back"),
        "declined": UpdateWords(tone: .warn, icon: "minus-circle", title: "Last update was declined on the board"),
        "refused": UpdateWords(tone: .warn, icon: "ban", title: "Last update was refused by the board"),
        "cancelled": UpdateWords(tone: .idle, icon: "stop", title: "Last update was cancelled"),
    ]

    /// Describe what a board last said about updates. An offline board's words are old news, and say so.
    public static func describeUpdate(_ device: Device) -> UpdateWords {
        guard let ota = device.ota else {
            return UpdateWords(tone: .idle, icon: "minus", title: "Nothing reported", quiet: true)
        }
        let online = device.online
        let version = DeploymentId.version(of: ota.job)
        let target = version ?? "an update"
        func live(_ tone: Tone, _ icon: String, _ title: String, _ text: String, progress: Int? = nil,
                  was: String? = nil) -> UpdateWords {
            let lowered = title.prefix(1).lowercased() + title.dropFirst()
            return UpdateWords(tone: online ? tone : .idle, icon: icon,
                               title: online ? title : "Was \(was ?? lowered) when last seen",
                               text: online ? text : "", progress: online ? progress : nil, deployment: ota.job)
        }
        switch ota.state {
        case "idle":
            var last = lastUpdate[ota.last] ?? lastUpdate["none"]!
            let refusal = refusals[ota.error]
            let why = failures[ota.error]?.title ?? refusal.map { "Because \($0)." } ?? ""
            last.text = ota.last == "failed" || ota.last == "refused" ? why : ""
            if ota.last == "none" || lastUpdate[ota.last] == nil, !online {
                last.title = "No update in progress when last seen"
            }
            return last
        case "awaiting_user":
            return live(.act, "press", "Press \(button1) on the board",
                        "\(version ?? "An update") is on offer. Button 1 on the board installs it, Button 2 declines.",
                        was: "waiting for \(button1)")
        case "downloading":
            return live(.live, "download", "Downloading \(target)", "", progress: ota.progress)
        case "verifying":
            return live(.live, "shield", "Checking the download of \(target)", "")
        case "rebooting":
            return live(.live, "restart", "Restarting into \(target)", "")
        case "testing":
            return live(.live, "pulse", "On trial: \(target)", "It is kept once the board has reconnected.",
                        was: "on trial with \(target)")
        case "bluetooth":
            return live(.live, "download", "Open for an update over Bluetooth",
                        "A person at the board opened Bluetooth for a phone. Updates from here wait until it closes.",
                        was: "open for an update over Bluetooth")
        default:
            return live(.live, "restart", "Updating", "")
        }
    }

    /// Where the boards of a deployment that went through stand today: `current` (every one online,
    /// on this version, confirmed), `unheard` (nothing speaks against it), or `moved` (some report
    /// another version).
    public static func installStanding(_ deployment: Deployment, devices: [Device]?)
        -> (state: String, boards: [Device], moved: [Device]) {
        let boards = (devices ?? []).filter { deployment.things.contains($0.thing) }
        let moved = deployment.version == nil ? [] : boards.filter { $0.fw != nil && $0.fw?.version != deployment.version }
        if !moved.isEmpty { return ("moved", boards, moved) }
        let current = !boards.isEmpty && boards.count == deployment.things.count && boards.allSatisfy {
            $0.online && $0.fw?.version == deployment.version && $0.fw?.confirmed == true
        }
        return (current ? "current" : "unheard", boards, moved)
    }

    /// The badge for a deployment as a whole.
    public static func describeDeployment(_ deployment: Deployment, devices: [Device]? = nil) -> Look {
        let counts = deployment.counts
        let total = deployment.things.isEmpty ? counts.total : deployment.things.count
        switch deployment.status {
        case "IN_PROGRESS":
            return counts.inProgress > 0 ? Look(.live, "restart", "Updating") : Look(.wait, "clock", "Waiting for boards")
        case "COMPLETED":
            if total > 0 && counts.succeeded == total {
                let what = deployment.version ?? "The update"
                let verb = installStanding(deployment, devices: devices).state == "current" ? "is" : "was"
                return Look(.good, "check-circle", "Succeeded",
                            said: "\(what) \(verb) installed and confirmed\(total == 1 ? "" : " on \(total) boards").")
            }
            if counts.succeeded > 0 {
                return Look(.warn, "alert", "Partly succeeded", said: "The last deployment partly succeeded.")
            }
            if counts.failed + counts.timedOut > 0 {
                return Look(.bad, "x-circle", "Failed", said: "The last deployment failed.")
            }
            return Look(.idle, "minus-circle", "Not installed")
        case "CANCELED":
            if counts.inProgress > 0 {
                return Look(.live, "restart", "Cancelled, \(plural(counts.inProgress, "board")) still working")
            }
            if counts.succeeded > 0 {
                return Look(.warn, "alert", "Cancelled, \(plural(counts.succeeded, "board")) finished",
                            said: "The last deployment was cancelled, but \(plural(counts.succeeded, "board")) finished it.")
            }
            return Look(.idle, "stop", "Cancelled")
        case "SCHEDULED": return Look(.wait, "clock", "Scheduled")
        case "DELETION_IN_PROGRESS": return Look(.idle, "minus", "Being deleted")
        default: return Look(.idle, "minus", "Unknown")
        }
    }

    static let countWords: [(name: String, label: String, tone: Tone, icon: String)] = [
        ("succeeded", "succeeded", .good, "check-circle"),
        ("inProgress", "updating", .live, "restart"),
        ("queued", "waiting", .wait, "clock"),
        ("failed", "failed", .bad, "x-circle"),
        ("timedOut", "timed out", .bad, "hourglass"),
        ("rejected", "refused or declined", .warn, "ban"),
        ("canceled", "cancelled", .idle, "stop"),
        ("removed", "removed", .idle, "minus"),
    ]

    /// The non-zero board counts of a deployment, in a fixed order. `atButton` of the waiting boards
    /// are waiting for a person.
    public static func describeCounts(_ counts: Counts, atButton: Int = 0) -> [CountLine] {
        let pressing = min(atButton, counts.queued)
        var lines = countWords.compactMap { entry -> CountLine? in
            let value = counts.value(entry.name)
            guard value > 0, !(entry.name == "queued" && counts.queued == pressing) else { return nil }
            return CountLine(name: entry.name, count: entry.name == "queued" ? counts.queued - pressing : value,
                             label: entry.label, tone: entry.tone, icon: entry.icon)
        }
        if pressing > 0 {
            lines.insert(CountLine(name: "atButton", count: pressing, label: "waiting for \(button1)", tone: .act,
                                   icon: "press"), at: 0)
        }
        return lines
    }

    /// The counts in a sentence: "2 succeeded, 1 waiting".
    public static func countSentence(_ counts: Counts, atButton: Int = 0) -> String {
        describeCounts(counts, atButton: atButton).map { "\($0.count) \($0.label)" }.joined(separator: ", ")
    }

    /// The boards that wait for a person, among those of these deployments.
    public static func waitingForButton(_ devices: [Device], deployments ids: Set<String>) -> Int {
        devices.filter { $0.online && $0.ota?.state == "awaiting_user" && ids.contains($0.ota?.job ?? "") }.count
    }

    // MARK: Cancelling and revoking

    /// What to say once a deployment has been cancelled.
    public static func cancelNotice(force: Bool, withdrawn: Bool, started: Int) -> String {
        if withdrawn { return "Stop requested. Boards that had started have been asked to stop." }
        if force {
            return started > 0
                ? "Cancelled. Boards that had started have been asked to stop."
                : "Cancelled. Boards that had not started are no longer offered this update."
        }
        return started > 0
            ? "Cancelled. \(plural(started, "board that had started carries", "boards that had started carry")) on."
            : "Cancelled. Boards that had not started are no longer offered this update."
    }

    public enum RevocationState: Equatable, Sendable {
        case complete, incomplete, unknown
    }

    /// Where the revocation of a release stands; nil for a release that is not revoked.
    public static func revocationState(_ release: FirmwareRelease) -> RevocationState? {
        guard !release.isActive else { return nil }
        guard let mark = release.revoked else { return .unknown }
        if mark.enforcedAt != nil { return .complete }
        return mark.recordsEnforcement ? .incomplete : .unknown
    }

    public static let revocationOpen = "The server has not recorded that the image is refused and that every open deployment of this release is cancelled."

    /// That boards report a release that was just revoked.
    public static func stillRunning(_ boards: [Device]) -> String {
        let heard = boards.filter(\.online).count
        let quiet = boards.count - heard
        let who: String
        if boards.count == 1 {
            who = "\(boards[0].thing) \(heard == 1 ? "still runs it" : "last reported running it")"
        } else {
            who = [heard > 0 ? plural(heard, "board still runs it", "boards still run it") : nil,
                   quiet > 0 ? "\(plural(quiet, "board")) last reported running it" : nil]
                .compactMap { $0 }.joined(separator: " and ")
        }
        return "\(who); to replace it there, upload a newer version and deploy that."
    }

    /// What to say once a revocation has gone through. `cancelled` is nil when the server only said
    /// that all is in place; `again`: the release was revoked before this request.
    public static func revocationNotice(_ version: String, cancelled: [String]?, again: Bool, running: [Device] = []) -> String {
        let still = running.isEmpty ? "" : " \(stillRunning(running))"
        guard let cancelled else {
            return (again
                ? "The revocation of \(version) is in place: its image is refused and no deployment of it is open."
                : "\(version) was revoked already, and that revocation is in place.") + still
        }
        let lead = again ? "The revocation of \(version) is in place." : "Revoked \(version)."
        if cancelled.isEmpty { return "\(lead) No deployment of it was still open.\(still)" }
        let stopped = plural(cancelled.count, "unfinished deployment was", "unfinished deployments were")
        return "\(lead) \(stopped) cancelled.\(still)"
    }

    // MARK: Errors

    static let signedWrongly = "This image is not signed the way this project requires: an ECDSA P-256 signature, with a hash of the public key. Sign it with the project’s imgtool settings."
    static let plainWords: [String: String] = [
        "unexpected_tlv": signedWrongly,
        "malformed_tlv": "The signature area of this image cannot be read. Build and sign it again.",
        "bad_signature_encoding": "The signature in this image cannot be read. Build and sign it again.",
    ]

    /// What to say about a failed request: the server's wording, unless it is written in jargon.
    public static func plainMessage(_ error: Error) -> String {
        if let error = error as? APIError {
            return plainWords[error.code] ?? error.message
        }
        return UserMessage.text(for: error)
    }

    /// The server's code and request id, to refer to a failed request by.
    public static func problemRef(_ error: Error) -> String? {
        guard let error = error as? APIError else { return nil }
        let coded = error.status >= 400 && !["gateway", "http", "unauthorized"].contains(error.code)
            && !error.code.hasPrefix("http_")
        var parts: [String] = []
        if coded { parts.append("Code \(error.code)") }
        if let id = error.requestId, !id.isEmpty { parts.append("Request \(id)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A failed action: what did not happen, then the server's own words. Only a refusal says for
    /// certain that nothing was done.
    public static func failure(_ refusal: String, _ error: Error) -> String {
        let refused = (error as? APIError)?.isRefusal ?? (error is FreshSignInError || error is AuthError)
        let lead = refused ? refusal : "It is not certain whether this went through."
        return "\(lead) \(sentence(plainMessage(error)))"
    }

    // MARK: The activity log

    struct AuditAction {
        let done: String
        /// The whole sentence for an entry that has no label.
        var doneAlone: String? = nil
        let tried: String
        let triedAlone: String
        let icon: String
    }

    // What each action of the activity log is called (core.js, `AUDIT_ACTIONS`). `done` and `tried`
    // read on into the entry's label: a version, a board, a token. Where `{}` stands in them the label
    // goes there, and the words after it follow it. A deployment is named by the version it installs,
    // and the boards it went to follow the sentence (`auditBoards`).
    static let auditActions: [String: AuditAction] = [
        // The alert rules, for everybody who gets the alerts (console 2.12.0).
        "alert.rules": AuditAction(done: "changed the alert rules", doneAlone: "changed the alert rules",
                                   tried: "tried to change the alert rules", triedAlone: "tried to change the alert rules", icon: "bell"),
        "firmware.upload": AuditAction(done: "uploaded firmware", tried: "tried to upload", triedAlone: "tried to upload a file", icon: "upload"),
        "firmware.revoke": AuditAction(done: "revoked firmware", tried: "tried to revoke firmware", triedAlone: "tried to revoke a release", icon: "ban"),
        "deployment.create": AuditAction(done: "deployed", doneAlone: "started a deployment", tried: "tried to deploy",
                                         triedAlone: "tried to start a deployment", icon: "send"),
        "deployment.cancel": AuditAction(done: "cancelled the deployment of", tried: "tried to cancel the deployment of",
                                         triedAlone: "tried to cancel a deployment", icon: "stop"),
        // From the phone apps, for an update over Bluetooth.
        "firmware.download": AuditAction(done: "downloaded {} to a phone", doneAlone: "downloaded firmware to a phone",
                                         tried: "tried to download", triedAlone: "tried to download firmware", icon: "download"),
        "pairing.read": AuditAction(done: "read the Bluetooth passkey of", tried: "tried to read the Bluetooth passkey of",
                                    triedAlone: "tried to read a Bluetooth passkey", icon: "shield"),
        // The check a phone makes right before it sends a release over Bluetooth.
        "firmware.bluetooth_send": AuditAction(done: "was cleared to send {} over Bluetooth", doneAlone: "was cleared to send firmware over Bluetooth",
                                               tried: "tried to send {} over Bluetooth", triedAlone: "tried to send firmware over Bluetooth", icon: "chip"),
        "token.create": AuditAction(done: "made API token", tried: "tried to make API token", triedAlone: "tried to make an API token", icon: "key"),
        "token.revoke": AuditAction(done: "revoked API token", tried: "tried to revoke API token", triedAlone: "tried to revoke an API token", icon: "key"),
        // A sign-in with password and code, on the website or a phone app (`signedInOn`).
        "account.sign_in": AuditAction(done: "signed in", tried: "tried to sign in", triedAlone: "tried to sign in", icon: "user"),
        // A command that changed a board at its serial console, over USB, named by the board's device ID.
        "serial.command": AuditAction(done: "ran a command on {} over USB", doneAlone: "ran a command on a board over USB",
                                      tried: "tried to put on record a command on {} over USB",
                                      triedAlone: "tried to put on record a command run over USB", icon: "chip"),
        // The customer site's accounts, from the console's Customers page (docs/customer-site.md): a customer
        // by their e-mail address, and "a customer" after a board is that address where the entry has it.
        "customer.create": AuditAction(done: "invited the customer", tried: "tried to invite the customer",
                                       triedAlone: "tried to invite a customer", icon: "user"),
        "customer.resend": AuditAction(done: "sent the invitation again to", doneAlone: "sent an invitation again",
                                       tried: "tried to send the invitation again to", triedAlone: "tried to send an invitation again",
                                       icon: "send"),
        "customer.assign": AuditAction(done: "gave {} to a customer", tried: "tried to give {} to a customer",
                                       triedAlone: "tried to give a board to a customer", icon: "chip"),
        "customer.unassign": AuditAction(done: "took {} back from a customer", tried: "tried to take {} back from a customer",
                                         triedAlone: "tried to take a board back from a customer", icon: "undo"),
        "customer.disable": AuditAction(done: "switched off the customer account of", tried: "tried to switch off the customer account of",
                                        triedAlone: "tried to switch off a customer account", icon: "ban"),
        "customer.enable": AuditAction(done: "switched on the customer account of", tried: "tried to switch on the customer account of",
                                       triedAlone: "tried to switch on a customer account", icon: "check"),
        // A new board registered in AWS IoT through the console (docs/new-board-setup.md).
        "device.register": AuditAction(done: "registered", doneAlone: "registered a board", tried: "tried to register",
                                       triedAlone: "tried to register a board", icon: "chip"),
        // Board setup's Wi-Fi defaults handed to a release manager (docs/new-board-setup.md).
        "setup.wifi_defaults": AuditAction(done: "read the Wi-Fi defaults", tried: "tried to read the Wi-Fi defaults",
                                           triedAlone: "tried to read the Wi-Fi defaults", icon: "lock"),
        // An export of the console's Database page, by its table (docs/database.md).
        "db.export": AuditAction(done: "exported the {} table", doneAlone: "exported from the database",
                                 tried: "tried to export the {} table", triedAlone: "tried to export from the database",
                                 icon: "download"),
    ]

    /// The customer actions whose target is a board, and whose sentence ends with the customer.
    static let customerBoard: Set<String> = ["customer.assign", "customer.unassign"]

    static let signedInOn = ["web": "signed in on the website", "phone": "signed in on the phone app"]

    /// What a command at a board's serial console did, with the board where {} stands. What was typed
    /// after the command is never recorded, so never said.
    public static let serialWords: [String: String] = [
        "INIT": "set up {} from factory mode over USB",
        "SET_ID": "changed the device ID of {} over USB",
        "RESET_CONFIG": "cleared the cloud settings of {} over USB",
        "FACTORY_RESET": "erased {} back to factory mode over USB",
        "WIFI": "set the Wi-Fi network of {} over USB",
        "WIFI_SEC": "set the Wi-Fi network and its security mode of {} over USB",
        "CLEAR_WIFI": "erased the Wi-Fi network of {} over USB",
        "CLOUD": "set the AWS IoT endpoint and download address of {} over USB",
        "KEYGEN": "made a new device key on {} over USB",
        "MQTT_HOST": "set the AWS IoT endpoint of {} over USB",
        "MQTT_RECONNECT": "reconnected {} to AWS IoT over USB",
        "BUTTON": "pressed a button of {} over USB",
        "REBOOT": "restarted {} over USB",
        "ENTER_BOOTLOADER": "restarted {} into its bootloader over USB",
    ]

    static let auditOutcomes: [String: Look] = [
        "rejected": Look(.warn, "ban", "Refused"),
        "denied": Look(.bad, "lock", "Not allowed"),
        "error": Look(.bad, "alert", "Server error"),
    ]

    /// Why the server refused a request or failed at it, in words, for a log line that only has the code.
    public static let refusalWords: [String: String] = [
        "account_inactive": "The account is not active",
        "already_cancelled": "That deployment was already cancelled",
        "already_finished": "That deployment had already finished",
        "already_revoked": "That release was already revoked",
        "audit_failed": "The change could not be written to this log",
        "bad_header": "The image header cannot be read",
        "bad_signing_key": "The server’s signing key cannot be read",
        "cancel_refused": "AWS IoT would not cancel it",
        "forbidden": "This account may not do that",
        "internal_error": "Something went wrong on the server",
        "invalid_body": "The request could not be read",
        "invalid_deployment": "Not a valid deployment ID",
        "invalid_filename": "The file name has characters the server does not accept, or is too long",
        "invalid_json": "The request could not be read",
        "invalid_thing": "Not a valid board name",
        "invalid_things": "The list of boards is not valid",
        "invalid_version": "Not a valid version number",
        "not_found": "There is nothing at that address",
        "payload_too_large": "The request was too large",
        "release_manager_required": "Only a release manager can do this",
        "revoke_incomplete": "The revocation did not finish",
        "throttled": "AWS asked the server to slow down",
        "timeout": "The server ran out of time",
        "unauthorized": "The sign-in was not accepted",
        "unknown_deployment": "There is no such deployment",
        "unknown_device": "A board is not registered",
        "unknown_version": "There is no such release",
        "image_unavailable": "The image could not be read; it may have been revoked",
        "image_mismatch": "The stored image is not the one that was verified",
        "invalid_name": "Not the name of a board over Bluetooth",
        "invalid_board": "Not the name of a board over Bluetooth",
        "invalid_sha256": "Not a valid SHA-256",
        "sha256_mismatch": "The phone’s image is not the release’s",
        "no_pairing": "No board online was pairing under that name",
        "unsupported_flags": "Uses image options this project does not",
        "upload_conflict": "Another upload was under way at that moment",
        "wrong_key": "Signed with a different key than this project’s",
        "bad_signature": "The signature is not valid",
        "unsigned": "Not signed",
        "hash_mismatch": "The file is damaged",
        "bad_magic": "Not an MCUboot image",
        "not_an_image": "Not an MCUboot image",
        "too_small": "Too small to be a firmware image",
        "too_large": "Too large for the board’s slot",
        "truncated": "Shorter than its header says",
        "wrong_target": "Not built for this product’s flash layout",
        "trailing_data": "Has data after the signature",
        "unexpected_tlv": "Not signed the way this project requires",
        "malformed_tlv": "The signature area cannot be read",
        "bad_signature_encoding": "The signature cannot be read",
        "version_exists": "That version is already registered",
        "version_not_newer": "Not newer than the highest version registered",
        "version_zero": "Version 0.0.0+0 is never accepted",
        "device_busy": "A board had an unfinished update",
        "release_revoked": "The release is revoked",
        "invalid_token": "The API token was not valid, or had been revoked or had expired",
        "token_not_allowed": "An API token cannot be used for that",
        "phone_not_allowed": "The phone app’s sign-in cannot be used for that",
        "phone_sign_in_again": "A change from the phone needs a sign-in in the last 15 minutes",
        "too_many_tokens": "That person already had as many API tokens as one may have",
        "invalid_token_name": "The token’s name was empty, too long or not one line",
        "invalid_days": "The token’s lifetime was not a whole number of days from 1 to 90",
        "invalid_token_id": "Not a valid token ID",
        "unknown_token": "That person has no API token with that ID",
        "token_already_revoked": "That API token was already revoked",
        "invalid_time": "A time was not written the way the server reads times",
        "invalid_range": "The time range was empty, backwards or longer than 31 days",
        "invalid_kinds": "The list of kinds of event was not valid",
        "invalid_hours": "The number of hours was not a whole number from 1 to 168",
        "invalid_tags": "The list of sources of the board log was not valid",
        "invalid_command": "Not a command that changes a board at its serial console",
        "invalid_device": "Not a board’s device ID",
        "unexpected_field": "The request held more than the command, the device ID and the version",
        "rate_limited": "More serial console commands in a minute than are recorded for one person",
        // A command to a board, and a person's own e-mail alerts.
        "already_subscribed": "Alerts already go to that address",
        "invalid_seconds": "A board blinks for 1 to 60 seconds",
        "no_email": "The account has no e-mail address",
        "not_confirmed": "The subscription waits for its e-mail to be confirmed",
        "not_subscribed": "Alerts do not go to that address",
        // The fleet (docs/fleet.md): board types, flash layouts, groups, staged rollouts, sightings and notes.
        "incompatible_board": "The release is for another type of board",
        "incompatible_layout": "The release is built for another flash layout",
        "invalid_layout_tlv": "The flash layout in the image was not a positive whole number",
        "invalid_layout": "The flash layout was not a whole number from 1",
        "bluetooth_only": "The board has no Wi-Fi and updates over Bluetooth from a phone",
        "invalid_type": "Not a board type this console knows",
        "unknown_board": "The image is for a board type this console does not know",
        "invalid_board_tlv": "The board type in the image was not one short word",
        "invalid_notes": "The note was not one line of up to 500 characters",
        "unknown_group": "There is no such group",
        "invalid_group": "Not the id of a group",
        "name_taken": "Another group already has that name",
        "too_many_groups": "There can be at most 50 groups",
        "group_changed": "Someone changed the group at the same moment",
        "nothing_to_change": "The request named nothing to change",
        "unknown_rollout": "There is no such staged rollout",
        "invalid_rollout": "Not the id of a staged rollout",
        "invalid_target": "Not a target of a rollout: boards, a group, a type or the fleet",
        "invalid_types": "The list of board types and their releases was not valid",
        "invalid_canary": "The canary was not a whole number from 1 to 5",
        "invalid_wave": "The first wave was not a whole number from 1 to 50 boards",
        "invalid_abortPercent": "The share of failures to stop at was not a whole number from 1 to 100",
        "invalid_stages": "The number of stages was not a whole number from 1 to 10",
        "invalid_batch": "The batch sizes were not a percent or a count for each stage but the last",
        "invalid_soakMinutes": "The soak time was not a whole number of minutes from 0 to 60",
        "nothing_to_deploy": "No board would take the release",
        "too_many_boards": "A rollout takes at most 100 boards",
        "plan_changed": "The plan had changed since it was shown",
        "no_older_release": "There is no older release of that type to go back to",
        "rollout_changed": "The rollout moved on while it was being cancelled",
        "rollout_unrecorded": "The rollout could not be recorded, so its canary was withdrawn",
        "partly_started": "Only some of the rollouts could be started",
        "invalid_healthGate": "The health gate was not on or off with 0 to 120 minutes",
        // The alert rules (cloud/api/src/handlers/alerts.mjs).
        "invalid_rules": "The alert rules asked for were not rules, or not within their limits",
        "rules_changed": "Someone changed the alert rules at the same moment",
        // The phone apps (the API's handlers/apps.mjs): publishing the Android app, and its download links.
        "version_code_not_higher": "Its versionCode is not higher than the newest Android app’s",
        "apk_missing": "No APK had arrived in S3 for that version",
        "ipa_missing": "No IPA had arrived in S3 for that version",
        "ipa_unreadable": "The IPA that arrived could not be read as an iPhone app",
        "ipa_mismatch": "The IPA was not the app, the version, the build or the configuration it was published as",
        "build_not_higher": "Its build is not higher than the newest iPhone app’s",
        "invalid_build": "The build was not a whole number",
        "unknown_source": "There was no SideStore link at that address",
        "no_source": "There was no SideStore link to turn off",
        "source_conflict": "The SideStore link was being changed at the same moment",
        "size_mismatch": "The APK that arrived was of another size",
        "checksum_missing": "The APK that arrived had no SHA-256 of its own",
        "publish_conflict": "Another release of the app was being published at the same moment",
        "invalid_via": "Not a way to hand out a link: a QR code, or none",
        "invalid_version_code": "The versionCode was not a whole number",
        "invalid_size": "The size was not a whole number of bytes, up to 100 MB",
        "unversioned": "The bucket kept no version of the APK",
        // The customer site's customers (the API's handlers/customers.mjs) and its own API.
        "customers_not_set_up": "This deployment has no customer pool",
        "customer_site_has_no_address": "The customer site has no address yet, so an invitation would lead nowhere",
        "invalid_customer": "Not a valid customer ID",
        "invalid_email": "Not an e-mail address",
        "unknown_customer": "There is no customer with that ID",
        "customer_exists": "There is a customer with that address already",
        "customer_not_invited": "That customer has signed in already, so there was no invitation to send again",
        "already_assigned": "That board was that customer’s already",
        "board_taken": "That board belongs to another customer",
        "not_assigned": "That board was not that customer’s",
        "not_your_board": "That customer has no such board",
        "unavailable": "The account could not be checked just then",
        "invalid_id": "Not a board’s identifier of 16 hex digits",
        "invalid_csr": "Not a certificate signing request a board makes",
        "csr_mismatch": "The signing request is for another board",
        "already_registered": "That board has a certificate already",
        "board_mismatch": "That board is registered as another type",
        "certificate_mismatch": "AWS IoT issued a certificate for another key",
        // Board setup's Wi-Fi defaults (docs/new-board-setup.md).
        "wifi_defaults_unavailable": "The console could not read its Wi-Fi defaults just then",
        "wifi_defaults_invalid": "The stored Wi-Fi defaults break the firmware’s rules",
        // The console's Database page (docs/database.md).
        "unknown_table": "There is no such table",
        "invalid_filter": "A filter of the Database page was not valid",
        "invalid_key": "An item’s key was empty, too long or not plain text",
        "invalid_format": "An export is CSV or JSON",
        "unknown_item": "There is no item with that key",
    ]

    struct AuditDetail {
        let label: String
        var code = false
        var sentence = false
        var say: (@Sendable (String) -> String)? = nil
    }

    /// What the API records with an entry, in the words of the console and in the order in which a
    /// line reads best.
    static let auditDetailOrder = ["code", "incomplete", "filename", "version", "things", "force", "reason", "cancelled",
                                   "size", "sha256", "token", "tokenState", "board", "thing", "boards", "command", "from",
                                   "client", "name", "days", "withdrawn", "email", "customer", "label"]
    static let revocationSteps = ["tag": "refusing the image", "cancel": "cancelling the deployments",
                                  "record": "recording that it is done"]
    static let auditDetails: [String: AuditDetail] = [
        "code": AuditDetail(label: "Refused with", code: true),
        "incomplete": AuditDetail(label: "Left undone", sentence: true, say: { value in
            value.split(separator: " ").map { revocationSteps[String($0)] ?? String($0) }.joined(separator: ", ")
        }),
        "filename": AuditDetail(label: "File", code: true),
        "version": AuditDetail(label: "Version", code: true),
        "things": AuditDetail(label: "Boards"),
        "force": AuditDetail(label: "Asked to", say: { value in
            value == "true" ? "withdraw the offer and stop boards that had started" : value == "false" ? "withdraw the offer" : value
        }),
        "reason": AuditDetail(label: "Reason", sentence: true),
        "cancelled": AuditDetail(label: "Cancelled", say: { value in
            value == "true" ? "all the same" : value == "false" ? "no" : value
        }),
        "size": AuditDetail(label: "Size", say: { value in Int(value).map(exactBytes) ?? value }),
        "sha256": AuditDetail(label: "SHA-256", code: true),
        "token": AuditDetail(label: "With API token", code: true),
        "tokenState": AuditDetail(label: "The token had", say: { $0 == "revoked" ? "been revoked" : $0 }),
        "board": AuditDetail(label: "To board", code: true),
        // The board whose Bluetooth passkey was read, by its thing name.
        "thing": AuditDetail(label: "Board", code: true),
        // The boards of a deployment of more than two, by thing name; up to two, the sentence names them.
        "boards": AuditDetail(label: "To"),
        "command": AuditDetail(label: "Command", code: true),
        "from": AuditDetail(label: "From", say: { $0 == "phone" ? "the phone app" : $0 }),
        "client": AuditDetail(label: "On", say: { ["web": "the website", "phone": "the phone app"][$0] ?? $0 }),
        "name": AuditDetail(label: "Named", sentence: true),
        "days": AuditDetail(label: "Valid for", say: { value in
            value.allSatisfy(\.isNumber) && !value.isEmpty ? plural(Int(value) ?? 0, "day") : value
        }),
        "withdrawn": AuditDetail(label: "Withdrawn", say: { $0 == "true" ? "at once, to stay within the limit" : $0 }),
        // A customer of the customer site: their address, their account id, and what a board was called for them.
        "email": AuditDetail(label: "E-mail"),
        "customer": AuditDetail(label: "Customer", code: true),
        "label": AuditDetail(label: "Called", sentence: true),
    ]

    /// Requests from scripts/firmware/ota.sh without a token, and from the test bench, carry this request id.
    static let scriptedRequest = "bench-"
    public static let scriptedTag = "Script, no sign-in"
    public static let scriptedNote = "Sent by a script (the test bench, or scripts/firmware/ota.sh without an API token) with AWS credentials, directly to the API function. Nobody signed in. The name is the one the script gave, which has to be an active release manager, so the entry does not show that this person did it."

    /// One line of the activity log: what was done, to what, and how it ended if not well (core.js,
    /// `describeAudit`). `verb` comes before the label and `tail` after it. A deployment is called by its
    /// version; its id goes to `facts`, the details of the entry in words.
    public static func describeAudit(_ entry: AuditEntry) -> AuditWords {
        let action = auditActions[entry.action]
        let ok = entry.outcome == "ok"
        let deployment = DeploymentId.isValid(entry.target) ? entry.target : nil
        let details = Dictionary(entry.detail.map { ($0.key, $0.value) }, uniquingKeysWith: { first, _ in first })
        var label = deployment.map { DeploymentId.version(of: $0) ?? $0 } ?? entry.target
        // A customer is told by their address, where the entry has it, not by the id of their account.
        let customerEmail = entry.action.hasPrefix("customer.") ? details["email"] ?? "" : ""
        let byAddress = !customerEmail.isEmpty && !customerBoard.contains(entry.action)
        if byAddress { label = customerEmail }
        // A revocation that completed what an earlier request had begun.
        let resumed = entry.action == "firmware.revoke" && ok && details["resumed"] == "true"
        var words = entry.action.isEmpty ? "did something" : entry.action
        if resumed {
            words = "finished revoking firmware"
        } else if entry.action == "account.sign_in", ok, let action {
            words = signedInOn[details["client"] ?? ""] ?? action.done
        } else if entry.action == "serial.command", ok, let action {
            words = serialWords[details["command"] ?? ""] ?? action.done
        } else if let action, ok {
            words = label.isEmpty ? action.doneAlone ?? action.done : action.done
        } else if let action {
            words = label.isEmpty ? action.triedAlone : action.tried
        }

        var verb = words
        var tail = ""
        if let slot = words.range(of: "{}") {
            if !label.isEmpty {
                verb = String(words[..<slot.lowerBound]).trimmingCharacters(in: .whitespaces)
                tail = String(words[slot.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else {
                verb = words.replacingOccurrences(of: "{}", with: "a board")
            }
        }
        if label.isEmpty, verb.hasSuffix(" of") { verb = String(verb.dropLast(3)) }
        // "gave CRVIHAAN01 to <the customer's address>": the board, then whose it is now.
        if customerBoard.contains(entry.action), !customerEmail.isEmpty, tail.hasSuffix("a customer") {
            tail = String(tail.dropLast("a customer".count)) + customerEmail
        }

        // The boards of a deployment: by name where the entry has them, else how many.
        let boards = entry.action == "deployment.create"
            ? (details["boards"] ?? "").split(separator: " ").map(String.init).filter(BoardName.isThing) : []
        let things = details["things"] ?? ""
        let counted = entry.action == "deployment.create" && things.range(of: "^[1-9][0-9]{0,3}$", options: .regularExpression) != nil
            ? Int(things) ?? 0 : 0
        let boardCount = max(counted, boards.count)

        // What the sentence says already is not said again as a fact.
        var said: Set<String> = []
        if entry.action == "account.sign_in" { said.insert("client") }
        if !customerEmail.isEmpty && (byAddress || !label.isEmpty) { said.insert("email") }
        if entry.action == "deployment.create" && boardCount > 0 { said.insert("things") }
        if boards.count <= 2 { said.insert("boards") }
        var keys: [String] = []
        for key in auditDetailOrder + entry.detail.map(\.key) where !keys.contains(key) { keys.append(key) }
        var facts: [AuditWords.Fact] = []
        for key in keys {
            guard let value = details[key], !said.contains(key) else { continue }
            if key == "version" && value == label { continue }
            if key == "resumed" && resumed { continue }
            if key == "filename" && value == label { continue }
            guard let known = auditDetails[key] else {
                facts.append(AuditWords.Fact(key: key, label: key, value: value, code: false, phrase: false, words: nil))
                continue
            }
            var factLabel = known.label
            if key == "cancelled" && entry.action == "firmware.revoke" { factLabel = "Deployments cancelled" }
            if key == "code" && entry.outcome == "error" { factLabel = "Failed with" }
            // The firmware a board ran when a command was given at its serial console.
            if key == "version" && entry.action == "serial.command" { factLabel = "Running" }
            facts.append(AuditWords.Fact(key: key, label: factLabel, value: known.say?(value) ?? value, code: known.code,
                                         phrase: !known.sentence, words: key == "code" ? refusalWords[value] : nil))
        }
        if let deployment {
            facts.append(AuditWords.Fact(key: "target", label: "Deployment", value: deployment, code: true, phrase: true, words: nil))
        }
        let link: AuditWords.Link?
        if let deployment { link = .deployment(deployment) }
        else if Lenient.isVersion(entry.target) { link = .firmware }
        else { link = nil }
        return AuditWords(
            icon: action?.icon ?? "list",
            verb: verb,
            label: label,
            tail: tail,
            outcome: ok ? nil : auditOutcomes[entry.outcome] ?? Look(.idle, "minus", entry.outcome.isEmpty ? "Unknown" : entry.outcome),
            link: link,
            facts: facts,
            scripted: entry.requestId.hasPrefix(scriptedRequest),
            boards: boards,
            boardCount: boardCount,
            byName: entry.action == "serial.command" && label.range(of: "^[A-Za-z0-9]{1,32}$", options: .regularExpression) != nil)
    }

    /// Where a deployment went, in words, each board by what it is called in `devices`: "to
    /// CRVIHAAN01", "to CRVIHAAN01 and cranium-0123…", "to 3 boards"; "" when the entry does not say.
    public static func auditBoards(_ words: AuditWords, devices: [Device] = []) -> String {
        if !words.boards.isEmpty && words.boards.count <= 2 {
            return "to " + words.boards.map { thing in devices.first { $0.thing == thing }?.name ?? thing }.joined(separator: " and ")
        }
        return words.boardCount > 0 ? "to \(plural(words.boardCount, "board"))" : ""
    }

    /// The words after the person's name: "deployed 1.11.4+0 to CRVIHAAN01".
    public static func auditWhat(_ words: AuditWords, devices: [Device] = []) -> String {
        [words.verb, words.label, words.tail, auditBoards(words, devices: devices)].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// A whole line of the activity log in words, for where it is plain text (core.js, `auditSentence`):
    /// "a@b deployed 1.12.0+0 to CRVIHAAN01".
    public static func auditSentence(_ entry: AuditEntry, devices: [Device] = []) -> String {
        [nameOf(entry.actor), auditWhat(describeAudit(entry), devices: devices)].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// The same for VoiceOver and the Console lane, with how it ended when not well: "… (refused)".
    public static func auditSpoken(_ entry: AuditEntry, devices: [Device] = []) -> String {
        let what = auditSentence(entry, devices: devices)
        return describeAudit(entry).outcome.map { "\(what) (\($0.label.lowercased()))" } ?? what
    }

    /// A sign-in was asked for by no request: its request id is made of the sign-in itself, and not shown.
    public static func showsRequestId(_ entry: AuditEntry) -> Bool {
        !entry.requestId.isEmpty && entry.action != "account.sign_in"
    }
}
