import Foundation
import Testing
@testable import CraniumKit

/// A bundle's manifest is read by the rules of cloud/web/src/bundle.mjs: apps/shared/bundle-sample.json, which
/// bundle.mjs wrote, reads, has the id that its canonical text gives, and every broken copy of it is refused.
@Suite struct BundleManifestTests {
    func sample() throws -> [String: Any] { try Shared.json("bundle-sample.json") }

    func text(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    @Test func theSampleReads() throws {
        let sample = try sample()
        let manifest = try BundleManifest.read(try text(try #require(sample["manifest"])))
        #expect(manifest.canonicalText == sample["canonical"] as? String)
        #expect(manifest.workedOutId == manifest.id)
        #expect(manifest.id == (sample["manifest"] as? [String: Any])?["id"] as? String)
        #expect(manifest.objects.count == sample["objects"] as? Int)
        #expect(manifest.consoleVersion == "2.1.1")
        #expect(manifest.routes["/"] == BundleManifest.Route(file: "index.html", policy: "customer"))
        #expect(manifest.routes["/admin"] == BundleManifest.Route(file: "admin/index.html", policy: "console"))
        // Each file's text has its SHA-256 and its size.
        let files = try #require(sample["files"] as? [String: String])
        #expect(files.count == manifest.files.count)
        for file in manifest.files {
            let content = Data(try #require(files[file.path]).utf8)
            #expect(BundleManifest.sha256Hex(content) == file.sha256, "\(file.path)")
            #expect(content.count == file.size, "\(file.path)")
        }
    }

    @Test func everyBrokenManifestIsRefused() throws {
        let broken = try #require(try sample()["broken"] as? [String: Any])
        #expect(broken.count >= 9)
        for (name, manifest) in broken {
            #expect(throws: BundleManifest.ReadError.self, "\(name)") { try BundleManifest.read(try text(manifest)) }
        }
        #expect(throws: BundleManifest.ReadError.self) { try BundleManifest.read("not json") }
        #expect(throws: BundleManifest.ReadError.self) { try BundleManifest.read("[]") }
    }

    @Test func aChangeAnywhereChangesTheId() throws {
        var manifest = try #require(try sample()["manifest"] as? [String: Any])
        var files = try #require(manifest["files"] as? [[String: Any]])
        files[0]["size"] = (files[0]["size"] as! Int) + 1
        manifest["files"] = files
        #expect(throws: BundleManifest.ReadError.self) { try BundleManifest.read(try text(manifest)) }
        // What it says of the console is not part of the id.
        var about = try #require(try sample()["manifest"] as? [String: Any])
        about["console"] = ["version": "9.9.9", "commit": NSNull()]
        about["builtAt"] = NSNull()
        #expect(try BundleManifest.read(try text(about)).consoleVersion == "9.9.9")
    }

    @Test func pathsAreKeysOfOneShape() {
        for good in ["index.html", "admin/index.html", "assets/0123456789ab/app.js", "a/b/c/d.css", "x_y-z.1.txt"] {
            #expect(BundleManifest.isPath(good), "\(good)")
        }
        for bad in ["", "/index.html", "../x.js", "a/../b.js", ".hidden.js", "a//b.js", "A.js", "a/b/c/d/e.js", "a b.js",
                    "assets/x/", "-x.js", "_x.js", "a\\b.js", "%2e%2e/x.js", String(repeating: "a", count: 65) + ".js"] {
            #expect(!BundleManifest.isPath(bad), "\(bad)")
        }
        #expect(BundleManifest.contentType("a.js") == "text/javascript; charset=utf-8")
        #expect(BundleManifest.contentType("a.html") == "text/html; charset=utf-8")
        #expect(BundleManifest.contentType("a.svg") == nil)
        #expect(BundleManifest.contentType("Makefile") == nil)
    }

    @Test func aRequestIsALookup() throws {
        let manifest = try BundleManifest.read(try text(try #require(try sample()["manifest"])))
        #expect(manifest.lookup("/")?.file.path == "index.html")
        #expect(manifest.lookup("/")?.policy == "customer")
        #expect(manifest.lookup("/admin")?.policy == "console")
        #expect(manifest.lookup("/assets/ba9876543210/app.js")?.file.path == "assets/ba9876543210/app.js")
        #expect(manifest.lookup("/assets/ba9876543210/app.js")?.policy == nil)
        // Nothing is decoded or normalised.
        #expect(manifest.lookup("/admin/") == nil)
        #expect(manifest.lookup("/assets/ba9876543210/../ba9876543210/app.js") == nil)
        #expect(manifest.lookup("/assets/ba9876543210/app%2Ejs") == nil)
        #expect(manifest.lookup("assets/ba9876543210/app.js") == nil)
        #expect(manifest.lookup("/index.html")?.policy == nil)
    }
}
