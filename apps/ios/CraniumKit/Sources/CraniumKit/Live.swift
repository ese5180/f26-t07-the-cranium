import Combine
import Foundation

/// Live updates (docs/live.md) without a web page: the WebSocket the console's pages keep, kept by the
/// app itself. The token goes in the Sec-WebSocket-Protocol header with "cranium-live", never in the
/// address. Each message only says that something changed; the app reads it again through the API, as
/// on its next refresh, and keeps polling for when the socket is down.

/// One `{ "type": "changed", ... }` message.
public struct LiveChange: Equatable, Sendable {
    /// The boards that changed, by thing name (the team's messages).
    public let things: [String]
    /// The boards that changed, by the id of their assignment (a customer's messages).
    public let boards: [String]
    /// What changed: "board", "updates", "ownership", "releases", "groups", "rollouts", "apps", "activity".
    public let what: [String]
    public let at: String?

    public init(things: [String] = [], boards: [String] = [], what: [String], at: String? = nil) {
        self.things = things
        self.boards = boards
        self.what = what
        self.at = at
    }

    /// The message, or nil for anything else (an unknown type, text that is not JSON).
    public static func parse(_ text: String) -> LiveChange? {
        guard text.utf8.count <= 16_384, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["type"] as? String == "changed" else { return nil }
        func names(_ key: String) -> [String] {
            (object[key] as? [Any] ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty && $0.count <= 128 }
        }
        let what = names("what")
        guard !what.isEmpty else { return nil }
        return LiveChange(things: names("things"), boards: names("boards"), what: what, at: object["at"] as? String)
    }

    /// Whether a page about `thing` should read again: it is named, or no board is.
    public func concerns(thing: String) -> Bool {
        things.isEmpty || things.contains(thing)
    }
}

public enum LiveProtocol {
    /// The subprotocol the live API answers with; the token is the second one asked for.
    public static let name = "cranium-live"
    public static let ping = #"{"action":"ping"}"#
    /// API Gateway closes a socket that is quiet for 10 minutes.
    public static let pingEvery: TimeInterval = 5 * 60
    /// A connection that lasted this long was a good one: the next failure starts the waits over.
    public static let goodConnection: TimeInterval = 60
}

/// A WebSocket: URLSessionWebSocketTask, or a stand-in in the tests.
public protocol LiveSocket: AnyObject, Sendable {
    /// Done once the socket is open; throws when it cannot open.
    func send(_ text: String) async throws
    func receive() async throws -> String
    func cancel()
}

public protocol LiveConnecting: Sendable {
    func open(_ url: URL, token: String) -> LiveSocket
}

/// URLSession's WebSocket, with the subprotocols "cranium-live" and the access token.
public final class URLSessionLiveConnector: LiveConnecting, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func open(_ url: URL, token: String) -> LiveSocket {
        let task = session.webSocketTask(with: url, protocols: [LiveProtocol.name, token])
        task.resume()
        return URLSessionLiveSocket(task)
    }
}

final class URLSessionLiveSocket: LiveSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(_ task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    func cancel() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

/// How long to wait before connecting again: 1, 2, 4 … seconds, 60 at most, each between half and
/// all of that, so that every app does not come back at the same moment.
public enum LiveBackoff {
    public static func delay(after failures: Int, jitter: Double) -> TimeInterval {
        let base = min(60, pow(2, Double(max(0, failures - 1))))
        return base * (0.5 + 0.5 * min(1, max(0, jitter)))
    }
}

/// Keeps the socket open while it runs: connects with a fresh token, pings every 5 minutes, hands each
/// change to `onChange`, and connects again after a failure or the server's close (which comes when
/// the token expires, two hours at most).
@MainActor
public final class LiveClient: ObservableObject {
    public enum State: Equatable, Sendable {
        /// Not running, or this build has no live API: the app only polls.
        case off
        case connecting
        case live
        /// Down; it tries again in a moment. The app polls meanwhile.
        case waiting
    }

    @Published public private(set) var state: State = .off

    public let url: URL?
    private let connector: LiveConnecting
    private let token: @MainActor () async -> String?
    private let onChange: @MainActor (LiveChange) -> Void
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let random: () -> Double
    private let now: () -> Date
    private var task: Task<Void, Never>?
    private var socket: LiveSocket?

    public init(url: URL?, connector: LiveConnecting = URLSessionLiveConnector(),
                token: @escaping @MainActor () async -> String?,
                onChange: @escaping @MainActor (LiveChange) -> Void,
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
                random: @escaping () -> Double = { Double.random(in: 0...1) },
                now: @escaping () -> Date = { Date() }) {
        self.url = url
        self.connector = connector
        self.token = token
        self.onChange = onChange
        self.sleep = sleep
        self.random = random
        self.now = now
    }

    public var isRunning: Bool { task != nil }

    /// Starts keeping the socket, once; nothing without a live API.
    public func start() {
        guard task == nil, url != nil else { return }
        task = Task { [weak self] in await self?.run() }
    }

    public func stop() {
        task?.cancel()
        task = nil
        socket?.cancel()
        socket = nil
        state = .off
    }

    private func run() async {
        var failures = 0
        while !Task.isCancelled, let url {
            state = .connecting
            guard let token = await token(), !token.isEmpty else {
                // Signed out, or the session is being renewed: try again in a while.
                failures += 1
                state = .waiting
                if (try? await sleep(LiveBackoff.delay(after: failures, jitter: random()))) == nil { break }
                continue
            }
            let socket = connector.open(url, token: token)
            self.socket = socket
            let opened = now()
            do {
                try await socket.send(LiveProtocol.ping)
                guard !Task.isCancelled else { break }
                state = .live
                let sleep = self.sleep
                let pinger = Task {
                    while !Task.isCancelled {
                        try await sleep(LiveProtocol.pingEvery)
                        try await socket.send(LiveProtocol.ping)
                    }
                }
                defer { pinger.cancel() }
                while !Task.isCancelled {
                    let text = try await socket.receive()
                    if let change = LiveChange.parse(text) { onChange(change) }
                }
            } catch {
                // Closed, refused, or no network: the waits below, then once more.
            }
            socket.cancel()
            if self.socket === socket { self.socket = nil }
            guard !Task.isCancelled else { break }
            failures = now().timeIntervalSince(opened) >= LiveProtocol.goodConnection ? 1 : failures + 1
            state = .waiting
            if (try? await sleep(LiveBackoff.delay(after: failures, jitter: random()))) == nil { break }
        }
        if !Task.isCancelled { state = .off }
    }
}
