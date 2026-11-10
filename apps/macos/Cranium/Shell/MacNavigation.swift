import CraniumKit
import Foundation

/// What the Mac app's web view may do with an address. The rules are the iPhone app's (`ShellPolicy`, in
/// CraniumKit): only the bundle's own origin loads in the view, in the main frame; an https address goes
/// to the browser; anything else is dropped. The Serial console and Board setup pages, which ShellPolicy
/// leaves out for the iPhone, load here: the app's bridge gives them the Mac's serial ports (MacSerial).
enum MacNavigation {
    enum Decision: Equatable {
        case load
        case browser(URL)
        case drop
    }

    static func decide(_ url: URL, mainFrame: Bool, newWindow: Bool, console: URL?) -> Decision {
        if !newWindow, mainFrame, ShellPolicy.isBundle(url), ShellPolicy.isExcludedPage(url) { return .load }
        switch ShellPolicy.navigation(to: url, mainFrame: mainFrame, newWindow: newWindow, console: console) {
        case .allow: return .load
        case .openOutside(let outside): return .browser(outside)
        case .drop: return .drop
        }
    }
}
