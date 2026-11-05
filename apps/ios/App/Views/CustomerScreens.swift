import CraniumKit
import SwiftUI

// The customer side's pages (customer-views.js): Overview, Devices, a board, Mixes and Help, in the
// console's pieces (Components.swift) and the site's words (CustomerWords).

/// How often a page of boards is read again while it is on screen, as the site does.
let customerRefresh: UInt64 = 30_000_000_000

extension Tone {
    /// The site's tone names: good, live, idle.
    init(site: String) {
        self = Tone(rawValue: site) ?? .idle
    }
}

/// A board's state as a badge.
struct CustomerStatusBadge: View {
    let board: CustomerBoard
    let now: Date

    var body: some View {
        let words = CustomerWords.status(board, now: now)
        Badge(Tone(site: words.tone), words.icon, words.label)
    }
}

/// Could not load something, in the site's words, with Try again.
struct CustomerProblem: View {
    let what: String
    let error: Error?
    let retry: () -> Void

    var body: some View {
        if let error {
            Notice(.bad, "alert", CustomerWords.couldNotLoad(what) + UserMessage.text(for: error)) {
                Button(CustomerWords.tryAgain, action: retry).consoleButton()
            }
        }
    }
}

/// "3 min ago", to the second while on screen.
struct Ago: View {
    let iso: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { context in
            Text(iso.map { Words.timeAgo($0, now: context.date) } ?? CustomerWords.dash)
        }
    }
}

// MARK: Overview

struct CustomerOverviewView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    let customerSide: Bool

    var body: some View {
        Group {
            if customerSide {
                customerOverview
            } else {
                AdminOverview()
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { AdminModeButton() }
        }
        .consoleTitle(CustomerWords.sections[0].label)
    }

    private var customerOverview: some View {
        Page {
            PageHead(eyebrow: CustomerWords.overviewEyebrow, lede: CustomerWords.overviewLede)
            Text(CustomerWords.hello(customer.me.value?.name ?? ""))
                .font(Typeface.title)
                .accessibilityAddTraits(.isHeader)
            CustomerProblem(what: CustomerWords.yourBoards, error: customer.boards.value == nil ? customer.boards.error : nil) {
                Task { await customer.refreshOverview() }
            }
            if let boards = customer.boards.value {
                OnlineBadge(boards: boards)
                CustomerTiles(boards: boards)
                Card(CustomerWords.yourBoardsTitle) {
                    if !boards.isEmpty { TabLink(tab: "devices", label: CustomerWords.allDevices) }
                } content: {
                    if boards.isEmpty {
                        EmptyState(icon: "chip", title: CustomerWords.noBoardsTitle, text: CustomerWords.noBoardsText)
                    } else {
                        CustomerBoardRows(boards: boards)
                    }
                }
                Card(CustomerWords.lately) {
                    CustomerProblem(what: CustomerWords.whatTheyDid, error: customer.activity.value == nil ? customer.activity.error : nil) {
                        Task { await customer.loadActivity() }
                    }
                    if let activity = customer.activity.value {
                        if activity.isEmpty {
                            Text(CustomerWords.nothingThisWeek).font(Typeface.body).foregroundStyle(.secondary)
                        } else {
                            CustomerActivityList(events: Array(activity.prefix(8)), boards: boards, compact: true)
                        }
                    } else if customer.activity.error == nil {
                        Loading(what: CustomerWords.whatTheyDid)
                    }
                }
                MixesTeaser()
            } else if customer.boards.error == nil {
                Loading(what: CustomerWords.yourBoards)
            }
        }
        .refreshable { await customer.refreshOverview() }
        .task {
            while !Task.isCancelled {
                await customer.refreshOverview()
                try? await Task.sleep(nanoseconds: customerRefresh)
            }
        }
    }
}

/// The figure in the site's top bar: how the boards are, in a word or two.
struct OnlineBadge: View {
    let boards: [CustomerBoard]

    var body: some View {
        let summary = CustomerWords.summarize(boards)
        Badge(summary.online > 0 ? .good : .idle, summary.online > 0 ? "online" : "offline", CustomerWords.online(summary))
    }
}

/// A link that switches tab: "All devices" on the overview. On the phone the devices are a tab of their own.
struct TabLink: View {
    let tab: String
    let label: String
    @Environment(\.selectTab) private var selectTab

    var body: some View {
        Button {
            selectTab(tab)
        } label: {
            HStack(spacing: 4) {
                Text(label)
                Image(systemName: Icon.symbol("arrow-right")).font(.caption2.weight(.bold))
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
    }
}

private struct SelectTabKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Switches the customer side's tab.
    var selectTab: (String) -> Void {
        get { self[SelectTabKey.self] }
        set { self[SelectTabKey.self] = newValue }
    }
}

/// The four figures: online now, boards, firmware, last heard from.
struct CustomerTiles: View {
    @Environment(\.theme) private var theme
    let boards: [CustomerBoard]

    var body: some View {
        let summary = CustomerWords.summarize(boards)
        TimelineView(.periodic(from: .now, by: 10)) { context in
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                Tile(icon: "online", label: CustomerWords.onlineNow, value: CustomerWords.onlineFigure(summary),
                     note: summary.busy > 0 ? CustomerWords.updatingNote(summary.busy) : CustomerWords.reportsNote, ink: true)
                Tile(icon: "chip", label: CustomerWords.boardsTile, value: String(summary.total), note: CustomerWords.onYourAccount)
                Tile(icon: "package", label: CustomerWords.firmwareTile, value: CustomerWords.firmwareFigure(summary),
                     note: summary.versions.count > 1 ? CustomerWords.notSameNote : CustomerWords.keptUpNote)
                Tile(icon: "clock", label: CustomerWords.lastHeardFrom,
                     value: summary.lastSeen.map { Words.timeAgo($0, now: context.date) } ?? CustomerWords.dash,
                     note: summary.lastSeen.map(Words.dateAndTime) ?? CustomerWords.noReportYet)
            }
        }
    }

    private struct Tile: View {
        @Environment(\.theme) private var theme
        let icon: String
        let label: String
        let value: String
        let note: String
        var ink = false

        var body: some View {
            let look = ink ? Theme.panel : theme
            VStack(alignment: .leading, spacing: 6) {
                Label(label, systemImage: Icon.symbol(icon))
                    .font(Typeface.small.weight(.semibold))
                    .foregroundStyle(look.ink2)
                Text(value)
                    .font(.title2.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(look.ink)
                Text(note)
                    .font(Typeface.tiny)
                    .foregroundStyle(look.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
            .background(ink ? look.surface : theme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                if !ink { RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(theme.line, lineWidth: 1) }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// The boards, one row each: the name, its firmware and when it was heard from, its state.
struct CustomerBoardRows: View {
    @Environment(\.theme) private var theme
    let boards: [CustomerBoard]
    var showUpdate = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(boards) { board in
                NavigationLink(value: CustomerRoute.board(board.id)) {
                    HStack(alignment: .center, spacing: 12) {
                        CraniumMark().frame(width: 28, height: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(CustomerWords.boardTitle(board)).font(Typeface.heading)
                            if let device = board.boardName, device != board.name {
                                Mono(device, font: Typeface.mono).foregroundStyle(theme.ink3)
                            }
                            HStack(spacing: 0) {
                                Text(CustomerWords.firmwareLine(board) + " · ")
                                if board.lastSeen != nil {
                                    Text(CustomerWords.heardFrom)
                                    Ago(iso: board.lastSeen)
                                } else {
                                    Text(CustomerWords.notHeardYet)
                                }
                            }
                            .font(Typeface.small)
                            .foregroundStyle(theme.ink2)
                            if showUpdate, let update = CustomerWords.update(board) {
                                Text(update).font(Typeface.small).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 6)
                        CustomerStatusBadge(board: board, now: Date())
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(theme.ink3)
                            .accessibilityHidden(true)
                    }
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                RowRule()
            }
        }
    }
}

/// What the boards did: an icon, the sentence, and which board and when.
struct CustomerActivityList: View {
    @Environment(\.theme) private var theme
    let events: [CustomerEvent]
    let boards: [CustomerBoard]
    var compact = false

    var body: some View {
        let names = Dictionary(boards.map { ($0.id, CustomerWords.boardTitle($0)) }, uniquingKeysWith: { first, _ in first })
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                let words = CustomerWords.event(event)
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: Icon.symbol(words.icon))
                        .frame(width: 20)
                        .foregroundStyle(theme.ink2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(words.text).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 0) {
                            if names.count > 1 || compact {
                                Text((names[event.board] ?? CustomerWords.aBoard) + " · ")
                            }
                            Ago(iso: event.at)
                        }
                        .font(Typeface.small)
                        .foregroundStyle(theme.ink3)
                    }
                }
                .padding(.vertical, 9)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// "After the last track": what is coming for the mixes.
struct MixesTeaser: View {
    @Environment(\.theme) private var theme

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(CustomerWords.teaserEyebrow)
                Text(CustomerWords.teaserTitle).font(Typeface.heading).fixedSize(horizontal: false, vertical: true)
                Text(CustomerWords.teaserText).font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                TabLink(tab: "mixes", label: CustomerWords.teaserLink)
            }
        }
    }
}

/// The admin's overview (customer-views.js `adminOverview`): who is signed in, and Open admin mode.
struct AdminOverview: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme

    var body: some View {
        Page {
            PageHead(eyebrow: CustomerWords.adminEyebrow,
                     lede: app.me.flatMap { me in me.email.map { CustomerWords.adminLede(email: $0, canWrite: me.canWrite) } }
                        ?? CustomerWords.adminLedeUnknown)
            Text(CustomerWords.adminTitle).font(Typeface.title).accessibilityAddTraits(.isHeader)
            Panel {
                Eyebrow(CustomerWords.adminMode)
                Text(CustomerWords.adminPanelTitle).font(Typeface.heading)
                Text(CustomerWords.adminPanelText).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                Button {
                    customer.openAdminMode()
                } label: {
                    Label(CustomerWords.openAdminMode, systemImage: "key").frame(minHeight: 40)
                }
                .consoleButton(.primary)
            }
            Card(CustomerWords.whatCustomersSee) {
                Text(CustomerWords.whatCustomersSeeText).font(Typeface.body).foregroundStyle(theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if customer.stage != .notSetUp {
                Button(CustomerWords.customerSignIn) {
                    customer.gate = .signIn
                    customer.customerSignInOpen = true
                }
                .consoleButton()
            }
            Card(CustomerWords.signOut) {
                Button(CustomerWords.signOut, role: .destructive) {
                    Task { await customer.signOutEverything(admin: app) }
                }
                .consoleButton(.dangerQuiet)
            }
        }
    }
}

// MARK: Devices and one board

struct CustomerDevicesView: View {
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        Page {
            PageHead(eyebrow: CustomerWords.yourStudio, lede: CustomerWords.devicesLede)
            CustomerProblem(what: CustomerWords.yourBoards, error: customer.boards.value == nil ? customer.boards.error : nil) {
                Task { await customer.loadBoards() }
            }
            if let boards = customer.boards.value {
                if boards.isEmpty {
                    EmptyState(icon: "chip", title: CustomerWords.noBoardsTitle, text: CustomerWords.noBoardsText)
                } else {
                    CustomerBoardRows(boards: boards, showUpdate: true)
                }
            } else if customer.boards.error == nil {
                Loading(what: CustomerWords.yourBoards)
            }
        }
        .refreshable { await customer.loadBoards() }
        .task {
            while !Task.isCancelled {
                await customer.loadBoards()
                try? await Task.sleep(nanoseconds: customerRefresh)
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { AdminModeButton() } }
        .consoleTitle(CustomerWords.yourBoardsTitle)
    }
}

struct CustomerBoardView: View {
    @EnvironmentObject private var customer: CustomerModel
    @Environment(\.theme) private var theme
    let id: String

    var body: some View {
        let entry = customer.details[id]
        Page {
            if let detail = entry?.value {
                content(detail)
            } else if let error = entry?.error {
                if (error as? CustomerAPIError)?.status == 404 {
                    EmptyState(icon: "chip", title: CustomerWords.notYoursTitle, text: CustomerWords.notYoursText)
                } else {
                    CustomerProblem(what: CustomerWords.theBoard, error: error) { Task { await customer.loadBoard(id) } }
                }
            } else {
                Loading(what: CustomerWords.theBoard)
            }
        }
        .refreshable { await customer.loadBoard(id) }
        .task {
            while !Task.isCancelled {
                await customer.loadBoard(id)
                try? await Task.sleep(nanoseconds: customerRefresh)
            }
        }
        .consoleTitle(CustomerWords.boardTitle(entry?.value?.board), large: false)
    }

    @ViewBuilder private func content(_ detail: CustomerBoardDetail) -> some View {
        let board = detail.board
        let now = Date()
        let words = CustomerWords.status(board, now: now)
        PageHead(eyebrow: CustomerWords.boardEyebrow(board), lede: words.text)
        CustomerStatusBadge(board: board, now: now)
        // A refresh that did not work, over what was read before.
        CustomerProblem(what: CustomerWords.theBoard, error: customer.details[id]?.error) { Task { await customer.loadBoard(id) } }
        Card(CustomerWords.howItIs) {
            VStack(alignment: .leading, spacing: 0) {
                Fact(CustomerWords.stateColumn) { CustomerStatusBadge(board: board, now: now) }
                Fact(CustomerWords.firmwareTile) {
                    if let firmware = board.firmware {
                        HStack(spacing: 8) {
                            Mono(CustomerWords.shortVersion(firmware.version), strong: true)
                            if !firmware.confirmed { Tag(text: CustomerWords.onTrial, tone: .warn) }
                        }
                    } else {
                        Text(CustomerWords.notReportedYet)
                    }
                }
                Fact(CustomerWords.lastHeardFrom) {
                    if let seen = board.lastSeen {
                        Ago(iso: seen)
                        Text(Words.dateAndTime(seen)).font(Typeface.small).foregroundStyle(theme.ink3)
                    } else {
                        Text(CustomerWords.notYet)
                    }
                }
                Fact(CustomerWords.updateColumn) { Text(CustomerWords.update(board) ?? CustomerWords.dash).fixedSize(horizontal: false, vertical: true) }
                Fact(CustomerWords.wifiSignal) {
                    if let quality = Words.signalQuality(board.rssi) {
                        HStack(spacing: 8) {
                            SignalBars(bars: quality.bars, old: !board.online)
                            Text(CustomerWords.signal(board.rssi))
                        }
                    } else {
                        Text(CustomerWords.notReported)
                    }
                }
                Fact(CustomerWords.runningFor) {
                    Text(board.online ? board.uptime.map { Words.duration(Double($0)) } ?? CustomerWords.dash : CustomerWords.dash)
                }
                Fact(CustomerWords.location) {
                    Text(CustomerWords.locationNotReported).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
                Fact(CustomerWords.yoursSince) { Text(board.since.map(Words.dateAndTime) ?? CustomerWords.dash) }
            }
        }
        Notice(.idle, "shield", CustomerWords.updatesNote)
        Card(CustomerWords.whatItDid) {
            if detail.activity.isEmpty {
                Text(CustomerWords.nothingThisMonth).font(Typeface.body).foregroundStyle(theme.ink2)
            } else {
                CustomerActivityList(events: detail.activity, boards: [board])
            }
        }
    }

}

// MARK: Mixes

struct CustomerMixesView: View {
    @Environment(\.theme) private var theme
    @State private var tab = "sessions"

    var body: some View {
        let words = CustomerWords.mixes[tab]!
        Page {
            PageHead(eyebrow: CustomerWords.mixesEyebrow, lede: CustomerWords.mixesLede)
            Text(CustomerWords.mixesTitle).font(Typeface.title).accessibilityAddTraits(.isHeader)
            Picker(CustomerWords.sections[2].label, selection: $tab) {
                ForEach(CustomerWords.mixTabs, id: \.self) { name in
                    Text(CustomerWords.mixes[name]!.label).tag(name)
                }
            }
            .pickerStyle(.segmented)
            VStack(alignment: .leading, spacing: 12) {
                Tag(text: CustomerWords.notBuiltYet, tone: .warn)
                Text(words.title).font(Typeface.heading).accessibilityAddTraits(.isHeader)
                Text(words.text).font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                Lanes().frame(height: 64)
                Text(CustomerWords.mixesWhy).font(Typeface.small).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
            }
            Notice(.idle, "shield", CustomerWords.mixesNote)
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { AdminModeButton() } }
        .consoleTitle(CustomerWords.sections[2].label)
    }

    /// Two decks as lanes, with nothing on them: what a session will look like, not a session.
    private struct Lanes: View {
        @Environment(\.theme) private var theme

        var body: some View {
            GeometryReader { geometry in
                let scale = geometry.size.width / 320
                ZStack(alignment: .topLeading) {
                    ForEach([6.0, 38.0], id: \.self) { y in
                        RoundedRectangle(cornerRadius: 4).fill(theme.well)
                            .frame(width: geometry.size.width, height: 20).offset(y: y)
                    }
                    ForEach(Array([(8.0, 6.0, 70.0), (104, 6, 64), (200, 6, 76), (56, 38, 62), (150, 38, 70), (246, 38, 66)].enumerated()),
                            id: \.offset) { _, slot in
                        RoundedRectangle(cornerRadius: 4).strokeBorder(theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .frame(width: slot.2 * scale, height: 20).offset(x: slot.0 * scale, y: slot.1)
                    }
                }
            }
            .accessibilityHidden(true)
        }
    }
}

// MARK: Help

struct CustomerHelpView: View {
    @Environment(\.theme) private var theme

    var body: some View {
        Page {
            PageHead(eyebrow: CustomerWords.helpEyebrow, lede: CustomerWords.helpLede)
            Text(CustomerWords.helpTitle).font(Typeface.title).accessibilityAddTraits(.isHeader)
            ForEach(CustomerWords.help, id: \.section) { section in
                Card(section.section) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(section.items, id: \.question) { item in
                            DisclosureGroup {
                                Text(item.answer).font(Typeface.body).foregroundStyle(theme.ink2)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 6)
                            } label: {
                                Text(item.question).font(Typeface.body.weight(.semibold)).foregroundStyle(theme.ink)
                            }
                            .padding(.vertical, 8)
                            RowRule()
                        }
                    }
                }
            }
            Card(CustomerWords.stillStuck) {
                Text(CustomerWords.stillStuckText).font(Typeface.body).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
        }
        .toolbar { ToolbarItem(placement: .primaryAction) { AdminModeButton() } }
        .consoleTitle(CustomerWords.sections[4].label)
    }
}
