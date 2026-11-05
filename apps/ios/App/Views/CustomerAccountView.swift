import CraniumKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// A customer's account (customer-views.js `accountView`): who is signed in, a new password,
/// two-step sign-in on or off, Face ID, and signing out. Every change is between the customer and
/// Cognito, with the customer's own access token (CustomerAccount).
struct CustomerAccountView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme

    var body: some View {
        Page {
            PageHead(eyebrow: CustomerWords.yourStudio, lede: CustomerWords.accountLede)
            Text(CustomerWords.accountTitle).font(Typeface.title).accessibilityAddTraits(.isHeader)
            CustomerProblem(what: CustomerWords.yourAccount, error: customer.profile.error) {
                Task { await customer.loadProfile() }
            }
            Card(CustomerWords.signedInAs) {
                VStack(alignment: .leading, spacing: 0) {
                    Fact(CustomerWords.email) {
                        Text(customer.profile.value?.email ?? customer.me.value?.email ?? CustomerWords.dash).fontWeight(.semibold)
                    }
                    Fact(CustomerWords.name) {
                        let name = customer.profile.value?.name.nilIfEmpty ?? customer.me.value?.name.nilIfEmpty
                        Text(name ?? CustomerWords.notGiven).foregroundStyle(name == nil ? theme.ink3 : theme.ink)
                    }
                    Fact(CustomerWords.session) {
                        Text(CustomerWords.sessionLine(biometry: customer.biometricOn ? customer.biometry : nil))
                    }
                }
                Notice(.idle, "user", CustomerWords.emailNote)
            }
            PasswordCard()
            if customer.profile.value == nil && customer.profile.error == nil {
                Loading(what: CustomerWords.yourAccount)
            } else if let profile = customer.profile.value {
                TwoStepCard(on: profile.authenticator, email: profile.email)
            }
            if let biometry = customer.biometry {
                Card(biometry.name) {
                    Toggle(isOn: Binding(get: { customer.biometricOn }, set: { on in
                        Task { on ? await customer.turnOnBiometrics() : await customer.turnOffBiometrics() }
                    })) {
                        Label(biometry.name, systemImage: biometry.symbol)
                    }
                    .disabled(customer.biometricBusy || (!customer.biometricOn && !customer.biometryUsable))
                    Text(customer.biometryUsable || customer.biometricOn ? CustomerWords.biometricFooter(biometry) : BiometricWords.cannotUse(biometry))
                        .font(Typeface.small).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
            }
            if app.holdsSession {
                Card(CustomerWords.adminMode) {
                    Button {
                        customer.openAdminMode()
                    } label: {
                        Label(CustomerWords.adminMode, systemImage: "key")
                    }
                    .consoleButton(.primary)
                }
            }
            Card(CustomerWords.signOut) {
                Text(CustomerWords.signOutText).font(Typeface.body).foregroundStyle(theme.ink2)
                Button {
                    Task { await customer.signOutEverything(admin: app) }
                } label: {
                    Label(CustomerWords.signOut, systemImage: "rectangle.portrait.and.arrow.right")
                }
                .consoleButton()
            }
        }
        .task { await customer.loadProfile() }
        .refreshable { await customer.loadProfile() }
        .toolbar { ToolbarItem(placement: .primaryAction) { AdminModeButton() } }
        .consoleTitle(CustomerWords.sections[3].label)
    }
}

/// "Password": the current one and a new one twice. Nothing kept once it is sent.
private struct PasswordCard: View {
    @EnvironmentObject private var customer: CustomerModel
    @State private var current = ""
    @State private var next = ""
    @State private var again = ""
    @State private var busy = false
    @State private var problem: AccountProblem?
    @State private var done = false
    @State private var tries = 0
    @FocusState private var currentFocused: Bool
    @FocusState private var nextFocused: Bool
    @FocusState private var againFocused: Bool

    var body: some View {
        Card(CustomerWords.password) {
            VStack(alignment: .leading, spacing: 16) {
                GateField(label: CustomerWords.currentPassword, text: $current, secure: true, invalid: problem == .wrongPassword,
                          readOnly: busy, focused: $currentFocused, submit: { nextFocused = true })
                GateField(label: CustomerWords.newPassword, hint: CustomerWords.newPasswordHint, text: $next, secure: true,
                          newPassword: true, readOnly: busy, focused: $nextFocused, submit: { againFocused = true })
                GateField(label: CustomerWords.newPasswordAgain, text: $again, secure: true, newPassword: true, readOnly: busy,
                          focused: $againFocused, submit: submit)
                GateProblem(text: problem?.words, tries: tries)
                if done {
                    Label(CustomerWords.passwordChanged, systemImage: "checkmark")
                        .font(Typeface.body)
                }
                GateButtons(primary: busy ? CustomerWords.saving : CustomerWords.changePassword, busy: busy, action: submit)
            }
        }
    }

    private func submit() {
        guard !busy, let account = customer.account else { return }
        done = false
        tries += 1
        if let wrong = AccountProblem.ofNewPassword(next, again: again) {
            problem = wrong
            return
        }
        busy = true
        problem = nil
        let old = current, new = next
        Task {
            let result = await account.changePassword(current: old, next: new)
            busy = false
            if let wrong = result.problem {
                problem = wrong
                if wrong == .sessionEnded { await customer.handle(AuthError.sessionExpired) }
            } else {
                current = ""
                next = ""
                again = ""
                done = true
            }
        }
    }
}

/// "Two-step sign-in": on or off, and turning it on with a setup key and the first code.
private struct TwoStepCard: View {
    enum Step { case idle, secret, confirmOff }

    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    let on: Bool
    let email: String
    @State private var step: Step = .idle
    @State private var secret = ""
    @State private var digits = ""
    @State private var busy = false
    @State private var problem: AccountProblem?
    @State private var done: String?
    @State private var tries = 0
    @FocusState private var codeFocused: Bool

    var body: some View {
        Card(CustomerWords.twoStep) {
            if on {
                Badge(.good, "shield", CustomerWords.on)
            } else {
                Badge(.idle, "minus-circle", CustomerWords.off)
            }
            switch step {
            case .secret where !secret.isEmpty: secretStep
            case .confirmOff where on: confirmOffStep
            default: idleStep
            }
        }
    }

    private var idleStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(on ? CustomerWords.twoStepOnText : CustomerWords.twoStepOffText)
                .font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            GateProblem(text: problem?.words, tries: tries)
            if let done {
                Label(done, systemImage: "checkmark").font(Typeface.body)
            }
            if on {
                Button(CustomerWords.turnOff) {
                    step = .confirmOff
                    problem = nil
                    done = nil
                }
                .consoleButton()
            } else {
                GateButtons(primary: busy ? CustomerWords.starting : CustomerWords.turnOn, busy: busy, action: start)
            }
        }
    }

    private var secretStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                numbered(1, CustomerWords.setupStep1)
                numbered(2, CustomerWords.setupStep2)
                Text(CustomerAccount.groupSecret(secret))
                    .font(.system(.title3, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    .accessibilityLabel(CustomerWords.setupKeyLabel(CustomerAccount.groupSecret(secret)))
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { keyButtons }
                    VStack(alignment: .leading, spacing: 8) { keyButtons }
                }
                numbered(3, CustomerWords.setupStep3)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(CustomerWords.codeFromApp).font(.subheadline.weight(.semibold)).accessibilityHidden(true)
                CodeBoxes(digits: digits, wrong: problem == .wrongCode, busy: busy, focused: $codeFocused, onEdit: edit)
                Text(CustomerWords.newCodeHint).font(Typeface.small).foregroundStyle(theme.ink3)
            }
            GateProblem(text: problem?.words, tries: tries)
            GateButtons(primary: busy ? CustomerWords.checking : CustomerWords.turnOnTwoStep, busy: busy, action: confirm,
                        quiet: [(CustomerWords.notNow, cancel)])
        }
    }

    @ViewBuilder private var keyButtons: some View {
        Button {
            #if canImport(UIKit)
            UIPasteboard.general.string = secret
            #endif
            customer.say(CustomerWords.keyCopied)
        } label: {
            Label(CustomerWords.copyKey, systemImage: Icon.symbol("copy"))
        }
        .consoleButton()
        if let uri = CustomerAccount.otpauthURI(secret: secret, email: email), let url = URL(string: uri) {
            Button {
                openURL(url) { opened in
                    if !opened { customer.say(CustomerWords.noAuthenticatorApp) }
                }
            } label: {
                Label(CustomerWords.openAuthenticator, systemImage: "arrow.up.forward.app")
            }
            .consoleButton()
        }
    }

    private var confirmOffStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(CustomerWords.offWarning).font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            GateProblem(text: problem?.words, tries: tries)
            HStack(spacing: 12) {
                Button(busy ? CustomerWords.turningOff : CustomerWords.turnItOff, action: stop).consoleButton(.danger).disabled(busy)
                Button(CustomerWords.keepItOn, action: cancel).consoleButton(.quiet).disabled(busy)
            }
        }
    }

    private func numbered(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(number).").font(Typeface.body.weight(.semibold))
            Text(text).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func edit(_ text: String) -> String {
        guard !busy else { return digits }
        let before = digits
        digits = CodeEntry.digits(before: before, after: text)
        problem = nil
        if !CodeEntry.isComplete(before) && CodeEntry.isComplete(digits) { confirm() }
        return digits
    }

    private func start() {
        guard !busy, let account = customer.account else { return }
        busy = true
        problem = nil
        done = nil
        Task {
            let result = await account.startAuthenticator()
            busy = false
            switch result {
            case .ok(let value):
                secret = value
                digits = ""
                step = .secret
                codeFocused = true
            case .problem(let wrong):
                tries += 1
                problem = wrong
            }
        }
    }

    private func confirm() {
        guard !busy, let account = customer.account else { return }
        guard CodeEntry.isComplete(digits) else {
            tries += 1
            problem = .shortCode
            return
        }
        busy = true
        problem = nil
        let code = digits
        Task {
            let result = await account.confirmAuthenticator(code: code)
            busy = false
            if let wrong = result.problem {
                tries += 1
                problem = wrong
                digits = ""
                codeFocused = true
                return
            }
            await customer.loadProfile()
            secret = ""
            step = .idle
            done = CustomerWords.twoStepIsOn
        }
    }

    private func stop() {
        guard !busy, let account = customer.account else { return }
        busy = true
        problem = nil
        Task {
            let result = await account.stopAuthenticator()
            busy = false
            if let wrong = result.problem {
                tries += 1
                problem = wrong
                return
            }
            await customer.loadProfile()
            step = .idle
            done = CustomerWords.twoStepIsOff
        }
    }

    private func cancel() {
        step = .idle
        secret = ""
        problem = nil
        busy = false
    }
}
