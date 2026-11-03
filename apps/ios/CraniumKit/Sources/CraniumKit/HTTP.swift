import Foundation

/// What the API client and sign-in need from the network. `URLSession` is one; tests use a fake.
public protocol HTTPClient: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPClient {
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

/// `application/x-www-form-urlencoded`, for OAuth requests and the authorize URL.
enum FormEncoding {
    private static let unreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// For a request body: everything but the unreserved characters is encoded, spaces as `+`.
    static func body(_ items: [(String, String)]) -> Data {
        Data(encode(items, allowed: unreserved).utf8)
    }

    /// For a URL's query: `:` and `/` stay as they are, which RFC 3986 allows in a query, so that
    /// the authorize URL reads as the contract writes it (`redirect_uri=cranium://signin`,
    /// `scope=openid+cranium/console`).
    static func query(_ items: [(String, String)]) -> String {
        encode(items, allowed: unreserved.union(CharacterSet(charactersIn: ":/")))
    }

    private static func encode(_ items: [(String, String)], allowed: CharacterSet) -> String {
        let withSpace = allowed.union(CharacterSet(charactersIn: " "))
        func one(_ text: String) -> String {
            (text.addingPercentEncoding(withAllowedCharacters: withSpace) ?? "")
                .replacingOccurrences(of: " ", with: "+")
        }
        return items.map { "\(one($0.0))=\(one($0.1))" }.joined(separator: "&")
    }

    /// For the query of an API call: the same, under its own name.
    static func urlQuery(_ items: [(String, String)]) -> String {
        query(items)
    }

    /// One path segment: everything but the unreserved characters is encoded, so `1.8.0+0`
    /// becomes `1.8.0%2B0`.
    static func pathSegment(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }
}
