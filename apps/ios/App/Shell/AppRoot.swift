import SwiftUI
import UIKit

/// From 0.8.0 the app is a shell around the console's own pages (docs/mobile-apps.md, "The app shell"), and
/// the screens of 0.7 are the "Classic app", kept for this one version behind a switch: in the shell's
/// settings, and as a Home Screen quick action. The shell is the default.
struct AppRoot: View {
    @ObservedObject private var choice = ShellChoice.shared

    var body: some View {
        Group {
            if choice.showsClassic {
                ClassicRoot()
                    // A fresh classic app each time it is chosen: it reads the sign-in the shell may have changed.
                    .id(choice.generation)
            } else {
                ShellRoot()
                    .id(choice.generation)
            }
        }
        .onAppear { choice.updateShortcuts() }
    }
}

/// The classic app: the native screens of 0.7, as they were, with a line on top that leads back.
struct ClassicRoot: View {
    @StateObject private var model = AppModel()
    /// The customer side, and which side is on screen (docs/mobile-apps.md, "Customers").
    @StateObject private var customer = CustomerModel()
    @ObservedObject private var choice = ShellChoice.shared

    var body: some View {
        VStack(spacing: 0) {
            ClassicBanner(reason: choice.forcedReason) { choice.useShell() }
            RootView()
                .environmentObject(model)
                .environmentObject(customer)
        }
    }
}

struct ClassicBanner: View {
    let reason: String?
    let back: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(reason.map { "Classic app. \($0)" } ?? "Classic app: the screens of 0.7, for this version only.")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.page.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(reason == nil ? "New app" : "Try again", action: back)
                .font(.footnote.weight(.bold))
                .accessibilityIdentifier("classic-back")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.page.accentWash)
    }
}

/// Which app is on screen. Kept in UserDefaults (`cranium.shell.classic`); off by default.
@MainActor
final class ShellChoice: ObservableObject {
    static let shared = ShellChoice()
    static let key = "cranium.shell.classic"
    static let classicAction = "com.craniumiot.cranium.classic"
    static let shellAction = "com.craniumiot.cranium.shell"

    /// The person chose the classic app.
    @Published private(set) var classic: Bool
    /// The shell could not start: the classic app, for this run only, saying why.
    @Published private(set) var forcedReason: String?
    /// Changes each time the choice does, so that the side on screen starts afresh.
    @Published private(set) var generation = 0

    var showsClassic: Bool { classic || forcedReason != nil }

    private init() {
        classic = UserDefaults.standard.bool(forKey: Self.key)
    }

    func useClassic() {
        UserDefaults.standard.set(true, forKey: Self.key)
        classic = true
        generation += 1
        updateShortcuts()
    }

    func useShell() {
        UserDefaults.standard.set(false, forKey: Self.key)
        classic = false
        forcedReason = nil
        generation += 1
        updateShortcuts()
    }

    /// No bundle at all could be loaded.
    func fallBack(_ reason: String) {
        forcedReason = reason
        generation += 1
    }

    /// From a Home Screen quick action.
    func perform(_ type: String) {
        if type == Self.classicAction, !classic { useClassic() }
        if type == Self.shellAction, showsClassic { useShell() }
    }

    /// The quick action that leads to the other app: "Classic app" is in Info.plist; "New app" is added here
    /// while the classic one is on.
    func updateShortcuts() {
        UIApplication.shared.shortcutItems = classic
            ? [UIApplicationShortcutItem(type: Self.shellAction, localizedTitle: "New app", localizedSubtitle: nil,
                                         icon: UIApplicationShortcutIcon(systemImageName: "globe"), userInfo: nil)]
            : []
    }
}

/// Quick actions arrive at the scene: at launch, and while the app runs.
final class CraniumAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem {
            let type = item.type
            Task { @MainActor in ShellChoice.shared.perform(type) }
        }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = CraniumSceneDelegate.self
        return configuration
    }
}

final class CraniumSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let type = shortcutItem.type
        Task { @MainActor in
            ShellChoice.shared.perform(type)
            completionHandler(true)
        }
    }
}
