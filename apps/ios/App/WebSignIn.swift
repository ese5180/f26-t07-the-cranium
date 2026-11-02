import AuthenticationServices
import CraniumKit
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Cognito's managed login in the system's web authentication session, which hands back the
/// `cranium://signin?code=…` redirect. The session is ephemeral: it shares no cookies with
/// Safari, so signing out of the app really signs out, and the next person signs in afresh.
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var anchor: ASPresentationAnchor?

    /// On the main actor: the session is made and started there, as UIKit needs.
    @MainActor
    func signIn(url: URL, callbackScheme: String, anchor: ASPresentationAnchor) async throws -> URL {
        self.anchor = anchor
        defer {
            self.session = nil
            self.anchor = nil
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: AuthError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? AuthError.badCallback)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            if !session.start() {
                // The completion handler is not called when the session does not start.
                continuation.resume(throwing: AuthError.refused("The sign-in page could not be opened."))
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }

    /// The window to show the sign-in page over.
    @MainActor
    static func currentAnchor() -> ASPresentationAnchor {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let key = scenes.flatMap(\.windows).first(where: \.isKeyWindow) {
            return key
        }
        if let scene = scenes.first {
            return UIWindow(windowScene: scene)
        }
        return ASPresentationAnchor()
        #else
        return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
        #endif
    }
}
