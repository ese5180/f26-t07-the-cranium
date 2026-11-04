import CraniumKit
import SwiftUI

/// What Search looks through: what the app has loaded, a page of the activity log, the last
/// day's events (the last week's on request), the app's screens and actions, and Help.
@MainActor
final class SearchModel: ObservableObject {
    @Published var query = ""
    @Published private(set) var recent: [String] = RecentSearches().all
    @Published private(set) var audit: [AuditEntry] = []
    @Published private(set) var events: [BoardEvent] = []
    /// The board log of the same range as the events: the last day, or the last week on request.
    @Published private(set) var lines: [BoardLine] = []
    @Published private(set) var eventsWeek = false
    @Published private(set) var loadingEvents = false
    private var prepared = false

    init() {
        #if DEBUG
        // -CraniumSearch "query": a search already typed, for screenshots in demo mode.
        query = UserDefaults.standard.string(forKey: "CraniumSearch") ?? ""
        #endif
    }

    /// Reads what is cheap to read, once a search is opened.
    func prepare(_ app: AppModel) async {
        recent = RecentSearches().all
        guard !prepared, let api = app.api else { return }
        prepared = true
        if app.devices.value == nil { await app.loadDevices() }
        if app.firmware.value == nil { await app.loadFirmware() }
        if app.deployments.value == nil { await app.loadDeployments() }
        audit = (try? await api.audit(limit: 100).entries) ?? []
        events = (try? await api.events(from: Date().addingTimeInterval(-86_400), to: Date()).events) ?? []
        lines = (try? await api.boardLog(from: Date().addingTimeInterval(-86_400), to: Date()).lines) ?? []
    }

    /// The events of the last 7 days, up to two pages: the API has no search of its own.
    func searchWeek(_ app: AppModel) async {
        guard let api = app.api, !loadingEvents else { return }
        loadingEvents = true
        defer { loadingEvents = false }
        let to = Date()
        let from = to.addingTimeInterval(-7 * 86_400)
        guard var page = try? await api.events(from: from, to: to) else { return }
        var all = page.events
        if let cursor = page.cursor, let next = try? await api.events(from: from, to: to, cursor: cursor) {
            page = next
            all += next.events
        }
        events = all
        if let week = try? await api.boardLog(from: from, to: to) { lines = week.lines }
        eventsWeek = true
    }

    func remember(_ text: String? = nil) {
        recent = RecentSearches().add(text ?? query)
    }

    func forget(_ text: String) {
        RecentSearches().remove(text)
        recent = RecentSearches().all
    }

    func clearRecent() {
        RecentSearches().clear()
        recent = []
    }

    func items(_ app: AppModel) -> [SearchItem] {
        let devices = app.deviceList ?? []
        var items = SearchCatalog.items(canWrite: app.canWrite)
        items += Search.items(boards: devices)
        items += Search.items(releases: app.releases ?? [])
        items += Search.items(deployments: app.deployments.value ?? [], devices: devices)
        items += Search.items(events: events, devices: devices)
        items += Search.items(lines: lines, devices: devices)
        items += Search.items(activity: audit)
        if let help = HelpLibrary.book { items += Search.items(help: help) }
        return items
    }
}

/// The Search tab, from iOS 26: the system's own search field at the bottom.
struct SearchScreen: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var model = SearchModel()

    var body: some View {
        SearchResults(model: model)
            .consoleSearchable($model.query)
            .onSubmit(of: .search) { model.remember() }
            .task { await model.prepare(app) }
            .screenTitle("Search")
    }
}

/// Recent searches while the field is empty; results grouped by kind while it is not.
struct SearchResults: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @ObservedObject var model: SearchModel
    @State private var confirmSignOut = false

    var body: some View {
        let query = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        ListScreen {
            if query.isEmpty {
                recent
            } else {
                let groups = Search.grouped(Search.rank(query, in: model.items(app)))
                if groups.isEmpty {
                    Section { StateRow(kind: .empty, text: "Nothing matches “\(query)”.") }
                }
                ForEach(groups, id: \.kind) { group in
                    Section(group.kind.heading) {
                        ForEach(group.hits) { hit in row(hit) }
                    }
                }
                if !model.eventsWeek {
                    Section {
                        Button {
                            Task { await model.searchWeek(app) }
                        } label: {
                            HStack {
                                Label("Search events and lines of the last 7 days", systemImage: "magnifyingglass")
                                if model.loadingEvents { Spacer(); ProgressView() }
                            }
                        }
                    } footer: {
                        Text("Events and board log lines of the last 24 hours are searched already.")
                    }
                }
            }
        }
        .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await app.signOut() } }
        }
    }

    @ViewBuilder private var recent: some View {
        if model.recent.isEmpty {
            Section {
                StateRow(kind: .empty, text: "Search boards, releases, deployments, events, activity and Help.")
            }
        } else {
            Section {
                ForEach(model.recent, id: \.self) { text in
                    Button {
                        model.query = text
                    } label: {
                        Label(text, systemImage: "clock.arrow.circlepath").foregroundStyle(theme.ink)
                    }
                    .swipeActions { Button("Remove", role: .destructive) { model.forget(text) } }
                }
            } header: {
                HStack {
                    Text("Recent")
                    Spacer()
                    Button("Clear") { model.clearRecent() }.font(.footnote.weight(.semibold)).textCase(nil)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ hit: SearchHit) -> some View {
        let label = HitLabel(hit: hit)
        switch destination(hit.item.target) {
        case .route(let route):
            NavigationLink(value: route) { label }
                .simultaneousGesture(TapGesture().onEnded { model.remember() })
        case .action(let run):
            Button {
                model.remember()
                run()
            } label: {
                label
            }
            .foregroundStyle(theme.ink)
        }
    }

    private enum Destination {
        case route(Route)
        case action(() -> Void)
    }

    private func destination(_ target: SearchTarget) -> Destination {
        switch target {
        case .board(let thing), .event(let thing): return .route(.board(thing))
        case .boardLog(let thing): return .route(.boardLog(thing))
        case .release(let version): return .route(.release(version))
        case .deployment(let id): return .route(.deployment(id))
        case .activity: return .route(.activity)
        case .help(let id): return .route(.help(id))
        case .screen(let id):
            switch id {
            case "overview": return .route(.overview)
            case "boards": return .route(.boardsList)
            case "firmware": return .route(.firmwareList)
            case "events": return .route(.eventsList)
            case "deployments": return .route(.deployments)
            case "activity": return .route(.activity)
            case "tokens": return .route(.tokens)
            case "history": return .route(.history)
            case "serial": return .route(.serial)
            case "account": return .route(.account)
            case "upload": return .route(.upload)
            case "deploy": return .action { app.deployingThings = []; app.deploying = "" }
            case "bluetooth": return .action { app.openBluetooth(release: nil) }
            case "signout": return .action { confirmSignOut = true }
            default: return .route(.help(nil))
            }
        }
    }
}

/// A result: an icon for its kind, and its words with the match in bold.
struct HitLabel: View {
    @Environment(\.theme) private var theme
    let hit: SearchHit

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(theme.ink3)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(highlighted(hit.item.title, hit.titleRanges, mono: hit.item.kind == .release))
                    .lineLimit(2)
                if !hit.item.subtitle.isEmpty {
                    Text(highlighted(hit.item.subtitle, hit.subtitleRanges, mono: false))
                        .font(.footnote)
                        .foregroundStyle(theme.ink3)
                        .lineLimit(2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch hit.item.kind {
        case .screen: return "square.grid.2x2"
        case .board: return "cpu"
        case .release: return "shippingbox"
        case .deployment: return "paperplane"
        case .event: return "chart.xyaxis.line"
        case .line: return "text.alignleft"
        case .activity: return "list.bullet"
        case .help: return "questionmark.circle"
        }
    }

    private func highlighted(_ text: String, _ ranges: [Range<Int>], mono: Bool) -> AttributedString {
        var string = AttributedString(text)
        if mono { string.font = Typeface.version }
        let count = text.count
        for range in ranges where range.lowerBound >= 0 && range.upperBound <= count {
            let start = string.characters.index(string.startIndex, offsetBy: range.lowerBound)
            let end = string.characters.index(string.startIndex, offsetBy: range.upperBound)
            string[start..<end].foregroundColor = theme.accent
            string[start..<end].inlinePresentationIntent = .stronglyEmphasized
        }
        return string
    }
}

extension View {
    /// The search field, always shown under the title, so that it is there to type in on every
    /// version of iOS the app runs on.
    func consoleSearchable(_ text: Binding<String>) -> some View {
        #if os(iOS)
        return searchable(text: text, placement: .navigationBarDrawer(displayMode: .always), prompt: "Boards, releases, help…")
        #else
        return searchable(text: text, prompt: "Boards, releases, help…")
        #endif
    }
}
