import Foundation

/// What went wrong with a sign-in on the app's own screen, in the website's words
/// (core.js, `SIGN_IN_WORDS`). Never Cognito's own message: the same words whether the account
/// exists or not.
public enum SignInProblem: String, CaseIterable, Equatable, Sendable {
    case wrongPassword = "wrong-password"
    case wrongCode = "wrong-code"
    case expired
    case tooMany = "too-many"
    case network
    case failed
    case missing
    case shortCode = "short-code"

    public var words: String {
        switch self {
        case .wrongPassword: return "The e-mail address or password is wrong."
        case .wrongCode: return "That code is not right. Try the next one from your authenticator app."
        case .expired: return "The sign-in took too long, so it starts again. Enter your password once more."
        case .tooMany: return "Too many tries. Wait a minute."
        case .network: return "The sign-in service could not be reached. Check the connection and try again."
        case .failed: return "Signing in did not work. Try again, or use the AWS sign-in page."
        case .missing: return "Enter your e-mail address and your password."
        case .shortCode: return "Type all six digits of the code."
        }
    }

    /// What an error of Cognito's means at a step: a problem, or nil for what only the AWS sign-in
    /// page can do. After the password, NotAuthorizedException is Cognito ending the sign-in: its
    /// session is over. The website's `signInProblem`.
    static func of(_ name: String, at step: PasswordSignIn.Step) -> SignInProblem? {
        switch name {
        case "NotAuthorizedException", "UserNotFoundException":
            return step == .code ? .expired : .wrongPassword
        case "CodeMismatchException":
            return step == .code ? .wrongCode : .failed
        case "ExpiredCodeException":
            return .expired
        case "TooManyRequestsException", "LimitExceededException", "TooManyFailedAttemptsException":
            return .tooMany
        case "PasswordResetRequiredException":
            return nil
        default:
            return .failed
        }
    }
}

/// Where an answer of Cognito leaves the sign-in.
public enum PasswordSignInOutcome: Equatable, Sendable {
    /// Ask for the code from the authenticator app, or ask again, with why.
    case code(SignInProblem?)
    /// Back to the e-mail address and the password, with why.
    case password(SignInProblem)
    /// Signed in: the tokens are kept, as the AWS sign-in page's are.
    case done
    /// A step this screen does not do (a new password, an authenticator app to set up, a reset):
    /// Cognito's name for it. The AWS sign-in page does it.
    case elsewhere(challenge: String)
}

/// Sign-in on the app's own screen, as on the console's own sign-in page (core.js, `createAuth`):
/// the e-mail address and the password (USER_SRP_AUTH, then PASSWORD_VERIFIER with the proof of
/// the password), then the code (SOFTWARE_TOKEN_MFA), against Cognito's user pool API. The
/// password stays on the phone: it is used for the proof and nothing else, and is not kept.
///
/// Cognito's session for the step of the code is kept in memory only, here. The tokens at the end
/// go to the `AuthSession`, which keeps and refreshes them as it does those of the AWS sign-in
/// page.
public actor PasswordSignIn {
    enum Step { case password, code }

    private let pool: CognitoUserPool
    private let clientId: String
    private let http: HTTPClient
    private let session: AuthSession
    private let now: @Sendable () -> Date
    private let random: @Sendable (Int) -> [UInt8]
    /// The step that waits for the code: Cognito's session for it, and whom it is for.
    private var challenge: (session: String, userId: String?)?

    /// How long one call may take, as on the website.
    static let timeout: TimeInterval = 15

    /// Nil when the configuration names no user pool: then only the AWS sign-in page can sign in.
    public init?(config: CraniumConfig, http: HTTPClient, session: AuthSession,
                 now: @escaping @Sendable () -> Date = { Date() }) {
        self.init(config: config, http: http, session: session, now: now, random: CognitoSRP.systemRandom)
    }

    init?(config: CraniumConfig, http: HTTPClient, session: AuthSession,
          now: @escaping @Sendable () -> Date, random: @escaping @Sendable (Int) -> [UInt8]) {
        guard let pool = config.userPool else { return nil }
        self.pool = pool
        clientId = config.mobileClientId
        self.http = http
        self.session = session
        self.now = now
        self.random = random
    }

    /// Whether a sign-in waits for its code.
    public var waitsForCode: Bool { challenge != nil }

    /// Drops a sign-in that waits for its code.
    public func cancel() {
        challenge = nil
    }

    /// Signs in with an e-mail address and a password: Cognito's USER_SRP_AUTH. The password is
    /// used for the proof and nothing else; it is not kept and not sent.
    public func signIn(email: String, password: String) async -> PasswordSignInOutcome {
        challenge = nil
        let username = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !username.isEmpty, !password.isEmpty else { return .password(.missing) }
        let secret: CognitoSRP.Secret
        do {
            secret = try CognitoSRP.start(random: random)
        } catch {
            return .password(.failed)
        }
        let started = await ask("InitiateAuth", [
            "AuthFlow": "USER_SRP_AUTH",
            "ClientId": clientId,
            "AuthParameters": ["USERNAME": username, "SRP_A": secret.srpA],
        ])
        guard case .reply(let reply, let date) = started else { return refused(started, at: .password) }
        guard reply["ChallengeName"] as? String == "PASSWORD_VERIFIER" else {
            return await following(reply, at: .password, userId: nil)
        }

        let parameters = reply["ChallengeParameters"] as? [String: Any] ?? [:]
        guard let userId = parameters["USER_ID_FOR_SRP"] as? String,
              let srpB = parameters["SRP_B"] as? String,
              let salt = parameters["SALT"] as? String,
              let secretBlock = parameters["SECRET_BLOCK"] as? String else {
            return .password(.failed)
        }
        // Cognito's clock, where its answer may be read, or else this phone's.
        let timestamp = CognitoSRP.timestamp(CognitoSRP.serverTime(date) ?? now())
        let signature: String
        do {
            signature = try CognitoSRP.proof(userPoolId: pool.id, userId: userId, password: password, secret: secret,
                                             srpB: srpB, salt: salt, secretBlock: secretBlock,
                                             timestamp: timestamp).signature
        } catch {
            return .password(.failed)
        }
        var body: [String: Any] = [
            "ChallengeName": "PASSWORD_VERIFIER",
            "ClientId": clientId,
            "ChallengeResponses": [
                "USERNAME": userId,
                "PASSWORD_CLAIM_SECRET_BLOCK": secretBlock,
                "TIMESTAMP": timestamp,
                "PASSWORD_CLAIM_SIGNATURE": signature,
            ],
        ]
        if let session = reply["Session"] as? String, !session.isEmpty {
            body["Session"] = session
        }
        let verified = await ask("RespondToAuthChallenge", body)
        guard case .reply(let answer, _) = verified else { return refused(verified, at: .password) }
        return await following(answer, at: .password, userId: userId)
    }

    /// The code from the authenticator app, for the sign-in that asked for it. A wrong code leaves
    /// that sign-in waiting for another; a sign-in that Cognito has ended starts again.
    public func sendCode(_ code: String) async -> PasswordSignInOutcome {
        guard let waiting = challenge else { return .password(.expired) }
        guard code.utf8.count == CodeEntry.length, code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            return .code(.wrongCode)
        }
        let answered = await ask("RespondToAuthChallenge", [
            "ChallengeName": "SOFTWARE_TOKEN_MFA",
            "ClientId": clientId,
            "Session": waiting.session,
            "ChallengeResponses": ["USERNAME": waiting.userId ?? NSNull(), "SOFTWARE_TOKEN_MFA_CODE": code] as [String: Any],
        ])
        guard case .reply(let reply, _) = answered else { return refused(answered, at: .code) }
        return await following(reply, at: .code, userId: waiting.userId)
    }

    // MARK: Cognito's user pool API

    enum Answer {
        /// A JSON object, and the Date header.
        case reply([String: Any], date: String?)
        /// An error of Cognito's, by name ("" if it did not say).
        case error(String)
        /// Nothing usable came back.
        case problem(SignInProblem)
    }

    /// One call: POST https://cognito-idp.{region}.amazonaws.com/ with the operation in a header,
    /// as Cognito's JSON protocol has it. No cookies, no cache.
    private func ask(_ operation: String, _ body: [String: Any]) async -> Answer {
        var request = URLRequest(url: pool.endpoint)
        request.httpMethod = "POST"
        request.setValue(CognitoUserPool.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(CognitoUserPool.targetPrefix + operation, forHTTPHeaderField: "X-Amz-Target")
        request.timeoutInterval = Self.timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes]) else {
            return .problem(.failed)
        }
        request.httpBody = data
        let reply: Data, response: HTTPURLResponse
        do {
            (reply, response) = try await http.send(request)
        } catch {
            return .problem(.network)
        }
        let object = try? JSONSerialization.jsonObject(with: reply)
        guard (200...299).contains(response.statusCode) else {
            return .error(Self.errorName(object as? [String: Any],
                                         header: response.value(forHTTPHeaderField: "X-Amzn-ErrorType")))
        }
        guard let object = object as? [String: Any] else { return .problem(.failed) }
        return .reply(object, date: response.value(forHTTPHeaderField: "Date"))
    }

    /// What Cognito's error answer is called, such as NotAuthorizedException; "" if it does not say.
    /// In the body, perhaps with a namespace, or in the header.
    static func errorName(_ reply: [String: Any]?, header: String?) -> String {
        let raw = reply?["__type"] as? String ?? header ?? ""
        let afterHash = raw.split(separator: "#", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        let name = afterHash.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let letters = name.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("a"..."z").contains($0) }
        return (1...64).contains(name.count) && letters ? name : ""
    }

    /// Where a refusal leaves the sign-in.
    private func refused(_ answer: Answer, at step: Step) -> PasswordSignInOutcome {
        let problem: SignInProblem
        switch answer {
        case .problem(let given):
            problem = given
        case .error(let name):
            guard let known = SignInProblem.of(name, at: step) else {
                challenge = nil
                return .elsewhere(challenge: "PASSWORD_RESET_REQUIRED")
            }
            problem = known
        case .reply:
            problem = .failed
        }
        if problem == .expired {
            challenge = nil
            return .password(.expired)
        }
        return step == .code ? .code(problem) : .password(problem)
    }

    /// What follows an answer: the code, the tokens, or a step for the AWS sign-in page.
    private func following(_ reply: [String: Any], at step: Step, userId: String?) async -> PasswordSignInOutcome {
        let failed: PasswordSignInOutcome = step == .code ? .code(.failed) : .password(.failed)
        if let result = reply["AuthenticationResult"] as? [String: Any] {
            guard let tokens = Self.tokens(from: result, now: now()) else { return failed }
            challenge = nil
            do {
                try await session.completeSignIn(tokens: tokens)
            } catch {
                // Not kept, so not signed in. Cognito's session for it is used up.
                return .password(.failed)
            }
            return .done
        }
        let name = (reply["ChallengeName"] as? String).flatMap(Self.challengeName) ?? ""
        if name == "SOFTWARE_TOKEN_MFA", let session = reply["Session"] as? String, !session.isEmpty {
            challenge = (session, userId)
            return .code(nil)
        }
        challenge = nil
        // A new password, an authenticator app to set up, or anything else this screen does not do.
        return name.isEmpty ? failed : .elsewhere(challenge: name)
    }

    /// /^[A-Z_]{1,40}$/: a name that is not one is not repeated.
    private static func challengeName(_ text: String) -> String? {
        let fine = (1...40).contains(text.unicodeScalars.count)
            && text.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || $0 == "_" }
        return fine ? text : nil
    }

    /// The tokens in an AuthenticationResult, if they are usable: an access token, a lifetime and
    /// the Bearer type, as the website checks them. The refresh token is kept, as the AWS sign-in
    /// page's is; the ID token is not wanted.
    static func tokens(from result: [String: Any], now: Date) -> Tokens? {
        guard let access = result["AccessToken"] as? String, !access.isEmpty,
              let lifetime = (result["ExpiresIn"] as? NSNumber)?.doubleValue, lifetime.isFinite, lifetime > 0,
              (result["TokenType"] as? String)?.lowercased() == "bearer" else {
            return nil
        }
        let refresh = (result["RefreshToken"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Tokens(accessToken: access, refreshToken: refresh, expiresAt: now.addingTimeInterval(lifetime))
    }
}
