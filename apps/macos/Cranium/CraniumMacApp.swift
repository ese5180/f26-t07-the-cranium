import AppKit
import CraniumKit
import SwiftUI

/// The Cranium Mac app (docs/mac-app.md): the console's own pages and the customer site's, from the bundle the
/// iPhone and desktop apps host (cloud/web/build-bundle.mjs), in a web view, with the Mac's own parts around
/// them: the window and menus, Touch ID on the saved sign-in, Bluetooth for a firmware update.
@main
struct CraniumMacApp: App {
    @StateObject private var model = MacShellModel()

    var body: some Scene {
        Window("Cranium", id: "main") {
            MacShellRoot(model: model)
                .frame(minWidth: 860, minHeight: 540)
        }
        .defaultSize(width: 1280, height: 860)
        .commands { CraniumCommands(model: model) }

        // A board in a window of its own: Console > Open Board in New Window, from a board's page.
        WindowGroup("Board", id: "board", for: String.self) { $thing in
            MacBoardWindow(thing: thing)
                .frame(minWidth: 640, minHeight: 480)
        }
        .defaultSize(width: 900, height: 760)
    }
}

/// A board's page in its own window, with a web view and a shell of its own.
struct MacBoardWindow: View {
    @StateObject private var model: MacShellModel

    init(thing: String?) {
        _model = StateObject(wrappedValue: MacShellModel(startURL: thing.flatMap(MacShellModel.boardURL)))
    }

    var body: some View {
        MacShellRoot(model: model)
    }
}

/// The menu bar. App: Settings in its usual place (Command-,). View: Back, Forward, Reload (and, in a Debug build,
/// Developer Tools). Go: the console's sections, Command-1 to Command-9. Console: Open Board in New Window, Lock Now,
/// Sign Out. Help: Cranium Help (Command-?), the customer site's Help page.
struct CraniumCommands: Commands {
    @ObservedObject var model: MacShellModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {}
        CommandGroup(replacing: .appSettings) {
            Button("Settings\u{2026}") { model.showSettings = true }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(after: .toolbar) {
            Button("Back") { model.goBack() }
                .keyboardShortcut("[", modifiers: .command)
            Button("Forward") { model.goForward() }
                .keyboardShortcut("]", modifiers: .command)
            Button("Reload") { Task { await model.reload() } }
                .keyboardShortcut("r", modifiers: .command)
            Button("Look for Newer Pages") { Task { await model.checkForUpdate(force: true) } }
            #if DEBUG
            Divider()
            Button("Developer Tools") { model.showDeveloperTools() }
                .keyboardShortcut("i", modifiers: [.command, .option])
            #endif
        }
        CommandMenu("Go") {
            ForEach(Array(MacRoutes.shortcuts.enumerated()), id: \.element.route) { index, section in
                if let key = MacRoutes.key(at: index) {
                    Button(section.title) { model.go(to: section.route) }
                        .keyboardShortcut(KeyEquivalent(key), modifiers: .command)
                }
            }
            Divider()
            ForEach(MacRoutes.others, id: \.route) { section in
                Button(section.title) { model.go(to: section.route) }
            }
        }
        CommandMenu("Console") {
            Button("Open Board in New Window") {
                if let thing = model.boardThing { openWindow(id: "board", value: thing) }
            }
            .disabled(model.boardThing == nil)
            Divider()
            Button("Lock Now") { Task { await model.lockNow() } }
                .keyboardShortcut("l", modifiers: [.command, .control])
            Button("Sign Out") { Task { await model.signOutEverywhere() } }
        }
        CommandGroup(replacing: .help) {
            Button("Cranium Help") { model.go(to: "help", customer: true) }
                .keyboardShortcut("?", modifiers: .command)
        }
    }
}

#if DEBUG
extension MacShellModel {
    /// The web inspector of this build (Debug only; the view is inspectable for Safari's Develop menu as
    /// well). Uses WebKit's inspector object when the system has it.
    func showDeveloperTools() {
        guard let webView, let inspector = webView.value(forKey: "_inspector") as? NSObject else { return }
        let show = NSSelectorFromString("show")
        if inspector.responds(to: show) { _ = inspector.perform(show) }
    }
}
#endif
