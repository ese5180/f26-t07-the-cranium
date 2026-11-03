import Foundation

/// The website's History page: the project's commits, newest first, and what the console was built
/// from. The data is `history.json` beside the console's scripts (cloud/web/build-history.mjs).
public struct CommitHistory: Equatable, Sendable {
    public struct Commit: Equatable, Sendable, Identifiable {
        public let hash: String
        public let short: String
        public let date: String
        public let subject: String
        public let tags: [String]

        public var id: String { hash }
        /// Where a person can read it. Nothing is fetched from there.
        public var link: URL? { URL(string: CommitHistory.commitBase + hash) }
    }

    public let commits: [Commit]
    /// The commit this deployment of the console was built from, if known.
    public let builtFrom: String?
    /// clean, dirty or unknown.
    public let tree: String
    public let deployedAt: String?

    public static let commitBase = "https://github.com/ese5180/f26-t07-the-cranium/commit/"
    /// The same names in the same order as cloud/web/build-history.mjs.
    public static let tags: [(id: String, label: String)] = [
        ("website", "Website"), ("firmware", "Firmware"), ("cloud", "Cloud"), ("tools", "Tools"), ("ci", "CI"), ("docs", "Docs"),
    ]

    public static func tagLabel(_ id: String) -> String? {
        tags.first { $0.id == id }?.label
    }

    /// The file's data with only what the page uses, or nil if it is not what was written.
    public static func parse(_ data: Data) -> CommitHistory? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["commits"] as? [Any] else { return nil }
        let known = Set(tags.map(\.id))
        var commits: [Commit] = []
        for item in list.prefix(300) {
            guard let commit = item as? [String: Any], let hash = commit["hash"] as? String, isHash(hash),
                  let subject = commit["subject"] as? String, let date = commit["date"] as? String else { return nil }
            let short = commit["short"] as? String ?? String(hash.prefix(7))
            let tags = (commit["tags"] as? [Any] ?? []).compactMap { $0 as? String }.filter { known.contains($0) }
            commits.append(Commit(hash: hash, short: String(short.prefix(12)), date: date,
                                  subject: String(subject.prefix(300)), tags: tags))
        }
        let built = root["deployment"] as? [String: Any]
        let commit = (built?["commit"] as? String).flatMap { isHash($0) ? $0 : nil }
        let tree = (built?["tree"] as? String).flatMap { ["clean", "dirty"].contains($0) ? $0 : nil } ?? "unknown"
        return CommitHistory(commits: commits, builtFrom: commit, tree: tree, deployedAt: built?["deployedAt"] as? String)
    }

    /// The build id in the console's own page: its scripts are under `/assets/<build>/`.
    public static func buildId(inIndex html: String) -> String? {
        guard let range = html.range(of: #"/assets/([A-Za-z0-9._-]{1,64})/app\.js"#, options: .regularExpression) else {
            return nil
        }
        let match = html[range]
        let build = match.dropFirst("/assets/".count).dropLast("/app.js".count)
        return build.isEmpty || build == "." || build == ".." ? nil : String(build)
    }

    private static func isHash(_ text: String) -> Bool {
        text.range(of: "^[0-9a-f]{7,64}$", options: .regularExpression) != nil
    }
}
