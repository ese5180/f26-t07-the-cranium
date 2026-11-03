import Foundation

/// An error answer from the console: `{"error": {"code": "...", "message": "..."}}` and its
/// HTTP status. The message is written for people, so the app shows it.
public struct APIError: Error, Equatable, LocalizedError {
    public let status: Int
    public let code: String
    public let message: String

    public init(status: Int, code: String, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// The calls of docs/mobile-apps.md, "The API", all under the console's address, all with
/// `Authorization: Bearer {access_token}`.
public final class ConsoleAPI: Sendable {
    private let base: String
    private let http: HTTPClient
    private let tokens: AccessTokenProvider

    public init(config: CraniumConfig, http: HTTPClient, tokens: AccessTokenProvider) {
        self.base = config.consoleURL.absoluteString
        self.http = http
        self.tokens = tokens
    }

    /// `GET /api/me`. `canWrite` is true for a release manager.
    public func me() async throws -> Me {
        try decode(Me.self, from: try await get(["api", "me"]))
    }

    /// `GET /api/firmware`: every release, active and revoked, newest first.
    public func firmware() async throws -> FirmwareList {
        try decode(FirmwareList.self, from: try await get(["api", "firmware"]))
    }

    /// `GET /api/firmware/{version}/image`: the signed image. Release managers only (403 for
    /// anyone else), 404 for a revoked or unknown version. Check it with `ImageCheck.verify`
    /// before it goes anywhere.
    public func image(of release: FirmwareRelease) async throws -> Data {
        try await get(["api", "firmware", release.version, "image"], accept: "application/octet-stream", timeout: 120)
    }

    /// `GET /api/pairing/{name}`: the passkey of the board advertising as `name`, while a phone
    /// pairs with it. Nil when no online board has a window open with that name (404), which is
    /// the usual answer for a board that is not on Wi-Fi.
    public func pairing(name: String) async throws -> Pairing? {
        guard BoardName.isValid(name) else { return nil }
        do {
            let pairing = try decode(Pairing.self, from: try await get(["api", "pairing", name]))
            guard pairing.name == name, pairing.passkey.count == 6,
                  pairing.passkey.allSatisfy({ $0.isASCII && $0.isNumber }) else {
                return nil
            }
            return pairing
        } catch let error as APIError where error.status == 404 {
            return nil
        }
    }

    /// `GET /api/devices/{thing}`: whether the board is online, and what it reports it runs.
    public func device(thing: String) async throws -> DeviceStatus {
        struct Answer: Decodable { let device: DeviceStatus }
        return try decode(Answer.self, from: try await get(["api", "devices", thing])).device
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
            answer = try await get(["api", "firmware", image.release, "bluetooth"],
                                   post: SendCheck.body(sha256: sha256, board: board))
        } catch is URLError {
            throw SendCheckError.unreachable(release: image.release)
        } catch let error as APIError where error.status != 401 {
            throw SendCheckError.refused(release: image.release, message: error.message)
        }
        try SendCheck.requireCleared(answer, release: image.release, sha256: sha256)
    }

    // MARK: -

    /// A GET, or with `post` a POST of that JSON body.
    private func get(_ segments: [String], accept: String = "application/json",
                     timeout: TimeInterval = 30, post: Data? = nil) async throws -> Data {
        let path = segments.map(FormEncoding.pathSegment).joined(separator: "/")
        guard let url = URL(string: base + "/" + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = post == nil ? "GET" : "POST"
        if let post {
            request.httpBody = post
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
            struct Inner: Decodable { let code: String?; let message: String? }
            let error: Inner
        }
        if let body = try? JSONDecoder().decode(Body.self, from: data),
           let message = body.error.message, !message.isEmpty {
            return APIError(status: status, code: body.error.code ?? "error", message: message)
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
