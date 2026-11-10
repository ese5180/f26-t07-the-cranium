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
    }
}

/// The menu bar: View > Back, Forward, Reload (and, in a Debug build, Developer Tools); Console > Lock Now.
struct CraniumCommands: Commands {
    @ObservedObject var model: MacShellModel

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .newItem) {}
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
        CommandMenu("Console") {
            Button("Lock Now") { Task { await model.lockNow() } }
                .keyboardShortcut("l", modifiers: [.command, .control])
            Button("App Settings") { model.showSettings = true }
                .keyboardShortcut(",", modifiers: .command)
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
