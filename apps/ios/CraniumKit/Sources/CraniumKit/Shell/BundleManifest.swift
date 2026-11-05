import CryptoKit
import Foundation

/// The manifest of a web bundle (cloud/web/src/bundle.mjs, docs/mobile-apps.md "The app shell"): what the
/// bundle holds, each file by its path, size and SHA-256, and the bundle's id, a hash of all of that. This
/// reads it by the same rules as bundle.mjs's `readManifest`, which the tests keep in step through
/// apps/shared/bundle-sample.json, and works the id out again: a manifest that says anything else is refused.
public struct BundleManifest: Equatable, Sendable {
    public static let format = 1
    public static let maxBytes = 1024 * 1024
    public static let maxFiles = 300
    public static let maxFileBytes = 8 * 1024 * 1024
    public static let maxTotalBytes = 32 * 1024 * 1024
    /// The routes a bundle may have, and nothing else: the customer site at /, the console at /admin.
    public static let routeKeys: Set<String> = ["/", "/admin"]

    public struct File: Equatable, Sendable {
        public let path: String
        public let size: Int
        public let sha256: String
    }

    public struct Route: Equatable, Sendable {
        public let file: String
        /// `console` or `customer`: which Content-Security-Policy goes with the page (`ShellPolicy`).
        public let policy: String
    }

    public let id: String
    public let bridge: Int
    public let routes: [String: Route]
    public let files: [File]
    /// What the manifest says of the console it came from, to show; not part of the id.
    public let consoleVersion: String?
    public let consoleCommit: String?

    /// Files by path.
    public var byPath: [String: File] { Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first }) }

    /// The SHA-256s the bundle needs, each once.
    public var objects: Set<String> { Set(files.map(\.sha256)) }

    public enum ReadError: Error, Equatable, LocalizedError {
        case refused(String)
        public var errorDescription: String? {
            if case .refused(let why) = self { return "The bundle's manifest was refused: \(why)." }
            return nil
        }
    }

    // MARK: Reading

    public static func read(_ data: Data) throws -> BundleManifest {
        guard data.count <= maxBytes, let text = String(data: data, encoding: .utf8) else { throw ReadError.refused("not a manifest") }
        return try read(text)
    }

    public static func read(_ text: String) throws -> BundleManifest {
        func no(_ why: String) -> ReadError { .refused(why) }
        guard text.utf16.count <= maxBytes, let value = JSONValue.parse(text), let fields = value.objectValue else {
            throw no("not a manifest")
        }
        guard fields["format"]?.integerValue == format else { throw no("not a manifest of this format") }
        guard let id = fields["id"]?.stringValue, isHex(id, count: 16) else { throw no("no id") }
        guard let bridge = fields["bridge"]?.integerValue, (1...1000).contains(bridge) else { throw no("no bridge version") }
        guard let routeFields = fields["routes"]?.objectValue else { throw no("no routes") }
        var routes: [String: Route] = [:]
        for (key, entry) in routeFields {
            guard routeKeys.contains(key), let route = entry.objectValue, let file = route["file"]?.stringValue,
                  let policy = route["policy"]?.stringValue, ["console", "customer"].contains(policy) else {
                throw no("a route that is not one: \(key.prefix(40))")
            }
            routes[key] = Route(file: file, policy: policy)
        }
        guard case .array(let list) = fields["files"] ?? .null, !list.isEmpty, list.count <= maxFiles else { throw no("no files") }
        var paths = Set<String>()
        var total = 0
        var files: [File] = []
        for entry in list {
            guard let file = entry.objectValue, let path = file["path"]?.stringValue, isPath(path), contentType(path) != nil else {
                throw no("a file that is not one")
            }
            guard !paths.contains(path) else { throw no("\(path) twice") }
            paths.insert(path)
            guard let size = file["size"]?.integerValue, (0...maxFileBytes).contains(size) else { throw no("\(path): no size") }
            guard let sha256 = file["sha256"]?.stringValue, isHex(sha256, count: 64) else { throw no("\(path): no SHA-256") }
            total += size
            files.append(File(path: path, size: size, sha256: sha256))
        }
        guard total <= maxTotalBytes else { throw no("too large") }
        for route in routes.values where !paths.contains(route.file) { throw no("no file for \(route.file)") }
        guard !routes.isEmpty else { throw no("no routes") }
        let about = fields["console"]?.objectValue
        let manifest = BundleManifest(id: id, bridge: bridge, routes: routes, files: files,
                                      consoleVersion: about?["version"]?.stringValue.flatMap { $0.count <= 20 ? $0 : nil },
                                      consoleCommit: about?["commit"]?.stringValue.flatMap { isHex($0, count: 40) ? $0 : nil })
        guard manifest.workedOutId == id else { throw no("the id is not that of what the manifest says") }
        return manifest
    }

    // MARK: The id

    /// bundle.mjs's `canonicalText`: one fact a line, routes by key and files by path, in byte order.
    public static func canonicalText(bridge: Int, routes: [String: Route], files: [File]) -> String {
        var lines = ["cranium-bundle \(format)", "bridge \(bridge)"]
        for key in routes.keys.sorted(by: byBytes) {
            let route = routes[key]!
            lines.append("route \(key) \(route.file) \(route.policy)")
        }
        for file in files.sorted(by: { byBytes($0.path, $1.path) }) {
            lines.append("file \(file.path) \(file.size) \(file.sha256)")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    public var canonicalText: String { Self.canonicalText(bridge: bridge, routes: routes, files: files) }

    /// The first 16 hex digits of the SHA-256 of the canonical text.
    public var workedOutId: String { String(Self.sha256Hex(Data(canonicalText.utf8)).prefix(16)) }

    static func byBytes(_ a: String, _ b: String) -> Bool { Array(a.utf8).lexicographicallyPrecedes(Array(b.utf8)) }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Paths and types

    /// bundle.mjs's PATH: at most four parts of lower-case letters, digits, dots, dashes and underscores,
    /// each 1 to 64 long and none starting with a dot, a dash or an underscore.
    public static func isPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard (1...4).contains(parts.count) else { return false }
        return parts.allSatisfy { part in
            guard (1...64).contains(part.count), let first = part.unicodeScalars.first, isLowerOrDigit(first) else { return false }
            return part.unicodeScalars.allSatisfy { isLowerOrDigit($0) || $0 == "." || $0 == "_" || $0 == "-" }
        }
    }

    /// The type of a file by the end of its path, from bundle.mjs's TYPES; nil for a kind a bundle may not hold.
    public static func contentType(_ path: String) -> String? {
        guard let dot = path.lastIndex(of: ".") else { return nil }
        switch path[path.index(after: dot)...] {
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "txt": return "text/plain; charset=utf-8"
        default: return nil
        }
    }

    static func isLowerOrDigit(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    static func isHex(_ text: String, count: Int) -> Bool {
        text.utf8.count == count && text.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    // MARK: Requests

    /// What the shell answers for a path of a request (its percent-encoded path, never decoded): a route's
    /// file with the route's policy, else the file of that path without its leading slash. Nil otherwise.
    public func lookup(_ requestPath: String) -> (file: File, policy: String?)? {
        let files = byPath
        if let route = routes[requestPath], let file = files[route.file] { return (file, route.policy) }
        guard requestPath.hasPrefix("/"), let file = files[String(requestPath.dropFirst())] else { return nil }
        return (file, nil)
    }
}
