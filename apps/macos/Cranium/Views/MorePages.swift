import Charts
import CraniumKit
import SwiftUI

// MARK: A board's tabs

/// The parts of a board's page, as the iPhone's board screen and its sub-screens have them.
enum BoardTab: String, CaseIterable, Identifiable {
    case board, events, log, boots, charts, slots

    var id: String { rawValue }

    var title: String {
        switch self {
        case .board: return "Board"
        case .events: return "Events"
        case .log: return "Board log"
        case .boots: return "Boots"
        case .charts: return "Signal and memory"
        case .slots: return "Flash slots"
        }
    }
}

/// What the boards did and printed over a span: the fleet's Events page, or one board's tab.
@MainActor
final class EventsReader: ObservableObject {
    @Published var preset = "24h"
    @Published var hidden: Set<String> = []
    @Published private(set) var markers: [Telemetry.Marker]?
    @Published private(set) var lines: [BoardLine]?
    @Published private(set) var error: Error?
    @Published private(set) var loadingMore = false
    private var cursor: String?
    private var linesCursor: String?
    private var span: (from: Date, to: Date) = (Date(), Date())
    let thing: String

    init(thing: String = "") {
        self.thing = thing
    }

    var hasMore: Bool { cursor != nil }
    var hasMoreLines: Bool { linesCursor != nil }

    func refresh(_ app: AppModel) async {
        guard let api = app.api else { return }
        let range = Telemetry.span(.preset(preset), now: Date())
        span = (range.from, range.to)
        let kinds = BoardEvent.kinds.filter { !hidden.contains($0) }
        let wanted = kinds.count < BoardEvent.kinds.count ? kinds : nil
        let thing = self.thing
        do {
            async let events = api.events(from: range.from, to: range.to, thing: thing, kinds: wanted)
            async let log = api.boardLog(from: range.from, to: range.to, thing: thing)
            let (page, logPage) = try await (events, log)
            markers = page.events.compactMap(Telemetry.marker)
            cursor = page.cursor
            lines = logPage.lines
            linesCursor = logPage.cursor
            error = nil
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }

    func more(_ app: AppModel) async {
        guard let api = app.api, let cursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let kinds = BoardEvent.kinds.filter { !hidden.contains($0) }
        if let next = try? await api.events(from: span.from, to: span.to, thing: thing,
                                            kinds: kinds.count < BoardEvent.kinds.count ? kinds : nil, cursor: cursor) {
            markers = (markers ?? []) + next.events.compactMap(Telemetry.marker)
            self.cursor = next.cursor
        }
    }

    func moreLines(_ app: AppModel) async {
        guard let api = app.api, let linesCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let next = try? await api.boardLog(from: span.from, to: span.to, thing: thing, cursor: linesCursor) {
            lines = (lines ?? []) + next.lines
            self.linesCursor = next.cursor
        }
    }
}

/// The range and kind controls of an events list.
private struct EventsControls: View {
    @ObservedObject var reader: EventsReader
    let changed: () -> Void

    var body: some View {
        HStack {
            Picker("Range", selection: $reader.preset) {
                ForEach(Telemetry.presets) { Text($0.label).tag($0.id) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            Spacer()
            Menu {
                ForEach(BoardEvent.kinds, id: \.self) { kind in
                    Toggle(kind.capitalized, isOn: Binding(get: { !reader.hidden.contains(kind) }, set: { shown in
                        if shown { reader.hidden.remove(kind) } else { reader.hidden.insert(kind) }
                    }))
                }
            } label: {
                Label("Kinds", systemImage: "line.3.horizontal.decrease.circle")
            }
            .fixedSize()
        }
        .onChange(of: reader.preset) { _ in changed() }
        .onChange(of: reader.hidden) { _ in changed() }
    }
}

struct MarkerRow: View {
    @EnvironmentObject private var app: AppModel
    let marker: Telemetry.Marker
    var showsBoard = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(marker.warn ? .orange : .secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(marker.text)
                if showsBoard, let thing = marker.thing {
                    Text(app.name(of: thing) ?? Words.shortThing(thing)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(marker.at.formatted(.dateTime.month(.abbreviated).day().hour().minute().second()))
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }

    private var symbol: String {
        switch marker.kind {
        case "connection": return "wifi"
        case "firmware": return "cpu"
        case "update": return "arrow.down.to.line"
        case "restart": return "arrow.clockwise"
        case "bluetooth": return "dot.radiowaves.left.and.right"
        case "health": return "waveform.path.ecg"
        default: return "circle"
        }
    }
}

struct LineRow: View {
    let line: BoardLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(line.tag).font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(line.level == "err" || line.level == "error" ? .red : (line.level == "wrn" || line.level == "warn" ? .orange : .secondary))
                .frame(width: 70, alignment: .leading)
            Text(line.text).font(.body.monospaced()).textSelection(.enabled)
            Spacer()
            Text(Words.timeOfDay(line.at)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}

/// The fleet's Events: every board's events and log over a span, with their kinds to choose.
struct EventsPage: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var reader = EventsReader()
    @State private var showing = "events"

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Show", selection: $showing) {
                    Text("Events").tag("events")
                    Text("Board log").tag("log")
                }
                .pickerStyle(.segmented)
                .fixedSize()
                EventsControls(reader: reader) { Task { await reader.refresh(app) } }
            }
            .padding(12)
            Divider()
            EventsList(reader: reader, showing: showing, showsBoard: true)
        }
        .refreshing(every: { Telemetry.eventsRefresh }) { _ in await reader.refresh(app) }
        .pageToolbar("Events", subtitle: Telemetry.presets.first { $0.id == reader.preset }?.name.capitalizedFirst)
    }
}

struct EventsList: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject var reader: EventsReader
    let showing: String
    let showsBoard: Bool

    var body: some View {
        if let error = reader.error, reader.markers == nil {
            PageState(kind: .failed, text: "Could not load the events. \(Words.plainMessage(error))") { Task { await reader.refresh(app) } }
        } else if showing == "events" {
            if let markers = reader.markers {
                if markers.isEmpty {
                    PageState(kind: .empty, text: "No event in this range.")
                } else {
                    List {
                        ForEach(markers) { MarkerRow(marker: $0, showsBoard: showsBoard) }
                        if reader.hasMore {
                            Button(reader.loadingMore ? "Loading…" : "Load More") { Task { await reader.more(app) } }
                                .disabled(reader.loadingMore)
                        }
                    }
                }
            } else {
                PageState(kind: .loading, text: "Loading the events…")
            }
        } else if let lines = reader.lines {
            if lines.isEmpty {
                PageState(kind: .empty, text: "No line in this range. A board prints to the cloud from firmware 1.12.0 on.")
            } else {
                List {
                    ForEach(lines, id: \.lineId) { LineRow(line: $0) }
                    if reader.hasMoreLines {
                        Button(reader.loadingMore ? "Loading…" : "Load More") { Task { await reader.moreLines(app) } }
                            .disabled(reader.loadingMore)
                    }
                }
            }
        } else {
            PageState(kind: .loading, text: "Loading the board log…")
        }
    }
}

/// A board's events or log, in its page.
struct BoardEventsTab: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var reader: EventsReader
    let showing: String

    init(thing: String, showing: String) {
        _reader = StateObject(wrappedValue: EventsReader(thing: thing))
        self.showing = showing
    }

    var body: some View {
        VStack(spacing: 0) {
            EventsControls(reader: reader) { Task { await reader.refresh(app) } }.padding(12)
            Divider()
            EventsList(reader: reader, showing: showing, showsBoard: false)
        }
        .refreshing(every: { Telemetry.eventsRefresh }, concerns: { $0.concerns(thing: reader.thing) }) { _ in
            await reader.refresh(app)
        }
    }
}

/// Why each boot before ended, from the chip's own record of its reset.
struct BootsTab: View {
    let device: Device

    var body: some View {
        let rows = Telemetry.diaryRows(device.diary)
        if rows.isEmpty {
            PageState(kind: .empty, text: device.diary == nil ? Telemetry.diaryMissing(device) : "The diary is empty.")
        } else {
            List(rows) { row in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("Boot \(row.boot)\(row.running ? " (running)" : "")").font(.headline)
                        Spacer()
                        VersionText(row.version).foregroundStyle(.secondary)
                    }
                    Text("Before it: \(row.before)").foregroundStyle(row.bad ? .orange : .primary)
                    Text(row.running ? "\(row.reached) so far" : row.reached).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 3)
            }
        }
    }
}

/// The board's signal and free memory over the last 24 hours (`GET /api/devices/<thing>/samples`).
struct ChartsTab: View {
    @EnvironmentObject private var app: AppModel
    let thing: String
    @State private var samples: Samples?
    @State private var error: Error?
    @State private var hours = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Span", selection: $hours) {
                Text("6 h").tag(6)
                Text("24 h").tag(24)
                Text("7 d").tag(168)
            }
            .pickerStyle(.segmented)
            .fixedSize()
            if let samples {
                let points = samples.samples.compactMap { sample -> (Date, Samples.Sample)? in
                    ConsoleTime.date(sample.at).map { ($0, sample) }
                }
                if points.isEmpty {
                    PageState(kind: .empty, text: "No reading in this span.")
                } else {
                    Text("Signal (dBm)").font(.headline)
                    Chart(points.filter { $0.1.rssi != nil }, id: \.0) { point in
                        LineMark(x: .value("Time", point.0), y: .value("dBm", point.1.rssi ?? 0))
                            .foregroundStyle(Color.accentColor)
                    }
                    .frame(minHeight: 160)
                    Text("Free memory (bytes)").font(.headline)
                    Chart(points.filter { $0.1.heapFree != nil }, id: \.0) { point in
                        LineMark(x: .value("Time", point.0), y: .value("Free", point.1.heapFree ?? 0))
                            .foregroundStyle(.blue)
                        if let least = point.1.heapLeast {
                            LineMark(x: .value("Time", point.0), y: .value("Least", least), series: .value("Series", "least"))
                                .foregroundStyle(.orange)
                        }
                    }
                    .frame(minHeight: 160)
                }
            } else if let error {
                PageState(kind: .failed, text: "Could not load the readings. \(Words.plainMessage(error))")
            } else {
                PageState(kind: .loading, text: "Loading the readings…")
            }
        }
        .padding(16)
        .task(id: hours) { await load() }
        .refreshing(every: { Telemetry.samplesRefresh }) { _ in await load() }
    }

    private func load() async {
        guard let api = app.api else { return }
        do {
            samples = try await api.samples(thing: thing, hours: hours)
            error = nil
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }
}

/// The board's flash: the bootloader, the slot it runs from, and the other slot.
struct SlotsTab: View {
    let device: Device

    var body: some View {
        let slots = Self.slots(device)
        Form {
            Section {
                slot("Bootloader", "MCUboot", "Checks every signature")
                slot("Primary slot", slots.primary.version, slots.primary.state)
                slot("Secondary slot", slots.secondary.version, slots.secondary.state)
            } footer: {
                Text(device.ota != nil ? "Worked out from the step the board last reported."
                     : "The board reports what it runs, and nothing about its other slot.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func slot(_ name: String, _ version: String?, _ state: String) -> some View {
        LabeledContent {
            VStack(alignment: .trailing, spacing: 2) {
                if let version { VersionText(version) }
                Text(state).font(.caption).foregroundStyle(.secondary)
            }
        } label: {
            Text(name)
        }
    }

    /// The iPhone's BoardSlotsView.slots, as it is.
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

// MARK: API tokens

/// Personal API tokens, for scripts: make one (it shows once), see them, revoke one.
struct TokensPage: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var change = ChangeRunner()
    @State private var list: TokenList?
    @State private var error: Error?
    @State private var making = false
    @State private var revoking: APIToken?

    var body: some View {
        Group {
            if let list {
                if list.tokens.isEmpty {
                    PageState(kind: .empty, text: "No token yet. A token lets a script use the console's API in your name, for up to \(TokenRules.mostDays) days.")
                } else {
                    Table(list.tokens) {
                        TableColumn("Name") { token in Text(token.name) }
                        TableColumn("Status") { token in
                            StatusLabel(token.status == "active" ? .good : .idle, token.status == "active" ? "check-circle" : "ban",
                                        token.status.capitalized)
                        }
                        TableColumn("Made") { token in Text(Words.dateAndTime(token.createdAt)).foregroundStyle(.secondary) }
                        TableColumn("Ends") { token in Text(Words.dateAndTime(token.expiresAt)).foregroundStyle(.secondary) }
                        TableColumn("") { token in
                            if token.status == "active" {
                                Button("Revoke…") { revoking = token }
                            }
                        }
                        .width(90)
                    }
                }
            } else if let error {
                PageState(kind: .failed, text: "Could not load the tokens. \(Words.plainMessage(error))") { Task { await load() } }
            } else {
                PageState(kind: .loading, text: "Loading the tokens…")
            }
        }
        .task { await load() }
        .changeSheets(change)
        .pageToolbar("API tokens", subtitle: list.map { "\($0.active) of \($0.limit) active" })
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { making = true } label: { Label("New Token", systemImage: "plus") }
                    .disabled(list.map { $0.active >= $0.limit } ?? true)
            }
        }
        .sheet(isPresented: $making) { NewTokenSheet(change: change) { Task { await load() } } }
        .confirmationDialog("Revoke \(revoking?.name ?? "the token")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })) {
            Button("Revoke", role: .destructive) {
                guard let id = revoking?.id else { return }
                Task {
                    if await change.run(app, refusal: "Not revoked.", { api in try await api.revokeToken(id: id) }) != nil {
                        app.say("The token is revoked.")
                        await load()
                    }
                }
            }
        } message: {
            Text("A script that uses it is refused from now on.")
        }
    }

    private func load() async {
        guard let api = app.api else { return }
        do {
            list = try await api.tokens()
            error = nil
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }
}

private struct NewTokenSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var change: ChangeRunner
    let made: () -> Void
    @State private var name = ""
    @State private var days = TokenRules.usualDays
    @State private var token: NewToken?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(token == nil ? "A new API token" : "Your new token").font(.title2.weight(.semibold))
            if let token {
                Text("It shows only now: copy it into your script's settings. The console keeps only a digest of it.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(token.token).font(.body.monospaced()).textSelection(.enabled)
                    .padding(8).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                HStack {
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(token.token, forType: .string)
                        app.say("Copied the token.")
                    }
                    Spacer()
                    Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
                }
            } else {
                TextField("Name (what the script is)", text: $name)
                Stepper("Lasts \(Words.plural(days, "day"))", value: $days, in: TokenRules.leastDays...TokenRules.mostDays)
                if let error = change.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                HStack {
                    Spacer()
                    Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                    Button("Make the Token") {
                        let chosen = name.trimmingCharacters(in: .whitespacesAndNewlines), length = days
                        Task {
                            if let new = await change.run(app, refusal: "No token was made.", { api in
                                try await api.createToken(name: chosen, days: length)
                            }) {
                                token = new
                                made()
                            }
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > TokenRules.nameLimit || change.busy)
                }
            }
        }
        .padding(24)
        .frame(width: 460)
    }
}

// MARK: History

/// What the console runs: the commits it was built from, newest first, with their release tags.
struct HistoryPage: View {
    @EnvironmentObject private var app: AppModel
    @State private var history: CommitHistory??
    @State private var error: Error?

    var body: some View {
        Group {
            if let history {
                if let history {
                    List(history.commits) { commit in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(commit.short).font(.body.monospaced()).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(commit.subject)
                                HStack {
                                    Text(Words.dateAndTime(commit.date)).font(.caption).foregroundStyle(.secondary)
                                    ForEach(commit.tags, id: \.self) { tag in
                                        Text(tag).font(.caption.weight(.semibold))
                                            .padding(.horizontal, 6).padding(.vertical, 1)
                                            .background(Color.accentColor.opacity(0.15), in: Capsule())
                                    }
                                }
                            }
                            Spacer()
                            if let link = commit.link { Link(destination: link) { Image(systemName: "arrow.up.right.square") } }
                        }
                        .padding(.vertical, 2)
                    }
                } else {
                    PageState(kind: .empty, text: "This console was never deployed from a checkout with its history.")
                }
            } else if let error {
                PageState(kind: .failed, text: "Could not load the history. \(Words.plainMessage(error))")
            } else {
                PageState(kind: .loading, text: "Loading the history…")
            }
        }
        .task {
            guard let api = app.api else { return }
            do {
                history = .some(try await api.history())
            } catch {
                self.error = error
            }
        }
        .pageToolbar("History", subtitle: (history ?? nil)?.builtFrom.map { "Built from \(String($0.prefix(7)))" })
    }
}

// MARK: Firmware's extras

/// The key every image must be signed with, as the board's bootloader holds it.
struct SigningKeySheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let fingerprint = app.firmware.value?.fingerprint ?? ""
        let earlier = (app.releases ?? []).filter { !fingerprint.isEmpty && !$0.keyHash.isEmpty && $0.keyHash != fingerprint }.count
        VStack(alignment: .leading, spacing: 14) {
            Text("Signing key").font(.title2.weight(.semibold))
            Text("Every release is signed with this key, and the board's bootloader refuses an image that is not.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            LabeledContent("Fingerprint · SHA-256") {
                Text(fingerprint.isEmpty ? "Not known yet" : fingerprint).font(.body.monospaced()).textSelection(.enabled)
            }
            if earlier > 0 {
                Label("\(Words.plural(earlier, "release")) signed with an earlier key.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 520)
    }
}

/// A release's notes, changed by a release manager.
struct NotesSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var change = ChangeRunner()
    let version: String
    @State var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Notes of \(version)").font(.title2.weight(.semibold))
            TextEditor(text: $text).font(.body).frame(minHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
            if let error = change.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") {
                    let notes = text
                    Task {
                        if await change.run(app, refusal: "The notes were not saved.", { api in
                            try await api.setNotes(version: version, notes: notes)
                        }) != nil {
                            await app.loadFirmware()
                            dismiss()
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(change.busy)
            }
        }
        .padding(24)
        .frame(width: 500)
        .changeSheets(change)
    }
}

// MARK: Search

/// Everything at once: boards, releases, deployments, the last day's events and log lines, the activity,
/// the screens and Help, ranked as on the iPhone (Search, CraniumKit).
struct SearchPage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession
    @State private var query = ""
    @State private var events: [BoardEvent] = []
    @State private var lines: [BoardLine] = []
    @State private var target: Route?

    var body: some View {
        let hits = Search.grouped(Search.rank(query, in: items()))
        Group {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                PageState(kind: .empty, text: "Search the boards, the releases, the deployments, the last day's events and log, the activity and Help.")
            } else if hits.isEmpty {
                PageState(kind: .empty, text: "Nothing matches “\(query)”.")
            } else {
                List {
                    ForEach(hits, id: \.kind) { group in
                        Section(group.kind.heading) {
                            ForEach(group.hits) { hit in
                                Button { open(hit.item.target) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(hit.item.title)
                                        if !hit.item.subtitle.isEmpty {
                                            Text(hit.item.subtitle).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $query, placement: .toolbar, prompt: "Boards, releases, events…")
        .onSubmit(of: .search) { _ = RecentSearches().add(query) }
        .task {
            guard let api = app.api else { return }
            events = (try? await api.events(from: Date().addingTimeInterval(-86_400), to: Date()).events) ?? []
            lines = (try? await api.boardLog(from: Date().addingTimeInterval(-86_400), to: Date()).lines) ?? []
            if app.audit.value == nil { await app.loadAudit() }
        }
        .navigationTitle("Search")
        .navigationDestination(isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } })) {
            if let target { RoutePage(route: target) }
        }
    }

    private func items() -> [SearchItem] {
        let devices = app.deviceList ?? []
        var items = SearchCatalog.items(canWrite: app.canWrite)
        items += Search.items(boards: devices)
        items += Search.items(releases: app.releases ?? [])
        items += Search.items(deployments: app.deployments.value ?? [], devices: devices)
        items += Search.items(events: events, devices: devices)
        items += Search.items(lines: lines, devices: devices)
        items += Search.items(activity: app.audit.value?.entries ?? [])
        if let book = try? HelpBook.load(from: .main) { items += Search.items(help: book) }
        return items
    }

    private func open(_ found: SearchTarget) {
        switch found {
        case .board(let thing), .event(let thing), .boardLog(let thing): target = .board(thing)
        case .release(let version): target = .release(version)
        case .deployment(let id): target = .deployment(id)
        case .activity(let link):
            if case .deployment(let id)? = link { target = .deployment(id) } else { session.teamSection = .activity }
        case .screen(let key): session.teamSection = TeamSection.forScreen(key) ?? .overview
        case .help(let id): target = .help(id)
        }
    }
}

// MARK: The customer's account

/// A customer's account: who, the password, and two-step sign-in with an authenticator app, as the
/// customer site's Account page (CustomerAccount, CraniumKit).
struct CustomerAccountPage: View {
    @EnvironmentObject private var customer: CustomerModel
    @EnvironmentObject private var session: MacSession
    @State private var current = ""
    @State private var next = ""
    @State private var again = ""
    @State private var secret: String?
    @State private var code = ""
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        Form {
            if let profile = customer.profile.value {
                Section("You") {
                    FactRow("Name", profile.name)
                    FactRow("E-mail", profile.email)
                }
                Section("Password") {
                    SecureField("Current password", text: $current)
                    SecureField("New password", text: $next)
                    SecureField("New password again", text: $again)
                    HStack {
                        Spacer()
                        Button("Change the Password") { Task { await changePassword() } }
                            .disabled(busy || current.isEmpty || next.isEmpty)
                    }
                }
                Section {
                    if profile.authenticator {
                        Label("Two-step sign-in is on: a code from your authenticator app at each sign-in.", systemImage: "checkmark.shield")
                        Button("Turn Off Two-Step Sign-In", role: .destructive) { Task { await stopAuthenticator() } }.disabled(busy)
                    } else if let secret {
                        Text("Add Cranium to your authenticator app with this setup key, then type the code it shows.")
                            .foregroundStyle(.secondary)
                        Text(CustomerAccount.groupSecret(secret)).font(.title3.monospaced()).textSelection(.enabled)
                        TextField("Code", text: $code).font(.title3.monospacedDigit())
                        HStack {
                            Spacer()
                            Button("Turn On") { Task { await confirmAuthenticator() } }
                                .disabled(busy || !CodeEntry.isComplete(CodeEntry.digits(before: "", after: code)))
                        }
                    } else {
                        Text("Two-step sign-in is off.").foregroundStyle(.secondary)
                        Button("Set Up an Authenticator App") { Task { await startAuthenticator() } }.disabled(busy)
                    }
                } header: {
                    Text("Two-step sign-in")
                }
                if let message {
                    Section { Text(message) }
                }
                Section {
                    Button("Sign Out", role: .destructive) { Task { await session.signOut() } }
                }
            } else if let error = customer.profile.error {
                PageState(kind: .failed, text: "Could not load your account. \(Words.plainMessage(error))") { Task { await customer.loadProfile() } }
            } else {
                PageState(kind: .loading, text: "Loading your account…")
            }
        }
        .formStyle(.grouped)
        .task { await customer.loadProfile() }
        .pageToolbar("Your account")
    }

    private func changePassword() async {
        guard let account = customer.account else { return }
        if let problem = AccountProblem.ofNewPassword(next, again: again) {
            message = problem.words
            return
        }
        busy = true
        defer { busy = false }
        let result = await account.changePassword(current: current, next: next)
        current = ""
        next = ""
        again = ""
        message = result.problem?.words ?? "Your password is changed."
    }

    private func startAuthenticator() async {
        guard let account = customer.account else { return }
        busy = true
        defer { busy = false }
        switch await account.startAuthenticator() {
        case .ok(let key): secret = key
        case .problem(let problem): message = problem.words
        }
    }

    private func confirmAuthenticator() async {
        guard let account = customer.account else { return }
        busy = true
        defer { busy = false }
        let result = await account.confirmAuthenticator(code: CodeEntry.digits(before: "", after: code))
        if let problem = result.problem {
            message = problem.words
        } else {
            secret = nil
            code = ""
            message = "Two-step sign-in is on."
            await customer.loadProfile()
        }
    }

    private func stopAuthenticator() async {
        guard let account = customer.account else { return }
        busy = true
        defer { busy = false }
        message = (await account.stopAuthenticator()).problem?.words ?? "Two-step sign-in is off."
        await customer.loadProfile()
    }
}

extension String {
    /// "The last 24 hours" from "the last 24 hours".
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
