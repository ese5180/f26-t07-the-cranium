import CraniumKit
import SwiftUI

extension AppModel {
    /// A board's own name, if the board list has it.
    func name(of thing: String) -> String? {
        deviceList?.first { $0.thing == thing }?.name
    }
}

/// The team's console: the sidebar of sections, and each section's page with its own navigation (a
/// board, a release, a deployment), as the console's pages are linked. The section on screen comes
/// back when the window does (window restoration).
struct TeamView: View {
    @EnvironmentObject private var session: MacSession
    @EnvironmentObject private var app: AppModel
    @SceneStorage("cranium.team.section") private var storedSection = TeamSection.overview.rawValue

    var body: some View {
        split
            .onAppear {
                if let stored = TeamSection(rawValue: storedSection) { session.teamSection = stored }
            }
            .onChange(of: session.teamSection) { section in
                if let section { storedSection = section.rawValue }
            }
    }

    private var split: some View {
        NavigationSplitView {
            List(selection: $session.teamSection) {
                let visible = TeamSection.visible(canWrite: app.canWrite)
                ForEach(TeamSection.Group.allCases, id: \.self) { group in
                    let sections = visible.filter { $0.group == group }
                    if !sections.isEmpty {
                        Section(group.rawValue) {
                            ForEach(sections) { section in
                                Label(section.title, systemImage: section.symbol).tag(section)
                            }
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220)
            .safeAreaInset(edge: .bottom) { AccountFooter() }
        } detail: {
            NavigationStack {
                page(session.teamSection ?? .overview)
                    .navigationDestination(for: Route.self) { route in
                        RoutePage(route: route)
                    }
            }
            .id(session.teamSection)
        }
    }

    @ViewBuilder
    private func page(_ section: TeamSection) -> some View {
        switch section {
        case .overview: OverviewPage()
        case .boards: BoardsPage()
        case .firmware: FirmwarePage()
        case .deployments: DeploymentsPage()
        case .events: EventsPage()
        case .activity: ActivityPage()
        case .bluetooth: BluetoothPage()
        case .serial: SerialPage()
        case .search: SearchPage()
        case .tokens: TokensPage()
        case .history: HistoryPage()
        case .help: HelpPage()
        }
    }
}

/// Where a link leads: the iPhone's routes, on the Mac's pages.
struct RoutePage: View {
    let route: Route

    var body: some View {
        switch route {
        case .board(let thing), .boardCertificates(let thing): BoardPage(thing: thing)
        case .boardHistory(let thing): BoardPage(thing: thing, tab: .events)
        case .boardLog(let thing): BoardPage(thing: thing, tab: .log)
        case .boardBoots(let thing): BoardPage(thing: thing, tab: .boots)
        case .boardCharts(let thing): BoardPage(thing: thing, tab: .charts)
        case .boardSlots(let thing): BoardPage(thing: thing, tab: .slots)
        case .deployment(let id), .execution(let id, _): DeploymentPage(id: id)
        case .release(let version), .releaseDetails(let version): ReleasePage(version: version)
        case .deployments: DeploymentsPage()
        case .activity: ActivityPage()
        case .overview: OverviewPage()
        case .boardsList: BoardsPage()
        case .firmwareList, .upload, .signingKey: FirmwarePage()
        case .eventsList: EventsPage()
        case .tokens, .token: TokensPage()
        case .history: HistoryPage()
        case .serial: SerialPage()
        case .account: AccountPrompt()
        case .help(let topic): HelpPage(selected: topic)
        }
    }
}

/// Who is signed in, at the foot of the sidebar, with their role.
struct AccountFooter: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle").font(.title2).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(app.me.map { Words.nameOf(Person(sub: $0.sub, email: $0.email ?? "")) } ?? "Signed in")
                    .lineLimit(1)
                Text(app.me?.role ?? (app.meProblem ?? "Reading your account…"))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
        }
        .padding(10)
    }
}

// MARK: Overview

/// The console's Overview, as a dashboard: what is being updated, the fleet, the newest release and
/// the last changes.
struct OverviewPage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession

    var body: some View {
        let devices = app.deviceList
        let deployments = app.deployments.value
        ScrollView {
            if devices == nil || deployments == nil {
                if let error = app.devices.error ?? app.deployments.error {
                    PageState(kind: .failed, text: Words.plainMessage(error)) { session.refreshNow() }
                } else {
                    PageState(kind: .loading, text: "Loading…")
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 16)], alignment: .leading, spacing: 16) {
                    Card("Updates") { updates(devices ?? [], deployments ?? []) }
                    Card("Fleet") { fleet(devices ?? []) }
                    Card("Recent") { recent(devices ?? []) }
                }
                .padding(20)
            }
        }
        .refreshing(every: { app.fleetInterval }) { full in await app.refreshOverview(full: full) }
        .pageToolbar("Overview")
    }

    @ViewBuilder
    private func updates(_ devices: [Device], _ deployments: [Deployment]) -> some View {
        let now = Date()
        let active = deployments.filter { Words.isUnderWay($0) || Words.stillFinishing($0, devices: devices, now: now) }
        if active.isEmpty {
            if let newest = app.updates.value?.updates.first {
                NavigationLink(value: Route.of(newest)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("No update in progress").font(.headline)
                        Text(Words.lastUpdateLine(newest, now: now)).foregroundStyle(.secondary)
                        StatusLabel(Words.updateOutcome(newest.outcome))
                    }
                }
                .buttonStyle(.plain)
            } else {
                Text("No update in progress").foregroundStyle(.secondary)
            }
        } else {
            ForEach(active) { deployment in
                NavigationLink(value: Route.deployment(deployment.id)) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            VersionText(deployment.version ?? "unknown").font(.headline)
                            Spacer()
                            StatusLabel(Words.describeDeployment(deployment, devices: devices))
                        }
                        Text(Words.countSentence(deployment.counts)).foregroundStyle(.secondary)
                        if let detail = app.deploymentDetails[deployment.id]?.value {
                            ForEach(detail.executions) { execution in
                                let words = Words.describeExecution(execution, board: devices.first { $0.thing == execution.thing },
                                                                    deployment: detail.id, version: detail.version)
                                HStack {
                                    Text(app.name(of: execution.thing) ?? Words.shortThing(execution.thing))
                                    Spacer()
                                    StatusLabel(words.tone, words.icon, words.said ?? words.title)
                                }
                                if let progress = words.progress {
                                    ProgressView(value: Double(progress), total: 100)
                                }
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private func fleet(_ devices: [Device]) -> some View {
        let counted = Words.boardsCounted(devices)
        let newest = app.firmware.value?.newestActive
        Grid(alignment: .leading, verticalSpacing: 8) {
            GridRow {
                Text("Boards online").foregroundStyle(.secondary)
                Text("\(counted.online) of \(devices.count)").font(.title3.weight(.semibold))
            }
            GridRow {
                Text("Newest release").foregroundStyle(.secondary)
                if let newest { VersionText(newest.version) } else { Text("None can be deployed") }
            }
            if let newest {
                GridRow {
                    Text("On the newest").foregroundStyle(.secondary)
                    Text("\(devices.filter { $0.fw?.version == newest.version }.count) of \(devices.count)")
                }
            }
        }
        let open = (app.releases ?? []).filter { Words.revocationState($0) == .incomplete }
        if let first = open.first {
            NavigationLink(value: Route.release(first.version)) {
                StatusLabel(.warn, "alert", "Revocation of \(first.version) is incomplete")
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func recent(_ devices: [Device]) -> some View {
        let entries = app.recent.value?.entries ?? []
        if entries.isEmpty {
            Text("Nothing yet.").foregroundStyle(.secondary)
        } else {
            ForEach(entries.prefix(5)) { entry in
                ActivityRow(entry: entry)
            }
        }
    }
}

/// A rounded card of the Overview, on the window's material.
struct Card<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title3.weight(.semibold))
            content
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator))
    }
}

// MARK: Boards

/// Every board, in a table that sorts and searches; double-click opens a board, and its
/// menu opens it in its own window.
struct BoardsPage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession
    @Environment(\.openWindow) private var openWindow
    @State private var selection = Set<String>()
    @State private var search = ""
    @State private var order = [KeyPathComparator(\BoardRow.name)]
    @State private var path: [String] = []
    @SceneStorage("cranium.boards.filter") private var filter = BoardFilter.all

    var body: some View {
        let newest = app.firmware.value?.newestActive?.version
        let rows = (app.deviceList ?? []).filter { filter.keeps($0, newest: newest) }.map(BoardRow.init)
            .filter { search.isEmpty || $0.matches(search) }.sorted(using: order)
        Group {
            if app.deviceList == nil {
                if let error = app.devices.error {
                    PageState(kind: .failed, text: Words.plainMessage(error)) { session.refreshNow() }
                } else {
                    PageState(kind: .loading, text: "Loading the boards…")
                }
            } else if rows.isEmpty {
                PageState(kind: .empty, text: search.isEmpty ? "No boards yet. Provision one with tools/provision_device.py." : "No board matches “\(search)”.")
            } else {
                Table(rows, selection: $selection, sortOrder: $order) {
                    TableColumn("Board", value: \.name) { row in BoardTitle(thing: row.thing, name: row.device.name) }
                        .width(min: 160, ideal: 220)
                    TableColumn("Status", value: \.statusOrder) { row in
                        StatusLabel(row.online ? .good : .idle, row.online ? "online" : "offline", row.status)
                    }
                    .width(min: 110, ideal: 140)
                    TableColumn("Firmware", value: \.version) { row in
                        HStack(spacing: 6) {
                            VersionText(row.version.isEmpty ? "—" : row.version)
                            if row.device.fw?.confirmed == false { Text("on trial").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    .width(min: 90, ideal: 110)
                    TableColumn("Update") { row in
                        let update = Words.describeUpdate(row.device)
                        Text(update.progress.map { "\(update.title) · \($0)%" } ?? update.title)
                            .foregroundStyle(update.quiet ? .secondary : update.tone.color)
                            .lineLimit(1)
                    }
                    .width(min: 140, ideal: 220)
                    TableColumn("Signal") { row in
                        if let quality = Words.signalQuality(row.device.rssi) {
                            Text(quality.label).foregroundStyle(.secondary)
                        } else {
                            Text("—").foregroundStyle(.tertiary)
                        }
                    }
                    .width(min: 60, ideal: 80)
                }
                .contextMenu(forSelectionType: String.self) { things in
                    if let thing = things.first {
                        Button("Open") { path = [thing] }
                        Button("Open in New Window") { openWindow(id: "board", value: BoardWindowID(thing: thing)) }
                        Divider()
                        Button("Copy Thing Name") { copy(thing) }
                    }
                } primaryAction: { things in
                    if let thing = things.first { path = [thing] }
                }
            }
        }
        .searchable(text: $search, placement: .toolbar, prompt: "Name, thing or version")
        .refreshing(every: { app.fleetInterval }) { full in await app.refreshDevices(full: full) }
        .pageToolbar("Boards", subtitle: app.deviceList.map { "\(Words.boardsCounted($0).online) of \($0.count) online" })
        .navigationDestination(isPresented: Binding(get: { !path.isEmpty }, set: { if !$0 { path = [] } })) {
            if let thing = path.first { BoardPage(thing: thing) }
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// A board as a table row: what the columns sort by.
struct BoardRow: Identifiable {
    let device: Device
    var id: String { device.thing }
    var thing: String { device.thing }
    var name: String { device.name ?? device.thing }
    var online: Bool { Words.isUp(device) }
    var version: String { device.fw?.version ?? "" }
    var status: String {
        if online { return "Online" }
        return device.lastSeen == nil ? "Never connected" : "Offline · \(Words.timeAgo(device.lastSeen, now: Date()))"
    }

    var statusOrder: Int { online ? 0 : (device.lastSeen == nil ? 2 : 1) }

    func matches(_ text: String) -> Bool {
        let wanted = text.lowercased()
        return [name, thing, version].contains { $0.lowercased().contains(wanted) }
    }
}

/// A board in a window of its own.
struct BoardWindow: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    let board: BoardWindowID?

    var body: some View {
        Group {
            if let board, BoardWindowID.valid(board.thing), customer.adminMode, app.stage == .signedIn {
                NavigationStack {
                    BoardPage(thing: board.thing)
                        .navigationDestination(for: Route.self) { RoutePage(route: $0) }
                }
                .lockCover(app)
            } else {
                PageState(kind: .empty, text: "Sign in to the console in Cranium's main window to see this board.")
            }
        }
    }
}

// MARK: A board

/// A board's page: who it is and what it runs, its update, its diagnostics and its last updates.
struct BoardPage: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var session: MacSession
    @Environment(\.openWindow) private var openWindow
    let thing: String
    @State private var tab: BoardTab

    init(thing: String, tab: BoardTab = .board) {
        self.thing = thing
        _tab = State(initialValue: tab)
    }

    var body: some View {
        let entry = app.deviceDetails[thing]
        VStack(spacing: 0) {
            Picker("Show", selection: $tab) {
                ForEach(BoardTab.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            Group {
                if let detail = entry?.value {
                    switch tab {
                    case .board: content(detail)
                    case .events: BoardEventsTab(thing: thing, showing: "events")
                    case .log: BoardEventsTab(thing: thing, showing: "log")
                    case .boots: BootsTab(device: detail.device)
                    case .charts: ScrollView { ChartsTab(thing: thing) }
                    case .slots: SlotsTab(device: detail.device)
                    }
                } else if let error = entry?.error {
                    PageState(kind: .failed, text: "Could not load the board. \(Words.plainMessage(error))") {
                        Task { await app.refreshBoard(thing, full: true) }
                    }
                } else {
                    PageState(kind: .loading, text: "Loading the board…")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .refreshing(every: {
            guard let device = app.deviceDetails[thing]?.value?.device else { return Words.idleRefresh }
            let interval = Words.pollInterval([Words.deviceActivity(device)])
            return interval > 0 ? interval : Words.idleRefresh
        }, concerns: { $0.concerns(thing: thing) }) { full in
            await app.refreshBoard(thing, full: full)
        }
        .pageToolbar(app.name(of: thing) ?? Words.shortThing(thing), subtitle: thing)
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    openWindow(id: "board", value: BoardWindowID(thing: thing))
                } label: {
                    Label("Open in New Window", systemImage: "macwindow.badge.plus")
                }
                .help("Open this board in a window of its own")
            }
        }
    }

    private func content(_ detail: DeviceDetail) -> some View {
        let device = detail.device
        let update = Words.describeUpdate(device)
        return Form {
            Section {
                HStack {
                    StatusLabel(Words.isUp(device) ? .good : .idle, Words.isUp(device) ? "online" : "offline",
                                Words.isUp(device) ? "Online" : (device.lastSeen == nil ? "Never connected" : "Offline"))
                    Spacer()
                    if let fw = device.fw { VersionText(fw.version).font(.title3) }
                }
                if let seen = device.lastSeen { FactRow("Last heard from", Words.whenAt(seen, now: Date())) }
                FactRow("Thing name", device.thing, mono: true)
            }
            Section("Update") {
                StatusLabel(update.tone, update.icon, update.title)
                if !update.text.isEmpty { Text(update.text).foregroundStyle(.secondary) }
                if let progress = update.progress { ProgressView(value: Double(progress), total: 100) }
                if let deployment = update.deployment {
                    NavigationLink("The deployment", value: Route.deployment(deployment))
                }
            }
            Section("Firmware") {
                if let fw = device.fw {
                    FactRow("Runs", fw.version, mono: true)
                    FactRow("Kept", fw.confirmed ? "Yes" : "On trial: not kept yet")
                    if Words.isUnregistered(fw.version, releases: app.releases) {
                        StatusLabel(.warn, "alert", Words.notRegistered)
                    }
                    if (app.releases ?? []).contains(where: { $0.version == fw.version && !$0.isActive }) {
                        StatusLabel(.bad, "ban", "Runs a revoked release")
                    }
                } else {
                    FactRow("Runs", "Not reported")
                }
                if let last = detail.lastUpdate {
                    FactRow("Last update", Words.lastUpdateLine(last, now: Date()))
                }
            }
            Section("Diagnostics") {
                FactRow("Heartbeat", device.lastSeen == nil ? "None yet" : Telemetry.heartbeatAge(device.lastSeen, now: Date()))
                if device.uptime != nil {
                    FactRow("Uptime", Words.duration(Double(Telemetry.uptimeNow(device, now: Date()) ?? 0)))
                }
                if let quality = Words.signalQuality(device.rssi), let rssi = device.rssi {
                    FactRow("Signal", "\(quality.label) · \(Words.signed(rssi)) dBm")
                }
                if let diag = device.diag {
                    FactRow("Wi-Fi", diag.channel.map { "Channel \($0)" } ?? "Not associated")
                    if let heap = diag.heap, let words = Telemetry.heapWords(heap) {
                        LabeledContent("Memory") {
                            HStack {
                                ProgressView(value: Double(words.used), total: 100).frame(width: 120)
                                Text(words.text)
                            }
                        }
                    }
                }
                if let stuck = Telemetry.stuckWords(device.stuck) {
                    FactRow("Stuck restarts", stuck.badge ?? "None")
                }
            }
            if let page = app.boardUpdates[thing]?.value, !page.updates.isEmpty {
                Section("Updates") {
                    ForEach(page.updates.prefix(10)) { update in
                        NavigationLink(value: Route.of(update)) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Words.updateTitle(update))
                                    Text(Words.updateDetail(update, now: Date())).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusLabel(Words.updateOutcome(update.outcome))
                            }
                        }
                    }
                }
            }
            if !detail.certificates.isEmpty {
                Section("Certificates") {
                    ForEach(detail.certificates, id: \.self) { Text($0).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
        }
        .formStyle(.grouped)
    }
}
