import Foundation
import Testing
@testable import CraniumKit

/// The console's pages in this app (apps/shared/pages.json): each one in the bundle, in the sections, in the web view,
/// with its API calls taken from the app's sign-in. A page the console gains fails here until pages.json has it.
@Suite struct PagesParityTests {
    static let repo = Shared.folder.deletingLastPathComponent().deletingLastPathComponent()
    static let assets = repo.appendingPathComponent("cloud/web/src/site/assets")

    static func text(_ path: String) throws -> String {
        try String(contentsOf: repo.appendingPathComponent(path), encoding: .utf8)
    }

    static func pages() throws -> [String: Any] { try Shared.json("pages.json") }

    static func list(_ name: String) throws -> [[String: Any]] {
        try #require(try pages()[name] as? [[String: Any]])
    }

    static func matches(_ pattern: String, in text: String, group: Int = 1) throws -> [String] {
        let regex = try NSRegularExpression(pattern: pattern)
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range(at: group), in: text).map { String(text[$0]) }
        }
    }

    /// The names in a `const SECTIONS = [ ... ];` of a script, without its comments.
    static func sections(_ source: String, _ pattern: String) throws -> [String] {
        let start = try #require(source.range(of: "const SECTIONS = ["))
        let end = try #require(source.range(of: "];", range: start.upperBound..<source.endIndex))
        let body = source[start.upperBound..<end.lowerBound].split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
        return try matches(pattern, in: body)
    }

    /// `#/section` or `#/section/item`: the section, and the item if there is one.
    static func section(_ route: String) throws -> (String, String?) {
        let parts = try #require(route.hasPrefix("#/") ? route.dropFirst(2).split(separator: "/").map(String.init) : nil)
        return (try #require(parts.first), parts.count > 1 ? parts[1] : nil)
    }

    @Test func everySectionOfTheConsoleIsAPageAndEveryPageOneOfTheConsoles() throws {
        let core = try Self.text("cloud/web/src/site/assets/core.js")
        // A section's name is a word, or two joined by a hyphen (release-notes).
        let known = try Self.sections(core, "'([a-z]+(?:-[a-z]+)?)'")
        #expect(known.contains("memfault"))
        let pages = try Self.list("console")
        let listed = Set(try pages.map { try Self.section(try #require($0["route"] as? String)).0 })
        for section in known { #expect(listed.contains(section), "#/\(section) in pages.json") }
        for page in pages {
            let route = try #require(page["route"] as? String)
            let (section, item) = try Self.section(route)
            #expect(known.contains(section), "\(route) in core.js")
            if item != nil { #expect(core.contains("section === '\(section)' &&"), "\(route)'s item in core.js") }
        }
    }

    @Test func eachPageIsInTheSectionsAndItsScriptInTheBundle() throws {
        let nav = try Self.sections(try Self.text("cloud/web/src/site/assets/views.js"), "\\['([a-z]+)', '")
        let app = try Self.text("cloud/web/src/site/assets/app.js")
        for page in try Self.list("console") {
            let route = try #require(page["route"] as? String)
            if let section = page["nav"] as? String { #expect(nav.contains(section), "\(route) under \(section)") }
            guard let script = page["script"] as? String else { continue }
            #expect(script.range(of: "^[a-z0-9][a-z0-9._-]{0,63}\\.js$", options: .regularExpression) != nil)
            #expect(FileManager.default.fileExists(atPath: Self.assets.appendingPathComponent(script).path), "\(script) in site/assets/")
            #expect(app.contains("import('./\(script)')"), "\(script) loaded by app.js")
        }
    }

    @Test func eachBoardCardIsDrawnByItsScriptAndCalledOnTheBoardsPage() throws {
        let views = try Self.text("cloud/web/src/site/assets/views.js")
        for card in try Self.list("cards") {
            let script = try #require(card["script"] as? String)
            let draw = try #require(card["draw"] as? String)
            let title = try #require(card["title"] as? String)
            let source = try String(contentsOf: Self.assets.appendingPathComponent(script), encoding: .utf8)
            #expect(source.contains("export function \(draw)("))
            #expect(source.contains("title: '\(title)'"))
            #expect(views.contains(".\(draw)("))
        }
    }

    @Test func eachPagesAPIRoutesTakeTheAppsSignIn() throws {
        let api = try Self.text("cloud/api/src/app.mjs")
        let routes = (try Self.list("console") + Self.list("cards")).flatMap { $0["api"] as? [String] ?? [] }
        #expect(routes.contains("GET /api/devices/{thing}/memfault"))
        for name in routes {
            let parts = name.split(separator: " ").map(String.init)
            #expect(parts.count == 2)
            // No options: `phone` and `token` keep their defaults, so the phone apps' client is taken.
            let pattern = "route\\('\(parts[0])', '\(NSRegularExpression.escapedPattern(for: parts[1]))', [A-Za-z_.]+\\),"
            #expect(try !Self.matches(pattern, in: api, group: 0).isEmpty, "\(name) in app.mjs")
        }
    }

    /// The platforms a page may leave out, each with its reason; the desktop app has every page.
    @Test func exclusionsHaveAReasonAndOnlyTheSerialPagesAreLeftOutHere() throws {
        var mine: Set<String> = []
        for page in try Self.list("console") {
            let route = try #require(page["route"] as? String)
            guard let excluded = page["excluded"] as? [String: Any] else { continue }
            for (platform, reason) in excluded {
                #expect(["ios", "android"].contains(platform), "\(route) excluded on \(platform)")
                #expect(((reason as? String) ?? "").count >= 20, "\(route) excluded on \(platform) has a reason")
            }
            if excluded["ios"] != nil { mine.insert(try Self.section(route).0) }
        }
        #expect(mine == ShellPolicy.excludedSections)
        let views = try Self.text("cloud/web/src/site/assets/views.js")
        let hidden = try #require(views.split(separator: "\n").first { $0.contains("SERIAL_PAGES = Object.freeze([") })
        for section in mine { #expect(hidden.contains("'\(section)'"), "views.js hides \(section) in the app") }
    }

    @Test func theWebViewKeepsEveryPageReachesTheConsoleAndSendsMemfaultOutside() throws {
        for page in try Self.list("console") {
            let route = try #require(page["route"] as? String)
            let url = try #require(URL(string: "\(ShellPolicy.origin)/admin\(route)"))
            let excluded = (page["excluded"] as? [String: Any])?["ios"] != nil
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false) == (excluded ? .drop : .allow), "\(route)")
        }
        let csp = try #require(ShellPolicy.contentSecurityPolicy("console", config: ShellPolicyTests.config))
        #expect(csp.contains("connect-src 'self' cranium-app://bundle https://console.test"))
        for address in try #require(try Self.pages()["outside"] as? [String]) {
            let url = try #require(URL(string: address))
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: true) == .openOutside(url))
            #expect(ShellPolicy.navigation(to: url, mainFrame: true, newWindow: false) == .openOutside(url))
        }
    }
}
