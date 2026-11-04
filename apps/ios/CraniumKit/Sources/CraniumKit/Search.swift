import Foundation

// Search across what the app has loaded: boards, releases, deployments, events, the activity log,
// the app's own screens and actions, and the Help topics. Matching is case- and
// diacritic-insensitive, on the start of words and, less highly, anywhere inside them.

/// Where a result leads.
public enum SearchTarget: Hashable, Sendable {
    case board(String)
    case release(String)
    case deployment(String)
    /// An event: its board.
    case event(thing: String)
    /// An entry of the activity log: what it is about, if that has a page, else the log.
    case activity(AuditWords.Link?)
    /// One of the app's screens or actions, by its id in `SearchCatalog.screens`.
    case screen(String)
    case help(String)
}

/// Something that can be found.
public struct SearchItem: Sendable, Identifiable, Equatable {
    public enum Kind: String, Sendable, CaseIterable {
        case screen, board, release, deployment, event, activity, help

        /// The heading of a group of results.
        public var heading: String {
            switch self {
            case .screen: return "Screens and actions"
            case .board: return "Boards"
            case .release: return "Releases"
            case .deployment: return "Deployments"
            case .event: return "Events"
            case .activity: return "Activity"
            case .help: return "Help"
            }
        }
    }

    public let kind: Kind
    /// Unique within its kind.
    public let key: String
    public let title: String
    public let subtitle: String
    /// More text that matches, not shown.
    public let keywords: [String]
    public let target: SearchTarget

    public var id: String { "\(kind.rawValue):\(key)" }

    public init(kind: Kind, key: String, title: String, subtitle: String = "", keywords: [String] = [], target: SearchTarget) {
        self.kind = kind
        self.key = key
        self.title = title
        self.subtitle = subtitle
        self.keywords = keywords
        self.target = target
    }
}

/// A match, with where it matched in the title and the subtitle, as character offsets of the
/// text as it is shown, to highlight.
public struct SearchHit: Sendable, Identifiable, Equatable {
    public let item: SearchItem
    public let score: Double
    public let titleRanges: [Range<Int>]
    public let subtitleRanges: [Range<Int>]
    public var id: String { item.id }
}

public enum Search {
    /// Text folded for matching, character by character, with where each folded character came from.
    struct Folded {
        let chars: [Character]
        let origin: [Int]

        init(_ text: String) {
            var chars: [Character] = []
            var origin: [Int] = []
            for (index, character) in text.enumerated() {
                for folded in String(character).folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                                                        locale: Locale(identifier: "en_US_POSIX")) {
                    chars.append(folded)
                    origin.append(index)
                }
            }
            self.chars = chars
            self.origin = origin
        }

        /// Where `token` occurs: at the start of a word (a whole word preferred), or anywhere.
        func find(_ token: [Character]) -> (wordStart: Int?, whole: Bool, anywhere: Int?) {
            guard !token.isEmpty, token.count <= chars.count else { return (nil, false, nil) }
            var anywhere: Int?
            var prefix: Int?
            for start in 0...(chars.count - token.count) where Array(chars[start..<(start + token.count)]) == token {
                if anywhere == nil { anywhere = start }
                guard start == 0 || !Search.isWordCharacter(chars[start - 1]) || !Search.isWordCharacter(token[0]) else { continue }
                let end = start + token.count
                if end == chars.count || !Search.isWordCharacter(chars[end]) || !Search.isWordCharacter(token[token.count - 1]) {
                    return (start, true, anywhere)
                }
                if prefix == nil { prefix = start }
            }
            return (prefix, false, anywhere)
        }

        /// The original characters a folded range came from.
        func originalRange(_ start: Int, _ length: Int) -> Range<Int> {
            let first = origin[start]
            let last = origin[start + length - 1]
            return first..<(last + 1)
        }
    }

    static func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber
    }

    /// The words of a query, folded: split on white space; punctuation inside a word stays, so that
    /// "1.11" finds the version 1.11.4+0.
    public static func tokens(_ query: String) -> [String] {
        query.split(whereSeparator: { $0.isWhitespace }).map { String(Folded(String($0)).chars) }.filter { !$0.isEmpty }
    }

    /// The items that match every word of the query, best first.
    public static func rank(_ query: String, in items: [SearchItem]) -> [SearchHit] {
        let words = tokens(query)
        guard !words.isEmpty else { return [] }
        let whole = Array(Folded(query.trimmingCharacters(in: .whitespacesAndNewlines)).chars)
        var hits: [SearchHit] = []
        for item in items {
            let title = Folded(item.title)
            let subtitle = Folded(item.subtitle)
            let keywords = item.keywords.map(Folded.init)
            var score = 0.0
            var titleRanges: [Range<Int>] = []
            var subtitleRanges: [Range<Int>] = []
            var matched = true
            for word in words {
                let token = Array(word)
                let inTitle = title.find(token)
                let inSubtitle = subtitle.find(token)
                if let at = inTitle.wordStart {
                    score += (at == 0 ? 70 : 50) + (inTitle.whole ? 15 : 0)
                    titleRanges.append(title.originalRange(at, token.count))
                } else if let at = inTitle.anywhere {
                    score += 25
                    titleRanges.append(title.originalRange(at, token.count))
                } else if let at = inSubtitle.wordStart {
                    score += 18
                    subtitleRanges.append(subtitle.originalRange(at, token.count))
                } else if keywords.contains(where: { $0.find(token).wordStart != nil }) {
                    score += 15
                } else if let at = inSubtitle.anywhere {
                    score += 6
                    subtitleRanges.append(subtitle.originalRange(at, token.count))
                } else if keywords.contains(where: { $0.find(token).anywhere != nil }) {
                    score += 4
                } else {
                    matched = false
                    break
                }
            }
            guard matched else { continue }
            if title.chars == whole { score += 200 }
            else if title.chars.starts(with: whole) { score += 60 }
            // Among equals, the shorter title is the closer match.
            score -= Double(title.chars.count) * 0.05
            hits.append(SearchHit(item: item, score: score, titleRanges: merged(titleRanges), subtitleRanges: merged(subtitleRanges)))
        }
        return hits.sorted { a, b in
            a.score != b.score ? a.score > b.score : a.item.title.localizedStandardCompare(b.item.title) == .orderedAscending
        }
    }

    /// The hits by kind, in a fixed order, at most `limit` of each.
    public static func grouped(_ hits: [SearchHit], limit: Int = 8) -> [(kind: SearchItem.Kind, hits: [SearchHit])] {
        SearchItem.Kind.allCases.compactMap { kind in
            let some = hits.filter { $0.item.kind == kind }
            return some.isEmpty ? nil : (kind, Array(some.prefix(limit)))
        }
        .sorted { ($0.hits.first?.score ?? 0) > ($1.hits.first?.score ?? 0) }
    }

    static func merged(_ ranges: [Range<Int>]) -> [Range<Int>] {
        var out: [Range<Int>] = []
        for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = out.last, range.lowerBound <= last.upperBound {
                out[out.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                out.append(range)
            }
        }
        return out
    }

    // MARK: What can be found

    public static func items(boards: [Device]) -> [SearchItem] {
        boards.map { device in
            let state = Words.isRestarting(device) ? "Restarting" : device.online ? "Online" : device.lastSeen == nil ? "Never connected" : "Offline"
            let firmware = device.fw.map { "\($0.version)\($0.confirmed ? "" : " on trial")" } ?? "Firmware not reported"
            return SearchItem(kind: .board, key: device.thing, title: device.label,
                              subtitle: [device.name == nil ? nil : device.thing, state, firmware].compactMap { $0 }.joined(separator: " · "),
                              keywords: [device.thing, Words.describeUpdate(device).title], target: .board(device.thing))
        }
    }

    public static func items(releases: [FirmwareRelease]) -> [SearchItem] {
        releases.map { release in
            SearchItem(kind: .release, key: release.version, title: release.version,
                       subtitle: [release.isActive ? "Active" : "Revoked", release.notes].compactMap { $0 }.joined(separator: " · "),
                       keywords: [release.revoked?.reason ?? "", release.filename ?? "", Words.nameOf(release.uploadedBy)],
                       target: .release(release.version))
        }
    }

    public static func items(deployments: [Deployment], devices: [Device]) -> [SearchItem] {
        deployments.map { deployment in
            let names = deployment.things.map { thing in devices.first { $0.thing == thing }?.label ?? thing }
            let look = Words.describeDeployment(deployment, devices: devices)
            return SearchItem(kind: .deployment, key: deployment.id, title: "Deployment of \(deployment.version ?? "unknown version")",
                              subtitle: "\(look.label) · \(names.joined(separator: ", "))",
                              keywords: [deployment.id, deployment.note, Words.nameOf(deployment.createdBy)] + deployment.things,
                              target: .deployment(deployment.id))
        }
    }

    public static func items(events: [BoardEvent], devices: [Device]) -> [SearchItem] {
        events.map { event in
            let board = devices.first { $0.thing == event.thing }?.label ?? event.thing
            return SearchItem(kind: .event, key: event.id, title: event.text,
                              subtitle: "\(board) · \(Telemetry.kind(event.kind).label) · \(Words.dateAndTime(event.at))",
                              keywords: [event.thing, event.what], target: .event(thing: event.thing))
        }
    }

    public static func items(activity: [AuditEntry]) -> [SearchItem] {
        activity.map { entry in
            let words = Words.describeAudit(entry)
            // Straight to what it is about: the deployment, or the release; else the log.
            let target: SearchTarget
            switch words.link {
            case .deployment(let id): target = .deployment(id)
            case .firmware where Lenient.isVersion(entry.target): target = .release(entry.target)
            default: target = .activity(nil)
            }
            return SearchItem(kind: .activity, key: entry.id, title: Words.auditSentence(entry),
                              subtitle: Words.dateAndTime(entry.at),
                              keywords: [entry.action, entry.target, entry.actor?.sub ?? ""] + words.facts.map(\.value),
                              target: target)
        }
    }

    public static func items(help: HelpBook) -> [SearchItem] {
        help.topics.map { topic in
            SearchItem(kind: .help, key: topic.id, title: topic.title, subtitle: topic.summary,
                       keywords: topic.keywords + [topic.plainText], target: .help(topic.id))
        }
    }
}

/// The app's own screens and actions, so that "API tokens" or "sign out" can be searched for.
public enum SearchCatalog {
    public struct Screen: Sendable {
        public let id: String
        public let title: String
        public let subtitle: String
        public let keywords: [String]
        /// Only for a release manager.
        public let changes: Bool
    }

    public static let screens: [Screen] = [
        Screen(id: "overview", title: "Overview", subtitle: "Updates in progress, boards online, the newest release",
               keywords: ["home", "summary", "fleet"], changes: false),
        Screen(id: "boards", title: "Boards", subtitle: "Every board, as it last reported",
               keywords: ["devices", "diagnostics", "online"], changes: false),
        Screen(id: "firmware", title: "Firmware", subtitle: "Every release on AWS", keywords: ["releases", "images"], changes: false),
        Screen(id: "events", title: "Events", subtitle: "What every board did", keywords: ["timeline", "log", "history"], changes: false),
        Screen(id: "deployments", title: "Deployments", subtitle: "Releases offered to boards over the internet",
               keywords: ["updates", "ota", "jobs"], changes: false),
        Screen(id: "activity", title: "Activity", subtitle: "Who changed what, and when", keywords: ["audit", "log"], changes: false),
        Screen(id: "tokens", title: "API tokens", subtitle: "Tokens for scripts that use the console as you",
               keywords: ["token", "script", "ota.sh", "key"], changes: false),
        Screen(id: "history", title: "History", subtitle: "The project's commits", keywords: ["commits", "git", "changes"], changes: false),
        Screen(id: "serial", title: "Serial console", subtitle: "Not on an iPhone: on a computer", keywords: ["usb", "cable", "terminal"], changes: false),
        Screen(id: "account", title: "Account", subtitle: "Who is signed in, and the firmware kept on this phone",
               keywords: ["profile", "role", "email"], changes: false),
        Screen(id: "help", title: "Help", subtitle: "How updates work, the LEDs, troubleshooting", keywords: ["guide", "faq"], changes: false),
        Screen(id: "deploy", title: "Deploy a release", subtitle: "Offer a release to boards over the internet",
               keywords: ["new deployment", "update", "ota", "wifi"], changes: true),
        Screen(id: "upload", title: "Upload firmware", subtitle: "Register a signed image",
               keywords: ["new release", "signed.bin", "image"], changes: true),
        Screen(id: "bluetooth", title: "Update over Bluetooth", subtitle: "Send a release to a board in the room",
               keywords: ["ble", "passkey", "phone"], changes: false),
        Screen(id: "signout", title: "Sign out", subtitle: "Forget the sign-in and the firmware on this phone",
               keywords: ["log out", "logout"], changes: false),
    ]

    public static func items(canWrite: Bool) -> [SearchItem] {
        screens.filter { canWrite || !$0.changes }.map {
            SearchItem(kind: .screen, key: $0.id, title: $0.title, subtitle: $0.subtitle, keywords: $0.keywords, target: .screen($0.id))
        }
    }
}

/// The last searches, kept on the phone: at most 10, newest first, cleared at sign-out.
public struct RecentSearches: @unchecked Sendable {
    public static let limit = 10
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "cranium.recentSearches") {
        self.defaults = defaults
        self.key = key
    }

    public var all: [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    /// Keeps `query` first. The same search, in other case or spacing, is kept once.
    @discardableResult
    public func add(_ query: String) -> [String] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return all }
        let folded = Search.tokens(trimmed)
        let kept = [trimmed] + all.filter { Search.tokens($0) != folded }
        let list = Array(kept.prefix(Self.limit))
        defaults.set(list, forKey: key)
        return list
    }

    public func remove(_ query: String) {
        defaults.set(all.filter { $0 != query }, forKey: key)
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}
