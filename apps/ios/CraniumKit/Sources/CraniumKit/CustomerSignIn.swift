import Foundation

/// One sign-in for everybody (customer-core.js `signInEither`): the e-mail address and the password
/// go to the team's pool first, with the phone apps' client of it, and only if it says the address or
/// the password is wrong, to the customer pool, the same way. One submission tries each pool once at
/// most, and a refusal by both is the one "wrong e-mail address or password", whichever pool has the
/// account. "Forgot your password?" asks both pools too, one request each.
public enum OneSignIn {
    /// Whose account took the password.
    public enum Account: Equatable, Sendable { case team, customer }

    public typealias Attempt = @Sendable (_ email: String, _ password: String) async -> PasswordSignInOutcome

    /// The team's pool first, then the customer pool; either may be missing from the build.
    public static func first(team: Attempt?, customer: Attempt?, email: String, password: String) async
        -> (account: Account, outcome: PasswordSignInOutcome) {
        var refused: (Account, PasswordSignInOutcome)?
        for (account, attempt) in [(Account.team, team), (Account.customer, customer)] {
            guard let attempt else { continue }
            let outcome = await attempt(email, password)
            if outcome == .password(.wrongPassword) {
                refused = (account, outcome)
                continue
            }
            return (account, outcome)
        }
        return refused ?? (.customer, .password(.failed))
    }

    /// The flows as attempts: PasswordSignIn lowercases the address, as the team's names are kept.
    public static func first(team: PasswordSignIn?, customer: PasswordSignIn?, email: String, password: String) async
        -> (account: Account, outcome: PasswordSignInOutcome) {
        let attempt: @Sendable (PasswordSignIn) -> Attempt = { flow in { @Sendable in await flow.signIn(email: $0, password: $1) } }
        return await first(team: team.map(attempt), customer: customer.map(attempt), email: email, password: password)
    }

    /// The code of a reset: both pools, one request each. The team's pool hides unknown names and says
    /// a code went out, so its yes proves nothing and the customer pool is always asked as well.
    public static func forgotPassword(team: CustomerAccount?, customer: CustomerAccount?, email: String) async -> AccountResult<Bool> {
        await either([team, customer].compactMap { $0 }, stopAtFirst: false) { await $0.forgotPassword(email: email) }
    }

    /// The code and the new password: the team's pool first; a yes there settles it.
    public static func confirmForgotPassword(team: CustomerAccount?, customer: CustomerAccount?, email: String, code: String,
                                             password: String) async -> AccountResult<Bool> {
        await either([team, customer].compactMap { $0 }, stopAtFirst: true) {
            await $0.confirmForgotPassword(email: email, code: code, password: password)
        }
    }

    private static func either(_ accounts: [CustomerAccount], stopAtFirst: Bool,
                               _ call: (CustomerAccount) async -> AccountResult<Bool>) async -> AccountResult<Bool> {
        var problems: [AccountProblem] = []
        var ok = false
        for account in accounts {
            switch await call(account) {
            case .ok:
                ok = true
                if stopAtFirst { return .ok(true) }
            case .problem(let problem):
                // Asked of neither pool: an address left empty, a code too short.
                if problem == .missingEmail || problem == .shortCode { return .problem(problem) }
                problems.append(problem)
            }
        }
        return ok ? .ok(true) : .problem(plainest(problems))
    }

    /// Of the pools' refusals, the one to show: a specific one before "that code is not right", which is
    /// also what a pool says of an address it does not have (customer-core.js `plainestProblem`).
    public static func plainest(_ problems: [AccountProblem]) -> AccountProblem {
        let vague: Set<AccountProblem> = [.wrongCode, .failed, .sessionEnded]
        return problems.first { !vague.contains($0) } ?? problems.last ?? .failed
    }
}

/// The one sign-in screen (docs/mobile-apps.md, "Customers"), as the customer site's
/// (customer.js `signInControls`, `afterStep`): the e-mail address and the password (OneSignIn: the
/// team's pool, then the customer pool), then the code in six boxes if the account asks for one, or
/// a new password at a customer's first sign-in. A step this screen does not do goes, for a team
/// account, to the AWS sign-in page (the app's view does that); a customer has no such page, so the
/// screen points at "Forgot your password?". The view holds a password only until it hands it over.
@MainActor
public final class CustomerSignInModel: ObservableObject {
    public enum Step: Equatable, Sendable {
        case password
        case code
        case newPassword
        /// A step only a password reset gets past.
        case elsewhere
    }

    public enum Field: Hashable, Sendable {
        case email, password, code, newPassword
    }

    /// Where the keyboard should go; `serial` changes with every request.
    public struct FocusRequest: Equatable, Sendable {
        public let field: Field
        public let serial: Int
    }

    @Published public private(set) var step: Step = .password
    @Published public var email: String
    @Published public private(set) var digits = ""
    @Published public private(set) var busy = false
    /// What went wrong, in the site's words (SIGN_IN_WORDS, else ACCOUNT_WORDS).
    @Published public private(set) var problem: String?
    /// How many answers there have been, so that the same problem twice is said twice.
    @Published public private(set) var tries = 0
    @Published public private(set) var focus: FocusRequest
    /// Signed in: the tokens are kept in the customer's own session.
    @Published public private(set) var signedIn = false
    /// Why the screen is shown, if there is a why: "Your session has ended. …".
    public let lead: String?
    /// Whose account took the password (OneSignIn): nil until a pool has.
    @Published public private(set) var account: OneSignIn.Account?

    private let customerFlow: PasswordSignIn?
    private let teamFlow: PasswordSignIn?
    private(set) var pendingSubmission: Task<Void, Never>?

    /// The one sign-in screen: `team` is the team's pool (the app's own sign-in), `flow` the customer
    /// pool. Either is nil when the build lacks it; with neither, the screen says so.
    public init(flow: PasswordSignIn?, team: PasswordSignIn? = nil, email: String = "", lead: String? = nil) {
        customerFlow = flow
        teamFlow = team
        self.email = email
        self.lead = lead
        focus = FocusRequest(field: email.isEmpty ? .email : .password, serial: 0)
    }

    public var isSetUp: Bool { customerFlow != nil || teamFlow != nil }

    /// The flow of the account that took the password, for its code or its new password.
    private var flow: PasswordSignIn? { account == .team ? teamFlow : customerFlow }

    private func focus(on field: Field) {
        focus = FocusRequest(field: field, serial: focus.serial + 1)
    }

    public func submitPassword(_ password: String) async {
        guard isSetUp, step == .password, !busy, !signedIn else { return }
        busy = true
        problem = nil
        await teamFlow?.cancel()
        await customerFlow?.cancel()
        let answer = await OneSignIn.first(team: teamFlow, customer: customerFlow, email: email, password: password)
        account = answer.account
        after(answer.outcome)
    }

    @discardableResult
    public func editCode(_ text: String) -> String {
        guard step == .code, !busy, !signedIn else { return digits }
        let before = digits
        digits = CodeEntry.digits(before: before, after: text)
        if !CodeEntry.isComplete(before) && CodeEntry.isComplete(digits) {
            pendingSubmission = Task { await self.submitCode() }
        }
        return digits
    }

    public func submitCode() async {
        guard let flow, step == .code, !busy, !signedIn else { return }
        guard CodeEntry.isComplete(digits) else {
            problem = SignInProblem.shortCode.rawValue
            tries += 1
            focus(on: .code)
            return
        }
        busy = true
        problem = nil
        after(await flow.sendCode(digits))
    }

    /// A first sign-in's new password, typed twice: at least 10 characters, the same both times.
    public func submitNewPassword(_ password: String, again: String) async {
        guard let flow, step == .newPassword, !busy, !signedIn else { return }
        if let wrong = AccountProblem.ofNewPassword(password, again: again) {
            problem = wrong.rawValue
            tries += 1
            return
        }
        busy = true
        problem = nil
        after(await flow.sendNewPassword(password))
    }

    public func startOver() {
        guard step == .code || step == .newPassword || step == .elsewhere, !busy, !signedIn else { return }
        Task { [teamFlow, customerFlow] in
            await teamFlow?.cancel()
            await customerFlow?.cancel()
        }
        account = nil
        step = .password
        digits = ""
        problem = nil
        focus(on: .password)
    }

    /// The words of `problem`.
    public var problemWords: String? {
        guard let problem else { return nil }
        return SignInProblem(rawValue: problem)?.words ?? AccountProblem(rawValue: problem)?.words ?? SignInProblem.failed.words
    }

    private func after(_ outcome: PasswordSignInOutcome) {
        guard !signedIn else { return }
        tries += 1
        switch outcome {
        case .done:
            problem = nil
            signedIn = true
        case .code(let problem):
            let cleared = problem == nil || problem == .wrongCode || problem == .tooMany
            step = .code
            busy = false
            self.problem = problem?.rawValue
            if cleared {
                digits = ""
                focus(on: .code)
            }
        case .newPassword(let problem):
            step = .newPassword
            busy = false
            self.problem = problem?.rawValue
            focus(on: .newPassword)
        case .elsewhere:
            step = .elsewhere
            busy = false
            problem = nil
        case .password(let problem):
            step = .password
            busy = false
            self.problem = problem.rawValue
            digits = ""
            focus(on: email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .email : .password)
        }
    }
}

/// "Forgot your password?" (customer.js `forgotControls`): the address, then the code from the
/// e-mail with a new password, then done.
@MainActor
public final class ForgotPasswordModel: ObservableObject {
    public enum Step: Equatable, Sendable { case email, code, done }

    @Published public private(set) var step: Step = .email
    @Published public var email: String
    @Published public private(set) var digits = ""
    @Published public private(set) var busy = false
    @Published public private(set) var problem: AccountProblem?

    private let account: CustomerAccount?
    private let team: CustomerAccount?

    /// `team` is the team's pool, asked first (OneSignIn); `account` the customer pool.
    public init(account: CustomerAccount?, team: CustomerAccount? = nil, email: String = "") {
        self.account = account
        self.team = team
        self.email = email
    }

    public func submitEmail() async {
        guard account != nil || team != nil, step == .email, !busy else { return }
        busy = true
        problem = nil
        let result = await OneSignIn.forgotPassword(team: team, customer: account, email: email)
        busy = false
        if let problem = result.problem {
            self.problem = problem
        } else {
            step = .code
            digits = ""
        }
    }

    /// The six boxes: the code goes with the new password, so it is not sent by itself.
    @discardableResult
    public func editCode(_ text: String) -> String {
        guard step == .code, !busy else { return digits }
        digits = CodeEntry.digits(before: digits, after: text)
        problem = nil
        return digits
    }

    public func submitReset(password: String, again: String) async {
        guard account != nil || team != nil, step == .code, !busy else { return }
        let wrong = CodeEntry.isComplete(digits) ? AccountProblem.ofNewPassword(password, again: again) : .shortCode
        if let wrong {
            problem = wrong
            return
        }
        busy = true
        problem = nil
        let result = await OneSignIn.confirmForgotPassword(team: team, customer: account, email: email, code: digits, password: password)
        busy = false
        if let problem = result.problem {
            self.problem = problem
            if problem == .wrongCode { digits = "" }
        } else {
            step = .done
        }
    }

    /// "Send another code": back to the address.
    public func startOver() {
        guard !busy else { return }
        step = .email
        problem = nil
        digits = ""
    }
}
