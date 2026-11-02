import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "cpu")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Cranium")
                .font(.largeTitle.weight(.bold))
            Text("Send a firmware release from the console to a board over Bluetooth. Sign in with your console account: only a release manager can download firmware.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
            if let message = model.message {
                MessageText(text: message)
            }
            WideButton(title: "Sign in", busy: model.busy) {
                Task { await model.signIn() }
            }
        }
        .padding(24)
    }
}
