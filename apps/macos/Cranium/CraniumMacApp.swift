import AppKit
import CraniumKit
import SwiftUI

/// The Cranium Mac app (docs/mac-app.md): the firmware console and the customer side as native
/// windows, with Touch ID, live updates, a Bluetooth update and the board's serial console.
@main
struct CraniumMacApp: App {
    @StateObject private var session = MacSession()

    var body: some Scene {
        WindowGroup("Cranium", id: "main") {
            RootView()
                .environmentObject(session)
                .environmentObject(session.app)
                .environmentObject(session.customer)
                .frame(minWidth: 860, minHeight: 540)
        }
        .defaultSize(width: 1180, height: 760)
        .commands { CraniumCommands(session: session) }

        // A board in a window of its own: double-click a board, or Board > Open in New Window.
        WindowGroup("Board", id: "board", for: BoardWindowID.self) { $board in
            BoardWindow(board: board)
                .environmentObject(session)
                .environmentObject(session.app)
                .environmentObject(session.customer)
                .frame(minWidth: 560, minHeight: 480)
        }
        .defaultSize(width: 720, height: 680)

        Settings {
            SettingsView()
                .environmentObject(session)
                .environmentObject(session.app)
                .environmentObject(session.customer)
        }
    }
}

/// The menu bar: View > each section with ⌘1…, Refresh with ⌘R, the account's sign-out.
struct CraniumCommands: Commands {
    @ObservedObject var session: MacSession

    var body: some Commands {
        SidebarCommands()
        ToolbarCommands()
        CommandGroup(replacing: .newItem) {}
        CommandGroup(after: .sidebar) {
            Divider()
            ForEach(TeamSection.allCases) { section in
                if let key = section.shortcut {
                    Button(section.title) { session.teamSection = section }
                        .keyboardShortcut(KeyEquivalent(key), modifiers: .command)
                        .disabled(!session.teamShown || !TeamSection.visible(canWrite: session.app.canWrite).contains(section))
                }
            }
        }
        CommandMenu("Console") {
            Button("Refresh") { session.refreshNow() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(!session.signedInShown)
            Divider()
            Button("Lock Now") { session.lockNow() }
                .keyboardShortcut("l", modifiers: [.command, .control])
                .disabled(!session.canLockNow)
            Button("Sign Out") { Task { await session.signOut() } }
                .disabled(!session.signedInShown)
        }
        CommandGroup(replacing: .help) {
            Button("Cranium Help") { session.showHelp() }
                .keyboardShortcut("?", modifiers: .command)
        }
    }
}

/// Everything the windows share besides the two models: which side and section is on screen, the live
/// socket, the Mac's own events (another app in front, sleep, the screen locked), and the signal that
/// a live change came in, which every page that is open reads again on.
@MainActor
final class MacSession: ObservableObject {
    let app = AppModel()
    let customer = CustomerModel()

    @Published var teamSection: TeamSection? = .overview
    @Published var customerSection: CustomerSection? = .boards
    /// Goes up by one for each live change (or burst of changes); the pages read again on it.
    @Published private(set) var changes = 0
    /// The newest change, for a board's page to tell whether it is about its board.
    @Published private(set) var lastChange: LiveChange?
    /// For a manual refresh (⌘R): the pages read again in full.
    @Published private(set) var refreshes = 0
    @Published private(set) var liveState: LiveClient.State = .off
    @Published private(set) var started = false

    private var live: LiveClient?
    private var liveSide: Side?
    private var debounce: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var stateWatch: Task<Void, Never>?

    enum Side: Equatable {
        case team
        case customer
    }

    /// The team's console is on screen (not the customer side).
    var teamShown: Bool { customer.adminMode }
    var signedInShown: Bool { teamShown ? app.stage == .signedIn : customer.stage == .signedIn }
    var canLockNow: Bool {
        teamShown ? (app.stage == .signedIn && app.lock?.isOn == true) : (customer.stage == .signedIn && customer.lock?.isOn == true)
    }

    func start() async {
        guard !started else { return }
        started = true
        observeTheMac()
        #if DEBUG
        // `-CraniumSnapshot YES`: a picture of the window, 3 s after launch, in the app's temporary folder.
        // For the docs' screenshots, where the screen itself may not be recorded.
        if UserDefaults.standard.bool(forKey: "CraniumSnapshot") {
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                MacSession.snapshotKeyWindow()
            }
        }
        #endif
        await app.start()
        await customer.start(admin: app)
        // Each change of who is on screen, and of the lock, decides the live socket.
        stateWatch = Task { [weak self] in
            while !Task.isCancelled {
                self?.updateLive()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    // MARK: Live updates

    private var liveURL: URL? { (try? CraniumConfig.load(from: .main))?.config.liveURL }

    /// One socket, for the side on screen while it is signed in and unlocked; none otherwise.
    func updateLive() {
        let wanted: Side?
        if teamShown {
            wanted = app.stage == .signedIn && app.cover == nil ? .team : nil
        } else {
            wanted = customer.stage == .signedIn && customer.cover == nil ? .customer : nil
        }
        if wanted == liveSide {
            if let live, liveState != live.state { liveState = live.state }
            return
        }
        live?.stop()
        live = nil
        liveSide = wanted
        guard let wanted, let url = liveURL else {
            liveState = .off
            return
        }
        let client = LiveClient(url: url, token: { [weak self] in
            guard let self else { return nil }
            return wanted == .team ? await self.app.liveToken() : await self.customer.liveToken()
        }, onChange: { [weak self] change in
            self?.heard(change)
        })
        live = client
        client.start()
        liveState = client.state
    }

    /// A burst of changes is one read: the console's pages wait 300 ms the same way (live.js).
    private func heard(_ change: LiveChange) {
        lastChange = change
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            self?.changes += 1
        }
    }

    func refreshNow() {
        refreshes += 1
    }

    // MARK: The Mac's events

    private func observeTheMac() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                await self?.app.wentAway()
                await self?.customer.wentAway()
            }
        })
        observers.append(center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                await self?.app.becameActive()
                await self?.customer.becameActive()
            }
        })
        let sleeping: [(NotificationCenter, Notification.Name)] = [
            (NSWorkspace.shared.notificationCenter, NSWorkspace.willSleepNotification),
            (NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidSleepNotification),
            (DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsLocked")),
        ]
        for (center, name) in sleeping {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.macSlept() }
            })
        }
    }

    private func macSlept() {
        guard MacLockPreferences.load().lockWhenMacSleeps else { return }
        app.lockNow()
        customer.lockNow()
    }

    func lockNow() {
        if teamShown { app.lockNow() } else { customer.lockNow() }
    }

    func setRelock(_ choice: RelockChoice) {
        var preferences = MacLockPreferences.load()
        preferences.relock = choice
        preferences.save()
        app.setRelock(choice)
        customer.setRelock(choice)
    }

    func signOut() async {
        if teamShown {
            await app.signOut()
        } else {
            await customer.signOutEverything(admin: app)
        }
    }

    #if DEBUG
    static func snapshotKeyWindow() {
        guard let window = NSApplication.shared.windows.first(where: { $0.isVisible && $0.contentView != nil }),
              let view = window.contentView?.superview ?? window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cranium-window.png")
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        print("snapshot: \(url.path)")
    }
    #endif

    func showHelp() {
        if teamShown {
            teamSection = .help
        } else {
            customerSection = .help
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
