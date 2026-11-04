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

/// The website's Overview, as a summary: what is being updated, the fleet, the newest release,
/// and the last few changes.
struct OverviewView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        let devices = app.deviceList
        let firmware = app.firmware.value
        let deployments = app.deployments.value
        let blank = devices?.isEmpty == true && firmware?.releases.isEmpty == true && deployments?.isEmpty == true
        ListScreen {
            if StaleNote.shows(loadedAt: app.devices.loadedAt, error: app.devices.error ?? app.deployments.error, every: app.fleetInterval) {
                Section {
                    StaleNote(loadedAt: app.devices.loadedAt, error: app.devices.error ?? app.deployments.error,
                              every: app.fleetInterval) { refresh() }
                }
            }
            openRevocations(firmware)
            if blank {
                Section {
                    NavigationLink(value: Route.help("getting-started")) {
                        StateRow(kind: .empty, text: "No boards, releases or deployments yet. How to start")
                    }
                }
            } else if devices == nil || deployments == nil {
                Section { StateRow(kind: .loading, text: "Loading…") }
            } else {
                updates(devices ?? [], deployments ?? [])
                fleet(devices ?? [], firmware)
                recent
            }
        }
        .poll(every: { app.fleetInterval }) { full in await app.refreshOverview(full: full) }
        .helpButton("overview")
        .screenTitle("Overview")
    }

    private func refresh() {
        Task { await app.refreshOverview(full: true) }
    }

    @ViewBuilder
    private func openRevocations(_ firmware: FirmwareList?) -> some View {
        let open = (firmware?.releases ?? []).filter { Words.revocationState($0) == .incomplete }
        if let first = open.first {
            Section {
                NavigationLink(value: Route.release(first.version)) {
                    StatusText(.warn, "alert", "Revocation of \(first.version) is incomplete")
                }
            }
        }
    }

    @ViewBuilder
    private func updates(_ devices: [Device], _ deployments: [Deployment]) -> some View {
        let now = Date()
        let active = deployments.filter { Words.isUnderWay($0) || Words.stillFinishing($0, devices: devices, now: now) }
        if active.isEmpty {
            Section("Updates") {
                if let last = deployments.first {
                    let look = Words.describeDeployment(last, devices: devices)
                    NavigationLink(value: Route.deployment(last.id)) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("No update in progress")
                                Text("Last: \(last.version ?? "unknown") · \(Words.timeAgo(last.completedAt ?? last.createdAt, now: now))")
                                    .font(.footnote).foregroundStyle(theme.ink3)
                            }
                            Spacer()
                            StatusText(look)
                        }
                    }
                } else {
                    Text("No update in progress").foregroundStyle(theme.ink2)
                }
            }
        } else {
            Section("Updates in progress") {
                ForEach(active) { deployment in
                    if let detail = app.deploymentDetails[deployment.id]?.value, !detail.executions.isEmpty {
                        ForEach(detail.executions) { execution in
                            UpdateRow(execution: execution, deployment: detail, device: devices.first { $0.thing == execution.thing })
                        }
                    } else {
                        NavigationLink(value: Route.deployment(deployment.id)) {
                            VStack(alignment: .leading, spacing: 2) {
                                VersionText(deployment.version ?? "unknown")
                                Text(Words.countSentence(deployment.counts)).font(.footnote).foregroundStyle(theme.ink3)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func fleet(_ devices: [Device], _ firmware: FirmwareList?) -> some View {
        let counted = Words.boardsCounted(devices)
        let newest = firmware?.newestActive
        Section("Fleet") {
            NavigationLink(value: Route.boardsList) {
                ValueRow("Boards online", "\(counted.online) of \(devices.count)")
            }
            if let newest {
                NavigationLink(value: Route.release(newest.version)) {
                    HStack {
                        Text("Newest release")
                        Spacer()
                        VersionText(newest.version).foregroundStyle(theme.ink2)
                    }
                }
                let on = devices.filter { $0.fw?.version == newest.version }.count
                ValueRow("On the newest release", "\(on) of \(devices.count)")
            } else if firmware != nil {
                ValueRow("Newest release", "None can be deployed")
            }
        }
    }

    @ViewBuilder private var recent: some View {
        let entries = app.recent.value?.entries ?? []
        if !entries.isEmpty {
            Section("Recent") {
                ForEach(entries.prefix(4)) { entry in
                    ActivityRow(entry: entry)
                }
                NavigationLink(value: Route.activity) {
                    Text("All activity").foregroundStyle(theme.accent)
                }
            }
        }
    }
}

/// One board of an update under way: who, the step, and the download.
struct UpdateRow: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let execution: Execution
    let deployment: Deployment
    let device: Device?

    var body: some View {
        let words = Words.describeExecution(execution, board: device, deployment: deployment.id, version: deployment.version,
                                            unread: app.deviceList == nil)
        NavigationLink(value: Route.execution(deployment.id, execution.thing)) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    BoardLabel(execution.thing, name: device?.name ?? app.name(of: execution.thing))
                    Spacer()
                    if let progress = words.progress {
                        Text("\(progress)%").font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                }
                StatusText(words.tone, words.icon, words.said ?? words.title)
                if let progress = words.progress {
                    ProgressBar(percent: progress, label: "Download on \(device?.label ?? execution.thing)")
                }
            }
            .padding(.vertical, 2)
        }
    }
}
