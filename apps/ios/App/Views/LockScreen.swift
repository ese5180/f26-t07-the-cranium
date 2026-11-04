import CraniumKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Face ID is on, and the app has just opened or is back after 5 minutes: the console's mark, and
/// nothing of the console, until Face ID passes (docs/mobile-apps.md, "Unlocking with Face ID").
/// It asks as soon as it shows; Cancel, or a face that does not match, leaves it here with
/// "Unlock with Face ID" and "Sign in with password". With `privacy`, only the mark: what the app
/// switcher shows while the app is away.
struct LockScreen: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    var privacy = false

    var body: some View {
        let biometry = app.biometry ?? .faceID
        VStack(spacing: 0) {
            if !privacy {
                HStack {
                    Spacer()
                    HelpButton(topic: "biometric-sign-in")
                        .font(.title3)
                }
                .padding(.top, 8)
            }
            Spacer()
            CraniumMark()
                .frame(width: 76, height: 76)
            Text("Cranium")
                .font(.system(size: 30, weight: .bold))
                .tracking(-0.8)
                .foregroundStyle(theme.ink)
                .padding(.top, 18)
            Text("Firmware console")
                .font(.subheadline)
                .foregroundStyle(theme.ink3)
                .padding(.top, 2)
            if !privacy {
                Text(BiometricWords.locked(biometry))
                    .font(.body)
                    .foregroundStyle(theme.ink2)
                    .multilineTextAlignment(.center)
                    .padding(.top, 28)
                if let message = app.lockMessage {
                    Notice(.bad, "alert", message)
                        .foregroundStyle(theme.ink)
                        .padding(.top, 18)
                        .transition(.opacity)
                }
            }
            Spacer()
            if !privacy {
                VStack(spacing: 6) {
                    PrimaryButton(BiometricWords.unlock(biometry), systemImage: biometry.symbol, busy: app.unlocking) {
                        Task { await app.unlock() }
                    }
                    .controlSize(.large)
                    .disabled(app.unlocking)
                    Button(BiometricWords.password) {
                        Task { await app.signInWithPassword() }
                    }
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(app.unlocking)
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.paper.ignoresSafeArea())
        // Not a foreground style for all of it: the prominent button keeps its own white label.
        .tint(theme.accent)
        .animation(.easeOut(duration: 0.2), value: app.lockMessage)
        // Again when the app switcher's mark turns into the lock, in the same window.
        .task(id: privacy) {
            guard !privacy else { return }
            // Once the app is active: a prompt asked for any earlier is refused, as a Cancel.
            try? await Task.sleep(nanoseconds: 350_000_000)
            #if canImport(UIKit)
            for _ in 0..<30 where UIApplication.shared.applicationState != .active {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            #endif
            guard !Task.isCancelled else { return }
            #if DEBUG
            // Demo mode: `-CraniumBiometric lock` keeps it on screen for its screenshot.
            if Demo.isOn, Demo.biometric == "lock" { return }
            #endif
            await app.unlock()
        }
    }
}

/// After a full sign-in, once: "Use Face ID to open Cranium?". Yes asks for Face ID once and turns
/// it on; Not now, or pulling the sheet down, leaves it off (More, Account turns it on later).
struct BiometricOfferSheet: View {
    @Environment(\.theme) private var theme
    let biometry: Biometry
    let answer: (Bool) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: biometry.symbol)
                .font(.system(size: 46, weight: .regular))
                .foregroundStyle(theme.accent)
                .padding(.top, 34)
                .accessibilityHidden(true)
            Text(BiometricWords.offerTitle(biometry))
                .font(.title2.weight(.bold))
                .foregroundStyle(theme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
                .accessibilityAddTraits(.isHeader)
            Text(BiometricWords.offerText(biometry))
                .font(.body)
                .foregroundStyle(theme.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
            Spacer(minLength: 24)
            PrimaryButton(BiometricWords.offerYes(biometry), systemImage: biometry.symbol) { answer(true) }
                .controlSize(.large)
            Button(BiometricWords.notNow) { answer(false) }
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.top, 4)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.paper.ignoresSafeArea())
        .tint(theme.accent)
        #if os(iOS)
        .presentationDetents([.height(400)])
        .presentationDragIndicator(.visible)
        #endif
    }
}

extension View {
    /// The cover over the running console (AppModel's `cover`): on the iPhone in a window of its own
    /// above every sheet and full-screen cover, so that nothing of the console shows in the app
    /// switcher or before Face ID passes; elsewhere an overlay.
    func lockCover(_ app: AppModel) -> some View {
        modifier(LockCover(app: app))
    }
}

private struct LockCover: ViewModifier {
    @ObservedObject var app: AppModel
    #if canImport(UIKit)
    @State private var window = CoverWindow()
    #endif

    func body(content: Content) -> some View {
        #if canImport(UIKit)
        content
            .accessibilityHidden(app.cover != nil)
            .onChange(of: app.cover) { cover in
                if let cover {
                    window.show(LockScreen(privacy: cover == .privacy).environmentObject(app), lock: cover == .lock)
                } else {
                    window.hide()
                }
            }
        #else
        content
            .accessibilityHidden(app.cover != nil)
            .overlay {
                if let cover = app.cover {
                    LockScreen(privacy: cover == .privacy).environmentObject(app)
                }
            }
        #endif
    }
}

#if canImport(UIKit)
/// A window above the app's own (and its sheets, alerts and the Bluetooth screen) for the cover.
@MainActor
private final class CoverWindow {
    private var window: UIWindow?

    func show<Content: View>(_ content: Content, lock: Bool) {
        if lock {
            // A keyboard would stay above the cover.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        if let host = window?.rootViewController as? UIHostingController<AnyView> {
            host.rootView = AnyView(content)
            return
        }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.rootViewController = UIHostingController(rootView: AnyView(content))
        window.isHidden = false
        self.window = window
    }

    func hide() {
        window?.isHidden = true
        window = nil
    }
}
#endif
