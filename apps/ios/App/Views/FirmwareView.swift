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
    @Published private(set) var refusal: Error?
    @Published private(set) var readProblem: String?
    let change = ChangeRunner()

    var recordedAs: String { UploadCheck.recordedFilename(name) }

    /// The file from Files, read with the access the picker gave.
    func choose(_ url: URL) async {
        stage = .reading
        name = url.lastPathComponent
        readProblem = nil
        refusal = nil
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
                ? "The file is far larger than a board's update slot: it cannot be firmware for the board."
                : "The file could not be read. \(error.localizedDescription)"
            stage = .idle
        }
    }

    func review(_ firmware: FirmwareList?) -> ImageReview {
        UploadCheck.review(header, size: data.count, digest: digest, firmware: firmware)
    }

    func upload(_ app: AppModel) async {
        stage = .sending
        refusal = nil
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
        refusal = nil
        readProblem = nil
        change.reset()
    }
}

/// The website's Firmware page.
struct FirmwareView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var upload = UploadModel()

    var body: some View {
        Page {
            PageHead(lede: "Signed images that can be offered to boards. A version, once used, is never reused.")
            Freshness(loadedAt: app.firmware.loadedAt, interval: 0, loading: app.firmware.loading)
            if let error = app.firmware.error {
                LoadProblem(what: "the releases", error: error, loadedAt: app.firmware.loadedAt) {
                    Task { await app.refreshFirmware(full: true) }
                }
            }
            if app.canWrite {
                UploadPanel(upload: upload)
            }
            if let firmware = app.firmware.value, !firmware.releases.isEmpty {
                ReleaseTimeline(firmware: firmware)
            }
            if !app.canWrite {
                Card { TrustPanel() }
            }
            Card("Releases") {
                if let firmware = app.firmware.value {
                    if firmware.releases.isEmpty {
                        EmptyState(icon: "package", title: "No firmware has been uploaded yet.",
                                   text: app.canWrite ? "Build the firmware, then upload binaries/latest.signed.bin to register the first release."
                                   : "A release manager can upload the first signed image.")
                    } else {
                        VStack(spacing: 0) {
                            ForEach(firmware.releases) { release in
                                ReleaseRow(release: release, slot: firmware.slotSize)
                                RowRule()
                            }
                        }
                    }
                } else if app.firmware.error == nil {
                    Loading(what: "releases")
                }
            }
        }
        .poll(every: { upload.stage == .idle || upload.stage == .done ? Words.idleRefresh : 0 }) { full in
            await app.refreshFirmware(full: full)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    app.openBluetooth(release: nil)
                } label: {
                    Label("Update over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                }
            }
        }
        .consoleTitle("Firmware")
    }
}

/// A release in the list.
struct ReleaseRow: View {
    @Environment(\.theme) private var theme
    let release: FirmwareRelease
    let slot: Int?

    var body: some View {
        RowLink(.release(release.version)) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Mono(release.version, strong: true, font: .system(.body, design: .monospaced))
                        .foregroundStyle(release.isActive ? theme.ink : theme.ink2)
                    ReleaseBadges(release: release)
                }
                if let notes = release.notes {
                    Text(verbatim: notes).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                }
                if let revoked = release.revoked {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "nosign").font(.caption).foregroundStyle(theme.bad)
                        Text("Revoked \(Words.timeAgo(revoked.at, now: Date())) by \(Words.nameOf(revoked.by)): \(revoked.reason)")
                            .font(Typeface.small).foregroundStyle(theme.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if Words.revocationState(release) == .incomplete {
                    Text("\(Words.revocationOpen) Until it has, a board may still be able to download or install it.")
                        .font(Typeface.small).foregroundStyle(theme.warn)
                        .fixedSize(horizontal: false, vertical: true)
                }
                SlotFit(size: release.size, slot: slot)
                Text("\(Words.fileSize(release.size)) · Uploaded \(Words.timeAgo(release.uploadedAt, now: Date())) by \(Words.nameOf(release.uploadedBy))")
                    .font(Typeface.small).foregroundStyle(theme.ink3)
                Text("SHA-256 \(String(release.sha256.prefix(16)))…").font(Typeface.mono).foregroundStyle(theme.ink3)
            }
            .padding(.vertical, 12)
        }
        .opacity(release.isActive ? 1 : 0.85)
    }
}

/// How much of a board's update slot an image takes.
struct SlotFit: View {
    @Environment(\.theme) private var theme
    let size: Int
    let slot: Int?

    var body: some View {
        if let slot, slot > 0 {
            let percent = Double(size) / Double(slot) * 100
            HStack(spacing: 8) {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(theme.line)
                        Capsule().fill(theme.ink2).frame(width: geometry.size.width * min(1, percent / 100))
                    }
                }
                .frame(width: 70, height: 5)
                Text("Takes \(percent < 1 ? "under 1%" : "\(Int(percent.rounded()))%") of the \(Words.fileSize(slot)) update slot")
                    .font(Typeface.tiny).foregroundStyle(theme.ink3)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// The releases in the order they were uploaded, with the boards on each.
struct ReleaseTimeline: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let firmware: FirmwareList

    var body: some View {
        let newest = firmware.newestActive
        let shown = Array(firmware.releases.prefix(6).reversed())
        let revoked = firmware.releases.filter { !$0.isActive }.count
        var counted: [String: Int] = [:]
        var quiet: Set<String> = []
        for device in app.deviceList ?? [] {
            guard let version = device.fw?.version else { continue }
            counted[version, default: 0] += 1
            if !device.online { quiet.insert(version) }
        }
        return Card("Release timeline", more: {
            Text([Words.plural(firmware.releases.count, "release"), revoked > 0 ? "\(revoked) revoked" : nil,
                  firmware.releases.count > shown.count ? "the newest \(shown.count) shown" : nil]
                .compactMap { $0 }.joined(separator: " · "))
                .font(Typeface.tiny).foregroundStyle(theme.ink3)
        }) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 0) {
                    ForEach(shown) { release in
                        let isNewest = release.version == newest?.version
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 0) {
                                ZStack {
                                    Circle().fill(isNewest ? theme.accent : release.isActive ? theme.ink : theme.paper)
                                    Circle().stroke(release.isActive ? Color.clear : theme.bad, lineWidth: 1.5)
                                    if !release.isActive { Image(systemName: "xmark").font(.system(size: 7, weight: .bold)).foregroundStyle(theme.bad) }
                                }
                                .frame(width: 14, height: 14)
                                Rectangle().fill(theme.lineStrong).frame(height: 2)
                            }
                            Mono(release.version, strong: true, font: Typeface.mono)
                            Text(isNewest ? "Newest release" : release.isActive ? "Active" : "Revoked")
                                .font(Typeface.tiny.weight(.semibold))
                                .foregroundStyle(isNewest ? theme.accent : release.isActive ? theme.ink2 : theme.bad)
                            Text(Words.timeAgo(release.uploadedAt, now: Date())).font(Typeface.tiny).foregroundStyle(theme.ink3)
                            if let boards = counted[release.version], boards > 0 {
                                Text("\(Words.plural(boards, "board")) on it\(quiet.contains(release.version) ? " when last seen" : "")")
                                    .font(Typeface.tiny).foregroundStyle(theme.ink2)
                            }
                        }
                        .frame(width: 120, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Circle().stroke(theme.lineStrong, lineWidth: 1.5).frame(width: 14, height: 14)
                        Text("Now").font(Typeface.tiny.weight(.semibold)).foregroundStyle(theme.ink3)
                    }
                    .accessibilityHidden(true)
                }
            }
        }
    }
}

/// The server verifies every upload: the chain of checks and the signing key's fingerprint.
struct TrustPanel: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        let fingerprint = app.firmware.value?.fingerprint ?? ""
        let earlier = (app.releases ?? []).filter { !fingerprint.isEmpty && !$0.keyHash.isEmpty && $0.keyHash != fingerprint }.count
        VStack(alignment: .leading, spacing: 12) {
            Label("The server verifies every upload", systemImage: "checkmark.shield")
                .font(Typeface.heading)
            VStack(alignment: .leading, spacing: 8) {
                chain("key", "Signed at build", "With the project’s private key")
                chain("checkmark.shield", "Checked on upload", "By this server, with the public key")
                chain("cpu", "Checked at boot", "By the board’s bootloader")
            }
            Text("An image is stored only if its ECDSA P-256 signature checks out against this project’s signing key. The board’s bootloader checks the same signature again before it starts the image.")
                .font(Typeface.small).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            Text("The console holds only the public half of that key. It can check a signature; it can never make one, and neither can anyone who signs in here.")
                .font(Typeface.small).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            if !fingerprint.isEmpty {
                Eyebrow("Signing key fingerprint · SHA-256")
                CopyRow(value: fingerprint, label: "the key fingerprint")
                if earlier > 0 {
                    Text("\(Words.plural(earlier, "older release was", "older releases were")) signed with an earlier key, which has been replaced since, so \(earlier == 1 ? "it shows" : "they show") another fingerprint.")
                        .font(Typeface.tiny).foregroundStyle(theme.ink3)
                }
            }
        }
    }

    private func chain(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(theme.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Typeface.small.weight(.semibold))
                Text(text).font(Typeface.tiny).foregroundStyle(theme.ink3)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Upload, verify, deploy: the ink panel of the Firmware page for a release manager.
struct UploadPanel: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject var upload: UploadModel
    @ObservedObject private var change: ChangeRunner
    @State private var picking = false

    init(upload: UploadModel) {
        self.upload = upload
        _change = ObservedObject(wrappedValue: upload.change)
    }

    var body: some View {
        let theme = Theme.panel
        Panel {
            Eyebrow("Upload, verify, deploy")
            stages
            switch upload.stage {
            case .idle:
                choose
            case .reading:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Reading \(upload.name)…")
                }
            case .done:
                if let release = upload.release { verified(release) }
            default:
                chosen
            }
            if upload.stage != .done {
                Divider().overlay(theme.line)
                TrustPanel()
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first {
                Task { await upload.choose(url) }
            }
        }
    }

    private var stages: some View {
        let theme = Theme.panel
        let review = upload.stage == .ready ? upload.review(app.firmware.value) : nil
        let unusable = review?.blocked == true || review?.doomed == true
        let sentOff = upload.stage == .sending || upload.stage == .refused || upload.stage == .done
        let chooseWord = sentOff ? ("done", Tone.idle, true) : (unusable ? ("cannot be used", Tone.bad, false) : ("your turn", Tone.act, false))
        var verify = ("not started", Tone.idle, false)
        if upload.stage == .sending { verify = ("the server is verifying", .live, false) }
        else if upload.stage == .done { verify = ("signature valid", .good, true) }
        else if upload.refusedForGood { verify = ("refused, nothing stored", .bad, false) }
        else if upload.stage == .refused { verify = ("not finished", .bad, false) }
        let deployed = upload.release.flatMap { release in (app.deployments.value ?? []).first { $0.version == release.version } }
        let deploy = upload.stage == .done ? (deployed != nil ? ("started", Tone.idle, true) : ("your turn", Tone.act, false))
            : ("not started", Tone.idle, false)
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(Array([("Choose a signed image", chooseWord), ("The server verifies it", verify), ("Deploy it to boards", deploy)].enumerated()),
                    id: \.offset) { index, item in
                let (label, state) = item
                HStack(spacing: 10) {
                    ZStack {
                        Circle().stroke(state.1 == .idle && !state.2 ? theme.lineMark : theme.tone(state.1), lineWidth: 1.5)
                        if state.2 {
                            Image(systemName: "checkmark").font(.caption2.weight(.bold))
                        } else if state.1 == .bad {
                            Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(theme.bad)
                        } else {
                            Text("\(index + 1)").font(.caption2.weight(.bold))
                        }
                    }
                    .frame(width: 22, height: 22)
                    Text(label).font(Typeface.small.weight(.semibold))
                    Text(state.0).font(Typeface.tiny).foregroundStyle(state.1 == .act ? theme.accent : theme.ink3)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var choose: some View {
        let theme = Theme.panel
        let slot = app.firmware.value?.slotSize
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                picking = true
            } label: {
                Label("Choose latest.signed.bin", systemImage: "arrow.up.doc")
            }
            .consoleButton(.primary, wide: true)
            Text((slot.map { "A signed MCUboot image, up to \(Words.fileSize($0)). " } ?? "A signed MCUboot image. ")
                 + "Nothing is sent until you have checked what the file contains.")
                .font(Typeface.small).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            Text("Each build leaves its signed image in binaries/latest.signed.bin in your checkout. Put it in Files (iCloud Drive, or AirDrop it) to choose it here.")
                .font(Typeface.tiny).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
            if let problem = upload.readProblem {
                Notice(.bad, "x-circle", problem)
            }
        }
    }

    @ViewBuilder private var chosen: some View {
        let theme = Theme.panel
        let review = upload.review(app.firmware.value)
        let busy = upload.stage == .sending
        let refused = upload.stage == .refused
        let final = refused && !UploadCheck.canRetry(change.lastError ?? URLError(.unknown))
        let doomed = review.doomed && !refused
        let checks: [ReviewNote] = final ? [] : (review.blocked || refused || doomed || busy ? review.notes
                                                 : review.notes + [UploadCheck.signatureUnchecked])
        HStack {
            Label(upload.name, systemImage: "doc").font(Typeface.monoBody).lineLimit(1).truncationMode(.middle)
            Spacer()
            if !(busy || final || doomed) {
                Button("Choose another") { upload.reset(); picking = true }.consoleButton(.quiet)
            }
        }
        if upload.header.ok {
            VStack(spacing: 0) {
                Fact("Version") { Mono(upload.header.version, strong: true) }
                Fact("Size") { Text(Words.sizeWords(upload.data.count)) }
                Fact("SHA-256") { Mono(upload.digest, font: Typeface.mono) }
                Fact("Layout") {
                    Text("\(Words.exactBytes(upload.header.headerSize)) of header, \(Words.exactBytes(upload.header.payloadSize)) of firmware")
                }
                if upload.recordedAs != upload.name {
                    Fact("Recorded as") { Mono(upload.recordedAs) }
                }
            }
        }
        if !checks.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(checks, id: \.self) { note in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: Icon.symbol(note.tone == .good ? "check-circle" : note.tone == .warn ? "alert" : note.tone == .bad ? "x-circle" : "clock"))
                            .foregroundStyle(theme.tone(note.tone))
                        Text(note.text).font(Typeface.small).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        if refused, let error = change.lastError {
            let ofImage = upload.refusedForGood
            let check = (error as? APIError).flatMap { UploadCheck.failedCheck($0.code) }
            Notice(.bad, "x-circle", Words.failure(ofImage ? "The server refused this image." : "The image was not stored.", error),
                   more: [ofImage ? (check.map { "Check that failed: \($0). " } ?? "") + "Nothing was stored." : nil,
                          change.errorRef].compactMap { $0 }.joined(separator: " ").nilIfEmpty)
        }
        FreshSignInPrompt(change: change, what: "upload")
        if busy {
            HStack(spacing: 10) {
                ProgressView()
                Text("Uploading. The server verifies the signature…")
            }
            .font(Typeface.body)
        } else if final || doomed {
            Button { upload.reset(); picking = true } label: { Label("Choose another file", systemImage: "doc") }
                .consoleButton(.primary, wide: true)
        } else if !review.blocked {
            VStack(alignment: .leading, spacing: 6) {
                Text("Notes (optional)").font(Typeface.small.weight(.semibold))
                TextField("What changed in this build", text: $upload.notes, axis: .vertical)
                    .lineLimit(2...4)
                    .padding(10)
                    .background(theme.well, in: RoundedRectangle(cornerRadius: 5))
                    .onChange(of: upload.notes) { value in
                        if value.count > 500 { upload.notes = String(value.prefix(500)) }
                    }
                Text("What changed in this build. Shown next to the release.").font(Typeface.tiny).foregroundStyle(theme.ink3)
            }
            Button {
                Task { await upload.upload(app) }
            } label: {
                Label(refused ? "Try again" : "Upload for verification", systemImage: "arrow.up.to.line")
            }
            .consoleButton(.primary, wide: true)
            .disabled(change.asking)
        }
    }

    private func verified(_ release: FirmwareRelease) -> some View {
        let theme = Theme.panel
        let fingerprint = app.firmware.value?.fingerprint ?? ""
        let deployed = (app.deployments.value ?? []).first { $0.version == release.version }
        let first = (app.releases ?? []).allSatisfy { $0.version == release.version }
        return VStack(alignment: .leading, spacing: 12) {
            Label("Verified by the server", systemImage: "checkmark.shield").font(Typeface.small.weight(.semibold))
                .foregroundStyle(theme.good)
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle").foregroundStyle(theme.good)
                Text("Registered as").font(Typeface.heading)
                Mono(release.version, strong: true, font: .system(.headline, design: .monospaced))
            }
            Text(deployed != nil ? "The signature is valid and the image is stored. A deployment of it has been started."
                 : "The signature is valid and the image is stored. It can now be offered to boards.")
                .font(Typeface.body).foregroundStyle(theme.ink2)
            if let deployed {
                NavigationLink(value: Route.deployment(deployed.id)) { Text("Open its deployment") }
                    .consoleButton(.primary, wide: true)
            } else {
                Button { app.deployingThings = []; app.deploying = release.version } label: {
                    Label("Deploy this release", systemImage: "paperplane")
                }
                .consoleButton(.primary, wide: true)
            }
            HStack(spacing: 10) {
                Button { app.openBluetooth(release: release.version) } label: {
                    Label("Send over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                }
                .consoleButton()
                Button("Upload another") { upload.reset() }.consoleButton()
            }
            VStack(spacing: 0) {
                Fact("Signature") { StatusLine(tone: .good, icon: "check-circle", title: "ECDSA P-256, valid") }
                if !release.keyHash.isEmpty {
                    Fact("Signing key") {
                        Mono(release.keyHash, font: Typeface.mono)
                        FactNote(release.keyHash == fingerprint ? "The fingerprint of this project’s signing key."
                                 : "The fingerprint of the key that signed it.")
                    }
                }
                Fact("Version") {
                    Mono(release.version, strong: true)
                    FactNote("Read from the signed header of the image.")
                }
                Fact("Size") {
                    Text(Words.sizeWords(release.size))
                    if let header = release.headerSize, let payload = release.payloadSize {
                        FactNote("\(Words.exactBytes(header)) of header, \(Words.exactBytes(payload)) of firmware, then the signature.")
                    }
                }
                Fact("SHA-256") { Mono(release.sha256, font: Typeface.mono) }
                if let load = release.loadAddress { Fact("Load address") { Mono("0x" + String(load, radix: 16)) } }
            }
            Eyebrow("What the server checked")
            VStack(alignment: .leading, spacing: 6) {
                ForEach(UploadCheck.checks, id: \.name) { check in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "checkmark.circle").foregroundStyle(theme.good)
                        Text(first ? (check.passedFirst ?? check.passed) : check.passed)
                            .font(Typeface.small).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Text("The board’s bootloader checks the same signature again before it starts the image.")
                .font(Typeface.tiny).foregroundStyle(theme.ink3)
        }
    }
}

/// Asked when the console wants a fresh sign-in for a change: the change waits, with what was
/// entered, and runs once more after the sign-in.
struct FreshSignInPrompt: View {
    @ObservedObject var change: ChangeRunner
    let what: String

    var body: some View {
        if change.asking {
            Notice(.warn, "lock", FreshSignIn.ask,
                   more: "After you sign in, the \(what) goes ahead with what you entered.") {
                HStack(spacing: 10) {
                    Button("Sign in again") { change.answer(true) }.consoleButton(.primary)
                    Button("Not now") { change.answer(false) }.consoleButton()
                }
            }
        }
    }
}
