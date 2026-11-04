import CraniumKit
import SwiftUI

/// One release: what it is and who uploaded it, Deploy as the one action, and the rest in the menu.
struct ReleaseView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let version: String
    @State private var revoking = false

    var body: some View {
        let release = app.releases?.first { $0.version == version }
        ListScreen {
            if let release {
                content(release)
            } else if app.firmware.value != nil {
                Section { StateRow(kind: .empty, text: "There is no release \(version).") }
            } else if let error = app.firmware.error {
                Section { StateRow(kind: .failed, text: Words.plainMessage(error), action: ("Retry", { Task { await app.loadFirmware() } })) }
            } else {
                Section { StateRow(kind: .loading, text: "Loading the release…") }
            }
        }
        .poll(every: { Words.idleRefresh }) { full in await app.refreshFirmware(full: full) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if let release { menu(release) }
            }
        }
        .sheet(isPresented: $revoking) {
            if let release { RevokeSheet(release: release) }
        }
        .navigationTitle(version)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func menu(_ release: FirmwareRelease) -> some View {
        let state = Words.revocationState(release)
        return Menu {
            if app.canWrite && release.isActive {
                Button { app.openBluetooth(release: release.version) } label: {
                    Label("Send over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                }
            }
            CopyMenuItem(value: release.sha256, label: "Copy the SHA-256")
            NavigationLink(value: Route.help("firmware-and-signing")) { Label("Help", systemImage: "questionmark.circle") }
            if app.canWrite {
                if release.isActive {
                    Button(role: .destructive) { revoking = true } label: { Label("Revoke…", systemImage: "nosign") }
                } else if state == .incomplete {
                    Button(role: .destructive) { revoking = true } label: { Label("Finish revoking…", systemImage: "nosign") }
                } else if state == .unknown {
                    Button { revoking = true } label: { Label("Apply the revocation again…", systemImage: "nosign") }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle").accessibilityLabel("More")
        }
    }

    @ViewBuilder
    private func content(_ release: FirmwareRelease) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    VersionText(release.version)
                    Spacer()
                    StatusText(release.isActive ? Look(.good, "check-circle", "Active") : Look(.bad, "ban", "Revoked"))
                }
                if let notes = release.notes {
                    Text(verbatim: notes).font(.subheadline)
                }
                Text("Uploaded \(Words.timeAgo(release.uploadedAt, now: Date())) by \(Words.nameOf(release.uploadedBy))")
                    .font(.footnote).foregroundStyle(theme.ink3)
            }
            .padding(.vertical, 2)
        }
        if let mark = release.revoked {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    StatusText(.bad, "ban", "Revoked \(Words.timeAgo(mark.at, now: Date())) by \(Words.nameOf(mark.by))")
                    if !mark.reason.isEmpty { Text(verbatim: mark.reason).font(.subheadline).foregroundStyle(theme.ink2) }
                }
                if Words.revocationState(release) == .incomplete {
                    StatusText(.warn, "alert", "Revocation incomplete: a board may still download it")
                }
            }
        }
        if app.canWrite && release.isActive {
            Section {
                PrimaryButton("Deploy", systemImage: "paperplane") {
                    app.deployingThings = []
                    app.deploying = release.version
                }
            }
        }
        Section("Details") {
            ValueRow("Size", Words.fileSize(release.size))
            if let slot = app.firmware.value?.slotSize, slot > 0 {
                let percent = Double(release.size) / Double(slot) * 100
                ValueRow("Update slot", percent < 1 ? "Under 1%" : "\(Int(percent.rounded()))% of \(Words.fileSize(slot))")
            }
            NavigationLink("Digests and layout", value: Route.releaseDetails(release.version))
        }
        let boards = (app.deviceList ?? []).filter { $0.fw?.version == release.version }
        if !boards.isEmpty {
            Section("Boards on it") {
                ForEach(boards) { device in
                    NavigationLink(value: Route.board(device.thing)) { BoardRow(device: device) }
                }
            }
        }
        let deployments = (app.deployments.value ?? []).filter { $0.version == release.version }
        if !deployments.isEmpty {
            Section("Deployments") {
                ForEach(deployments) { deployment in
                    NavigationLink(value: Route.deployment(deployment.id)) { DeploymentLine(deployment: deployment) }
                }
            }
        }
    }
}

/// A release's digests, sizes and record.
struct ReleaseDetailsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let version: String

    var body: some View {
        let fingerprint = app.firmware.value?.fingerprint ?? ""
        ListScreen {
            if let release = app.releases?.first(where: { $0.version == version }) {
                Section {
                    ValueRow("File", release.filename ?? "—")
                    ValueRow("Size", Words.exactBytes(release.size))
                    if let header = release.headerSize { ValueRow("Header", Words.exactBytes(header)) }
                    if let payload = release.payloadSize { ValueRow("Firmware", Words.exactBytes(payload)) }
                    ValueRow("Load address", "0x" + String(release.loadAddress ?? 0, radix: 16))
                }
                Section {
                    digest("File SHA-256", release.sha256, note: "What a board checks after downloading.")
                    if !release.imageHash.isEmpty {
                        digest("Image hash", release.imageHash, note: "What the signature covers and the bootloader verifies.")
                    }
                    if !release.keyHash.isEmpty {
                        digest("Signed with", release.keyHash,
                               note: !fingerprint.isEmpty && release.keyHash != fingerprint ? "Not the current signing key."
                               : release.keyHash == fingerprint ? "This project's signing key." : "The key that signed it.")
                    }
                }
                Section {
                    ValueRow("Uploaded", Words.exactTime(release.uploadedAt))
                    ValueRow("By", Words.nameOf(release.uploadedBy))
                    if let mark = release.revoked {
                        ValueRow("Revoked", Words.exactTime(mark.at))
                        ValueRow("By", Words.nameOf(mark.by))
                        if let enforced = mark.enforcedAt { ValueRow("Enforced", Words.exactTime(enforced)) }
                    }
                }
            }
        }
        .screenTitle("Digests and layout", large: false)
    }

    private func digest(_ label: String, _ value: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                Spacer()
                CopyButton(value: value, label: label)
            }
            Text(verbatim: value).font(Typeface.hash).foregroundStyle(theme.ink2).textSelection(.enabled)
            Text(note).font(.caption).foregroundStyle(theme.ink3)
        }
    }
}

/// Revoking a release, or finishing a revocation that stopped half way.
struct RevokeSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    let release: FirmwareRelease
    @StateObject private var change = ChangeRunner()
    @State private var reason = ""
    @State private var done: String?

    private static let limit = 200

    var body: some View {
        let again = !release.isActive
        let open = Words.revocationState(release) == .incomplete
        NavigationStack {
            ListScreen {
                if let done {
                    Section { StatusText(.good, "check-circle", done) }
                } else {
                    Section {
                        ForEach(again ? steps : steps + [
                            "It can never be deployed again, and its version stays used.",
                            "Boards that already run it keep running it.",
                            "This cannot be undone.",
                        ], id: \.self) { line in
                            Text(line).font(.subheadline)
                        }
                    } header: {
                        Text(again ? "Repeats the steps after the mark" : "What revoking does")
                    }
                    if !again {
                        Section {
                            TextField("Why it must not be installed", text: $reason, axis: .vertical)
                                .lineLimit(2...4)
                                .disabled(change.busy)
                                .onChange(of: reason) { value in
                                    if value.count > Self.limit { reason = String(value.prefix(Self.limit)) }
                                }
                        } header: {
                            Text("Reason")
                        } footer: {
                            Text("Required. In the activity log and next to the release.\(reason.count >= 160 ? " \(reason.count) / \(Self.limit)" : "")")
                        }
                    }
                    if let error = change.error {
                        Section { StateRow(kind: .failed, text: error) }
                    }
                    if change.asking || change.signingIn {
                        Section { FreshSignInPrompt(change: change, what: "revocation") }
                    }
                    Section {
                        PrimaryButton(change.busy ? (again ? "Finishing…" : "Revoking…")
                                      : again ? (open ? "Finish revoking" : "Apply again") : "Revoke \(release.version)",
                                      systemImage: "nosign", role: .destructive, busy: change.busy) {
                            Task { await submit(UploadCheck.singleLine(reason)) }
                        }
                        .disabled((!again && UploadCheck.singleLine(reason).isEmpty) || change.busy || change.asking)
                    }
                }
            }
            .navigationTitle(again ? (open ? "Finish revoking" : "Revoke again") : "Revoke \(release.version)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: done == nil ? .cancellationAction : .confirmationAction) {
                    Button(done != nil ? "Done" : again ? "Close" : "Keep the release") { dismiss() }
                        .disabled(change.busy)
                }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking)
    }

    private var steps: [String] {
        ["The image stops downloading at once, also for a board in the middle of downloading it.",
         "Every unfinished deployment of \(release.version) is cancelled. Boards that started stop before installing."]
    }

    private func submit(_ reason: String) async {
        let version = release.version
        let again = !release.isActive
        // A revocation again carries the reason on record; this stands in for a record that has none.
        let onRecord = UploadCheck.singleLine(release.revoked?.reason ?? "")
        let sent = again ? (onRecord.isEmpty ? "Revocation applied again." : onRecord) : reason
        if let result = await change.run(app, refusal: again ? "Not finished." : "Not revoked.", { api in
            try await api.revoke(version: version, reason: sent)
        }) {
            let running = (app.deviceList ?? []).filter { $0.fw?.version == version }
            done = Words.revocationNotice(version, cancelled: result.cancelled, again: again, running: running)
        } else if let error = change.lastError as? APIError, error.status == 409, error.code == "already_revoked" {
            // The server went through the steps after the mark before it answered so.
            change.reset()
            let running = (app.deviceList ?? []).filter { $0.fw?.version == version }
            done = Words.revocationNotice(version, cancelled: nil, again: again, running: running)
        }
        if done != nil {
            await app.loadFirmware()
            await app.loadDeployments()
        }
    }
}
