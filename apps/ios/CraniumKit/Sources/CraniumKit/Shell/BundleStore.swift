import Foundation

/// Fetches a bundle's manifest and files over HTTPS. `URLSession` makes one in the app; tests use a fake.
public protocol BundleFetcher: Sendable {
    /// The body of a 200 answer to `url`, at most `limit` bytes; throws for anything else.
    func fetch(_ url: URL, limit: Int) async throws -> Data
}

/// A bundle the web view can be served from: its manifest, and the folder its files are in, each named by
/// its SHA-256. Reading a file needs nothing else, so the scheme handler can do it on any thread.
public struct LoadedBundle: Equatable, Sendable {
    public enum Source: String, Sendable {
        case downloaded
        case builtIn = "built-in"
    }

    public let manifest: BundleManifest
    public let source: Source
    /// Where `<sha256>` files are.
    public let objects: URL

    public init(manifest: BundleManifest, source: Source, objects: URL) {
        self.manifest = manifest
        self.source = source
        self.objects = objects
    }

    public var id: String { manifest.id }

    /// What a request for `path` (percent-encoded, never decoded) is answered with, or nil for a 404.
    public func serve(_ path: String) -> (data: Data, type: String, policy: String?)? {
        guard let (file, policy) = manifest.lookup(path), let type = BundleManifest.contentType(file.path),
              let data = try? Data(contentsOf: objects.appendingPathComponent(file.sha256, isDirectory: false)),
              data.count == file.size else { return nil }
        return (data, type, policy)
    }

    /// Every file is there, of its size and with its SHA-256.
    func isWhole() -> Bool {
        manifest.objects.allSatisfy { digest in
            let size = manifest.files.first { $0.sha256 == digest }?.size
            guard let data = try? Data(contentsOf: objects.appendingPathComponent(digest, isDirectory: false)) else { return false }
            return data.count == size && BundleManifest.sha256Hex(data) == digest
        }
    }
}

/// The bundles kept on the phone (apps/shared/bridge.json, "bundle"; docs/mobile-apps.md "The app shell").
///
///     <root>/objects/<sha256>   each file, checked against its size and SHA-256 before it is renamed into place
///     <root>/current.json       the manifest of the newest bundle
///     <root>/previous.json      the one before it
///     <root>/state.json         which bundles started, which said app.ready, which are bad
///
/// The root is in Application Support, kept out of backups. A path in a manifest is only ever a key: no file
/// on the phone is named after one, so no manifest can reach outside `objects/`.
///
/// At launch: the current bundle if every file it names is there and checks out and it is not bad; else the
/// previous one, the same way; else the one built into the app. A downloaded bundle that has not said
/// app.ready after two starts is bad, and is never fetched again. A downloaded bundle of an older console
/// than the built-in one gives way to it: an app built with newer pages than the console has deployed (a
/// new page, such as Offline, waiting for its console release) shows them. Equal or unknown versions keep
/// the downloaded one, as before. Its starts are counted as a download's are: built-in pages that have not
/// said app.ready after two starts give way to the downloaded bundle again, so that a broken build cannot
/// keep a phone on a blank page.
public actor BundleStore {
    public enum UpdateOutcome: Equatable, Sendable {
        case upToDate
        case updated(BundleManifest)
        /// The console's bundle needs a newer bridge than this app has: the app itself needs an update.
        case needsNewerApp
        /// That bundle was bad here before.
        case refused
        case failed(String)
    }

    struct State: Codable, Equatable {
        struct Entry: Codable, Equatable {
            var tries: Int
            var good: Bool
        }

        var bundles: [String: Entry] = [:]
        var bad: [String] = []
        /// The console's last manifest asked for a newer bridge than this app's.
        var needsNewerApp = false
    }

    /// Starts without app.ready after which a bundle is bad.
    public static let maxTries = 2
    /// Downloads at once.
    public static let parallel = 4

    private let root: URL
    private let builtIn: URL?
    private let fileManager = FileManager.default

    /// - Parameters:
    ///   - root: the folder for downloaded bundles.
    ///   - builtIn: the folder that cloud/web/build-bundle.mjs wrote into the app: manifest.json and files/.
    public init(root: URL, builtIn: URL?) {
        self.root = root
        self.builtIn = builtIn
    }

    private var objectsDir: URL { root.appendingPathComponent("objects", isDirectory: true) }
    private var currentFile: URL { root.appendingPathComponent("current.json") }
    private var previousFile: URL { root.appendingPathComponent("previous.json") }
    private var stateFile: URL { root.appendingPathComponent("state.json") }

    // MARK: State

    func loadState() -> State {
        guard let data = try? Data(contentsOf: stateFile), let state = try? JSONDecoder().decode(State.self, from: data) else {
            return State()
        }
        return state
    }

    private func save(_ state: State) {
        prepare()
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: stateFile, options: .atomic)
    }

    private func prepare() {
        try? fileManager.createDirectory(at: objectsDir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = root
        try? folder.setResourceValues(values)
    }

    private func manifest(at url: URL) -> BundleManifest? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? BundleManifest.read(data)
    }

    /// The built-in bundle's manifest, if its bridge is this app's: read only, its files not checked.
    private func builtInManifest() -> BundleManifest? {
        guard let builtIn, let manifest = manifest(at: builtIn.appendingPathComponent("manifest.json")),
              manifest.bridge <= Bridge.version else { return nil }
        return manifest
    }

    /// Whether console version `a` is newer than `b` ("2.27.0" against "2.25.5"); false when either is
    /// missing or not three numbers, so that a manifest without a version keeps the rule from before.
    public static func isNewer(_ a: String?, than b: String?) -> Bool {
        func parts(_ text: String?) -> [Int]? {
            guard let text, let core = text.split(separator: "+").first else { return nil }
            let numbers = core.split(separator: ".", omittingEmptySubsequences: false).compactMap { Int($0) }
            return numbers.count == 3 && core.split(separator: ".").count == 3 ? numbers : nil
        }
        guard let x = parts(a), let y = parts(b) else { return false }
        return y.lexicographicallyPrecedes(x)
    }

    /// The built-in bundle, when it is of a newer console than `manifest` and checks out.
    /// Only while those pages have not failed to start twice: `state` counts their starts like a download's.
    private func builtInNewer(than manifest: BundleManifest, state: State) -> LoadedBundle? {
        guard let shipped = builtInManifest(), Self.isNewer(shipped.consoleVersion, than: manifest.consoleVersion) else { return nil }
        let entry = state.bundles[shipped.id] ?? State.Entry(tries: 0, good: false)
        if !entry.good && entry.tries >= Self.maxTries { return nil }
        return builtInBundle()
    }

    /// The built-in bundle, checked; nil if the app has none or it does not check out.
    public func builtInBundle() -> LoadedBundle? {
        guard let builtIn, let manifest = manifest(at: builtIn.appendingPathComponent("manifest.json")),
              manifest.bridge <= Bridge.version else { return nil }
        let bundle = LoadedBundle(manifest: manifest, source: .builtIn, objects: builtIn.appendingPathComponent("files", isDirectory: true))
        return bundle.isWhole() ? bundle : nil
    }

    // MARK: Launch

    /// The bundle to start from, as above. Counts the start of a downloaded bundle that has not yet said
    /// app.ready. Nil when there is none at all, the built-in one included.
    public func launch() -> LoadedBundle? {
        var state = loadState()
        for file in [currentFile, previousFile] {
            guard let manifest = manifest(at: file), manifest.bridge <= Bridge.version,
                  !state.bad.contains(manifest.id) else { continue }
            var entry = state.bundles[manifest.id] ?? State.Entry(tries: 0, good: false)
            if !entry.good && entry.tries >= Self.maxTries {
                markBad(manifest.id, in: &state)
                continue
            }
            // Older than the pages built into the app: those, and no start of this one is counted.
            if let shipped = builtInNewer(than: manifest, state: state) {
                var own = state.bundles[shipped.id] ?? State.Entry(tries: 0, good: false)
                if !own.good {
                    own.tries += 1
                    state.bundles[shipped.id] = own
                }
                save(state)
                return shipped
            }
            let bundle = LoadedBundle(manifest: manifest, source: .downloaded, objects: objectsDir)
            guard bundle.isWhole() else { continue }
            if !entry.good {
                entry.tries += 1
                state.bundles[manifest.id] = entry
            }
            save(state)
            return bundle
        }
        save(state)
        return builtInBundle()
    }

    private func markBad(_ id: String, in state: inout State) {
        if !state.bad.contains(id) { state.bad.append(id) }
        if state.bad.count > 20 { state.bad.removeFirst(state.bad.count - 20) }
        state.bundles[id] = nil
    }

    /// The page started from this bundle (app.ready): it is good.
    public func markReady(_ id: String) {
        var state = loadState()
        guard !state.bad.contains(id) else { return }
        if state.bundles[id] != nil || manifest(at: currentFile)?.id == id || manifest(at: previousFile)?.id == id {
            state.bundles[id] = State.Entry(tries: state.bundles[id]?.tries ?? 1, good: true)
            save(state)
        }
    }

    public func isBad(_ id: String) -> Bool { loadState().bad.contains(id) }

    /// Whether the console's last manifest needed a newer bridge than this app has.
    public func needsNewerApp() -> Bool { loadState().needsNewerApp }

    /// The newest bundle that may be shown now: what `launch` would pick, without counting a start.
    public func newest() -> LoadedBundle? {
        let state = loadState()
        for file in [currentFile, previousFile] {
            guard let manifest = manifest(at: file), manifest.bridge <= Bridge.version, !state.bad.contains(manifest.id) else { continue }
            let entry = state.bundles[manifest.id] ?? State.Entry(tries: 0, good: false)
            if !entry.good && entry.tries >= Self.maxTries { continue }
            if let shipped = builtInNewer(than: manifest, state: state) { return shipped }
            let bundle = LoadedBundle(manifest: manifest, source: .downloaded, objects: objectsDir)
            if bundle.isWhole() { return bundle }
        }
        return builtInBundle()
    }

    // MARK: Update

    /// Fetches the console's manifest and, if it is a new bundle, every file it names that is not kept
    /// yet, checks each, and makes it the current one; the old current one becomes the previous one.
    /// `keeping` is the bundle on screen, whose files are not deleted while it is.
    public func update(consoleURL: URL, fetcher: BundleFetcher, keeping active: LoadedBundle? = nil) async -> UpdateOutcome {
        let manifestURL = consoleURL.appendingPathComponent("app").appendingPathComponent("manifest.json")
        let fresh: BundleManifest
        let text: Data
        do {
            text = try await fetcher.fetch(manifestURL, limit: BundleManifest.maxBytes)
            fresh = try BundleManifest.read(text)
        } catch let error as BundleManifest.ReadError {
            return .failed(error.localizedDescription)
        } catch {
            return .failed("The console's bundle could not be fetched: \(error.localizedDescription)")
        }
        var state = loadState()
        guard fresh.bridge <= Bridge.version else {
            state.needsNewerApp = true
            save(state)
            return .needsNewerApp
        }
        if state.needsNewerApp {
            state.needsNewerApp = false
            save(state)
        }
        guard !state.bad.contains(fresh.id) else { return .refused }
        // The console's pages are older than the ones built into the app: nothing to fetch or to offer.
        if let shipped = builtInManifest(), Self.isNewer(shipped.consoleVersion, than: fresh.consoleVersion) {
            return .upToDate
        }
        let current = manifest(at: currentFile)
        if current?.id == fresh.id, LoadedBundle(manifest: fresh, source: .downloaded, objects: objectsDir).isWhole() {
            return .upToDate
        }
        prepare()
        let missing = fresh.files.reduce(into: [String: Int]()) { wanted, file in
            if !has(file.sha256, size: file.size) { wanted[file.sha256] = file.size }
        }
        do {
            try await download(missing, from: consoleURL, fetcher: fetcher)
        } catch {
            return .failed("A file of the console's bundle could not be fetched: \(error.localizedDescription)")
        }
        guard LoadedBundle(manifest: fresh, source: .downloaded, objects: objectsDir).isWhole() else {
            return .failed("A file of the console's bundle did not check out.")
        }
        // The manifest as it came, so that it reads the same again.
        let work = root.appendingPathComponent("current.json.tmp")
        do {
            try text.write(to: work, options: .atomic)
            if current != nil, current?.id != fresh.id {
                if fileManager.fileExists(atPath: previousFile.path) { try fileManager.removeItem(at: previousFile) }
                try fileManager.moveItem(at: currentFile, to: previousFile)
            }
            if fileManager.fileExists(atPath: currentFile.path) { try fileManager.removeItem(at: currentFile) }
            try fileManager.moveItem(at: work, to: currentFile)
        } catch {
            return .failed("The new bundle could not be kept: \(error.localizedDescription)")
        }
        state = loadState()
        state.bundles[fresh.id] = State.Entry(tries: 0, good: false)
        let previous = manifest(at: previousFile)
        let known = Set([fresh.id, previous?.id, active?.id].compactMap { $0 })
        state.bundles = state.bundles.filter { known.contains($0.key) }
        save(state)
        collect(keeping: [fresh, previous, active?.source == .downloaded ? active?.manifest : nil].compactMap { $0 })
        return .updated(fresh)
    }

    private func has(_ digest: String, size: Int) -> Bool {
        let url = objectsDir.appendingPathComponent(digest, isDirectory: false)
        guard let data = try? Data(contentsOf: url) else { return false }
        if data.count == size && BundleManifest.sha256Hex(data) == digest { return true }
        try? fileManager.removeItem(at: url)
        return false
    }

    /// Each file, `parallel` at a time: fetched, checked, written to a temporary file and renamed into place.
    private func download(_ wanted: [String: Int], from consoleURL: URL, fetcher: BundleFetcher) async throws {
        let items = Array(wanted)
        let dir = objectsDir
        var next = 0
        try await withThrowingTaskGroup(of: (String, Data).self) { group in
            func start() {
                guard next < items.count else { return }
                let (digest, size) = items[next]
                next += 1
                let url = consoleURL.appendingPathComponent("app").appendingPathComponent("files").appendingPathComponent(digest)
                group.addTask {
                    let data = try await fetcher.fetch(url, limit: size)
                    guard data.count == size, BundleManifest.sha256Hex(data) == digest else {
                        throw BundleManifest.ReadError.refused("a file that is not the one named")
                    }
                    return (digest, data)
                }
            }
            for _ in 0..<Self.parallel { start() }
            while let (digest, data) = try await group.next() {
                let work = dir.appendingPathComponent("\(digest).tmp", isDirectory: false)
                try data.write(to: work, options: .atomic)
                let target = dir.appendingPathComponent(digest, isDirectory: false)
                if fileManager.fileExists(atPath: target.path) { try fileManager.removeItem(at: target) }
                try fileManager.moveItem(at: work, to: target)
                start()
            }
        }
    }

    /// Deletes every file that none of `kept` names.
    private func collect(keeping kept: [BundleManifest]) {
        let wanted = kept.reduce(into: Set<String>()) { $0.formUnion($1.objects) }
        guard let names = try? fileManager.contentsOfDirectory(atPath: objectsDir.path) else { return }
        for name in names where !wanted.contains(name) {
            try? fileManager.removeItem(at: objectsDir.appendingPathComponent(name, isDirectory: false))
        }
    }
}
