import CraniumKit
import SwiftUI

/// The rest of the website's sections. Before iOS 26 it also holds the search field.
struct MoreView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme
    let searchHere: Bool
    var eventsHere = false
    @StateObject private var search = SearchModel()

    var body: some View {
        Group {
            if searchHere && !search.query.trimmingCharacters(in: .whitespaces).isEmpty {
                SearchResults(model: search)
            } else {
                menu
            }
        }
        .modifier(SearchField(enabled: searchHere, model: search))
        .screenTitle("More")
    }

    private var menu: some View {
        ListScreen {
            Section {
                if eventsHere { row(.eventsList, "chart.xyaxis.line", "Events") }
                row(.deployments, "paperplane", "Deployments")
                row(.activity, "list.bullet", "Activity")
                Button {
                    app.openBluetooth(release: nil)
                } label: {
                    Label("Update over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                }
                .foregroundStyle(theme.ink)
            }
            Section("Developer") {
                row(.tokens, "key", "API tokens")
                row(.history, "clock.arrow.circlepath", "History")
                row(.serial, "terminal", "Serial console")
                row(.boardSetup, "cable.connector", "Board setup")
            }
            Section {
                row(.help(nil), "questionmark.circle", "Help")
                NavigationLink(value: Route.account) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Account")
                            if let email = app.me?.email {
                                Text(email).font(.footnote).foregroundStyle(theme.ink3)
                            }
                        }
                    } icon: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            // Admin mode is the console; the customer side is where it was opened from
            // (docs/mobile-apps.md, "Customers"). The admin stays signed in.
            Section {
                Button {
                    customer.leaveAdminMode()
                } label: {
                    Label(CustomerWords.leaveAdminMode, systemImage: "arrow.left")
                }
                .foregroundStyle(theme.ink)
            }
        }
    }

    private func row(_ route: Route, _ symbol: String, _ title: String) -> some View {
        NavigationLink(value: route) {
            Label(title, systemImage: symbol)
        }
    }
}

/// The search field of a screen, only where it is wanted.
struct SearchField: ViewModifier {
    @EnvironmentObject private var app: AppModel
    let enabled: Bool
    @ObservedObject var model: SearchModel

    func body(content: Content) -> some View {
        if enabled {
            content
                .consoleSearchable($model.query)
                .onSubmit(of: .search) { model.remember() }
                .task { await model.prepare(app) }
        } else {
            content
        }
    }
}

/// Who is signed in, their role, the firmware kept on the phone, and signing out.
struct AccountView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @State private var confirmSignOut = false

    var body: some View {
        ListScreen {
            if let me = app.me {
                Section {
                    ValueRow("E-mail", me.email ?? "Not known")
                    ValueRow("Role", me.role)
                    if !me.sub.isEmpty {
                        HStack {
                            Text("Account ID")
                            Spacer()
                            Text(verbatim: Words.shortAccount(me.sub)).font(Typeface.hash).foregroundStyle(theme.ink2)
                            CopyButton(value: me.sub, label: "the account ID")
                        }
                    }
                } footer: {
                    Text(me.canWrite ? "You can upload, deploy, cancel and revoke." : "You can see everything; changes are for release managers.")
                }
                if let biometry = app.biometry {
                    biometricSection(biometry)
                }
            }
            Section {
                ValueRow("Firmware on this phone", UserMessage.firmwareOnPhone(app.firmwareOnPhone)
                    .replacingOccurrences(of: " on this phone", with: ""))
                Button("Clear downloaded firmware") {
                    Task { await app.clearFirmware() }
                }
                .disabled(app.firmwareOnPhone.count == 0)
            } footer: {
                Text("Kept so that sending a release over Bluetooth again needs no download.")
            }
            Section {
                Button("Sign out", role: .destructive) { confirmSignOut = true }
            }
        }
        .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await app.signOut() } }
        } message: {
            Text("The sign-in and the firmware kept on this phone are forgotten.")
        }
        .task { await app.noteFirmwareOnPhone() }
        // Turning Face ID on after the refresh token's 60 minutes: the password and code first.
        .sheet(isPresented: Binding(get: { app.biometricSignInOpen }, set: { if !$0 { app.endBiometricSignIn(.cancelled) } })) {
            SignInScreen(flow: app.passwordSignIn, again: true, email: app.me?.email) { ending in
                app.endBiometricSignIn(ending)
            }
        }
        .helpButton("getting-started")
        .screenTitle("Account")
    }

    /// Face ID (or Touch ID): on or off for this person on this phone. Not shown on a phone with neither.
    private func biometricSection(_ biometry: Biometry) -> some View {
        let usable = app.biometryUsable
        return Section {
            Toggle(isOn: Binding(get: { app.biometricOn }, set: { on in
                Task { on ? await app.turnOnBiometrics() : await app.turnOffBiometrics() }
            })) {
                Label(biometry.name, systemImage: biometry.symbol)
            }
            .disabled(app.biometricBusy || (!app.biometricOn && !usable))
            NavigationLink(value: Route.help("biometric-sign-in")) {
                Text("About \(biometry.name)")
            }
        } footer: {
            Text(usable || app.biometricOn ? BiometricWords.toggleFooter(biometry) : BiometricWords.cannotUse(biometry))
        }
    }
}

/// The console's Board setup takes a board on USB to online over its serial port, which an iPhone cannot open
/// (BoardSetupWords, the website's setup.js APP_WORDS).
struct BoardSetupView: View {
    var body: some View {
        ListScreen {
            Section {
                Text(BoardSetupWords.title).font(.headline)
            } footer: {
                Text(BoardSetupWords.ios)
            }
            Section {
                NavigationLink(value: Route.help("bluetooth-update")) {
                    Label("Update a board over Bluetooth instead", systemImage: "dot.radiowaves.left.and.right")
                }
            }
        }
        .helpButton("serial-console")
        .screenTitle("Board setup")
    }
}

/// The website's Serial console drives a board on its USB cable from the browser. An iPhone app
/// has no way to open a USB serial port, so this says so and points to where it works.
struct SerialConsoleView: View {
    var body: some View {
        ListScreen {
            Section {
                Text("An iPhone can't open a board's USB serial port, so the serial console isn't in this app.")
            } footer: {
                Text("Use the console's Serial console in Chrome or Edge on a computer, with the board on its USB cable, or the Android app.")
            }
            Section {
                NavigationLink(value: Route.help("bluetooth-update")) {
                    Label("Update over Bluetooth instead", systemImage: "dot.radiowaves.left.and.right")
                }
            }
        }
        .helpButton("serial-console")
        .screenTitle("Serial console")
    }
}
