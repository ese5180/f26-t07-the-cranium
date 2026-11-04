import Foundation
import Testing
@testable import CraniumKit

@Suite struct SearchTests {
    let boards = [
        Device(thing: "cranium-3f2a9c1e5b7d4a60", name: "CRVIHAAN01", online: true, fw: .init(version: "1.11.3+0", confirmed: true)),
        Device(thing: "cranium-8b1d6e0f2c4a9e73", name: "CRLAB02", online: false, lastSeen: "2026-11-03T10:00:00.000Z",
               fw: .init(version: "1.11.4+0", confirmed: false)),
        Device(thing: "cranium-c05e7a1b3d9f2468"),
    ]

    func item(_ title: String, subtitle: String = "", keywords: [String] = [], kind: SearchItem.Kind = .screen) -> SearchItem {
        SearchItem(kind: kind, key: title, title: title, subtitle: subtitle, keywords: keywords, target: .screen(title))
    }

    @Test func caseAndDiacriticsDoNotMatter() {
        let items = [item("Café menu"), item("Résumé")]
        #expect(Search.rank("CAFE", in: items).map(\.item.title) == ["Café menu"])
        #expect(Search.rank("resume", in: items).map(\.item.title) == ["Résumé"])
        #expect(Search.rank("résumé", in: items).first?.titleRanges == [0..<6])
    }

    @Test func everyWordMustMatchAndPrefixesOfWordsDo() {
        let items = [item("Update over Bluetooth"), item("Deploy a release"), item("Upload firmware")]
        #expect(Search.rank("up blue", in: items).map(\.item.title) == ["Update over Bluetooth"])
        #expect(Search.rank("fir", in: items).map(\.item.title) == ["Upload firmware"])
        #expect(Search.rank("up zzz", in: items).isEmpty)
        #expect(Search.rank("   ", in: items).isEmpty)
    }

    @Test func theStartOfAWordOutranksTheMiddle() {
        let items = [item("Unrelease notes"), item("Release notes"), item("Notes on a release")]
        let ranked = Search.rank("release", in: items).map(\.item.title)
        #expect(ranked == ["Release notes", "Notes on a release", "Unrelease notes"])
    }

    @Test func anExactTitleComesFirstAndTheTitleBeforeTheSubtitle() {
        let items = [item("Events", subtitle: "What every board did"), item("Board events log"),
                     item("Account", subtitle: "Events of your sign-in")]
        let ranked = Search.rank("events", in: items).map(\.item.title)
        #expect(ranked.first == "Events")
        #expect(ranked.last == "Account")
    }

    @Test func boardsAreFoundByNameThingVersionAndState() {
        let items = Search.items(boards: boards)
        #expect(Search.rank("crvihaan", in: items).first?.item.target == .board("cranium-3f2a9c1e5b7d4a60"))
        #expect(Search.rank("3f2a", in: items).first?.item.title == "CRVIHAAN01", "the thing name, at the start of its second word")
        #expect(Search.rank("1.11.4", in: items).map(\.item.title) == ["CRLAB02"])
        #expect(Set(Search.rank("offline", in: items).map(\.item.title)) == ["CRLAB02"])
        #expect(Search.rank("cranium-c05e", in: items).first?.item.title == "cranium-c05e7a1b3d9f2468",
                "a board with no device ID is called by its thing name")
        #expect(Search.rank("trial", in: items).map(\.item.title) == ["CRLAB02"])
    }

    @Test func releasesDeploymentsActivityAndEvents() {
        let releases = Search.items(releases: [
            FirmwareRelease(version: "1.11.4+0", size: 1, sha256: "", notes: "Device ID in diagnostics"),
            FirmwareRelease(version: "1.11.2+1", size: 1, sha256: "", status: "revoked",
                            revoked: Revocation(by: nil, at: nil, reason: "Drops the Wi-Fi", enforcedAt: nil)),
        ])
        #expect(Search.rank("revoked", in: releases).map(\.item.title) == ["1.11.2+1"])
        #expect(Search.rank("wi-fi", in: releases).map(\.item.title) == ["1.11.2+1"], "the reason counts")
        #expect(Search.rank("diagnostics", in: releases).first?.subtitleRanges.isEmpty == false)

        let deployment = Deployment(id: "cranium-1-11-4-b0-20261103T110000Z-1a2b", version: "1.11.4+0", status: "IN_PROGRESS",
                                    things: ["cranium-3f2a9c1e5b7d4a60"], counts: Counts(inProgress: 1))
        let deployments = Search.items(deployments: [deployment], devices: boards)
        #expect(deployments[0].subtitle == "Updating · CRVIHAAN01")
        #expect(Search.rank("updating crvihaan", in: deployments).count == 1)
        #expect(Search.rank("20261103T11", in: deployments).count == 1, "by its id")

        let entry = AuditEntry(at: "2026-11-03T12:00:00.000Z", actor: Person(sub: "s", email: "vihaan@cranium.test"),
                               action: "firmware.revoke", target: "1.11.2+1")
        let activity = Search.items(activity: [entry])
        #expect(Search.rank("vihaan revoked", in: activity).count == 1)
        #expect(activity[0].target == .release("1.11.2+1"), "straight to the release it is about")

        let event = BoardEvent(thing: "cranium-8b1d6e0f2c4a9e73", at: "2026-11-03T11:00:00.000Z", kind: "health",
                               what: "heap_low", level: "warn", text: "Free memory ran low")
        let events = Search.items(events: [event], devices: boards)
        #expect(Search.rank("memory low", in: events).first?.item.target == .event(thing: "cranium-8b1d6e0f2c4a9e73"))
        #expect(events[0].subtitle.hasPrefix("CRLAB02 · Wi-Fi and memory"))
    }

    @Test func screensAndActionsForWhatTheAccountMayDo() {
        let viewer = SearchCatalog.items(canWrite: false)
        let manager = SearchCatalog.items(canWrite: true)
        #expect(Search.rank("deploy", in: viewer).allSatisfy { $0.item.key != "deploy" })
        #expect(Search.rank("deploy", in: manager).first?.item.key == "deploy")
        #expect(Search.rank("api tokens", in: viewer).first?.item.key == "tokens")
        #expect(Search.rank("log out", in: viewer).first?.item.key == "signout")
        #expect(Search.rank("upload", in: manager).first?.item.key == "upload")
    }

    @Test func resultsAreGroupedBestGroupFirst() {
        let items = Search.items(boards: boards) + SearchCatalog.items(canWrite: true)
        let groups = Search.grouped(Search.rank("boards", in: items))
        #expect(groups.first?.kind == .screen)
        #expect(Search.grouped(Search.rank("cr", in: items), limit: 1).first { $0.kind == .board }?.hits.count == 1)
    }

    @Test func highlightsAreRangesOfTheShownText() {
        let hit = Search.rank("ver blue", in: [item("Update over Bluetooth")])[0]
        #expect(hit.titleRanges == [8..<11, 12..<16])
        let merged = Search.rank("blu bluet", in: [item("Bluetooth")])[0]
        #expect(merged.titleRanges == [0..<5])
    }

    @Test func recentSearchesAreKeptNewestFirstAtMostTen() throws {
        let defaults = try #require(UserDefaults(suiteName: "cranium.tests.\(UUID().uuidString)"))
        let recent = RecentSearches(defaults: defaults)
        for index in 1...12 { recent.add("query \(index)") }
        #expect(recent.all.count == 10)
        #expect(recent.all.first == "query 12")
        recent.add("  Query   3 ")
        #expect(recent.all.first == "Query   3".trimmingCharacters(in: .whitespaces))
        #expect(recent.all.filter { Search.tokens($0) == ["query", "3"] }.count == 1, "the same search is kept once")
        recent.add("   ")
        #expect(recent.all.count == 10)
        recent.clear()
        #expect(recent.all.isEmpty)
    }
}

@Suite struct HelpTests {
    /// The repository's root, from this file's place in it.
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func book() throws -> HelpBook {
        try HelpBook.load(Data(contentsOf: root.appendingPathComponent("apps/shared/help.json")))
    }

    @Test func theSharedFileLoadsAndHoldsTogether() throws {
        let book = try Self.book()
        #expect(book.version == 1)
        #expect(book.topics.count >= 21)
        // The ids the Android app opens topics by (its SharedHelpTest): none may be renamed or removed.
        for id in ["getting-started", "sign-in-again", "keep-the-app", "wifi-update", "bluetooth-update", "deployments",
                   "board-states", "leds", "buttons", "boards-and-diagnostics", "overview", "firmware-and-signing", "events",
                   "activity", "api-tokens", "trouble-offline", "trouble-bluetooth", "trouble-upload", "trouble-sign-in",
                   "about", "serial-console"] {
            #expect(book.topic(id) != nil, "\(id)")
        }
        #expect(book.topics.allSatisfy { !$0.blocks.isEmpty && !$0.summary.isEmpty })
    }

    @Test func everySourceIsAFileOfTheRepository() throws {
        let book = try Self.book()
        for topic in book.topics {
            #expect(!topic.sources.isEmpty, "\(topic.id) names its sources")
            for source in topic.sources {
                #expect(FileManager.default.fileExists(atPath: Self.root.appendingPathComponent(source).path), "\(topic.id): \(source)")
            }
        }
    }

    @Test func theWiFiUpdateHasTheConsolesSevenSteps() throws {
        let topic = try #require(try Self.book().topic("wifi-update"))
        let steps = topic.blocks.compactMap { block -> [String]? in
            if case .steps(let items) = block { return items }
            return nil
        }.first ?? []
        let names = Words.steps.map { $0.name }
        #expect(steps.count == names.count)
        for (step, name) in zip(steps, names) {
            #expect(step.hasPrefix("\(name):"), "\(step)")
        }
    }

    @Test func helpIsSearchable() throws {
        let items = Search.items(help: try Self.book())
        #expect(Search.rank("led", in: items).first?.item.target == .help("leds"))
        #expect(Search.rank("passkey", in: items).contains { $0.item.target == .help("bluetooth-update") })
        #expect(Search.rank("15 minutes", in: items).first?.item.target == .help("sign-in-again"))
        #expect(Search.rank("renew", in: items).first?.item.target == .help("keep-the-app"))
        #expect(Search.rank("triple flash", in: items).first?.item.target == .help("leds"), "by the words inside a topic")
    }

    @Test func aBrokenFileIsRefused() {
        let unknown = Data(#"{"version":1,"sections":[{"title":"A","topics":["a"]}],"topics":[{"id":"a","title":"A","summary":"s","blocks":[{"see":["b"]}]}]}"#.utf8)
        #expect(throws: HelpError.unknownTopic("b")) { try HelpBook.load(unknown) }
        let twice = Data(#"{"version":1,"sections":[{"title":"A","topics":["a"]}],"topics":[{"id":"a","title":"A","summary":"s","blocks":[{"text":"t"}]},{"id":"a","title":"A","summary":"s","blocks":[{"text":"t"}]}]}"#.utf8)
        #expect(throws: HelpError.duplicateTopic) { try HelpBook.load(twice) }
        let twoKinds = Data(#"{"version":1,"sections":[],"topics":[{"id":"a","title":"A","summary":"s","blocks":[{"text":"t","note":"n"}]}]}"#.utf8)
        #expect(throws: (any Error).self) { try HelpBook.load(twoKinds) }
        let plainHTTP = Data(#"{"version":1,"sections":[{"title":"A","topics":["a"]}],"topics":[{"id":"a","title":"A","summary":"s","blocks":[{"links":[["x","http://example.com"]]}]}]}"#.utf8)
        #expect(throws: (any Error).self) { try HelpBook.load(plainHTTP) }
    }
}
