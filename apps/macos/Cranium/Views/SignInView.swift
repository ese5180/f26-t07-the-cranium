import CraniumKit
import SwiftUI

// MARK: Which sign-in

/// The two sign-ins: the team's console, and a customer's. One login for everyone (the team pool with
/// Admin, Member and Customer groups) will replace this: then `SignInSide`, `SideSwitch` and the
/// customer's form go, and the gate shows `TeamSignIn` alone. Nothing else in the app knows of the switch.
enum SignInSide: String, CaseIterable, Identifiable {
    case team
    case customer

    var id: String { rawValue }

    var title: String {
        switch self {
        case .team: return "Team"
        case .customer: return "Customer"
        }
    }

    /// Under the name, as each site has it: the console's, and the customer site's gate (customer-views.js).
    var subtitle: String {
        switch self {
        case .team: return "Firmware console"
        case .customer: return CustomerWords.yourStudio
        }
    }

    /// The customer side's gate (CustomerModel), for this side.
    init(_ gate: CustomerModel.Gate, customerSetUp: Bool) {
        self = !customerSetUp || gate == .adminSignIn ? .team : .customer
    }
}

private struct SideSwitch: View {
    @Binding var side: SignInSide

    var body: some View {
        Picker("Sign in as", selection: $side) {
            ForEach(SignInSide.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }
}

// MARK: The gate

/// Signed out: a compact card in the middle of the window, with the mark, which sign-in, and its form.
/// The work is SignInModel's, CustomerSignInModel's and PasswordSignIn's (CraniumKit), as on the iPhone.
struct GateView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel

    private var customerSetUp: Bool { customer.stage != .notSetUp }
    private var side: SignInSide { SignInSide(customer.gate, customerSetUp: customerSetUp) }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .center) {
                Brand(subtitle: side.subtitle)
                Spacer(minLength: 16)
                if customerSetUp {
                    SideSwitch(side: Binding(get: { side }, set: { customer.gate = $0 == .team ? .adminSignIn : .signIn }))
                }
            }
            Divider()
            Group {
                switch side {
                case .team:
                    TeamSignIn(flow: app.passwordSignIn, message: app.signInMessage, awsPageOpen: app.signingIn) { ending in
                        switch ending {
                        case .signedIn:
                            Task {
                                await app.signedInHere()
                                customer.openAdminMode()
                            }
                        case .awsPage:
                            Task {
                                await app.signIn()
                                if app.stage == .signedIn { customer.openAdminMode() }
                            }
                        case .cancelled:
                            break
                        }
                    }
                    .id("team")
                case .customer:
                    if customer.gate == .forgot {
                        ForgotPasswordForm(account: customer.account, email: customer.lastEmail) { customer.gate = .signIn }
                    } else {
                        CustomerSignIn(flow: customer.passwordSignIn, email: customer.lastEmail, lead: customer.signInLead)
                            .id("customer")
                    }
                }
            }
        }
        .padding(28)
        .frame(width: 420)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.12), radius: 18, y: 6)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: The fields

/// A labelled text field in the Mac's own style: the label above, a rounded field with its focus ring.
private struct Field<Input: View>: View {
    let label: String
    let input: Input

    init(_ label: String, @ViewBuilder input: () -> Input) {
        self.label = label
        self.input = input()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.callout.weight(.medium))
            input.textFieldStyle(.roundedBorder).controlSize(.large)
        }
    }
}

private struct Problem: View {
    let text: String?
    let tries: Int

    var body: some View {
        if let text {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .id(tries)
        }
    }
}

// MARK: The team

/// The team's sign-in: the console's own page as a Mac form (e-mail and password, then the code in one
/// field), "Forgot your password?" and "Use the AWS sign-in page" both to the AWS page, as on the iPhone.
struct TeamSignIn: View {
    @StateObject private var model: SignInModel
    private let message: String?
    private let awsPageOpen: Bool
    private let again: Bool
    private let onEnd: (SignInEnding) -> Void
    @State private var password = ""
    @FocusState private var field: SignInModel.Field?

    init(flow: PasswordSignIn?, again: Bool = false, email: String? = nil, message: String? = nil, awsPageOpen: Bool = false,
         onEnd: @escaping (SignInEnding) -> Void) {
        _model = StateObject(wrappedValue: SignInModel(flow: flow, email: email, fixedEmail: again))
        self.again = again
        self.message = message
        self.awsPageOpen = awsPageOpen
        self.onEnd = onEnd
    }

    private var locked: Bool { model.busy || awsPageOpen }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.title2.weight(.semibold))
                if !lead.isEmpty {
                    Text(lead).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let note = model.note {
                Label(note, systemImage: "lock").foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if let message, model.step == .password {
                Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            switch model.step {
            case .password where model.hasOwnSignIn:
                Field(SignInWords.email) {
                    TextField("name@example.com", text: $model.email)
                        .textContentType(.username)
                        .focused($field, equals: .email)
                        .disabled(locked || model.emailIsFixed)
                        .onSubmit { field = .password }
                }
                Field(SignInWords.password) {
                    SecureField("", text: $password)
                        .textContentType(.password)
                        .focused($field, equals: .password)
                        .disabled(locked)
                        .onSubmit(submitPassword)
                }
                Problem(text: model.problem?.words, tries: model.tries)
                HStack {
                    Button(SignInWords.forgot) { model.useAwsPage() }
                        .buttonStyle(.link)
                        .disabled(locked)
                    Spacer()
                    if again { Button(SignInWords.cancel) { model.cancel() }.keyboardShortcut(.cancelAction) }
                    Button(model.busy ? SignInWords.checking : SignInWords.next, action: submitPassword)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                        .disabled(locked)
                }
            case .password:
                // Without a user pool in the configuration: the AWS sign-in page only.
                HStack {
                    Spacer()
                    Button(SignInWords.signIn) { model.useAwsPage() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                        .disabled(locked)
                }
            case .code:
                Field(SignInWords.codeLabel) {
                    TextField("123456", text: Binding(get: { model.digits }, set: { _ = model.editCode($0) }))
                        .textContentType(.oneTimeCode)
                        .font(.title3.monospacedDigit())
                        .focused($field, equals: .code)
                        .disabled(locked)
                        .onSubmit { Task { await model.submitCode() } }
                        .accessibilityLabel(SignInWords.codeField)
                }
                Text(SignInWords.codeHint).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Problem(text: model.problem?.words, tries: model.tries)
                HStack {
                    Button(SignInWords.startAgain) { model.startOver() }
                        .disabled(model.busy)
                    Spacer()
                    Button(model.busy ? SignInWords.checking : SignInWords.signIn) { Task { await model.submitCode() } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .keyboardShortcut(.defaultAction)
                        .disabled(locked || !CodeEntry.isComplete(model.digits))
                }
            case .leaving:
                ProgressView().frame(maxWidth: .infinity)
            }
            if model.hasOwnSignIn && model.step != .leaving {
                Divider()
                VStack(alignment: .leading, spacing: 2) {
                    Button(SignInWords.awsPage) { model.useAwsPage() }
                        .buttonStyle(.link)
                        .disabled(locked)
                    Text(SignInWords.awsPageNote).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear { field = model.focus.field }
        .onChange(of: model.focus) { request in field = request.field }
        .onChange(of: model.ending) { ending in
            guard let ending else { return }
            model.endingSeen()
            onEnd(ending)
        }
    }

    private var title: String {
        switch model.step {
        case .leaving: return SignInWords.leaving
        case .code: return SignInWords.codeTitle
        case .password: return again ? SignInWords.againTitle : SignInWords.title
        }
    }

    private var lead: String {
        switch model.step {
        case .code: return "Signing in as \(model.email.trimmingCharacters(in: .whitespacesAndNewlines))."
        case .leaving: return ""
        case .password:
            return again ? "A change from the app needs a sign-in in the last 15 minutes: your password and the code from your authenticator app."
                         : SignInWords.lead
        }
    }

    private func submitPassword() {
        let typed = password
        // Nothing keeps the password: the field is emptied as it is sent.
        password = ""
        Task { await model.submitPassword(typed) }
    }
}

// MARK: A customer

/// A customer's sign-in: e-mail and password, then the code if two-step sign-in is on, or a new password
/// the first time. No AWS page for customers; "Forgot your password?" resets it by e-mail, as the site does.
struct CustomerSignIn: View {
    @EnvironmentObject private var customer: CustomerModel
    @StateObject private var model: CustomerSignInModel
    @State private var password = ""
    @State private var newPassword = ""
    @State private var again = ""
    @FocusState private var field: CustomerSignInModel.Field?

    init(flow: PasswordSignIn?, email: String, lead: String?) {
        _model = StateObject(wrappedValue: CustomerSignInModel(flow: flow, email: email, lead: lead))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(CustomerWords.signInTitle).font(.title2.weight(.semibold))
            if let lead = model.lead {
                Label(lead, systemImage: "info.circle").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !model.isSetUp {
                Text("This build has no customer sign-in.").foregroundStyle(.secondary)
            } else {
                switch model.step {
                case .password:
                    Field(SignInWords.email) {
                        TextField("name@example.com", text: $model.email)
                            .textContentType(.username)
                            .focused($field, equals: .email)
                            .onSubmit { field = .password }
                    }
                    Field(SignInWords.password) {
                        SecureField("", text: $password)
                            .textContentType(.password)
                            .focused($field, equals: .password)
                            .onSubmit(submitPassword)
                    }
                case .code:
                    Field(SignInWords.codeLabel) {
                        TextField("123456", text: Binding(get: { model.digits }, set: { _ = model.editCode($0) }))
                            .textContentType(.oneTimeCode)
                            .font(.title3.monospacedDigit())
                            .focused($field, equals: .code)
                            .onSubmit { Task { await model.submitCode() } }
                    }
                case .newPassword:
                    Field("A new password") {
                        SecureField("", text: $newPassword).focused($field, equals: .newPassword)
                    }
                    Field("The new password again") {
                        SecureField("", text: $again).onSubmit(submitNewPassword)
                    }
                case .elsewhere:
                    EmptyView()
                }
                Problem(text: model.problem, tries: model.tries)
                HStack {
                    Button(CustomerWords.forgot) {
                        customer.lastEmail = model.email
                        customer.gate = .forgot
                    }
                    .buttonStyle(.link)
                    Spacer()
                    if model.step != .password {
                        Button(SignInWords.startAgain) { model.startOver() }.disabled(model.busy)
                    }
                    primary
                }
            }
        }
        .onAppear { field = model.focus.field }
        .onChange(of: model.focus) { request in field = request.field }
        .onChange(of: model.signedIn) { signedIn in
            guard signedIn else { return }
            customer.lastEmail = model.email
            Task { await customer.signedInHere() }
        }
    }

    @ViewBuilder private var primary: some View {
        switch model.step {
        case .password:
            Button(model.busy ? SignInWords.checking : SignInWords.next, action: submitPassword)
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction).disabled(model.busy)
        case .code:
            Button(SignInWords.signIn) { Task { await model.submitCode() } }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction).disabled(model.busy || !CodeEntry.isComplete(model.digits))
        case .newPassword:
            Button(SignInWords.signIn, action: submitNewPassword)
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction).disabled(model.busy)
        case .elsewhere:
            EmptyView()
        }
    }

    private func submitPassword() {
        let typed = password
        password = ""
        Task { await model.submitPassword(typed) }
    }

    private func submitNewPassword() {
        let first = newPassword, second = again
        newPassword = ""
        again = ""
        Task { await model.submitNewPassword(first, again: second) }
    }
}

/// "Forgot your password?": a code by e-mail, then a new password (ForgotPasswordModel), as the site's.
struct ForgotPasswordForm: View {
    @StateObject private var model: ForgotPasswordModel
    @State private var password = ""
    @State private var again = ""
    let done: () -> Void

    init(account: CustomerAccount?, email: String, done: @escaping () -> Void) {
        _model = StateObject(wrappedValue: ForgotPasswordModel(account: account, email: email))
        self.done = done
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(CustomerWords.forgotTitle).font(.title2.weight(.semibold))
            Text(CustomerWords.forgotLead).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Field(SignInWords.email) {
                TextField("name@example.com", text: $model.email).disabled(model.step != .email)
            }
            if model.step == .code {
                Field("Code from the e-mail") {
                    TextField("123456", text: Binding(get: { model.digits }, set: { _ = model.editCode($0) }))
                        .font(.title3.monospacedDigit())
                }
                Field("A new password") { SecureField("", text: $password) }
                Field("The new password again") { SecureField("", text: $again) }
            }
            Problem(text: model.problem?.words, tries: 0)
            if model.step == .done {
                Label("Your password is changed. Sign in with it.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            }
            HStack {
                Button("Back to sign-in", action: done)
                Spacer()
                switch model.step {
                case .email:
                    Button("Send the code") { Task { await model.submitEmail() } }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .keyboardShortcut(.defaultAction).disabled(model.busy)
                case .code:
                    Button("Change the password") {
                        let first = password, second = again
                        password = ""
                        again = ""
                        Task { await model.submitReset(password: first, again: second) }
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .keyboardShortcut(.defaultAction).disabled(model.busy)
                case .done:
                    Button("Sign in", action: done)
                        .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
                }
            }
        }
    }
}
