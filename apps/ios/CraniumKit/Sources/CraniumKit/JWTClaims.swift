import Foundation

/// What the app reads in its own access token: when the person signed in (`auth_time`), the claim
/// the console's 15-minute rule checks, which a refresh keeps. The signature is not checked: the
/// token came from Cognito over TLS, and the console checks it on every call; this only decides
/// how long the phone keeps the refresh token. Nothing here is logged.
enum JWTClaims {
    /// The claims of a JWT, or nil if `token` is not one.
    static func claims(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object
    }

    /// `auth_time`, in seconds since 1970.
    static func authTime(_ token: String) -> Date? {
        guard let seconds = (claims(token)?["auth_time"] as? NSNumber)?.doubleValue, seconds.isFinite, seconds > 0 else {
            return nil
        }
        return Date(timeIntervalSince1970: seconds)
    }
}
