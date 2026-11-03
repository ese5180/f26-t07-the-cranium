import Foundation

/// Reading the console's answers the way the website does (core.js, "Reading API replies"): every
/// answer is rebuilt field by field. An answer whose outline is wrong is an error; a single odd
/// value becomes nil or a harmless default, and never fails the whole list.
struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

extension KeyedDecodingContainer {
    /// The value, or nil when it is missing, null, or of another type.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }

    /// Text cut to `limit` characters; "" when missing or not text.
    func text(_ key: Key, limit: Int = 200) -> String {
        String((lenient(String.self, key) ?? "").prefix(limit))
    }

    /// Text that is there and not empty, else nil.
    func optionalText(_ key: Key, limit: Int = 200) -> String? {
        let value = text(key, limit: limit)
        return value.isEmpty ? nil : value
    }

    /// Text that came from a board: printable ASCII only, and short. Anything else becomes "?".
    func boardText(_ key: Key, limit: Int = 96) -> String {
        Lenient.boardText(lenient(String.self, key) ?? "", limit: limit)
    }

    /// A whole number from `least` to `most`, else nil. A number with a fraction is not one.
    func whole(_ key: Key, _ least: Int, _ most: Int) -> Int? {
        guard let value = lenient(Double.self, key), value.rounded() == value,
              value >= Double(least), value <= Double(most) else { return nil }
        return Int(value)
    }

    /// A time the API wrote (ISO 8601), else nil.
    func instant(_ key: Key) -> String? {
        guard let value = lenient(String.self, key), ConsoleTime.date(value) != nil else { return nil }
        return value
    }

    /// A release version, `1.8.0+0`, else nil.
    func version(_ key: Key) -> String? {
        guard let value = lenient(String.self, key), Lenient.isVersion(value) else { return nil }
        return value
    }

    /// The strings of a list, each cut to `limit`; anything else in it is left out.
    func texts(_ key: Key, limit: Int = 64) -> [String] {
        guard let values = lenient([LenientScalar].self, key) else { return [] }
        return values.compactMap { $0.string.map { String($0.prefix(limit)) } }
    }

    func bool(_ key: Key) -> Bool {
        lenient(Bool.self, key) ?? false
    }
}

/// A JSON value that is a string, a number or a boolean, or something else that is ignored.
struct LenientScalar: Decodable {
    let string: String?
    let number: Double?

    init(from decoder: Decoder) throws {
        let single = try decoder.singleValueContainer()
        if let text = try? single.decode(String.self) {
            string = text
            number = nil
        } else if let value = try? single.decode(Double.self) {
            number = value
            string = nil
        } else {
            string = nil
            number = nil
        }
    }

    /// As the website writes a detail of the activity log: a string as it is, a number as text.
    var asText: String? {
        if let string { return string }
        guard let number else { return nil }
        return number.rounded() == number && abs(number) < 1e15 ? String(Int64(number)) : String(number)
    }
}

/// A list whose items are each read on their own: one that cannot be read is left out.
struct LenientList<Element: Decodable>: Decodable {
    let items: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var items: [Element] = []
        while !container.isAtEnd {
            if let item = try? container.decode(Element.self) {
                items.append(item)
            } else {
                _ = try? container.decode(Skip.self)
            }
        }
        self.items = items
    }

    private struct Skip: Decodable {}
}

public enum Lenient {
    /// `1.8.0+0`, with the bounds of an MCUboot version and no leading zeros.
    public static func isVersion(_ text: String) -> Bool {
        FirmwareVersion(release: text) != nil
    }

    /// Printable ASCII, each other character as "?", at most `limit` characters.
    public static func boardText(_ text: String, limit: Int = 96) -> String {
        String(String(text.unicodeScalars.map { (0x20...0x7E).contains($0.value) ? Character($0) : "?" }).prefix(limit))
    }
}

/// Times as the API writes them: ISO 8601 in UTC, with or without milliseconds.
public enum ConsoleTime {
    public static func date(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle()) {
            return date
        }
        return nil
    }

    /// `2026-11-02T14:30:00.000Z`, as the API takes a time in a query.
    public static func text(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}
