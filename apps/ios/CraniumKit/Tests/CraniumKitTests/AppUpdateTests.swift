import Foundation
import Testing
@testable import CraniumKit

/// The iPhone app's own update: which build is newer, and the links built for SideStore.
@Suite struct AppUpdateTests {
    static let console = URL(string: "https://console.test")!
    static let sha = String(repeating: "ab", count: 32)
    static let s3 = "https://cranium-apps-123.s3.us-east-1.amazonaws.com/apps/ios/cranium-ios-0.8.10.ipa"
        + "?versionId=v1&response-content-disposition=attachment%3B%20filename%3D%22cranium-ios-0.8.10.ipa%22"
        + "&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=abc123"

    static func release(_ version: String, _ build: String) -> AppUpdate.Release {
        AppUpdate.Release(version: version, build: build, size: 1000, sha256: sha)
    }

    @Test func versionsCompareByNumberThenBuild() {
        #expect(AppUpdate.isNewer(Self.release("0.8.10", "24"), thanVersion: "0.8.9", build: "23"))
        #expect(AppUpdate.isNewer(Self.release("0.9.0", "1"), thanVersion: "0.8.99", build: "99"))
        #expect(AppUpdate.isNewer(Self.release("1.0.0", "30"), thanVersion: "0.10.0", build: "29"))
        // The same version: the build decides.
        #expect(AppUpdate.isNewer(Self.release("0.8.9", "24"), thanVersion: "0.8.9", build: "23"))
        #expect(!AppUpdate.isNewer(Self.release("0.8.9", "23"), thanVersion: "0.8.9", build: "23"))
        // Older, or a newer app from the Mac than any published: nothing.
        #expect(!AppUpdate.isNewer(Self.release("0.8.8", "99"), thanVersion: "0.8.9", build: "23"))
        // 0.8.10 is not 0.8.1 followed by a 0.
        #expect(!AppUpdate.isNewer(Self.release("0.8.9", "30"), thanVersion: "0.8.10", build: "24"))
        // Unreadable either side: nothing.
        for (offered, running) in [("0.8", "0.8.9"), ("0.8.9", "?"), ("0.08.9", "0.8.1"), ("0.8.9-beta", "0.8.1"), ("0.8.x", "0.8.1")] {
            #expect(!AppUpdate.isNewer(Self.release(offered, "50"), thanVersion: running, build: "1"), "\(offered) \(running)")
        }
        #expect(AppUpdate.Version("0.8.10")! > AppUpdate.Version("0.8.9")!)
    }

    @Test func theNewestBuildOfTheConsolesList() throws {
        let body: [String: Any] = ["ios": ["version": "0.8.10", "latest": "0.8.10", "releases": [
            ["version": "0.8.9", "buildVersion": "23", "size": 10, "sha256": Self.sha, "notes": "old"],
            ["version": "0.8.10", "buildVersion": "24", "size": 20, "sha256": Self.sha, "notes": "One-tap update."],
            ["version": "9.9.9", "buildVersion": "x", "size": 20, "sha256": Self.sha],
            ["version": "9.9.8", "buildVersion": "1", "size": 20, "sha256": "nothex"],
        ]]]
        let data = try JSONSerialization.data(withJSONObject: body)
        let newest = try #require(AppUpdate.newest(fromApps: data))
        #expect(newest == AppUpdate.Release(version: "0.8.10", build: "24", size: 20, sha256: Self.sha, notes: "One-tap update."))
        #expect(AppUpdate.offer(fromApps: data, runningVersion: "0.8.9", build: "23") == newest)
        #expect(AppUpdate.offer(fromApps: data, runningVersion: "0.8.10", build: "24") == nil)
        #expect(AppUpdate.newest(fromApps: Data(#"{"ios":{"releases":[]}}"#.utf8)) == nil)
        #expect(AppUpdate.newest(fromApps: Data("nope".utf8)) == nil)
    }

    @Test func theConsolesAddresses() {
        #expect(AppUpdate.appsURL(console: Self.console).absoluteString == "https://console.test/api/apps")
        #expect(AppUpdate.downloadURL(console: Self.console, version: "0.8.10")?.absoluteString
            == "https://console.test/api/apps/ios/0.8.10/download?via=app")
        #expect(AppUpdate.downloadURL(console: Self.console, version: "../x") == nil)
        #expect(AppUpdate.appsPage(console: Self.console).absoluteString == "https://console.test/#/apps")
        #expect(AppUpdate.appsPage(console: URL(string: "https://console.test/")!).absoluteString == "https://console.test/#/apps")
    }

    @Test func theDownloadLinkIsTheBuildOffered() throws {
        let offered = AppUpdate.Release(version: "0.8.10", build: "24", size: 20, sha256: Self.sha)
        func answer(_ changes: [String: Any] = [:]) throws -> Data {
            var download: [String: Any] = ["url": Self.s3, "version": "0.8.10", "size": 20, "sha256": Self.sha,
                                           "filename": "cranium-ios-0.8.10.ipa", "expiresAt": "2026-11-09T12:15:00.000Z"]
            download.merge(changes) { $1 }
            return try JSONSerialization.data(withJSONObject: ["download": download])
        }
        #expect(AppUpdate.link(fromDownload: try answer(), for: offered, console: Self.console)?.absoluteString == Self.s3)
        for change: [String: Any] in [["version": "0.8.9"], ["size": 21], ["sha256": String(repeating: "cd", count: 32)],
                                      ["url": "https://evil.test/apps/ios/cranium-ios-0.8.10.ipa?X-Amz-Signature=1"],
                                      ["url": "http://cranium-apps-123.s3.us-east-1.amazonaws.com/apps/ios/cranium-ios-0.8.10.ipa?X-Amz-Signature=1"]] {
            #expect(AppUpdate.link(fromDownload: try answer(change), for: offered, console: Self.console) == nil, "\(change)")
        }
    }

    @Test func theSideStoreLinkCarriesTheWholeLink() throws {
        let ipa = URL(string: Self.s3)!
        let install = try #require(AppUpdate.installLink(ipa: ipa))
        #expect(install.absoluteString.hasPrefix("sidestore://install?url=https%3A%2F%2Fcranium-apps-123.s3.us-east-1.amazonaws.com%2Fapps%2Fios%2F"))
        // SideStore reads it with URLComponents' query items, as its URL handler does: the very same link comes back.
        let items = try #require(URLComponents(url: install, resolvingAgainstBaseURL: false)?.queryItems)
        #expect(items.count == 1 && items[0].name == "url")
        #expect(items[0].value == Self.s3)
        #expect(ShellPolicy.mayOpenOutside(install, console: Self.console))
        #expect(ShellPolicy.isSideStoreLink(install, console: Self.console))
    }
}
