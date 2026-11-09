import CraniumKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The customer side (docs/mobile-apps.md, "Customers"): the customer site's sections as tabs, its
/// sign-in pages, and the admin's way into admin mode. Its words are the site's (CustomerWords).
struct CustomerRoot: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        content
            .lockCover(customer)
            .sheet(isPresented: $customer.offeringBiometrics) {
                if let biometry = customer.biometry {
                    BiometricOfferSheet(biometry: biometry, text: CustomerWords.biometricOffer(biometry)) { yes in
                        Task { await customer.answerBiometricOffer(yes) }
                    }
                }
            }
    }

    @ViewBuilder private var content: some View {
        switch customer.stage {
        case .loading:
            ProgressView()
        case .locked:
            LockScreen(model: customer)
        case .signedIn:
            CustomerTabs(customerSide: true)
        case .signedOut, .notSetUp:
            if app.holdsSession {
                // Signed in as an admin only: the site's admin overview, Mixes and Help.
                CustomerTabs(customerSide: false)
            } else {
                CustomerGate()
            }
        }
    }
}

/// The signed-out side: the one sign-in, for customers and the team alike, or "Forgot your password?".
struct CustomerGate: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        switch customer.gate {
        case .signIn:
            CustomerSignInScreen(flow: customer.passwordSignIn, team: app.passwordSignIn, email: customer.lastEmail,
                                 lead: customer.signInLead ?? app.signInMessage)
        case .forgot:
            ForgotPasswordScreen(account: customer.account, team: customer.teamAccount, email: customer.lastEmail)
        }
    }
}

/// The site's sidebar as tabs: Overview, Devices, Mixes, Account and Help; for an admin who is not
/// signed in as a customer, Overview (the admin's), Mixes and Help.
struct CustomerTabs: View {
    @EnvironmentObject private var customer: CustomerModel
    let customerSide: Bool
    @State private var tab = "overview"

    var body: some View {
        TabView(selection: $tab) {
            ForEach(CustomerWords.sections.filter { customerSide || ($0.id != "devices" && $0.id != "account") }, id: \.id) { section in
                CustomerStack { screen(section.id) }
                    .tabItem { Label(section.label, systemImage: Self.symbol(section.id)) }
                    .tag(section.id)
            }
        }
        .environment(\.selectTab) { tab = $0 }
    }

    @ViewBuilder private func screen(_ id: String) -> some View {
        switch id {
        case "overview": CustomerOverviewView(customerSide: customerSide)
        case "devices": CustomerDevicesView()
        case "mixes": CustomerMixesView()
        case "account": CustomerAccountView()
        default: CustomerHelpView()
        }
    }

    /// The site's icons for its sections: grid, chip, disc, user, help.
    static func symbol(_ id: String) -> String {
        switch id {
        case "overview": return "square.grid.2x2"
        case "devices": return "cpu"
        case "mixes": return "opticaldisc"
        case "account": return "person.crop.circle"
        default: return "questionmark.circle"
        }
    }
}

/// Where a link on the customer side leads: one board, by its assignment id.
enum CustomerRoute: Hashable {
    case board(String)
}

struct CustomerStack<Root: View>: View {
    @ViewBuilder let root: () -> Root
    @State private var path: [CustomerRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            root()
                .navigationDestination(for: CustomerRoute.self) { route in
                    switch route {
                    case .board(let id): CustomerBoardView(id: id)
                    }
                }
        }
    }
}

/// "Admin mode", where an admin is signed in too: in the top bar, as on the site.
struct AdminModeButton: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        if app.holdsSession {
            Button {
                customer.openAdminMode()
            } label: {
                Label(CustomerWords.adminMode, systemImage: "key")
                    .labelStyle(.titleAndIcon)
            }
            .font(.subheadline.weight(.semibold))
        }
    }
}

// MARK: Signing in

/// The sign-in pages' frame (views.js `gate` on the site): the mark and the name, the title, the
/// lead, the form, and the way to the other sign-in.
struct Gate<Content: View>: View {
    @Environment(\.theme) private var theme
    let sub: String
    let title: String
    var foot: String? = nil
    var close: (() -> Void)? = nil
    @ViewBuilder let content: () -> Content
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 40

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    CraniumMark()
                        .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Cranium")
                            .font(.system(size: 22, weight: .bold))
                            .tracking(-0.6)
                        Text(sub)
                            .font(Typeface.small)
                            .foregroundStyle(theme.ink3)
                    }
                    Spacer()
                    if let close {
                        Button(SignInWords.cancel, action: close).consoleButton(.quiet)
                    }
                }
                .accessibilityElement(children: .contain)
                .padding(.bottom, 44)
                VStack(alignment: .leading, spacing: 16) {
                    Text(title)
                        .font(.system(size: titleSize, weight: .bold))
                        .tracking(-0.022 * titleSize)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    content()
                    if let foot {
                        Text(foot)
                            .font(Typeface.small)
                            .foregroundStyle(theme.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 12)
                    }
                }
            }
            .frame(maxWidth: 432, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 32)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(theme.paper.ignoresSafeArea())
        .foregroundStyle(theme.ink)
    }
}

/// A labelled field of the sign-in pages, in the site's style.
struct GateField: View {
    @Environment(\.theme) private var theme
    let label: String
    var hint: String? = nil
    @Binding var text: String
    var secure = false
    var email = false
    var newPassword = false
    var invalid = false
    var readOnly = false
    var focused: FocusState<Bool>.Binding
    var submit: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .accessibilityHidden(true)
            input
                .focused(focused)
                .disabled(readOnly)
                .onSubmit(submit)
                .signInInput(theme, focused: focused.wrappedValue, invalid: invalid, readOnly: readOnly)
                .accessibilityLabel(label)
                .accessibilityHint(hint ?? "")
            if let hint {
                Text(hint)
                    .font(Typeface.small)
                    .foregroundStyle(theme.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder private var input: some View {
        if secure {
            #if os(iOS)
            SecureField("", text: $text).textContentType(newPassword ? .newPassword : .password)
            #else
            SecureField("", text: $text)
            #endif
        } else if email {
            TextField("", text: $text).emailInput()
        } else {
            TextField("", text: $text)
        }
    }
}

/// The site's buttons of the sign-in pages: primary, then quiet.
struct GateButtons: View {
    @Environment(\.theme) private var theme
    let primary: String
    var busy = false
    let action: () -> Void
    var quiet: [(String, () -> Void)] = []

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) { buttons }
            VStack(alignment: .leading, spacing: 8) { buttons }
        }
    }

    @ViewBuilder private var buttons: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(theme.onAccent) }
                Text(primary)
            }
            .font(.body.weight(.semibold))
            .padding(.horizontal, 11)
            .frame(minHeight: 48)
        }
        .consoleButton(.primary)
        ForEach(Array(quiet.enumerated()), id: \.offset) { _, item in
            Button(action: item.1) { Text(item.0).foregroundStyle(theme.ink2) }
                .consoleButton(.quiet)
                .disabled(busy)
        }
    }
}

/// What went wrong, in one line, said to VoiceOver too.
struct GateProblem: View {
    let text: String?
    let tries: Int

    var body: some View {
        if let text {
            Notice(.bad, "alert", text)
                .id(tries)
                .transition(.opacity)
                .onAppear {
                    #if canImport(UIKit)
                    UIAccessibility.post(notification: .announcement, argument: text)
                    #endif
                }
        }
    }
}

/// The one sign-in (customer-views.js `signInView`): the team's pool first, then the customer pool. A
/// team account lands in admin mode, a customer on the customer side.
struct CustomerSignInScreen: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme
    @StateObject private var model: CustomerSignInModel
    @State private var password = ""
    @State private var first = ""
    @State private var again = ""
    @FocusState private var emailFocused: Bool
    @FocusState private var passwordFocused: Bool
    @FocusState private var codeFocused: Bool
    @FocusState private var newFocused: Bool
    @FocusState private var againFocused: Bool

    init(flow: PasswordSignIn?, team: PasswordSignIn?, email: String, lead: String?) {
        _model = StateObject(wrappedValue: CustomerSignInModel(flow: flow, team: team, email: email, lead: lead))
    }

    var body: some View {
        Gate(sub: CustomerWords.yourStudio, title: title, foot: CustomerWords.gateFoot, close: nil) {
            lead
            if model.isSetUp {
                switch model.step {
                case .password: passwordStep
                case .code: codeStep
                case .newPassword: newPasswordStep
                case .elsewhere: elsewhereStep
                }
            } else {
                Notice(.warn, "alert", CustomerWords.notSetUp)
            }
        }
        .interactiveDismissDisabled(model.busy)
        .task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            focus(model.focus.field)
        }
        .onChange(of: model.focus) { request in focus(request.field) }
        .onChange(of: model.email) { customer.lastEmail = $0 }
        .onChange(of: model.signedIn) { done in
            guard done else { return }
            if model.account == .team {
                // A team account: admin mode, as the site's /admin, with the session the app's own sign-in kept.
                Task {
                    await app.signedInHere()
                    customer.openAdminMode()
                }
            } else {
                Task { await customer.signedInHere() }
            }
        }
        .onChange(of: model.step) { step in
            // A team account's step this screen does not do (a new password, an authenticator to set up): the AWS sign-in page.
            guard step == .elsewhere, model.account == .team else { return }
            Task {
                await app.signIn()
                if app.stage == .signedIn { customer.openAdminMode() } else { model.startOver() }
            }
        }
    }

    private var title: String {
        switch model.step {
        case .password: return CustomerWords.signInTitle
        case .code: return CustomerWords.codeTitle
        case .newPassword: return CustomerWords.newPasswordTitle
        case .elsewhere: return CustomerWords.elsewhereTitle
        }
    }

    @ViewBuilder private var lead: some View {
        switch model.step {
        case .password:
            Text(model.lead ?? CustomerWords.signInLead).leadStyle(theme)
        case .code:
            (Text("Signing in as ") + Text(model.email.trimmingCharacters(in: .whitespacesAndNewlines)).fontWeight(.semibold) + Text("."))
                .leadStyle(theme)
        case .newPassword:
            Text(CustomerWords.newPasswordLead).leadStyle(theme)
        case .elsewhere:
            Text(model.account == .team ? SignInWords.leaving : CustomerWords.elsewhereLead).leadStyle(theme)
        }
    }

    private var passwordStep: some View {
        let wrong = model.problem == "wrong-password" || model.problem == "missing"
        return VStack(alignment: .leading, spacing: 18) {
            GateField(label: CustomerWords.emailAddress, text: $model.email, email: true, invalid: wrong, readOnly: model.busy,
                      focused: $emailFocused, submit: { passwordFocused = true })
            GateField(label: CustomerWords.password, text: $password, secure: true, invalid: wrong, readOnly: model.busy,
                      focused: $passwordFocused, submit: submitPassword)
            GateProblem(text: model.problemWords, tries: model.tries)
            GateButtons(primary: model.busy ? CustomerWords.checking : CustomerWords.next, busy: model.busy, action: submitPassword,
                        quiet: [(CustomerWords.forgot, { customer.gate = .forgot })])
        }
        .padding(.top, 6)
    }

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text(CustomerWords.codeFromApp).font(.subheadline.weight(.semibold)).accessibilityHidden(true)
                CodeBoxes(digits: model.digits, wrong: model.problem == "wrong-code", busy: model.busy,
                          focused: $codeFocused, onEdit: { model.editCode($0) })
                Text(CustomerWords.codeHint)
                    .font(Typeface.small)
                    .foregroundStyle(theme.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
            GateProblem(text: model.problemWords, tries: model.tries)
            GateButtons(primary: model.busy ? CustomerWords.checking : CustomerWords.signIn, busy: model.busy,
                        action: { Task { await model.submitCode() } },
                        quiet: [(CustomerWords.startAgain, { model.startOver() })])
        }
        .padding(.top, 6)
    }

    private var newPasswordStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            GateField(label: CustomerWords.newPassword, hint: CustomerWords.firstPasswordHint, text: $first, secure: true,
                      newPassword: true, readOnly: model.busy, focused: $newFocused, submit: { againFocused = true })
            GateField(label: CustomerWords.newPasswordAgain, text: $again, secure: true, newPassword: true, readOnly: model.busy,
                      focused: $againFocused, submit: submitNewPassword)
            GateProblem(text: model.problemWords, tries: model.tries)
            GateButtons(primary: model.busy ? CustomerWords.saving : CustomerWords.saveAndSignIn, busy: model.busy,
                        action: submitNewPassword)
        }
        .padding(.top, 6)
    }

    private var elsewhereStep: some View {
        GateButtons(primary: CustomerWords.chooseNewPassword, action: { customer.gate = .forgot },
                    quiet: [(CustomerWords.startAgain, { model.startOver() })])
            .padding(.top, 6)
    }

    private func submitPassword() {
        guard !model.busy else { return }
        let typed = password
        password = ""
        Task { await model.submitPassword(typed) }
    }

    private func submitNewPassword() {
        guard !model.busy else { return }
        let typed = first, twice = again
        first = ""
        again = ""
        Task { await model.submitNewPassword(typed, again: twice) }
    }

    private func focus(_ field: CustomerSignInModel.Field) {
        emailFocused = field == .email
        passwordFocused = field == .password
        codeFocused = field == .code
        newFocused = field == .newPassword
    }
}

/// "Forgot your password?" (customer-views.js `forgotView`).
struct ForgotPasswordScreen: View {
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme
    @StateObject private var model: ForgotPasswordModel
    @State private var first = ""
    @State private var again = ""
    @FocusState private var emailFocused: Bool
    @FocusState private var codeFocused: Bool
    @FocusState private var newFocused: Bool
    @FocusState private var againFocused: Bool

    init(account: CustomerAccount?, team: CustomerAccount?, email: String) {
        _model = StateObject(wrappedValue: ForgotPasswordModel(account: account, team: team, email: email))
    }

    var body: some View {
        Gate(sub: CustomerWords.yourStudio, title: model.step == .done ? CustomerWords.doneTitle : CustomerWords.forgotTitle) {
            switch model.step {
            case .email: emailStep
            case .code: codeStep
            case .done:
                Text(CustomerWords.passwordChangedSignIn).leadStyle(theme)
                GateButtons(primary: CustomerWords.signIn, action: { customer.gate = .signIn })
            }
            Button {
                customer.gate = .signIn
            } label: {
                Label(CustomerWords.backToSignIn, systemImage: "chevron.left").foregroundStyle(theme.ink2)
            }
            .consoleButton(.quiet)
            .padding(.leading, -15)
            .padding(.top, 10)
            .disabled(model.busy)
        }
        .onChange(of: model.email) { customer.lastEmail = $0 }
        .onChange(of: model.step) { step in
            if step == .code { codeFocused = true }
        }
    }

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(CustomerWords.forgotLead).leadStyle(theme)
            GateField(label: CustomerWords.emailAddress, text: $model.email, email: true, invalid: model.problem == .missingEmail,
                      readOnly: model.busy, focused: $emailFocused, submit: { Task { await model.submitEmail() } })
            GateProblem(text: model.problem?.words, tries: 0)
            GateButtons(primary: model.busy ? CustomerWords.sending : CustomerWords.sendCode, busy: model.busy,
                        action: { Task { await model.submitEmail() } })
        }
    }

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            (Text("If ") + Text(model.email.trimmingCharacters(in: .whitespacesAndNewlines)).fontWeight(.semibold)
                + Text(" has an account, a code is on its way to it. It can take a minute."))
                .leadStyle(theme)
            VStack(alignment: .leading, spacing: 6) {
                Text(CustomerWords.codeFromEmail).font(.subheadline.weight(.semibold)).accessibilityHidden(true)
                CodeBoxes(digits: model.digits, wrong: model.problem == .wrongCode, busy: model.busy,
                          focused: $codeFocused, onEdit: { model.editCode($0) })
                Text(CustomerWords.codeFromEmailHint)
                    .font(Typeface.small)
                    .foregroundStyle(theme.ink3)
                    .accessibilityHidden(true)
            }
            GateField(label: CustomerWords.newPassword, hint: CustomerWords.firstPasswordHint, text: $first, secure: true,
                      newPassword: true, readOnly: model.busy, focused: $newFocused, submit: { againFocused = true })
            GateField(label: CustomerWords.newPasswordAgain, text: $again, secure: true, newPassword: true, readOnly: model.busy,
                      focused: $againFocused, submit: submitReset)
            GateProblem(text: model.problem?.words, tries: 0)
            GateButtons(primary: model.busy ? CustomerWords.saving : CustomerWords.setNewPassword, busy: model.busy,
                        action: submitReset, quiet: [(CustomerWords.sendAnother, { model.startOver() })])
        }
    }

    private func submitReset() {
        guard !model.busy else { return }
        let typed = first, twice = again
        Task {
            await model.submitReset(password: typed, again: twice)
            if model.step == .done {
                first = ""
                again = ""
            }
        }
    }
}
