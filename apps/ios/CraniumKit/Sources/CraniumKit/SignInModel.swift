import Foundation

/// The code from the authenticator app as the six boxes hold it. The screen has one hidden text
/// field (number pad, one-time code) behind six boxes; this says what that field's text becomes.
/// The website's `enterCode` and `codeComplete`, for one field instead of six.
public enum CodeEntry {
    public static let length = 6

    /// Only digits count, at most six. A whole code that arrives on top of what was there (pasted,
    /// or filled in from the Passwords app) takes the place of it, with or without a space in the
    /// middle; a digit typed into six full boxes is not taken.
    public static func digits(before: String, after: String) -> String {
        let all = only(after)
        if all.count <= length { return all }
        // What arrived: the text between what stayed the same at the start and at the end.
        let old = Array(before), new = Array(after)
        var start = 0
        while start < old.count, start < new.count, old[start] == new[start] { start += 1 }
        var end = 0
        while end < old.count - start, end < new.count - start, old[old.count - 1 - end] == new[new.count - 1 - end] {
            end += 1
        }
        let arrived = only(String(new[start..<(new.count - end)]))
        if arrived.count >= length { return String(arrived.prefix(length)) }
        // Fewer digits: into the boxes that are free, as far as they go; full boxes keep theirs.
        let kept = only(before)
        return kept.count >= length ? String(kept.prefix(length)) : String(all.prefix(length))
    }

    /// Whether every box holds a digit.
    public static func isComplete(_ digits: String) -> Bool {
        digits.count == length && only(digits) == digits
    }

    /// The ASCII digits of `text`: not "٣" or "３", as the website's \D has it.
    static func only(_ text: String) -> String {
        String(text.unicodeScalars.filter { ("0"..."9").contains($0) }.map(Character.init))
    }
}

/// How a sign-in screen ends.
public enum SignInEnding: Equatable, Sendable {
    /// Signed in: the tokens are kept.
    case signedIn
    /// Go to the AWS sign-in page (the managed login, with PKCE), with the one line that says why,
    /// if there is a why: a step this screen does not do.
    case awsPage(reason: String?)
    /// The person closed a sign-in again for a change.
    case cancelled
}

/// The words of the sign-in screen, as on the website (views.js, `signInView`; app.js).
public enum SignInWords {
    public static let title = "Sign in"
    public static let againTitle = "Sign in again"
    public static let codeTitle = "Enter the code"
    public static let lead = "With your e-mail address, your password and the code from your authenticator app."
    public static let againLead = "A change from the phone needs a sign-in in the last 15 minutes: your password and the code from your authenticator app."
    public static let email = "E-mail address"
    public static let password = "Password"
    public static let next = "Continue"
    public static let signIn = "Sign in"
    public static let checking = "Checking…"
    public static let forgot = "Forgot your password?"
    public static let startAgain = "Start again"
    public static let codeLabel = "Code from your authenticator app"
    public static let codeHint = "The six digits it shows now. The code goes in by itself once the last digit is typed."
    /// What VoiceOver says for the six boxes, which it hears as one field.
    public static let codeField = "Code, 6 digits"
    public static let awsPage = "Use the AWS sign-in page"
    public static let awsPageNote = "The same account and the same code, on Amazon’s page."
    public static let leaving = "Taking you to the AWS sign-in page…"
    public static let cancel = "Cancel"

    /// "Signing in as …." on the step of the code.
    public static func signingInAs(_ email: String) -> String {
        "Signing in as \(email)."
    }

    /// Why the AWS sign-in page: a step that this screen does not do is said; the name of any
    /// other is not. The website's `ELSEWHERE_WORDS`.
    public static func elsewhere(_ challenge: String) -> String {
        switch challenge {
        case "NEW_PASSWORD_REQUIRED": return "Your account needs a new password first, and the AWS sign-in page asks for it."
        case "MFA_SETUP": return "Your account needs an authenticator app first, and the AWS sign-in page sets one up."
        case "PASSWORD_RESET_REQUIRED": return "Your password has to be reset first."
        default: return "Your account needs a step that only that page does."
        }
    }
}

/// The state of the sign-in screen, and what each control does: the website's app.js
/// (`submitPassword`, `submitCode`, `changeCode`, `afterStep`, `startOver`, `toAwsPage`) for a
/// SwiftUI view. The view holds the password only until it hands it to `submitPassword`; nothing
/// here keeps it.
@MainActor
public final class SignInModel: ObservableObject {
    public enum Step: Equatable, Sendable {
        case password
        case code
        /// On the way to the AWS sign-in page, saying why.
        case leaving
    }

    public enum Field: Hashable, Sendable {
        case email, password, code
    }

    /// Where the keyboard should go. `serial` changes with every request, so that the view hears a
    /// request for the field it is already in.
    public struct FocusRequest: Equatable, Sendable {
        public let field: Field
        public let serial: Int
    }

    @Published public private(set) var step: Step = .password
    @Published public var email: String
    /// The code so far: at most six ASCII digits.
    @Published public private(set) var digits = ""
    /// A request to Cognito is on its way: the fields are read-only and the button says so.
    @Published public private(set) var busy = false
    @Published public private(set) var problem: SignInProblem?
    /// How many answers there have been, so that the same problem twice is said twice.
    @Published public private(set) var tries = 0
    /// Why the AWS sign-in page: one line, kept after coming back from it.
    @Published public private(set) var note: String?
    @Published public private(set) var focus: FocusRequest
    /// How the screen ended; the view acts on it, then calls `endingSeen()`.
    @Published public private(set) var ending: SignInEnding?

    /// The e-mail address is the signed-in person's and cannot be changed (a sign-in again).
    public let emailIsFixed: Bool
    /// False when the configuration names no user pool: the AWS sign-in page is the only way.
    public var hasOwnSignIn: Bool { flow != nil }

    private let flow: PasswordSignIn?
    private let readingTime: TimeInterval
    /// The submission the sixth digit started, for the tests to wait on.
    private(set) var pendingSubmission: Task<Void, Never>?

    /// `email`, when given for a sign-in again, is fixed. `readingTime` is how long the reason for
    /// the AWS sign-in page stays on screen before it opens.
    public init(flow: PasswordSignIn?, email: String? = nil, fixedEmail: Bool = false, readingTime: TimeInterval = 2) {
        self.flow = flow
        let known = email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.email = known
        emailIsFixed = fixedEmail && !known.isEmpty
        self.readingTime = max(0, readingTime)
        focus = FocusRequest(field: emailIsFixed || !known.isEmpty ? .password : .email, serial: 0)
    }

    private func focus(on field: Field) {
        focus = FocusRequest(field: field, serial: focus.serial + 1)
    }

    /// The e-mail address and the password: the start of USER_SRP_AUTH.
    public func submitPassword(_ password: String) async {
        guard let flow, step == .password, !busy, ending == nil else { return }
        busy = true
        problem = nil
        note = nil
        let outcome = await flow.signIn(email: email, password: password)
        after(outcome)
    }

    /// What the hidden code field now holds. Returns the digits, which the field shows from then
    /// on. The sixth digit sends the code, once.
    @discardableResult
    public func editCode(_ text: String) -> String {
        guard step == .code, !busy, ending == nil else { return digits }
        let before = digits
        digits = CodeEntry.digits(before: before, after: text)
        if !CodeEntry.isComplete(before) && CodeEntry.isComplete(digits) {
            pendingSubmission = Task { await self.submitCode() }
        }
        return digits
    }

    /// The code, from the button or by itself at the sixth digit.
    public func submitCode() async {
        guard let flow, step == .code, !busy, ending == nil else { return }
        guard CodeEntry.isComplete(digits) else {
            problem = .shortCode
            tries += 1
            focus(on: .code)
            return
        }
        busy = true
        problem = nil
        let outcome = await flow.sendCode(digits)
        after(outcome)
    }

    /// Back to the password, dropping the sign-in that waits for its code.
    public func startOver() {
        guard step == .code, !busy, ending == nil else { return }
        Task { [flow] in await flow?.cancel() }
        step = .password
        digits = ""
        problem = nil
        focus(on: .password)
    }

    /// "Use the AWS sign-in page" and "Forgot your password?".
    public func useAwsPage() {
        guard step != .leaving, ending == nil else { return }
        leave(reason: nil)
    }

    /// A sign-in again that the person closed.
    public func cancel() {
        guard ending == nil else { return }
        Task { [flow] in await flow?.cancel() }
        busy = false
        ending = .cancelled
    }

    /// The view has acted on `ending`. After the AWS sign-in page the screen is the password step
    /// again, with the reason still said, should the person come back without signing in.
    public func endingSeen() {
        guard let ending else { return }
        self.ending = nil
        if case .awsPage = ending {
            step = .password
            busy = false
            digits = ""
            problem = nil
        }
    }

    /// Where an answer of Cognito leaves the screen.
    private func after(_ outcome: PasswordSignInOutcome) {
        // The screen was left meanwhile.
        guard ending == nil else { return }
        tries += 1
        switch outcome {
        case .done:
            // Busy until the screen goes: nothing more to send.
            problem = nil
            ending = .signedIn
        case .elsewhere(let challenge):
            busy = false
            leave(reason: SignInWords.elsewhere(challenge))
        case .code(let problem):
            // A wrong code, or one given too often, is cleared for the next; a code that did not
            // get through is kept to be sent again.
            let cleared = problem == nil || problem == .wrongCode || problem == .tooMany
            step = .code
            busy = false
            self.problem = problem
            if cleared {
                digits = ""
                focus(on: .code)
            }
        case .password(let problem):
            step = .password
            busy = false
            self.problem = problem
            digits = ""
            focus(on: email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .email : .password)
        }
    }

    /// To the AWS sign-in page: at once, or after the reason has been on screen for a moment.
    private func leave(reason: String?) {
        Task { [flow] in await flow?.cancel() }
        note = reason
        problem = nil
        step = .leaving
        guard let reason, readingTime > 0 else {
            ending = .awsPage(reason: reason)
            return
        }
        let wait = UInt64(readingTime * 1_000_000_000)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: wait)
            guard let self, self.step == .leaving, self.ending == nil else { return }
            self.ending = .awsPage(reason: reason)
        }
    }
}
