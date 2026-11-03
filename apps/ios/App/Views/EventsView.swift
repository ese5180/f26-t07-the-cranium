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

/// The website's Events page.
struct EventsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model = EventsModel()
    @State private var customOpen = false

    var body: some View {
        Page {
            PageHead(lede: "What every board did, as it reported it: connections, updates, restarts, Bluetooth and its health, with what people did in this console alongside. Events are kept for 90 days.")
            Freshness(loadedAt: model.loadedAt, interval: model.interval, loading: model.loading)
            toolbar
            if let error = model.error {
                LoadProblem(what: "the events", error: error, loadedAt: model.loadedAt) { reload() }
            }
            if let data = model.data {
                content(data)
            } else if model.error == nil {
                Loading(what: "events")
            }
        }
        .poll(every: { model.interval }) { full in await model.refresh(app, full: full) }
        .onChange(of: model.range) { _ in reload() }
        .onChange(of: model.thing) { _ in reload() }
        .onChange(of: model.hidden) { _ in reload() }
        .sheet(isPresented: $customOpen) {
            CustomRangeSheet(model: model)
        }
        .consoleTitle("Events")
    }

    private func reload() {
        model.selected = nil
        Task { await model.refresh(app, full: false) }
    }

    @ViewBuilder private var toolbar: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Telemetry.presets) { preset in
                        chip(preset.label, on: model.range == .preset(preset.id)) { model.range = .preset(preset.id) }
                    }
                    chip(model.live ? "Custom…" : "Custom", on: !model.live) { customOpen = true }
                }
            }
            Text(Telemetry.rangeWords(model.range, now: Date()))
                .font(Typeface.small).foregroundStyle(theme.ink3)
            Menu {
                Button("All boards") { model.thing = "" }
                ForEach(app.deviceList ?? []) { device in
                    Button(device.name.map { "\($0) (\(Words.shortThing(device.thing)))" } ?? device.thing) { model.thing = device.thing }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                    Text(model.thing.isEmpty ? "All boards" : (app.name(of: model.thing) ?? model.thing))
                        .lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                }
                .font(Typeface.body.weight(.semibold))
            }
            .consoleButton()
        }
    }

    private func chip(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(Typeface.small.weight(.semibold))
                .padding(.horizontal, 12)
                .frame(minHeight: 34)
                .foregroundStyle(on ? theme.onAccent : theme.ink)
                .background(on ? theme.accent : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(on ? theme.accent : theme.lineField, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    @ViewBuilder
    private func content(_ data: EventsModel.Data) -> some View {
        let devices = app.deviceList ?? []
        let span = Telemetry.span(model.range, now: Date())
        let from = data.query.from
        let to = model.live ? max(data.query.to, span.to) : data.query.to
        let lanes = Telemetry.lanes(events: data.events, devices: devices, thing: model.thing, console: data.console)
        let shown = Telemetry.shown(lanes, hidden: model.hidden)
        let warnings = shown.filter(\.warn).count
        if lanes.isEmpty || (app.deviceList != nil && devices.isEmpty && data.events.isEmpty) {
            Card { EmptyState.noBoards }
        } else {
            kindChips(shown)
            Card("Timeline") {
                TimelineChart(lanes: lanes, from: from, to: to, live: model.live, hidden: model.hidden, selected: $model.selected)
                if let id = model.selected, let marker = shown.first(where: { $0.id == id }) {
                    EventRow(marker: marker, label: laneLabel(marker, lanes: lanes), dayShown: true)
                        .padding(10)
                        .background(theme.well, in: RoundedRectangle(cornerRadius: 6))
                }
                Text("A band is a board online. Tap an event on the timeline for what happened." +
                     (data.consoleCut ? " The Console lane shows the newest 500 entries of the activity log in this range." : ""))
                    .font(Typeface.small).foregroundStyle(theme.ink3)
            }
            Card("All events", more: {
                Text([Words.plural(shown.count, "event"), warnings > 0 ? Words.plural(warnings, "warning") : nil,
                      data.cursor != nil ? "more in this range" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(Typeface.tiny).foregroundStyle(theme.ink3)
            }) {
                if shown.isEmpty {
                    EmptyState(icon: "list", title: "No events in this range.",
                               text: !model.hidden.isEmpty || !model.thing.isEmpty
                               ? "Some kinds or boards are left out: show them all, or choose a longer range."
                               : "Boards record events when they connect, update, restart or change state. Choose a longer range.")
                } else {
                    EventList(markers: shown, lanes: lanes, label: { laneLabel($0, lanes: lanes) })
                }
                if data.cursor != nil {
                    Button(model.loadingMore ? "Loading…" : "Load 500 more") { Task { await model.loadMore(app) } }
                        .consoleButton()
                        .disabled(model.loadingMore)
                }
                if let error = model.moreError {
                    Notice(.bad, "x-circle", Words.failure("Could not load more.", error))
                }
            }
        }
    }

    private func laneLabel(_ marker: Telemetry.Marker, lanes: [Telemetry.Lane]) -> String {
        guard let thing = marker.thing else { return "Console" }
        return lanes.first { $0.id == thing }?.device?.name ?? thing
    }

    private func kindChips(_ shown: [Telemetry.Marker]) -> some View {
        let counts = Dictionary(grouping: shown, by: \.kind).mapValues(\.count)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Telemetry.kinds) { kind in
                    let on = !model.hidden.contains(kind.id)
                    Button {
                        if on { model.hidden.insert(kind.id) } else { model.hidden.remove(kind.id) }
                    } label: {
                        HStack(spacing: 6) {
                            KindGlyph(kind: kind.id)
                            Text(kind.label)
                            if on, let count = counts[kind.id] { Text("\(count)").foregroundStyle(theme.ink3).monospacedDigit() }
                        }
                        .font(Typeface.small.weight(.medium))
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .opacity(on ? 1 : 0.45)
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(on ? theme.lineField : theme.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(kind.label)\(on ? ", shown" : ", hidden")")
                    .accessibilityHint(on ? "Hides this kind of event" : "Shows this kind of event")
                }
            }
        }
    }
}

/// Every event shown, newest first, under its day.
struct EventList: View {
    @Environment(\.theme) private var theme
    let markers: [Telemetry.Marker]
    let lanes: [Telemetry.Lane]
    let label: (Telemetry.Marker) -> String

    var body: some View {
        let now = Date()
        let days = Dictionary(grouping: markers) { Words.dayLabel(ConsoleTime.text($0.at), now: now) }
        let order = markers.reduce(into: [String]()) { order, marker in
            let day = Words.dayLabel(ConsoleTime.text(marker.at), now: now)
            if order.last != day { order.append(day) }
        }
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(order, id: \.self) { day in
                Text(day).font(Typeface.small.weight(.semibold)).foregroundStyle(theme.ink2)
                    .padding(.top, 14).padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                ForEach(days[day] ?? []) { marker in
                    EventRow(marker: marker, label: label(marker))
                        .padding(.vertical, 8)
                    RowRule()
                }
            }
        }
    }
}

/// One event: when, which board, what kind, and what happened.
struct EventRow: View {
    @Environment(\.theme) private var theme
    let marker: Telemetry.Marker
    let label: String
    var dayShown = false

    var body: some View {
        let kind = Telemetry.kind(marker.kind)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(dayShown ? Words.dateAndTime(ConsoleTime.text(marker.at)) : Words.timeOfDay(ConsoleTime.text(marker.at)))
                    .font(Typeface.small.weight(.semibold)).monospacedDigit()
                KindGlyph(kind: marker.kind)
                Text(kind.label).font(Typeface.small).foregroundStyle(theme.ink2)
                Spacer(minLength: 4)
                if marker.warn { Badge(.warn, "alert", "Warning") }
            }
            if let thing = marker.thing {
                NavigationLink(value: Route.board(thing)) {
                    Text(label).font(label == thing ? Typeface.mono : Typeface.small.weight(.semibold)).underline()
                }
                .buttonStyle(.plain)
            } else {
                Text("Console").font(Typeface.small.weight(.semibold))
            }
            Text(marker.text).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
            if let job = marker.job, DeploymentId.isValid(job) {
                NavigationLink(value: Route.deployment(job)) { linkWords("Deployment") }.buttonStyle(.plain)
            }
            switch marker.link {
            case .deployment(let id)?:
                NavigationLink(value: Route.deployment(id)) { linkWords("Open") }.buttonStyle(.plain)
            case .firmware?:
                if let version = marker.text.split(separator: " ").last.map(String.init), Lenient.isVersion(version) {
                    NavigationLink(value: Route.release(version)) { linkWords("Open") }.buttonStyle(.plain)
                }
            case nil:
                EmptyView()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func linkWords(_ text: String) -> some View {
        HStack(spacing: 3) {
            Text(text)
            Image(systemName: "chevron.right").font(.caption2.weight(.bold))
        }
        .font(Typeface.small.weight(.semibold))
        .foregroundStyle(theme.ink)
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
