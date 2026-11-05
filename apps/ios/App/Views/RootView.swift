import CraniumKit
import SwiftUI

/// The app's two sides (docs/mobile-apps.md, "Customers"), as the customer site and its admin mode:
/// the customer side (CustomerRoot), and admin mode, which is the console's own screens as before
/// (AdminRoot). One of them is on screen; each has its own session, Face ID and lock.
struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    /// The admin's stage before its last change, to tell a sign-out from "Sign in with password".
    @State private var adminStage: AppModel.Stage = .loading

    var body: some View {
        VStack(spacing: 0) {
            if app.configSource == .example {
                ExampleConfigBanner()
            }
            Group {
                if case .broken(let text) = app.stage {
                    Notice(.bad, "alert", "This build cannot be used. \(text)")
                        .padding(24)
                } else if customer.adminMode {
                    AdminRoot()
                } else {
                    CustomerRoot()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.paper.ignoresSafeArea())
        .tint(theme.accent)
        .overlay(alignment: .bottom) {
            if let toast = customer.adminMode ? app.toast : (customer.toast ?? app.toast) {
                Text(toast)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.panel.ink)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Theme.panel.surface, in: Capsule())
                    .padding(.bottom, 96)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityHidden(true)
            }
        }
        .animation(.easeOut(duration: 0.2), value: app.toast)
        .animation(.easeOut(duration: 0.2), value: customer.toast)
        .task {
            await app.start()
            await customer.start(admin: app)
        }
        .onChange(of: app.stage) { stage in
            // Recent searches belong to whoever is signed in: they go at sign-out.
            if stage == .signedOut {
                RecentSearches().clear()
                customer.adminEnded(from: adminStage, message: app.signInMessage)
            }
            adminStage = stage
        }
        // Face ID: each side covered in the app switcher, and asked again after 5 minutes away.
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .background:
                Task {
                    await app.enteredBackground()
                    await customer.enteredBackground()
                }
            case .inactive:
                app.becameInactive()
                customer.becameInactive()
            case .active:
                Task {
                    await app.becameActive()
                    await customer.becameActive()
                }
            @unknown default: break
            }
        }
    }
}

/// Admin mode: the console, as the app was before the customer side.
struct AdminRoot: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        content
            .lockCover(app)
            .sheet(isPresented: $app.offeringBiometrics) {
                if let biometry = app.biometry {
                    BiometricOfferSheet(biometry: biometry) { yes in
                        Task { await app.answerBiometricOffer(yes) }
                    }
                }
            }
    }

    @ViewBuilder private var content: some View {
        switch app.stage {
        case .loading, .signedOut, .broken:
            // Signed out, admin mode closes (RootView): nothing of it in between.
            ProgressView()
        case .locked:
            LockScreen(model: app)
        case .signedIn:
            ConsoleTabs()
        }
    }
}

/// The website's sections, as tabs. From iOS 26: Overview, Boards, Firmware, More (with Events) and
/// the system's own Search button. Before that: Overview, Boards, Firmware, Events and More, with
/// the search field on More.
struct ConsoleTabs: View {
    @EnvironmentObject private var app: AppModel
    @State private var tab = Stack<EmptyView>.firstTab
    #if DEBUG
    /// `-CraniumSheet signin-again`: the sign-in again, for screenshots in demo mode.
    @State private var demoAgain = false
    #endif

    var body: some View {
        tabs
            #if DEBUG
            .sheet(isPresented: $demoAgain) {
                SignInScreen(flow: app.passwordSignIn, again: true, email: app.me?.email) { _ in demoAgain = false }
            }
            .task {
                // Once the account is known, as in a real sign-in again.
                guard Demo.isOn, UserDefaults.standard.string(forKey: "CraniumSheet") == "signin-again" else { return }
                while app.me == nil { try? await Task.sleep(nanoseconds: 200_000_000) }
                demoAgain = true
            }
            #endif
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

    @ViewBuilder private var tabs: some View {
        if #available(iOS 26, macOS 26, *) {
            TabView(selection: $tab) {
                Tab("Overview", systemImage: "square.grid.2x2", value: 0) { Stack(0) { OverviewView() } }
                Tab("Boards", systemImage: "cpu", value: 1) { Stack(1) { BoardsView() } }
                Tab("Firmware", systemImage: "shippingbox", value: 2) { Stack(2) { FirmwareView() } }
                // Four tabs and the search button: a fifth would send two of them into the system's own
                // overflow. Events is the first row of More here.
                Tab("More", systemImage: "ellipsis.circle", value: 4) { Stack(4) { MoreView(searchHere: false, eventsHere: true) } }
                Tab(value: 5, role: .search) { Stack(5) { SearchScreen() } }
            }
        } else {
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
                Stack(4) { MoreView(searchHere: true) }
                    .tabItem { Label("More", systemImage: "ellipsis.circle") }
                    .tag(4)
            }
        }
    }
}

/// One tab's navigation, with every screen a link inside the app can lead to.
struct Stack<Root: View>: View {
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
        case "release": return [.release("1.12.0+0")]
        case "deployments": return [.deployments]
        case "activity": return [.activity]
        case "tokens": return [.tokens]
        case "history": return [.history]
        case "serial": return [.serial]
        case "account": return [.account]
        case "help": return [.help(nil)]
        case "help-topic": return [.help(nil), .help("bluetooth-update")]
        case "upload": return [.upload]
        case "events": return [.eventsList]
        case "board-log": return [.boardLog(Demo.boards[0])]
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
        case .help(let topic):
            if let topic { HelpTopicView(id: topic) } else { HelpView() }
        case .boardHistory(let thing): BoardHistoryView(thing: thing)
        case .boardBoots(let thing): BoardBootsView(thing: thing)
        case .boardCharts(let thing): BoardChartsView(thing: thing)
        case .boardSlots(let thing): BoardSlotsView(thing: thing)
        case .boardCertificates(let thing): BoardCertificatesView(thing: thing)
        case .releaseDetails(let version): ReleaseDetailsView(version: version)
        case .execution(let id, let thing): ExecutionView(id: id, thing: thing)
        case .token(let id): TokenView(id: id)
        case .upload: UploadView()
        case .signingKey: SigningKeyView()
        case .overview: OverviewView()
        case .boardsList: BoardsView()
        case .firmwareList: FirmwareView()
        case .eventsList: EventsView()
        case .boardLog(let thing): EventsView(thing: thing)
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
