import Foundation

/// Why an image was not sent: the console did not clear it right before the send. Nothing has gone
/// to the board when one of these is thrown.
public enum SendCheckError: Error, Equatable, LocalizedError {
    /// The console could not be reached. An image on the phone is never sent without its word.
    case unreachable(release: String)
    /// The console refused, in its own words: the release is revoked or unknown, or the image is
    /// not the release's, or the account may not send.
    case refused(release: String, message: String)
    /// The console answered, but not with this release, this SHA-256 and `active`.
    case notConfirmed(release: String)

    public var errorDescription: String? {
        switch self {
        case .unreachable(let release):
            return "Could not reach the console to check that \(release) may still be sent, so nothing was sent. "
                + "An image kept on this phone is only sent once the console says the release is still active. "
                + "Check the phone's connection, then send again."
        case .refused(let release, let message):
            return "The console did not clear \(release) for sending, so nothing was sent. \(message)"
        case .notConfirmed(let release):
            return "The console did not confirm that this image of \(release) is still active, so nothing was sent."
        }
    }
}

/// The console's word right before every Bluetooth send (docs/mobile-apps.md, "The API"):
/// `POST /api/firmware/{version}/bluetooth` with the SHA-256 of the image that is about to go and
/// the board's name. It is asked whether the image was downloaded just now, kept on the phone, or
/// checked earlier in this session, because only the console knows whether a release has been
/// revoked since. Only an answer of 200 that names the same release, the same SHA-256 and `active`
/// lets the image go. Whatever else comes back, or nothing at all because the phone is offline,
/// nothing is sent: there is no falling back on the cache, and no earlier answer counts.
public enum SendCheck {
    /// The request body: `{"sha256": "…", "board": "Cranium-1A2B"}`. `board` goes in only if it is
    /// a board's name, and is left out otherwise.
    public static func body(sha256: String, board: String?) -> Data {
        var fields = ["sha256": sha256]
        if let board, BoardName.isValid(board) {
            fields["board"] = board
        }
        // Two strings: this cannot fail.
        return (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])) ?? Data()
    }

    /// Returns only if `answer`, the body of a 200, clears `release` with exactly `sha256`: the
    /// same version, the same digest, and `active`.
    public static func requireCleared(_ answer: Data, release: String, sha256: String) throws {
        struct Answer: Decodable {
            let version: String?
            let sha256: String?
            let status: String?
        }
        guard let decoded = try? JSONDecoder().decode(Answer.self, from: answer),
              decoded.version == release, decoded.sha256 == sha256, decoded.status == "active" else {
            throw SendCheckError.notConfirmed(release: release)
        }
    }
}
