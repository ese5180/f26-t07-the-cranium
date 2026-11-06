import CraniumKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: Changes

extension View {
    /// What a change from the Mac may need: the console's "sign in again first" (a change from the
    /// app needs a sign-in in the last 15 minutes, as from the phones), then the sign-in itself, then
    /// the change once more with what was entered. ChangeRunner (AppModel.swift) does the work.
    func changeSheets(_ change: ChangeRunner) -> some View {
        modifier(ChangeSheets(change: change))
    }
}

private struct ChangeSheets: ViewModifier {
    @ObservedObject var change: ChangeRunner

    func body(content: Content) -> some View {
        content
            .alert("Sign in again first", isPresented: Binding(get: { change.asking }, set: { if !$0 && change.asking { change.answer(false) } })) {
                Button("Sign in again") { change.answer(true) }
                Button("Not now", role: .cancel) { change.answer(false) }
            } message: {
                Text("A change from the app needs a sign-in in the last 15 minutes. Then it goes ahead with what you entered.")
            }
            .sheet(isPresented: Binding(get: { change.signingIn }, set: { if !$0 { change.endSignIn(.cancelled) } })) {
                TeamSignIn(flow: change.signInFlow, again: true, email: change.signInEmail) { change.endSignIn($0) }
                    .padding(28)
                    .frame(width: 460)
            }
    }
}

// MARK: Firmware

/// The releases: upload, notes, deploy and revoke, as the console's Firmware page.
struct FirmwarePage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession
    @State private var selection: String?
    @State private var search = ""
    @State private var order = [KeyPathComparator(\ReleaseRow.order, order: .reverse)]
    @State private var uploading = false
    @State private var opened: String?

    var body: some View {
        let rows = (app.releases ?? []).map(ReleaseRow.init).filter { search.isEmpty || $0.release.version.contains(search) }
            .sorted(using: order)
        Group {
            if app.releases == nil {
                if let error = app.firmware.error {
                    PageState(kind: .failed, text: Words.plainMessage(error)) { session.refreshNow() }
                } else {
                    PageState(kind: .loading, text: "Loading the releases…")
                }
            } else if rows.isEmpty {
                PageState(kind: .empty, text: search.isEmpty ? "No release yet. Upload a signed image to make the first." : "No release matches “\(search)”.")
            } else {
                Table(rows, selection: $selection, sortOrder: $order) {
                    TableColumn("Version", value: \.order) { row in VersionText(row.release.version) }
                        .width(min: 90, ideal: 110)
                    TableColumn("Status") { row in
                        if row.release.isActive {
                            StatusLabel(.good, "check-circle", "Active")
                        } else {
                            StatusLabel(.bad, "ban", Words.revocationState(row.release) == .incomplete ? "Revocation incomplete" : "Revoked")
                        }
                    }
                    .width(min: 100, ideal: 150)
                    TableColumn("Uploaded", value: \.uploaded) { row in
                        Text(Words.timeAgo(row.release.uploadedAt, now: Date())).foregroundStyle(.secondary)
                    }
                    .width(min: 90, ideal: 120)
                    TableColumn("Size") { row in Text(Words.fileSize(row.release.size)).foregroundStyle(.secondary) }
                        .width(min: 60, ideal: 80)
                    TableColumn("Notes") { row in Text(row.release.notes ?? "").lineLimit(1).foregroundStyle(.secondary) }
                }
                .contextMenu(forSelectionType: String.self) { versions in
                    if let version = versions.first { Button("Open") { opened = version } }
                } primaryAction: { versions in
                    opened = versions.first
                }
            }
        }
        .searchable(text: $search, placement: .toolbar, prompt: "Version")
        .refreshing(every: { Words.idleRefresh }) { full in await app.refreshFirmware(full: full) }
        .pageToolbar("Firmware", subtitle: app.firmware.value?.newestActive.map { "Newest \($0.version)" })
        .toolbar {
            if app.canWrite {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        uploading = true
                    } label: {
                        Label("Upload", systemImage: "arrow.up.doc")
                    }
                    .help("Upload a signed image as a new release")
                }
            }
        }
        .sheet(isPresented: $uploading) { UploadSheet() }
        .navigationDestination(isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } })) {
            if let opened { ReleasePage(version: opened) }
        }
    }
}

struct ReleaseRow: Identifiable {
    let release: FirmwareRelease
    var id: String { release.version }
    /// Sorts by the version's numbers, not its text.
    var order: String {
        guard let parsed = release.parsedVersion else { return release.version }
        return String(format: "%03d.%03d.%05d.%010d", Int(parsed.major), Int(parsed.minor), Int(parsed.revision), Int(parsed.build))
    }

    var uploaded: String { release.uploadedAt ?? "" }
}

/// One release: its facts, its notes, the boards on it, and Deploy and Revoke.
struct ReleasePage: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var change = ChangeRunner()
    let version: String
    @State private var deploying = false
    @State private var revoking = false

    var body: some View {
        let release = app.releases?.first { $0.version == version }
        Group {
            if let release {
                Form {
                    Section {
                        HStack {
                            VersionText(release.version).font(.title2.weight(.semibold))
                            Spacer()
                            if release.isActive {
                                StatusLabel(.good, "check-circle", "Active")
                            } else {
                                StatusLabel(.bad, "ban", "Revoked")
                            }
                        }
                        if let notes = release.notes, !notes.isEmpty { Text(notes) }
                    }
                    Section("Image") {
                        FactRow("Uploaded", Words.dateAndTime(release.uploadedAt))
                        if let by = release.uploadedBy { FactRow("By", Words.nameOf(by)) }
                        FactRow("Size", Words.exactBytes(release.size))
                        FactRow("SHA-256", release.sha256, mono: true)
                        FactRow("Image hash", release.imageHash, mono: true)
                        FactRow("Signing key", release.keyHash, mono: true)
                        if let filename = release.filename { FactRow("File", filename, mono: true) }
                    }
                    if let revoked = release.revoked {
                        Section("Revoked") {
                            FactRow("Why", revoked.reason)
                            FactRow("When", Words.dateAndTime(revoked.at))
                            if Words.revocationState(release) == .incomplete {
                                StatusLabel(.warn, "alert", Words.revocationOpen)
                            }
                        }
                    }
                    let boards = (app.deviceList ?? []).filter { $0.fw?.version == release.version }
                    Section("Boards on it (\(boards.count))") {
                        if boards.isEmpty {
                            Text("None").foregroundStyle(.secondary)
                        }
                        ForEach(boards) { device in
                            NavigationLink(value: Route.board(device.thing)) { BoardTitle(thing: device.thing, name: device.name) }
                        }
                    }
                    if let error = change.error {
                        Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                    }
                }
                .formStyle(.grouped)
                .toolbar {
                    if app.canWrite && release.isActive {
                        ToolbarItem(placement: .primaryAction) {
                            Button { deploying = true } label: { Label("Deploy", systemImage: "paperplane") }
                        }
                        ToolbarItem(placement: .automatic) {
                            Button(role: .destructive) { revoking = true } label: { Label("Revoke", systemImage: "nosign") }
                        }
                    }
                }
                .sheet(isPresented: $deploying) { DeploySheet(version: release.version) }
                .sheet(isPresented: $revoking) { RevokeSheet(version: release.version, change: change) }
            } else if app.releases == nil {
                PageState(kind: .loading, text: "Loading the release…")
            } else {
                PageState(kind: .empty, text: "No release \(version).")
            }
        }
        .changeSheets(change)
        .refreshing(every: { Words.idleRefresh }) { full in await app.refreshFirmware(full: full) }
        .pageToolbar(version, subtitle: "Release")
    }
}

/// A signed image from the Mac: the console checks it (signature, key, header) before it keeps it.
struct UploadSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var change = ChangeRunner()
    @State private var file: URL?
    @State private var notes = ""
    @State private var picking = false
    @State private var done: FirmwareRelease?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Upload a release").font(.title2.weight(.semibold))
            Text("A signed MCUboot image (zephyr.signed.bin). The console checks its signature and its header before it keeps it.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(file?.lastPathComponent ?? "No file chosen").font(.body.monospaced())
                Spacer()
                Button("Choose…") { picking = true }
            }
            TextField("Notes (what changed)", text: $notes, axis: .vertical).lineLimit(3...6)
            if let error = change.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            if let done { Label("Uploaded \(done.version).", systemImage: "checkmark.circle").foregroundStyle(.green) }
            HStack {
                Spacer()
                Button(done == nil ? "Cancel" : "Done") { dismiss() }.keyboardShortcut(.cancelAction)
                if done == nil {
                    Button(change.busy ? "Uploading…" : "Upload") { Task { await upload() } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(file == nil || change.busy)
                }
            }
        }
        .padding(24)
        .frame(width: 480)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data]) { result in
            if case .success(let url) = result { file = url }
        }
        .changeSheets(change)
    }

    private func upload() async {
        guard let file else { return }
        let reading = file.startAccessingSecurityScopedResource()
        defer { if reading { file.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: file), data.count <= 8 * 1024 * 1024 else {
            change.error = "The file could not be read, or is larger than 8 MB."
            return
        }
        let filename = file.lastPathComponent
        let text = notes
        if let release = await change.run(app, refusal: "Not uploaded.", { api in
            try await api.upload(filename: filename, notes: text, data: data)
        }) {
            done = release
            await app.loadFirmware()
        }
    }
}

/// Revoke: no board may install it from then on, and its open deployments are cancelled.
struct RevokeSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let version: String
    @ObservedObject var change: ChangeRunner
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Revoke \(version)?").font(.title2.weight(.semibold))
            Text("No board can install it from now on, and every open deployment of it is cancelled. A board that runs it keeps running it.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("Why (the log keeps it)", text: $reason)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Revoke", role: .destructive) {
                    let sent = reason.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task {
                        if let result = await change.run(app, refusal: "Not revoked.", { api in
                            try await api.revoke(version: version, reason: sent)
                        }) {
                            app.say(Words.revocationNotice(version, cancelled: result.cancelled, again: false))
                            await app.loadFirmware()
                            dismiss()
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || change.busy)
            }
        }
        .padding(24)
        .frame(width: 460)
    }
}

// MARK: Deployments

/// A release to boards over the air: pick the boards, add a note, deploy. The board asks for Button 1
/// before it writes anything, from firmware 1.7.2 on.
struct DeploySheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var change = ChangeRunner()
    let version: String
    @State private var things = Set<String>()
    @State private var note = ""
    @State private var made: Deployment?

    var body: some View {
        let devices = app.deviceList ?? []
        VStack(alignment: .leading, spacing: 14) {
            Text("Deploy \(version)").font(.title2.weight(.semibold))
            List(devices) { device in
                Toggle(isOn: Binding(get: { things.contains(device.thing) }, set: { on in
                    if on { things.insert(device.thing) } else { things.remove(device.thing) }
                })) {
                    HStack {
                        BoardTitle(thing: device.thing, name: device.name)
                        Spacer()
                        if Words.alreadyRuns(device, version: version) {
                            Text("Runs it already").font(.caption).foregroundStyle(.secondary)
                        } else if let fw = device.fw {
                            VersionText(fw.version).foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(Words.alreadyRuns(device, version: version))
            }
            .frame(minHeight: 180)
            TextField("Note (the log keeps it)", text: $note)
            if let error = change.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            if let made { Label("Deployment \(made.id) made.", systemImage: "checkmark.circle").foregroundStyle(.green) }
            HStack {
                Text(Words.plural(things.count, "board")).foregroundStyle(.secondary)
                Spacer()
                Button(made == nil ? "Cancel" : "Done") { dismiss() }.keyboardShortcut(.cancelAction)
                if made == nil {
                    Button(change.busy ? "Deploying…" : "Deploy") {
                        let chosen = Array(things).sorted(), text = note
                        Task {
                            if let deployment = await change.run(app, refusal: "Not deployed.", { api in
                                try await api.deploy(version: version, things: chosen, note: text)
                            }) {
                                made = deployment
                                await app.loadDeployments()
                            }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(things.isEmpty || change.busy)
                }
            }
        }
        .padding(24)
        .frame(width: 520, height: 520)
        .changeSheets(change)
    }
}

/// Every deployment, newest first.
struct DeploymentsPage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession

    var body: some View {
        let devices = app.deviceList ?? []
        Group {
            if let deployments = app.deployments.value {
                if deployments.isEmpty {
                    PageState(kind: .empty, text: "No deployment yet. Deploy a release from its page.")
                } else {
                    List(deployments) { deployment in
                        NavigationLink(value: Route.deployment(deployment.id)) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 8) {
                                        VersionText(deployment.version ?? "unknown").font(.headline)
                                        Text(deployment.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                                    }
                                    Text(Words.countSentence(deployment.counts)).foregroundStyle(.secondary)
                                    Text("\(Words.nameOf(deployment.createdBy)) · \(Words.timeAgo(deployment.createdAt, now: Date()))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusLabel(Words.describeDeployment(deployment, devices: devices))
                            }
                            .padding(.vertical, 3)
                        }
                    }
                }
            } else if let error = app.deployments.error {
                PageState(kind: .failed, text: Words.plainMessage(error)) { session.refreshNow() }
            } else {
                PageState(kind: .loading, text: "Loading the deployments…")
            }
        }
        .refreshing(every: { app.deploymentsInterval > 0 ? app.deploymentsInterval : Words.idleRefresh }) { full in
            await app.refreshDeployments(full: full)
        }
        .pageToolbar("Deployments")
    }
}

/// One deployment: each board's part, step by step, and Cancel while it is open.
struct DeploymentPage: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var change = ChangeRunner()
    let id: String
    @State private var confirmingCancel = false

    var body: some View {
        let entry = app.deploymentDetails[id]
        Group {
            if let deployment = entry?.value {
                Form {
                    Section {
                        HStack {
                            VersionText(deployment.version ?? "unknown").font(.title2.weight(.semibold))
                            Spacer()
                            StatusLabel(Words.describeDeployment(deployment, devices: app.deviceList))
                        }
                        Text(Words.countSentence(deployment.counts)).foregroundStyle(.secondary)
                        FactRow("Made", "\(Words.nameOf(deployment.createdBy)) · \(Words.dateAndTime(deployment.createdAt))")
                        if !deployment.note.isEmpty { FactRow("Note", deployment.note) }
                        FactRow("Deployment", deployment.id, mono: true)
                    }
                    ForEach(deployment.executions) { execution in
                        let board = app.deviceList?.first { $0.thing == execution.thing }
                        let words = Words.describeExecution(execution, board: board, deployment: deployment.id,
                                                            version: deployment.version, unread: app.deviceList == nil)
                        Section {
                            HStack {
                                NavigationLink(value: Route.board(execution.thing)) {
                                    BoardTitle(thing: execution.thing, name: board?.name)
                                }
                                Spacer()
                                StatusLabel(words.tone, words.icon, words.said ?? words.title)
                            }
                            Text(words.text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            if let progress = words.progress { ProgressView(value: Double(progress), total: 100) }
                            HStack(spacing: 10) {
                                ForEach(Array(words.steps.enumerated()), id: \.offset) { _, step in
                                    StepDot(step: step)
                                }
                            }
                            if let next = words.next { Label(next, systemImage: "lightbulb").foregroundStyle(.secondary) }
                        }
                    }
                    if let error = change.error {
                        Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                    }
                }
                .formStyle(.grouped)
                .toolbar {
                    if app.canWrite && Words.isUnfinished(deployment.status) {
                        ToolbarItem(placement: .primaryAction) {
                            Button(role: .destructive) { confirmingCancel = true } label: {
                                Label("Cancel Deployment", systemImage: "stop.circle")
                            }
                        }
                    }
                }
                .confirmationDialog("Cancel this deployment?", isPresented: $confirmingCancel) {
                    Button("Cancel the boards that have not started", role: .destructive) { cancel(force: false) }
                    Button("Also stop the boards that are downloading", role: .destructive) { cancel(force: true) }
                } message: {
                    Text("A board that has started writing keeps going unless it is stopped too. A board that restarted into the new image keeps it.")
                }
            } else if let error = entry?.error {
                PageState(kind: .failed, text: Words.plainMessage(error)) { Task { await app.refreshDeployment(id, full: true) } }
            } else {
                PageState(kind: .loading, text: "Loading the deployment…")
            }
        }
        .changeSheets(change)
        .refreshing(every: {
            guard let deployment = app.deploymentDetails[id]?.value else { return Words.idleRefresh }
            let interval = Words.pollInterval(deployment.executions.map(Words.executionActivity))
            return interval > 0 ? interval : Words.idleRefresh
        }) { full in
            await app.refreshDeployment(id, full: full)
        }
        .pageToolbar("Deployment", subtitle: id)
    }

    private func cancel(force: Bool) {
        Task {
            if let result = await change.run(app, refusal: "Not cancelled.", { api in try await api.cancel(deployment: id, force: force) }) {
                let started = result.executions.filter { !Words.isUnfinished($0.status) }.count
                app.say(Words.cancelNotice(force: force, withdrawn: true, started: started))
                await app.refreshDeployment(id, full: true)
            }
        }
    }
}

/// One step of an update, as the console's step indicator.
struct StepDot: View {
    let step: Step

    var body: some View {
        let (symbol, color): (String, Color) = {
            switch step.state {
            case .done: return ("checkmark.circle.fill", .green)
            case .current: return ("circle.dotted", .blue)
            case .failed, .stopped: return ("xmark.circle.fill", .red)
            case .skipped, .upcoming, .unknown: return ("circle", .secondary)
            }
        }()
        Label(step.label, systemImage: symbol)
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(color)
            .help("\(step.label): \(step.stateWord)")
    }
}

// MARK: Activity

/// The activity log: who did what, newest first.
struct ActivityPage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession

    var body: some View {
        Group {
            if let page = app.audit.value {
                if page.entries.isEmpty {
                    PageState(kind: .empty, text: "Nothing has been done yet.")
                } else {
                    List(page.entries) { entry in
                        ActivityRow(entry: entry, details: true)
                    }
                }
            } else if let error = app.audit.error {
                PageState(kind: .failed, text: Words.plainMessage(error)) { session.refreshNow() }
            } else {
                PageState(kind: .loading, text: "Loading the activity…")
            }
        }
        .refreshing(every: { Words.idleRefresh }) { _ in
            async let audit: Void = app.loadAudit()
            async let devices: Void = app.devices.value == nil ? app.loadDevices() : ()
            _ = await (audit, devices)
        }
        .pageToolbar("Activity")
    }
}

struct ActivityRow: View {
    @EnvironmentObject private var app: AppModel
    let entry: AuditEntry
    var details = false

    var body: some View {
        let words = Words.describeAudit(entry)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: Icon.symbol(words.icon))
                .foregroundStyle(words.outcome?.tone.color ?? .secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(Words.auditSentence(entry, devices: app.deviceList ?? [])).lineLimit(details ? 4 : 2)
                if let outcome = words.outcome {
                    Text(outcome.label).font(.caption.weight(.semibold)).foregroundStyle(outcome.tone.color)
                }
                if details, !words.facts.isEmpty {
                    Text(words.facts.map { $0.words ?? "\($0.label)\($0.phrase ? "" : ":") \($0.value)" }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Text(Words.timeAgo(entry.at, now: Date())).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: Help

/// The Help topics both phone apps read (apps/shared/help.json): sections in a list, a topic beside it.
struct HelpPage: View {
    var selected: String? = nil
    @State private var book: HelpBook?
    @State private var topic: String?

    var body: some View {
        HSplitView {
            List(selection: $topic) {
                ForEach(book?.sections ?? [], id: \.title) { section in
                    Section(section.title) {
                        ForEach(section.topics, id: \.self) { id in
                            Text(book?.topic(id)?.title ?? id).tag(id as String?)
                        }
                    }
                }
            }
            .frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
            ScrollView {
                if let topic, let shown = book?.topic(topic) {
                    HelpTopicView(topic: shown, book: book) { self.topic = $0 }
                        .padding(24)
                        .frame(maxWidth: 640, alignment: .leading)
                } else {
                    PageState(kind: .empty, text: "Choose a topic.")
                }
            }
            .frame(minWidth: 360, maxWidth: .infinity)
        }
        .task {
            book = try? HelpBook.load(from: .main)
            topic = selected ?? book?.sections.first?.topics.first
        }
        .navigationTitle("Help")
    }
}

struct HelpTopicView: View {
    let topic: HelpBook.Topic
    let book: HelpBook?
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(topic.title).font(.title.weight(.semibold))
            Text(topic.summary).font(.title3).foregroundStyle(.secondary)
            ForEach(Array(topic.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let text): Text(text).font(.headline).padding(.top, 6)
                case .text(let text): Text(text)
                case .note(let text): Label(text, systemImage: "info.circle").foregroundStyle(.secondary)
                case .steps(let items):
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in Text("\(index + 1). \(item)") }
                case .list(let items):
                    ForEach(items, id: \.self) { Text("• \($0)") }
                case .rows(let rows):
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        LabeledContent(row.label) { Text(row.text) }
                    }
                case .see(let ids):
                    HStack {
                        Text("See also").foregroundStyle(.secondary)
                        ForEach(ids, id: \.self) { id in
                            Button(book?.topic(id)?.title ?? id) { open(id) }.buttonStyle(.link)
                        }
                    }
                case .links(let links):
                    ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                        Link(link.title, destination: link.url)
                    }
                }
            }
        }
        .textSelection(.enabled)
    }
}
