import CryptoKit
import Foundation
@testable import CraniumKit

/// A stand-in for Cognito's user pool API, as far as the app's own sign-in uses it, after the
/// website's cloud/web/test/cognito.mjs: InitiateAuth with USER_SRP_AUTH, then
/// RespondToAuthChallenge with PASSWORD_VERIFIER and SOFTWARE_TOKEN_MFA. It plays the server's half
/// of SRP, which is worked out differently from the phone's:
///
///   v = g^x,   B = k·v + g^b,   u = H(A | B),   S = (A · v^u)^b,
///   key = HKDF(S, salt = u, "Caldera Derived Key", 16 bytes),
///   claim = HMAC(key, poolName | userId | secret block | timestamp), base64.
///
/// So a sign-in only gets through with a proof that Cognito would accept. (It uses the app's
/// BigUInt and hashes; SRPTests checks those against the website's own code.)
///
/// Like a pool with PreventUserExistenceErrors, it answers an unknown address with a challenge as
/// usual and refuses the claim in the same words as a wrong password. No AWS is involved.
final class CognitoStub: HTTPClient, @unchecked Sendable {
    struct User {
        var email: String
        var userId: String
        var password: String
        var code: String
        /// The challenge after the password: SOFTWARE_TOKEN_MFA unless it says otherwise. "NONE": the
        /// tokens at once (a customer without two-step sign-in). NEW_PASSWORD_REQUIRED: a first
        /// sign-in, after which the code follows if `code` is not empty.
        var next: String? = nil
    }

    struct Call {
        let operation: String
        let body: [String: Any]
        let request: URLRequest
        var challenge: String? { body["ChallengeName"] as? String }
    }

    let userPoolId: String
    let clientId: String
    let endpoint: URL
    /// How long the step of the code waits (AuthSessionValidity), and how many wrong codes it takes.
    static let sessionLength: TimeInterval = 15 * 60
    static let codeTries = 3
    /// How far the time in a claim may be from the server's.
    static let clockSkew: TimeInterval = 5 * 60

    private let lock = NSLock()
    private var accounts: [String: (user: User, salt: BigUInt, verifier: BigUInt)] = [:]
    private var exchanges: [String: (account: User?, userId: String, verifier: BigUInt, A: BigUInt, b: BigUInt, B: BigUInt)] = [:]
    private var sessions: [String: (user: User, expiresAt: Date, tries: Int, step: String)] = [:]
    private var issued = 0
    /// The refresh tokens handed out and not revoked, and those revoked.
    private var refreshTokens: Set<String> = []
    private var _revoked: [String] = []
    private var _calls: [Call] = []
    private var _now: Date
    /// Put the Date header on every answer.
    var sendsDate: Bool
    /// An error to answer with instead, by name.
    var fail: @Sendable (String, [String: Any]) -> String?
    /// Instead of all this: what to answer to a request (status, body), or throw.
    var raw: (@Sendable (URLRequest) throws -> (Int, Data)?)?

    init(userPoolId: String, clientId: String, users: [User], now: Date, sendsDate: Bool = false,
         fail: @escaping @Sendable (String, [String: Any]) -> String? = { _, _ in nil }) {
        self.userPoolId = userPoolId
        self.clientId = clientId
        let region = String(userPoolId[..<userPoolId.firstIndex(of: "_")!])
        endpoint = URL(string: "https://cognito-idp.\(region).amazonaws.com/")!
        _now = now
        self.sendsDate = sendsDate
        self.fail = fail
        for user in users {
            let salt = BigUInt(bigEndian: Self.random(16))
            accounts[user.email.lowercased()] = (user, salt, verifier(userId: user.userId, password: user.password, salt: salt))
        }
    }

    var calls: [Call] { lock.withLock { _calls } }
    var now: Date {
        get { lock.withLock { _now } }
        set { lock.withLock { _now = newValue } }
    }
    var sessionsOpen: Int { lock.withLock { sessions.count } }
    var revoked: [String] { lock.withLock { _revoked } }
    /// The new password a first sign-in chose, by user.
    private var _chosen: [String: String] = [:]
    var chosen: [String: String] { lock.withLock { _chosen } }

    static func random(_ count: Int) -> [UInt8] { CognitoSRP.systemRandom(count) }

    private var poolName: String { String(userPoolId[userPoolId.index(after: userPoolId.firstIndex(of: "_")!)...]) }

    private func verifier(userId: String, password: String, salt: BigUInt) -> BigUInt {
        let inner = Array(SHA256.hash(data: Array("\(poolName)\(userId):\(password)".utf8)))
        let x = BigUInt(bigEndian: Array(SHA256.hash(data: salt.signedBytes + inner)))
        return CognitoSRP.group.power(CognitoSRP.g, x)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if let raw, let (status, data) = try raw(request) {
            return (data, response(request, status: status, error: nil))
        }
        let target = request.value(forHTTPHeaderField: "X-Amz-Target") ?? ""
        let prefix = "AWSCognitoIdentityProviderService."
        guard request.url == endpoint, request.httpMethod == "POST", target.hasPrefix(prefix),
              request.value(forHTTPHeaderField: "Content-Type") == "application/x-amz-json-1.1",
              let data = request.httpBody,
              let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return refuse(request, "UnknownOperationException")
        }
        let operation = String(target.dropFirst(prefix.count))
        lock.withLock { _calls.append(Call(operation: operation, body: body, request: request)) }
        if let scripted = fail(operation, body) { return refuse(request, scripted) }
        guard body["ClientId"] as? String == clientId else { return refuse(request, "ResourceNotFoundException") }
        let answer: (String?, [String: Any])
        switch (operation, body["ChallengeName"] as? String) {
        case ("InitiateAuth", _): answer = initiate(body)
        case ("RespondToAuthChallenge", "PASSWORD_VERIFIER"): answer = verifyPassword(body)
        case ("RespondToAuthChallenge", "SOFTWARE_TOKEN_MFA"): answer = verifyCode(body)
        case ("RespondToAuthChallenge", "NEW_PASSWORD_REQUIRED"): answer = verifyNewPassword(body)
        case ("RevokeToken", _):
            let token = body["Token"] as? String ?? ""
            lock.withLock {
                refreshTokens.remove(token)
                _revoked.append(token)
            }
            answer = (nil, [:])
        default: answer = ("InvalidParameterException", [:])
        }
        if let error = answer.0 { return refuse(request, error) }
        return (try JSONSerialization.data(withJSONObject: answer.1), response(request, status: 200, error: nil))
    }

    private func response(_ request: URLRequest, status: Int, error: String?) -> HTTPURLResponse {
        var headers = ["Content-Type": "application/x-amz-json-1.1"]
        if let error { headers["X-Amzn-ErrorType"] = "\(error):http://internal.amazon.com/coral/" }
        if sendsDate {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: "GMT")
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
            headers["Date"] = formatter.string(from: now)
        }
        return HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }

    private func refuse(_ request: URLRequest, _ name: String) -> (Data, HTTPURLResponse) {
        let body = try! JSONSerialization.data(withJSONObject: ["__type": name, "message": "Refused: \(name)."])
        return (body, response(request, status: 400, error: name))
    }

    private func initiate(_ body: [String: Any]) -> (String?, [String: Any]) {
        if body["AuthFlow"] as? String == "REFRESH_TOKEN_AUTH" {
            let token = (body["AuthParameters"] as? [String: Any])?["REFRESH_TOKEN"] as? String ?? ""
            return lock.withLock {
                guard refreshTokens.contains(token) else { return ("NotAuthorizedException", [:]) }
                issued += 1
                // No refresh token in a refresh's answer, as Cognito without rotation.
                return (nil, ["AuthenticationResult": [
                    "TokenType": "Bearer", "AccessToken": "SRP-ACCESS-\(issued)", "ExpiresIn": 3600, "IdToken": "SRP-ID-\(issued)",
                ] as [String: Any], "ChallengeParameters": [String: String]()])
            }
        }
        guard body["AuthFlow"] as? String == "USER_SRP_AUTH" else { return ("InvalidParameterException", [:]) }
        let parameters = body["AuthParameters"] as? [String: Any] ?? [:]
        guard let username = parameters["USERNAME"] as? String, let srpA = parameters["SRP_A"] as? String,
              srpA.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }),
              let A = BigUInt(hex: srpA) else {
            return ("InvalidParameterException", [:])
        }
        if (A % CognitoSRP.N).isZero { return ("NotAuthorizedException", [:]) }
        return lock.withLock {
            let account = accounts[username.lowercased()]
            // An address nobody has gets a challenge that nothing can answer.
            let salt = account?.salt ?? BigUInt(bigEndian: Self.random(16))
            let verifier = account?.verifier ?? CognitoSRP.group.power(CognitoSRP.g, BigUInt(bigEndian: Self.random(32)))
            let userId = account?.user.userId ?? Self.random(16).map { String(format: "%02x", $0) }.joined()
            let b = BigUInt(bigEndian: Self.random(32))
            let B = (CognitoSRP.k * verifier + CognitoSRP.group.power(CognitoSRP.g, b)) % CognitoSRP.N
            let secretBlock = Data(Self.random(96)).base64EncodedString()
            exchanges[secretBlock] = (account?.user, userId, verifier, A, b, B)
            return (nil, [
                "ChallengeName": "PASSWORD_VERIFIER",
                "ChallengeParameters": [
                    "SALT": salt.hex, "SECRET_BLOCK": secretBlock, "SRP_B": B.hex, "USERNAME": userId, "USER_ID_FOR_SRP": userId,
                ],
            ])
        }
    }

    /// The claim Cognito expects, from its own side of the exchange.
    private func expectedClaim(userId: String, verifier: BigUInt, A: BigUInt, b: BigUInt, B: BigUInt,
                               secretBlock: String, timestamp: String) -> String {
        let group = CognitoSRP.group, N = CognitoSRP.N
        let u = BigUInt(bigEndian: Array(SHA256.hash(data: A.signedBytes + B.signedBytes)))
        let S = group.power((A * group.power(verifier, u)) % N, b)
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: S.signedBytes), salt: u.signedBytes,
                                         info: Array("Caldera Derived Key".utf8), outputByteCount: 16)
        let message = Array(poolName.utf8) + Array(userId.utf8) + Array(Data(base64Encoded: secretBlock)!) + Array(timestamp.utf8)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: key)).base64EncodedString()
    }

    /// The instant a claim's time names, or nil if it is not written as Cognito writes it.
    static func timestampAt(_ text: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "EEE MMM d HH:mm:ss 'UTC' yyyy"
        guard let date = formatter.date(from: text) else { return nil }
        // Strict: the day without a leading zero, and the right weekday.
        return formatter.string(from: date) == text ? date : nil
    }

    private func verifyPassword(_ body: [String: Any]) -> (String?, [String: Any]) {
        let answer = body["ChallengeResponses"] as? [String: Any] ?? [:]
        let block = answer["PASSWORD_CLAIM_SECRET_BLOCK"] as? String ?? ""
        // An exchange is good for one answer.
        guard let exchange = lock.withLock({ exchanges.removeValue(forKey: block) }) else {
            return ("NotAuthorizedException", [:])
        }
        guard let timestamp = answer["TIMESTAMP"] as? String, let at = Self.timestampAt(timestamp),
              abs(at.timeIntervalSince(now)) <= Self.clockSkew else {
            return ("NotAuthorizedException", [:])
        }
        let expected = expectedClaim(userId: exchange.userId, verifier: exchange.verifier, A: exchange.A, b: exchange.b,
                                     B: exchange.B, secretBlock: block, timestamp: timestamp)
        guard let user = exchange.account, answer["USERNAME"] as? String == exchange.userId,
              answer["PASSWORD_CLAIM_SIGNATURE"] as? String == expected else {
            return ("NotAuthorizedException", [:])
        }
        let step = user.next ?? "SOFTWARE_TOKEN_MFA"
        if step == "NONE" { return lock.withLock { tokensLocked() } }
        return (nil, open(step, for: user))
    }

    /// A step that waits, with its session.
    private func open(_ step: String, for user: User) -> [String: Any] {
        let session = Data(Self.random(24)).base64EncodedString()
        let expiresAt = now.addingTimeInterval(Self.sessionLength)
        lock.withLock { sessions[session] = (user, expiresAt, 0, step) }
        return ["ChallengeName": step, "Session": session, "ChallengeParameters": [String: String]()]
    }

    /// Tokens, with a refresh token that a refresh and a revocation know. Call with the lock held.
    private func tokensLocked() -> (String?, [String: Any]) {
        issued += 1
        refreshTokens.insert("SRP-REFRESH-\(issued)")
        return (nil, [
            "AuthenticationResult": [
                "TokenType": "Bearer", "AccessToken": "SRP-ACCESS-\(issued)", "ExpiresIn": 3600,
                "RefreshToken": "SRP-REFRESH-\(issued)", "IdToken": "SRP-ID-\(issued)",
            ] as [String: Any],
            "ChallengeParameters": [String: String](),
        ])
    }

    /// A first sign-in's new password: at least 10 characters, as the customer pool asks.
    private func verifyNewPassword(_ body: [String: Any]) -> (String?, [String: Any]) {
        let key = body["Session"] as? String ?? ""
        let found: (user: User, ok: Bool)? = lock.withLock {
            guard let session = sessions[key], session.step == "NEW_PASSWORD_REQUIRED", session.expiresAt > _now else {
                sessions.removeValue(forKey: key)
                return nil
            }
            let answer = body["ChallengeResponses"] as? [String: Any] ?? [:]
            guard answer["USERNAME"] as? String == session.user.userId else { return nil }
            let password = answer["NEW_PASSWORD"] as? String ?? ""
            guard password.count >= 10 else { return (session.user, false) }
            sessions.removeValue(forKey: key)
            _chosen[session.user.userId] = password
            return (session.user, true)
        }
        guard let found else { return ("NotAuthorizedException", [:]) }
        guard found.ok else { return ("InvalidPasswordException", [:]) }
        if found.user.code.isEmpty { return lock.withLock { tokensLocked() } }
        return (nil, open("SOFTWARE_TOKEN_MFA", for: found.user))
    }

    private func verifyCode(_ body: [String: Any]) -> (String?, [String: Any]) {
        let key = body["Session"] as? String ?? ""
        return lock.withLock {
            guard var session = sessions[key], session.step == "SOFTWARE_TOKEN_MFA", session.expiresAt > _now else {
                sessions.removeValue(forKey: key)
                return ("NotAuthorizedException", [:])
            }
            let answer = body["ChallengeResponses"] as? [String: Any] ?? [:]
            guard answer["USERNAME"] as? String == session.user.userId else { return ("NotAuthorizedException", [:]) }
            guard answer["SOFTWARE_TOKEN_MFA_CODE"] as? String == session.user.code else {
                session.tries += 1
                sessions[key] = session.tries >= Self.codeTries ? nil : session
                return ("CodeMismatchException", [:])
            }
            sessions.removeValue(forKey: key)
            return tokensLocked()
        }
    }
}
