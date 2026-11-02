import CraniumKit
import SwiftUI

/// Steps 5 to 7: pair, send, press the button.
struct BoardView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        switch model.boardStage {
        case .pairing:
            PairingView()
        case .choose:
            ChooseView()
        case .checking(let version):
            VStack(spacing: 16) {
                ProgressView()
                Text("Checking \(version)…")
            }
        case .downloading(let version):
            VStack(spacing: 16) {
                ProgressView()
                Text("Downloading \(version) from the console…")
            }
        case .uploading(let progress):
            UploadView(progress: progress)
        case .sent(let version):
            SentView(version: version)
        case .failed(let text):
            VStack(spacing: 20) {
                Notice(systemImage: "exclamationmark.triangle", title: "Not sent", text: text)
                WideButton(title: "Back to the boards") {
                    Task { await model.backToBoards() }
                }
                .padding(.horizontal, 24)
            }
        }
    }
}

struct PairingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            // At the top: the phone's own pairing prompt covers the middle of the screen.
            if let passkey = model.passkey {
                VStack(spacing: 6) {
                    Text("Passkey")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                    Text(passkey)
                        .font(.system(size: 52, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityLabel("Passkey \(passkey.map(String.init).joined(separator: " "))")
                    Text("From the cloud. The board draws a new one for each attempt.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 24)
            } else if model.passkeyNotInCloud {
                Label(UserMessage.passkeyOnConsole, systemImage: "terminal")
                    .padding(.top, 24)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Asking the cloud for the passkey…")
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 24)
            }

            Text(UserMessage.pairing)
                .multilineTextAlignment(.center)
            Spacer()
            HStack(spacing: 10) {
                ProgressView()
                Text("Pairing with \(model.boardName ?? "the board")…")
            }
            Button("Cancel", role: .cancel) {
                Task { await model.backToBoards() }
            }
        }
        .padding(24)
    }
}

struct ChooseView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            List {
                Section {
                    if let running = model.running {
                        LabeledContent("Runs now", value: running.description)
                            .font(.body.monospacedDigit())
                    }
                }
                Section {
                    if model.offered.isEmpty {
                        Text("Nothing newer than what the board runs. There is nothing to send.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.offered) { release in
                        ReleaseRow(release: release, selected: release.version == model.preferred,
                                   onPhone: model.firmwareOnPhone.holds(release))
                            .contentShape(Rectangle())
                            .onTapGesture { model.preferred = release.version }
                    }
                } header: {
                    Text("Newer releases")
                } footer: {
                    Text(UserMessage.uploadTakes)
                }
            }
            VStack(spacing: 12) {
                WideButton(title: model.offered.contains { $0.version == model.preferred }
                               ? "Send \(model.preferred ?? "")" : "Send",
                           enabled: model.offered.contains { $0.version == model.preferred }) {
                    Task { await model.send() }
                }
                Button("Disconnect") {
                    Task { await model.backToBoards() }
                }
            }
            .padding()
        }
    }
}

struct UploadView: View {
    @EnvironmentObject private var model: AppModel
    let progress: UploadProgress

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Text("Sending to \(model.boardName ?? "the board")")
                .font(.title3.weight(.semibold))
            ProgressView(value: progress.fraction)
            HStack {
                Text("\(progress.sent / 1024) of \(progress.total / 1024) KB")
                Spacer()
                if let left = timeLeft {
                    Text(left)
                }
            }
            .font(.callout.monospacedDigit())
            .foregroundStyle(.secondary)
            if let image = model.sending {
                Text(UserMessage.origin(of: image))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Text(UserMessage.uploadTakes)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Stop", role: .destructive) {
                Task { await model.backToBoards() }
            }
        }
        .padding(24)
    }

    private var timeLeft: String? {
        guard let started = model.uploadStarted, progress.sent > 0, progress.sent < progress.total else { return nil }
        let elapsed = Date().timeIntervalSince(started)
        guard elapsed > 3 else { return nil }
        let seconds = elapsed * Double(progress.total - progress.sent) / Double(progress.sent)
        let minutes = Int((seconds / 60).rounded(.up))
        return minutes <= 1 ? "about a minute left" : "about \(minutes) minutes left"
    }
}

struct SentView: View {
    @EnvironmentObject private var model: AppModel
    let version: String

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.green)
                Text("\(version) has arrived")
                    .font(.title2.weight(.bold))
                Text(UserMessage.pressButton)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(UserMessage.afterInstall)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                if let device = model.device {
                    DeviceLine(device: device, version: version)
                }
                WideButton(title: "Done") {
                    Task { await model.done() }
                }
            }
            .padding(24)
        }
    }
}

/// What the cloud last heard from the board, for one that is online.
struct DeviceLine: View {
    let device: DeviceStatus
    let version: String

    var body: some View {
        Label(text, systemImage: device.online ? "cloud" : "cloud.slash")
            .font(.callout)
    }

    private var text: String {
        guard device.online, let fw = device.fw else {
            return "Waiting for the board to come back online."
        }
        if fw.version == version {
            return fw.confirmed ? "Back online on \(fw.version), and kept." : "Back online on \(fw.version), on trial."
        }
        return "Online, on \(fw.version)."
    }
}
