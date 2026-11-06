import CraniumKit
import SwiftUI

/// Touch ID is on, and Cranium has just opened, or is back after its time away, or the Mac slept: the
/// mark, and nothing of the console, until Touch ID passes. It asks as soon as it shows; Cancel, or a
/// finger that does not match, leaves it here with "Unlock with Touch ID" and "Sign in with password",
/// as the iPhone's LockScreen does with Face ID.
struct LockView<Model: LockingModel>: View {
    @ObservedObject var model: Model

    var body: some View {
        let biometry = model.biometry ?? .touchID
        VStack(spacing: 18) {
            Image(systemName: biometry.symbol)
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Color.accentColor)
                .symbolRenderingMode(.hierarchical)
            VStack(spacing: 4) {
                Text("Cranium").font(.largeTitle.weight(.bold))
                Text(model.lockSubtitle).foregroundStyle(.secondary)
            }
            Text(BiometricWords.locked(biometry))
                .font(.title3)
            if let message = model.lockMessage {
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 420)
                    .multilineTextAlignment(.center)
            }
            HStack(spacing: 12) {
                Button(BiometricWords.password) {
                    Task { await model.signInWithPassword() }
                }
                Button {
                    Task { await model.unlock() }
                } label: {
                    Label(BiometricWords.unlock(biometry), systemImage: biometry.symbol)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.unlocking)
            }
            .controlSize(.large)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Opaque: nothing of the console shows through.
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            // As the phone's lock screen: ask as soon as it shows.
            if model.lockMessage == nil { await model.unlock() }
        }
    }
}

extension View {
    /// Over the console while it is locked again (back after its time away, the Mac asleep): the lock,
    /// and nothing of what is under it, for sight or for VoiceOver.
    func lockCover<Model: LockingModel>(_ model: Model) -> some View {
        modifier(LockCover(model: model))
    }
}

private struct LockCover<Model: LockingModel>: ViewModifier {
    @ObservedObject var model: Model

    func body(content: Content) -> some View {
        content
            .blur(radius: model.cover == nil ? 0 : 24)
            .accessibilityHidden(model.cover != nil)
            .allowsHitTesting(model.cover == nil)
            .overlay {
                if model.cover == .lock {
                    LockView(model: model)
                }
            }
    }
}
