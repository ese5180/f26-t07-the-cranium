import Foundation
import Testing
@testable import CraniumKit

/// The customer side's words against the customer site's own sources in this checkout
/// (cloud/web/src/customer/assets/customer-core.js and customer-views.js, and the console's
/// views.js and core.js), so that the app and the site cannot drift apart: every line the app
/// shows a customer is the site's, but for the few that only a phone says.
@Suite struct CustomerWordsTests {
    static let repository = ConfigTests.configDir.deletingLastPathComponent().deletingLastPathComponent()

    static func source(_ path: String) throws -> String {
        try String(contentsOf: repository.appendingPathComponent(path), encoding: .utf8)
    }

    /// The sources as their strings read: a string split over lines joined again, and \' as '.
    static func site() throws -> String {
        let text = try ["cloud/web/src/customer/assets/customer-core.js", "cloud/web/src/customer/assets/customer-views.js",
                        "cloud/web/src/customer/assets/customer.js", "cloud/web/src/site/assets/views.js"]
            .map(source).joined(separator: "\n")
        let joined = try NSRegularExpression(pattern: "'\\s*\\+\\s*\\n\\s*'")
            .stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
        return joined.replacingOccurrences(of: "\\'", with: "'")
    }

    /// `NAME = Object.freeze({ key: 'words', ... })` of a source, as a map.
    static func map(_ source: String, _ name: String) throws -> [String: String] {
        let start = try #require(source.range(of: "\(name) = Object.freeze({"))
        let end = try #require(source.range(of: "});", range: start.upperBound..<source.endIndex))
        let body = String(source[start.upperBound..<end.lowerBound])
        let pattern = try NSRegularExpression(pattern: "'?([A-Za-z_0-9-]+)'?: '((?:[^'\\\\]|\\\\.)*)'")
        var found: [String: String] = [:]
        for match in pattern.matches(in: body, range: NSRange(body.startIndex..., in: body)) {
            found[String(body[Range(match.range(at: 1), in: body)!])] =
                String(body[Range(match.range(at: 2), in: body)!]).replacingOccurrences(of: "\\'", with: "'")
        }
        return found
    }

    @Test func theAccountWordsAreTheSitesEveryOne() throws {
        let site = try Self.map(Self.source("cloud/web/src/customer/assets/customer-core.js"), "export const ACCOUNT_WORDS")
        #expect(site.count == AccountProblem.allCases.count)
        #expect(site == Dictionary(uniqueKeysWithValues: AccountProblem.allCases.map { ($0.rawValue, $0.words) }))
    }

    @Test func theSignInWordsAreTheSitesEveryOne() throws {
        let site = try Self.map(Self.source("cloud/web/src/site/assets/core.js"), "export const SIGN_IN_WORDS")
        #expect(site == Dictionary(uniqueKeysWithValues: SignInProblem.allCases.map { ($0.rawValue, $0.words) }))
    }

    /// Every line of the screens, as the site writes it.
    static let lines: [String] = {
        let w = CustomerWords.self
        var all = [
            w.yourStudio, w.adminMode, w.signOut, w.signedIn, w.tryAgain,
            w.overviewEyebrow, w.overviewLede, w.yourBoards, w.whatTheyDid, w.onlineNow, w.boardsTile, w.firmwareTile,
            w.lastHeardFrom, w.reportsNote, w.onYourAccount, w.notSameNote, w.keptUpNote, w.noReportYet, w.dash,
            w.yourBoardsTitle, w.allDevices, w.noBoardsTitle, w.noBoardsText, w.lately, w.nothingThisWeek, w.heardFrom,
            w.notHeardYet, w.aBoard, w.teaserEyebrow, w.teaserTitle, w.teaserText, w.teaserLink,
            w.adminEyebrow, w.adminTitle, w.adminLedeUnknown, w.accountUnreadable, w.accountSessionEnded, w.adminPanelTitle, w.adminPanelText, w.openAdminMode, w.whatCustomersSee,
            w.whatCustomersSeeText,
            w.devicesLede, w.boardColumn, w.stateColumn, w.updateColumn, w.theBoard, w.notYoursTitle, w.notYoursText, w.howItIs,
            w.onTrial, w.notReportedYet, w.notYet, w.wifiSignal, w.notReported, w.runningFor, w.location, w.locationNotReported,
            w.yoursSince, w.updatesNote, w.whatItDid, w.nothingThisMonth,
            w.mixesEyebrow, w.mixesTitle, w.mixesLede, w.notBuiltYet, w.mixesWhy, w.mixesNote,
            w.accountTitle, w.accountLede, w.yourAccount, w.signedInAs, w.email, w.name, w.notGiven, w.session, w.emailNote,
            w.password, w.currentPassword, w.newPassword, w.newPasswordAgain, w.changePassword, w.saving,
            w.passwordChanged, w.twoStep, w.on, w.off, w.twoStepOnText, w.twoStepOffText, w.turnOn, w.starting, w.turnOff,
            w.setupStep1, w.setupStep2, w.setupStep3, w.copyKey, w.openAuthenticator, w.codeFromApp, w.newCodeHint,
            w.turnOnTwoStep, w.checking, w.notNow, w.offWarning, w.turnItOff, w.turningOff, w.keepItOn, w.twoStepIsOn,
            w.twoStepIsOff, w.keyCopied,
            w.helpEyebrow, w.helpTitle, w.helpLede, w.stillStuck, w.stillStuckText,
            w.signInTitle, w.adminSignInTitle, w.codeTitle, w.newPasswordTitle, w.elsewhereTitle, w.signInLead,
            w.adminSignInLead, w.newPasswordLead, w.elsewhereLead, w.chooseNewPassword, w.emailAddress, w.next, w.forgot,
            w.signIn, w.startAgain, w.codeHint, w.saveAndSignIn, w.customerSignIn, w.adminSignIn,
            w.gateFoot, w.adminGateFoot, w.forgotTitle, w.doneTitle, w.forgotLead, w.sendCode, w.sending, w.codeFromEmail,
            w.codeFromEmailHint, w.setNewPassword, w.sendAnother, w.passwordChangedSignIn, w.backToSignIn, w.sessionEnded,
            w.adminSessionEnded, w.leaveAdminMode,
        ]
        all += w.sections.map(\.label)
        for tab in w.mixTabs {
            let words = w.mixes[tab]!
            all += [words.label, words.title, words.text]
        }
        for (section, items) in w.help {
            all.append(section)
            for (question, answer) in items { all += [question, answer] }
        }
        return all
    }()

    @Test func everyLineOfTheScreensIsTheSites() throws {
        let site = try Self.site()
        for line in Self.lines {
            #expect(site.contains("'\(line)'") || site.contains(line), "\(line)")
        }
        // The phone's own are not, and say only what a phone needs.
        for line in CustomerWords.phoneOnly {
            #expect(!site.contains(line), "\(line)")
        }
        #expect(CustomerWords.help.reduce(0) { $0 + $1.items.count } == 11)
        #expect(CustomerWords.mixTabs == ["sessions", "transitions", "library", "moments"])
        #expect(site.contains("MIX_TABS = Object.freeze(['sessions', 'transitions', 'library', 'moments'])"))
    }

    @Test func theLinesMadeOfPartsAreTheSitesTemplates() throws {
        let site = try Self.site()
        let templates = [
            "`Hello, ${name}.`", "'Welcome back.'", "`Last heard from ${seen}. It reports again once it is on and on Wi-Fi.`",
            "`Downloading an update: ${update.progress}% so far.`", "`${plural(summary.busy, 'board')} updating`",
            "`${summary.online} of ${summary.total}`", "`All ${summary.total} online`", "`All ${summary.total} offline`",
            "`${summary.online} of ${summary.total} online`", "`Firmware ${shortVersion(board.firmware.version)}`",
            "`Board ${board.boardName}`", "`${me.email} · ${me.canWrite ? 'release manager' : 'viewer'}`",
            "`Could not load ${what}. `", "`Loading ${what}…`", "`${base}, build ${parts.build}`",
            "`Running firmware ${v}`", "`Firmware went from ${shortVersion(event.from)} to ${v}`", "`Firmware is now ${v}`",
            "', on trial'", "`Kept firmware ${v} after its trial`", "`Update to ${v} waits for Button 1`",
            "`Started downloading ${v}`", "`Update to ${v} finished`", "`Updated to ${shortVersion(event.to)} over Bluetooth`",
            "`otpauth://totp/${account}?secret=${secret}&issuer=Cranium`", "`Cranium:${String(email ?? '').slice(0, 254)}`",
            "`Setup key ${groupSecret(model.secret).split('').join(' ')}`",
            "`At least ${PASSWORD_MIN} characters. A few words in a row make a good one.`", "`At least ${PASSWORD_MIN} characters.`",
        ]
        #expect(CustomerWords.newPasswordHint == "At least \(CustomerAccount.passwordMinimum) characters. A few words in a row make a good one.")
        #expect(CustomerWords.firstPasswordHint == "At least \(CustomerAccount.passwordMinimum) characters.")
        #expect(site.contains("export const PASSWORD_MIN = \(CustomerAccount.passwordMinimum);"))
        for template in templates {
            #expect(site.contains(template), "\(template)")
        }
        #expect(site.contains("'Signing in as ', h('strong', { class: 'signin-who' }, model.email), '.'"))
        #expect(site.contains("'If ', h('strong', { class: 'signin-who' }, model.email),"))
        #expect(site.contains("' has an account, a code is on its way to it. It can take a minute.'"))
    }

    // The words of a board, case by case, as cloud/web/test/customer.test.mjs has them.

    static let board = CustomerRead.board(CustomerReadTests.board)!
    static let now = ConsoleTime.date("2026-11-04T12:00:00.000Z")!

    func with(_ changes: [String: Any]) -> CustomerBoard {
        CustomerRead.board(CustomerReadTests.with(changes))!
    }

    @Test func whatABoardIsDoingInPlainWordsForEveryStateAndEveryResult() {
        let online = CustomerWords.status(Self.board, now: Self.now)
        #expect(online == .init(tone: "good", icon: "online", label: "Online", text: "Connected, and reporting every 30 seconds."))
        #expect(CustomerWords.status(with(["status": "offline", "online": false]), now: Self.now).text
            .hasPrefix("Last heard from 20 s ago."))
        #expect(CustomerWords.status(with(["status": "new", "lastSeen": NSNull()]), now: Self.now).label == "Not heard from yet")
        #expect(CustomerWords.status(with(["status": "offline", "lastSeen": NSNull()]), now: Self.now).text == "Not heard from lately.")
        func update(_ changes: [String: Any]) -> String? {
            CustomerWords.update(with(["update": ["state": "idle", "progress": 0, "last": "succeeded"].merging(changes) { $1 }]))
        }
        #expect(update(["state": "downloading", "progress": 40]) == "Downloading an update: 40% so far.")
        #expect(update(["state": "awaiting_user"])?.contains("press Button 1") == true)
        #expect(update(["state": "testing"])?.contains("within 5 minutes") == true)
        for last in ["succeeded", "failed", "rolled_back", "declined", "refused", "cancelled", "none"] {
            #expect(update(["last": last]) != nil, "\(last)")
        }
        #expect(CustomerWords.update(with(["update": NSNull()])) == nil)
        #expect(CustomerWords.shortVersion("1.11.2+0") == "1.11.2")
        #expect(CustomerWords.shortVersion("1.11.2+3") == "1.11.2, build 3")
        #expect(CustomerWords.boardTitle(with(["name": NSNull()])) == "Your Cranium")
        #expect(CustomerWords.online(CustomerWords.summarize([Self.board, with(["online": false])])) == "1 of 2 online")
        #expect(CustomerWords.online(CustomerWords.summarize([Self.board])) == "Online")
        #expect(CustomerWords.online(CustomerWords.summarize([Self.board, Self.board])) == "All 2 online")
        #expect(CustomerWords.online(CustomerWords.summarize([with(["online": false])])) == "Offline")
        #expect(CustomerWords.online(CustomerWords.summarize([])) == "No boards yet")
        #expect(CustomerWords.signal(-58) == "Good")
        #expect(CustomerWords.signal(nil) == "")
    }

    @Test func theOverviewsFigures() {
        let other = with(["id": "00000000000000bb", "firmware": ["version": "1.11.3+0", "confirmed": false],
                          "status": "updating", "lastSeen": "2026-11-04T11:59:50.000Z"])
        let summary = CustomerWords.summarize([Self.board, other, Self.board])
        #expect(summary.total == 3 && summary.online == 3 && summary.busy == 1)
        #expect(summary.versions == ["1.11.2+0", "1.11.3+0"])
        #expect(summary.lastSeen == "2026-11-04T11:59:50.000Z")
        #expect(CustomerWords.firmwareFigure(summary) == "2 versions")
        #expect(CustomerWords.firmwareFigure(CustomerWords.summarize([Self.board])) == "1.11.2")
        #expect(CustomerWords.firmwareFigure(CustomerWords.summarize([])) == "—")
        #expect(CustomerWords.onlineFigure(summary) == "3 of 3")
        #expect(CustomerWords.onlineFigure(CustomerWords.summarize([])) == "0")
        #expect(CustomerWords.updatingNote(1) == "1 board updating")
        #expect(CustomerWords.hello("Ada") == "Hello, Ada.")
        #expect(CustomerWords.hello("") == "Welcome back.")
        #expect(CustomerWords.boardEyebrow(Self.board) == "Board CRADA01")
        #expect(CustomerWords.boardEyebrow(with(["name": "CRADA01"])) == "Board")
        #expect(CustomerWords.initials(name: "Ada Lovelace", email: nil) == "AL")
        #expect(CustomerWords.initials(name: "", email: "ben.smith@example.invalid") == "BS")
        #expect(CustomerWords.initials(name: nil, email: "") == "?")
        #expect(CustomerWords.adminLede(email: "a@b", canWrite: true) == "a@b · release manager")
    }

    @Test func theStatesAndTheUpdatesAreTheSitesSentences() throws {
        let site = try Self.site()
        for status in ["online", "updating", "restarting", "offline", "new"] {
            let words = CustomerWords.status(with(["status": status, "lastSeen": NSNull()]), now: Self.now)
            #expect(site.contains("'\(words.label)'") && site.contains("'\(words.text)'"), "\(status)")
        }
        for state in ["awaiting_user", "verifying", "rebooting", "testing", "bluetooth"] {
            let text = try #require(CustomerWords.update(with(["update": ["state": state, "progress": 0, "last": "none"]])))
            #expect(site.contains("'\(text)'"), "\(state)")
        }
        for last in ["succeeded", "failed", "rolled_back", "declined", "refused", "cancelled", "none"] {
            let text = try #require(CustomerWords.update(with(["update": ["state": "idle", "progress": 0, "last": last]])))
            #expect(site.contains("'\(text)'"), "\(last)")
        }
    }

    @Test func everyEventReadsAsASentenceThatNamesNothingOfAWS() throws {
        let site = try Self.site()
        let cases: [(String, String, [String: Any], String)] = [
            ("connection", "connected", [:], "Came online"),
            ("connection", "disconnected", [:], "Went offline"),
            ("firmware", "reported", ["version": "1.0.0+0"], "Running firmware 1.0.0"),
            ("firmware", "changed", ["version": "1.1.0+0", "from": "1.0.0+0"], "Firmware went from 1.0.0 to 1.1.0"),
            ("firmware", "changed", ["version": "1.1.0+0", "confirmed": false], "Firmware is now 1.1.0, on trial"),
            ("firmware", "confirmed", [:], "Kept its new firmware after its trial"),
            ("update", "step", ["state": "downloading", "version": "1.2.0+0"], "Started downloading 1.2.0"),
            ("update", "step", ["state": "awaiting_user"], "An update waits for Button 1"),
            ("update", "result", ["result": "rolled_back"], "An update did not stick; the board went back to its firmware"),
            ("update", "result", ["result": "succeeded", "version": "1.2.0+3"], "Update to 1.2.0, build 3 finished"),
            ("restart", "restarted", [:], "Restarted"),
            ("restart", "stuck", [:], "Restarted itself to recover"),
            ("bluetooth", "opened", [:], "Opened its Bluetooth window for a phone"),
            ("bluetooth", "closed", [:], "Closed its Bluetooth window"),
            ("bluetooth", "record", ["result": "succeeded", "to": "1.2.0+0"], "Updated to 1.2.0 over Bluetooth"),
            ("bluetooth", "record", ["result": "failed"], "An update over Bluetooth did not go through"),
            ("restart", "something_new", [:], "Something changed"),
        ]
        for (kind, what, extra, text) in cases {
            var raw: [String: Any] = ["at": "2026-11-04T11:59:40.000Z", "board": "0123456789abcdef", "kind": kind, "what": what]
            raw.merge(extra) { $1 }
            let event = CustomerRead.event(raw)!
            let words = CustomerWords.event(event)
            #expect(words.text == text, "\(kind) \(what)")
            if !text.contains(where: \.isNumber) { #expect(site.contains("'\(text)'"), "\(text)") }
            #expect(!words.text.contains("AWS") && !words.text.contains("IoT") && !words.text.contains("cranium-"))
        }
    }
}
