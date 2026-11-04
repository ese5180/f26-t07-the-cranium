import Foundation

/// The Help topics, from `apps/shared/help.json`, which both phone apps can read. Each topic is a
/// list of blocks: a heading, a paragraph, numbered steps, a list, rows of a label and its text, a
/// note, links to other topics, and links out.
public struct HelpBook: Decodable, Equatable, Sendable {
    public struct Section: Decodable, Equatable, Sendable {
        public let title: String
        public let topics: [String]
    }

    public enum Block: Equatable, Sendable {
        case heading(String)
        case text(String)
        case steps([String])
        case list([String])
        case rows([(label: String, text: String)])
        case note(String)
        case see([String])
        case links([(title: String, url: URL)])

        public static func == (a: Block, b: Block) -> Bool {
            switch (a, b) {
            case (.heading(let x), .heading(let y)), (.text(let x), .text(let y)), (.note(let x), .note(let y)): return x == y
            case (.steps(let x), .steps(let y)), (.list(let x), .list(let y)), (.see(let x), .see(let y)): return x == y
            case (.rows(let x), .rows(let y)): return x.map(\.label) == y.map(\.label) && x.map(\.text) == y.map(\.text)
            case (.links(let x), .links(let y)): return x.map(\.title) == y.map(\.title) && x.map(\.url) == y.map(\.url)
            default: return false
            }
        }

        /// The words of the block, for search.
        var plainText: String {
            switch self {
            case .heading(let text), .text(let text), .note(let text): return text
            case .steps(let items), .list(let items): return items.joined(separator: " ")
            case .rows(let rows): return rows.map { "\($0.label) \($0.text)" }.joined(separator: " ")
            case .see: return ""
            case .links(let links): return links.map(\.title).joined(separator: " ")
            }
        }
    }

    public struct Topic: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let summary: String
        public let keywords: [String]
        /// Where every fact of the topic comes from, in the repository.
        public let sources: [String]
        public let blocks: [Block]

        /// The topic's words, for search.
        public var plainText: String { blocks.map(\.plainText).joined(separator: " ") }

        private enum CodingKeys: String, CodingKey { case id, title, summary, keywords, sources, blocks }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decode(String.self, forKey: .title)
            summary = try c.decode(String.self, forKey: .summary)
            keywords = try c.decodeIfPresent([String].self, forKey: .keywords) ?? []
            sources = try c.decodeIfPresent([String].self, forKey: .sources) ?? []
            blocks = try c.decode([RawBlock].self, forKey: .blocks).map(\.block)
        }
    }

    /// One block as the file writes it: an object with one key, its kind.
    struct RawBlock: Decodable {
        let block: Block

        private enum Kind: String, CodingKey { case heading, text, steps, list, rows, note, see, links }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Kind.self)
            guard c.allKeys.count == 1, let kind = c.allKeys.first else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "a block has one kind"))
            }
            switch kind {
            case .heading: block = .heading(try c.decode(String.self, forKey: kind))
            case .text: block = .text(try c.decode(String.self, forKey: kind))
            case .note: block = .note(try c.decode(String.self, forKey: kind))
            case .steps: block = .steps(try c.decode([String].self, forKey: kind))
            case .list: block = .list(try c.decode([String].self, forKey: kind))
            case .see: block = .see(try c.decode([String].self, forKey: kind))
            case .rows:
                let rows = try c.decode([[String]].self, forKey: kind)
                guard rows.allSatisfy({ $0.count == 2 }) else {
                    throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "a row is a label and a text"))
                }
                block = .rows(rows.map { ($0[0], $0[1]) })
            case .links:
                let links = try c.decode([[String]].self, forKey: kind)
                block = .links(try links.map { pair in
                    guard pair.count == 2, let url = URL(string: pair[1]), url.scheme == "https" else {
                        throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "a link is a title and an https address"))
                    }
                    return (pair[0], url)
                })
            }
        }
    }

    public let version: Int
    public let sections: [Section]
    public let topics: [Topic]

    public func topic(_ id: String) -> Topic? {
        topics.first { $0.id == id }
    }

    /// Reads the file, and checks that it holds together: unique ids, sections and links that name
    /// topics that exist, and every topic in a section.
    public static func load(_ data: Data) throws -> HelpBook {
        let book = try JSONDecoder().decode(HelpBook.self, from: data)
        let ids = book.topics.map(\.id)
        guard Set(ids).count == ids.count else { throw HelpError.duplicateTopic }
        let known = Set(ids)
        let listed = book.sections.flatMap(\.topics)
        if let missing = listed.first(where: { !known.contains($0) }) { throw HelpError.unknownTopic(missing) }
        if let unlisted = ids.first(where: { !listed.contains($0) }) { throw HelpError.unlistedTopic(unlisted) }
        for topic in book.topics {
            for case .see(let others) in topic.blocks {
                if let missing = others.first(where: { !known.contains($0) }) { throw HelpError.unknownTopic(missing) }
            }
        }
        return book
    }

    /// From an app's bundle, where the build puts `help.json`.
    public static func load(from bundle: Bundle) throws -> HelpBook {
        guard let url = bundle.url(forResource: "help", withExtension: "json") else { throw HelpError.missing }
        return try load(Data(contentsOf: url))
    }
}

public enum HelpError: Error, Equatable {
    case missing
    case duplicateTopic
    case unknownTopic(String)
    case unlistedTopic(String)
}
