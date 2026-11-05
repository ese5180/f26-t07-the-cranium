import Foundation

/// An error answer from the console: `{"error": {"code": "...", "message": "...", "requestId": "..."}}`
/// and its HTTP status. The message is written for people, so the app shows it.
public struct APIError: Error, Equatable, LocalizedError {
    /// A board the console named when it refused a deployment because the board is busy.
    public struct BusyBoard: Equatable, Sendable {
        public let thing: String
        public let deployment: String?
    }

    public let status: Int
    public let code: String
    public let message: String
    public let requestId: String?
    public let busyBoards: [BusyBoard]

    public init(status: Int, code: String, message: String, requestId: String? = nil, busyBoards: [BusyBoard] = []) {
        self.status = status
        self.code = code
        self.message = message
        self.requestId = requestId
        self.busyBoards = busyBoards
    }

    public var errorDescription: String? { message }

    /// A refusal: the server understood the request and said no, so nothing was changed. After any
    /// other failure the change may have been made.
    public var isRefusal: Bool { (400..<500).contains(status) }

    /// The answer to a change from the phone whose sign-in is older than 15 minutes.
    public var needsFreshSignIn: Bool { status == 403 && code == FreshSignIn.code }
}

/// Every route of the console's API (cloud/api/src/app.mjs), under the console's address, with
/// `Authorization: Bearer {access_token}`. A phone's session may use all of them; a change needs a
/// sign-in in the last 15 minutes (see `FreshSignIn`).
public final class ConsoleAPI: Sendable {
    private let base: String
    private let http: HTTPClient
    private let tokens: AccessTokenProvider

    public init(config: CraniumConfig, http: HTTPClient, tokens: AccessTokenProvider) {
        self.base = config.consoleURL.absoluteString
        self.http = http
        self.tokens = tokens
    }

    // MARK: Who

    /// `GET /api/me`. `canWrite` is true for a release manager.
    public func me() async throws -> Me {
        try decode(Me.self, from: try await send(["api", "me"]))
    }

    // MARK: Boards

    /// `GET /api/devices`: every board of the project, as it last reported.
    public func devices() async throws -> DeviceList {
        try decode(DeviceList.self, from: try await send(["api", "devices"]))
    }

    /// `GET /api/devices/{thing}`: a board, its certificates and its updates.
    public func deviceDetail(thing: String) async throws -> DeviceDetail {
        try decode(DeviceDetail.self, from: try await send(["api", "devices", thing]))
    }

    /// `GET /api/devices/{thing}`: whether the board is online, and what it reports it runs.
    public func device(thing: String) async throws -> DeviceStatus {
        struct Answer: Decodable { let device: DeviceStatus }
        return try decode(Answer.self, from: try await send(["api", "devices", thing])).device
    }

    /// `GET /api/devices/{thing}/samples?hours=…`: the signal and the memory over 1 to 168 hours.
    public func samples(thing: String, hours: Int = 24) async throws -> Samples {
        let hours = min(max(hours, 1), 168)
        return try decode(Samples.self, from: try await send(["api", "devices", thing, "samples"],
                                                             query: [("hours", String(hours))]))
    }

    /// `GET /api/events`: what the boards did, newest first, at most 500 a page.
    public func events(from: Date, to: Date, thing: String? = nil, kinds: [String]? = nil, limit: Int? = nil,
                       cursor: String? = nil) async throws -> EventPage {
        var query = [("from", ConsoleTime.text(from)), ("to", ConsoleTime.text(to))]
        if let thing, !thing.isEmpty { query.append(("thing", thing)) }
        if let kinds, !kinds.isEmpty { query.append(("kinds", kinds.joined(separator: ","))) }
        if let limit { query.append(("limit", String(limit))) }
        if let cursor { query.append(("cursor", cursor)) }
        return try decode(EventPage.self, from: try await send(["api", "events"], query: query))
    }

    /// `GET /api/events/log`: what the boards printed on their serial consoles (firmware 1.12.0 and
    /// later), newest first, at most 500 a page; `tags` keeps the lines of those sources only.
    public func boardLog(from: Date, to: Date, thing: String? = nil, kinds: [String]? = nil, tags: [String]? = nil,
                         limit: Int? = nil, cursor: String? = nil) async throws -> LinePage {
        var query = [("from", ConsoleTime.text(from)), ("to", ConsoleTime.text(to))]
        if let thing, !thing.isEmpty { query.append(("thing", thing)) }
        if let kinds, !kinds.isEmpty { query.append(("kinds", kinds.joined(separator: ","))) }
        if let tags, !tags.isEmpty { query.append(("tags", tags.joined(separator: ","))) }
        if let limit { query.append(("limit", String(min(max(limit, 1), 500)))) }
        if let cursor { query.append(("cursor", cursor)) }
        return try decode(LinePage.self, from: try await send(["api", "events", "log"], query: query))
    }

    // MARK: Firmware

    /// `GET /api/firmware`: every release, active and revoked, newest first.
    public func firmware() async throws -> FirmwareList {
        try decode(FirmwareList.self, from: try await send(["api", "firmware"]))
    }

    /// `POST /api/firmware`: uploads a signed image for the server to verify and register, as the
    /// website does: `{filename, notes, data}` with the file in standard base64. The server reads the
    /// version from the signed header. Release managers only; a change.
    public func upload(filename: String, notes: String, data: Data) async throws -> FirmwareRelease {
        struct Answer: Decodable { let release: FirmwareRelease }
        let body = try JSONSerialization.data(withJSONObject: [
            "filename": UploadCheck.recordedFilename(filename),
            "notes": UploadCheck.singleLine(notes),
            "data": data.base64EncodedString(),
        ], options: [.sortedKeys])
        return try decode(Answer.self, from: try await send(["api", "firmware"], method: "POST", body: body, timeout: 120)).release
    }

    /// `POST /api/firmware/{version}/revoke` with a reason: withdraws a release for good, refuses its
    /// image and cancels its open deployments. Returns the release and the deployments it cancelled.
    /// `PUT /api/firmware/{version}/notes`: a release's note, changed after its upload, active or revoked.
    /// The whole note every time: "" clears it. One line, at most 500 characters. Release managers; a change.
    public func setNotes(version: String, notes: String) async throws -> FirmwareRelease {
        struct Answer: Decodable { let release: FirmwareRelease }
        let body = try JSONSerialization.data(withJSONObject: ["notes": String(UploadCheck.singleLine(notes).prefix(Self.notesLimit))])
        return try decode(Answer.self, from: try await send(["api", "firmware", version, "notes"], method: "PUT", body: body)).release
    }

    /// The longest note the server keeps.
    public static let notesLimit = 500

    public func revoke(version: String, reason: String) async throws -> (release: FirmwareRelease, cancelled: [String]) {
        struct Answer: Decodable {
            let release: FirmwareRelease
            let cancelled: [String]?
        }
        let body = try JSONSerialization.data(withJSONObject: ["reason": UploadCheck.singleLine(reason)])
        let answer = try decode(Answer.self, from: try await send(["api", "firmware", version, "revoke"],
                                                                  method: "POST", body: body))
        return (answer.release, answer.cancelled ?? [])
    }

    /// `GET /api/firmware/{version}/image`: the signed image. Release managers only (403 for anyone
    /// else), 404 for a revoked or unknown version. Check it with `ImageCheck.verify` before it goes
    /// anywhere.
    public func image(of release: FirmwareRelease) async throws -> Data {
        try await send(["api", "firmware", release.version, "image"], accept: "application/octet-stream", timeout: 120)
    }

    /// `GET /api/pairing/{name}`: the passkey of the board advertising as `name`, while a phone
    /// pairs with it. Nil when no online board has a window open with that name (404), which is
    /// the usual answer for a board that is not on Wi-Fi.
    public func pairing(name: String) async throws -> Pairing? {
        guard BoardName.isValid(name) else { return nil }
        do {
            let pairing = try decode(Pairing.self, from: try await send(["api", "pairing", name]))
            guard pairing.name == name, pairing.passkey.count == 6,
                  pairing.passkey.allSatisfy({ $0.isASCII && $0.isNumber }) else {
                return nil
            }
            return pairing
        } catch let error as APIError where error.status == 404 {
            return nil
        }
    }

    /// `POST /api/firmware/{version}/bluetooth`, right before every Bluetooth send: may `image` be
    /// sent to `board` now? Returns only if the console answers 200 with the same release, the
    /// same SHA-256 and `active` (`SendCheck`). Throws `SendCheckError` otherwise, when the console
    /// cannot be reached included: then nothing may be sent. A sign-in that has ended is thrown as
    /// it is.
    public func confirmSend(_ image: VerifiedImage, board: String?) async throws {
        let sha256 = ImageCheck.sha256Hex(image.data)
        let answer: Data
        do {
            answer = try await send(["api", "firmware", image.release, "bluetooth"], method: "POST",
                                    body: SendCheck.body(sha256: sha256, board: board))
        } catch is URLError {
            throw SendCheckError.unreachable(release: image.release)
        } catch let error as APIError where error.status != 401 {
            throw SendCheckError.refused(release: image.release, message: error.message)
        }
        try SendCheck.requireCleared(answer, release: image.release, sha256: sha256)
    }

    // MARK: Deployments

    /// `GET /api/deployments`: the newest deployments, with their counts.
    public func deployments() async throws -> [Deployment] {
        struct Answer: Decodable { let deployments: LenientList<Deployment> }
        return try decode(Answer.self, from: try await send(["api", "deployments"])).deployments.items.filter { !$0.id.isEmpty }
    }

    /// `GET /api/deployments/{id}`: a deployment with each board's part in it.
    public func deployment(id: String) async throws -> Deployment {
        struct Answer: Decodable { let deployment: Deployment }
        return try decode(Answer.self, from: try await send(["api", "deployments", id])).deployment
    }

    /// `POST /api/deployments`: offers a release to boards over the internet. A change.
    public func deploy(version: String, things: [String], note: String) async throws -> Deployment {
        struct Answer: Decodable { let deployment: Deployment }
        let body = try JSONSerialization.data(withJSONObject: [
            "version": version, "things": things, "note": UploadCheck.singleLine(note),
        ], options: [.sortedKeys])
        return try decode(Answer.self, from: try await send(["api", "deployments"], method: "POST", body: body)).deployment
    }

    /// `POST /api/deployments/{id}/cancel`: withdraws the offer, and with `force` stops the boards that
    /// have started. A change.
    public func cancel(deployment id: String, force: Bool) async throws -> Deployment {
        struct Answer: Decodable { let deployment: Deployment }
        let body = try JSONSerialization.data(withJSONObject: ["force": force])
        return try decode(Answer.self, from: try await send(["api", "deployments", id, "cancel"],
                                                            method: "POST", body: body)).deployment
    }

    // MARK: Updates

    /// `GET /api/updates` (console 2.1.1 and later): every update of every board, or of `thing`, newest
    /// first: the deployments, and the updates the boards reported themselves, over Bluetooth or by USB
    /// or another tool. `limit` is 1 to 100 (the console's default is 25). Nil from an older console,
    /// which has no such route (`hasNoRoute`): then the app shows what it showed before.
    public func updates(thing: String? = nil, limit: Int? = nil, cursor: String? = nil) async throws -> UpdatesPage? {
        var query: [(String, String)] = []
        if let thing, !thing.isEmpty { query.append(("thing", thing)) }
        if let limit { query.append(("limit", String(min(max(limit, 1), 100)))) }
        if let cursor { query.append(("cursor", cursor)) }
        do {
            return try decode(UpdatesPage.self, from: try await send(["api", "updates"], query: query))
        } catch let error as APIError where Self.hasNoRoute(error) {
            return nil
        }
    }

    /// The console has no such route: 404 with the code `not_found`, as console 2.1.0 and before answer
    /// `GET /api/updates`. A board that is not registered is 404 `unknown_device`, which is not this.
    public static func hasNoRoute(_ error: Error) -> Bool {
        guard let error = error as? APIError else { return false }
        return error.status == 404 && error.code == "not_found"
    }

    // MARK: Activity

    /// `GET /api/audit`: a page of the activity log, newest first.
    public func audit(limit: Int = 50, before: String? = nil) async throws -> AuditPage {
        var query = [("limit", String(min(max(limit, 1), 100)))]
        if let before { query.append(("before", before)) }
        return try decode(AuditPage.self, from: try await send(["api", "audit"], query: query))
    }

    // MARK: API tokens

    /// `GET /api/tokens`: the signed-in person's own API tokens.
    public func tokens() async throws -> TokenList {
        try decode(TokenList.self, from: try await send(["api", "tokens"]))
    }

    /// `POST /api/tokens`: makes a token, valid for `days`. The answer holds the token, once. A change.
    public func createToken(name: String, days: Int) async throws -> NewToken {
        let body = try JSONSerialization.data(withJSONObject: [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "days": days,
        ], options: [.sortedKeys])
        return try decode(NewToken.self, from: try await send(["api", "tokens"], method: "POST", body: body))
    }

    /// `POST /api/tokens/{id}/revoke`. A change.
    public func revokeToken(id: String) async throws -> APIToken {
        struct Answer: Decodable { let token: APIToken }
        return try decode(Answer.self, from: try await send(["api", "tokens", id, "revoke"], method: "POST",
                                                            body: Data("{}".utf8))).token
    }

    // MARK: The website's own files

    /// The project's commits, from `history.json` beside the console's scripts: the website's
    /// History page. Nil when this deployment of the console has none.
    public func history() async throws -> CommitHistory? {
        guard let page = URL(string: base + "/") else { throw URLError(.badURL) }
        var request = URLRequest(url: page, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        let (html, answer) = try await http.send(request)
        guard (200..<300).contains(answer.statusCode),
              let build = CommitHistory.buildId(inIndex: String(decoding: html, as: UTF8.self)),
              let file = URL(string: base + "/assets/" + build + "/history.json") else {
            throw APIError(status: answer.statusCode, code: "http", message: "The console's page could not be read.")
        }
        var fetch = URLRequest(url: file, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        fetch.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await http.send(fetch)
        if response.statusCode == 404 { return nil }
        guard (200..<300).contains(response.statusCode), let history = CommitHistory.parse(data) else {
            throw APIError(status: response.statusCode, code: "http",
                           message: "The history file could not be read. Try again in a moment.")
        }
        return history
    }

    // MARK: -

    /// One request: a GET, or with `body` a request of that JSON body.
    private func send(_ segments: [String], method: String? = nil, query: [(String, String)] = [], body: Data? = nil,
                      accept: String = "application/json", timeout: TimeInterval = 30) async throws -> Data {
        let path = segments.map(FormEncoding.pathSegment).joined(separator: "/")
        let suffix = query.isEmpty ? "" : "?" + FormEncoding.urlQuery(query)
        guard let url = URL(string: base + "/" + path + suffix) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method ?? (body == nil ? "GET" : "POST")
        if let body {
            request.httpBody = body
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        request.setValue(accept, forHTTPHeaderField: "Accept")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData

        var token = try await tokens.accessToken()
        for attempt in 0..<2 {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await http.send(request)
            if response.statusCode == 401 && attempt == 0 {
                token = try await tokens.accessToken(replacing: token)
                continue
            }
            guard (200..<300).contains(response.statusCode) else {
                throw Self.error(from: data, status: response.statusCode)
            }
            return data
        }
        throw AuthError.sessionExpired
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError(status: 200, code: "bad_answer", message: "The console's answer could not be read.")
        }
    }

    static func error(from data: Data, status: Int) -> APIError {
        struct Body: Decodable {
            struct Busy: Decodable { let thing: String?; let deployment: String? }
            struct Inner: Decodable {
                let code: String?
                let message: String?
                let requestId: String?
                let details: [Busy]?
            }
            let error: Inner?
            let message: String?
        }
        let body = try? JSONDecoder().decode(Body.self, from: data)
        if let inner = body?.error, let message = inner.message, !message.isEmpty {
            let busy = (inner.details ?? []).compactMap { item -> APIError.BusyBoard? in
                guard let thing = item.thing, BoardName.isThing(thing) else { return nil }
                return APIError.BusyBoard(thing: thing, deployment: item.deployment.flatMap { DeploymentId.isValid($0) ? $0 : nil })
            }
            let requestId = inner.requestId.map { String($0.prefix(64)) }
            return APIError(status: status, code: String((inner.code ?? "error").prefix(64)),
                            message: String(message.prefix(400)), requestId: requestId, busyBoards: busy)
        }
        // API Gateway answers some requests itself, as { "message": "..." }.
        if let message = body?.message, !message.isEmpty, status != 401 {
            return APIError(status: status, code: "gateway", message: "\(message.prefix(200)) (HTTP \(status)).")
        }
        let fallback: String
        switch status {
        case 401: fallback = "The console did not accept the sign-in."
        case 403: fallback = "You do not have the role this needs."
        case 404: fallback = "The console has no such thing."
        default: fallback = "The console answered \(status)."
        }
        return APIError(status: status, code: "http_\(status)", message: fallback)
    }
}
