import CraniumKit
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if model.configSource == .example {
                    ExampleConfigBanner()
                }
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle(title)
            .toolbar {
                if signedIn {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            if let email = model.me?.email {
                                Text(email)
                            }
                            Divider()
                            Text(UserMessage.firmwareOnPhone(model.firmwareOnPhone))
                            Button("Clear downloaded firmware") {
                                Task { await model.clearFirmware() }
                            }
                            .disabled(model.firmwareOnPhone.count == 0)
                            Divider()
                            Button("Sign out", role: .destructive) {
                                Task { await model.signOut() }
                            }
                        } label: {
                            Image(systemName: "person.crop.circle")
                                .accessibilityLabel("Account")
                        }
                    }
                }
            }
        }
        .task { await model.start() }
    }

    @ViewBuilder private var content: some View {
        switch model.stage {
        case .loading:
            ProgressView()
        case .broken(let text):
            Notice(systemImage: "exclamationmark.triangle", title: "This build cannot be used", text: text)
        case .signedOut:
            SignInView()
        case .releases:
            ReleasesView()
        case .boards:
            BoardsView()
        case .board:
            BoardView()
        }
    }

    private var signedIn: Bool {
        switch model.stage {
        case .releases, .boards, .board: return true
        default: return false
        }
    }

    private var title: String {
        switch model.stage {
        case .releases: return "Releases"
        case .boards: return "Find the board"
        case .board: return model.boardName ?? "Board"
        default: return "Cranium"
        }
    }
}

/// Shown on every screen of a build made without apps/config/cranium.json.
struct ExampleConfigBanner: View {
    var body: some View {
        Text("Example configuration: this build was made without apps/config/cranium.json, so sign-in cannot work. Run apps/configure.sh and build again.")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.black)
            .padding(10)
            .frame(maxWidth: .infinity)
            .background(Color.orange)
            .accessibilityIdentifier("example-config-banner")
    }
}

struct Notice: View {
    let systemImage: String
    let title: String
    let text: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(text)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding(24)
    }
}

/// An error or a warning on the current screen.
struct MessageText: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A full-width button at the foot of a screen.
struct WideButton: View {
    let title: String
    var busy = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                if busy { ProgressView() }
                Text(title).frame(maxWidth: .infinity)
            }
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .disabled(busy || !enabled)
    }
}
