import CraniumKit
import SwiftUI

/// What the Events page reads and shows: the boards' events of a range, and the console's
/// activity as a lane of its own (telemetry.js, refreshEvents).
@MainActor
final class EventsModel: ObservableObject {
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

    var live: Bool {
        if case .preset = range { return true }
        return false
    }

    /// Every 15 s while the range ends now, and not while pages loaded by hand would be lost.
    var interval: TimeInterval {
        live && (data?.pages ?? 1) == 1 && !loadingMore ? Telemetry.eventsRefresh : 0
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
        do {
            async let page = api.events(from: span.from, to: span.to, thing: thing, kinds: wanted)
            async let entries = console ? Self.consoleEntries(api, from: span.from, to: span.to) : nil
            let (read, audit) = try await (page, entries)
            data = Data(events: read.events.compactMap(Telemetry.marker), cursor: read.cursor,
                        query: (span.from, span.to, thing, wanted),
                        console: audit?.entries.compactMap(Telemetry.consoleMarker), consoleCut: audit?.cut ?? false, pages: 1)
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


/// What every board did, as it reported it.
struct EventsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model = EventsModel()
    @State private var customOpen = false

    var body: some View {
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
        return hidden == 0 ? board : "\(board) · \(Words.plural(hidden, "kind")) hidden"
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
            NavigationLink(value: Route.help("events")) { Label("Help", systemImage: "questionmark.circle") }
        } label: {
            Image(systemName: model.thing.isEmpty && model.hidden.isEmpty
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
        let lanes = Telemetry.lanes(events: data.events, devices: devices, thing: model.thing, console: data.console)
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
        }
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
