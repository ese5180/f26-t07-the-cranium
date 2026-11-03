import Foundation

/// A change made from the phone (an upload, a revocation, a deployment, a cancellation, an API
/// token made or ended) needs a sign-in, with password and code, in the last 15 minutes. A phone
/// whose sign-in is older gets `403 phone_sign_in_again` (docs/mobile-apps.md, "Signing in"). The
/// app then asks the person to sign in again, and retries the change once, with what they had
/// entered.
public enum FreshSignIn {
    public static let code = "phone_sign_in_again"
    /// How recent the sign-in has to be, as the API counts it.
    public static let window: TimeInterval = 15 * 60

    /// What the app says when it asks.
    public static let ask = "To change anything from the phone, sign in again first: a change from the phone needs a sign-in in the last 15 minutes."

    public static func isNeeded(_ error: Error) -> Bool {
        (error as? APIError)?.needsFreshSignIn == true
    }

    /// Runs `change`. If the console asks for a fresh sign-in, calls `signInAgain`, which asks the
    /// person and signs in (false: they did not), then runs `change` once more. A second refusal is
    /// thrown as it is; so is any other error.
    public static func run<T>(isolation: isolated (any Actor)? = #isolation,
                              _ change: () async throws -> T,
                              signInAgain: () async throws -> Bool) async throws -> T {
        do {
            return try await change()
        } catch let error as APIError where error.needsFreshSignIn {
            guard try await signInAgain() else { throw FreshSignInError.declined }
            return try await change()
        }
    }
}

public enum FreshSignInError: Error, Equatable, LocalizedError {
    /// The person did not sign in again: nothing was changed.
    case declined
    /// Someone else signed in: the change was not made in their name.
    case otherAccount

    public var errorDescription: String? {
        switch self {
        case .declined:
            return "Nothing was changed. A change from the phone needs a sign-in in the last 15 minutes."
        case .otherAccount:
            return "Another account signed in, so nothing was changed in its name. Check what you entered, and try again."
        }
    }
}
