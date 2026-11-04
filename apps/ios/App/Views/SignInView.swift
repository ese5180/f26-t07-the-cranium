import CraniumKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The app's own sign-in, as the console's own sign-in page (views.js `signInView`, app.css `.gate`
/// and `.signin-*`), in the app's colours: the e-mail address and the password, then the code from
/// the authenticator app in six boxes, which goes in by itself at the sixth digit. A step that this
/// screen does not do (a new password, an authenticator app to set up) says why in one line, then
/// goes to the AWS sign-in page, as does the link at the foot.
///
/// The work is SignInModel's and PasswordSignIn's (CraniumKit). The password is in this view only
/// until it is sent for: the field is emptied at once, and nothing keeps it.
///
/// It ends by calling `onEnd` once: `.signedIn` (the tokens are kept), `.awsPage(reason:)` (open the
/// AWS sign-in page), or `.cancelled` (a sign-in again that was closed).
struct SignInScreen: View {
    @Environment(\.theme) private var theme
    @StateObject private var model: SignInModel
    private let again: Bool
    private let message: String?
    private let awsPageOpen: Bool
    private let onEnd: (SignInEnding) -> Void

    @State private var password = ""
    @FocusState private var field: SignInModel.Field?
    @FocusState private var codeFocused: Bool
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 40

    /// - Parameters:
    ///   - flow: the app's own sign-in; nil when the configuration names no user pool, and then the
    ///     screen has one button, for the AWS sign-in page.
    ///   - again: a sign-in again for a change: the address is `email`, which cannot be changed, and
    ///     the screen can be closed.
    ///   - email: the address to start with.
    ///   - message: what went wrong on the AWS sign-in page (AppModel's `signInMessage`).
    ///   - awsPageOpen: the AWS sign-in page is open, or its answer is on the way.
    init(flow: PasswordSignIn?, again: Bool = false, email: String? = nil, message: String? = nil,
         awsPageOpen: Bool = false, onEnd: @escaping (SignInEnding) -> Void) {
        _model = StateObject(wrappedValue: SignInModel(flow: flow, email: email, fixedEmail: again))
        self.again = again
        self.message = message
        self.awsPageOpen = awsPageOpen
        self.onEnd = onEnd
    }

    /// Nothing can be typed or sent.
    private var locked: Bool { model.busy || awsPageOpen }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                top
                VStack(alignment: .leading, spacing: 16) {
                    Text(title)
                        .font(.system(size: titleSize, weight: .bold))
                        .tracking(-0.022 * titleSize)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    lead
                    switch model.step {
                    case .password: model.hasOwnSignIn ? AnyView(passwordStep) : AnyView(awsPageOnly)
                    case .code: AnyView(codeStep)
                    case .leaving: AnyView(leaving)
                    }
                    if model.hasOwnSignIn && model.step != .leaving {
                        other
                    }
                }
            }
            // The website's column: 27rem at most.
            .frame(maxWidth: 432, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, again ? 12 : 32)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(theme.paper.ignoresSafeArea())
        .foregroundStyle(theme.ink)
        .interactiveDismissDisabled(model.busy)
        .task {
            // After the screen has settled, or the keyboard does not come up.
            try? await Task.sleep(nanoseconds: 350_000_000)
            focus(on: model.focus.field)
            #if DEBUG
            // Demo mode only (DemoData.swift): `-CraniumDemoPassword` goes on to the code step, for screenshots.
            if Demo.isOn, let demo = UserDefaults.standard.string(forKey: "CraniumDemoPassword"), model.step == .password {
                if !model.emailIsFixed { model.email = "vihaan@cranium.test" }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await model.submitPassword(demo)
            }
            #endif
        }
        .onChange(of: model.focus) { request in focus(on: request.field) }
        .onChange(of: model.tries) { _ in announceProblem() }
        .onChange(of: model.ending) { ending in
            guard let ending else { return }
            model.endingSeen()
            onEnd(ending)
        }
    }

    // MARK: The pieces

    private var title: String {
        switch model.step {
        case .leaving: return SignInWords.leaving
        case .code: return SignInWords.codeTitle
        case .password: return again ? SignInWords.againTitle : SignInWords.title
        }
    }

    @ViewBuilder private var lead: some View {
        switch model.step {
        case .code:
            (Text("Signing in as ") + Text(model.email.trimmingCharacters(in: .whitespacesAndNewlines)).fontWeight(.semibold) + Text("."))
                .leadStyle(theme)
        case .leaving:
            if let note = model.note { Text(note).leadStyle(theme) }
        case .password:
            Text(again ? SignInWords.againLead : SignInWords.lead).leadStyle(theme)
        }
    }

    /// The mark and the name above the sign-in, or Cancel above a sign-in again.
    @ViewBuilder private var top: some View {
        if again {
            HStack {
                Spacer()
                Button(SignInWords.cancel) { model.cancel() }
                    .consoleButton(.quiet)
                    .disabled(model.busy)
            }
            .padding(.bottom, 8)
        } else {
            HStack(spacing: 12) {
                SignInMark()
                    .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Cranium")
                        .font(.system(size: 22, weight: .bold))
                        .tracking(-0.6)
                    Text("Firmware console")
                        .font(Typeface.small)
                        .foregroundStyle(theme.ink3)
                }
            }
            .accessibilityElement(children: .combine)
            .padding(.bottom, 44)
        }
    }

    private var passwordStep: some View {
        let wrong = model.problem == .wrongPassword || model.problem == .missing
        return VStack(alignment: .leading, spacing: 18) {
            if let note = model.note {
                Notice(.warn, "lock", note)
            }
            if let message {
                Notice(.bad, "alert", message)
            }
            VStack(alignment: .leading, spacing: 6) {
                label(SignInWords.email)
                TextField("", text: $model.email)
                    .emailInput()
                    .focused($field, equals: .email)
                    .disabled(locked || model.emailIsFixed)
                    .onSubmit { field = .password }
                    .signInInput(theme, focused: field == .email, invalid: wrong,
                                 readOnly: locked || model.emailIsFixed)
                    .accessibilityLabel(SignInWords.email)
            }
            VStack(alignment: .leading, spacing: 6) {
                label(SignInWords.password)
                SecureField("", text: $password)
                    .passwordInput()
                    .focused($field, equals: .password)
                    .disabled(locked)
                    .onSubmit(submitPassword)
                    .signInInput(theme, focused: field == .password, invalid: wrong, readOnly: locked)
                    .accessibilityLabel(SignInWords.password)
            }
            problemLine
            HStack(spacing: 14) {
                primary(model.busy ? SignInWords.checking : SignInWords.next, action: submitPassword)
                quiet(SignInWords.forgot) { model.useAwsPage() }
            }
        }
        .padding(.top, 6)
    }

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                label(SignInWords.codeLabel)
                CodeBoxes(digits: model.digits, wrong: model.problem == .wrongCode, busy: model.busy,
                          focused: $codeFocused, onEdit: { model.editCode($0) })
                Text(SignInWords.codeHint)
                    .font(Typeface.small)
                    .foregroundStyle(theme.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
            problemLine
            HStack(spacing: 14) {
                primary(model.busy ? SignInWords.checking : SignInWords.signIn) {
                    Task { await model.submitCode() }
                }
                quiet(SignInWords.startAgain) { model.startOver() }
            }
        }
        .padding(.top, 6)
    }

    private var leaving: some View {
        ProgressView()
            .tint(theme.accent)
            .padding(.top, 6)
    }

    /// Without a user pool in the configuration: the AWS sign-in page only, as before.
    private var awsPageOnly: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let message {
                Notice(.bad, "alert", message)
            }
            primary(SignInWords.signIn) { model.useAwsPage() }
        }
        .padding(.top, 6)
    }

    /// "Use the AWS sign-in page", under a rule.
    private var other: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                model.useAwsPage()
            } label: {
                HStack(spacing: 7) {
                    Text(SignInWords.awsPage)
                    Image(systemName: Icon.symbol("arrow-right"))
                        .font(.footnote.weight(.semibold))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(theme.ink2)
            }
            .consoleButton(.quiet)
            .padding(.leading, -15)
            .disabled(locked)
            Text(SignInWords.awsPageNote)
                .font(Typeface.small)
                .foregroundStyle(theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) {
            Rectangle().fill(theme.line).frame(height: 1)
        }
    }

    /// What went wrong, in one line. A new one for every answer, so that the same words twice are
    /// noticed twice; VoiceOver hears them (announceProblem).
    @ViewBuilder private var problemLine: some View {
        if let problem = model.problem {
            Notice(.bad, "alert", problem.words)
                .id(model.tries)
                .transition(.opacity)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .accessibilityHidden(true)
    }

    /// The website's large primary button: 48 points high, 26 points of room either side.
    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if model.busy || awsPageOpen { ProgressView().tint(theme.onAccent) }
                Text(title)
            }
            .font(.body.weight(.semibold))
            .padding(.horizontal, 11)
            .frame(minHeight: 48)
        }
        .consoleButton(.primary)
        // While its request is on its way it only says so (the model sends nothing twice).
        .disabled(awsPageOpen)
    }

    private func quiet(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).foregroundStyle(theme.ink2)
        }
        .consoleButton(.quiet)
        .disabled(locked)
    }

    // MARK: What the controls do

    private func submitPassword() {
        guard !locked else { return }
        // Out of the screen at once. From here on only the sign-in holds it, until the proof of it
        // is made; nothing keeps it after that.
        let typed = password
        password = ""
        Task { await model.submitPassword(typed) }
    }

    private func focus(on target: SignInModel.Field) {
        switch target {
        case .code:
            field = nil
            codeFocused = true
        case .email where model.emailIsFixed:
            codeFocused = false
            field = .password
        case .email, .password:
            codeFocused = false
            field = target
        }
    }

    private func announceProblem() {
        #if canImport(UIKit)
        if let problem = model.problem {
            UIAccessibility.post(notification: .announcement, argument: problem.words)
        }
        #endif
    }
}

/// The console's mark (views.js `brandMark`): a rust dome cut with the grooves of a record.
private struct SignInMark: View {
    @Environment(\.theme) private var theme

    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width, geometry.size.height) / 32
            ZStack {
                Dome().fill(theme.accent)
                Grooves().stroke(theme.paper, lineWidth: 1.8 * scale)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    /// In the mark's own 32-by-32 square: M2 18a14 14 0 0 1 28 0v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z
    private struct Dome: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: 2, y: 18))
            path.addRelativeArc(center: CGPoint(x: 16, y: 18), radius: 14, startAngle: .degrees(180), delta: .degrees(180))
            path.addLine(to: CGPoint(x: 30, y: 27))
            path.addRelativeArc(center: CGPoint(x: 27, y: 27), radius: 3, startAngle: .degrees(0), delta: .degrees(90))
            path.addLine(to: CGPoint(x: 5, y: 30))
            path.addRelativeArc(center: CGPoint(x: 5, y: 27), radius: 3, startAngle: .degrees(90), delta: .degrees(90))
            path.closeSubpath()
            return path.fitted(to: rect)
        }
    }

    /// M7 30V18a9 9 0 0 1 18 0v12M12 30V18a4 4 0 0 1 8 0v12
    private struct Grooves: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            for (left, radius) in [(7.0, 9.0), (12.0, 4.0)] {
                path.move(to: CGPoint(x: left, y: 30))
                path.addLine(to: CGPoint(x: left, y: 18))
                path.addRelativeArc(center: CGPoint(x: 16, y: 18), radius: radius, startAngle: .degrees(180), delta: .degrees(180))
                path.addLine(to: CGPoint(x: left + 2 * radius, y: 30))
            }
            return path.fitted(to: rect)
        }
    }
}

private extension Path {
    /// From the mark's 32-by-32 square to `rect`, centred.
    func fitted(to rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 32
        let x = rect.minX + (rect.width - 32 * scale) / 2, y = rect.minY + (rect.height - 32 * scale) / 2
        return applying(CGAffineTransform(translationX: x, y: y).scaledBy(x: scale, y: scale))
    }
}

private extension Text {
    /// The website's `.gate-text`.
    func leadStyle(_ theme: Theme) -> some View {
        font(.body)
            .foregroundStyle(theme.ink2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private extension View {
    /// The website's `.signin-form .input`: 11 by 13 points of room, 17-point type, a 1-point rule
    /// that turns rust with the keyboard and red when wrong, the well's colour when read-only.
    func signInInput(_ theme: Theme, focused: Bool, invalid: Bool, readOnly: Bool) -> some View {
        font(.body)
            .foregroundStyle(readOnly ? theme.ink2 : theme.ink)
            .padding(.vertical, 11)
            .padding(.horizontal, 13)
            .background(readOnly ? theme.well : theme.surface, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(invalid ? theme.bad : (focused ? theme.accent : theme.lineField), lineWidth: focused ? 1.5 : 1)
            }
    }

    /// The e-mail field: the username for the Passwords app, the e-mail keyboard, nothing changed.
    @ViewBuilder func emailInput() -> some View {
        #if os(iOS)
        self.textContentType(.username)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.next)
        #else
        self.autocorrectionDisabled().submitLabel(.next)
        #endif
    }

    /// The password field: the password for the Passwords app.
    @ViewBuilder func passwordInput() -> some View {
        #if os(iOS)
        self.textContentType(.password)
            .submitLabel(.go)
        #else
        self.submitLabel(.go)
        #endif
    }
}
