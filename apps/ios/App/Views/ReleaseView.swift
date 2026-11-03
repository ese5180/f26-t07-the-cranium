import CraniumKit
import SwiftUI

/// One release: what it is, who uploaded it, and what can be done with it: deploy it over the
/// internet, send it over Bluetooth, or revoke it.
struct ReleaseView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let version: String
    @State private var revoking = false

    var body: some View {
        Page {
            if let release = app.releases?.first(where: { $0.version == version }) {
                content(release)
            } else if app.firmware.value != nil {
                Card { EmptyState(icon: "package", title: "There is no release \(version).",
                                  text: "It is not in the list of releases the console has.") }
            } else if let error = app.firmware.error {
                LoadProblem(what: "the releases", error: error) { Task { await app.loadFirmware() } }
            } else {
                Loading(what: "the release")
            }
        }
        .poll(every: { Words.idleRefresh }) { full in await app.refreshFirmware(full: full) }
        .sheet(isPresented: $revoking) {
            if let release = app.releases?.first(where: { $0.version == version }) {
                RevokeSheet(release: release)
            }
        }
        .consoleTitle(version, large: false)
    }

    @ViewBuilder
    private func content(_ release: FirmwareRelease) -> some View {
        let state = Words.revocationState(release)
        let fingerprint = app.firmware.value?.fingerprint ?? ""
        let boards = (app.deviceList ?? []).filter { $0.fw?.version == release.version }
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow("Release")
            HStack(spacing: 10) {
                Mono(release.version, strong: true, font: .system(.title2, design: .monospaced))
                ReleaseBadges(release: release)
            }
            if let notes = release.notes {
                Text(verbatim: notes).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
            }
            Text("\(Words.fileSize(release.size)) · Uploaded \(Words.timeAgo(release.uploadedAt, now: Date())) by \(Words.nameOf(release.uploadedBy))")
                .font(Typeface.small).foregroundStyle(theme.ink3)
            SlotFit(size: release.size, slot: app.firmware.value?.slotSize)
        }
        if let revoked = release.revoked {
            Notice(.idle, "ban", "Revoked \(Words.timeAgo(revoked.at, now: Date())) by \(Words.nameOf(revoked.by))\(revoked.reason.isEmpty ? "." : ": \(Words.sentence(revoked.reason))")",
                   more: release.isActive ? nil : "It cannot be deployed or sent over Bluetooth again. Boards that already run it keep running it; to replace it there, upload a newer version and deploy that.")
        }
        if state == .incomplete {
            Notice(.warn, "alert", "\(Words.revocationOpen) Until it has, a board may still be able to download or install it. \(app.canWrite ? "Finish revoking to make sure." : "A release manager can finish revoking.")")
        }
        if app.canWrite {
            VStack(alignment: .leading, spacing: 10) {
                if release.isActive {
                    Button { app.deployingThings = []; app.deploying = release.version } label: {
                        Label("Deploy over the internet", systemImage: "paperplane")
                    }
                    .consoleButton(.primary, wide: true)
                    Button { app.openBluetooth(release: release.version) } label: {
                        Label("Send over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                    }
                    .consoleButton(wide: true)
                    Button { revoking = true } label: { Label("Revoke", systemImage: "nosign") }
                        .consoleButton(.dangerQuiet, wide: true)
                        .accessibilityLabel("Revoke \(release.version)")
                } else if state == .incomplete {
                    Button { revoking = true } label: { Label("Finish revoking", systemImage: "nosign") }
                        .consoleButton(.primary, wide: true)
                } else if state == .unknown {
                    Button("Apply the revocation again") { revoking = true }.consoleButton(wide: true)
                }
            }
        }
        if !boards.isEmpty {
            Card("Boards on it") {
                VStack(spacing: 0) {
                    ForEach(boards) { device in
                        RowLink(.board(device.thing)) {
                            HStack {
                                BoardTitle(device)
                                Spacer()
                                Presence(device: device)
                            }
                            .padding(.vertical, 8)
                        }
                        RowRule()
                    }
                }
                if boards.contains(where: { !$0.online }) {
                    Text("An offline board's version is the one it last reported.").font(Typeface.small).foregroundStyle(theme.ink3)
                }
            }
        }
        Card("Details") {
            VStack(spacing: 0) {
                Fact("File") { Mono(release.filename ?? "—") }
                Fact("Size") {
                    Text(Words.exactBytes(release.size) + (release.headerSize != nil && release.payloadSize != nil
                         ? ": \(Words.exactBytes(release.headerSize!)) of header, \(Words.exactBytes(release.payloadSize!)) of firmware, then the signature" : ""))
                }
                Fact("File SHA-256") {
                    CopyRow(value: release.sha256, label: "the SHA-256 of \(release.version)")
                    FactNote("What a board checks after downloading.")
                }
                if !release.imageHash.isEmpty {
                    Fact("Image hash") {
                        Mono(release.imageHash, font: Typeface.mono)
                        FactNote("What the signature covers and the bootloader verifies.")
                    }
                }
                if !release.keyHash.isEmpty {
                    Fact("Signed with") {
                        Mono(release.keyHash, font: Typeface.mono)
                        FactNote(!fingerprint.isEmpty && release.keyHash != fingerprint
                                 ? "Not the current signing key. This release was signed with an earlier key, which has been replaced since."
                                 : release.keyHash == fingerprint ? "Matches this project’s signing key." : "Fingerprint of the key that signed it.")
                    }
                }
                Fact("Load address") { Mono("0x" + String(release.loadAddress ?? 0, radix: 16)) }
                Fact("Uploaded") {
                    Text(Words.exactTime(release.uploadedAt))
                    FactNote("by \(Words.nameOf(release.uploadedBy))\(release.uploadedBy.map { $0.sub.isEmpty ? "" : " · account \($0.sub)" } ?? "")")
                }
                if let revoked = release.revoked {
                    Fact("Revoked") {
                        Text(Words.exactTime(revoked.at))
                        FactNote("by \(Words.nameOf(revoked.by))\(revoked.by.map { $0.sub.isEmpty ? "" : " · account \($0.sub)" } ?? "")")
                    }
                    if let enforced = revoked.enforcedAt {
                        Fact("Enforced") {
                            Text(Words.exactTime(enforced))
                            FactNote("The image is refused and every open deployment of it was cancelled.")
                        }
                    }
                }
            }
        }
        let deployments = (app.deployments.value ?? []).filter { $0.version == release.version }
        if !deployments.isEmpty {
            Card("Deployments of it") {
                VStack(spacing: 0) {
                    ForEach(deployments) { deployment in
                        DeploymentRow(deployment: deployment)
                        RowRule()
                    }
                }
            }
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
            Page {
                if let done {
                    Notice(.good, "check-circle", done)
                    Button("Done") { dismiss() }.consoleButton(.primary, wide: true)
                } else if again {
                    Text(open
                         ? "This release is marked revoked, but the server has not recorded that the two steps after the mark were completed. Finishing repeats them:"
                         : "This release is revoked. Applying the revocation again repeats the two steps after the mark, in case one of them did not go through:")
                        .font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                    consequences(steps)
                    if let mark = release.revoked {
                        Text("Revoked \(Words.timeAgo(mark.at, now: Date())) by \(Words.nameOf(mark.by))\(mark.reason.isEmpty ? "" : ": \(mark.reason)")")
                            .font(Typeface.small).foregroundStyle(theme.ink2)
                    }
                    Text("That record stays as it is: who revoked the release, when and why.")
                        .font(Typeface.small).foregroundStyle(theme.ink3)
                    failure(open ? "Not finished." : "Not applied.")
                    FreshSignInPrompt(change: change, what: "revocation")
                    Button {
                        Task { await submit("") }
                    } label: {
                        Label(change.busy ? (open ? "Finishing…" : "Applying…") : (open ? "Finish revoking" : "Apply again"), systemImage: "nosign")
                    }
                    .consoleButton(.primary, wide: true)
                    .disabled(change.busy || change.asking)
                } else {
                    Text("Revoking withdraws a release for good. Use it when an image must not be installed any more.")
                        .font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                    consequences(steps + [
                        "It can never be deployed again, and its version number stays used: the next upload must still be newer.",
                        "Boards that already run \(release.version) keep running it. To replace it there, upload a newer version and deploy that.",
                        "This cannot be undone.",
                    ])
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Reason (required)").font(Typeface.small.weight(.semibold))
                        TextField("Why it must not be installed", text: $reason, axis: .vertical)
                            .lineLimit(2...4)
                            .padding(10)
                            .background(theme.surface, in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).stroke(theme.lineField, lineWidth: 1))
                            .disabled(change.busy)
                            .onChange(of: reason) { value in
                                if value.count > Self.limit { reason = String(value.prefix(Self.limit)) }
                            }
                        HStack {
                            Text("Recorded in the activity log and shown next to the release. Up to \(Self.limit) characters.")
                            if reason.count >= 160 {
                                Text("\(reason.count) / \(Self.limit)").monospacedDigit()
                                    .foregroundStyle(reason.count >= Self.limit ? theme.bad : theme.ink3)
                            }
                        }
                        .font(Typeface.tiny).foregroundStyle(theme.ink3)
                    }
                    failure("Not revoked.")
                    FreshSignInPrompt(change: change, what: "revocation")
                    Button(role: .destructive) {
                        Task { await submit(UploadCheck.singleLine(reason)) }
                    } label: {
                        Label(change.busy ? "Revoking…" : "Revoke \(release.version)", systemImage: "nosign")
                    }
                    .consoleButton(.danger, wide: true)
                    .disabled(UploadCheck.singleLine(reason).isEmpty || change.busy || change.asking)
                    if UploadCheck.singleLine(reason).isEmpty {
                        Text("Give a reason first.").font(Typeface.tiny).foregroundStyle(theme.ink3)
                    }
                }
            }
            .navigationTitle(again ? (open ? "Finish revoking \(release.version)?" : "Apply the revocation again?") : "Revoke \(release.version)?")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done != nil || again ? "Close" : "Keep the release") { dismiss() }
                        .disabled(change.busy)
                }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking)
    }

    private var steps: [String] {
        ["The image stops downloading at once, also for a board that is in the middle of downloading it.",
         "Every unfinished deployment of \(release.version) is cancelled, including on boards that have already started. They stop before installing."]
    }

    private func consequences(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("·").foregroundStyle(theme.ink3)
                    Text(item).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func failure(_ refusal: String) -> some View {
        if let error = change.error {
            Notice(.bad, "x-circle", error, more: change.errorRef)
        }
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
            app.say("Revocation of \(version) recorded.")
            await app.loadFirmware()
            await app.loadDeployments()
        }
    }
}
