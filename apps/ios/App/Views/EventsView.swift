import CraniumKit
import SwiftUI

/// What the Events page reads and shows: the boards' events of a range, the console's activity as a
/// lane of its own, and the boards' own log (telemetry.js, refreshEvents and boardLogOf).
@MainActor
final class EventsModel: ObservableObject {
    /// The board log of the range, as the page shows it.
    struct LogData {
        var lines: [BoardLine]
        var cursor: String?
        var query: (from: Date, to: Date, thing: String, kinds: [String]?, tags: [String]?)
        var pages: Int
    }

    struct Data {
        var events: [Telemetry.Marker]
        var cursor: String?
        var query: (from: Date, to: Date, thing: String, kinds: [String]?)
        var console: [Telemetry.Marker]?
        /// The Console lane shows only the newest 500 entries of the range.
        var consoleCut: Bool
        var pages: Int
    }

    @Published var range: Telemetry.Range = .preset("24h")
    @Published var thing = ""
    @Published var hidden: Set<String> = []
    @Published var selected: String?
    @Published private(set) var data: Data?
    @Published private(set) var error: Error?
    @Published private(set) var loadedAt: Date?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var moreError: Error?
    /// The board log: shown or not, and the one source it is narrowed to ("" for all of them).
    @Published var log = true
    @Published var tag = ""
    @Published private(set) var logData: LogData?
    /// The board log could not be read: the events are shown all the same.
    @Published private(set) var logError: Error?
    @Published private(set) var linesLoadingMore = false
    @Published private(set) var linesMoreError: Error?

    init(thing: String = "") {
        self.thing = thing
    }

    var live: Bool {
        if case .preset = range { return true }
        return false
    }

    /// Every 15 s while the range ends now, and not while pages loaded by hand would be lost.
    var interval: TimeInterval {
        live && (data?.pages ?? 1) == 1 && (logData?.pages ?? 1) == 1 && !loadingMore && !linesLoadingMore
            ? Telemetry.eventsRefresh : 0
    }

    func refresh(_ app: AppModel, full: Bool) async {
        guard let api = app.api else { return }
        let span = Telemetry.span(range, now: Date())
        // Connections are read even while their markers are hidden: the online bands are drawn from them.
        let kinds = BoardEvent.kinds.filter { $0 == "connection" || !hidden.contains($0) }
        let thing = self.thing
        let wanted = kinds.count < BoardEvent.kinds.count ? kinds : nil
        let console = !hidden.contains("console")
        loading = true
        defer { loading = false }
        if full || app.devices.due(false, every: 25) {
            await app.loadDevices()
        }
        let log = self.log
        let hidden = self.hidden
        let tag = self.tag
        do {
            async let page = api.events(from: span.from, to: span.to, thing: thing, kinds: wanted)
            async let entries = console ? Self.consoleEntries(api, from: span.from, to: span.to) : nil
            async let lines = log ? Self.boardLog(api, from: span.from, to: span.to, thing: thing, hidden: hidden, tag: tag) : nil
            let (read, audit, logRead) = try await (page, entries, lines)
            data = Data(events: read.events.compactMap(Telemetry.marker), cursor: read.cursor,
                        query: (span.from, span.to, thing, wanted),
                        console: audit?.entries.compactMap(Telemetry.consoleMarker), consoleCut: audit?.cut ?? false, pages: 1)
            switch logRead {
            case .success(let value)?:
                logData = value
                logError = nil
            case .failure(let failure)?:
                if !(failure is CancellationError) { logError = failure }
            case nil:
                logData = nil
                logError = nil
            }
            linesMoreError = nil
            error = nil
            loadedAt = Date()
            moreError = nil
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }

    /// The entries of the activity log within a span, newest first, five pages of 100 at most.
    private static func consoleEntries(_ api: ConsoleAPI, from: Date, to: Date) async throws -> (entries: [AuditEntry], cut: Bool) {
        var entries: [AuditEntry] = []
        var before: String?
        for _ in 0..<5 {
            let page = try await api.audit(limit: 100, before: before)
            entries += page.entries.filter { entry in
                guard let at = ConsoleTime.date(entry.at) else { return false }
                return at >= from && at <= to
            }
            guard let next = page.next, let last = ConsoleTime.date(page.entries.last?.at), last >= from else {
                return (entries, false)
            }
            before = next
        }
        return (entries, true)
    }

    /// The board log of the range: its failure is its own, and leaves the events as they are.
    private static func boardLog(_ api: ConsoleAPI, from: Date, to: Date, thing: String, hidden: Set<String>,
                                 tag: String) async -> Result<LogData, Error> {
        let asked = BoardLog.query(hidden: hidden, tag: tag)
        let query = (from: from, to: to, thing: thing, kinds: asked.kinds, tags: asked.tags)
        if asked.none { return .success(LogData(lines: [], cursor: nil, query: query, pages: 1)) }
        do {
            let page = try await api.boardLog(from: from, to: to, thing: thing, kinds: asked.kinds, tags: asked.tags)
            return .success(LogData(lines: page.lines, cursor: page.cursor, query: query, pages: 1))
        } catch {
            return .failure(error)
        }
    }

    func loadMoreLines(_ app: AppModel) async {
        guard let api = app.api, let value = logData, let cursor = value.cursor, !linesLoadingMore else { return }
        linesLoadingMore = true
        linesMoreError = nil
        defer { linesLoadingMore = false }
        do {
            let next = try await api.boardLog(from: value.query.from, to: value.query.to, thing: value.query.thing,
                                              kinds: value.query.kinds, tags: value.query.tags, cursor: cursor)
            var updated = value
            updated.lines += next.lines
            updated.cursor = next.cursor
            updated.pages += 1
            logData = updated
        } catch {
            linesMoreError = error
            await app.handle(error)
        }
    }

    func loadMore(_ app: AppModel) async {
        guard let api = app.api, let value = data, let cursor = value.cursor, !loadingMore else { return }
        loadingMore = true
        moreError = nil
        defer { loadingMore = false }
        do {
            let next = try await api.events(from: value.query.from, to: value.query.to, thing: value.query.thing,
                                            kinds: value.query.kinds, cursor: cursor)
            var updated = value
            updated.events += next.events.compactMap(Telemetry.marker)
            updated.cursor = next.cursor
            updated.pages += 1
            data = updated
        } catch {
            moreError = error
            await app.handle(error)
        }
    }
}


/// What every board did, as it reported it, with every line a board prints on its serial console under
/// it (the Board log).
struct EventsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model: EventsModel
    @State private var customOpen = false
    /// Opened for one board's lines (its page's "All lines"): the board log comes into view first.
    private let startAtLog: Bool
    @State private var scrolledToLog = false
    @State private var jump = 0

    /// `thing`: one board's events and lines.
    init(thing: String = "") {
        _model = StateObject(wrappedValue: EventsModel(thing: thing))
        startAtLog = !thing.isEmpty
    }

    var body: some View {
        ScrollViewReader { proxy in
            list
                .onChange(of: model.loadedAt) { _ in
                    guard startAtLog, !scrolledToLog, model.data != nil else { return }
                    scrolledToLog = true
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        withAnimation { proxy.scrollTo(Self.logAnchor, anchor: Self.logPlace) }
                    }
                }
                .onChange(of: jump) { _ in withAnimation { proxy.scrollTo(Self.logAnchor, anchor: Self.logPlace) } }
        }
    }

    static let logAnchor = "board-log"
    /// A little below the top, so that the section's heading is clear of the navigation bar.
    static let logPlace = UnitPoint(x: 0.5, y: 0.12)

    private var list: some View {
        ListScreen {
            Section {
                Picker("Range", selection: rangeChoice) {
                    ForEach(Telemetry.presets) { Text($0.label).tag($0.id) }
                    if !model.live { Text("Custom").tag("custom") }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                Text(filterWords)
            }
            if StaleNote.shows(loadedAt: model.loadedAt, error: model.error, every: Telemetry.eventsRefresh) {
                Section {
                    StaleNote(loadedAt: model.loadedAt, error: model.error, every: Telemetry.eventsRefresh) { reload() }
                }
            }
            if let data = model.data {
                content(data)
            } else if model.error == nil {
                Section { StateRow(kind: .loading, text: "Loading events…") }
            }
        }
        .poll(every: { model.interval }) { full in await model.refresh(app, full: full) }
        .onChange(of: model.range) { _ in reload() }
        .onChange(of: model.thing) { _ in reload() }
        .onChange(of: model.hidden) { _ in reload() }
        .onChange(of: model.log) { _ in reload() }
        .onChange(of: model.tag) { _ in reload() }
        .sheet(isPresented: $customOpen) { CustomRangeSheet(model: model) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { filterMenu }
        }
        .screenTitle("Events")
    }

    private var rangeChoice: Binding<String> {
        Binding(get: {
            if case .preset(let id) = model.range { return id }
            return "custom"
        }, set: { id in
            if id != "custom" { model.range = .preset(id) }
        })
    }

    private var filterWords: String {
        let board = model.thing.isEmpty ? "All boards" : (app.name(of: model.thing) ?? Words.shortThing(model.thing))
        let hidden = model.hidden.count
        return [board, hidden == 0 ? nil : "\(Words.plural(hidden, "kind")) hidden", model.tag.isEmpty ? nil : "Source \(model.tag)"]
            .compactMap { $0 }.joined(separator: " · ")
    }

    private var filterMenu: some View {
        Menu {
            Picker("Board", selection: $model.thing) {
                Text("All boards").tag("")
                ForEach(app.deviceList ?? []) { device in
                    Text(device.label).tag(device.thing)
                }
            }
            Menu("Kinds") {
                ForEach(Telemetry.kinds) { kind in
                    Toggle(kind.label, isOn: Binding(get: { !model.hidden.contains(kind.id) }, set: { on in
                        if on { model.hidden.remove(kind.id) } else { model.hidden.insert(kind.id) }
                    }))
                }
            }
            Button { customOpen = true } label: { Label("Custom range…", systemImage: "calendar") }
            Button { jump += 1 } label: { Label("Go to the board log", systemImage: "text.alignleft") }
            NavigationLink(value: Route.help("events")) { Label("Help", systemImage: "questionmark.circle") }
        } label: {
            Image(systemName: model.thing.isEmpty && model.hidden.isEmpty && model.tag.isEmpty
                  ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                .accessibilityLabel("Filter")
        }
    }

    private func reload() {
        model.selected = nil
        Task { await model.refresh(app, full: false) }
    }

    @ViewBuilder
    private func content(_ data: EventsModel.Data) -> some View {
        let devices = app.deviceList ?? []
        let span = Telemetry.span(model.range, now: Date())
        let to = model.live ? max(data.query.to, span.to) : data.query.to
        let lines = model.log ? BoardLog.shown(model.logData?.lines ?? [], hidden: model.hidden) : []
        let lanes = Telemetry.lanes(events: data.events, devices: devices, thing: model.thing, console: data.console, lines: lines)
        let shown = Telemetry.shown(lanes, hidden: model.hidden)
        if lanes.isEmpty || (app.deviceList != nil && devices.isEmpty && data.events.isEmpty) {
            Section { StateRow(kind: .empty, text: "No boards are registered yet.") }
        } else {
            Section {
                TimelineChart(lanes: lanes, from: data.query.from, to: to, live: model.live, hidden: model.hidden,
                              selected: $model.selected)
                    .padding(.vertical, 6)
                if let id = model.selected, let marker = shown.first(where: { $0.id == id }) {
                    EventLine(marker: marker, label: label(marker, lanes: lanes), withDay: true)
                }
            }
            if shown.isEmpty {
                Section { StateRow(kind: .empty, text: "No events in this range.") }
            }
            ForEach(days(shown), id: \.day) { group in
                Section(group.day) {
                    ForEach(group.markers) { marker in
                        EventLine(marker: marker, label: label(marker, lanes: lanes))
                    }
                }
            }
            if data.cursor != nil || model.moreError != nil {
                Section {
                    if data.cursor != nil {
                        Button {
                            Task { await model.loadMore(app) }
                        } label: {
                            HStack {
                                Text(model.loadingMore ? "Loading…" : "Load 500 more")
                                if model.loadingMore { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(model.loadingMore)
                    }
                    if let error = model.moreError {
                        StateRow(kind: .failed, text: Words.plainMessage(error))
                    }
                }
            }
            boardLog(lines, devices: devices)
        }
    }

    /// The Board log (telemetry.js, `boardLogCard`): every line a board printed in the range, newest
    /// first, by day, with its source and a way to narrow it to one, or hide it.
    @ViewBuilder
    private func boardLog(_ lines: [BoardLine], devices: [Device]) -> some View {
        Section {
            if model.log {
                Picker("Source", selection: $model.tag) {
                    Text(BoardLog.allSources).tag("")
                    ForEach(BoardLine.tags, id: \.self) { Text(verbatim: $0).tag($0) }
                }
            }
            Button(model.log ? BoardLog.hide : BoardLog.show) { model.log.toggle() }
            if !model.log {
                Text(BoardLog.hiddenNote).font(.footnote).foregroundStyle(theme.ink3)
            } else if let error = model.logError {
                StateRow(kind: .failed, text: "\(BoardLog.failed) \(Words.plainMessage(error))")
            } else if model.logData != nil && lines.isEmpty {
                StateRow(kind: .empty, text: "\(BoardLog.emptyTitle) \(!model.tag.isEmpty || !model.thing.isEmpty || BoardLine.kinds.contains(where: model.hidden.contains) ? BoardLog.emptyFiltered : BoardLog.emptyAll)")
            } else if model.logData == nil {
                StateRow(kind: .loading, text: "Loading the board log…")
            }
        } header: {
            HStack {
                Text(BoardLog.title)
                Spacer()
                if model.log, model.logError == nil, let data = model.logData, !lines.isEmpty {
                    Text(BoardLog.count(lines, more: data.cursor != nil)).textCase(nil)
                }
            }
        }
        .id(Self.logAnchor)
        if model.log, model.logError == nil, !lines.isEmpty {
            ForEach(lineDays(lines), id: \.day) { group in
                Section("\(BoardLog.title) · \(group.day)") {
                    ForEach(group.lines) { line in
                        BoardLineRow(line: line, board: devices.first { $0.thing == line.thing })
                    }
                }
            }
            if model.logData?.cursor != nil || model.linesMoreError != nil {
                Section {
                    if model.logData?.cursor != nil {
                        Button {
                            Task { await model.loadMoreLines(app) }
                        } label: {
                            HStack {
                                Text(model.linesLoadingMore ? "Loading…" : BoardLog.loadMore)
                                if model.linesLoadingMore { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(model.linesLoadingMore)
                    }
                    if let error = model.linesMoreError {
                        StateRow(kind: .failed, text: Words.plainMessage(error))
                    }
                }
            }
        }
    }

    private func lineDays(_ lines: [BoardLine]) -> [(day: String, lines: [BoardLine])] {
        let now = Date()
        var order: [String] = []
        var grouped: [String: [BoardLine]] = [:]
        for line in lines {
            let day = Words.dayLabel(line.at, now: now)
            if grouped[day] == nil { order.append(day) }
            grouped[day, default: []].append(line)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }

    private func label(_ marker: Telemetry.Marker, lanes: [Telemetry.Lane]) -> String {
        guard let thing = marker.thing else { return "Console" }
        return lanes.first { $0.id == thing }?.device?.name ?? Words.shortThing(thing)
    }

    private func days(_ markers: [Telemetry.Marker]) -> [(day: String, markers: [Telemetry.Marker])] {
        let now = Date()
        var order: [String] = []
        var grouped: [String: [Telemetry.Marker]] = [:]
        for marker in markers {
            let day = Words.dayLabel(ConsoleTime.text(marker.at), now: now)
            if grouped[day] == nil { order.append(day) }
            grouped[day, default: []].append(marker)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }
}

/// One event: its kind's mark, what happened, the board, and when. Tapping goes to the board, or
/// to what a console entry is about.
struct EventLine: View {
    @Environment(\.theme) private var theme
    let marker: Telemetry.Marker
    let label: String
    var withDay = false

    var body: some View {
        let row = HStack(alignment: .firstTextBaseline, spacing: 12) {
            KindGlyph(kind: marker.kind)
            VStack(alignment: .leading, spacing: 2) {
                Text(marker.text).font(.subheadline).lineLimit(2)
                Text("\(marker.thing == nil ? "Console" : "\(label) · \(Telemetry.kind(marker.kind).label)")\(marker.warn ? " · Warning" : "")")
                    .font(.caption).foregroundStyle(marker.warn ? theme.warn : theme.ink3)
            }
            Spacer(minLength: 8)
            Text(withDay ? Words.dateAndTime(ConsoleTime.text(marker.at)) : Words.timeOfDay(ConsoleTime.text(marker.at)))
                .font(.caption).foregroundStyle(theme.ink3)
        }
        .accessibilityElement(children: .combine)
        if let thing = marker.thing {
            NavigationLink(value: Route.board(thing)) { row }
        } else if case .deployment(let id)? = marker.link {
            NavigationLink(value: Route.deployment(id)) { row }
        } else {
            row
        }
    }
}

/// One line of a board's log (telemetry.js, `lineRow`): the time to the second, the board, its source
/// and kind, the line itself in the monospace face, a Warning badge, and the lines lost before it.
struct BoardLineRow: View {
    @Environment(\.theme) private var theme
    let line: BoardLine
    let board: Device?
    /// On a board's own page the board is not said again.
    var showsBoard = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            KindGlyph(kind: line.kind)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: line.text)
                    .font(Typeface.thing)
                    .foregroundStyle(theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                // The board, the source in the monospace face, and the kind, as one line that wraps whole.
                (Text(verbatim: showsBoard ? "\(board?.label ?? Words.shortThing(line.thing)) · " : "")
                    + Text(verbatim: line.tag).font(Typeface.hash)
                    + Text(verbatim: " · \(Telemetry.kind(line.kind).label)"))
                    .font(.caption)
                    .foregroundStyle(theme.ink3)
                if line.warn {
                    Label("Warning", systemImage: "exclamationmark.triangle.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(theme.warn)
                }
                if let dropped = line.dropped {
                    Text(BoardLog.dropped(dropped)).font(.caption).foregroundStyle(theme.warn)
                }
            }
            Spacer(minLength: 8)
            Text(BoardLog.secondOfDay(line.at))
                .font(.caption.monospacedDigit())
                .foregroundStyle(theme.ink3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    private var spoken: String {
        [BoardLog.secondOfDay(line.at), showsBoard ? board?.label ?? Words.shortThing(line.thing) : nil, line.tag,
         line.warn ? "Warning" : nil, line.text, line.dropped.map(BoardLog.dropped)].compactMap { $0 }.joined(separator: ", ")
    }
}

/// Two times for a range of events, checked as the API checks them.
struct CustomRangeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @ObservedObject var model: EventsModel
    @State private var from = Date().addingTimeInterval(-86_400)
    @State private var to = Date()
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("From", selection: $from, in: ...Date())
                    DatePicker("To", selection: $to, in: ...Date())
                } footer: {
                    Text("At most 31 days. Events are kept for 90 days. A range that does not end now is not refreshed by itself.")
                }
                if let problem {
                    Section { Text(problem).foregroundStyle(theme.bad) }
                }
            }
            .navigationTitle("Custom range")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Show") {
                        switch Telemetry.customRange(from: from, to: to, now: Date()) {
                        case .success(let range):
                            model.range = range
                            dismiss()
                        case .failure(let failure):
                            problem = failure.message
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
