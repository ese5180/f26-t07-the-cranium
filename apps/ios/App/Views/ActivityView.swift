import CraniumKit
import SwiftUI

/// The activity log, a page at a time.
@MainActor
final class ActivityModel: ObservableObject {
    @Published private(set) var entries: [AuditEntry]?
    @Published private(set) var next: String?
    @Published private(set) var error: Error?
    @Published private(set) var loadedAt: Date?
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var moreError: Error?

    static let page = 50

    /// Reading the first page again would take away the pages loaded by hand.
    var interval: TimeInterval {
        loadingMore || (entries?.count ?? 0) > Self.page ? 0 : Words.idleRefresh
    }

    func refresh(_ app: AppModel, full: Bool) async {
        guard let api = app.api else { return }
        loading = true
        defer { loading = false }
        // How a deployment ended is not in the log: it follows from the deployment. A board is called by
        // the name it has now, from the list of boards.
        if app.deployments.due(full) { await app.loadDeployments() }
        if app.devices.due(full) { await app.loadDevices() }
        do {
            let page = try await api.audit(limit: Self.page)
            entries = page.entries
            next = page.next
            error = nil
            moreError = nil
            loadedAt = Date()
        } catch {
            if !(error is CancellationError) { self.error = error }
            await app.handle(error)
        }
    }

    func loadMore(_ app: AppModel) async {
        guard let api = app.api, let next, !loadingMore else { return }
        loadingMore = true
        moreError = nil
        defer { loadingMore = false }
        do {
            let page = try await api.audit(limit: Self.page, before: next)
            entries = (entries ?? []) + page.entries
            self.next = page.next
        } catch {
            moreError = error
            await app.handle(error)
        }
    }
}

/// Who changed what, and when, by day.
struct ActivityView: View {
    @EnvironmentObject private var app: AppModel
    @StateObject private var model = ActivityModel()

    var body: some View {
        ListScreen {
            if StaleNote.shows(loadedAt: model.loadedAt, error: model.error) {
                Section {
                    StaleNote(loadedAt: model.loadedAt, error: model.error) { Task { await model.refresh(app, full: true) } }
                }
            }
            if let entries = model.entries {
                if entries.isEmpty {
                    Section { StateRow(kind: .empty, text: "Nothing has been recorded yet.") }
                } else {
                    ForEach(days(entries), id: \.day) { group in
                        Section(group.day) {
                            ForEach(group.entries) { entry in
                                NavigationLink {
                                    ActivityEntryView(entry: entry)
                                } label: {
                                    ActivityRow(entry: entry, timeOfDay: true, details: true)
                                }
                            }
                        }
                    }
                    Section {
                        if model.next != nil {
                            Button {
                                Task { await model.loadMore(app) }
                            } label: {
                                HStack {
                                    Text(model.loadingMore ? "Loading…" : "Load more")
                                    if model.loadingMore { Spacer(); ProgressView() }
                                }
                            }
                            .disabled(model.loadingMore)
                        } else {
                            Text("That is every entry.").foregroundStyle(Theme.page.ink3)
                        }
                        if let error = model.moreError {
                            StateRow(kind: .failed, text: Words.plainMessage(error))
                        }
                    }
                }
            } else if model.error == nil {
                Section { StateRow(kind: .loading, text: "Loading activity…") }
            }
        }
        .poll(every: { model.interval }) { full in await model.refresh(app, full: full) }
        .helpButton("activity")
        .screenTitle("Activity")
    }

    private func days(_ entries: [AuditEntry]) -> [(day: String, entries: [AuditEntry])] {
        let now = Date()
        var order: [String] = []
        var grouped: [String: [AuditEntry]] = [:]
        for entry in entries {
            let day = Words.dayLabel(entry.at, now: now)
            if grouped[day] == nil { order.append(day) }
            grouped[day, default: []].append(entry)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }
}

/// One entry of the log, in a row: who did what, how it ended if not well, and when.
struct ActivityRow: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let entry: AuditEntry
    var timeOfDay = false
    /// The entry's details under it, as the website's full log has them ("From the phone app"); the
    /// Overview's short form leaves them out.
    var details = false

    var body: some View {
        let words = Words.describeAudit(entry)
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: Icon.symbol(words.icon))
                .font(.footnote)
                .foregroundStyle(words.outcome.map { theme.tone($0.tone) } ?? theme.ink3)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(Words.auditSentence(entry, devices: app.deviceList ?? []))
                    .font(.subheadline)
                    .lineLimit(details ? 4 : 2)
                if let outcome = words.outcome {
                    Text(outcome.label).font(.caption.weight(.semibold)).foregroundStyle(theme.tone(outcome.tone))
                }
                if details, !words.facts.isEmpty {
                    // A refusal by its words alone; anything else by its label and value.
                    Text(words.facts.map { $0.words ?? "\($0.label)\($0.phrase ? "" : ":") \($0.value)" }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(theme.ink3).lineLimit(2).truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Text(timeOfDay ? Words.timeOfDay(entry.at) : Words.timeAgo(entry.at, now: Date()))
                .font(.caption).foregroundStyle(theme.ink3)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One entry of the log, with everything it records.
struct ActivityEntryView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let entry: AuditEntry

    var body: some View {
        let words = Words.describeAudit(entry)
        let devices = app.deviceList ?? []
        ListScreen {
            Section {
                Text(Words.auditSentence(entry, devices: devices))
                if let outcome = words.outcome { StatusText(outcome) }
                if words.scripted {
                    Text("\(Words.scriptedTag): \(Words.scriptedNote)").font(.footnote).foregroundStyle(theme.ink3)
                }
            }
            if !words.facts.isEmpty {
                Section {
                    ForEach(words.facts) { fact in
                        if let refusal = fact.words {
                            ValueRow(fact.label, refusal)
                        } else if fact.code {
                            HStack {
                                Text(fact.label)
                                Spacer()
                                Text(verbatim: fact.value).font(Typeface.hash).foregroundStyle(theme.ink2).lineLimit(1).truncationMode(.middle)
                            }
                        } else {
                            ValueRow(fact.label, fact.value)
                        }
                    }
                }
            }
            Section {
                ValueRow("When", Words.exactTime(entry.at))
                if let sub = entry.actor?.sub, !sub.isEmpty {
                    HStack {
                        Text("Account")
                        Spacer()
                        Text(verbatim: Words.shortAccount(sub)).font(Typeface.hash).foregroundStyle(theme.ink2)
                    }
                }
                // A sign-in was asked for by no request: its id is made of the sign-in itself.
                if Words.showsRequestId(entry) {
                    HStack {
                        Text("Request")
                        Spacer()
                        Text(verbatim: entry.requestId).font(Typeface.hash).foregroundStyle(theme.ink2).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            // The boards it is about, by the name each has now: a deployment's, or the board a command
            // at its serial console was given to, found by its device ID.
            let boards = boardsOf(words, devices: devices)
            if !boards.isEmpty {
                Section {
                    ForEach(boards, id: \.self) { thing in
                        NavigationLink(value: Route.board(thing)) {
                            Text(verbatim: devices.first { $0.thing == thing }?.label ?? Words.shortThing(thing))
                        }
                    }
                }
            }
            switch words.link {
            case .deployment(let id)?:
                Section { NavigationLink("Open the deployment", value: Route.deployment(id)) }
            case .firmware? where Lenient.isVersion(entry.target):
                Section { NavigationLink("Open the release", value: Route.release(entry.target)) }
            default:
                EmptyView()
            }
        }
        .screenTitle("Entry", large: false)
    }

    private func boardsOf(_ words: AuditWords, devices: [Device]) -> [String] {
        if words.byName, let board = devices.first(where: { $0.name == words.label }) { return [board.thing] }
        return words.boards
    }
}

/// The signed-in person's own API tokens.
@MainActor
final class TokensModel: ObservableObject {
    @Published var list = Loadable<TokenList>()

    func refresh(_ app: AppModel) async {
        guard let api = app.api else { return }
        list.loading = true
        do {
            list = Loadable(value: try await api.tokens(), loadedAt: Date())
        } catch {
            list.loading = false
            if !(error is CancellationError) { list.error = error }
            await app.handle(error)
        }
    }
}

/// Your API tokens; New token is the one action, Revoke is on a token's own page.
struct TokensView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model = TokensModel()
    @State private var creating = false

    var body: some View {
        let listing = model.list.value
        let full = listing.map { $0.active >= $0.limit } ?? false
        ListScreen {
            if let error = model.list.error {
                Section { StateRow(kind: .failed, text: Words.plainMessage(error), action: ("Retry", { Task { await model.refresh(app) } })) }
            }
            if let listing {
                if listing.tokens.isEmpty {
                    Section { StateRow(kind: .empty, text: "You have no API tokens.", action: ("New token", { creating = true })) }
                } else {
                    Section {
                        ForEach(listing.tokens) { token in
                            NavigationLink(value: Route.token(token.id)) { TokenLine(token: token) }
                        }
                    } header: {
                        Text("\(listing.active) of \(listing.limit) in use")
                    } footer: {
                        if full { Text("Revoke a token you no longer use first.") }
                    }
                }
            } else if model.list.error == nil {
                Section { StateRow(kind: .loading, text: "Loading your tokens…") }
            }
        }
        .poll(every: { Words.idleRefresh }) { _ in await model.refresh(app) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Image(systemName: "plus").accessibilityLabel("New token") }
                    .disabled(listing == nil || full)
            }
        }
        .helpButton("api-tokens")
        .sheet(isPresented: $creating) {
            NewTokenSheet(limitDays: listing?.maxDays ?? TokenRules.mostDays) { await model.refresh(app) }
        }
        .screenTitle("API tokens")
    }
}

/// A token in a list: its name, and how long it has.
struct TokenLine: View {
    @Environment(\.theme) private var theme
    let token: APIToken

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: token.name)
                Text(life).font(.footnote).foregroundStyle(theme.ink3)
            }
            Spacer()
            StatusText(look)
        }
        .accessibilityElement(children: .combine)
    }

    var look: Look {
        token.status == "active" ? Look(.good, "check-circle", "Active")
            : token.status == "revoked" ? Look(.bad, "ban", "Revoked") : Look(.idle, "clock", "Expired")
    }

    var life: String {
        let now = Date()
        if token.status == "revoked" { return "Revoked \(Words.timeAgo(token.revokedAt, now: now))" }
        if token.status == "expired" { return "Expired \(Words.timeAgo(token.expiresAt, now: now))" }
        let left = (ConsoleTime.date(token.expiresAt)?.timeIntervalSince(now)) ?? 0
        return "Expires in \(Words.duration(max(0, left)))"
    }
}

/// One token, and revoking it.
struct TokenView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let id: String
    @StateObject private var model = TokensModel()
    @State private var revoking = false

    var body: some View {
        let token = model.list.value?.tokens.first { $0.id == id }
        ListScreen {
            if let token {
                Section {
                    HStack {
                        Text(verbatim: token.name).font(.headline)
                        Spacer()
                        StatusText(TokenLine(token: token).look)
                    }
                    HStack {
                        Text("ID")
                        Spacer()
                        Text(verbatim: token.id).font(Typeface.hash).foregroundStyle(theme.ink2)
                    }
                    ValueRow("Made", Words.dateAndTime(token.createdAt))
                    ValueRow(token.status == "revoked" ? "Revoked" : token.status == "expired" ? "Expired" : "Expires",
                             Words.dateAndTime(token.status == "revoked" ? token.revokedAt : token.expiresAt))
                }
            } else if model.list.value != nil {
                Section { StateRow(kind: .empty, text: "You have no token with this ID.") }
            } else {
                Section { StateRow(kind: .loading, text: "Loading…") }
            }
        }
        .task { await model.refresh(app) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    NavigationLink(value: Route.help("api-tokens")) { Label("Help", systemImage: "questionmark.circle") }
                    if token?.status == "active" {
                        Button(role: .destructive) { revoking = true } label: { Label("Revoke…", systemImage: "nosign") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel("More")
                }
            }
        }
        .sheet(isPresented: $revoking) {
            if let token { RevokeTokenSheet(token: token) { await model.refresh(app) } }
        }
        .screenTitle(token?.name ?? "Token", large: false)
    }
}

/// Making an API token: a name and a lifetime, then the token itself, once.
struct NewTokenSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    let limitDays: Int
    let made: () async -> Void
    @StateObject private var change = ChangeRunner()
    @State private var name = ""
    @State private var days = String(TokenRules.usualDays)
    @State private var token: NewToken?

    var body: some View {
        NavigationStack {
            ListScreen {
                if let token {
                    shown(token)
                } else {
                    form
                }
            }
            .navigationTitle(token == nil ? "New token" : "Your new token")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: token == nil ? .cancellationAction : .confirmationAction) {
                    Button(token == nil ? "Cancel" : "Done") { dismiss() }.disabled(change.busy)
                }
            }
        }
        // Once it is shown, only Done closes it: a swipe would lose a token that cannot be shown again.
        .interactiveDismissDisabled(token != nil || change.busy || change.asking)
    }

    @ViewBuilder private var form: some View {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let lifetime = TokenRules.days(days)
        Section {
            TextField("Name", text: $name)
                .onChange(of: name) { value in if value.count > TokenRules.nameLimit { name = String(value.prefix(TokenRules.nameLimit)) } }
                .disabled(change.busy)
            HStack {
                Text("Valid for")
                TextField("30", text: $days)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .multilineTextAlignment(.trailing)
                    .disabled(change.busy)
                Text("days").foregroundStyle(theme.ink3)
            }
        } footer: {
            Text("What it is for, and \(TokenRules.leastDays) to \(min(limitDays, TokenRules.mostDays)) days. It cannot be extended.")
        }
        if let error = change.error {
            Section { StateRow(kind: .failed, text: error) }
        }
        if change.asking || change.signingIn {
            Section { FreshSignInPrompt(change: change, what: "new token") }
        }
        Section {
            PrimaryButton(change.busy ? "Making…" : "Make token", systemImage: "key", busy: change.busy) {
                guard let lifetime else { return }
                Task {
                    if let made = await change.run(app, refusal: "No token was made.", { api in
                        try await api.createToken(name: trimmed, days: lifetime)
                    }) {
                        token = made
                        await self.made()
                    }
                }
            }
            .disabled(trimmed.isEmpty || lifetime == nil || change.busy || change.asking)
        }
    }

    @ViewBuilder
    private func shown(_ token: NewToken) -> some View {
        Section {
            HStack(alignment: .top) {
                Text(verbatim: token.token).font(Typeface.hash).textSelection(.enabled)
                Spacer()
                CopyButton(value: token.token, label: "the token")
            }
        } footer: {
            Text("Copy it now: you won't see it again.").foregroundStyle(theme.warn)
        }
        Section {
            ValueRow("Name", token.name)
            HStack {
                Text("ID")
                Spacer()
                Text(verbatim: token.id).font(Typeface.hash).foregroundStyle(theme.ink2)
            }
            ValueRow("Expires", token.expiresAt.map(Words.dateAndTime) ?? "—")
        }
        Section {
            NavigationLink("How to use it", value: Route.help("api-tokens"))
        }
    }
}

struct RevokeTokenSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    let token: APIToken
    let done: () async -> Void
    @StateObject private var change = ChangeRunner()

    var body: some View {
        NavigationStack {
            ListScreen {
                Section {
                    Text("A script that uses it is refused from its next request on.")
                    Text("What it has done stays done, and stays in the activity log.")
                    Text("This cannot be undone.")
                }
                .font(.subheadline)
                if let error = change.error {
                    Section { StateRow(kind: .failed, text: error) }
                }
                if change.asking || change.signingIn {
                    Section { FreshSignInPrompt(change: change, what: "revocation") }
                }
                Section {
                    PrimaryButton(change.busy ? "Revoking…" : "Revoke token", systemImage: "nosign", role: .destructive,
                                  busy: change.busy) {
                        let id = token.id
                        Task {
                            if await change.run(app, refusal: "Not revoked.", { api in try await api.revokeToken(id: id) }) != nil {
                                app.say("Revoked “\(token.name)”.")
                                await done()
                                dismiss()
                            }
                        }
                    }
                    .disabled(change.busy || change.asking)
                }
            }
            .navigationTitle("Revoke “\(token.name)”")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Keep it") { dismiss() }.disabled(change.busy) }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking)
    }
}

/// The project's commits, newest first.
struct HistoryView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @State private var history = Loadable<CommitHistory?>()
    @State private var tag = "all"

    var body: some View {
        ListScreen {
            if let error = history.error {
                Section { StateRow(kind: .failed, text: Words.plainMessage(error), action: ("Retry", { Task { await load() } })) }
            }
            if let value = history.value {
                if let value {
                    Section {
                        if let commit = value.builtFrom {
                            HStack {
                                Text("Console built from")
                                Spacer()
                                Text(verbatim: String(commit.prefix(7))).font(Typeface.hash).foregroundStyle(theme.ink2)
                            }
                        }
                        if let deployed = value.deployedAt { ValueRow("Deployed", Words.timeAgo(deployed, now: Date())) }
                    }
                    ForEach(days(value.commits.filter { tag == "all" || $0.tags.contains(tag) }), id: \.day) { group in
                        Section(group.day) {
                            ForEach(group.commits) { commit in
                                Button {
                                    if let link = commit.link { openURL(link) }
                                } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(verbatim: commit.subject).foregroundStyle(theme.ink).multilineTextAlignment(.leading)
                                        HStack(spacing: 8) {
                                            Text(verbatim: commit.short).font(Typeface.hash)
                                            Text(commit.tags.compactMap(CommitHistory.tagLabel).joined(separator: ", "))
                                        }
                                        .font(.caption)
                                        .foregroundStyle(theme.ink3)
                                    }
                                }
                                .accessibilityHint("Opens the commit on GitHub")
                            }
                        }
                    }
                } else {
                    Section { StateRow(kind: .empty, text: "This console was deployed without its history.") }
                }
            } else if history.error == nil {
                Section { StateRow(kind: .loading, text: "Loading the history…") }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Show", selection: $tag) {
                        Text("All").tag("all")
                        ForEach(CommitHistory.tags, id: \.id) { Text($0.label).tag($0.id) }
                    }
                } label: {
                    Image(systemName: tag == "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                        .accessibilityLabel("Filter")
                }
            }
        }
        .screenTitle("History")
    }

    private func load() async {
        guard let api = app.api else { return }
        history.loading = true
        do {
            history = Loadable(value: .some(try await api.history()), loadedAt: Date())
        } catch {
            history.loading = false
            history.error = error
        }
    }

    private func days(_ commits: [CommitHistory.Commit]) -> [(day: String, commits: [CommitHistory.Commit])] {
        let now = Date()
        var order: [String] = []
        var grouped: [String: [CommitHistory.Commit]] = [:]
        for commit in commits {
            let day = Words.dayLabel(commit.date, now: now)
            if grouped[day] == nil { order.append(day) }
            grouped[day, default: []].append(commit)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }
}
