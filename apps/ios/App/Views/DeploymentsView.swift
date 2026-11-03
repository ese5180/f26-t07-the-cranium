import CraniumKit
import SwiftUI

/// The website's Deployments page.
struct DeploymentsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        let deployable = app.firmware.value == nil || (app.releases ?? []).contains(where: \.isActive)
        Page {
            PageHead(lede: "A deployment sends one release to a set of boards. A board on firmware \(Words.firstWithNoButton) or newer starts as soon as it sees it, and older firmware waits for someone to press Button 1 on the board. A job made directly in AWS IoT is not listed here; its board’s page shows it.")
            Freshness(loadedAt: app.deployments.loadedAt, interval: app.deploymentsInterval, loading: app.deployments.loading)
            if app.canWrite {
                if deployable {
                    Button { app.deployingThings = []; app.deploying = "" } label: { Label("New deployment", systemImage: "plus") }
                        .consoleButton(.primary, wide: true)
                } else {
                    Text("Upload a signed image on the Firmware tab first; then it can be offered to boards here.")
                        .font(Typeface.small).foregroundStyle(theme.ink2)
                }
            }
            if let error = app.deployments.error {
                LoadProblem(what: "the deployments", error: error, loadedAt: app.deployments.loadedAt) {
                    Task { await app.refreshDeployments(full: true) }
                }
            }
            if let deployments = app.deployments.value {
                if deployments.isEmpty {
                    Card {
                        EmptyState(icon: "send", title: "No deployments yet.",
                                   text: !app.canWrite ? "When a release manager offers a release to boards, it appears here."
                                   : deployable ? "Choose New deployment to offer a release to one or more boards."
                                   : "Upload a signed image on the Firmware tab first; then it can be offered to boards here.")
                    }
                } else {
                    panel(deployments)
                    Card {
                        VStack(spacing: 0) {
                            ForEach(deployments) { deployment in
                                DeploymentRow(deployment: deployment)
                                RowRule()
                            }
                        }
                    }
                }
            } else if app.deployments.error == nil {
                Loading(what: "deployments")
            }
        }
        .poll(every: { app.deploymentsInterval }) { full in await app.refreshDeployments(full: full) }
        .consoleTitle("Deployments")
    }

    /// Every board of every deployment, by how it went.
    private func panel(_ deployments: [Deployment]) -> some View {
        let total = deployments.reduce(Counts()) { $0 + $1.counts }
        let devices = app.deviceList ?? []
        let atButton = Words.waitingForButton(devices, deployments: Set(deployments.map(\.id)))
        let lines = Words.describeCounts(total, atButton: atButton)
        let boards = lines.reduce(0) { $0 + $1.count }
        let theme = Theme.panel
        return Panel {
            HStack(spacing: 28) {
                stat("Deployments", deployments.count)
                stat("Under way", deployments.filter(Words.isUnderWay).count)
            }
            Eyebrow("Where each board’s update stands")
            if boards > 0 {
                if boards > 1 { Segments(lines: lines) }
                CountList(lines: lines)
            } else {
                Text("AWS IoT has not listed any board for these deployments yet.").foregroundStyle(theme.ink3)
            }
        }
    }

    private func stat(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)").font(Typeface.figure).monospacedDigit()
            Eyebrow(label)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A deployment in a list.
struct DeploymentRow: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let deployment: Deployment

    var body: some View {
        let summary = Words.describeDeployment(deployment)
        let devices = app.deviceList ?? []
        let atButton = Words.waitingForButton(devices, deployments: [deployment.id])
        let lines = Words.describeCounts(deployment.counts, atButton: atButton)
        RowLink(.deployment(deployment.id)) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Mono(deployment.version ?? "Unknown version", strong: true)
                    Badge(summary)
                }
                if !deployment.note.isEmpty {
                    Text(verbatim: deployment.note).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                }
                Text("\(Words.startedBy(deployment, now: Date())) · \(Words.plural(deployment.things.count, "board"))")
                    .font(Typeface.small).foregroundStyle(theme.ink3)
                if deployment.things.count > 1 { Segments(lines: lines) }
                CountList(lines: lines, percent: onePercent(devices, updating: deployment.counts.inProgress))
                    .font(Typeface.small)
            }
            .padding(.vertical, 12)
        }
    }

    /// How far the download is, where one board is downloading and so one number can say it.
    private func onePercent(_ devices: [Device], updating: Int) -> Int? {
        let moving = devices.filter { $0.online && $0.ota?.state == "downloading" && $0.ota?.job == deployment.id }
        return updating == 1 && moving.count == 1 ? moving[0].ota?.progress : nil
    }
}

/// One deployment: each board's part in it, live.
struct DeploymentView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let id: String
    @State private var cancelling = false

    var body: some View {
        let resource = app.deploymentDetails[id] ?? Loadable()
        Page {
            if let deployment = resource.value {
                content(deployment, resource: resource)
            } else if let error = resource.error as? APIError, error.status == 404 {
                Card { EmptyState(icon: "send", title: "There is no deployment with this address.",
                                  text: "Find it in the list of deployments.") }
            } else if let error = resource.error {
                LoadProblem(what: "this deployment", error: error) { Task { await app.loadDeployment(id) } }
            } else {
                Loading(what: "the deployment")
            }
        }
        .poll(every: { interval }) { full in await app.refreshDeployment(id, full: full) }
        .sheet(isPresented: $cancelling) {
            if let deployment = app.deploymentDetails[id]?.value {
                CancelSheet(deployment: deployment)
            }
        }
        .consoleTitle(DeploymentId.version(of: id).map { "Deployment of \($0)" } ?? "Deployment", large: false)
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

    @ViewBuilder
    private func content(_ deployment: Deployment, resource: Loadable<Deployment>) -> some View {
        let summary = Words.describeDeployment(deployment)
        let unfinished = deployment.executions.contains { Words.isUnfinished($0.status) }
        let withdrawn = unfinished && deployment.status == "CANCELED"
        let atWork = withdrawn && deployment.executions.contains { $0.status == "IN_PROGRESS" }
        let release = app.releases?.first { $0.version == deployment.version }
        let revoked = release.map { !$0.isActive } ?? false
        let boards = app.deviceList
        let shortOfDone = !unfinished && !Words.isUnderWay(deployment) && deployment.executions.contains { execution in
            Words.describeExecution(execution, board: boards?.first { $0.thing == execution.thing }, deployment: id,
                                    version: deployment.version, unread: boards == nil).retry
        }
        let offerAgain = shortOfDone && app.canWrite && app.firmware.value != nil && !revoked
        let cancelEntry = deployment.status == "CANCELED"
            ? (app.audit.value?.entries ?? []).last { $0.action == "deployment.cancel" && $0.outcome == "ok" && $0.target == id }
            : nil
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow("Deployment of")
            HStack(spacing: 10) {
                Mono(deployment.version ?? "unknown version", strong: true, font: .system(.title2, design: .monospaced))
                Badge(summary)
            }
            if !deployment.note.isEmpty {
                Text(verbatim: deployment.note).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
            }
            Text("\(Words.startedBy(deployment, now: Date()))\(deployment.completedAt.map { ", finished \(Words.timeAgo($0, now: Date()))" } ?? "")")
                .font(Typeface.small).foregroundStyle(theme.ink3)
            if let cancelEntry {
                Text("Cancelled \(Words.whenAt(cancelEntry.at, now: Date())) by \(Words.nameOf(cancelEntry.actor))")
                    .font(Typeface.small).foregroundStyle(theme.ink3)
            }
            CopyRow(value: deployment.id, label: "the deployment ID")
            Freshness(loadedAt: resource.loadedAt, interval: interval, loading: resource.loading)
        }
        if app.canWrite && unfinished {
            Button(role: .destructive) { cancelling = true } label: {
                Label(withdrawn ? "Stop boards that have started" : "Cancel deployment", systemImage: "stop.circle")
            }
            .consoleButton(.dangerQuiet, wide: true)
        }
        if offerAgain, let version = deployment.version {
            Button { app.deployingThings = []; app.deploying = version } label: { Label("Offer again", systemImage: "paperplane") }
                .consoleButton(wide: true)
        }
        if let error = resource.error {
            LoadProblem(what: "this deployment", error: error, loadedAt: resource.loadedAt) { Task { await app.loadDeployment(id) } }
        }
        if boards == nil, let error = app.devices.error {
            LoadProblem(what: "the list of boards", error: error) { Task { await app.loadDevices() } }
        }
        if withdrawn {
            Notice(.idle, "stop", atWork
                   ? "This deployment was cancelled. A board that had already started carries on unless it is stopped."
                   : "This deployment was cancelled. AWS takes a few seconds to withdraw the offer from every board.")
        }
        if let release, let mark = release.revoked {
            let cancelledFirst = cancelEntry.flatMap { ConsoleTime.date($0.at) }.map { $0 < (ConsoleTime.date(mark.at) ?? .distantFuture) } ?? false
            Notice(.idle, "ban",
                   "\(release.version) was revoked \(Words.timeAgo(mark.at, now: Date())) by \(Words.nameOf(mark.by))\(mark.reason.isEmpty ? "." : ": \(Words.sentence(mark.reason))")\(deployment.status != "CANCELED" || cancelledFirst ? "" : " Revoking cancels every open deployment of a release.")") {
                NavigationLink(value: Route.release(release.version)) { Text("Open the release") }.consoleButton()
            }
        }
        if deployment.executions.isEmpty {
            Card { Text("AWS IoT has not listed any board for this deployment yet.").foregroundStyle(theme.ink3) }
        } else {
            if deployment.executions.count > 1 {
                let lines = Words.describeCounts(deployment.counts)
                VStack(alignment: .leading, spacing: 8) {
                    Segments(lines: lines)
                    CountList(lines: lines)
                }
            }
            ForEach(deployment.executions) { execution in
                ExecutionCard(execution: execution, deployment: deployment, boards: deployment.executions.count)
            }
        }
    }
}

/// One board's part in a deployment: what it is doing, in words and as steps.
struct ExecutionCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let execution: Execution
    let deployment: Deployment
    let boards: Int

    var body: some View {
        let known = app.device(execution.thing)
        let unread = app.deviceList == nil
        let detail = app.deviceDetails[execution.thing]?.value
        // A copy read before the board got to what it runs now says nothing about how it got there.
        let history = detail != nil && detail?.device.fw?.version == execution.reported ? detail?.executions : nil
        let words = Words.describeExecution(execution, board: known, deployment: deployment.id, version: deployment.version,
                                            history: history, historyCut: (detail?.olderExecutions ?? 0) > 0 && history != nil,
                                            unread: unread)
        let finished = !Words.isUnfinished(execution.status)
        let full = boards == 1 || (boards <= 3 && [.act, .live, .bad].contains(words.tone))
        let revoked = (app.releases ?? []).contains { $0.version == deployment.version && !$0.isActive }
        let next = words.next != nil && app.canWrite && (!revoked || !words.retry) ? words.next : nil
        let content = VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                NavigationLink(value: Route.board(execution.thing)) {
                    BoardTitle(execution.thing, name: known?.name ?? app.name(of: execution.thing))
                }
                .buttonStyle(.plain)
                Spacer()
                presence(known, unread: unread)
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    StatusLine(tone: words.tone, icon: words.icon, title: words.said ?? words.title).font(Typeface.heading)
                    Text(words.text).font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(full ? Theme.panel.ink2 : theme.ink2)
                    if let next { Text(next).font(Typeface.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
                    if let other = words.installedBy {
                        NavigationLink(value: Route.deployment(other)) {
                            Text("Open the deployment that installed it").underline()
                        }
                        .buttonStyle(.plain)
                    }
                    if let code = words.code {
                        HStack(spacing: 4) { Text("The board gave the reason"); Mono(code, font: Typeface.mono) }.font(Typeface.small)
                    }
                    if let note = execution.detail {
                        HStack(spacing: 4) { Text("Board’s note:"); Mono(note, font: Typeface.mono) }.font(Typeface.small)
                    }
                }
                Spacer(minLength: 0)
                if let progress = words.progress {
                    Text("\(progress)%").font(Typeface.figure).monospacedDigit().accessibilityHidden(true)
                }
            }
            if let progress = words.progress { Meter(percent: progress, label: "Download on \(known?.label ?? execution.thing)") }
            if words.tone == .act { ButtonKeys() }
            if let back = returnPath(words) {
                Label(back, systemImage: "arrow.uturn.backward").font(Typeface.small)
            }
            StepList(words: words, compact: !full, viewer: !app.canWrite)
            let moments = moments(known: known, finished: finished, words: words)
            if !moments.isEmpty {
                if full { Eyebrow("What happened when") }
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(moments, id: \.self) { Text($0) }
                }
                .font(Typeface.small)
                .foregroundStyle(full ? Theme.panel.ink3 : theme.ink3)
            }
        }
        if full && words.tone != .idle {
            Panel { content }
        } else {
            Card { content }
        }
    }

    private func presence(_ known: Device?, unread: Bool) -> some View {
        Group {
            if unread && execution.status == "CANCELED" && execution.startedAt != nil {
                Badge(.idle, "clock", "Not known yet")
            } else if execution.online && (execution.phase == "rebooting" || (known.map(Words.isRestarting) ?? false)) {
                Badge(.idle, "restart", "Restarting")
            } else if execution.online {
                Badge(.good, "online", "Online")
            } else if let known, known.lastSeen == nil {
                Badge(.idle, "minus-circle", "Never connected")
            } else {
                Badge(.idle, "offline", "Offline")
            }
        }
    }

    /// The way back when an update stops, with what the board ran when it ended.
    private func returnPath(_ words: ExecutionWords) -> String? {
        guard let at = words.steps.firstIndex(where: { $0.state == .failed }), at >= 1 else { return nil }
        let ran = execution.ranAtEnd
        switch execution.phase {
        case "rolled_back": return "It went back to the previous firmware" + (ran.map { ": \($0)" } ?? "")
        case "declined", "refused": return "Nothing was installed" + (ran.map { ". It stayed on \($0)" } ?? "")
        default: return "It stayed on the firmware it had" + (ran.map { ": \($0)" } ?? "")
        }
    }

    private func moments(known: Device?, finished: Bool, words: ExecutionWords) -> [String] {
        let now = Date()
        var moments: [String] = []
        if let queued = execution.queuedAt { moments.append("Offered \(Words.whenAt(queued, now: now))") }
        if let started = execution.startedAt { moments.append("Started \(Words.whenAt(started, now: now))") }
        if finished && words.tone != .live, let ended = execution.lastUpdatedAt { moments.append("Ended \(Words.whenAt(ended, now: now))") }
        if execution.status == "IN_PROGRESS", let left = execution.secondsLeft {
            moments.append("Times out in \(Words.duration(Double(left)))")
        }
        if finished && execution.ranAtEnd == nil && execution.reported == nil, let fw = known?.fw {
            moments.append("\(known?.online == true ? "Board now reports" : "Board last reported") \(fw.version)")
        }
        if !execution.online, let seen = known?.lastSeen { moments.append("Board last seen \(Words.timeAgo(seen, now: now))") }
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
        let version = current.version ?? "this release"
        NavigationStack {
            Page {
                if over {
                    Text("Nothing is left to cancel. No board is waiting for this update any more, and none is installing it.")
                        .font(Typeface.body)
                } else {
                    Text("Right now \(Words.plural(waiting, "board is", "boards are")) waiting and \(Words.plural(started, "board has", "boards have")) started. Boards that already finished are not affected.")
                        .font(Typeface.body).fixedSize(horizontal: false, vertical: true)
                    Eyebrow("How far should the cancellation go?")
                    option(false, chosen: forced, disabled: withdrawn, "Withdraw the offer", withdrawn
                           ? "Done already: this deployment was cancelled before, so boards that had not started are no longer offered it."
                           : "Boards that have not started are no longer offered this update. A board that is already downloading or installing carries on and finishes.")
                    option(true, chosen: forced, disabled: false, "Withdraw the offer and stop boards that have started",
                           "Forced. A board that is downloading or checking the image stops before installing, because it asks AWS first and finds the update cancelled. A board that is already restarting into the new firmware cannot be stopped; it may still finish, but it can no longer report the result here.")
                    Text("A cancellation takes a few seconds to reach every board’s record. It cannot be undone; to try again, start a new deployment.")
                        .font(Typeface.small).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
                    if let error = change.error {
                        Notice(.bad, "x-circle", error, more: change.errorRef)
                    }
                    FreshSignInPrompt(change: change, what: "cancellation")
                    Button(role: .destructive) {
                        Task { await submit(force: forced, withdrawn: withdrawn, started: started) }
                    } label: {
                        Text(withdrawn ? (change.busy ? "Stopping…" : "Stop boards")
                             : change.busy ? "Cancelling…" : forced ? "Cancel and stop boards" : "Cancel the deployment")
                    }
                    .consoleButton(.danger, wide: true)
                    .disabled(change.busy || change.asking)
                }
            }
            .navigationTitle(withdrawn ? "Stop the boards installing \(version)?" : "Cancel the deployment of \(version)?")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(over || withdrawn ? "Close" : "Keep the deployment") { dismiss() }.disabled(change.busy)
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
                Image(systemName: chosen == value ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen == value ? theme.accent : theme.ink3)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(Typeface.body.weight(.semibold))
                    Text(text).font(Typeface.small).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(chosen == value ? theme.accent : theme.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            // What the page shows is out of date: read it again.
            await app.loadDeployment(id)
        }
    }
}

/// A new deployment: a release, the boards, and a review, as the website's wizard.
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

    private static let steps = ["Release", "Boards", "Review"]

    var body: some View {
        let releases = (app.releases ?? []).filter(\.isActive)
        let devices = app.deviceList ?? []
        let chosen = devices.filter { things.contains($0.thing) }
        NavigationStack {
            Page {
                stepper
                if loading {
                    Loading(what: "releases and boards")
                } else if let loadError {
                    Notice(.bad, "alert", "Could not load what a deployment needs. \(Words.sentence(Words.plainMessage(loadError)))",
                           more: Words.problemRef(loadError)) {
                        Button("Try again") { Task { await load() } }.consoleButton()
                    }
                } else if step == 0 {
                    if let gone {
                        Notice(.warn, "alert", "\(gone) has been revoked, so it cannot be deployed any more.\(releases.isEmpty ? "" : " Choose another release if you want to deploy one.")")
                    }
                    if releases.isEmpty {
                        EmptyState(icon: "package", title: "There is no release to deploy.",
                                   text: "Upload a signed image on the Firmware tab first. Revoked releases cannot be deployed.")
                    } else {
                        Eyebrow("Which release?")
                        ForEach(releases) { release in
                            choice(selected: release.version == version, radio: true) {
                                version = release.version
                                gone = nil
                            } label: {
                                Mono(release.version, strong: true)
                                Text("\(Words.fileSize(release.size)) · uploaded \(Words.timeAgo(release.uploadedAt, now: Date())) by \(Words.nameOf(release.uploadedBy))")
                                    .font(Typeface.small).foregroundStyle(theme.ink3)
                                if let notes = release.notes { Text(verbatim: notes).font(Typeface.small) }
                            }
                        }
                    }
                } else if step == 1 {
                    if devices.isEmpty {
                        EmptyState.noBoards
                    } else {
                        Eyebrow("Which boards get \(version)?")
                        ForEach(devices) { device in boardChoice(device) }
                        let selectable = devices.filter { busy[$0.thing] == nil && !Words.alreadyRuns($0, version: version) }
                        if selectable.count > 1 {
                            let all = selectable.allSatisfy { things.contains($0.thing) }
                            Button(all ? "Clear the selection" : "Select all \(selectable.count) available boards") {
                                chosenByHand = true
                                things = all ? [] : things.union(selectable.map(\.thing))
                            }
                            .consoleButton(.quiet)
                        }
                    }
                } else {
                    review(chosen)
                }
                if let error = change.error {
                    Notice(.bad, "x-circle", error, more: [busyWords, change.errorRef].compactMap { $0 }.joined(separator: " ").nilIfEmpty)
                }
                FreshSignInPrompt(change: change, what: "deployment")
                footer(releases: releases, chosen: chosen, devices: devices)
            }
            .navigationTitle("New deployment")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(change.busy) }
            }
        }
        .interactiveDismissDisabled(change.busy || change.asking || step > 0)
        .task { await load() }
    }

    private var busyWords: String? {
        guard let error = change.lastError as? APIError, !error.busyBoards.isEmpty else { return nil }
        return error.busyBoards.map { board in
            "\(app.name(of: board.thing) ?? board.thing): the deployment of \(DeploymentId.version(of: board.deployment) ?? "another release")"
        }.joined(separator: "; ") + "."
    }

    private var stepper: some View {
        HStack(spacing: 6) {
            ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, label in
                HStack(spacing: 6) {
                    ZStack {
                        Circle().fill(index == step ? theme.accent : index < step ? theme.ink2 : Color.clear)
                        Circle().stroke(index <= step ? Color.clear : theme.lineMark, lineWidth: 1)
                        if index < step {
                            Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(theme.paper)
                        } else {
                            Text("\(index + 1)").font(.caption2.weight(.bold))
                                .foregroundStyle(index == step ? theme.onAccent : theme.ink3)
                        }
                    }
                    .frame(width: 22, height: 22)
                    Text(label).font(Typeface.small.weight(index == step ? .semibold : .regular))
                        .foregroundStyle(index == step ? theme.ink : theme.ink3)
                }
                if index < Self.steps.count - 1 { Rectangle().fill(theme.line).frame(height: 1) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(step + 1) of 3: \(Self.steps[step])")
    }

    private func choice<Label: View>(selected: Bool, radio: Bool, disabled: Bool = false, action: @escaping () -> Void,
                                     @ViewBuilder label: () -> Label) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: radio ? (selected ? "largecircle.fill.circle" : "circle") : (selected ? "checkmark.square.fill" : "square"))
                    .foregroundStyle(selected ? theme.accent : theme.ink3)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 4) { label() }
                Spacer(minLength: 0)
            }
            .padding(12)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(selected ? theme.accent : theme.line, lineWidth: 1))
            .contentShape(Rectangle())
            .opacity(disabled ? 0.6 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled || change.busy)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func boardChoice(_ device: Device) -> some View {
        let held = busy[device.thing]
        let chosen = things.contains(device.thing)
        return choice(selected: chosen, radio: false, disabled: held != nil) {
            chosenByHand = true
            if chosen { things.remove(device.thing) } else if held == nil { things.insert(device.thing) }
        } label: {
            HStack(alignment: .top) {
                BoardTitle(device)
                Spacer()
                Presence(device: device)
            }
            Text((device.fw.map { "\(device.online ? "Runs" : "Last reported") \($0.version)" } ?? "Has not reported a version")
                 + (device.online || device.lastSeen == nil ? "" : " · last seen \(Words.timeAgo(device.lastSeen, now: Date()))"))
                .font(Typeface.small).foregroundStyle(theme.ink3)
            if let held {
                Label("Has an unfinished update\(held.version.map { " to \($0)" } ?? ""). Finish or cancel that deployment first.",
                      systemImage: "lock").font(Typeface.small).foregroundStyle(theme.warn)
            } else if Words.alreadyRuns(device, version: version) {
                Label("Reports that it already runs this version or a newer one, so it will refuse the offer.",
                      systemImage: "exclamationmark.triangle").font(Typeface.small).foregroundStyle(theme.warn)
            } else if !device.online && device.lastSeen == nil {
                Text("It will see the offer when it first connects. \(Words.neverReportedHelp)").font(Typeface.small).foregroundStyle(theme.ink3)
            } else if !device.online {
                Text("Offline: it will see the offer when it reconnects.").font(Typeface.small).foregroundStyle(theme.ink3)
            }
        }
    }

    @ViewBuilder
    private func review(_ chosen: [Device]) -> some View {
        let release = app.releases?.first { $0.version == version }
        let offline = chosen.filter { !$0.online && $0.lastSeen != nil }.count
        let never = chosen.filter { !$0.online && $0.lastSeen == nil }.count
        let asking = chosen.filter(Words.asksForButton).count
        VStack(spacing: 0) {
            Fact("Release") {
                Mono(version, strong: true)
                if let release { FactNote("\(Words.fileSize(release.size)) · SHA-256 \(String(release.sha256.prefix(12)))…") }
            }
            Fact("Boards") {
                ForEach(chosen) { device in
                    HStack {
                        BoardTitle(device)
                        Spacer()
                        Presence(device: device)
                    }
                    if Words.alreadyRuns(device, version: version) {
                        FactNote("Reports that it already runs this version or a newer one, so it will refuse the offer.")
                    }
                }
            }
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("Note (optional, shown with the deployment)").font(Typeface.small.weight(.semibold))
            TextField("Why this deployment", text: $note)
                .padding(10)
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 5))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(theme.lineField, lineWidth: 1))
                .onChange(of: note) { value in if value.count > 200 { note = String(value.prefix(200)) } }
        }
        Notice(.idle, "send", "What happens when you deploy", more: [
            "Each board gets \(version). Firmware \(Words.firstWithNoButton) or newer installs it as soon as the board sees it, with nobody at the board.",
            asking > 0 ? "\(Words.plural(asking, "board runs", "boards run")) older firmware, which installs nothing until someone presses Button 1 on the board; Button 2 declines." : nil,
            offline > 0 ? "\(Words.plural(offline, "board is", "boards are")) offline and will see the update after reconnecting. It stays open until it is cancelled."
                : "It stays open until a board acts on it or the deployment is cancelled.",
            never > 0 ? "\(Words.plural(never, "board has", "boards have")) never connected and will see the update when first connected. \(Words.neverReportedHelp)" : nil,
            "A board checks the download and its bootloader checks the signature. If the new firmware cannot reconnect, the bootloader puts the previous one back.",
            "These boards cannot be given another deployment until this one has finished or been cancelled.",
        ].compactMap { $0 }.map { "· \($0)" }.joined(separator: "\n"))
    }

    @ViewBuilder
    private func footer(releases: [FirmwareRelease], chosen: [Device], devices: [Device]) -> some View {
        let ready = !loading && loadError == nil
        let canGoOn = step == 0 ? releases.contains { $0.version == version } : !chosen.isEmpty
        let free = devices.filter { busy[$0.thing] == nil }
        VStack(alignment: .leading, spacing: 8) {
            if ready && step == 0 && !releases.isEmpty && !canGoOn {
                Text("Choose a release.").font(Typeface.tiny).foregroundStyle(theme.ink3)
            } else if ready && step == 1 && !devices.isEmpty && chosen.isEmpty {
                Text(free.isEmpty ? "Every board has an unfinished update." : "Choose at least one board.")
                    .font(Typeface.tiny).foregroundStyle(theme.ink3)
            }
            HStack(spacing: 10) {
                if step > 0 {
                    Button("Back") { step -= 1; change.reset() }.consoleButton().disabled(change.busy)
                }
                if step < 2 {
                    Button("Next") {
                        step += 1
                        change.reset()
                        suggest()
                    }
                    .consoleButton(.primary, wide: true)
                    .disabled(!ready || !canGoOn)
                } else {
                    Button {
                        Task { await submit(chosen) }
                    } label: {
                        Label(change.busy ? "Starting…" : "Deploy to \(Words.plural(chosen.count, "board"))", systemImage: "paperplane")
                    }
                    .consoleButton(.primary, wide: true)
                    .disabled(chosen.isEmpty || change.busy || change.asking)
                }
            }
        }
    }

    /// With a single board to choose from, it is ticked when the boards come up.
    private func suggest() {
        guard !chosenByHand, step == 1 else { return }
        let devices = app.deviceList ?? []
        let free = devices.filter { busy[$0.thing] == nil }
        if free.count == 1, !Words.alreadyRuns(free[0], version: version) {
            things = [free[0].thing]
        } else if things.isEmpty {
            things = []
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
