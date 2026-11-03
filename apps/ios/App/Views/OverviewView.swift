import CraniumKit
import SwiftUI

/// Reads a screen's data now, then again and again while the screen is shown and the app is in
/// front: every `interval()` seconds; not while that is 0. Stops when the screen goes away.
struct Poll: ViewModifier {
    @Environment(\.scenePhase) private var phase
    let interval: () -> TimeInterval
    let refresh: (Bool) async -> Void

    func body(content: Content) -> some View {
        content
            .task {
                await refresh(true)
                while !Task.isCancelled {
                    // 0: nothing to read again for now (a fixed range of events). Look again in a moment.
                    let wait = interval()
                    try? await Task.sleep(nanoseconds: UInt64((wait > 0 ? wait : 5) * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    if wait > 0 && phase == .active { await refresh(false) }
                }
            }
            .refreshable { await refresh(true) }
    }
}

extension View {
    func poll(every interval: @escaping () -> TimeInterval, _ refresh: @escaping (Bool) async -> Void) -> some View {
        modifier(Poll(interval: interval, refresh: refresh))
    }
}

struct OverviewView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        let devices = app.deviceList
        let firmware = app.firmware.value
        let deployments = app.deployments.value
        let newest = firmware?.newestActive
        let loaded = devices != nil && firmware != nil && deployments != nil
        let have = (boards: !(devices ?? []).isEmpty, releases: !(firmware?.releases ?? []).isEmpty,
                    deployments: !(deployments ?? []).isEmpty)
        let blank = loaded && !have.boards && !have.releases && !have.deployments
        Page {
            PageHead(lede: "What the boards last reported, and what is being updated right now.")
            Freshness(loadedAt: app.devices.loadedAt, interval: app.fleetInterval, loading: app.devices.loading)
            problems
            openRevocations(firmware)
            if loaded && !(have.boards && have.releases && have.deployments) {
                GettingStarted(have: have)
            }
            if !blank {
                Panel {
                    UpdatesCard(devices: devices)
                    FleetCard(devices: devices)
                    VersionsCard(devices: devices, newest: newest)
                    NewestReleaseCard(newest: newest)
                }
                BoardsCard(devices: devices)
                RecentActivityCard()
            } else if !(app.recent.value?.entries ?? []).isEmpty {
                RecentActivityCard()
            }
        }
        .poll(every: { app.fleetInterval }) { full in await app.refreshOverview(full: full) }
        .consoleTitle("Overview")
    }

    @ViewBuilder private var problems: some View {
        if let error = app.devices.error {
            LoadProblem(what: "the boards", error: error, loadedAt: app.devices.loadedAt) { refresh() }
        } else if let error = app.deployments.error {
            LoadProblem(what: "the deployments", error: error, loadedAt: app.deployments.loadedAt) { refresh() }
        } else if let error = app.firmware.error {
            LoadProblem(what: "the releases", error: error, loadedAt: app.firmware.loadedAt) { refresh() }
        } else if let error = app.recent.error {
            LoadProblem(what: "the activity log", error: error, loadedAt: app.recent.loadedAt) { refresh() }
        }
    }

    private func refresh() {
        Task { await app.refreshOverview(full: true) }
    }

    /// Releases whose revocation the server has not recorded as finished: said on top, to everyone.
    @ViewBuilder
    private func openRevocations(_ firmware: FirmwareList?) -> some View {
        let open = (firmware?.releases ?? []).filter { Words.revocationState($0) == .incomplete }
        if !open.isEmpty {
            let versions = ListFormatter.localizedString(byJoining: open.map(\.version))
            Notice(.warn, "alert",
                   "Revocation incomplete. \(versions) \(open.count == 1 ? "is" : "are") marked revoked, but the server has not recorded the steps that follow: refusing the image and cancelling every open deployment. \(app.canWrite ? "Finish revoking on the Firmware page." : "A release manager can finish revoking on the Firmware page.")") {
                if let first = open.first {
                    NavigationLink(value: Route.release(first.version)) { Text("Open \(first.version)") }
                        .consoleButton()
                }
            }
        }
    }
}

/// The first steps with a new console, ticked off as they are done.
struct GettingStarted: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let have: (boards: Bool, releases: Bool, deployments: Bool)

    var body: some View {
        let done = [have.boards, have.releases, have.deployments]
        let next = done.firstIndex(of: false)
        Card("Getting started") {
            VStack(alignment: .leading, spacing: 14) {
                step(0, done, next, "Register a board",
                     "Each board gets its own certificate and name. With the board connected over USB, run python3 tools/provision_device.py")
                step(1, done, next, "Upload a signed image", app.canWrite
                     ? "Choose binaries/latest.signed.bin on the Firmware tab. The server checks its signature before it is stored."
                     : "A release manager uploads a signed build. The server checks its signature before it is stored.")
                step(2, done, next, "Deploy it", app.canWrite
                     ? "Start a deployment from a release on the Firmware tab. A board on firmware \(Words.firstWithNoButton) or newer installs it by itself; older firmware waits for someone to press Button 1 on the board."
                     : "A release manager deploys the release to boards. A board on firmware \(Words.firstWithNoButton) or newer installs it by itself; older firmware waits for someone to press Button 1 on the board.")
            }
        }
    }

    private func step(_ index: Int, _ done: [Bool], _ next: Int?, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().stroke(index == next ? theme.accent : theme.lineMark, lineWidth: index == next ? 2 : 1)
                if done[index] { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
            }
            .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Typeface.body.weight(.semibold))
                if !done[index] {
                    Text(text).font(Typeface.small).foregroundStyle(theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(done[index] ? "done" : index == next ? "next" : "")
    }
}

/// What is being updated now, or how the last deployment ended.
struct UpdatesCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let devices: [Device]?

    var body: some View {
        let now = Date()
        let deployments = app.deployments.value
        let active = (deployments ?? []).filter { Words.isUnderWay($0) || Words.stillFinishing($0, devices: devices, now: now) }
        Card(active.isEmpty ? "Updates" : "Updates in progress", more: {
            NavigationLink(value: Route.deployments) { Text("All deployments") }
                .foregroundStyle(theme.ink)
        }) {
            if deployments == nil {
                if app.deployments.error == nil { Loading(what: "deployments") }
            } else if active.isEmpty && devices == nil && app.devices.error == nil {
                Loading(what: "boards")
            } else if active.isEmpty {
                calm(deployments ?? [], now: now)
            } else {
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(active) { deployment in
                        run(deployment, now: now)
                    }
                }
            }
        }
    }

    private func run(_ deployment: Deployment, now: Date) -> some View {
        let detail = app.deploymentDetails[deployment.id]?.value
        return VStack(alignment: .leading, spacing: 12) {
            NavigationLink(value: Route.deployment(deployment.id)) {
                HStack {
                    Mono(deployment.version ?? deployment.id, strong: true)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(theme.ink3)
                }
            }
            .buttonStyle(.plain)
            Text(Words.startedBy(deployment, now: now)).font(Typeface.small).foregroundStyle(theme.ink3)
            if deployment.status == "CANCELED" {
                Text(Words.isUnderWay(deployment)
                     ? "This deployment was cancelled. A board that had already started carries on unless it is stopped."
                     : "This deployment was cancelled, but a board was already restarting into the new firmware. That cannot be stopped.")
                    .font(Typeface.small).foregroundStyle(theme.ink2)
            }
            if let detail {
                ForEach(detail.executions) { execution in
                    ExecutionLine(execution: execution, deployment: deployment, device: app.device(execution.thing))
                }
            } else {
                Text(Words.countSentence(deployment.counts)).font(Typeface.small).foregroundStyle(theme.ink2)
            }
        }
    }

    @ViewBuilder
    private func calm(_ deployments: [Deployment], now: Date) -> some View {
        let devices = self.devices ?? []
        let lastDone = deployments.first { !(Words.isUnderWay($0) || Words.stillFinishing($0, devices: devices, now: now)) }
        let outOfDate = app.deployments.error != nil
        let ending = lastDone.map { Words.describeDeployment($0, devices: devices) }
        let standing = ending?.tone == .good ? lastDone.map { Words.installStanding($0, devices: devices) } : nil
        let strangers = Words.offList(devices, releases: app.releases)
        let movedOn = standing?.state == "moved"
        let offRecord = !outOfDate && !strangers.isEmpty && ending?.tone != .bad && ending?.tone != .warn
            && standing?.state != "current"
        let work = app.devices.error == nil ? Words.workWords(devices) : nil
        let tone: Tone = offRecord ? .warn : (movedOn || outOfDate ? .idle : ending?.tone ?? .idle)
        let news: String? = offRecord ? Words.unregisteredWords(strangers, devices: devices)
            : (movedOn || outOfDate ? nil : ending?.said)
        let unknown = outOfDate || app.devices.error != nil
        let resting = unknown ? "Whether an update is in progress cannot be told right now." : "No update is in progress."
        let icon = tone == .idle ? (news == nil && work != nil ? "restart" : "minus-circle") : (offRecord ? "alert" : ending?.icon ?? "minus-circle")
        let since: String? = {
            if offRecord { return Words.offlineWords(strangers, now: now, alone: devices.count == 1) }
            if !outOfDate, movedOn, let standing, let lastDone { return Words.movedWords(moved: standing.moved, deployment: lastDone, now: now) }
            if !outOfDate, let standing, standing.state != "current" { return Words.offlineWords(standing.boards, now: now) }
            return nil
        }()
        VStack(alignment: .leading, spacing: 10) {
            StatusLine(tone: tone, icon: icon, title: news ?? work ?? resting)
                .font(Typeface.heading)
            if let lastDone, let ending {
                HStack(alignment: .center, spacing: 8) {
                    Text(offRecord ? "Last deployment from this console:" : "Last deployment:")
                        .foregroundStyle(theme.ink3)
                    NavigationLink(value: Route.deployment(lastDone.id)) {
                        Mono(lastDone.version ?? lastDone.id, font: Typeface.mono)
                            .underline()
                    }
                    .buttonStyle(.plain)
                    Badge(ending)
                }
                .font(Typeface.small)
                Text(lastDone.completedAt != nil ? Words.timeAgo(lastDone.completedAt, now: now)
                     : "started \(Words.timeAgo(lastDone.createdAt, now: now))")
                    .font(Typeface.small).foregroundStyle(theme.ink3)
            } else {
                Text("Deployments from this console appear here while boards are being updated.")
                    .font(Typeface.small).foregroundStyle(theme.ink3)
            }
            if news != nil, let work { Text(work).font(Typeface.small).foregroundStyle(theme.ink2) }
            if let since { Text(since).font(Typeface.small).foregroundStyle(theme.ink2) }
            if let lastDone, lastDone.things.count > 1, tone == .bad || tone == .warn || tone == .good {
                let lines = Words.describeCounts(lastDone.counts)
                Segments(lines: lines)
                CountList(lines: lines)
            }
        }
    }
}

/// One board of a deployment that is under way, as a line.
struct ExecutionLine: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let execution: Execution
    let deployment: Deployment
    let device: Device?

    var body: some View {
        let words = Words.describeExecution(execution, board: device, deployment: deployment.id, version: deployment.version,
                                            unread: app.deviceList == nil)
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink(value: Route.board(execution.thing)) {
                BoardTitle(execution.thing, name: device?.name ?? app.name(of: execution.thing))
            }
            .buttonStyle(.plain)
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    if let progress = words.progress {
                        StatusLine(tone: words.tone, icon: words.icon, title: words.said ?? words.title, value: "\(progress)%")
                        Meter(percent: progress, label: "Download on \(device?.label ?? execution.thing)")
                    } else {
                        StatusLine(tone: words.tone, icon: words.icon, title: words.title)
                        Text(words.brief + (!execution.online && device?.lastSeen != nil
                                            ? " Last seen \(Words.timeAgo(device?.lastSeen, now: Date()))." : ""))
                            .font(Typeface.small).foregroundStyle(theme.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            if words.tone == .act { ButtonKeys() }
            StepList(words: words, compact: true, viewer: !app.canWrite)
        }
        .padding(12)
        .background(theme.well, in: RoundedRectangle(cornerRadius: 6))
    }
}

/// How many boards are online.
struct FleetCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let devices: [Device]?
    var extra: [(String, Int)] = []

    var body: some View {
        Card("Fleet") {
            if let devices {
                if devices.isEmpty {
                    Text("No boards are registered yet.").foregroundStyle(theme.ink3)
                } else {
                    FleetFigure(devices: devices, extra: extra)
                }
            } else if app.devices.error == nil {
                Loading(what: "boards")
            }
        }
    }
}

struct FleetFigure: View {
    @Environment(\.theme) private var theme
    let devices: [Device]
    var extra: [(String, Int)] = []

    var body: some View {
        let counted = Words.boardsCounted(devices)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(counted.online)").font(Typeface.figure).monospacedDigit()
                Text("of \(Words.plural(devices.count, "board")) online").foregroundStyle(theme.ink2)
            }
            .accessibilityElement(children: .combine)
            if devices.count > 1 {
                HStack(spacing: 4) {
                    ForEach(devices) { device in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Words.isUp(device) ? theme.barGood : (device.lastSeen != nil ? theme.barIdle : Color.clear))
                            .overlay(RoundedRectangle(cornerRadius: 2).stroke(theme.lineStrong, lineWidth: device.lastSeen == nil ? 1 : 0))
                            .frame(width: 14, height: 14)
                    }
                }
                .accessibilityHidden(true)
                let words = [counted.online > 0 ? "\(counted.online) online" : nil,
                             counted.quiet > 0 ? "\(counted.quiet) offline" : nil,
                             counted.never > 0 ? "\(counted.never) never connected" : nil]
                    + extra.filter { $0.1 > 0 }.map { "\($0.1) \($0.0)" }
                Text(words.compactMap { $0 }.joined(separator: " · ")).font(Typeface.small).foregroundStyle(theme.ink2)
            }
        }
    }
}

/// The fleet by firmware: a row per version with the boards on it.
struct VersionsCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let devices: [Device]?
    let newest: FirmwareRelease?

    var body: some View {
        Card("Firmware in the fleet") {
            if let devices {
                let groups = Words.versionGroups(devices)
                if groups.isEmpty {
                    Text("Versions appear here once a board has reported.").foregroundStyle(theme.ink3)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        headline(devices, groups: groups)
                        if let note = Words.asReported(devices, now: Date()) {
                            Text(note).font(Typeface.small).foregroundStyle(theme.ink3)
                        }
                        VersionRows(devices: devices, newest: newest)
                    }
                }
            } else if app.devices.error == nil {
                Loading(what: "versions")
            }
        }
    }

    @ViewBuilder
    private func headline(_ devices: [Device], groups: [(version: String, members: [Device])]) -> some View {
        if let newest {
            let current = groups.first { $0.version == newest.version }?.members.count ?? 0
            let others = Words.offList(devices, releases: app.releases).count
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(current == 0 && others > 0 ? others : current)").font(Typeface.figure).monospacedDigit()
                Text(current == 0 && others > 0
                     ? "of \(devices.count) on firmware that is not a registered release"
                     : "of \(devices.count) on the newest release")
                    .foregroundStyle(theme.ink2)
            }
            .accessibilityElement(children: .combine)
        } else if app.firmware.value != nil {
            Text("No release can be deployed.").font(Typeface.heading)
        }
    }
}

struct VersionRows: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let devices: [Device]
    let newest: FirmwareRelease?

    var body: some View {
        let revoked = Set((app.releases ?? []).filter { !$0.isActive }.map(\.version))
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Words.versionGroups(devices), id: \.version) { group in
                let onTrial = group.members.filter { $0.fw != nil && $0.fw?.confirmed == false }.count
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if group.version.isEmpty {
                            Text("Not reported").foregroundStyle(theme.ink3)
                        } else {
                            Mono(group.version, strong: true)
                        }
                        Spacer()
                        Text(Words.plural(group.members.count, "board")).font(Typeface.small).foregroundStyle(theme.ink2)
                    }
                    HStack(spacing: 6) {
                        if !group.version.isEmpty && group.version == newest?.version { Tag(text: "Newest release") }
                        if Words.isUnregistered(group.version, releases: app.releases) { Tag(text: Words.notRegistered, tone: .warn) }
                        if onTrial > 0 { Tag(text: "\(onTrial) on trial", tone: .warn) }
                        if revoked.contains(group.version) { Tag(text: "Revoked release", tone: .bad) }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// The newest release that can be deployed.
struct NewestReleaseCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let newest: FirmwareRelease?

    var body: some View {
        let firmware = app.firmware.value
        let latest = firmware?.releases.first
        let shown = newest ?? latest
        Card("Newest release", more: {
            if let shown {
                NavigationLink(value: Route.release(shown.version)) { Text("Details") }.foregroundStyle(theme.ink)
            }
        }) {
            if firmware == nil {
                if app.firmware.error == nil { Loading(what: "releases") }
            } else if let shown {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Mono(shown.version, strong: true, font: .system(.title3, design: .monospaced))
                        ReleaseBadges(release: shown)
                    }
                    Text("Uploaded \(Words.timeAgo(shown.uploadedAt, now: Date())) by \(Words.nameOf(shown.uploadedBy))")
                        .font(Typeface.small).foregroundStyle(theme.ink2)
                    Text("\(Words.fileSize(shown.size)) · SHA-256 \(String(shown.sha256.prefix(12)))…")
                        .font(Typeface.small).foregroundStyle(theme.ink2)
                    if newest == nil {
                        Text("No release can be deployed.").font(Typeface.small).foregroundStyle(theme.ink2)
                    } else if let latest, latest.version != newest?.version {
                        Text("A newer upload, \(latest.version), was revoked\(latest.revoked?.at.map { " \(Words.timeAgo($0, now: Date()))" } ?? "").")
                            .font(Typeface.small).foregroundStyle(theme.ink2)
                    }
                    if let unused = Words.unusedReleaseWords(shown, devices: app.deviceList) {
                        Text(unused).font(Typeface.small).foregroundStyle(theme.ink2)
                    }
                }
            } else {
                Text("No firmware has been uploaded yet.").foregroundStyle(theme.ink3)
            }
        }
    }
}

/// The badges of a release: its status, and a warning while its revocation is not finished.
struct ReleaseBadges: View {
    let release: FirmwareRelease

    var body: some View {
        if release.isActive {
            Badge(.good, "check-circle", "Active")
        } else {
            HStack(spacing: 6) {
                Badge(.bad, "ban", "Revoked")
                if Words.revocationState(release) == .incomplete {
                    Badge(.warn, "alert", "Revocation incomplete")
                }
            }
        }
    }
}

/// The first boards, with what they run and what they are doing.
struct BoardsCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let devices: [Device]?

    var body: some View {
        Card("Boards") {
            if let devices {
                if devices.isEmpty {
                    Text("Boards appear here once they are registered.").foregroundStyle(theme.ink3)
                } else {
                    VStack(spacing: 0) {
                        ForEach(devices.prefix(6)) { device in
                            RowLink(.board(device.thing)) { BoardLine(device: device) }
                                .padding(.vertical, 10)
                            RowRule()
                        }
                    }
                    if devices.count > 6 {
                        Text("and \(Words.plural(devices.count - 6, "more board")) on the Boards tab")
                            .font(Typeface.small).foregroundStyle(theme.ink3)
                    }
                }
            } else if app.devices.error == nil {
                Loading(what: "boards")
            }
        }
    }
}

/// A board in a list: who, when it was last heard, what it runs, its signal and its update.
struct BoardLine: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        let reported = Words.describeUpdate(device)
        // A row among rows: the overview's panel is what asks somebody to press a button.
        let update: UpdateWords = {
            var update = reported
            if update.tone == .act {
                update.tone = .wait
                update.title = "Waiting for its button"
            }
            return update
        }()
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Circle()
                    .fill(Words.isUp(device) ? theme.good : theme.lineStrong)
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    BoardTitle(device)
                    Text(Words.heartbeatWords(device, now: Date()) ?? "Never connected")
                        .font(Typeface.small).foregroundStyle(theme.ink3)
                }
            }
            HStack(spacing: 6) {
                if let fw = device.fw {
                    Mono(fw.version, font: Typeface.mono)
                    if fw.confirmed {
                        Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(theme.good)
                            .accessibilityLabel("confirmed")
                    } else {
                        Tag(text: "On trial", tone: .warn)
                    }
                    if Words.isUnregistered(fw.version, releases: app.releases) { Tag(text: Words.notRegistered, tone: .warn) }
                } else {
                    Text("Firmware not reported").foregroundStyle(theme.ink3)
                }
            }
            .font(Typeface.small)
            .padding(.leading, 16)
            HStack(spacing: 14) {
                SignalWords(device: device).font(Typeface.small)
            }
            .padding(.leading, 16)
            StatusLine(update).padding(.leading, 16)
        }
    }
}

/// The newest entries of the activity log.
struct RecentActivityCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        Card("Recent activity", more: {
            NavigationLink(value: Route.activity) { Text("All activity") }.foregroundStyle(theme.ink)
        }) {
            if let entries = app.recent.value?.entries {
                if entries.isEmpty {
                    Text("Nothing has been recorded yet. Uploads, deployments, cancellations and revocations will appear here.")
                        .foregroundStyle(theme.ink3)
                } else {
                    VStack(spacing: 0) {
                        ForEach(entries.prefix(5)) { entry in
                            ActivityLine(entry: entry, compact: true).padding(.vertical, 10)
                            RowRule()
                        }
                    }
                }
            } else if app.recent.error == nil {
                Loading(what: "activity")
            }
        }
    }
}
