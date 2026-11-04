import Foundation

// The boards' own log, line by line, from firmware 1.12.0: what a board prints on its serial console
// (`GET /api/events/log`, cloud/api/src/lib/lines.mjs). The website shows it under Events as the
// Board log (telemetry.js, `boardLogCard`), with a tick for each line at the foot of its board's
// lane. Read as the website reads it (core.js, `readLine`).

/// One line of a board's log.
public struct BoardLine: Decodable, Equatable, Sendable, Identifiable {
    /// The kinds a line can have: the kinds of events, less connection and firmware, and two of its own.
    public static let kinds = ["bluetooth", "update", "restart", "health", "setting", "log"]
    /// The sources on the board's console the API sends (lib/lines.mjs `TAGS`). `CMD`, a board's answer
    /// to a command from the console, comes from firmware 1.13.0.
    public static let tags = ["BT", "WIFI", "STUCK", "CONSOLE", "CMD",
                              "app", "boot_diary", "bt_ota", "cloud", "factory", "health", "identity", "net", "ota", "store", "stuck", "ui"]
    /// How long a line can be: the board cuts its own at 160 characters.
    public static let textLimit = 160

    public let thing: String
    public let at: String
    /// "<boot>.<seq>": unique within its board.
    public let lineId: String
    public let kind: String
    public let tag: String
    /// info or warn: the board's own WRN or ERR, or a stuck restart.
    public let level: String
    public let text: String
    /// The boot it was printed in, and its place in that boot.
    public let boot: Int?
    public let seq: Int?
    /// Lines the board could not keep before this one (its queue was full while offline).
    public let dropped: Int?

    public var id: String { "\(thing)-\(lineId)" }
    public var date: Date? { ConsoleTime.date(at) }
    public var warn: Bool { level == "warn" }

    public init(thing: String, at: String, id: String, kind: String, tag: String, level: String = "info", text: String,
                boot: Int? = nil, seq: Int? = nil, dropped: Int? = nil) {
        self.thing = thing
        self.at = at
        lineId = id
        self.kind = kind
        self.tag = tag
        self.level = level
        self.text = text
        self.boot = boot
        self.seq = seq
        self.dropped = dropped
    }

    private enum CodingKeys: String, CodingKey { case thing, at, id, kind, tag, level, text, boot, seq, dropped }

    static let idPattern = "^(0|[1-9][0-9]{0,9})\\.([1-9][0-9]{0,9})$"
    static let most = 4_294_967_295

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let thing = c.text(.thing, limit: 64)
        let kind = c.text(.kind, limit: 24)
        let tag = c.text(.tag, limit: 24)
        let id = c.text(.id, limit: 24)
        guard BoardName.isThing(thing), let at = c.instant(.at), Self.kinds.contains(kind), Self.tags.contains(tag),
              id.range(of: Self.idPattern, options: .regularExpression) != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a line of a board's log"))
        }
        self.thing = thing
        self.at = at
        lineId = id
        self.kind = kind
        self.tag = tag
        level = c.lenient(String.self, .level) == "warn" ? "warn" : "info"
        text = c.boardText(.text, limit: Self.textLimit)
        boot = c.whole(.boot, 0, Self.most)
        seq = c.whole(.seq, 1, Self.most)
        dropped = c.whole(.dropped, 1, Self.most)
    }
}

/// A page of the board log, newest first.
public struct LinePage: Decodable, Equatable, Sendable {
    public let lines: [BoardLine]
    public let cursor: String?
    public let from: String?
    public let to: String?

    public init(lines: [BoardLine], cursor: String? = nil, from: String? = nil, to: String? = nil) {
        self.lines = lines
        self.cursor = cursor
        self.from = from
        self.to = to
    }

    private enum CodingKeys: String, CodingKey { case lines, cursor, from, to }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lines = try c.decode(LenientList<BoardLine>.self, forKey: .lines).items
        cursor = c.lenient(String.self, .cursor).flatMap(Cursor.valid)
        from = c.instant(.from)
        to = c.instant(.to)
    }
}

/// The board log's words, as the website has them.
public enum BoardLog {
    public static let title = "Board log"
    public static let hiddenNote = "Hidden. The board log is every line a board on firmware 1.12.0 or later prints on its serial console, a passkey or anything like a password never among them."
    public static let emptyTitle = "No lines in this range."
    public static let emptyFiltered = "Some sources, kinds or boards are left out: show them all, or choose a longer range."
    public static let emptyAll = "A board on firmware 1.12.0 or later sends what it prints on its serial console. Older firmware sends nothing here."
    public static let allSources = "All sources"
    public static let show = "Show the board log"
    public static let hide = "Hide the board log"
    public static let failed = "Could not load the board log."
    public static let loadMore = "Load 500 more lines"
    /// On a board's page: its newest lines, and the way to all of them.
    public static let recentTitle = "Latest lines"
    public static let allLines = "All lines"
    public static let recentEmpty = "No lines in the last 24 hours. A board on firmware 1.12.0 or later sends what it prints on its serial console."
    /// How many of a board's newest lines its page shows.
    public static let recentCount = 5

    /// The lines that are shown: those of the kinds that are switched on, newest first.
    public static func shown(_ lines: [BoardLine], hidden: Set<String>) -> [BoardLine] {
        lines.filter { !hidden.contains($0.kind) }
    }

    /// "1 line lost before this one", "3 lines lost before this one".
    public static func dropped(_ count: Int) -> String {
        "\(Words.plural(count, "line")) lost before this one"
    }

    /// "Boot 42, line 7 of that boot".
    public static func place(_ line: BoardLine) -> String? {
        guard let boot = line.boot, let seq = line.seq else { return nil }
        return "Boot \(boot), line \(seq) of that boot"
    }

    /// The count above the list: "24 lines · 2 warnings · more in this range".
    public static func count(_ lines: [BoardLine], more: Bool) -> String {
        let warnings = lines.filter(\.warn).count
        return [Words.plural(lines.count, "line"), warnings > 0 ? Words.plural(warnings, "warning") : nil,
                more ? "more in this range" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    /// The time of day to the second: lines of a log come many to a minute.
    public static func secondOfDay(_ at: String) -> String {
        guard let date = ConsoleTime.date(at) else { return "" }
        return date.formatted(.dateTime.hour().minute().second())
    }

    /// What the API is asked for: the kinds that are switched on, when not all of them, and one source.
    public static func query(hidden: Set<String>, tag: String) -> (kinds: [String]?, tags: [String]?, none: Bool) {
        let kinds = BoardLine.kinds.filter { !hidden.contains($0) }
        return (kinds.count < BoardLine.kinds.count ? kinds : nil, BoardLine.tags.contains(tag) ? [tag] : nil, kinds.isEmpty)
    }
}
