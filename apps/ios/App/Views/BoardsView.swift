import CraniumKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Every board, as it last reported.
struct BoardsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        ListScreen {
            if StaleNote.shows(loadedAt: app.devices.loadedAt, error: app.devices.error, every: app.fleetInterval) {
                Section {
                    StaleNote(loadedAt: app.devices.loadedAt, error: app.devices.error, every: app.fleetInterval) {
                        Task { await app.refreshDevices(full: true) }
                    }
                }
            }
            if let devices = app.deviceList {
                if devices.isEmpty {
                    Section {
                        NavigationLink(value: Route.help("trouble-offline")) {
                            StateRow(kind: .empty, text: "No boards are registered yet.")
                        }
                    }
                } else {
                    let counted = Words.boardsCounted(devices)
                    Section {
                        ForEach(devices) { device in
                            NavigationLink(value: Route.board(device.thing)) { BoardRow(device: device) }
                        }
                    } header: {
                        Text("\(counted.online) of \(devices.count) online")
                    }
                }
            } else if app.devices.error == nil {
                Section { StateRow(kind: .loading, text: "Loading boards…") }
            }
        }
        .poll(every: { app.fleetInterval }) { full in await app.refreshDevices(full: full) }
        .helpButton("board-states")
        .screenTitle("Boards")
    }
}

/// A board in a list: who, and what it runs or is doing.
struct BoardRow: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        let update = Words.describeUpdate(device)
        let working = device.ota != nil && device.ota?.state != "idle"
        HStack(alignment: .center, spacing: 12) {
            Circle()
                .fill(Words.isUp(device) ? theme.good : theme.lineStrong)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            BoardLabel(device)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if let fw = device.fw {
                    VersionText(fw.version).foregroundStyle(theme.ink2)
                }
                if working {
                    Text(update.progress.map { "\(update.title) · \($0)%" } ?? update.title)
                        .font(.caption).foregroundStyle(theme.tone(update.tone)).lineLimit(1)
                } else if !device.online {
                    Text(device.lastSeen == nil ? "Never connected" : "Offline · \(Words.timeAgo(device.lastSeen, now: Date()))")
                        .font(.caption).foregroundStyle(theme.ink3)
                } else if device.fw?.confirmed == false {
                    Text("On trial").font(.caption).foregroundStyle(theme.warn)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A board's page: who it is and what it runs at the top, the update while there is one, then
/// sections; the long parts are a tap away.
/// A board's newest lines of its own log (firmware 1.12.0 and later), and the way to all of them
/// under Events. Read every 30 s while the page is open.
@MainActor
final class BoardLogModel: ObservableObject {
    @Published private(set) var lines: [BoardLine]?
    @Published private(set) var more = false
    @Published private(set) var error: Error?

    func refresh(_ app: AppModel, thing: String) async {
        guard let api = app.api else { return }
        let to = Date()
        do {
            let page = try await api.boardLog(from: to.addingTimeInterval(-86_400), to: to, thing: thing, limit: BoardLog.recentCount)
            lines = page.lines
            more = page.cursor != nil
            error = nil
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }
}

struct BoardLogSection: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model = BoardLogModel()
    let thing: String

    var body: some View {
        Section {
            if let lines = model.lines {
                if lines.isEmpty {
                    Text(BoardLog.recentEmpty).font(.footnote).foregroundStyle(theme.ink3)
                } else {
                    ForEach(lines) { line in
                        BoardLineRow(line: line, board: app.device(thing), showsBoard: false)
                    }
                }
            } else if let error = model.error {
                StateRow(kind: .failed, text: "\(BoardLog.failed) \(Words.plainMessage(error))")
            } else {
                StateRow(kind: .loading, text: "Loading its lines…")
            }
            // The one row that is always there carries the reading, once for the section.
            NavigationLink(value: Route.boardLog(thing)) { Text(BoardLog.allLines) }
                .poll(every: { 30 }) { _ in await model.refresh(app, thing: thing) }
        } header: {
            Text(BoardLog.recentTitle)
        }
        .id(Self.anchor)
    }

    static let anchor = "latest-lines"
}

struct BoardView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let thing: String

    var body: some View {
        ScrollViewReader { proxy in
            page
                #if DEBUG
                // Demo mode: `-CraniumScroll lines` brings the latest lines into view, for a screenshot.
                .onChange(of: app.deviceDetails[thing]?.loadedAt) { _ in
                    guard Demo.isOn, UserDefaults.standard.string(forKey: "CraniumScroll") == "lines" else { return }
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 800_000_000)
                        proxy.scrollTo(BoardLogSection.anchor, anchor: UnitPoint(x: 0.5, y: 0.12))
                    }
                }
                #endif
        }
    }

    private var page: some View {
        let resource = app.deviceDetails[thing] ?? Loadable()
        return ListScreen {
            if let detail = resource.value {
                content(detail, resource: resource)
            } else if let error = resource.error as? APIError, error.status == 404 {
                Section { StateRow(kind: .empty, text: "No board with this name is registered.") }
            } else if let error = resource.error {
                Section { StateRow(kind: .failed, text: Words.plainMessage(error), action: ("Retry", { Task { await app.loadDevice(thing) } })) }
            } else {
                Section { StateRow(kind: .loading, text: "Loading the board…") }
            }
        }
        .poll(every: { Telemetry.diagnosticsRefresh }) { full in
            await app.refreshBoard(thing, full: full)
            if app.firmware.due(full) { await app.loadFirmware() }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if app.canWrite {
                        Button { app.deployingThings = [thing]; app.deploying = "" } label: {
                            Label("Deploy a release", systemImage: "paperplane")
                        }
                    }
                    Button { app.openBluetooth(release: nil) } label: {
                        Label("Update over Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                    }
                    CopyMenuItem(value: thing, label: "Copy the thing name")
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel("More")
                }
            }
        }
        .helpButton("boards-and-diagnostics")
        .screenTitle(app.name(of: thing) ?? Words.shortThing(thing), large: false)
    }

    @ViewBuilder
    private func content(_ detail: DeviceDetail, resource: Loadable<DeviceDetail>) -> some View {
        let device = detail.device
        Section {
            VStack(alignment: .leading, spacing: 8) {
                if let name = device.name {
                    Text(verbatim: name).font(.title2.weight(.bold))
                }
                Text(verbatim: device.thing).font(Typeface.thing).foregroundStyle(device.name == nil ? theme.ink : theme.ink3)
                    .textSelection(.enabled)
                HStack(spacing: 10) {
                    OnlinePill(device: device)
                    if let fw = device.fw {
                        VersionText(fw.version)
                        Text(fw.confirmed ? "Confirmed" : "On trial").font(.caption.weight(.semibold))
                            .foregroundStyle(fw.confirmed ? theme.good : theme.warn)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        if StaleNote.shows(loadedAt: resource.loadedAt, error: resource.error, every: Telemetry.diagnosticsRefresh) {
            Section {
                StaleNote(loadedAt: resource.loadedAt, error: resource.error, every: Telemetry.diagnosticsRefresh) {
                    Task { await app.loadDevice(thing) }
                }
            }
        }
        if let ota = device.ota, ota.state != "idle" {
            UpdateCard(device: device)
        }
        firmware(device)
        diagnostics(detail)
        BoardLogSection(thing: device.thing)
        bluetooth(device)
        history(detail)
    }

    @ViewBuilder
    private func firmware(_ device: Device) -> some View {
        Section("Firmware & slots") {
            if let fw = device.fw {
                HStack {
                    Text("Runs")
                    Spacer()
                    VersionText(fw.version).foregroundStyle(theme.ink2)
                }
                if Words.isUnregistered(fw.version, releases: app.releases) {
                    StatusText(.warn, "alert", Words.notRegistered)
                }
                if (app.releases ?? []).contains(where: { $0.version == fw.version && !$0.isActive }) {
                    StatusText(.bad, "ban", "Runs a revoked release")
                }
            } else {
                ValueRow("Runs", "Not reported")
            }
            if device.ota?.state ?? "idle" == "idle" {
                let last = Words.describeUpdate(device)
                HStack {
                    Text("Last update")
                    Spacer()
                    StatusText(last)
                }
            }
            NavigationLink("Flash slots", value: Route.boardSlots(device.thing))
        }
    }

    @ViewBuilder
    private func diagnostics(_ detail: DeviceDetail) -> some View {
        let device = detail.device
        Section("Diagnostics") {
            HStack {
                Text("Heartbeat")
                Spacer()
                if device.lastSeen != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(Telemetry.heartbeatAge(device.lastSeen, now: context.date)).monospacedDigit().foregroundStyle(theme.ink2)
                    }
                } else {
                    Text("None yet").foregroundStyle(theme.ink3)
                }
            }
            HStack {
                Text("Uptime")
                Spacer()
                if device.uptime != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(Words.duration(Double(Telemetry.uptimeNow(device, now: context.date) ?? 0)))
                            .monospacedDigit().foregroundStyle(theme.ink2)
                    }
                } else {
                    Text("Not reported").foregroundStyle(theme.ink3)
                }
            }
            HStack {
                Text("Signal")
                Spacer()
                if let quality = Words.signalQuality(device.rssi), let rssi = device.rssi {
                    SignalBars(bars: quality.bars, old: !device.online)
                    Text("\(quality.label) · \(Words.signed(rssi)) dBm").foregroundStyle(theme.ink2)
                } else {
                    Text("Not reported").foregroundStyle(theme.ink3)
                }
            }
            if let diag = device.diag {
                ValueRow("Wi-Fi", diag.channel.map { "Channel \($0)" } ?? "Not associated")
                if let heap = diag.heap, let words = Telemetry.heapWords(heap) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Memory")
                            Spacer()
                            Text(words.text).foregroundStyle(words.tone == .bad ? theme.bad : theme.ink2)
                        }
                        ProgressView(value: Double(words.used), total: 100)
                            .tint(theme.bar(words.tone == .live ? .live : words.tone))
                            .accessibilityLabel("Memory in use")
                            .accessibilityValue("\(words.used) percent")
                    }
                }
            }
            if let stuck = Telemetry.stuckWords(device.stuck) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Stuck restarts")
                    Spacer()
                    Text(stuck.badge ?? "None").foregroundStyle(stuck.tone == .warn ? theme.warn : theme.ink2)
                }
            }
            NavigationLink(value: Route.boardCharts(device.thing)) { Text("Signal and memory, 24 h") }
            NavigationLink(value: Route.boardBoots(device.thing)) {
                ValueRow("Last boots", device.diary.map { "\($0.boots) in all" } ?? "")
            }
            NavigationLink(value: Route.boardCertificates(device.thing)) {
                ValueRow("Certificates", "\(detail.certificates.count)")
            }
        }
    }

    @ViewBuilder
    private func bluetooth(_ device: Device) -> some View {
        Section("Bluetooth") {
            if let model = app.bluetooth {
                FollowedBluetoothUpdate(model: model, device: device)
            } else {
                LastBluetoothUpdate(record: nil, device: device)
            }
            if let record = device.bt {
                HStack {
                    Text("Last update")
                    Spacer()
                    Text(verbatim: "\(record.from) → \(record.to)").font(Typeface.version).foregroundStyle(theme.ink2)
                }
                HStack {
                    Text("Result")
                    Spacer()
                    let words = Telemetry.bluetoothResults[record.result] ?? record.result
                    Text(words).foregroundStyle(Telemetry.badBluetoothResults.contains(record.result) ? theme.warn : theme.ink2)
                }
                ValueRow("Proof", Telemetry.proofWords[record.proof] ?? record.proof)
            } else {
                Text("No update over Bluetooth recorded").foregroundStyle(theme.ink3)
            }
        }
    }

    @ViewBuilder
    private func history(_ detail: DeviceDetail) -> some View {
        Section("History") {
            // Every kind of update, from GET /api/updates; from an older console, or until it is read,
            // the deployments it was offered, as before.
            if let page = app.boardUpdates[detail.device.thing]?.value, !page.updates.isEmpty {
                ForEach(page.updates.prefix(3)) { update in
                    UpdateLine(update: update)
                }
                if page.updates.count > 3 || page.cursor != nil {
                    NavigationLink(value: Route.boardHistory(detail.device.thing)) {
                        Text("All updates").foregroundStyle(theme.accent)
                    }
                }
            } else if detail.executions.isEmpty {
                Text("Not offered an update yet").foregroundStyle(theme.ink3)
            } else {
                ForEach(detail.executions.prefix(3)) { execution in
                    HistoryLine(execution: execution, last: nil)
                }
                if detail.executions.count > 3 || detail.olderExecutions > 0 {
                    NavigationLink(value: Route.boardHistory(detail.device.thing)) {
                        Text("All updates").foregroundStyle(theme.accent)
                    }
                }
            }
        }
    }
}

/// The last update this phone followed on the board, with the phone's record of it as it changes.
private struct FollowedBluetoothUpdate: View {
    @ObservedObject var model: BluetoothModel
    let device: Device

    var body: some View {
        LastBluetoothUpdate(record: model.outcomes[device.thing], device: device)
    }
}

/// "1.13.0+0 over Bluetooth at 12:14, kept": what this phone followed, else the board's own record of
/// its last update over Bluetooth (`UpdateWatch.summary`).
private struct LastBluetoothUpdate: View {
    let record: UpdateWatch.Record?
    let device: Device

    var body: some View {
        if let text = UpdateWatch.summary(record: record, bt: device.bt, time: { $0.formatted(date: .omitted, time: .shortened) }) {
            Text(text).font(.subheadline)
        }
    }
}

/// The update a board is in the middle of, while it lasts.
struct UpdateCard: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        let update = Words.describeUpdate(device)
        Section("Update") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    StatusText(update.tone, update.icon, update.title).font(.headline)
                    Spacer()
                    if let progress = update.progress {
                        Text("\(progress)%").font(.title3.weight(.semibold)).monospacedDigit()
                    }
                }
                if let progress = update.progress { ProgressBar(percent: progress, label: "Download on \(device.label)") }
                if !update.text.isEmpty {
                    Text(update.text).font(.footnote).foregroundStyle(theme.ink2).lineLimit(2)
                }
                if update.tone == .act { ButtonKeys() }
            }
            .padding(.vertical, 4)
            if let id = update.deployment {
                NavigationLink("Open the deployment", value: Route.deployment(id))
            }
        }
    }
}

/// One update of a board (`GET /api/updates`): the version it installs and how it ended, and under it
/// what ran before, how it came and when. A deployment's row opens the deployment; any other stays
/// here, on the board's own screens.
struct UpdateLine: View {
    @Environment(\.theme) private var theme
    let update: BoardUpdate

    var body: some View {
        let row = HStack {
            VStack(alignment: .leading, spacing: 2) {
                if update.to != nil {
                    VersionText(Words.updateTitle(update))
                } else {
                    Text(Words.updateTitle(update))
                }
                Text(Words.updateDetail(update, now: Date()))
                    .font(.footnote).foregroundStyle(theme.ink3)
            }
            Spacer()
            StatusText(Words.updateOutcome(update.outcome))
        }
        if let id = update.deploymentLink {
            NavigationLink(value: Route.deployment(id)) { row }
        } else {
            row
        }
    }
}

/// One update a board was offered.
struct HistoryLine: View {
    @Environment(\.theme) private var theme
    let execution: ExecutionSummary
    let last: String?

    var body: some View {
        let version = execution.version ?? DeploymentId.version(of: execution.deployment)
        let look = Words.describeHistory(execution.status, last: last)
        let row = HStack {
            VStack(alignment: .leading, spacing: 2) {
                VersionText(version ?? execution.deployment)
                Text(DeploymentId.isValid(execution.deployment) ? "Offered \(Words.timeAgo(execution.queuedAt, now: Date()))"
                     : "Started outside this console")
                    .font(.footnote).foregroundStyle(theme.ink3)
            }
            Spacer()
            StatusText(look)
        }
        if DeploymentId.isValid(execution.deployment) {
            NavigationLink(value: Route.deployment(execution.deployment)) { row }
        } else {
            row
        }
    }
}

/// A sub-screen of a board, reading its record if it is not there yet.
private struct BoardSubscreen<Content: View>: View {
    @EnvironmentObject private var app: AppModel
    let thing: String
    let title: String
    let content: (DeviceDetail) -> Content

    init(thing: String, title: String, @ViewBuilder content: @escaping (DeviceDetail) -> Content) {
        self.thing = thing
        self.title = title
        self.content = content
    }

    var body: some View {
        ListScreen {
            if let detail = app.deviceDetails[thing]?.value {
                content(detail)
            } else {
                Section { StateRow(kind: .loading, text: "Loading…") }
            }
        }
        .task { if app.deviceDetails[thing]?.value == nil { await app.loadDevice(thing) } }
        .screenTitle(title, large: false)
    }
}

/// A board's older updates, a page at a time, after the first page that AppModel keeps.
@MainActor
final class OlderUpdates: ObservableObject {
    @Published private(set) var updates: [BoardUpdate] = []
    @Published private(set) var next: String?
    @Published private(set) var read = false
    @Published private(set) var loading = false
    @Published private(set) var error: Error?

    /// Where the next page starts: after the pages read here, else after the first.
    func cursor(after first: UpdatesPage) -> String? {
        read ? next : first.cursor
    }

    /// The first page, then the older ones, each update once.
    func rows(_ first: UpdatesPage) -> [BoardUpdate] {
        let shown = Set(first.updates.map(\.id))
        return first.updates + updates.filter { !shown.contains($0.id) }
    }

    func loadMore(_ app: AppModel, thing: String, after first: UpdatesPage) async {
        guard let api = app.api, let cursor = cursor(after: first), !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            guard let page = try await api.updates(thing: thing, cursor: cursor) else { return }
            var seen = Set(updates.map(\.id))
            updates += page.updates.filter { seen.insert($0.id).inserted }
            next = page.cursor
            read = true
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }
}

/// Every update of a board: from GET /api/updates, else, from an older console or until that is
/// read, the deployments it was offered, as before.
struct BoardHistoryView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var older = OlderUpdates()
    let thing: String

    var body: some View {
        ListScreen {
            if let first = app.boardUpdates[thing]?.value, !first.updates.isEmpty {
                updates(first)
            } else if let detail = app.deviceDetails[thing]?.value {
                executions(detail)
            } else {
                Section { StateRow(kind: .loading, text: "Loading…") }
            }
        }
        .poll(every: { 30 }) { full in await app.refreshBoard(thing, full: full) }
        .screenTitle("Updates", large: false)
    }

    @ViewBuilder
    private func updates(_ first: UpdatesPage) -> some View {
        Section {
            ForEach(older.rows(first)) { update in
                UpdateLine(update: update)
            }
        }
        if older.cursor(after: first) != nil || older.error != nil {
            Section {
                if older.cursor(after: first) != nil {
                    Button {
                        Task { await older.loadMore(app, thing: thing, after: first) }
                    } label: {
                        HStack {
                            Text(older.loading ? "Loading…" : "Load more")
                            if older.loading { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(older.loading)
                }
                if let error = older.error {
                    StateRow(kind: .failed, text: Words.plainMessage(error))
                }
            }
        }
    }

    @ViewBuilder
    private func executions(_ detail: DeviceDetail) -> some View {
        let ended = detail.executions.filter { !Words.isUnfinished($0.status) }
            .max { (ConsoleTime.date($0.lastUpdatedAt) ?? .distantPast) < (ConsoleTime.date($1.lastUpdatedAt) ?? .distantPast) }
        Section {
            ForEach(detail.executions) { execution in
                HistoryLine(execution: execution, last: execution.deployment == ended?.deployment ? detail.device.ota?.last : nil)
            }
        } footer: {
            if detail.olderExecutions > 0 {
                Text("\(Words.plural(detail.olderExecutions, "older update is", "older updates are")) not listed.")
            }
        }
    }
}

struct BoardBootsView: View {
    @Environment(\.theme) private var theme
    let thing: String

    var body: some View {
        BoardSubscreen(thing: thing, title: "Last boots") { detail in
            let rows = Telemetry.diaryRows(detail.device.diary)
            if rows.isEmpty {
                Section { Text(detail.device.diary == nil ? Telemetry.diaryMissing(detail.device) : "The diary is empty.").foregroundStyle(theme.ink3) }
            } else {
                Section {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("Boot \(row.boot)\(row.running ? " (running)" : "")").font(.body.weight(.semibold))
                                Spacer()
                                VersionText(row.version).foregroundStyle(theme.ink2)
                            }
                            Text("Before it: \(row.before)").font(.subheadline)
                                .foregroundStyle(row.bad ? theme.warn : theme.ink2)
                            Text(row.running ? "\(row.reached) so far" : row.reached).font(.footnote).foregroundStyle(theme.ink3)
                        }
                        .padding(.vertical, 2)
                    }
                } footer: {
                    Text("Why each boot before ended, from the chip's own record of its reset.")
                }
            }
        }
    }
}

struct BoardCertificatesView: View {
    @Environment(\.theme) private var theme
    let thing: String

    var body: some View {
        BoardSubscreen(thing: thing, title: "Certificates") { detail in
            Section {
                if detail.certificates.isEmpty {
                    Text("None attached: this board cannot connect.").foregroundStyle(theme.ink3)
                }
                ForEach(detail.certificates, id: \.self) { id in
                    Text(verbatim: "\(id)…").font(Typeface.hash)
                }
            } footer: {
                Text("The start of each certificate ID. Its private key never leaves the board.")
            }
        }
    }
}

struct BoardChartsView: View {
    @EnvironmentObject private var app: AppModel
    let thing: String
    @State private var samples = Loadable<Samples>()
    @State private var hours = 24

    var body: some View {
        ListScreen {
            Section {
                Picker("Range", selection: $hours) {
                    Text("1 h").tag(1)
                    Text("24 h").tag(24)
                    Text("7 d").tag(168)
                }
                .pickerStyle(.segmented)
            }
            if let value = samples.value {
                Section { SignalChart(samples: value).padding(.vertical, 6) }
                if let device = app.deviceDetails[thing]?.value.map(\.device) ?? app.device(thing) {
                    Section {
                        if device.diag != nil || value.samples.contains(where: { $0.heapFree != nil }) {
                            HeapChart(samples: value, device: device).padding(.vertical, 6)
                        } else {
                            Text(Telemetry.diagMissing(device)).font(.footnote)
                        }
                    }
                }
            } else if let error = samples.error {
                Section { StateRow(kind: .failed, text: Words.plainMessage(error), action: ("Retry", { Task { await load() } })) }
            } else {
                Section { StateRow(kind: .loading, text: "Loading the readings…") }
            }
        }
        .poll(every: { Telemetry.samplesRefresh }) { _ in await load() }
        .onChange(of: hours) { _ in Task { await load() } }
        .screenTitle("Signal and memory", large: false)
    }

    private func load() async {
        guard let api = app.api else { return }
        do {
            samples = Loadable(value: try await api.samples(thing: thing, hours: hours), loadedAt: Date())
        } catch {
            samples.error = error
            await app.handle(error)
        }
    }
}

/// What each slot of the board's flash holds, worked out from what it last reported.
struct BoardSlotsView: View {
    @Environment(\.theme) private var theme
    let thing: String

    var body: some View {
        BoardSubscreen(thing: thing, title: "Flash slots") { detail in
            let slots = Self.slots(detail.device)
            Section {
                slot("Bootloader", "MCUboot", "Checks every signature")
                slot("Primary slot", slots.primary.version, slots.primary.state)
                slot("Secondary slot", slots.secondary.version, slots.secondary.state)
            } footer: {
                Text(detail.device.ota != nil ? "Worked out from the step the board last reported."
                     : "The board reports what it runs, and nothing about its other slot.")
            }
        }
    }

    private func slot(_ name: String, _ version: String?, _ state: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(name)
                Spacer()
                if let version { VersionText(version).foregroundStyle(theme.ink2) }
            }
            Text(state).font(.footnote).foregroundStyle(theme.ink3)
        }
        .accessibilityElement(children: .combine)
    }

    static func slots(_ device: Device) -> (primary: (version: String?, state: String), secondary: (version: String?, state: String)) {
        let online = device.online
        let fw = device.fw
        let running: (version: String?, state: String) = (fw?.version, fw?.confirmed == true
            ? (online ? "Runs from here, confirmed" : "Ran from here, confirmed")
            : fw != nil ? (online ? "Runs on trial" : "Was on trial") : "Nothing reported")
        let target = DeploymentId.version(of: device.ota?.job)
        guard let ota = device.ota, ota.state != "idle" else { return (running, (nil, "No update under way")) }
        switch ota.state {
        case "awaiting_user":
            return (running, (nil, online ? "Nothing is written until Button 1 is pressed" : Words.describeUpdate(device).title))
        case "testing":
            return ((fw?.version, online ? "Runs on trial" : "Was on trial"), ("Previous firmware", "Kept to fall back on"))
        case "bluetooth":
            return (running, (nil, online ? "A phone may be sending an image over Bluetooth" : Words.describeUpdate(device).title))
        case "downloading":
            return (running, (target, online ? "Receiving the image" : Words.describeUpdate(device).title))
        default:
            return (running, (target, online ? "Written, being checked" : Words.describeUpdate(device).title))
        }
    }
}

/// "Copy …" in a menu.
struct CopyMenuItem: View {
    @EnvironmentObject private var app: AppModel
    let value: String
    let label: String

    var body: some View {
        Button {
            #if canImport(UIKit)
            UIPasteboard.general.string = value
            #endif
            app.say("Copied.")
        } label: {
            Label(label, systemImage: "doc.on.doc")
        }
    }
}
