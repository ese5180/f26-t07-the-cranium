import Foundation

// The Events and Diagnostics pages' words and data, from cloud/web/src/site/assets/telemetry.js:
// what every board did over time, and how each board is doing now.

public enum Telemetry {
    // MARK: Kinds of event

    /// The look of each kind of event: a family hue (a: the update path, b: people, c: the board's
    /// health, quiet: connections) and a shape. In the order of the legend. `setting` and `log` are
    /// kinds of the board log's lines only.
    public struct Kind: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        /// circle, square, diamond, down, up, ring, plus, dot, bar
        public let shape: String
        /// a, b, c or quiet
        public let hue: String
    }

    public static let kinds: [Kind] = [
        Kind(id: "update", label: "Update", shape: "circle", hue: "a"),
        Kind(id: "firmware", label: "Firmware", shape: "square", hue: "a"),
        Kind(id: "restart", label: "Restart", shape: "diamond", hue: "c"),
        Kind(id: "health", label: "Wi-Fi and memory", shape: "down", hue: "c"),
        Kind(id: "bluetooth", label: "Bluetooth", shape: "up", hue: "b"),
        Kind(id: "console", label: "Console", shape: "ring", hue: "b"),
        // Lines of the board log only: a setting changed at a board's serial console, and the rest.
        Kind(id: "setting", label: "Settings", shape: "plus", hue: "b"),
        Kind(id: "log", label: "Other lines", shape: "dot", hue: "quiet"),
        Kind(id: "connection", label: "Connection", shape: "bar", hue: "quiet"),
    ]

    public static func kind(_ id: String) -> Kind {
        kinds.first { $0.id == id } ?? kinds[0]
    }

    // MARK: Ranges

    public struct Preset: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let seconds: TimeInterval
        public let name: String
    }

    public static let presets: [Preset] = [
        Preset(id: "1h", label: "1 h", seconds: 3600, name: "the last hour"),
        Preset(id: "24h", label: "24 h", seconds: 86_400, name: "the last 24 hours"),
        Preset(id: "7d", label: "7 d", seconds: 7 * 86_400, name: "the last 7 days"),
        Preset(id: "30d", label: "30 d", seconds: 30 * 86_400, name: "the last 30 days"),
    ]
    /// The longest range the API takes.
    public static let longestRange: TimeInterval = 31 * 86_400
    public static let eventsRefresh: TimeInterval = 15
    public static let diagnosticsRefresh: TimeInterval = 10
    public static let samplesRefresh: TimeInterval = 60

    /// A range of the Events page: a preset that ends now and moves with it, or two fixed times.
    public enum Range: Equatable, Sendable {
        case preset(String)
        case fixed(from: Date, to: Date)
    }

    /// The span a range stands for now.
    public static func span(_ range: Range, now: Date) -> (from: Date, to: Date, live: Bool, preset: Preset?) {
        switch range {
        case .preset(let id):
            let preset = presets.first { $0.id == id } ?? presets[1]
            return (now.addingTimeInterval(-preset.seconds), now, true, preset)
        case .fixed(let from, let to):
            return (from, to, false, nil)
        }
    }

    /// The words for a range, for the line above the chart.
    public static func rangeWords(_ range: Range, now: Date) -> String {
        let span = span(range, now: now)
        if let preset = span.preset { return "\(preset.name), up to now" }
        return "\(Words.dateAndTime(ConsoleTime.text(span.from))) to \(Words.dateAndTime(ConsoleTime.text(span.to)))"
    }

    /// A range the person typed, checked the way the API checks it: `from` before `to`, at most 31
    /// days apart, and not in the future. Returns the problem in words when it is not one.
    public static func customRange(from: Date, to: Date, now: Date) -> Result<Range, RangeProblem> {
        let end = min(to, now)
        guard from < end else { return .failure(RangeProblem("The start must be before the end, and before now.")) }
        guard end.timeIntervalSince(from) <= longestRange else {
            return .failure(RangeProblem("A range of events may be at most 31 days long."))
        }
        return .success(.fixed(from: from, to: end))
    }

    public struct RangeProblem: Error, Equatable, Sendable {
        public let message: String
        init(_ message: String) { self.message = message }
    }

    // MARK: Lanes and markers

    /// An event on the timeline: a board's, or an entry of the activity log on the Console lane.
    public struct Marker: Equatable, Sendable, Identifiable {
        public let id: String
        /// The board, or nil for the Console lane.
        public let thing: String?
        public let at: Date
        public let kind: String
        public let what: String
        public let warn: Bool
        public let text: String
        /// The deployment it is about, if any.
        public let job: String?
        /// For a console entry: where it leads.
        public let link: AuditWords.Link?
    }

    public static func marker(_ event: BoardEvent) -> Marker? {
        guard let at = event.date else { return nil }
        return Marker(id: event.id, thing: event.thing, at: at, kind: event.kind, what: event.what,
                      warn: event.level == "warn", text: event.text, job: event.job, link: nil)
    }

    /// An entry of the activity log as an event of the Console lane.
    public static func consoleMarker(_ entry: AuditEntry) -> Marker? {
        guard let at = ConsoleTime.date(entry.at) else { return nil }
        let words = Words.describeAudit(entry)
        return Marker(id: "console-\(entry.at ?? "")-\(entry.requestId)", thing: nil, at: at, kind: "console",
                      what: entry.action, warn: entry.outcome != "ok", text: Words.auditSpoken(entry), job: nil,
                      link: words.link)
    }

    public struct Lane: Equatable, Sendable, Identifiable {
        /// The board, or "console".
        public let id: String
        public let label: String
        public let device: Device?
        public let markers: [Marker]
        /// The board's own log in the range, as ticks at the foot of its lane: where it was talking,
        /// without a marker for each. Not read out; the Board log lists every one.
        public var lines: [BoardLine] = []
    }

    /// One lane per board, in the order of their names, and the Console lane last. Every board of
    /// the group has one, also without events; a board that has events or lines and is no longer in
    /// the list keeps its lane for them.
    public static func lanes(events: [Marker], devices: [Device], thing: String = "", console: [Marker]?,
                             lines: [BoardLine] = []) -> [Lane] {
        let names = thing.isEmpty
            ? Array(Set(devices.map(\.thing) + events.compactMap(\.thing) + lines.map(\.thing))).filter(BoardName.isThing).sorted()
            : [thing]
        var lanes = names.map { name in
            Lane(id: name, label: name, device: devices.first { $0.thing == name },
                 markers: events.filter { $0.thing == name }, lines: lines.filter { $0.thing == name })
        }
        if let console { lanes.append(Lane(id: "console", label: "Console", device: nil, markers: console)) }
        return lanes
    }

    /// Events newest first, the kinds that are switched off left out.
    public static func shown(_ lanes: [Lane], hidden: Set<String>) -> [Marker] {
        lanes.flatMap(\.markers).filter { !hidden.contains($0.kind) }.sorted { a, b in
            a.at != b.at ? a.at > b.at : a.id > b.id
        }
    }

    /// When a board was online within the range, from its connected and disconnected events. With
    /// none in the range, a range that ends now goes by the board's heartbeat. `inferred` marks a
    /// band that the heartbeat says and no connection event does.
    public struct Band: Equatable, Sendable {
        public let from: Date
        public let to: Date
        public let inferred: Bool
    }

    static let onlineWindow: TimeInterval = 90

    public static func onlineBands(_ markers: [Marker], from: Date, to: Date, device: Device?, live: Bool) -> [Band] {
        let changes = markers.filter { $0.kind == "connection" }
            .map { (at: $0.at, up: $0.what == "connected") }
            .sorted { $0.at < $1.at }
        let heard = live ? ConsoleTime.date(device?.lastSeen) : nil
        var bands: [Band] = []
        var up = changes.first.map { !$0.up } ?? (live && device?.online == true)
        var since = from
        for change in changes {
            if change.up && !up {
                up = true
                since = change.at
            } else if !change.up && up {
                bands.append(Band(from: since, to: change.at, inferred: false))
                up = false
            }
        }
        if up {
            var end = to
            if live, let device, !device.online, let heard { end = min(to, heard.addingTimeInterval(onlineWindow)) }
            bands.append(Band(from: since, to: end, inferred: false))
        } else if live, device?.online == true, let last = changes.last {
            bands.append(Band(from: last.at, to: to, inferred: true))
        }
        return bands
            .map { Band(from: min(max($0.from, from), to), to: min(max($0.to, from), to), inferred: $0.inferred) }
            .filter { $0.to > $0.from }
    }

    // MARK: Words for what a board reports

    static let causeWords: [String: String] = [
        "pin": "the reset pin", "software": "a software restart", "brownout": "a brownout", "power_on": "a loss of power",
        "watchdog": "the watchdog", "debugger": "the debugger", "security": "a security reset", "wake": "a wake from off",
        "lockup": "a CPU lockup", "parity": "a parity error", "pll": "a clock fault", "clock": "a clock fault",
        "hardware": "a hardware reset", "user": "a user reset", "temperature": "a temperature reset",
        "unknown": "an unknown cause",
    ]
    static let badCauses: Set<String> = ["brownout", "watchdog", "lockup", "security", "parity", "pll", "clock",
                                         "hardware", "temperature"]
    static let stageWords: [Int: String] = [
        0: "Did not start its program", 1: "Started its program", 2: "Started its update manager",
        3: "Got onto the network", 4: "Reached the cloud",
    ]
    static let stuckReasons: [String: String] = [
        "wifi_silent": "the Wi-Fi chip stopped answering",
        "no_cloud": "no connection to the cloud for 15 minutes",
        "update_stall": "an update stopped moving",
    ]
    public static let bluetoothResults: [String: String] = [
        "pending": "Waiting to be proved", "succeeded": "Succeeded", "rolled_back": "Rolled back",
        "not_installed": "Not installed", "trial_lost": "Lost its trial", "superseded": "Replaced by a cloud update",
        "flash_error": "Could not be written to flash",
    ]
    public static let proofWords: [String: String] = [
        "person": "Kept by a person at the board", "cloud": "Proved by the cloud", "none": "Not proved",
    ]
    public static let badBluetoothResults: Set<String> = ["rolled_back", "not_installed", "trial_lost", "flash_error"]

    /// Why a boot ended, in words: "the watchdog", "a brownout and a CPU lockup".
    public static func causeWords(_ causes: [String]) -> String {
        var seen: [String] = []
        for cause in causes {
            let words = causeWords[cause] ?? causeWords["unknown"]!
            if !seen.contains(words) { seen.append(words) }
        }
        return seen.isEmpty ? causeWords["unknown"]! : seen.joined(separator: " and ")
    }

    public static func stageWords(_ stage: Int) -> String {
        stageWords[stage] ?? "Stage \(stage)"
    }

    public struct BootRow: Equatable, Sendable, Identifiable {
        public let boot: Int
        public let version: String
        public let running: Bool
        public let reached: String
        public let before: String
        public let bad: Bool
        public var id: Int { boot }
    }

    /// The boot diary as rows, newest first: each boot, why the one before it ended, and how far each got.
    public static func diaryRows(_ diary: Device.Diary?) -> [BootRow] {
        guard let diary else { return [] }
        return diary.entries.enumerated().map { index, entry in
            BootRow(boot: diary.boots - index, version: entry.version, running: index == 0,
                    reached: stageWords(entry.stage), before: causeWords(entry.causes),
                    bad: entry.causes.contains { badCauses.contains($0) })
        }
    }

    public struct StuckWords: Equatable, Sendable {
        public let tone: Tone
        public let badge: String?
        public let text: String
    }

    public static func stuckWords(_ stuck: Device.Stuck?) -> StuckWords? {
        guard let stuck else { return nil }
        if stuck.count == 0 { return StuckWords(tone: .good, badge: nil, text: "Has not had to restart itself for being stuck") }
        let why = stuckReasons[stuck.reason] ?? "reason \(stuck.reason)"
        if stuck.count == 1 {
            return StuckWords(tone: .warn, badge: "Once", text: "Restarted itself once for being stuck, because \(why)")
        }
        return StuckWords(tone: .warn, badge: "\(stuck.count) in a row",
                          text: "Restarted itself \(stuck.count) times in a row for being stuck; the last time because \(why)")
    }

    /// Below this share of the heap free, memory is short (the recorder warns at the same line).
    public static let lowHeapShare = 0.15
    static let tightHeapShare = 0.3

    public struct HeapWords: Equatable, Sendable {
        public let tone: Tone
        /// It ran low earlier in this boot.
        public let ranLow: Bool
        public let used: Int
        public let leastUsed: Int
        public let text: String
        public let least: String
    }

    public static func heapWords(_ heap: Device.Heap?) -> HeapWords? {
        guard let heap, heap.size > 0 else { return nil }
        let share = Double(heap.free) / Double(heap.size)
        let leastShare = Double(heap.least) / Double(heap.size)
        var tone = Tone.live
        if share < lowHeapShare { tone = .bad }
        else if share < tightHeapShare { tone = .warn }
        return HeapWords(tone: tone, ranLow: leastShare < lowHeapShare, used: Int(((1 - share) * 100).rounded()),
                         leastUsed: Int(((1 - leastShare) * 100).rounded()),
                         text: "\(Words.fileSize(heap.free)) free of \(Words.fileSize(heap.size))",
                         least: "At least \(Words.fileSize(heap.least)) has stayed free since it started (\(Int((leastShare * 100).rounded()))%)")
    }

    static func atLeast(_ version: String?, _ major: UInt8, _ minor: UInt8, _ revision: UInt16) -> Bool {
        guard let parsed = version.flatMap(FirmwareVersion.init(release:)) else { return false }
        return (parsed.major, parsed.minor, parsed.revision) >= (major, minor, revision)
    }

    /// Why a board shows no diagnostics report: plainly, by its firmware.
    public static func diagMissing(_ device: Device) -> String {
        guard let version = device.fw?.version else {
            return "Needs firmware 1.10.0 or later. This board has not said what it runs."
        }
        if !atLeast(version, 1, 10, 0) { return "Needs firmware 1.10.0 or later. This board runs \(version)." }
        return "No diagnostics report yet. A board on 1.10.0 or later sends one when it connects and every 5 minutes."
    }

    public static func diaryMissing(_ device: Device) -> String {
        if let version = device.fw?.version, !atLeast(version, 1, 7, 4) {
            return "Needs firmware 1.7.4 or later. This board runs \(version)."
        }
        return "No boot diary yet. A board on 1.7.4 or later sends it when it connects."
    }

    /// "12 s ago" to the second for the first two minutes, then as the rest of the console says it.
    public static func heartbeatAge(_ lastSeen: String?, now: Date) -> String {
        guard let then = ConsoleTime.date(lastSeen) else { return "" }
        let seconds = Int(now.timeIntervalSince(then).rounded(.down))
        if seconds < 120 { return "\(max(0, seconds)) s ago" }
        return Words.timeAgo(lastSeen, now: now)
    }

    /// The uptime now, counted on from the last heartbeat while the board is online.
    public static func uptimeNow(_ device: Device, now: Date) -> Int? {
        guard let uptime = device.uptime else { return nil }
        guard device.online, let seen = ConsoleTime.date(device.lastSeen) else { return uptime }
        return uptime + max(0, Int(now.timeIntervalSince(seen)))
    }

    // MARK: Readings

    public struct Point: Equatable, Sendable {
        public let at: Date
        public let value: Double
    }

    /// The readings of one field as points, oldest first; readings without it are left out.
    public static func points(_ samples: [Samples.Sample], _ field: KeyPath<Samples.Sample, Int?>) -> [Point] {
        samples.compactMap { sample in
            guard let value = sample[keyPath: field], let at = ConsoleTime.date(sample.at) else { return nil }
            return Point(at: at, value: Double(value))
        }
    }

    /// The longest gap between readings that still counts as reporting, for points `bucketSeconds` apart.
    public static func gap(bucketSeconds: Int) -> TimeInterval {
        max(150, 2.5 * Double(bucketSeconds))
    }

    /// A series as runs of points that belong together: a gap longer than `gap` breaks the line.
    public static func runs(_ points: [Point], gap: TimeInterval) -> [[Point]] {
        var runs: [[Point]] = []
        var run: [Point] = []
        for point in points {
            if let last = run.last, point.at.timeIntervalSince(last.at) > gap {
                runs.append(run)
                run = []
            }
            run.append(point)
        }
        if !run.isEmpty { runs.append(run) }
        return runs
    }
}
