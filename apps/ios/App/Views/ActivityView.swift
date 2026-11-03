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
        // How a deployment ended is not in the log: it follows from the deployment.
        if app.deployments.due(full) { await app.loadDeployments() }
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

/// The website's Activity page.
struct ActivityView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model = ActivityModel()

    var body: some View {
        Page {
            PageHead(lede: "Every upload, deployment, cancellation and revocation made through this console’s API, with who asked for it and whether it went through. A job made directly in AWS IoT does not pass through that API, so it is not in this log, though its board’s page lists it. A deployment that is over shows how it ended. This console has no way to change an entry.")
            Freshness(loadedAt: model.loadedAt, interval: model.interval, loading: model.loading)
            if let error = model.error {
                LoadProblem(what: "the activity log", error: error, loadedAt: model.loadedAt) {
                    Task { await model.refresh(app, full: true) }
                }
            }
            if let entries = model.entries {
                if entries.isEmpty {
                    Card {
                        EmptyState(icon: "list", title: "Nothing has been recorded yet.",
                                   text: "Uploads, deployments, cancellations and revocations made through this console’s API will appear here, including attempts that were refused.")
                    }
                } else {
                    summary(entries)
                    if entries.contains(where: { Words.describeAudit($0).scripted }) {
                        Text("\(Words.scriptedTag): \(Words.scriptedNote)").font(Typeface.tiny).foregroundStyle(theme.ink3)
                    }
                    days(entries)
                    if model.next != nil {
                        Button(model.loadingMore ? "Loading…" : "Load more") { Task { await model.loadMore(app) } }
                            .consoleButton(wide: true)
                            .disabled(model.loadingMore)
                    } else {
                        Text("That is every entry in this log.").font(Typeface.small).foregroundStyle(theme.ink3)
                    }
                    if let error = model.moreError {
                        Notice(.bad, "x-circle", Words.failure("Could not load more.", error))
                    }
                }
            } else if model.error == nil {
                Loading(what: "activity")
            }
        }
        .poll(every: { model.interval }) { full in await model.refresh(app, full: full) }
        .consoleTitle("Activity")
    }

    /// What the entries on this page are about. It only counts what has been loaded, and says so.
    private func summary(_ entries: [AuditEntry]) -> some View {
        func count(_ action: String) -> Int { entries.filter { $0.action == action }.count }
        let refused = entries.filter { $0.outcome != "ok" }.count
        let said = [
            (count("firmware.upload"), "upload", "uploads"),
            (count("deployment.create"), "deployment", "deployments"),
            (count("deployment.cancel"), "cancellation", "cancellations"),
            (count("firmware.revoke"), "revocation", "revocations"),
            (count("firmware.bluetooth_send"), "send over Bluetooth", "sends over Bluetooth"),
        ].filter { $0.0 > 0 }.map { Words.plural($0.0, $0.1, $0.2) }
        let scope = model.next != nil ? "The latest \(Words.plural(entries.count, "entry", "entries"))"
            : entries.count == 1 ? "The only entry" : "All \(entries.count) entries"
        return VStack(alignment: .leading, spacing: 6) {
            Text(([scope] + said).joined(separator: " · ")).font(Typeface.small).foregroundStyle(theme.ink2)
            if refused > 0 {
                StatusLine(tone: .warn, icon: "alert", title: "\(refused) refused or failed").font(Typeface.small)
            }
        }
    }

    private func days(_ entries: [AuditEntry]) -> some View {
        let now = Date()
        var order: [String] = []
        var grouped: [String: [AuditEntry]] = [:]
        for entry in entries {
            let day = Words.dayLabel(entry.at, now: now)
            if order.last != day && grouped[day] == nil { order.append(day) }
            grouped[day, default: []].append(entry)
        }
        return LazyVStack(alignment: .leading, spacing: 22) {
            ForEach(order, id: \.self) { day in
                Card(day) {
                    VStack(spacing: 0) {
                        ForEach(grouped[day] ?? []) { entry in
                            ActivityLine(entry: entry, compact: false).padding(.vertical, 10)
                            RowRule()
                        }
                    }
                }
            }
        }
    }
}

/// One line of the activity log: who did what, to what, and how it ended if not well.
struct ActivityLine: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let entry: AuditEntry
    let compact: Bool

    var body: some View {
        let words = Words.describeAudit(entry)
        // How a deployment that it started ended follows from the deployment as it is now.
        let run = entry.action == "deployment.create" && entry.outcome == "ok"
            ? (app.deployments.value ?? []).first { $0.id == entry.target } : nil
        let ending = run.flatMap { Words.isUnderWay($0) ? nil : Words.describeDeployment($0) }
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: Icon.symbol(words.icon))
                .font(.footnote)
                .foregroundStyle(words.outcome.map { theme.tone($0.tone) } ?? theme.ink2)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                (Text(Words.nameOf(entry.actor)).fontWeight(.semibold) + Text(" \(words.verb) ")
                 + Text(words.label).font(Typeface.mono))
                    .font(Typeface.body)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if let outcome = words.outcome { Badge(outcome) }
                    if let ending { Badge(ending) }
                    if words.scripted { Tag(text: Words.scriptedTag, tone: .warn) }
                }
                if !compact {
                    ForEach(words.facts) { fact in
                        factLine(fact)
                    }
                    let refs = [entry.actor.map { $0.sub.isEmpty ? nil : "Account \(Words.shortAccount($0.sub))" } ?? nil,
                                entry.requestId.isEmpty ? nil : "Request \(entry.requestId)"].compactMap { $0 }
                    if !refs.isEmpty {
                        Text(refs.joined(separator: " · ")).font(Typeface.tiny).foregroundStyle(theme.ink3).textSelection(.enabled)
                    }
                }
                link(words)
            }
            Spacer(minLength: 0)
            Text(compact ? Words.timeAgo(entry.at, now: Date()) : Words.timeOfDay(entry.at))
                .font(Typeface.tiny).foregroundStyle(theme.ink3)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func factLine(_ fact: AuditWords.Fact) -> some View {
        if fact.key == "sha256" {
            HStack(spacing: 4) {
                Text("\(fact.label) ").font(Typeface.small).foregroundStyle(theme.ink2)
                CopyRow(value: fact.value, label: "the SHA-256", shown: "\(fact.value.prefix(12))…")
            }
        } else if let words = fact.words {
            Text("\(words).").font(Typeface.small).foregroundStyle(theme.ink2)
        } else {
            (Text(fact.phrase ? "\(fact.label) " : "\(fact.label): ") + Text(fact.value).font(fact.code ? Typeface.mono : Typeface.small))
                .font(Typeface.small).foregroundColor(theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func link(_ words: AuditWords) -> some View {
        switch words.link {
        case .deployment(let id)?:
            NavigationLink(value: Route.deployment(id)) { open("Open the deployment") }.buttonStyle(.plain)
        case .firmware?:
            if Lenient.isVersion(entry.target) {
                NavigationLink(value: Route.release(entry.target)) { open("Open the release") }.buttonStyle(.plain)
            }
        case nil:
            if entry.action == "pairing.read", let thing = entry.detail.first(where: { $0.key == "thing" })?.value, BoardName.isThing(thing) {
                NavigationLink(value: Route.board(thing)) { open("Open the board") }.buttonStyle(.plain)
            }
        }
    }

    private func open(_ text: String) -> some View {
        HStack(spacing: 3) {
            Text(text)
            Image(systemName: "chevron.right").font(.caption2.weight(.bold))
        }
        .font(Typeface.small.weight(.semibold))
        .foregroundStyle(theme.ink)
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

/// The website's API tokens page.
struct TokensView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @StateObject private var model = TokensModel()
    @State private var creating = false
    @State private var revoking: APIToken?

    var body: some View {
        let listing = model.list.value
        let full = listing.map { $0.active >= $0.limit } ?? false
        Page {
            PageHead(lede: "A token lets a script use this console’s API as you, without signing in, until it expires or you revoke it. Each person makes and sees only their own.")
            Freshness(loadedAt: model.list.loadedAt, interval: 0, loading: model.list.loading)
            if let error = model.list.error {
                LoadProblem(what: "your API tokens", error: error, loadedAt: model.list.loadedAt) { Task { await model.refresh(app) } }
            }
            Card("Your tokens") {
                if let listing {
                    Text("\(Words.plural(listing.active, "token")) in use, of the \(listing.limit) you may have.\(app.canWrite ? "" : " You are a viewer, so your tokens can only read.")")
                        .font(Typeface.small).foregroundStyle(theme.ink2)
                }
                Button { creating = true } label: { Label("New token", systemImage: "plus") }
                    .consoleButton(.primary, wide: true)
                    .disabled(listing == nil || full)
                if full { Text("Revoke a token you no longer use first.").font(Typeface.tiny).foregroundStyle(theme.ink3) }
                if let listing {
                    if listing.tokens.isEmpty {
                        EmptyState(icon: "key", title: "You have no API tokens.",
                                   text: "Make one for a script that should use the console as you, such as scripts/ota.sh.")
                    } else {
                        VStack(spacing: 0) {
                            ForEach(listing.tokens) { token in
                                TokenRow(token: token) { revoking = token }
                                RowRule()
                            }
                        }
                    }
                } else if model.list.error == nil {
                    Loading(what: "your API tokens")
                }
            }
            Card("Using a token") {
                VStack(alignment: .leading, spacing: 8) {
                    point("Send it as Authorization: Bearer crn_… to the API under /api/t/: GET /api/t/firmware answers what GET /api/firmware does for you here.")
                    point("scripts/ota.sh uses the token in ~/.cranium/console-token (readable by you alone: chmod 600), or in CRANIUM_TOKEN.")
                    point("It acts as you, with what you may do at that moment: a viewer’s token only reads, and if your account loses a role or is disabled, its tokens lose it at once.")
                    point("A change made with a token is in the activity log under your name, with the token’s ID. A token cannot make or revoke tokens, or read a board’s Bluetooth passkey.")
                }
            }
        }
        .poll(every: { Words.idleRefresh }) { _ in await model.refresh(app) }
        .sheet(isPresented: $creating) {
            NewTokenSheet(limitDays: listing?.maxDays ?? TokenRules.mostDays) { await model.refresh(app) }
        }
        .sheet(item: $revoking) { token in
            RevokeTokenSheet(token: token) { await model.refresh(app) }
        }
        .consoleTitle("API tokens")
    }

    private func point(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("·").foregroundStyle(theme.ink3)
            Text(text).font(Typeface.small).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct TokenRow: View {
    @Environment(\.theme) private var theme
    let token: APIToken
    let revoke: () -> Void

    var body: some View {
        let look: Look = token.status == "active" ? Look(.good, "check-circle", "Active")
            : token.status == "revoked" ? Look(.bad, "ban", "Revoked") : Look(.idle, "clock", "Expired")
        let now = Date()
        let life: String = {
            if token.status == "revoked" { return "Revoked \(Words.timeAgo(token.revokedAt, now: now))" }
            if token.status == "expired" { return "Expired \(Words.timeAgo(token.expiresAt, now: now))" }
            let left = (ConsoleTime.date(token.expiresAt)?.timeIntervalSince(now)) ?? 0
            return "Expires in \(Words.duration(max(0, left))) (\(Words.dateAndTime(token.expiresAt)))"
        }()
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(verbatim: token.name).font(Typeface.body.weight(.semibold))
                Badge(look)
            }
            Text("ID \(token.id) · Made \(Words.timeAgo(token.createdAt, now: now)) · \(life)")
                .font(Typeface.small).foregroundStyle(theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
            if token.status == "active" {
                Button(action: revoke) { Label("Revoke", systemImage: "nosign") }
                    .consoleButton()
                    .accessibilityLabel("Revoke the token \(token.name)")
            }
        }
        .padding(.vertical, 10)
        .opacity(token.status == "active" ? 1 : 0.75)
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
            Page {
                if let token {
                    shown(token)
                } else {
                    form
                }
            }
            .navigationTitle(token == nil ? "New API token" : "Your new API token")
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
        let hint = trimmed.isEmpty ? "Give it a name first." : lifetime == nil ? "Choose \(TokenRules.leastDays) to \(TokenRules.mostDays) days." : nil
        Text("A script that has this token can use the console’s API as you, with what you may do at that moment.")
            .font(Typeface.body).fixedSize(horizontal: false, vertical: true)
        VStack(alignment: .leading, spacing: 6) {
            Text("Name (required)").font(Typeface.small.weight(.semibold))
            TextField("The computer or script that uses it", text: $name)
                .padding(10)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(theme.lineField, lineWidth: 1))
                .onChange(of: name) { value in if value.count > TokenRules.nameLimit { name = String(value.prefix(TokenRules.nameLimit)) } }
                .disabled(change.busy)
            Text("What it is for: the computer or the script that uses it. Up to \(TokenRules.nameLimit) characters.")
                .font(Typeface.tiny).foregroundStyle(theme.ink3)
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("Valid for, in days").font(Typeface.small.weight(.semibold))
            TextField("30", text: $days)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .padding(10)
                .frame(maxWidth: 120)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(theme.lineField, lineWidth: 1))
                .disabled(change.busy)
            Text("From \(TokenRules.leastDays) to \(min(limitDays, TokenRules.mostDays)). A token cannot be extended: make a new one when it runs out.")
                .font(Typeface.tiny).foregroundStyle(theme.ink3)
        }
        if let error = change.error { Notice(.bad, "x-circle", error, more: change.errorRef) }
        FreshSignInPrompt(change: change, what: "new token")
        if let hint { Text(hint).font(Typeface.tiny).foregroundStyle(theme.ink3) }
        Button {
            guard let lifetime else { return }
            Task {
                if let made = await change.run(app, refusal: "No token was made.", { api in
                    try await api.createToken(name: trimmed, days: lifetime)
                }) {
                    token = made
                    await self.made()
                }
            }
        } label: {
            Label(change.busy ? "Making…" : "Make token", systemImage: "key")
        }
        .consoleButton(.primary, wide: true)
        .disabled(hint != nil || change.busy || change.asking)
    }

    @ViewBuilder
    private func shown(_ token: NewToken) -> some View {
        Notice(.warn, "alert", "Copy it now: you won’t see this token again. The console keeps only a digest of it, from which it cannot be read back.")
        HStack(alignment: .top) {
            Text(verbatim: token.token)
                .font(Typeface.mono)
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.well, in: RoundedRectangle(cornerRadius: 4))
            CopyButton(value: token.token, label: "the token")
        }
        VStack(spacing: 0) {
            Fact("Name") { Text(verbatim: token.name) }
            Fact("ID") {
                Mono(token.id)
                FactNote("How the list and the activity log name it.")
            }
            Fact("Expires") { Text(token.expiresAt.map(Words.dateAndTime) ?? "—") }
        }
        Text("Keep it like a password. For scripts/ota.sh, put it in ~/.cranium/console-token and make that file readable by you alone, for example on a Mac after copying:")
            .font(Typeface.small).fixedSize(horizontal: false, vertical: true)
        Mono("mkdir -p ~/.cranium && (umask 077 && pbpaste > ~/.cranium/console-token)", font: Typeface.mono)
            .padding(8)
            .background(theme.well, in: RoundedRectangle(cornerRadius: 4))
    }
}

struct RevokeTokenSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    let token: APIToken
    let done: () async -> Void
    @StateObject private var change = ChangeRunner()

    var body: some View {
        NavigationStack {
            Page {
                VStack(spacing: 0) {
                    Fact("ID") { Mono(token.id) }
                    Fact("Made") { Text(Words.timeAgo(token.createdAt, now: Date())) }
                    Fact("Expires") { Text(Words.dateAndTime(token.expiresAt)) }
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(["A script that uses it is refused from its next request on.",
                             "What it has done stays done, and stays in the activity log.",
                             "This cannot be undone. A script that still needs access needs a new token."], id: \.self) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("·").foregroundStyle(theme.ink3)
                            Text(line).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if let error = change.error { Notice(.bad, "x-circle", error, more: change.errorRef) }
                FreshSignInPrompt(change: change, what: "revocation")
                Button(role: .destructive) {
                    let id = token.id
                    Task {
                        if await change.run(app, refusal: "Not revoked.", { api in try await api.revokeToken(id: id) }) != nil {
                            app.say("Revoked the token “\(token.name)”.")
                            await done()
                            dismiss()
                        }
                    }
                } label: {
                    Label(change.busy ? "Revoking…" : "Revoke token", systemImage: "nosign")
                }
                .consoleButton(.danger, wide: true)
                .disabled(change.busy || change.asking)
            }
            .navigationTitle("Revoke the token “\(token.name)”?")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Keep the token") { dismiss() }.disabled(change.busy) }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking)
    }
}

/// The website's History page: the project's commits, and what the console was built from.
struct HistoryView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    @Environment(\.openURL) private var openURL
    @State private var history = Loadable<CommitHistory?>()
    @State private var tag = "all"

    var body: some View {
        Page {
            PageHead(lede: "The project’s commits, newest first, and what this deployment of the console was built from.")
            if let error = history.error {
                LoadProblem(what: "the history", error: error) { Task { await load() } }
            }
            if let value = history.value {
                if let value {
                    built(value)
                    Picker("Show", selection: $tag) {
                        Text("All").tag("all")
                        ForEach(CommitHistory.tags, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    .pickerStyle(.menu)
                    let shown = value.commits.filter { tag == "all" || $0.tags.contains(tag) }
                    Card(Words.plural(shown.count, "commit")) {
                        commits(shown)
                    }
                } else {
                    Card { EmptyState(icon: "list", title: "No history in this deployment.",
                                      text: "The console was deployed without its history file.") }
                }
            } else if history.error == nil {
                Loading(what: "the history")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .consoleTitle("History")
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

    private func built(_ value: CommitHistory) -> some View {
        Notice(.idle, "package", value.builtFrom.map { "This console was built from \($0.prefix(7))\(value.tree == "dirty" ? ", with changes that were not committed" : "")." }
               ?? "Which commit this console was built from is not recorded.",
               more: value.deployedAt.map { "Deployed \(Words.timeAgo($0, now: Date()))." })
    }

    private func commits(_ shown: [CommitHistory.Commit]) -> some View {
        let now = Date()
        var order: [String] = []
        var grouped: [String: [CommitHistory.Commit]] = [:]
        for commit in shown {
            let day = Words.dayLabel(commit.date, now: now)
            if grouped[day] == nil { order.append(day) }
            grouped[day, default: []].append(commit)
        }
        return LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(order, id: \.self) { day in
                Text(day).font(Typeface.small.weight(.semibold)).foregroundStyle(theme.ink2)
                    .padding(.top, 12).padding(.bottom, 4)
                ForEach(grouped[day] ?? []) { commit in
                    Button {
                        if let link = commit.link { openURL(link) }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: commit.subject).font(Typeface.body).multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 6) {
                                Mono(commit.short, font: Typeface.mono).underline()
                                Text(Words.timeOfDay(commit.date)).font(Typeface.tiny).foregroundStyle(theme.ink3)
                                ForEach(commit.tags, id: \.self) { Tag(text: CommitHistory.tagLabel($0) ?? $0) }
                            }
                        }
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the commit on GitHub")
                    RowRule()
                }
            }
        }
    }
}
