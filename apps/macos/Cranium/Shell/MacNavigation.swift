import CraniumKit
import Foundation

/// What the Mac app's web view may do with an address. The rules are the iPhone app's (`ShellPolicy`, in
/// CraniumKit): only the bundle's own origin loads in the view, in the main frame; an https address goes
/// to the browser; anything else is dropped. Web Serial is not in WebKit, so the Serial console and Board
/// setup pages are left out here as on the iPhone.
enum MacNavigation {
    enum Decision: Equatable {
        case load
        case browser(URL)
        case drop
    }

    static func decide(_ url: URL, mainFrame: Bool, newWindow: Bool, console: URL?) -> Decision {
        switch ShellPolicy.navigation(to: url, mainFrame: mainFrame, newWindow: newWindow, console: console) {
        case .allow: return .load
        case .openOutside(let outside): return .browser(outside)
        case .drop: return .drop
        }
    }
}
