import CraniumKit
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            if app.configSource == .example {
                ExampleConfigBanner()
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.paper.ignoresSafeArea())
        .tint(theme.accent)
        .overlay(alignment: .bottom) {
            if let toast = app.toast {
                Text(toast)
                    .font(Typeface.body.weight(.semibold))
                    .foregroundStyle(Theme.panel.ink)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Theme.panel.surface, in: RoundedRectangle(cornerRadius: 6))
                    .padding(.bottom, 90)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityHidden(true)
            }
        }
        .animation(.easeOut(duration: 0.2), value: app.toast)
        .task { await app.start() }
    }

    @ViewBuilder private var content: some View {
        switch app.stage {
        case .loading:
            ProgressView()
        case .broken(let text):
            Notice(.bad, "alert", "This build cannot be used. \(text)")
                .padding(24)
        case .signedOut:
            SignInView()
        case .signedIn:
            ConsoleTabs()
        }
    }
}

/// The website's sections, as tabs: Overview, Boards, Firmware, Events, and More for the rest.
struct ConsoleTabs: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @State private var tab = Stack<EmptyView>.firstTab

    var body: some View {
        TabView(selection: $tab) {
            Stack(0) { OverviewView() }
                .tabItem { Label("Overview", systemImage: "square.grid.2x2") }
                .tag(0)
            Stack(1) { BoardsView() }
                .tabItem { Label("Boards", systemImage: "cpu") }
                .tag(1)
            Stack(2) { FirmwareView() }
                .tabItem { Label("Firmware", systemImage: "shippingbox") }
                .tag(2)
            Stack(3) { EventsView() }
                .tabItem { Label("Events", systemImage: "chart.xyaxis.line") }
                .tag(3)
            Stack(4) { MoreView() }
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
                .tag(4)
        }
        .sheet(isPresented: Binding(get: { app.deploying != nil }, set: { if !$0 { app.deploying = nil } })) {
            DeployWizard(initial: app.deploying ?? "")
                .environmentObject(app)
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $app.bluetoothOpen) {
            BluetoothFlow(model: app.bluetoothModel(), release: app.bluetoothRelease)
                .environmentObject(app)
        }
        #else
        .sheet(isPresented: $app.bluetoothOpen) {
            BluetoothFlow(model: app.bluetoothModel(), release: app.bluetoothRelease)
                .environmentObject(app)
        }
        #endif
    }
}

/// One tab's navigation, with every screen a link inside the app can lead to.
struct Stack<Root: View>: View {
    @Environment(\.theme) private var theme
    let root: Root
    @State private var path: [Route]

    init(_ tab: Int, @ViewBuilder root: () -> Root) {
        self.root = root()
        _path = State(initialValue: tab == Self.firstTab ? Self.firstRoute : [])
    }

    /// The tab and screen a Debug build opens on, from `-CraniumTab` and `-CraniumRoute`.
    static var firstTab: Int {
        #if DEBUG
        return UserDefaults.standard.integer(forKey: "CraniumTab")
        #else
        return 0
        #endif
    }

    static var firstRoute: [Route] {
        #if DEBUG
        switch UserDefaults.standard.string(forKey: "CraniumRoute") {
        case "board": return [.board(Demo.boards[0])]
        case "deployment": return [.deployment(Demo.newDeployment)]
        case "release": return [.release("1.11.4+0")]
        case "deployments": return [.deployments]
        case "activity": return [.activity]
        case "tokens": return [.tokens]
        case "history": return [.history]
        case "serial": return [.serial]
        case "account": return [.account]
        default: return []
        }
        #else
        return []
        #endif
    }

    var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: Route.self) { route in
                    destination(route)
                }
        }
        #if os(iOS)
        .toolbarBackground(theme.surface, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        #endif
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .board(let thing): BoardView(thing: thing)
        case .deployment(let id): DeploymentView(id: id)
        case .release(let version): ReleaseView(version: version)
        case .deployments: DeploymentsView()
        case .activity: ActivityView()
        case .tokens: TokensView()
        case .history: HistoryView()
        case .serial: SerialConsoleView()
        case .account: AccountView()
        }
    }
}

extension View {
    /// A screen's title, in the console's ink on its paper.
    func consoleTitle(_ title: String, large: Bool = true) -> some View {
        self
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(large ? .large : .inline)
            .toolbarBackground(Theme.page.paper, for: .navigationBar)
            #endif
    }
}

/// Shown on every screen of a build made without apps/config/cranium.json.
struct ExampleConfigBanner: View {
    var body: some View {
        Text("Example configuration: this build was made without apps/config/cranium.json, so sign-in cannot work. Run apps/configure.sh and build again.")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.black)
            .padding(10)
            .frame(maxWidth: .infinity)
            .background(Theme.page.warnWash)
            .accessibilityIdentifier("example-config-banner")
    }
}

struct SignInView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Panel {
                    Image(systemName: "cpu")
                        .font(.system(size: 40, weight: .light))
                        .foregroundStyle(Theme.panel.accent)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Eyebrow("Cranium firmware console")
                        Text("Sign in")
                            .font(.largeTitle.weight(.bold))
                    }
                    Text("The boards, their firmware and every deployment, as on the website. Release managers can upload, deploy, revoke and send a release to a board over Bluetooth; viewers can see everything.")
                        .font(Typeface.body)
                        .foregroundStyle(Theme.panel.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("With your e-mail address, your password and the code from your authenticator app.")
                    .font(Typeface.body)
                    .foregroundStyle(theme.ink2)
                if let message = app.signInMessage {
                    Notice(.bad, "alert", message)
                }
                Button {
                    Task { await app.signIn() }
                } label: {
                    HStack {
                        if app.signingIn { ProgressView().tint(theme.onAccent) }
                        Text("Sign in")
                    }
                }
                .consoleButton(.primary, wide: true)
                .disabled(app.signingIn)
            }
            .padding(16)
            .padding(.top, 40)
        }
        .background(theme.paper.ignoresSafeArea())
        .foregroundStyle(theme.ink)
    }
}

/// The rest of the website's sections.
struct MoreView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        Page {
            Card("Console") {
                VStack(spacing: 0) {
                    row(.deployments, "paperplane", "Deployments", "Each release offered to boards, and where every board stands.")
                    RowRule()
                    row(.activity, "list.bullet", "Activity", "Every upload, deployment, cancellation and revocation, with who asked.")
                }
            }
            Card("Bluetooth") {
                Button {
                    app.openBluetooth(release: nil)
                } label: {
                    HStack(spacing: 12) {
                        icon("dot.radiowaves.left.and.right")
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Update over Bluetooth").font(Typeface.body.weight(.semibold))
                            Text(app.canWrite ? "Send a release to a board in the room, with its passkey."
                                 : "For release managers: send a release to a board in the room.")
                                .font(Typeface.small).foregroundStyle(theme.ink3)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(theme.ink3)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Card("Developer") {
                VStack(spacing: 0) {
                    row(.tokens, "key", "API tokens", "Your own tokens, for scripts that use the console as you.")
                    RowRule()
                    row(.history, "clock.arrow.circlepath", "History", "The project's commits, and what the console was built from.")
                    RowRule()
                    row(.serial, "terminal", "Serial console", "Drive a board on its USB cable: on a computer.")
                }
            }
            Card("Account") {
                row(.account, "person.crop.circle", app.me?.email ?? "Signed in", app.me?.role ?? "")
            }
        }
        .consoleTitle("More")
    }

    private func icon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.body)
            .foregroundStyle(theme.accent)
            .frame(width: 28)
            .accessibilityHidden(true)
    }

    private func row(_ route: Route, _ symbol: String, _ title: String, _ text: String) -> some View {
        RowLink(route) {
            HStack(spacing: 12) {
                icon(symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Typeface.body.weight(.semibold))
                    if !text.isEmpty {
                        Text(text).font(Typeface.small).foregroundStyle(theme.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.vertical, 10)
        }
    }
}

/// Who is signed in, their role, and signing out.
struct AccountView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @State private var confirmSignOut = false

    var body: some View {
        Page {
            PageHead(lede: "The account this phone is signed in with. Signing out forgets the sign-in and every firmware image kept on this phone.")
            if let me = app.me {
                Card("Signed in") {
                    VStack(spacing: 0) {
                        Fact("E-mail") { Text(me.email ?? "Not known").textSelection(.enabled) }
                        Fact("Role") {
                            HStack(spacing: 6) {
                                Image(systemName: me.canWrite ? "key" : "person").foregroundStyle(theme.ink2)
                                Text(me.role).fontWeight(.semibold)
                            }
                            FactNote(me.canWrite
                                     ? "Can upload, deploy, cancel and revoke, and send firmware over Bluetooth."
                                     : "Can see everything. Changes are for release managers.")
                        }
                        if !me.sub.isEmpty {
                            Fact("Account") {
                                CopyRow(value: me.sub, label: "the account ID")
                                FactNote("What the activity log files your actions under.")
                            }
                        }
                        if let expires = me.expiresAt {
                            Fact("Session") {
                                TimelineView(.periodic(from: .now, by: 30)) { context in
                                    let left = expires - context.date.timeIntervalSince1970
                                    Text(left > 0 ? "This sign-in is renewed by itself; its current token ends in \(Words.duration(left))."
                                         : "Renewed at the next request.")
                                }
                                FactNote("A change from the phone needs a sign-in in the last 15 minutes. The app asks when it does.")
                            }
                        }
                    }
                }
            }
            Card("Firmware on this phone") {
                VStack(alignment: .leading, spacing: 12) {
                    Text(UserMessage.firmwareOnPhone(app.firmwareOnPhone)).font(Typeface.body)
                    Text("Checked images of active releases, kept so that sending one again over Bluetooth needs no download. At most 5; each is checked again before it is sent.")
                        .font(Typeface.small).foregroundStyle(theme.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Clear downloaded firmware") {
                        Task { await app.clearFirmware() }
                    }
                    .consoleButton()
                    .disabled(app.firmwareOnPhone.count == 0)
                }
            }
            Button("Sign out", role: .destructive) { confirmSignOut = true }
                .consoleButton(.dangerQuiet, wide: true)
                .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                    Button("Sign out", role: .destructive) { Task { await app.signOut() } }
                } message: {
                    Text("The sign-in and every firmware image kept on this phone are forgotten.")
                }
        }
        .task { await app.noteFirmwareOnPhone() }
        .consoleTitle("Account")
    }
}

/// The website's Serial console drives a board on its USB cable from the browser. An iPhone app
/// has no way to open a USB serial port, so this says so plainly and points to where it works.
struct SerialConsoleView: View {
    @Environment(\.theme) private var theme

    var body: some View {
        Page {
            PageHead(lede: "On the website, the Serial console drives a board on its USB cable from the browser: its log, its commands, and its Bluetooth passkey.")
            Notice(.idle, "minus-circle",
                   "An iPhone cannot talk to a board's USB serial port: iOS gives apps no way to open one, so this app has no serial console.")
            Card("Where it works") {
                VStack(alignment: .leading, spacing: 12) {
                    point("Open the console's Serial console page (More, Developer) in Chrome or Edge on a computer, with the board on its USB cable.")
                    point("Or use the Android app, on a phone that can host a USB device.")
                    point("For an update without a cable, use Update over Bluetooth in this app. When the board is online, the app shows its passkey; otherwise the passkey is on the serial console, the line [BT] passkey.")
                }
            }
        }
        .consoleTitle("Serial console")
    }

    private func point(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("·").foregroundStyle(theme.ink3)
            Text(text).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
        }
    }
}
