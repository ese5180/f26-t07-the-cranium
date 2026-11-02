import CraniumBLE
import CraniumKit
import SwiftUI

/// Steps 3 and 4: open the board's window, and pick it.
struct BoardsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            List {
                Section {
                    Label(UserMessage.openWindow, systemImage: "hand.tap")
                    if let release = model.chosenRelease {
                        Label("Ready to send \(release.version): downloaded and checked.", systemImage: "checkmark.seal")
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if let problem = model.radioProblem {
                        MessageText(text: problem)
                    } else if model.boards.isEmpty {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if let started = model.scanStarted, context.date.timeIntervalSince(started) > 15 {
                                Text(UserMessage.noBoard)
                                    .foregroundStyle(.secondary)
                            } else {
                                HStack(spacing: 10) {
                                    ProgressView()
                                    Text("Looking for boards…")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    ForEach(model.boards) { board in
                        Button {
                            Task { await model.connect(to: board) }
                        } label: {
                            HStack {
                                Image(systemName: "dot.radiowaves.left.and.right")
                                Text(board.name)
                                    .font(.body.monospaced())
                                Spacer()
                                SignalBars(rssi: board.rssi)
                            }
                        }
                    }
                } header: {
                    Text("Boards with Bluetooth open")
                } footer: {
                    Text("A board shows as Cranium- and four hex digits, new each time its window opens.")
                }
            }

            VStack(spacing: 12) {
                if let message = model.message {
                    MessageText(text: message)
                }
                HStack {
                    Button("Change release") { model.backToReleases() }
                    Spacer()
                    Button("Look again") { model.lookForBoards() }
                }
            }
            .padding()
        }
    }
}

struct SignalBars: View {
    let rssi: Int

    private var bars: Int {
        switch rssi {
        case (-60)...: return 3
        case (-75)...: return 2
        default: return 1
        }
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1...3, id: \.self) { level in
                RoundedRectangle(cornerRadius: 1)
                    .frame(width: 4, height: CGFloat(4 + level * 4))
                    .opacity(level <= bars ? 1 : 0.25)
            }
        }
        .foregroundStyle(.secondary)
        .accessibilityLabel("Signal \(bars) of 3")
    }
}
