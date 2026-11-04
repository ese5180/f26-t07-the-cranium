import CraniumKit
import SwiftUI

/// Releases offered to boards over the internet.
struct DeploymentsView: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        let deployable = app.firmware.value == nil || (app.releases ?? []).contains(where: \.isActive)
        ListScreen {
            if StaleNote.shows(loadedAt: app.deployments.loadedAt, error: app.deployments.error, every: app.deploymentsInterval) {
                Section {
                    StaleNote(loadedAt: app.deployments.loadedAt, error: app.deployments.error, every: app.deploymentsInterval) {
                        Task { await app.refreshDeployments(full: true) }
                    }
                }
            }
            if let deployments = app.deployments.value {
                if deployments.isEmpty {
                    Section {
                        if app.canWrite && deployable {
                            StateRow(kind: .empty, text: "No deployments yet.", action: ("New deployment", start))
                        } else {
                            StateRow(kind: .empty, text: "No deployments yet.")
                        }
                    }
                } else {
                    let underWay = deployments.filter(Words.isUnderWay).count
                    Section {
                        ForEach(deployments) { deployment in
                            NavigationLink(value: Route.deployment(deployment.id)) { DeploymentLine(deployment: deployment) }
                        }
                    } header: {
                        Text(underWay > 0 ? "\(underWay) under way" : Words.plural(deployments.count, "deployment"))
                    }
                }
            } else if app.deployments.error == nil {
                Section { StateRow(kind: .loading, text: "Loading deployments…") }
            }
        }
        .poll(every: { app.deploymentsInterval }) { full in await app.refreshDeployments(full: full) }
        .toolbar {
            if app.canWrite && deployable {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: start) { Image(systemName: "plus").accessibilityLabel("New deployment") }
                }
            }
        }
        .helpButton("deployments")
        .screenTitle("Deployments")
    }

    private func start() {
        app.deployingThings = []
        app.deploying = ""
    }
}

/// A deployment in a list: its version, its state, when, and how many boards.
struct DeploymentLine: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let deployment: Deployment

    var body: some View {
        let look = Words.describeDeployment(deployment, devices: app.deviceList)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VersionText(deployment.version ?? "unknown")
                Spacer()
                StatusText(look)
            }
            Text("\(Words.timeAgo(deployment.createdAt, now: Date())) · \(Words.plural(deployment.things.count, "board"))")
                .font(.footnote).foregroundStyle(theme.ink3)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One deployment: its state, and each board's part, live.
struct DeploymentView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let id: String
    @State private var cancelling = false

    var body: some View {
        let resource = app.deploymentDetails[id] ?? Loadable()
        ListScreen {
            if let deployment = resource.value {
                content(deployment, resource: resource)
            } else if let error = resource.error as? APIError, error.status == 404 {
                Section { StateRow(kind: .empty, text: "There is no deployment with this id.") }
            } else if let error = resource.error {
                Section { StateRow(kind: .failed, text: Words.plainMessage(error), action: ("Retry", { Task { await app.loadDeployment(id) } })) }
            } else {
                Section { StateRow(kind: .loading, text: "Loading the deployment…") }
            }
        }
        .poll(every: { interval }) { full in await app.refreshDeployment(id, full: full) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) { menu }
        }
        .sheet(isPresented: $cancelling) {
            if let deployment = app.deploymentDetails[id]?.value { CancelSheet(deployment: deployment) }
        }
        .navigationTitle(DeploymentId.version(of: id).map { "Deployment of \($0)" } ?? "Deployment")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// Every 3 s while a board is at work, every 10 s while boards wait, else now and then.
    private var interval: TimeInterval {
        guard let detail = app.deploymentDetails[id]?.value else { return Words.pollWaiting }
        var statuses: [String?] = detail.executions.map(Words.executionActivity)
        let now = Date()
        if detail.executions.contains(where: { Words.stillSettling($0, board: app.device($0.thing), deployment: id, now: now) }) {
            statuses.append("IN_PROGRESS")
        }
        let interval = Words.pollInterval(statuses)
        return interval > 0 ? interval : Words.idleRefresh
    }

    private var menu: some View {
        let deployment = app.deploymentDetails[id]?.value
        let unfinished = deployment?.executions.contains { Words.isUnfinished($0.status) } ?? false
        let withdrawn = unfinished && deployment?.status == "CANCELED"
        return Menu {
            CopyMenuItem(value: id, label: "Copy the deployment ID")
            NavigationLink(value: Route.help("deployments")) { Label("Help", systemImage: "questionmark.circle") }
            if app.canWrite && unfinished {
                Button(role: .destructive) { cancelling = true } label: {
                    Label(withdrawn ? "Stop boards that have started…" : "Cancel deployment…", systemImage: "stop.circle")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle").accessibilityLabel("More")
        }
    }

    @ViewBuilder
    private func content(_ deployment: Deployment, resource: Loadable<Deployment>) -> some View {
        let summary = Words.describeDeployment(deployment, devices: app.deviceList)
        let unfinished = deployment.executions.contains { Words.isUnfinished($0.status) }
        let withdrawn = unfinished && deployment.status == "CANCELED"
        let release = app.releases?.first { $0.version == deployment.version }
        let boards = app.deviceList
        let shortOfDone = !unfinished && !Words.isUnderWay(deployment) && deployment.executions.contains { execution in
            Words.describeExecution(execution, board: boards?.first { $0.thing == execution.thing }, deployment: id,
                                    version: deployment.version, unread: boards == nil).retry
        }
        let offerAgain = shortOfDone && app.canWrite && release?.isActive == true
        let cancelEntry = deployment.status == "CANCELED"
            ? (app.audit.value?.entries ?? []).last { $0.action == "deployment.cancel" && $0.outcome == "ok" && $0.target == id }
            : nil
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    VersionText(deployment.version ?? "unknown")
                    Spacer()
                    StatusText(summary)
                }
                if !deployment.note.isEmpty { Text(verbatim: deployment.note).font(.subheadline) }
                Text(Words.startedBy(deployment, now: Date()) + (deployment.completedAt.map { ", finished \(Words.timeAgo($0, now: Date()))" } ?? ""))
                    .font(.footnote).foregroundStyle(theme.ink3)
                if let cancelEntry {
                    Text("Cancelled \(Words.timeAgo(cancelEntry.at, now: Date())) by \(Words.nameOf(cancelEntry.actor))")
                        .font(.footnote).foregroundStyle(theme.ink3)
                }
            }
            .padding(.vertical, 2)
        }
        if StaleNote.shows(loadedAt: resource.loadedAt, error: resource.error, every: interval) {
            Section {
                StaleNote(loadedAt: resource.loadedAt, error: resource.error, every: interval) { Task { await app.loadDeployment(id) } }
            }
        }
        if withdrawn {
            Section {
                StatusText(.idle, "stop", deployment.executions.contains { $0.status == "IN_PROGRESS" }
                           ? "Cancelled. A board that had started carries on unless it is stopped."
                           : "Cancelled. AWS takes a few seconds to withdraw the offer.")
            }
        }
        if let release, let mark = release.revoked {
            Section {
                NavigationLink(value: Route.release(release.version)) {
                    StatusText(.idle, "ban", "\(release.version) was revoked \(Words.timeAgo(mark.at, now: Date()))")
                }
            }
        }
        if offerAgain, let version = deployment.version {
            Section {
                PrimaryButton("Offer again", systemImage: "paperplane") {
                    app.deployingThings = []
                    app.deploying = version
                }
            }
        }
        Section {
            if deployment.executions.isEmpty {
                Text("AWS IoT has not listed any board yet.").foregroundStyle(theme.ink3)
            }
            ForEach(deployment.executions) { execution in
                UpdateRow(execution: execution, deployment: deployment, device: app.device(execution.thing))
            }
        } header: {
            Text(deployment.executions.count > 1 ? Words.countSentence(deployment.counts) : "Board")
        }
    }
}

/// One board's part in a deployment: what it is doing, its steps, and what happened when.
struct ExecutionView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let id: String
    let thing: String

    var body: some View {
        let deployment = app.deploymentDetails[id]?.value
        let execution = deployment?.executions.first { $0.thing == thing }
        ListScreen {
            if let deployment, let execution {
                content(execution, deployment)
            } else {
                Section { StateRow(kind: .loading, text: "Loading…") }
            }
        }
        .poll(every: { Words.pollInstalling }) { full in await app.refreshDeployment(id, full: full) }
        .helpButton("wifi-update")
        .screenTitle(app.name(of: thing) ?? Words.shortThing(thing), large: false)
    }

    @ViewBuilder
    private func content(_ execution: Execution, _ deployment: Deployment) -> some View {
        let known = app.device(thing)
        let detail = app.deviceDetails[thing]?.value
        let history = detail != nil && detail?.device.fw?.version == execution.reported ? detail?.executions : nil
        let words = Words.describeExecution(execution, board: known, deployment: id, version: deployment.version,
                                            history: history, historyCut: (detail?.olderExecutions ?? 0) > 0 && history != nil,
                                            unread: app.deviceList == nil)
        let revoked = (app.releases ?? []).contains { $0.version == deployment.version && !$0.isActive }
        let next = words.next != nil && app.canWrite && (!revoked || !words.retry) ? words.next : nil
        Section {
            NavigationLink(value: Route.board(thing)) {
                HStack {
                    BoardLabel(thing, name: known?.name)
                    Spacer()
                    if let known { OnlinePill(device: known) }
                }
            }
        }
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    StatusText(words.tone, words.icon, words.said ?? words.title).font(.headline)
                    Spacer()
                    if let progress = words.progress {
                        Text("\(progress)%").font(.title3.weight(.semibold)).monospacedDigit()
                    }
                }
                if let progress = words.progress { ProgressBar(percent: progress) }
                Text(words.text).font(.subheadline).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                if let next { Text(next).font(.subheadline.weight(.semibold)) }
                if let code = words.code {
                    Text(verbatim: "The board gave the reason \(code)").font(.footnote).foregroundStyle(theme.ink3)
                }
                if let note = execution.detail {
                    Text(verbatim: "Board's note: \(note)").font(.footnote).foregroundStyle(theme.ink3)
                }
                if words.tone == .act { ButtonKeys() }
            }
            .padding(.vertical, 4)
            if let other = words.installedBy {
                NavigationLink("Open the deployment that installed it", value: Route.deployment(other))
            }
        }
        Section("Steps") {
            StepList(words: words, viewer: !app.canWrite).padding(.vertical, 4)
        }
        let moments = moments(execution, known: known, words: words)
        if !moments.isEmpty {
            Section("When") {
                ForEach(moments, id: \.label) { moment in
                    ValueRow(moment.label, moment.value)
                }
            }
        }
    }

    private func moments(_ execution: Execution, known: Device?, words: ExecutionWords) -> [(label: String, value: String)] {
        let now = Date()
        let finished = !Words.isUnfinished(execution.status)
        var moments: [(label: String, value: String)] = []
        if let queued = execution.queuedAt { moments.append(("Offered", Words.whenAt(queued, now: now))) }
        if let started = execution.startedAt { moments.append(("Started", Words.whenAt(started, now: now))) }
        if finished && words.tone != .live, let ended = execution.lastUpdatedAt { moments.append(("Ended", Words.whenAt(ended, now: now))) }
        if execution.status == "IN_PROGRESS", let left = execution.secondsLeft {
            moments.append(("Times out in", Words.duration(Double(left))))
        }
        if !execution.online, let seen = known?.lastSeen { moments.append(("Board last seen", Words.timeAgo(seen, now: now))) }
        return moments
    }
}

/// Cancelling a deployment, or stopping the boards of one that was cancelled without force.
struct CancelSheet: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    let deployment: Deployment
    @StateObject private var change = ChangeRunner()
    @State private var force = false

    var body: some View {
        let current = app.deploymentDetails[deployment.id]?.value ?? deployment
        let waiting = current.executions.filter { $0.status == "QUEUED" }.count
        let started = current.executions.filter { $0.status == "IN_PROGRESS" }.count
        let over = waiting + started == 0
        let withdrawn = !over && current.status == "CANCELED"
        let forced = force || withdrawn
        NavigationStack {
            ListScreen {
                if over {
                    Section { Text("Nothing is left to cancel: no board is waiting for this update or installing it.") }
                } else {
                    Section {
                        option(false, chosen: forced, disabled: withdrawn, "Withdraw the offer",
                               withdrawn ? "Done already." : "Boards that have not started are no longer offered it. Boards at work finish.")
                        option(true, chosen: forced, disabled: false, "Withdraw and stop boards",
                               "Boards downloading or checking stop before installing. A board already restarting cannot be stopped.")
                    } header: {
                        Text("\(Words.plural(waiting, "board")) waiting · \(Words.plural(started, "board")) started")
                    } footer: {
                        Text("It cannot be undone; to try again, start a new deployment.")
                    }
                    if let error = change.error {
                        Section { StateRow(kind: .failed, text: error) }
                    }
                    if change.asking || change.signingIn {
                        Section { FreshSignInPrompt(change: change, what: "cancellation") }
                    }
                    Section {
                        PrimaryButton(withdrawn ? (change.busy ? "Stopping…" : "Stop boards")
                                      : change.busy ? "Cancelling…" : forced ? "Cancel and stop boards" : "Cancel the deployment",
                                      role: .destructive, busy: change.busy) {
                            Task { await submit(force: forced, withdrawn: withdrawn, started: started) }
                        }
                        .disabled(change.busy || change.asking)
                    }
                }
            }
            .navigationTitle(withdrawn ? "Stop boards" : "Cancel deployment")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(over || withdrawn ? "Close" : "Keep it") { dismiss() }.disabled(change.busy)
                }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking)
    }

    private func option(_ value: Bool, chosen: Bool, disabled: Bool, _ title: String, _ text: String) -> some View {
        Button {
            force = value
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: chosen == value ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen == value ? theme.accent : theme.ink3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).foregroundStyle(theme.ink)
                    Text(text).font(.footnote).foregroundStyle(theme.ink3)
                }
            }
        }
        .disabled(disabled || change.busy)
        .accessibilityAddTraits(chosen == value ? .isSelected : [])
    }

    private func submit(force: Bool, withdrawn: Bool, started: Int) async {
        let id = deployment.id
        if let after = await change.run(app, refusal: withdrawn ? "The boards were not stopped." : "Not cancelled.", { api in
            try await api.cancel(deployment: id, force: force)
        }) {
            app.deploymentDetails[id] = Loadable(value: after, loadedAt: Date())
            app.say(Words.cancelNotice(force: force, withdrawn: withdrawn, started: started))
            dismiss()
            await app.refreshDeployment(id, full: true)
            await app.loadDeployments()
        } else if let error = change.lastError as? APIError, error.status == 409 {
            await app.loadDeployment(id)
        }
    }
}

/// A new deployment: a release, the boards, and a review.
struct DeployWizard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    let initial: String
    @StateObject private var change = ChangeRunner()
    @State private var step = 0
    @State private var version = ""
    @State private var things: Set<String> = []
    @State private var chosenByHand = false
    @State private var note = ""
    @State private var busy: [String: (deployment: String, version: String?)] = [:]
    @State private var loading = true
    @State private var loadError: Error?
    @State private var gone: String?

    private static let titles = ["Release", "Boards", "Review"]

    var body: some View {
        let releases = (app.releases ?? []).filter(\.isActive)
        let devices = app.deviceList ?? []
        let chosen = devices.filter { things.contains($0.thing) }
        NavigationStack {
            ListScreen {
                if loading {
                    Section { StateRow(kind: .loading, text: "Loading releases and boards…") }
                } else if let loadError {
                    Section { StateRow(kind: .failed, text: Words.plainMessage(loadError), action: ("Retry", { Task { await load() } })) }
                } else if step == 0 {
                    releaseStep(releases)
                } else if step == 1 {
                    boardsStep(devices)
                } else {
                    review(chosen)
                }
                if let error = change.error {
                    Section { StateRow(kind: .failed, text: [error, busyWords].compactMap { $0 }.joined(separator: " ")) }
                }
                if change.asking || change.signingIn {
                    Section { FreshSignInPrompt(change: change, what: "deployment") }
                }
                if step == 2 {
                    Section {
                        PrimaryButton(change.busy ? "Starting…" : "Deploy to \(Words.plural(chosen.count, "board"))",
                                      systemImage: "paperplane", busy: change.busy) {
                            Task { await submit(chosen) }
                        }
                        .disabled(chosen.isEmpty || change.busy || change.asking)
                    }
                }
            }
            .navigationTitle(Self.titles[step])
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if step == 0 {
                        Button("Cancel") { dismiss() }.disabled(change.busy)
                    } else {
                        Button("Back") { step -= 1; change.reset() }.disabled(change.busy)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if step < 2 {
                        Button("Next") {
                            step += 1
                            change.reset()
                            suggest()
                        }
                        .disabled(loading || loadError != nil
                                  || (step == 0 ? !releases.contains { $0.version == version } : chosen.isEmpty))
                    }
                }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking || step > 0)
        .task { await load() }
    }

    @ViewBuilder
    private func releaseStep(_ releases: [FirmwareRelease]) -> some View {
        if let gone {
            Section { StatusText(.warn, "alert", "\(gone) has been revoked, so it cannot be deployed.") }
        }
        if releases.isEmpty {
            Section { StateRow(kind: .empty, text: "No release can be deployed. Upload one first.") }
        } else {
            Section("Which release?") {
                ForEach(releases) { release in
                    Button {
                        version = release.version
                        gone = nil
                    } label: {
                        HStack {
                            ReleaseLine(release: release)
                            Spacer()
                            if release.version == version { Image(systemName: "checkmark").foregroundStyle(theme.accent) }
                        }
                    }
                    .foregroundStyle(theme.ink)
                    .accessibilityAddTraits(release.version == version ? .isSelected : [])
                }
            }
        }
    }

    @ViewBuilder
    private func boardsStep(_ devices: [Device]) -> some View {
        if devices.isEmpty {
            Section { StateRow(kind: .empty, text: "No boards are registered yet.") }
        } else {
            Section {
                ForEach(devices) { device in boardChoice(device) }
            } header: {
                Text("Which boards get \(version)?")
            } footer: {
                let free = devices.filter { busy[$0.thing] == nil }
                if things.isEmpty { Text(free.isEmpty ? "Every board has an unfinished update." : "Choose at least one board.") }
            }
            let selectable = devices.filter { busy[$0.thing] == nil && !Words.alreadyRuns($0, version: version) }
            if selectable.count > 1 {
                let all = selectable.allSatisfy { things.contains($0.thing) }
                Section {
                    Button(all ? "Clear the selection" : "Select all \(selectable.count) available boards") {
                        chosenByHand = true
                        things = all ? [] : things.union(selectable.map(\.thing))
                    }
                }
            }
        }
    }

    private func boardChoice(_ device: Device) -> some View {
        let held = busy[device.thing]
        let chosen = things.contains(device.thing)
        let remark: String? = held != nil ? "Has an unfinished update\(held?.version.map { " to \($0)" } ?? "")"
            : Words.alreadyRuns(device, version: version) ? "Already runs this version or newer: it will refuse"
            : !device.online ? (device.lastSeen == nil ? "Never connected: sees it when it first connects" : "Offline: sees it when it reconnects")
            : nil
        return Button {
            chosenByHand = true
            if chosen { things.remove(device.thing) } else if held == nil { things.insert(device.thing) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen ? theme.accent : theme.ink3)
                VStack(alignment: .leading, spacing: 3) {
                    BoardLabel(device)
                    if let remark {
                        Text(remark).font(.caption).foregroundStyle(held != nil || Words.alreadyRuns(device, version: version) ? theme.warn : theme.ink3)
                    }
                }
                Spacer()
                if let fw = device.fw { VersionText(fw.version).foregroundStyle(theme.ink3) }
            }
        }
        .foregroundStyle(theme.ink)
        .disabled(held != nil || change.busy)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    @ViewBuilder
    private func review(_ chosen: [Device]) -> some View {
        let asking = chosen.filter(Words.asksForButton).count
        Section("Release") {
            VersionText(version)
        }
        Section("Boards") {
            ForEach(chosen) { device in
                HStack {
                    BoardLabel(device)
                    Spacer()
                    OnlinePill(device: device)
                }
            }
        }
        Section {
            TextField("Note (optional)", text: $note)
                .onChange(of: note) { value in if value.count > 200 { note = String(value.prefix(200)) } }
        } footer: {
            Text("Shown with the deployment.")
        }
        Section {
            DisclosureGroup("What happens") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Firmware \(Words.firstWithNoButton) or newer installs it as soon as the board sees it.")
                    if asking > 0 {
                        Text("\(Words.plural(asking, "board runs", "boards run")) older firmware, which waits for Button 1.")
                    }
                    Text("Offline boards see it when they reconnect. It stays open until it is cancelled.")
                    Text("If the new firmware cannot reconnect, the bootloader puts the previous one back.")
                    Text("These boards get no other deployment until this one has finished or been cancelled.")
                }
                .font(.footnote)
                .foregroundStyle(theme.ink2)
            }
        }
    }

    private var busyWords: String? {
        guard let error = change.lastError as? APIError, !error.busyBoards.isEmpty else { return nil }
        return error.busyBoards.map { board in
            "\(app.name(of: board.thing) ?? board.thing): the deployment of \(DeploymentId.version(of: board.deployment) ?? "another release")."
        }.joined(separator: " ")
    }

    /// With a single board to choose from, it is ticked when the boards come up.
    private func suggest() {
        guard !chosenByHand, step == 1 else { return }
        let free = (app.deviceList ?? []).filter { busy[$0.thing] == nil }
        if free.count == 1, !Words.alreadyRuns(free[0], version: version) {
            things = [free[0].thing]
        }
    }

    private func load() async {
        loading = true
        loadError = nil
        defer { loading = false }
        guard let api = app.api else { return }
        do {
            async let firmware = api.firmware()
            async let fleet = api.devices()
            let (list, devices) = try await (firmware, fleet)
            app.firmware = Loadable(value: list, loadedAt: Date())
            app.devices = Loadable(value: devices, loadedAt: Date())
            // Whether a board still has an update open is in the board's own record.
            var found: [String: (deployment: String, version: String?)] = [:]
            try await withThrowingTaskGroup(of: (String, ExecutionSummary?).self) { group in
                for device in devices.devices {
                    group.addTask {
                        let detail = try await api.deviceDetail(thing: device.thing)
                        return (device.thing, detail.executions.first { Words.isUnfinished($0.status) })
                    }
                }
                for try await (thing, open) in group {
                    if let open { found[thing] = (open.deployment, open.version ?? DeploymentId.version(of: open.deployment)) }
                }
            }
            busy = found
            let active = list.releases.filter(\.isActive)
            if version.isEmpty {
                if !initial.isEmpty {
                    if active.contains(where: { $0.version == initial }) {
                        version = initial
                        step = 1
                    } else {
                        gone = initial
                    }
                } else if !app.deployingThings.isEmpty, let newest = active.first {
                    version = newest.version
                }
                let wanted = app.deployingThings.filter { found[$0] == nil }
                if !wanted.isEmpty {
                    things = wanted
                    chosenByHand = true
                }
            } else if !active.contains(where: { $0.version == version }) {
                gone = version
                version = ""
                step = 0
            }
            suggest()
        } catch {
            loadError = error
            await app.handle(error)
        }
    }

    private func submit(_ chosen: [Device]) async {
        let version = self.version
        let things = chosen.map(\.thing)
        let note = UploadCheck.singleLine(self.note)
        if let made = await change.run(app, refusal: "The deployment was not started.", { api in
            try await api.deploy(version: version, things: things, note: note)
        }) {
            app.deploymentDetails[made.id] = Loadable(value: made, loadedAt: Date())
            app.say("Deployment of \(version) started on \(Words.plural(things.count, "board")).")
            app.deployingThings = []
            dismiss()
            await app.loadDeployments()
        }
    }
}
