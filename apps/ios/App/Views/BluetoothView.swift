import CraniumBLE
import CraniumKit
import SwiftUI

/// An update over Bluetooth, full screen: the release, the board, its passkey, the send, and
/// Button 1. See docs/mobile-apps.md, "What a person does".
struct BluetoothFlow: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel
    let release: String?

    var body: some View {
        NavigationStack {
            Group {
                switch model.stage {
                case .releases: BluetoothReleases(model: model)
                case .boards: BluetoothBoards(model: model)
                case .board: BluetoothBoard(model: model)
                }
            }
            .background(theme.paper.ignoresSafeArea())
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.paper, for: .navigationBar)
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

/// Step 2: pick a release. The newest active one is chosen by default; revoked ones are not offered.
struct BluetoothReleases: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel

    var body: some View {
        Page {
            Panel {
                Eyebrow("At the board")
                Text(UserMessage.openWindow).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                Text("The image goes from AWS to this phone, then to the board over Bluetooth. Right before it is sent, the console is asked whether the release is still active; without its yes, nothing is sent.")
                    .font(Typeface.small).foregroundStyle(Theme.panel.ink2).fixedSize(horizontal: false, vertical: true)
            }
            Card("Active releases, newest first") {
                if model.releases.isEmpty && app.firmware.value != nil {
                    Text("No active releases. Upload one on the Firmware tab.").foregroundStyle(theme.ink3)
                } else if app.firmware.value == nil {
                    Loading(what: "releases")
                }
                VStack(spacing: 0) {
                    ForEach(model.releases) { release in
                        ReleaseChoice(release: release, selected: release.version == model.preferred,
                                      onPhone: app.firmwareOnPhone.holds(release))
                            .onTapGesture { model.preferred = release.version }
                        RowRule()
                    }
                }
                Text("The board will only take a release newer than the one it runs. Once it is connected, only those are offered.")
                    .font(Typeface.small).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            if let message = model.message {
                Notice(.bad, "alert", message)
            }
            if let preparing = model.preparing {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(preparing).font(Typeface.body)
                }
            }
            Button {
                Task { await model.continueToBoards() }
            } label: {
                Text(model.chosenRelease.map { "Continue with \($0.version)" } ?? "Continue")
            }
            .consoleButton(.primary, wide: true)
            .disabled(!app.canWrite || model.chosenRelease == nil || model.busy)
        }
    }
}

struct ReleaseChoice: View {
    @Environment(\.theme) private var theme
    let release: FirmwareRelease
    let selected: Bool
    /// The phone keeps a checked image of it: sending it needs no download.
    var onPhone = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(selected ? theme.accent : theme.ink3)
                .font(.title3)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Mono(release.version, strong: true)
                Text(onPhone ? "\(UserMessage.kilobytes(release.size)), on this phone" : UserMessage.kilobytes(release.size))
                    .font(Typeface.small).foregroundStyle(theme.ink3)
                if let uploaded = release.uploadedAt {
                    Text("Uploaded \(Words.timeAgo(uploaded, now: Date()))").font(Typeface.small).foregroundStyle(theme.ink3)
                }
                if let notes = release.notes { Text(verbatim: notes).font(Typeface.small) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// Steps 3 and 4: open the board's window, and pick it.
struct BluetoothBoards: View {
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel

    var body: some View {
        Page {
            Panel {
                Eyebrow("At the board")
                Label(UserMessage.openWindow, systemImage: "hand.tap").font(Typeface.body)
                if let release = model.chosenRelease, let image = model.obtained[release.version] {
                    Text("Ready to send \(release.version). \(UserMessage.origin(of: image))")
                        .font(Typeface.small).foregroundStyle(Theme.panel.ink2)
                }
            }
            Card("Boards with Bluetooth open") {
                if let problem = model.radioProblem {
                    Notice(.bad, "alert", problem)
                } else if model.boards.isEmpty {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        if let started = model.scanStarted, context.date.timeIntervalSince(started) > 15 {
                            Text(UserMessage.noBoard).foregroundStyle(theme.ink2)
                        } else {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Looking for boards…").foregroundStyle(theme.ink2)
                            }
                        }
                    }
                }
                VStack(spacing: 0) {
                    ForEach(model.boards) { board in
                        Button {
                            Task { await model.connect(to: board) }
                        } label: {
                            HStack {
                                Image(systemName: "dot.radiowaves.left.and.right").foregroundStyle(theme.accent)
                                Mono(board.name, strong: true)
                                Spacer()
                                SignalBars(bars: board.rssi >= -60 ? 4 : board.rssi >= -75 ? 3 : 2)
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(theme.ink3)
                            }
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Connect to \(board.name)")
                        RowRule()
                    }
                }
                Text("A board shows as Cranium- and four hex digits, new each time its window opens.")
                    .font(Typeface.small).foregroundStyle(theme.ink3)
            }
            if let message = model.message { Notice(.bad, "alert", message) }
            HStack(spacing: 10) {
                Button("Change release") { model.backToReleases() }.consoleButton()
                Button("Look again") { model.lookForBoards() }.consoleButton(.primary, wide: true)
            }
        }
    }
}

/// Steps 5 to 7: pair, send, press the button.
struct BluetoothBoard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @ObservedObject var model: BluetoothModel

    var body: some View {
        switch model.boardStage {
        case .pairing:
            pairing
        case .choose:
            choose
        case .checking(let version):
            working("Checking \(version)…")
        case .downloading(let version):
            working("Downloading \(version) from the console…")
        case .confirming(let version):
            working("Asking the console whether \(version) may still be sent…")
        case .uploading(let progress):
            uploading(progress)
        case .sent(let version):
            sent(version)
        case .failed(let text):
            Page {
                Notice(.bad, "alert", "Not sent. \(text)")
                Button("Back to the boards") { Task { await model.backToBoards() } }.consoleButton(.primary, wide: true)
            }
        }
    }

    private var pairing: some View {
        Page {
            // At the top: the phone's own pairing prompt covers the middle of the screen.
            Panel {
                if let passkey = model.passkey {
                    Eyebrow("Passkey")
                    Text(passkey)
                        .font(.system(size: 52, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityLabel("Passkey \(passkey.map(String.init).joined(separator: " "))")
                    Text("From the cloud. The board draws a new one for each attempt.")
                        .font(Typeface.small).foregroundStyle(Theme.panel.ink3)
                    // Which board the console gave this passkey for, so that a person can notice
                    // when it is not the board in front of them.
                    if let thing = model.consoleThing {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.consoleName.map { "Board in the console: \($0)" } ?? UserMessage.boardInConsole(thing))
                                .font(Typeface.body.weight(.semibold))
                            if model.consoleName != nil { Mono(thing, font: Typeface.mono).foregroundStyle(Theme.panel.ink3) }
                        }
                    }
                } else if model.passkeyNotInCloud {
                    Label(UserMessage.passkeyOnConsole, systemImage: "terminal").font(Typeface.body)
                } else {
                    HStack(spacing: 10) {
                        ProgressView().tint(Theme.panel.ink)
                        Text("Asking the cloud for the passkey…")
                    }
                }
            }
            Text(UserMessage.pairing).font(Typeface.body)
            HStack(spacing: 10) {
                ProgressView()
                Text("Pairing with \(model.boardName ?? "the board")…").font(Typeface.body)
            }
            Button("Cancel", role: .cancel) { Task { await model.backToBoards() } }.consoleButton(wide: true)
        }
    }

    private var choose: some View {
        Page {
            if let running = model.running {
                Card("The board") {
                    Fact("Runs now") { Mono(running.description, strong: true) }
                }
            }
            Card("Newer releases") {
                if model.offered.isEmpty {
                    Text("Nothing newer than what the board runs. There is nothing to send.").foregroundStyle(theme.ink2)
                }
                VStack(spacing: 0) {
                    ForEach(model.offered) { release in
                        ReleaseChoice(release: release, selected: release.version == model.preferred)
                            .onTapGesture { model.preferred = release.version }
                        RowRule()
                    }
                }
                Text(UserMessage.uploadTakes).font(Typeface.small).foregroundStyle(theme.ink3)
            }
            let ready = model.offered.contains { $0.version == model.preferred }
            Button(ready ? "Send \(model.preferred ?? "")" : "Send") { Task { await model.send() } }
                .consoleButton(.primary, wide: true)
                .disabled(!ready)
            Button("Disconnect") { Task { await model.backToBoards() } }.consoleButton(wide: true)
        }
    }

    private func working(_ text: String) -> some View {
        Page {
            HStack(spacing: 12) {
                ProgressView()
                Text(text).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 40)
        }
    }

    private func uploading(_ progress: UploadProgress) -> some View {
        Page {
            Panel {
                Eyebrow("Sending to \(model.boardName ?? "the board")")
                HStack(alignment: .firstTextBaseline) {
                    Text("\(Int((progress.fraction * 100).rounded()))%").font(Typeface.figure).monospacedDigit()
                    Spacer()
                    TimelineView(.periodic(from: .now, by: 2)) { _ in
                        if let left = timeLeft(progress) { Text(left).font(Typeface.small).foregroundStyle(Theme.panel.ink2) }
                    }
                }
                Meter(percent: Int(progress.fraction * 100), label: "Upload to the board")
                Text("\(progress.sent / 1024) of \(progress.total / 1024) KB").font(Typeface.small).monospacedDigit()
                    .foregroundStyle(Theme.panel.ink2)
                if let image = model.sending {
                    Text(UserMessage.origin(of: image)).font(Typeface.small).foregroundStyle(Theme.panel.ink3)
                }
            }
            Text(UserMessage.uploadTakes).font(Typeface.body)
            Button("Stop", role: .destructive) { Task { await model.backToBoards() } }.consoleButton(.dangerQuiet, wide: true)
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

    private func sent(_ version: String) -> some View {
        Page {
            Panel {
                Label("\(version) has arrived", systemImage: "checkmark.circle").font(Typeface.title)
                    .foregroundStyle(Theme.panel.good)
                Text(UserMessage.pressButton).font(Typeface.heading).foregroundStyle(Theme.panel.ink)
                    .fixedSize(horizontal: false, vertical: true)
                ButtonKeys()
            }
            Text(UserMessage.afterInstall).font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            if let device = model.device {
                Label(deviceWords(device, version: version), systemImage: device.online ? "icloud" : "icloud.slash")
                    .font(Typeface.body)
            }
            Button("Done") { Task { await model.close(); app.bluetoothOpen = false } }.consoleButton(.primary, wide: true)
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
