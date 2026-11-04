import CraniumKit
import SwiftUI
import UniformTypeIdentifiers

/// A chosen file on its way to the boards: read, checked here, sent, verified by the server.
@MainActor
final class UploadModel: ObservableObject {
    enum Stage: Equatable { case idle, reading, ready, sending, done, refused }

    @Published private(set) var stage: Stage = .idle
    @Published private(set) var name = ""
    @Published private(set) var data = Data()
    @Published private(set) var digest = ""
    @Published private(set) var header = ImagePreview(Data())
    @Published var notes = ""
    @Published private(set) var release: FirmwareRelease?
    @Published private(set) var readProblem: String?
    let change = ChangeRunner()

    var recordedAs: String { UploadCheck.recordedFilename(name) }

    /// The file from Files, read with the access the picker gave.
    func choose(_ url: URL) async {
        stage = .reading
        name = url.lastPathComponent
        readProblem = nil
        release = nil
        change.reset()
        let read = await Task.detached(priority: .userInitiated) { () -> Result<Data, Error> in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                // Far larger than any slot: not read at all.
                if size > 8 * 1024 * 1024 { throw CocoaError(.fileReadTooLarge) }
                return .success(try Data(contentsOf: url))
            } catch {
                return .failure(error)
            }
        }.value
        switch read {
        case .success(let bytes):
            data = bytes
            digest = ImageCheck.sha256Hex(bytes)
            header = ImagePreview(bytes)
            stage = .ready
        case .failure(let error):
            readProblem = (error as? CocoaError)?.code == .fileReadTooLarge
                ? "Far larger than a board's update slot: not firmware for the board."
                : "The file could not be read. \(error.localizedDescription)"
            stage = .idle
        }
    }

    func review(_ firmware: FirmwareList?) -> ImageReview {
        UploadCheck.review(header, size: data.count, digest: digest, firmware: firmware)
    }

    func upload(_ app: AppModel) async {
        stage = .sending
        let filename = name
        let notes = self.notes
        let data = self.data
        if let made = await change.run(app, refusal: "The image was not stored.", { api in
            try await api.upload(filename: filename, notes: notes, data: data)
        }) {
            release = made
            stage = .done
            app.say("Registered as \(made.version).")
            await app.loadFirmware()
            await app.loadRecent()
        } else {
            stage = .refused
        }
    }

    /// The server looked at this file and said no: a refusal of the file itself is final.
    var refusedForGood: Bool {
        guard stage == .refused, let error = change.lastError as? APIError else { return false }
        return !UploadCheck.canRetry(error) && error.status != 401 && error.status != 403
    }

    func reset() {
        stage = .idle
        name = ""
        data = Data()
        digest = ""
        notes = ""
        release = nil
        readProblem = nil
        change.reset()
    }
}

/// Every release on AWS, active and revoked.
struct FirmwareView: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        ListScreen {
            if StaleNote.shows(loadedAt: app.firmware.loadedAt, error: app.firmware.error) {
                Section {
                    StaleNote(loadedAt: app.firmware.loadedAt, error: app.firmware.error) {
                        Task { await app.refreshFirmware(full: true) }
                    }
                }
            }
            if let firmware = app.firmware.value {
                if firmware.releases.isEmpty {
                    Section {
                        StateRow(kind: .empty, text: "No firmware has been uploaded yet.")
                    }
                } else {
                    let newest = firmware.newestActive?.version
                    Section {
                        ForEach(firmware.releases) { release in
                            NavigationLink(value: Route.release(release.version)) {
                                ReleaseLine(release: release, newest: release.version == newest)
                            }
                        }
                    } header: {
                        Text(Words.plural(firmware.releases.count, "release"))
                    }
                }
            } else if app.firmware.error == nil {
                Section { StateRow(kind: .loading, text: "Loading releases…") }
            }
        }
        .poll(every: { Words.idleRefresh }) { full in await app.refreshFirmware(full: full) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { app.openBluetooth(release: nil) } label: {
                        Label("Update over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                    }
                    NavigationLink(value: Route.signingKey) { Label("Signing key", systemImage: "key") }
                    NavigationLink(value: Route.help("firmware-and-signing")) { Label("Help", systemImage: "questionmark.circle") }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel("More")
                }
            }
            if app.canWrite {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink(value: Route.upload) {
                        Image(systemName: "plus").accessibilityLabel("Upload firmware")
                    }
                }
            }
        }
        .screenTitle("Firmware")
    }
}

/// Upload, verify, deploy: one file at a time.
struct UploadView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var upload = UploadModel()
    @State private var picking = false

    var body: some View {
        ListScreen {
            switch upload.stage {
            case .idle:
                Section {
                    PrimaryButton("Choose a signed image", systemImage: "doc.badge.plus") { picking = true }
                } footer: {
                    Text("binaries/latest.signed.bin from your build, put in Files. Nothing is sent until you have checked it.")
                }
                if let problem = upload.readProblem {
                    Section { StateRow(kind: .failed, text: problem) }
                }
            case .reading:
                Section { StateRow(kind: .loading, text: "Reading \(upload.name)…") }
            case .done:
                if let release = upload.release { verified(release) }
            default:
                chosen
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first {
                Task { await upload.choose(url) }
            }
        }
        .helpButton("firmware-and-signing")
        .screenTitle("Upload", large: false)
    }

    @ViewBuilder private var chosen: some View {
        let review = upload.review(app.firmware.value)
        let busy = upload.stage == .sending
        let refused = upload.stage == .refused
        let final = refused && !UploadCheck.canRetry(upload.change.lastError ?? URLError(.unknown))
        let doomed = review.doomed && !refused
        Section {
            Text(verbatim: upload.name).lineLimit(1).truncationMode(.middle)
            if upload.header.ok {
                HStack {
                    Text("Version")
                    Spacer()
                    VersionText(upload.header.version).foregroundStyle(theme.ink2)
                }
                ValueRow("Size", Words.sizeWords(upload.data.count))
                HStack {
                    Text("SHA-256")
                    Spacer()
                    Text(verbatim: "\(upload.digest.prefix(16))…").font(Typeface.hash).foregroundStyle(theme.ink2)
                    CopyButton(value: upload.digest, label: "the SHA-256")
                }
            }
        } header: {
            Text("File")
        }
        Section("Checks") {
            ForEach(final ? [] : review.notes + (review.blocked || refused || doomed ? [] : [UploadCheck.signatureUnchecked]), id: \.self) { note in
                StatusText(note.tone, note.tone == .good ? "check-circle" : note.tone == .warn ? "alert" : note.tone == .bad ? "x-circle" : "clock",
                           note.text)
            }
            if refused, let error = upload.change.lastError {
                let check = (error as? APIError).flatMap { UploadCheck.failedCheck($0.code) }
                VStack(alignment: .leading, spacing: 4) {
                    StatusText(.bad, "x-circle", upload.refusedForGood ? "The server refused this image." : "The image was not stored.")
                    Text(Words.sentence(Words.plainMessage(error))).font(.footnote).foregroundStyle(theme.ink2)
                    if let check { Text("Check that failed: \(check). Nothing was stored.").font(.footnote).foregroundStyle(theme.ink2) }
                }
            }
        }
        // The prompt watches the runner itself: this screen only watches the upload.
        Section { FreshSignInPrompt(change: upload.change, what: "upload") }
        if final || doomed {
            Section {
                PrimaryButton("Choose another file", systemImage: "doc") { upload.reset(); picking = true }
            }
        } else if !review.blocked {
            Section("Notes") {
                TextField("What changed in this build (optional)", text: $upload.notes, axis: .vertical)
                    .lineLimit(1...4)
                    .onChange(of: upload.notes) { value in
                        if value.count > 500 { upload.notes = String(value.prefix(500)) }
                    }
                    .disabled(busy)
            }
            Section {
                PrimaryButton(busy ? "Verifying…" : refused ? "Try again" : "Upload for verification",
                              systemImage: "arrow.up.to.line", busy: busy) {
                    Task { await upload.upload(app) }
                }
                .disabled(busy || upload.change.asking)
            }
            if !busy {
                Section {
                    Button("Choose another file") { upload.reset(); picking = true }
                }
            }
        }
    }

    @ViewBuilder
    private func verified(_ release: FirmwareRelease) -> some View {
        let first = (app.releases ?? []).allSatisfy { $0.version == release.version }
        Section {
            VStack(alignment: .leading, spacing: 6) {
                StatusText(.good, "check-circle", "Verified by the server").font(.headline)
                HStack(spacing: 6) {
                    Text("Registered as")
                    VersionText(release.version)
                }
            }
            .padding(.vertical, 4)
        }
        Section {
            PrimaryButton("Deploy this release", systemImage: "paperplane") {
                app.deployingThings = []
                app.deploying = release.version
            }
        }
        Section {
            Button { app.openBluetooth(release: release.version) } label: {
                Label("Send over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
            }
            NavigationLink(value: Route.release(release.version)) { Label("Open the release", systemImage: "shippingbox") }
            Button("Upload another") { upload.reset() }
        }
        Section {
            DisclosureGroup("What the server checked") {
                ForEach(UploadCheck.checks, id: \.name) { check in
                    StatusText(.good, "check-circle", first ? (check.passedFirst ?? check.passed) : check.passed)
                }
            }
        }
    }
}

/// The project's signing key, as the server holds it.
struct SigningKeyView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        let fingerprint = app.firmware.value?.fingerprint ?? ""
        let earlier = (app.releases ?? []).filter { !fingerprint.isEmpty && !$0.keyHash.isEmpty && $0.keyHash != fingerprint }.count
        ListScreen {
            Section {
                if fingerprint.isEmpty {
                    Text("Not known yet").foregroundStyle(theme.ink3)
                } else {
                    HStack(alignment: .top) {
                        Text(verbatim: fingerprint).font(Typeface.hash).textSelection(.enabled)
                        CopyButton(value: fingerprint, label: "the key fingerprint")
                    }
                }
            } header: {
                Text("Fingerprint · SHA-256")
            } footer: {
                Text(earlier > 0 ? "\(Words.plural(earlier, "older release was", "older releases were")) signed with an earlier key."
                     : "The server keeps only the public half of the key.")
            }
            Section {
                NavigationLink(value: Route.help("firmware-and-signing")) { Text("How uploads are verified") }
            }
        }
        .screenTitle("Signing key", large: false)
    }
}

/// Asked when the console wants a fresh sign-in for a change: the change waits, with what was
/// entered, and runs once more after the sign-in.
struct FreshSignInPrompt: View {
    @Environment(\.theme) private var theme
    @ObservedObject var change: ChangeRunner
    let what: String

    var body: some View {
        // Still here while the sign-in sheet is open: the sheet hangs from it.
        if change.asking || change.signingIn {
            VStack(alignment: .leading, spacing: 10) {
                Label("Sign in again to go on", systemImage: "lock").font(.headline)
                Text("A change from the phone needs a sign-in in the last 15 minutes. Then the \(what) goes ahead with what you entered.")
                    .font(.subheadline).foregroundStyle(theme.ink2)
                HStack(spacing: 12) {
                    Button("Sign in again") { change.answer(true) }
                        .buttonStyle(.borderedProminent).tint(theme.accent)
                    Button("Not now") { change.answer(false) }
                        .buttonStyle(.bordered)
                }
                .disabled(change.signingIn)
            }
            .padding(.vertical, 4)
            .sheet(isPresented: Binding(get: { change.signingIn }, set: { if !$0 { change.endSignIn(.cancelled) } })) {
                SignInScreen(flow: change.signInFlow, again: true, email: change.signInEmail) { ending in
                    change.endSignIn(ending)
                }
            }
        }
    }
}
