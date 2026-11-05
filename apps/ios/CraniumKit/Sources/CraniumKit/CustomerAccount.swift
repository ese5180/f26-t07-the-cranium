import Foundation

/// What went wrong with a customer's own account at Cognito, in the customer site's words
/// (customer-core.js, `ACCOUNT_WORDS`). Never Cognito's own message.
public enum AccountProblem: String, CaseIterable, Equatable, Sendable {
    case wrongPassword = "wrong-password"
    case weakPassword = "weak-password"
    case tooShort = "too-short"
    case mismatch
    case missingEmail = "missing-email"
    case wrongCode = "wrong-code"
    case expiredCode = "expired-code"
    case shortCode = "short-code"
    case tooMany = "too-many"
    case notYet = "not-yet"
    case network
    case sessionEnded = "session-ended"
    case failed

    public var words: String {
        switch self {
        case .wrongPassword: return "The current password is not right."
        case .weakPassword: return "That password is not accepted. Choose one of at least 10 characters."
        case .tooShort: return "A password needs at least 10 characters."
        case .mismatch: return "The two new passwords are not the same."
        case .missingEmail: return "Type the e-mail address you sign in with."
        case .wrongCode: return "That code is not right. Check it and try again."
        case .expiredCode: return "That code has expired. Ask for a new one."
        case .shortCode: return "Type all six digits of the code."
        case .tooMany: return "Too many tries. Wait a few minutes, then try again."
        case .notYet: return "This account still has the temporary password from its invitation. Sign in with that one first."
        case .network: return "The sign-in service could not be reached. Check the connection and try again."
        case .sessionEnded: return "Your session has ended. Sign in again, then try once more."
        case .failed: return "That did not work. Try again in a moment."
        }
    }

    /// What an error of Cognito's means here, at a step: change, forgot, reset, profile or
    /// authenticator. The site's `accountProblem`.
    public static func of(_ name: String, step: String = "") -> AccountProblem {
        switch name {
        case "NotAuthorizedException":
            if step == "change" { return .wrongPassword }
            if step == "forgot" { return .notYet }
            return .sessionEnded
        case "InvalidPasswordException":
            return .weakPassword
        case "CodeMismatchException", "EnableSoftwareTokenMFAException":
            return .wrongCode
        case "ExpiredCodeException":
            return .expiredCode
        case "LimitExceededException", "TooManyRequestsException", "TooManyFailedAttemptsException":
            return .tooMany
        default:
            return .failed
        }
    }

    /// A new password as it was typed twice: nil if it will do. The site's `passwordProblem`.
    public static func ofNewPassword(_ password: String, again: String) -> AccountProblem? {
        if password.count < CustomerAccount.passwordMinimum { return .tooShort }
        if password != again { return .mismatch }
        return nil
    }
}

/// How one of the account's calls ended.
public enum AccountResult<Value: Equatable & Sendable>: Equatable, Sendable {
    case ok(Value)
    case problem(AccountProblem)

    public var problem: AccountProblem? {
        if case .problem(let problem) = self { return problem }
        return nil
    }
}

/// What a customer's account says about itself (GetUser).
public struct AccountProfile: Equatable, Sendable {
    public let email: String
    public let name: String
    /// Whether a sign-in asks for a code from an authenticator app.
    public let authenticator: Bool
}

/// A customer's own account at Cognito (customer-core.js, `createAccount`): the calls a signed-in
/// customer makes with their own access token, and the reset of a forgotten password, which needs
/// none. Cognito's answer is the one that counts.
public final class CustomerAccount: Sendable {
    public static let passwordMinimum = 10

    private let pool: CognitoUserPool
    private let clientId: String
    private let http: HTTPClient
    private let accessToken: @Sendable () async -> String?

    /// `accessToken` is the customer's (their `AuthSession`), never an admin's.
    public init(config: CustomerConfig, http: HTTPClient, accessToken: @escaping @Sendable () async -> String?) {
        pool = config.pool
        clientId = config.clientId
        self.http = http
        self.accessToken = accessToken
    }

    private func ask(_ operation: String, _ body: [String: Any]) async -> CognitoUserPoolAPI.Answer {
        guard let request = try? CognitoUserPoolAPI.request(pool, operation, body) else { return .unreadable }
        return await CognitoUserPoolAPI.send(http, request)
    }

    private static func problem(_ answer: CognitoUserPoolAPI.Answer, step: String) -> AccountProblem {
        switch answer {
        case .error(let name): return AccountProblem.of(name, step: step)
        case .network: return .network
        case .unreadable, .reply: return .failed
        }
    }

    /// One call with the access token: the reply's object, or why not.
    private func withToken(_ operation: String, _ body: [String: Any] = [:], step: String) async -> Result<Data, AccountProblemError> {
        guard let token = await accessToken() else { return .failure(AccountProblemError(.sessionEnded)) }
        var full = body
        full["AccessToken"] = token
        let answer = await ask(operation, full)
        if case .reply(let data, _) = answer { return .success(data) }
        return .failure(AccountProblemError(Self.problem(answer, step: step)))
    }

    /// The address, the name, and whether sign-in asks for a code.
    public func profile() async -> AccountResult<AccountProfile> {
        switch await withToken("GetUser", step: "profile") {
        case .failure(let error): return .problem(error.problem)
        case .success(let data):
            let reply = CognitoUserPoolAPI.object(data)
            let attributes = reply["UserAttributes"] as? [[String: Any]] ?? []
            func value(_ name: String) -> String {
                attributes.first { $0["Name"] as? String == name }?["Value"] as? String ?? ""
            }
            let methods = reply["UserMFASettingList"] as? [String] ?? []
            return .ok(AccountProfile(email: String(value("email").prefix(320)), name: CustomerRead.label(value("name")),
                                      authenticator: methods.contains("SOFTWARE_TOKEN_MFA")))
        }
    }

    public func changePassword(current: String, next: String) async -> AccountResult<Bool> {
        guard !current.isEmpty else { return .problem(.wrongPassword) }
        switch await withToken("ChangePassword", ["PreviousPassword": current, "ProposedPassword": next], step: "change") {
        case .failure(let error): return .problem(error.problem)
        case .success: return .ok(true)
        }
    }

    /// The secret of a new authenticator app: base32, 16 to 128 characters.
    public func startAuthenticator() async -> AccountResult<String> {
        switch await withToken("AssociateSoftwareToken", step: "authenticator") {
        case .failure(let error): return .problem(error.problem)
        case .success(let data):
            let secret = CognitoUserPoolAPI.object(data)["SecretCode"] as? String ?? ""
            return Self.isSecret(secret) ? .ok(secret) : .problem(.failed)
        }
    }

    /// The first code from the new authenticator app: once it is right, sign-in asks for a code.
    public func confirmAuthenticator(code: String) async -> AccountResult<Bool> {
        guard Self.isCode(code) else { return .problem(.shortCode) }
        switch await withToken("VerifySoftwareToken", ["UserCode": code, "FriendlyDeviceName": "Cranium"], step: "authenticator") {
        case .failure(let error): return .problem(error.problem)
        case .success(let data):
            guard CognitoUserPoolAPI.object(data)["Status"] as? String == "SUCCESS" else { return .problem(.wrongCode) }
        }
        return await setAuthenticator(on: true)
    }

    public func stopAuthenticator() async -> AccountResult<Bool> {
        await setAuthenticator(on: false)
    }

    private func setAuthenticator(on: Bool) async -> AccountResult<Bool> {
        switch await withToken("SetUserMFAPreference", ["SoftwareTokenMfaSettings": ["Enabled": on, "PreferredMfa": on]],
                               step: "authenticator") {
        case .failure(let error): return .problem(error.problem)
        case .success: return .ok(true)
        }
    }

    /// Asks for the code of a password reset. Cognito answers alike whether or not the address has
    /// an account, and so does the screen.
    public func forgotPassword(email: String) async -> AccountResult<Bool> {
        let username = Self.username(email)
        guard !username.isEmpty else { return .problem(.missingEmail) }
        let answer = await ask("ForgotPassword", ["ClientId": clientId, "Username": username])
        if case .reply = answer { return .ok(true) }
        return .problem(Self.problem(answer, step: "forgot"))
    }

    public func confirmForgotPassword(email: String, code: String, password: String) async -> AccountResult<Bool> {
        guard Self.isCode(code) else { return .problem(.shortCode) }
        let answer = await ask("ConfirmForgotPassword", [
            "ClientId": clientId, "Username": Self.username(email), "ConfirmationCode": code, "Password": password,
        ])
        if case .reply = answer { return .ok(true) }
        return .problem(Self.problem(answer, step: "reset"))
    }

    static func username(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func isCode(_ code: String) -> Bool {
        code.utf8.count == 6 && code.utf8.allSatisfy { (48...57).contains($0) }
    }

    /// /^[A-Z2-7]{16,128}$/
    static func isSecret(_ text: String) -> Bool {
        (16...128).contains(text.utf8.count) && text.utf8.allSatisfy { (65...90).contains($0) || (50...55).contains($0) }
    }

    /// The secret of an authenticator app in groups of four, as people copy it by hand; "" if it is not one.
    public static func groupSecret(_ secret: String) -> String {
        guard isSecret(secret) else { return "" }
        var groups: [String] = []
        var rest = Substring(secret)
        while !rest.isEmpty {
            groups.append(String(rest.prefix(4)))
            rest = rest.dropFirst(4)
        }
        return groups.joined(separator: " ")
    }

    /// The address that opens an authenticator app on this phone with the account filled in.
    public static func otpauthURI(secret: String, email: String) -> String? {
        guard isSecret(secret) else { return nil }
        let account = encodeURIComponent("Cranium:\(String(email.prefix(254)))")
        return "otpauth://totp/\(account)?secret=\(secret)&issuer=Cranium"
    }

    /// JavaScript's encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is encoded.
    static func encodeURIComponent(_ text: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

/// An `AccountProblem` as an error, inside `CustomerAccount`.
struct AccountProblemError: Error {
    let problem: AccountProblem
    init(_ problem: AccountProblem) { self.problem = problem }
}
