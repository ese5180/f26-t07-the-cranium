import Foundation

/// A customer's sign-in screen (docs/mobile-apps.md, "Customers"), as the customer site's
/// (customer.js `signInControls`, `afterStep`): the e-mail address and the password, then the
/// code in six boxes if the customer turned two-step sign-in on, or a new password at the first
/// sign-in. There is no AWS sign-in page for customers: a step this screen does not do says so and
/// points at "Forgot your password?". The view holds a password only until it hands it over.
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

    private let flow: PasswordSignIn?
    private(set) var pendingSubmission: Task<Void, Never>?

    /// `flow` is nil when the build has no customer pool: the screen then says so.
    public init(flow: PasswordSignIn?, email: String = "", lead: String? = nil) {
        self.flow = flow
        self.email = email
        self.lead = lead
        focus = FocusRequest(field: email.isEmpty ? .email : .password, serial: 0)
    }

    public var isSetUp: Bool { flow != nil }

    private func focus(on field: Field) {
        focus = FocusRequest(field: field, serial: focus.serial + 1)
    }

    public func submitPassword(_ password: String) async {
        guard let flow, step == .password, !busy, !signedIn else { return }
        busy = true
        problem = nil
        after(await flow.signIn(email: email, password: password))
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
        Task { [flow] in await flow?.cancel() }
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

    public init(account: CustomerAccount?, email: String = "") {
        self.account = account
        self.email = email
    }

    public func submitEmail() async {
        guard let account, step == .email, !busy else { return }
        busy = true
        problem = nil
        let result = await account.forgotPassword(email: email)
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
        guard let account, step == .code, !busy else { return }
        let wrong = CodeEntry.isComplete(digits) ? AccountProblem.ofNewPassword(password, again: again) : .shortCode
        if let wrong {
            problem = wrong
            return
        }
        busy = true
        problem = nil
        let result = await account.confirmForgotPassword(email: email, code: digits, password: password)
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
