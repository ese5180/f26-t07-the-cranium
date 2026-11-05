import Foundation
import Testing
@testable import CraniumKit

/// The bundles on the phone: what starts, what is fetched and kept, and what goes.
@Suite struct BundleStoreTests {
    static let console = URL(string: "https://console.test")!

    /// A bundle of a few files, with the manifest bundle.mjs would write for it.
    struct Made {
        let manifest: [String: Any]
        let files: [String: Data]
        var id: String { manifest["id"] as! String }
        var text: Data { try! JSONSerialization.data(withJSONObject: manifest) }
        var byDigest: [String: Data] {
            Dictionary(files.values.map { (BundleManifest.sha256Hex($0), $0) }, uniquingKeysWith: { a, _ in a })
        }
    }

    static func make(_ marker: String, bridge: Int = 1) -> Made {
        let files: [String: Data] = [
            "index.html": Data("<!doctype html><p>customer \(marker)".utf8),
            "admin/index.html": Data("<!doctype html><p>console \(marker)".utf8),
            "assets/0123456789ab/core.js": Data("export const shared = 1;\n".utf8),
            "assets/0123456789ab/app.js": Data("// \(marker)\n".utf8),
        ]
        let list = files.map { BundleManifest.File(path: $0.key, size: $0.value.count, sha256: BundleManifest.sha256Hex($0.value)) }
        let routes = ["/": BundleManifest.Route(file: "index.html", policy: "customer"),
                      "/admin": BundleManifest.Route(file: "admin/index.html", policy: "console")]
        let id = String(BundleManifest.sha256Hex(Data(BundleManifest.canonicalText(bridge: bridge, routes: routes, files: list).utf8)).prefix(16))
        let manifest: [String: Any] = [
            "format": 1, "id": id, "bridge": bridge,
            "console": ["version": "2.1.\(marker.count)", "commit": NSNull()], "builtAt": NSNull(),
            "routes": routes.mapValues { ["file": $0.file, "policy": $0.policy] },
            "files": list.map { ["path": $0.path, "size": $0.size, "sha256": $0.sha256] },
        ]
        return Made(manifest: manifest, files: files)
    }

    /// The console, as far as the store sees it.
    final class FakeConsole: BundleFetcher, @unchecked Sendable {
        let lock = NSLock()
        var bundle: Made
        var fetched: [String] = []
        /// Files answered with other bytes.
        var tampered: Set<String> = []
        var down = false

        init(_ bundle: Made) { self.bundle = bundle }

        func fetch(_ url: URL, limit: Int) async throws -> Data {
            try lock.withLock {
                fetched.append(url.path)
                if down { throw URLError(.notConnectedToInternet) }
                if url.path == "/app/manifest.json" { return bundle.text }
                let digest = url.lastPathComponent
                guard url.path == "/app/files/\(digest)", let data = bundle.byDigest[digest] else { throw URLError(.badServerResponse) }
                return tampered.contains(digest) ? Data("evil()".utf8) : data
            }
        }

        var fileFetches: Int { lock.withLock { fetched.filter { $0.hasPrefix("/app/files/") }.count } }
    }

    /// A fresh folder for the store, and the built-in bundle written as build-bundle.mjs writes it.
    func folders(builtIn: Made? = make("built-in")) throws -> (URL, URL?) {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("bundle-store-\(UUID().uuidString)")
        let root = base.appendingPathComponent("store")
        guard let builtIn else { return (root, nil) }
        let folder = base.appendingPathComponent("built-in")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("files"), withIntermediateDirectories: true)
        try builtIn.text.write(to: folder.appendingPathComponent("manifest.json"))
        for (digest, data) in builtIn.byDigest { try data.write(to: folder.appendingPathComponent("files/\(digest)")) }
        return (root, folder)
    }

    @Test func theBuiltInBundleStartsFirst() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let bundle = try #require(await store.launch())
        #expect(bundle.source == .builtIn)
        let page = try #require(bundle.serve("/"))
        #expect(String(decoding: page.data, as: UTF8.self).contains("customer built-in"))
        #expect(page.policy == "customer" && page.type == "text/html; charset=utf-8")
        #expect(bundle.serve("/admin")?.policy == "console")
        #expect(bundle.serve("/assets/0123456789ab/app.js")?.policy == nil)
        #expect(bundle.serve("/nothing.js") == nil)
        // No bundle at all, not even one in the app.
        let (empty, _) = try folders(builtIn: nil)
        #expect(await BundleStore(root: empty, builtIn: nil).launch() == nil)
    }

    @Test func aNewBundleIsFetchedCheckedAndKept() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let first = Self.make("one")
        let console = FakeConsole(first)
        #expect(await store.update(consoleURL: Self.console, fetcher: console) == .updated(try BundleManifest.read(first.text)))
        // core.js is the same bytes under two builds once; four files, four distinct contents here.
        #expect(console.fileFetches == 4)
        #expect(await store.update(consoleURL: Self.console, fetcher: console) == .upToDate)
        #expect(console.fileFetches == 4)

        let bundle = try #require(await store.launch())
        #expect(bundle.source == .downloaded && bundle.id == first.id)
        #expect(String(decoding: try #require(bundle.serve("/")).data, as: UTF8.self).contains("customer one"))

        // The next one: only what changed is fetched; the old one is kept as the previous.
        let second = Self.make("two")
        console.bundle = second
        #expect(await store.update(consoleURL: Self.console, fetcher: console, keeping: bundle) == .updated(try BundleManifest.read(second.text)))
        #expect(console.fileFetches == 4 + 3)
        let objects = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("objects").path)
        #expect(Set(objects) == Set(first.byDigest.keys).union(second.byDigest.keys))
        #expect(await store.newest()?.id == second.id)
    }

    @Test func aFileThatDoesNotCheckOutIsNotKept() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let made = Self.make("one")
        let console = FakeConsole(made)
        console.tampered = [BundleManifest.sha256Hex(made.files["admin/index.html"]!)]
        guard case .failed = await store.update(consoleURL: Self.console, fetcher: console) else {
            Issue.record("a tampered file was taken")
            return
        }
        #expect(await store.launch()?.source == .builtIn)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("objects").path)) ?? []
        #expect(!names.contains(console.tampered.first!))
        // Offline: nothing changes.
        console.down = true
        guard case .failed = await store.update(consoleURL: Self.console, fetcher: console) else {
            Issue.record("no network, and yet an outcome")
            return
        }
    }

    @Test func aBundleThatNeedsANewerAppIsNotTaken() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let console = FakeConsole(Self.make("future", bridge: 2))
        #expect(await store.update(consoleURL: Self.console, fetcher: console) == .needsNewerApp)
        #expect(await store.needsNewerApp())
        #expect(console.fileFetches == 0)
        #expect(await store.launch()?.source == .builtIn)
        console.bundle = Self.make("now")
        guard case .updated = await store.update(consoleURL: Self.console, fetcher: console) else {
            Issue.record("the next bundle was not taken")
            return
        }
        #expect(await !store.needsNewerApp())
    }

    @Test func aBundleThatNeverSaysReadyIsBadAfterTwoStarts() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let good = Self.make("good")
        let console = FakeConsole(good)
        _ = await store.update(consoleURL: Self.console, fetcher: console)
        #expect(await store.launch()?.id == good.id)
        await store.markReady(good.id)

        let broken = Self.make("broken")
        console.bundle = broken
        _ = await store.update(consoleURL: Self.console, fetcher: console)
        #expect(await store.launch()?.id == broken.id)
        #expect(await store.launch()?.id == broken.id)
        // Two starts without app.ready: the previous one, which did say it.
        #expect(await store.launch()?.id == good.id)
        #expect(await store.isBad(broken.id))
        // And it is not fetched again.
        #expect(await store.update(consoleURL: Self.console, fetcher: console) == .refused)
        // A good bundle keeps starting.
        for _ in 0..<5 { #expect(await store.launch()?.id == good.id) }
    }

    @Test func aMissingOrDamagedFileFallsBack() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let made = Self.make("one")
        _ = await store.update(consoleURL: Self.console, fetcher: FakeConsole(made))
        let digest = BundleManifest.sha256Hex(made.files["assets/0123456789ab/app.js"]!)
        try Data("tampered".utf8).write(to: root.appendingPathComponent("objects/\(digest)"))
        #expect(await store.launch()?.source == .builtIn)
        // The next update fetches it again.
        let console = FakeConsole(made)
        guard case .updated = await store.update(consoleURL: Self.console, fetcher: console) else {
            Issue.record("the damaged bundle was not repaired")
            return
        }
        #expect(console.fileFetches == 1)
        #expect(await store.launch()?.id == made.id)
    }

    @Test func theBundleOnScreenKeepsItsFiles() async throws {
        let (root, builtIn) = try folders()
        let store = BundleStore(root: root, builtIn: builtIn)
        let console = FakeConsole(Self.make("one"))
        _ = await store.update(consoleURL: Self.console, fetcher: console)
        let onScreen = try #require(await store.launch())
        for marker in ["two", "three"] {
            console.bundle = Self.make(marker)
            _ = await store.update(consoleURL: Self.console, fetcher: console, keeping: onScreen)
        }
        // "one" is neither current nor previous, but still on screen: a page it loads later still loads.
        #expect(onScreen.serve("/assets/0123456789ab/app.js") != nil)
        #expect(onScreen.serve("/") != nil)
    }
}
