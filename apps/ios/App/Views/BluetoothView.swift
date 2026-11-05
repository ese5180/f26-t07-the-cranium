import CraniumBLE
import CraniumKit
import SwiftUI

/// An update over Bluetooth, full screen: the release, the board, its passkey, the send, and
/// Button 1. See docs/mobile-apps.md, "What a person does"; Help has it for people.
struct BluetoothFlow: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel
    let release: String?

    /// While pairing, the top bar says the passkey: it stays above the phone's pairing box.
    private var pairingTitle: String? {
        guard model.stage == .board, case .pairing = model.boardStage, let passkey = model.passkey else { return nil }
        return "Passkey \(passkey.prefix(3)) \(passkey.dropFirst(3))"
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.stage {
                case .releases: BluetoothReleases(model: model)
                case .boards: BluetoothBoards(model: model)
                case .board: BluetoothBoard(model: model)
                }
            }
            .navigationTitle(pairingTitle ?? title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        Task {
                            await model.close()
                            dismiss()
                        }
                    }
                    .disabled(uploading)
                }
                ToolbarItem(placement: .primaryAction) { HelpButton(topic: "bluetooth-update") }
            }
        }
        .tint(theme.accent)
        .task { await model.open(release: release) }
    }

    private var uploading: Bool {
        if case .uploading = model.boardStage, model.stage == .board { return true }
        return false
    }

    private var title: String {
        switch model.stage {
        case .releases: return "Update over Bluetooth"
        case .boards: return "Find the board"
        case .board: return model.boardName ?? "Board"
        }
    }
}

/// Pick a release: the newest active one is chosen; revoked ones are not offered.
struct BluetoothReleases: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel

    var body: some View {
        ListScreen {
            Section {
                Label("At the board, hold Button 1 for 5 s. LED1 flashes four times.", systemImage: "hand.tap")
                    .font(.subheadline)
            }
            Section("Release") {
                if app.firmware.value == nil {
                    StateRow(kind: .loading, text: "Loading releases…")
                } else if model.releases.isEmpty {
                    StateRow(kind: .empty, text: "No active release.")
                }
                ForEach(model.releases) { release in
                    Button {
                        model.preferred = release.version
                    } label: {
                        HStack {
                            ReleaseLine(release: release)
                            Spacer()
                            if app.firmwareOnPhone.holds(release) {
                                Image(systemName: "iphone").foregroundStyle(theme.ink3).accessibilityLabel("On this phone")
                            }
                            if release.version == model.preferred {
                                Image(systemName: "checkmark").foregroundStyle(theme.accent)
                            }
                        }
                    }
                    .foregroundStyle(theme.ink)
                    .accessibilityAddTraits(release.version == model.preferred ? .isSelected : [])
                }
            }
            if let message = model.message {
                Section { StateRow(kind: .failed, text: message) }
            }
            if app.me == nil {
                Section {
                    Button("Check my account again") {
                        Task { await model.open(release: model.chosenRelease?.version) }
                    }
                }
            }
            Section {
                PrimaryButton(model.preparing ?? (model.chosenRelease.map { "Continue with \($0.version)" } ?? "Continue"),
                              busy: model.busy) {
                    Task { await model.continueToBoards() }
                }
                .disabled(!app.canWrite || model.chosenRelease == nil || model.busy)
            }
        }
    }
}

/// Open the board's window, and pick it.
struct BluetoothBoards: View {
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel

    var body: some View {
        ListScreen {
            Section {
                Label("Hold Button 1 for 5 s, until LED1 flashes four times.", systemImage: "hand.tap").font(.subheadline)
            } footer: {
                if let release = model.chosenRelease, let image = model.obtained[release.version] {
                    Text("\(release.version) is ready: \(image.origin == .phone ? "on this phone" : "downloaded"), \(UserMessage.kilobytes(image.size)).")
                }
            }
            Section("Boards with Bluetooth open") {
                if let problem = model.radioProblem {
                    StateRow(kind: .failed, text: problem)
                } else if model.boards.isEmpty {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        if let started = model.scanStarted, context.date.timeIntervalSince(started) > 15 {
                            StateRow(kind: .empty, text: "No board found.", action: ("Look again", { model.lookForBoards() }))
                        } else {
                            StateRow(kind: .loading, text: "Looking…")
                        }
                    }
                }
                ForEach(model.boards) { board in
                    Button {
                        Task { await model.connect(to: board) }
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
            if let message = model.message {
                Section { StateRow(kind: .failed, text: message) }
            }
            Section {
                Button("Change the release") { model.backToReleases() }
            }
        }
    }
}

/// Pair, send, press the button.
struct BluetoothBoard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel

    var body: some View {
        ListScreen {
            switch model.boardStage {
            case .pairing: pairing
            case .choose: choose
            case .checking(let version): Section { StateRow(kind: .loading, text: "Checking \(version)…") }
            case .downloading(let version): Section { StateRow(kind: .loading, text: "Downloading \(version)…") }
            case .confirming(let version): Section { StateRow(kind: .loading, text: "Asking the console about \(version)…") }
            case .uploading(let progress): uploading(progress)
            case .sent(let version): sent(version)
            case .failed(let text):
                Section { StateRow(kind: .failed, text: "Not sent. \(text)") }
                Section { PrimaryButton("Back to the boards") { Task { await model.backToBoards() } } }
            }
        }
    }

    @ViewBuilder private var pairing: some View {
        // At the top: the phone's own pairing prompt covers the middle of the screen.
        Section {
            if let passkey = model.passkey {
                VStack(alignment: .leading, spacing: 6) {
                    Text(passkey)
                        .font(.system(size: 44, weight: .semibold, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityLabel("Passkey \(passkey.map(String.init).joined(separator: " "))")
                    if let thing = model.consoleThing {
                        BoardLabel(thing, name: model.consoleName)
                    }
                }
                .padding(.vertical, 4)
            } else if model.passkeyNotInCloud {
                Text("The board is offline: read its passkey on its serial console, the line [BT] passkey.").font(.subheadline)
            } else {
                StateRow(kind: .loading, text: "Asking the cloud for the passkey…")
            }
        } header: {
            Text("Passkey")
        } footer: {
            Text("It is on the clipboard and at the top of the screen: in the phone's pairing box, tap the field, "
                 + "Paste, then Pair. A new one is drawn for each attempt.")
        }
        Section {
            StateRow(kind: .loading, text: "Pairing with \(model.boardName ?? "the board")…")
            Button("Cancel", role: .cancel) { Task { await model.backToBoards() } }
        }
    }

    @ViewBuilder private var choose: some View {
        if let running = model.running {
            Section {
                HStack {
                    Text("Runs now")
                    Spacer()
                    VersionText(running.description).foregroundStyle(theme.ink2)
                }
            }
        }
        Section("Newer releases") {
            if model.offered.isEmpty {
                StateRow(kind: .empty, text: "Nothing newer than what the board runs.")
            }
            ForEach(model.offered) { release in
                Button {
                    model.preferred = release.version
                } label: {
                    HStack {
                        ReleaseLine(release: release)
                        Spacer()
                        if release.version == model.preferred { Image(systemName: "checkmark").foregroundStyle(theme.accent) }
                    }
                }
                .foregroundStyle(theme.ink)
            }
        }
        let ready = model.offered.contains { $0.version == model.preferred }
        Section {
            PrimaryButton(ready ? "Send \(model.preferred ?? "")" : "Send", systemImage: "arrow.up.to.line") {
                Task { await model.send() }
            }
            .disabled(!ready)
        } footer: {
            Text("Takes a few minutes. Keep the phone near the board, and the app open.")
        }
        Section {
            Button("Disconnect") { Task { await model.backToBoards() } }
        }
    }

    @ViewBuilder
    private func uploading(_ progress: UploadProgress) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Sending to \(model.boardName ?? "the board")").font(.headline)
                    Spacer()
                    Text("\(Int((progress.fraction * 100).rounded()))%").font(.title3.weight(.semibold)).monospacedDigit()
                }
                ProgressBar(percent: Int(progress.fraction * 100), label: "Upload to the board")
                TimelineView(.periodic(from: .now, by: 2)) { _ in
                    Text([timeLeft(progress), "\(progress.sent / 1024) of \(progress.total / 1024) KB"].compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).monospacedDigit().foregroundStyle(theme.ink3)
                }
            }
            .padding(.vertical, 4)
        } footer: {
            Text("Keep the phone near the board, and the app open.")
        }
        Section {
            Button("Stop", role: .destructive) { Task { await model.backToBoards() } }
        }
    }

    private func timeLeft(_ progress: UploadProgress) -> String? {
        guard let started = model.uploadStarted, progress.sent > 0, progress.sent < progress.total else { return nil }
        let elapsed = Date().timeIntervalSince(started)
        guard elapsed > 3 else { return nil }
        let seconds = elapsed * Double(progress.total - progress.sent) / Double(progress.sent)
        let minutes = Int((seconds / 60).rounded(.up))
        return minutes <= 1 ? "about a minute left" : "about \(minutes) minutes left"
    }

    @ViewBuilder
    private func sent(_ version: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                StatusText(.good, "check-circle", "\(version) has arrived").font(.headline)
                Text("Press Button 1 on the board within 2 minutes to install it. Button 2 throws it away.")
                    .font(.subheadline)
                ButtonKeys()
            }
            .padding(.vertical, 4)
            if let device = model.device {
                StatusText(device.online ? .live : .idle, device.online ? "online" : "offline", deviceWords(device, version: version))
            }
        }
        Section {
            PrimaryButton("Done") { Task { await model.close(); app.bluetoothOpen = false } }
        }
    }

    private func deviceWords(_ device: DeviceStatus, version: String) -> String {
        guard device.online, let fw = device.fw else { return "Waiting for the board to come back online." }
        if fw.version == version {
            return fw.confirmed ? "Back online on \(fw.version), and kept." : "Back online on \(fw.version), on trial."
        }
        return "Online, on \(fw.version)."
    }
}
