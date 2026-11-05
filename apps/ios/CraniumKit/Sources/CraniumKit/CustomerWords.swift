import Foundation

/// The customer side's words (docs/mobile-apps.md, "Customers"): the customer site's own, from
/// cloud/web/src/customer/assets/customer-core.js and customer-views.js, which `CustomerWordsTests`
/// reads to hold every one of them to the site's. The few that only a phone says are in `phoneOnly`.
public enum CustomerWords {
    // MARK: Sections

    /// The site's sections, in its order: the tabs.
    public static let sections: [(id: String, label: String)] = [
        ("overview", "Overview"), ("devices", "Devices"), ("mixes", "Mixes"), ("account", "Account"), ("help", "Help"),
    ]

    public static let yourStudio = "Your studio"
    public static let adminMode = "Admin mode"
    public static let signOut = "Sign out"
    public static let signedIn = "Signed in"
    public static let tryAgain = "Try again"

    /// "Could not load your boards. " and then the message.
    public static func couldNotLoad(_ what: String) -> String { "Could not load \(what). " }
    public static func loading(_ what: String) -> String { "Loading \(what)…" }

    // MARK: A board

    /// "1.11.2", or "1.11.2, build 3" when the build is not 0.
    public static func shortVersion(_ text: String?) -> String {
        guard let text, let version = FirmwareVersion(release: text) else { return "" }
        let base = "\(version.major).\(version.minor).\(version.revision)"
        return version.build == 0 ? base : "\(base), build \(version.build)"
    }

    public static func boardTitle(_ board: CustomerBoard?) -> String {
        board?.name ?? "Your Cranium"
    }

    /// How a state looks: good, live or idle, and the site's icon name.
    public struct Status: Equatable, Sendable {
        public let tone: String
        public let icon: String
        public let label: String
        public let text: String
    }

    static let statusLooks: [String: (tone: String, icon: String, label: String)] = [
        "online": ("good", "online", "Online"),
        "updating": ("live", "download", "Updating"),
        "restarting": ("live", "restart", "Restarting"),
        "offline": ("idle", "offline", "Offline"),
        "new": ("idle", "clock", "Not heard from yet"),
    ]

    public static func status(_ board: CustomerBoard, now: Date) -> Status {
        let look = statusLooks[board.status] ?? statusLooks["offline"]!
        let seen = board.lastSeen.map { Words.timeAgo($0, now: now) } ?? ""
        let text: String
        switch board.status {
        case "online": text = "Connected, and reporting every 30 seconds."
        case "updating": text = "Installing an update that Cranium sent."
        case "restarting": text = "Restarting to finish an update. This takes a few minutes."
        case "offline":
            text = seen.isEmpty ? "Not heard from lately." : "Last heard from \(seen). It reports again once it is on and on Wi-Fi."
        case "new": text = "It has not reported yet. Switch it on and connect it to Wi-Fi."
        default: text = ""
        }
        return Status(tone: look.tone, icon: look.icon, label: look.label, text: text)
    }

    /// What a board's update says, in a sentence, or nil when there is nothing to say.
    public static func update(_ board: CustomerBoard) -> String? {
        guard let update = board.update else { return nil }
        switch update.state {
        case "awaiting_user": return "An update is waiting at the board: press Button 1 on it to install the update."
        case "downloading": return "Downloading an update: \(update.progress)% so far."
        case "verifying": return "Checking the update it has downloaded."
        case "rebooting": return "Restarting into the new firmware."
        case "testing": return "Trying the new firmware. If it cannot reach Cranium within 5 minutes, it goes back to the firmware it had."
        case "bluetooth": return "Its Bluetooth window is open, for an update from a phone."
        default:
            switch update.last {
            case "succeeded": return "The last update finished."
            case "failed": return "The last update did not finish, and the board kept the firmware it had."
            case "rolled_back": return "The last update did not stick, so the board went back to the firmware it had before."
            case "declined": return "The last update was declined at the board."
            case "refused": return "The board turned the last update down."
            case "cancelled": return "The last update was called off before it was installed."
            case "none": return "No update has run on it yet."
            default: return nil
            }
        }
    }

    /// Wi-Fi signal in a word, or "".
    public static func signal(_ rssi: Int?) -> String {
        Words.signalQuality(rssi)?.label ?? ""
    }

    /// How the boards stand, for the overview's figures.
    public struct Summary: Equatable, Sendable {
        public let total: Int
        public let online: Int
        public let busy: Int
        /// The versions they run, each once, in the order first met.
        public let versions: [String]
        public let lastSeen: String?
    }

    public static func summarize(_ boards: [CustomerBoard]) -> Summary {
        var versions: [String] = []
        for version in boards.compactMap({ $0.firmware?.version }) where !versions.contains(version) {
            versions.append(version)
        }
        let seen = boards.compactMap(\.lastSeen).sorted()
        return Summary(total: boards.count, online: boards.filter(\.online).count,
                       busy: boards.filter { $0.status == "updating" || $0.status == "restarting" }.count,
                       versions: versions, lastSeen: seen.last)
    }

    /// "2 of 3 online", "All 2 online", "Offline".
    public static func online(_ summary: Summary) -> String {
        if summary.total == 0 { return "No boards yet" }
        if summary.online == summary.total { return summary.total == 1 ? "Online" : "All \(summary.total) online" }
        if summary.online == 0 { return summary.total == 1 ? "Offline" : "All \(summary.total) offline" }
        return "\(summary.online) of \(summary.total) online"
    }

    /// One event in words: the site's icon name and the sentence.
    public static func event(_ event: CustomerEvent) -> (icon: String, text: String) {
        let v = event.version.map(shortVersion) ?? ""
        switch "\(event.kind) \(event.what)" {
        case "connection connected":
            return ("online", "Came online")
        case "connection disconnected":
            return ("offline", "Went offline")
        case "firmware reported":
            return ("chip", v.isEmpty ? "Reported its firmware" : "Running firmware \(v)")
        case "firmware changed":
            let moved = event.from.map { "Firmware went from \(shortVersion($0)) to \(v)" } ?? "Firmware is now \(v)"
            return ("package", moved + (event.confirmed == false ? ", on trial" : ""))
        case "firmware confirmed":
            return ("check", v.isEmpty ? "Kept its new firmware after its trial" : "Kept firmware \(v) after its trial")
        case "update step":
            if event.state == "awaiting_user" {
                return ("press", v.isEmpty ? "An update waits for Button 1" : "Update to \(v) waits for Button 1")
            }
            return ("download", v.isEmpty ? "Started downloading an update" : "Started downloading \(v)")
        case "update result":
            switch event.result {
            case "succeeded": return ("check-circle", v.isEmpty ? "An update finished" : "Update to \(v) finished")
            case "failed": return ("x-circle", "An update did not finish; the board kept its firmware")
            case "rolled_back": return ("undo", "An update did not stick; the board went back to its firmware")
            case "declined": return ("minus-circle", "An update was declined at the board")
            case "refused": return ("minus-circle", "The board turned an update down")
            case "cancelled": return ("stop", "An update was called off")
            default: return ("minus", "An update ended")
            }
        case "restart stuck":
            return ("restart", "Restarted itself to recover")
        case "restart restarted", "restart boot":
            return ("restart", "Restarted")
        case "bluetooth opened":
            return ("shield", "Opened its Bluetooth window for a phone")
        case "bluetooth closed":
            return ("shield", "Closed its Bluetooth window")
        case "bluetooth record":
            if event.result == "succeeded", let to = event.to {
                return ("check-circle", "Updated to \(shortVersion(to)) over Bluetooth")
            }
            return ("minus-circle", "An update over Bluetooth did not go through")
        default:
            return ("minus", "Something changed")
        }
    }

    /// Two letters for a person, from their name or their address.
    public static func initials(name: String?, email: String?) -> String {
        let source = (name?.isEmpty == false ? name! : (email ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
        if source.isEmpty { return "?" }
        let separators = CharacterSet(charactersIn: "@._-").union(.whitespaces)
        let words = source.components(separatedBy: separators).filter { !$0.isEmpty }
        let letters = words.count > 1 ? String(words[0].prefix(1)) + String(words[1].prefix(1)) : String(source.prefix(2))
        return letters.uppercased()
    }

    // MARK: Overview

    public static let overviewEyebrow = "Your boards, at a glance"
    public static func hello(_ name: String) -> String { name.isEmpty ? "Welcome back." : "Hello, \(name)." }
    public static let overviewLede = "How your Cranium is doing, and what it did lately."
    public static let yourBoards = "your boards"
    public static let whatTheyDid = "what your boards did"

    public static let onlineNow = "Online now"
    public static let boardsTile = "Boards"
    public static let firmwareTile = "Firmware"
    public static let lastHeardFrom = "Last heard from"
    public static func updatingNote(_ busy: Int) -> String { "\(Words.plural(busy, "board")) updating" }
    public static let reportsNote = "Each board reports every 30 s"
    public static let onYourAccount = "On your account"
    public static let notSameNote = "Not every board is on the same one"
    public static let keptUpNote = "Kept up to date by Cranium"
    public static let noReportYet = "No report yet"
    public static let dash = "—"

    /// The figure of the tile "Online now".
    public static func onlineFigure(_ summary: Summary) -> String {
        summary.total == 0 ? "0" : "\(summary.online) of \(summary.total)"
    }

    /// The figure of the tile "Firmware".
    public static func firmwareFigure(_ summary: Summary) -> String {
        switch summary.versions.count {
        case 0: return dash
        case 1: return shortVersion(summary.versions[0])
        default: return Words.plural(summary.versions.count, "version")
        }
    }

    public static let yourBoardsTitle = "Your boards"
    public static let allDevices = "All devices"
    public static let noBoardsTitle = "No boards on your account yet."
    public static let noBoardsText = "Once Cranium gives you a board, it shows here."
    public static let lately = "Lately"
    public static let nothingThisWeek = "Nothing in the last week."
    public static func firmwareLine(_ board: CustomerBoard) -> String {
        board.firmware.map { "Firmware \(shortVersion($0.version))" } ?? "Firmware not reported"
    }
    public static let heardFrom = "Heard from "
    public static let notHeardYet = "Not heard from yet"
    public static let aBoard = "A board"

    public static let teaserEyebrow = "After the last track"
    public static let teaserTitle = "Good mixes happen. Great ones get remembered."
    public static let teaserText = "Your sessions, your transitions and the tracks you keep coming back to will live here, once your board " +
        "can tell this site what you played. That part is not built yet."
    public static let teaserLink = "What is coming"

    // MARK: The admin's overview

    public static let adminEyebrow = "Admin"
    public static let adminTitle = "Signed in as an admin."
    public static func adminLede(email: String, canWrite: Bool) -> String {
        "\(email) · \(canWrite ? "release manager" : "viewer")"
    }
    public static let adminLedeUnknown = "Your account on the console."
    public static let adminPanelTitle = "The console, for every board."
    public static let adminPanelText = "Admin mode opens the firmware console here, with the sign-in you just made: the boards, firmware, " +
        "deployments, the activity log, and the Customers page, where you invite customers and give them their boards."
    public static let openAdminMode = "Open admin mode"
    public static let whatCustomersSee = "What customers see"
    public static let whatCustomersSeeText = "A customer signs in on this site with the account you invite them to, and sees their own boards: whether each " +
        "is online, the firmware it runs, when it was last heard from and how its updates went. Never another " +
        "customer, the activity log, firmware or anything of AWS."

    // MARK: Devices and a board

    public static let devicesLede = "Every Cranium on your account, as it last reported."
    public static let boardColumn = "Board"
    public static let stateColumn = "State"
    public static let updateColumn = "Update"
    public static let theBoard = "the board"
    public static func boardEyebrow(_ board: CustomerBoard) -> String {
        if let device = board.boardName, device != board.name { return "Board \(device)" }
        return "Board"
    }
    public static let notYoursTitle = "There is no board of yours here."
    public static let notYoursText = "It may have been moved to another account."
    public static let howItIs = "How it is"
    public static let onTrial = "On trial"
    public static let notReportedYet = "Not reported yet"
    public static let notYet = "Not yet"
    public static let wifiSignal = "Wi-Fi signal"
    public static let notReported = "Not reported"
    public static let runningFor = "Running for"
    public static let location = "Location"
    public static let locationNotReported = "Not reported: boards cannot tell where they are yet."
    public static let yoursSince = "Yours since"
    public static let updatesNote = "Cranium sends firmware updates, signed, and the board checks each one before it keeps it. " +
        "There is nothing for you to do; a board installs an update while it is on and online."
    public static let whatItDid = "What it did"
    public static let nothingThisMonth = "Nothing in the last 30 days."

    // MARK: Mixes

    public static let mixTabs = ["sessions", "transitions", "library", "moments"]
    public static let mixes: [String: (label: String, title: String, text: String)] = [
        "sessions": ("Sessions", "Every set has a story.",
                     "Each time you play, a session: when it started, how long it ran, and the tracks in the order you played them, deck by deck."),
        "transitions": ("Transitions", "The space between tracks.",
                        "Which tracks you put together, and how long both decks played at once."),
        "library": ("Track library", "Your rotation, revealed.",
                    "The tracks you keep coming back to, across every session, ranked by how often you play them."),
        "moments": ("Saved moments", "Keep the good ones.",
                    "A note on a transition worth trying again, kept with your account for your next set."),
    ]
    public static let mixesEyebrow = "Your mixes, remembered"
    public static let mixesTitle = "Find your next great mix."
    public static let mixesLede = "A home for the tracks, the transitions and the happy accidents of every set."
    public static let notBuiltYet = "Not built yet"
    public static let mixesWhy = "Why it is empty: your board does not send what you play. That needs the Raspberry Pi to record the tracks Mixxx " +
        "plays and the board to pass them on, and neither is built yet. Nothing here is made up in the meantime."
    public static let mixesNote = "When it is built, only what you played is kept: track names and times, never the music itself."

    // MARK: Account

    public static let accountTitle = "Your account"
    public static let accountLede = "Your sign-in, and how it is protected."
    public static let yourAccount = "your account"
    public static let signedInAs = "Signed in as"
    public static let email = "E-mail"
    public static let name = "Name"
    public static let notGiven = "Not given"
    public static let session = "Session"
    public static let emailNote = "Your e-mail address is your sign-in name. To change it, ask Cranium."
    public static let password = "Password"
    public static let currentPassword = "Current password"
    public static let newPassword = "New password"
    public static let newPasswordAgain = "New password again"
    public static let newPasswordHint = "At least 10 characters. A few words in a row make a good one."
    public static let changePassword = "Change password"
    public static let saving = "Saving…"
    public static let passwordChanged = "Your password is changed."
    public static let twoStep = "Two-step sign-in"
    public static let on = "On"
    public static let off = "Off"
    public static let twoStepOnText = "Each sign-in asks for your password and a code from your authenticator app."
    public static let twoStepOffText = "Ask for a code from an authenticator app on your phone at each sign-in, as well as your password. " +
        "Someone who learns your password still cannot sign in."
    public static let turnOn = "Turn on"
    public static let starting = "Starting…"
    public static let turnOff = "Turn off"
    public static let setupStep1 = "Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password, and add an account."
    public static let setupStep2 = "Choose to enter a setup key, and type this one. Its time-based codes are what Cranium asks for."
    public static let setupStep3 = "Type the six digits the app shows now."
    public static let copyKey = "Copy the key"
    public static let openAuthenticator = "Open in an authenticator app on this phone"
    public static let codeFromApp = "Code from your authenticator app"
    public static let newCodeHint = "A new code comes every 30 seconds."
    public static let turnOnTwoStep = "Turn on two-step sign-in"
    public static let checking = "Checking…"
    public static let notNow = "Not now"
    public static let offWarning = "Sign-in will ask for your password only. Anyone who learns it can then sign in as you."
    public static let turnItOff = "Turn it off"
    public static let turningOff = "Turning it off…"
    public static let keepItOn = "Keep it on"
    public static let twoStepIsOn = "Two-step sign-in is on. From your next sign-in, Cranium asks for a code too."
    public static let twoStepIsOff = "Two-step sign-in is off."
    public static let keyCopied = "The setup key is copied."
    public static func setupKeyLabel(_ grouped: String) -> String {
        "Setup key \(grouped.map(String.init).joined(separator: " "))"
    }

    // MARK: Help

    public static let helpEyebrow = "Help and support"
    public static let helpTitle = "How can we help?"
    public static let helpLede = "Answers about your board, its updates and your account."
    public static let help: [(section: String, items: [(question: String, answer: String)])] = [
        ("Your board", [
            ("What does Online mean?", "A board that is on and connected reports to Cranium every 30 seconds. It counts as online for 90 seconds after a report, so a board that was just switched off still shows online for a moment, and then offline."),
            ("My board shows Offline.", "Check that it is switched on and that its Wi-Fi works. It reports again within 30 seconds of getting back online. A board that is restarting after an update can be quiet for a few minutes."),
            ("What is the name of my board?", "The name Cranium gave it when it was put on your account. Its own device name, which it was set up with, is shown beside it when it is different."),
        ]),
        ("Updates", [
            ("Do I have to update my board?", "No. Cranium sends firmware updates, and the board installs them while it is on and online. You can watch it happen on the board's page."),
            ("Is an update safe?", "Every update is signed by Cranium, and the board checks the signature before it installs it. A new update runs on trial: if it cannot reach Cranium within 5 minutes, the board goes back to the firmware it had, by itself."),
            ("My board says it waits for Button 1.", "Older firmware asks for a press of Button 1 on the board before it installs an update. Press it, and the update goes ahead."),
        ]),
        ("Your account", [
            ("How do I get an account?", "Cranium makes it and e-mails you an invitation with a temporary password. There is no sign-up. The first time you sign in, you choose your own password."),
            ("I forgot my password.", "Choose \"Forgot your password?\" on the sign-in page. Cranium e-mails a code to your address, and you choose a new password with it."),
            ("How do I make my account safer?", "Turn on two-step sign-in on your Account page. Each sign-in then also asks for a code from an authenticator app on your phone."),
            ("Who can see my boards?", "You, and the people at Cranium who look after the boards. No other customer can."),
        ]),
        ("Your mixes", [
            ("Where are my sessions and tracks?", "Not here yet. Your board does not send what you play: that is being built. Until it is, the Mixes page says so instead of showing anything made up."),
        ]),
    ]
    public static let stillStuck = "Still stuck?"
    public static let stillStuckText = "A support address for customers is not set up yet. Until it is, ask the person at Cranium who gave you your account."

    // MARK: Signing in

    public static let signInTitle = "Sign in"
    public static let adminSignInTitle = "Admin sign-in"
    public static let codeTitle = "Enter the code"
    public static let newPasswordTitle = "Choose your password"
    public static let elsewhereTitle = "One more step"
    public static let signInLead = "With the e-mail address and the password of your Cranium account."
    public static let adminSignInLead = "With your Cranium team account: your e-mail address, your password and the code from your authenticator app."
    public static let newPasswordLead = "Welcome. Your invitation's password works once: choose your own now."
    public static let elsewhereLead = "Your account needs a new password first. Choose one with \"Forgot your password?\"."
    public static let chooseNewPassword = "Choose a new password"
    public static let emailAddress = "E-mail address"
    public static let next = "Continue"
    public static let forgot = "Forgot your password?"
    public static let signIn = "Sign in"
    public static let startAgain = "Start again"
    public static let codeHint = "The six digits it shows now. The code goes in by itself once the last digit is typed."
    public static let firstPasswordHint = "At least 10 characters."
    public static let saveAndSignIn = "Save and sign in"
    public static let customerSignIn = "Customer sign-in"
    public static let adminSignIn = "Admin sign-in"
    public static let gateFoot = "See your boards, how they are and what they did."
    public static let adminGateFoot = "For the Cranium team: the same account as on the firmware console, with its code."
    public static func signingInAs(_ email: String) -> String { "Signing in as \(email)." }

    public static let forgotTitle = "A new password"
    public static let doneTitle = "Done"
    public static let forgotLead = "Type the address you sign in with. Cranium e-mails a code to it, and you choose a new password with the code."
    public static let sendCode = "Send me a code"
    public static let sending = "Sending…"
    public static func codeOnItsWay(_ email: String) -> String {
        "If \(email) has an account, a code is on its way to it. It can take a minute."
    }
    public static let codeFromEmail = "Code from the e-mail"
    public static let codeFromEmailHint = "Six digits, in the e-mail from Cranium."
    public static let setNewPassword = "Set the new password"
    public static let sendAnother = "Send another code"
    public static let passwordChangedSignIn = "Your password is changed. Sign in with it now."
    public static let backToSignIn = "Back to sign-in"
    public static let sessionEnded = "Your session has ended. Sign in again to carry on."
    public static let adminSessionEnded = "Your admin session has ended. Sign in again to carry on."

    // MARK: Only on a phone

    /// The console's own words for the way back from admin mode (views.js).
    public static let leaveAdminMode = "Leave admin mode"
    /// What the phone says where the site's words are about tabs and pages, and about this build.
    public static let signOutText = "Ends your session on this phone."
    public static let notSetUp = "Customer sign-in is not set up in this build. Run apps/configure.sh once the stack has the customer pool, then build again."
    public static func sessionLine(biometry: Biometry?) -> String {
        if let biometry { return "Opens with \(biometry.name) for up to 30 days from your sign-in" }
        return "About an hour from your sign-in, then sign in again"
    }
    public static func biometricOffer(_ biometry: Biometry) -> String {
        "Cranium then opens with \(biometry.name) for up to 30 days, instead of your password."
    }
    public static func biometricFooter(_ biometry: Biometry) -> String {
        "Open Cranium with \(biometry.name) for up to 30 days, instead of your password."
    }
    public static let noAuthenticatorApp = "No app on this phone opens it. Copy the key and type it into your authenticator app."
    public static func biometricNeedsSignIn(_ biometry: Biometry) -> String {
        "Sign out and sign in again, then turn on \(biometry.name)."
    }
    public static let accountUnreadable = "Your account could not be read."
    public static let accountSessionEnded = "Your session has ended."

    /// Every line above that the site does not have, for `CustomerWordsTests`.
    public static let phoneOnly: [String] = [signOutText, notSetUp, noAuthenticatorApp]
}
