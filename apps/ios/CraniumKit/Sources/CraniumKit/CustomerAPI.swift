import Foundation

// The customer API (cloud/api/src/customer/app.mjs), as the customer site reads it
// (cloud/web/src/customer/assets/customer-core.js, `createCustomerApi`, `readBoard`, `readEvent`):
// what arrives is reduced to known shapes on the way in, with the same checks, and a board is only
// ever named by the id of its assignment, never by a thing name.

/// A customer's board, as the customer API sends it and the site keeps it.
public struct CustomerBoard: Equatable, Sendable, Identifiable {
    public struct Firmware: Equatable, Sendable {
        /// `1.11.2+0`.
        public let version: String
        /// False while the new image runs on trial.
        public let confirmed: Bool
    }

    public struct Update: Equatable, Sendable {
        /// idle, awaiting_user, downloading, verifying, rebooting, testing or bluetooth.
        public let state: String
        /// 0 to 100.
        public let progress: Int
        /// none, succeeded, failed, rolled_back, declined, refused or cancelled.
        public let last: String
    }

    /// The assignment id: 16 hex digits.
    public let id: String
    /// What the admin called it, or what the board calls itself; nil when neither.
    public let name: String?
    /// The board's own device name.
    public let boardName: String?
    /// online, updating, restarting, offline or new.
    public let status: String
    public let online: Bool
    public let lastSeen: String?
    public let firmware: Firmware?
    public let update: Update?
    /// dBm, -127 to 0.
    public let rssi: Int?
    /// Seconds.
    public let uptime: Int?
    /// When it became the customer's.
    public let since: String?

    public init(id: String, name: String?, boardName: String?, status: String, online: Bool, lastSeen: String?,
                firmware: Firmware?, update: Update?, rssi: Int?, uptime: Int?, since: String?) {
        self.id = id
        self.name = name
        self.boardName = boardName
        self.status = status
        self.online = online
        self.lastSeen = lastSeen
        self.firmware = firmware
        self.update = update
        self.rssi = rssi
        self.uptime = uptime
        self.since = since
    }
}

/// One event of a customer's board: typed fields only, never the console's own text.
public struct CustomerEvent: Equatable, Sendable {
    public let at: String
    /// The board's assignment id.
    public let board: String
    /// connection, firmware, update, restart or bluetooth.
    public let kind: String
    public let what: String
    public var version: String?
    public var from: String?
    public var to: String?
    public var confirmed: Bool?
    public var result: String?
    public var state: String?
    public var progress: Int?

    public init(at: String, board: String, kind: String, what: String, version: String? = nil, from: String? = nil,
                to: String? = nil, confirmed: Bool? = nil, result: String? = nil, state: String? = nil, progress: Int? = nil) {
        self.at = at
        self.board = board
        self.kind = kind
        self.what = what
        self.version = version
        self.from = from
        self.to = to
        self.confirmed = confirmed
        self.result = result
        self.state = state
        self.progress = progress
    }
}

/// `GET /api/c/me`.
public struct CustomerMe: Equatable, Sendable {
    public let email: String
    public let name: String
    public let boards: Int
}

/// One board and what it did in the last 30 days: `GET /api/c/boards/{id}`.
public struct CustomerBoardDetail: Equatable, Sendable {
    public let board: CustomerBoard
    public let activity: [CustomerEvent]
}

/// What the customer API answers, read with the site's checks. Nothing here throws.
public enum CustomerRead {
    static let statuses: Set<String> = ["online", "updating", "restarting", "offline", "new"]
    static let updateStates: Set<String> = ["idle", "awaiting_user", "downloading", "verifying", "rebooting", "testing", "bluetooth"]
    static let results: Set<String> = ["none", "succeeded", "failed", "rolled_back", "declined", "refused", "cancelled"]
    static let kinds: Set<String> = ["connection", "firmware", "update", "restart", "bluetooth"]

    /// /^[0-9a-f]{16}$/: an assignment id.
    public static func isBoardId(_ text: String) -> Bool {
        text.utf8.count == 16 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$/
    static func isVersion(_ text: String) -> Bool {
        let plus = text.split(separator: "+", omittingEmptySubsequences: false)
        guard plus.count == 2 else { return false }
        let dots = plus[0].split(separator: ".", omittingEmptySubsequences: false)
        guard dots.count == 3 else { return false }
        return number(dots[0], 3) && number(dots[1], 3) && number(dots[2], 5) && number(plus[1], 10)
    }

    private static func number(_ part: Substring, _ most: Int) -> Bool {
        guard (1...most).contains(part.count), part.utf8.allSatisfy({ (48...57).contains($0) }) else { return false }
        return part == "0" || part.first != "0"
    }

    /// /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
    static func isInstant(_ text: String) -> Bool {
        let shape = Array(text.utf8)
        let digit = { (c: UInt8) in (48...57).contains(c) }
        func fixed(_ pattern: String) -> Bool {
            guard shape.count == pattern.utf8.count else { return false }
            for (c, p) in zip(shape, pattern.utf8) {
                if p == UInt8(ascii: "d") ? !digit(c) : c != p { return false }
            }
            return true
        }
        return fixed("dddd-dd-ddTdd:dd:ddZ") || fixed("dddd-dd-ddTdd:dd:dd.dddZ")
    }

    /// /^[a-z][a-z_]{0,limit-1}$/
    static func isWord(_ text: String, limit: Int) -> Bool {
        guard let first = text.utf8.first, (97...122).contains(first), (1...limit).contains(text.utf8.count) else { return false }
        return text.utf8.allSatisfy { (97...122).contains($0) || $0 == 95 }
    }

    /// /^[A-Za-z0-9]{1,32}$/: a board's own device name.
    static func isDeviceName(_ text: String) -> Bool {
        (1...32).contains(text.utf8.count) && text.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
        }
    }

    /// What an admin called a board, or a name: one line of their text, cut to its printable part
    /// (printable ASCII and Latin letters up to U+024F), at most 40 characters.
    public static func label(_ value: Any?) -> String {
        guard let text = value as? String else { return "" }
        let kept = text.unicodeScalars.filter { (0x20...0x7e).contains($0.value) || (0xa0...0x24f).contains($0.value) }
        return String(String.UnicodeScalarView(kept).prefix(40))
    }

    static func instant(_ value: Any?) -> String? {
        guard let text = value as? String, isInstant(text) else { return nil }
        return text
    }

    static func version(_ value: Any?) -> String? {
        guard let text = value as? String, isVersion(text) else { return nil }
        return text
    }

    /// A whole number from least to most, or nil; a JSON true is not 1.
    static func whole(_ value: Any?, _ least: Int, _ most: Int) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double == double.rounded(), double >= Double(least), double <= Double(most) else { return nil }
        return Int(double)
    }

    static func flag(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// A board, or nil if it is not one.
    public static func board(_ raw: Any?) -> CustomerBoard? {
        guard let raw = raw as? [String: Any], let id = raw["id"] as? String, isBoardId(id),
              let status = raw["status"] as? String, statuses.contains(status) else { return nil }
        var firmware: CustomerBoard.Firmware?
        if let given = raw["firmware"] as? [String: Any], let v = version(given["version"]) {
            firmware = CustomerBoard.Firmware(version: v, confirmed: flag(given["confirmed"]) == true)
        }
        var update: CustomerBoard.Update?
        if let given = raw["update"] as? [String: Any], let state = given["state"] as? String, updateStates.contains(state) {
            let last = given["last"] as? String
            update = CustomerBoard.Update(state: state, progress: whole(given["progress"], 0, 100) ?? 0,
                                          last: last.map { results.contains($0) ? $0 : "none" } ?? "none")
        }
        let name = label(raw["name"])
        let boardName = (raw["boardName"] as? String).flatMap { isDeviceName($0) ? $0 : nil }
        return CustomerBoard(id: id, name: name.isEmpty ? nil : name, boardName: boardName, status: status,
                             online: flag(raw["online"]) == true, lastSeen: instant(raw["lastSeen"]), firmware: firmware,
                             update: update, rssi: whole(raw["rssi"], -127, 0), uptime: whole(raw["uptime"], 0, 1 << 32),
                             since: instant(raw["since"]))
    }

    /// One event, or nil if it is not one.
    public static func event(_ raw: Any?) -> CustomerEvent? {
        guard let raw = raw as? [String: Any], let at = instant(raw["at"]), let kind = raw["kind"] as? String,
              kinds.contains(kind), let what = raw["what"] as? String, isWord(what, limit: 24),
              let board = raw["board"] as? String, isBoardId(board) else { return nil }
        var event = CustomerEvent(at: at, board: board, kind: kind, what: what)
        event.version = version(raw["version"])
        event.from = version(raw["from"])
        event.to = version(raw["to"])
        event.confirmed = flag(raw["confirmed"])
        if let result = raw["result"] as? String, isWord(result, limit: 32) { event.result = result }
        if let state = raw["state"] as? String, updateStates.contains(state) { event.state = state }
        event.progress = whole(raw["progress"], 0, 100)
        return event
    }

    /// A list whose items are read one by one, the ones that are not dropped; nil if it is not a list.
    static func list<T>(_ value: Any?, _ read: (Any?) -> T?) -> [T]? {
        guard let items = value as? [Any] else { return nil }
        return items.compactMap(read)
    }

    static func me(_ body: [String: Any]) -> CustomerMe {
        CustomerMe(email: String((body["email"] as? String ?? "").prefix(320)), name: label(body["name"]),
                   boards: whole(body["boards"], 0, 10000) ?? 0)
    }
}

/// An answer of the customer API that is not what was asked for, in the site's words.
public struct CustomerAPIError: Error, Equatable, LocalizedError {
    public let status: Int
    public let code: String
    public let message: String

    public init(status: Int, code: String, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }

    static let unreadable = CustomerAPIError(status: 0, code: "unreadable", message: "The server sent a reply this page could not read.")
    static let network = CustomerAPIError(status: 0, code: "network", message: "Cranium could not be reached. Check the connection.")
    static let ended = CustomerAPIError(status: 401, code: "unauthorized", message: "Your session has ended. Sign in again.")
    static let notYours = CustomerAPIError(status: 404, code: "not_your_board", message: "There is no board of yours at this address.")

    /// `{"error": {"code", "message"}}`: the message cut to printable ASCII and 300 characters, the
    /// code only if it is a word.
    static func from(_ data: Data, status: Int) -> CustomerAPIError {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let inner = object?["error"] as? [String: Any] ?? [:]
        let message = String(String.UnicodeScalarView((inner["message"] as? String ?? "").unicodeScalars
            .filter { (0x20...0x7e).contains($0.value) }).prefix(300))
        let code = (inner["code"] as? String).flatMap { CustomerRead.isWord($0, limit: 32) ? $0 : nil } ?? "http"
        return CustomerAPIError(status: status, code: code, message: message.isEmpty ? "Something went wrong." : message)
    }
}

/// The customer API's four reads, with the customer's own access token. Never the console's API:
/// its base is the customer API's, and its tokens are the customer session's.
public final class CustomerAPI: Sendable {
    private let base: String
    private let http: HTTPClient
    private let tokens: AccessTokenProvider

    public init(config: CustomerConfig, http: HTTPClient, tokens: AccessTokenProvider) {
        base = config.apiURL.absoluteString
        self.http = http
        self.tokens = tokens
    }

    /// `GET /api/c/me`: the address, the name, how many boards.
    public func me() async throws -> CustomerMe {
        CustomerRead.me(try await get("me"))
    }

    /// `GET /api/c/boards`: the customer's boards, as they last reported.
    public func boards() async throws -> [CustomerBoard] {
        guard let boards = CustomerRead.list(try await get("boards")["boards"], CustomerRead.board) else {
            throw CustomerAPIError.unreadable
        }
        return boards
    }

    /// `GET /api/c/boards/{id}`: one board, by its assignment id, and the last 30 days of what it did.
    public func board(id: String) async throws -> CustomerBoardDetail {
        guard CustomerRead.isBoardId(id) else { throw CustomerAPIError.notYours }
        let body = try await get("boards/\(id)")
        guard let board = CustomerRead.board(body["board"]),
              let activity = CustomerRead.list(body["activity"], CustomerRead.event) else {
            throw CustomerAPIError.unreadable
        }
        return CustomerBoardDetail(board: board, activity: activity)
    }

    /// `GET /api/c/activity`: what every board did in the last 7 days, newest first.
    public func activity() async throws -> [CustomerEvent] {
        guard let activity = CustomerRead.list(try await get("activity")["activity"], CustomerRead.event) else {
            throw CustomerAPIError.unreadable
        }
        return activity
    }

    /// One GET. A 401 refreshes the token once and asks again; a second one ends the session.
    private func get(_ path: String) async throws -> [String: Any] {
        guard let url = URL(string: base + "/api/c/" + path) else { throw CustomerAPIError.unreadable }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        var token = try await tokens.accessToken()
        for attempt in 0..<2 {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let data: Data, response: HTTPURLResponse
            do {
                (data, response) = try await http.send(request)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw CustomerAPIError.network
            }
            if response.statusCode == 401 {
                if attempt == 0 {
                    token = try await tokens.accessToken(replacing: token)
                    continue
                }
                throw AuthError.sessionExpired
            }
            // As the site: an answer that is not JSON cannot be read, whatever its status.
            guard let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
                throw CustomerAPIError.unreadable
            }
            guard (200..<300).contains(response.statusCode) else {
                throw CustomerAPIError.from(data, status: response.statusCode)
            }
            guard let object = parsed as? [String: Any] else { throw CustomerAPIError.unreadable }
            return object
        }
        throw AuthError.sessionExpired
    }
}
