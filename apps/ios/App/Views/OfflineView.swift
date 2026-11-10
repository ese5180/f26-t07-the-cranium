import CraniumBLE
import CraniumKit
import SwiftUI

/// Offline mode (firmware 1.19.0): find a board, pair with its passkey, read its status, accept the
/// update that waits. It needs no internet. See docs/mobile-apps.md, "Offline mode".
struct OfflineFlow: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @ObservedObject var model: OfflineModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.stage {
                case .scanning: OfflineBoards(model: model)
                case .linked(let name): OfflineBoard(model: model, name: name)
                }
            }
            .navigationTitle("Offline")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        model.close()
                        dismiss()
                    }
                }
            }
        }
        .tint(theme.accent)
        .onAppear { model.start() }
    }
}

private struct OfflineBoards: View {
    @Environment(\.theme) private var theme
    @ObservedObject var model: OfflineModel

    var body: some View {
        ListScreen {
            Section {
                Label("Hold Button 1 for 5 s, until LED1 flashes four times.", systemImage: "hand.tap").font(.subheadline)
            } footer: {
                Text("This talks to the board directly, with no Wi-Fi or internet. The phone asks for the board's passkey, which Board setup showed once.")
            }
            Section("Boards with Bluetooth open") {
                if let problem = model.radioProblem {
                    StateRow(kind: .failed, text: problem)
                } else if model.boards.isEmpty {
                    StateRow(kind: .loading, text: "Looking…")
                }
                ForEach(model.boards) { board in
                    Button {
                        model.connect(board)
                    } label: {
                        HStack {
                            Text(verbatim: board.name).font(Typeface.thing)
                            Spacer()
                            SignalBars(bars: board.rssi >= -60 ? 4 : board.rssi >= -75 ? 3 : 2)
                        }
                    }
                    .foregroundStyle(theme.ink)
                    .accessibilityLabel("Connect to \(board.name)")
                }
            }
        }
    }
}

private struct OfflineBoard: View {
    @Environment(\.theme) private var theme
    @ObservedObject var model: OfflineModel
    let name: String

    var body: some View {
        ListScreen {
            Section {
                Text(verbatim: name).font(Typeface.thing)
            }
            switch model.link {
            case .connecting:
                Section { StateRow(kind: .loading, text: "Connecting…") }
            case .pairing:
                Section {
                    StateRow(kind: .loading, text: "Pairing. Type the board's passkey when the phone asks for it.")
                }
            case .failed(let message):
                Section { StateRow(kind: .failed, text: message) }
            case .ready(let status):
                statusSections(status)
            case .accepted:
                Section { StateRow(kind: .loading, text: "Accepted. The board installs the update and restarts.") }
            }
            Section {
                Button("Other boards") { model.back() }
            }
        }
        .confirmationDialog("Install this update?", isPresented: $model.confirming, titleVisibility: .visible) {
            if case .ready(let status) = model.link, let version = status.waiting {
                Button("Install \(version)") { model.accept(version: version) }
            }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("The board restarts into the new version. It goes back to the old one if you do not keep it.")
        }
    }

    @ViewBuilder private func statusSections(_ status: OfflineStatus) -> some View {
        Section("Board") {
            row("Firmware", status.running)
            row("Up for", status.uptimeWord)
            row("Last restart", status.rebootWord)
        }
        Section("Connection") {
            row("Wi-Fi", status.wifiWord)
            row("Cloud", status.cloudWord)
        }
        Section("Update") {
            Text(status.updateWord)
            if status.canAccept {
                Button("Accept the update") { model.confirming = true }
            }
        }
        if model.accepted {
            Section { StateRow(kind: .loading, text: "Accepted.") }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(verbatim: value).foregroundStyle(theme.ink3)
        }
    }
}
