import CraniumKit
import SwiftUI

/// The website's Devices page: every board registered to this project, as it last reported.
struct BoardsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme

    var body: some View {
        Page {
            PageHead(lede: "Every board registered to this project, as it last reported.")
            Freshness(loadedAt: app.devices.loadedAt, interval: app.fleetInterval, loading: app.devices.loading)
            if let error = app.devices.error {
                LoadProblem(what: "the boards", error: error, loadedAt: app.devices.loadedAt) {
                    Task { await app.refreshDevices(full: true) }
                }
            }
            if let devices = app.deviceList {
                if devices.isEmpty {
                    Card { EmptyState.noBoards }
                } else {
                    let onTrial = devices.filter { $0.fw != nil && $0.fw?.confirmed == false }.count
                    let updating = devices.filter { Words.deviceActivity($0) != nil }.count
                    Panel {
                        Eyebrow("Fleet")
                        FleetFigure(devices: devices, extra: [("updating now", updating), ("on trial", onTrial)])
                        Eyebrow("Firmware in the fleet")
                        if let note = Words.asReported(devices, now: Date()) {
                            Text(note).font(Typeface.small).foregroundStyle(Theme.panel.ink3)
                        }
                        VersionRows(devices: devices, newest: app.firmware.value?.newestActive)
                    }
                    VStack(spacing: 18) {
                        ForEach(devices) { device in
                            BoardCard(device: device)
                        }
                    }
                }
            } else if app.devices.error == nil {
                Loading(what: "boards")
            }
        }
        .poll(every: { app.fleetInterval }) { full in await app.refreshDevices(full: full) }
        .consoleTitle("Boards")
    }
}

/// A board on the Boards list.
struct BoardCard: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                RowLink(.board(device.thing)) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            BoardTitle(device)
                            Text(Words.seenLine(device, now: Date())).font(Typeface.small).foregroundStyle(theme.ink3)
                            if device.lastSeen == nil && !device.online {
                                Text(Words.neverReportedHelp).font(Typeface.small).foregroundStyle(theme.ink3)
                            }
                        }
                        Spacer()
                        Presence(device: device)
                    }
                }
                DeviceFacts(device: device, offer: Words.openOffer(for: device, deployments: app.deployments.value ?? [],
                                                                   details: app.deploymentDetails.compactMapValues(\.value)))
            }
        }
    }
}

/// Firmware, update, signal and uptime: what the website's Devices page says of a board.
struct DeviceFacts: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let device: Device
    var offer: (deployment: String, version: String?)?
    var withHeartbeat = false

    var body: some View {
        VStack(spacing: 0) {
            if withHeartbeat {
                Fact("Heartbeat") {
                    if device.lastSeen != nil {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(Telemetry.heartbeatAge(device.lastSeen, now: context.date)).monospacedDigit()
                        }
                        FactNote(Words.exactTime(device.lastSeen))
                    } else {
                        Text("None yet").foregroundStyle(theme.ink3)
                    }
                }
            }
            Fact("Firmware") { firmware }
            Fact("Update") { update }
            Fact("Signal") { SignalWords(device: device) }
            Fact("Uptime") {
                if device.uptime != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let uptime = Telemetry.uptimeNow(device, now: context.date) ?? 0
                        Text(Words.duration(Double(uptime)) + (device.online ? "" : " when last seen")).monospacedDigit()
                    }
                } else {
                    Text("Not reported").foregroundStyle(theme.ink3)
                }
            }
        }
    }

    @ViewBuilder private var firmware: some View {
        if let fw = device.fw {
            HStack(spacing: 6) {
                Mono(fw.version, strong: true)
                if !device.online { Text("when last seen").font(Typeface.small).foregroundStyle(theme.ink3) }
            }
            HStack(spacing: 6) {
                if fw.confirmed {
                    Badge(.good, "check", "Confirmed")
                } else {
                    Badge(.warn, "pulse", "On trial")
                }
                if Words.isUnregistered(fw.version, releases: app.releases) { Badge(.warn, "alert", Words.notRegistered) }
                if (app.releases ?? []).contains(where: { $0.version == fw.version && !$0.isActive }) {
                    Badge(.bad, "ban", "Revoked release")
                }
            }
            if !fw.confirmed {
                FactNote("Not confirmed yet. The bootloader goes back to the previous firmware if the board restarts before it confirms.")
            }
            if (app.releases ?? []).contains(where: { $0.version == fw.version && !$0.isActive }) {
                FactNote("To replace it, upload a newer version and deploy that.")
            }
        } else {
            Text("Not reported").foregroundStyle(theme.ink3)
        }
    }

    @ViewBuilder private var update: some View {
        let words = Words.describeUpdate(device)
        StatusLine(words)
        if let progress = words.progress { Meter(percent: progress, label: "Download on \(device.label)") }
        if !words.text.isEmpty { FactNote(words.text) }
        if let offer, words.deployment == nil {
            FactNote("Offered \(offer.version ?? "an update")\(device.online ? ". It has not picked the offer up yet." : ". It will see the offer when it connects.")")
        }
        if let id = words.deployment ?? offer?.deployment {
            NavigationLink(value: Route.deployment(id)) {
                HStack(spacing: 4) {
                    Text("Open the deployment")
                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                }
                .font(Typeface.small.weight(.semibold))
                .foregroundStyle(theme.ink)
            }
            .buttonStyle(.plain)
        }
    }
}

/// A board's page: the website's board page and its Diagnostics card together.
struct BoardView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.theme) private var theme
    let thing: String
    @State private var samples = Loadable<Samples>()
    @State private var hours = 24

    var body: some View {
        let resource = app.deviceDetails[thing] ?? Loadable()
        Page {
            if let detail = resource.value {
                content(detail, resource: resource)
            } else if let error = resource.error as? APIError, error.status == 404 {
                Card { EmptyState(icon: "chip", title: "No board with this name is registered.",
                                  text: "Check the name, or find the board on the Boards tab.") }
            } else {
                BoardTitle(thing, name: app.name(of: thing), large: true)
                if let error = resource.error {
                    LoadProblem(what: "this board", error: error) { Task { await app.loadDevice(thing) } }
                } else {
                    Loading(what: "the board")
                }
            }
        }
        .poll(every: { Telemetry.diagnosticsRefresh }) { full in
            await app.loadDevice(thing)
            if full || samples.due(false, every: Telemetry.samplesRefresh - 2) { await loadSamples() }
            if app.firmware.due(full) { await app.loadFirmware() }
        }
        .onChange(of: hours) { _ in Task { await loadSamples() } }
        .consoleTitle(app.name(of: thing) ?? Words.shortThing(thing), large: false)
    }

    private func loadSamples() async {
        guard let api = app.api else { return }
        samples.loading = true
        do {
            samples = Loadable(value: try await api.samples(thing: thing, hours: hours), loadedAt: Date())
        } catch {
            samples.loading = false
            samples.error = error
            await app.handle(error)
        }
    }

    @ViewBuilder
    private func content(_ detail: DeviceDetail, resource: Loadable<DeviceDetail>) -> some View {
        let device = detail.device
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow("Board")
            HStack(alignment: .top) {
                BoardTitle(device, large: true)
                Spacer()
                Presence(device: device)
            }
            Text(Words.seenLine(device, now: Date()) + (device.lastSeen == nil && !device.online ? " \(Words.neverReportedHelp)" : ""))
                .font(Typeface.small).foregroundStyle(theme.ink3)
            Freshness(loadedAt: resource.loadedAt, interval: Telemetry.diagnosticsRefresh, loading: resource.loading)
        }
        if let error = resource.error {
            LoadProblem(what: "this board", error: error, loadedAt: resource.loadedAt) { Task { await app.loadDevice(thing) } }
        }
        BoardPanel(device: device)
        if app.canWrite {
            HStack(spacing: 10) {
                Button {
                    app.deployingThings = [thing]
                    app.deploying = ""
                } label: { Label("Deploy a release", systemImage: "paperplane") }
                    .consoleButton()
                Button { app.openBluetooth(release: nil) } label: {
                    Label("Bluetooth", systemImage: "dot.radiowaves.left.and.right")
                }
                .consoleButton()
            }
        }
        Card("State") {
            let queued = detail.executions.first { $0.status == "QUEUED" }
            let offer = queued.map { (deployment: $0.deployment, version: $0.version ?? DeploymentId.version(of: $0.deployment)) }
                ?? Words.openOffer(for: device, deployments: app.deployments.value ?? [],
                                   details: app.deploymentDetails.compactMapValues(\.value))
            DeviceFacts(device: device, offer: offer, withHeartbeat: true)
        }
        DiagnosticsCard(device: device)
        Card("Signal and memory", more: {
            Picker("Hours", selection: $hours) {
                Text("1 h").tag(1)
                Text("24 h").tag(24)
                Text("7 d").tag(168)
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
        }) {
            if let value = samples.value {
                VStack(alignment: .leading, spacing: 24) {
                    SignalChart(samples: value)
                    if device.diag != nil || value.samples.contains(where: { $0.heapFree != nil }) {
                        HeapChart(samples: value, device: device)
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Free memory").font(Typeface.body.weight(.semibold))
                            Text(Telemetry.diagMissing(device)).font(Typeface.small).foregroundStyle(theme.ink3)
                        }
                    }
                }
            } else if let error = samples.error {
                Notice(.bad, "x-circle", "Could not load the readings. \(Words.sentence(Words.plainMessage(error)))")
            } else {
                Loading(what: "the readings")
            }
        }
        Card("Certificates") {
            if detail.certificates.isEmpty {
                Text("No certificate is attached, so this board cannot connect. Run the provisioning tool again.")
                    .foregroundStyle(theme.ink3)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(detail.certificates, id: \.self) { id in
                        HStack(spacing: 6) {
                            Image(systemName: "key").font(.caption).foregroundStyle(theme.ink2)
                            Mono("\(id)…", font: Typeface.mono)
                        }
                    }
                    FactNote("The start of each certificate ID. The certificate belongs to this board alone; its private key never leaves the board.")
                }
            }
        }
        Card("Last boots") { BootTable(device: device) }
        Card("Last update over Bluetooth") { BluetoothRecordFacts(device: device) }
        Card("Update history") {
            if detail.executions.isEmpty {
                Text("This board has not been offered an update yet.").foregroundStyle(theme.ink3)
            } else {
                let ended = newestEnded(detail.executions)
                VStack(spacing: 0) {
                    ForEach(detail.executions) { execution in
                        HistoryRow(execution: execution, last: execution.deployment == ended?.deployment ? device.ota?.last : nil)
                        RowRule()
                    }
                }
                if detail.olderExecutions > 0 {
                    Text("The newest \(detail.executions.count) are shown. \(Words.plural(detail.olderExecutions, "older update is", "older updates are")) not listed.")
                        .font(Typeface.small).foregroundStyle(theme.ink3)
                }
            }
        }
    }

    /// The entry of a board's history that the board's own last report speaks of: the one that ended last.
    private func newestEnded(_ executions: [ExecutionSummary]) -> ExecutionSummary? {
        executions.filter { !Words.isUnfinished($0.status) }
            .max { (ConsoleTime.date($0.lastUpdatedAt) ?? .distantPast) < (ConsoleTime.date($1.lastUpdatedAt) ?? .distantPast) }
    }
}

/// What the board is doing, in words for across a room, and what its flash holds.
struct BoardPanel: View {
    let device: Device

    var body: some View {
        let theme = Theme.panel
        let update = Words.describeUpdate(device)
        let working = device.ota != nil && device.ota?.state != "idle"
        Panel {
            if working {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        StatusLine(tone: update.tone, icon: update.icon, title: update.title).font(Typeface.heading)
                        if !update.text.isEmpty {
                            Text(update.text).font(Typeface.small).foregroundStyle(theme.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer()
                    if let progress = update.progress {
                        Text("\(progress)%").font(Typeface.figure).monospacedDigit().accessibilityHidden(true)
                    }
                }
                if let progress = update.progress { Meter(percent: progress, label: "Download on \(device.label)") }
                if update.tone == .act { ButtonKeys() }
            }
            if device.fw != nil || device.ota != nil {
                FlashMap(device: device)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    StatusLine(tone: .idle, icon: "minus-circle", title: "Nothing reported yet")
                    Text(device.lastSeen != nil
                         ? "This board has not said what it runs, so nothing is known about its flash memory."
                         : "This board has not reported to AWS IoT, so nothing is known about its flash memory.")
                        .font(Typeface.small).foregroundStyle(theme.ink2)
                }
            }
        }
    }
}

/// What each slot of the board's flash holds, worked out from what it last reported.
struct FlashMap: View {
    @Environment(\.theme) private var theme
    let device: Device

    private struct Slot {
        var version: String?
        var none: String
        var state: String
        var tone: Tone = .idle
        var icon: String? = nil
    }

    var body: some View {
        let online = device.online
        let fw = device.fw
        let ota = device.ota
        let running = Slot(version: fw?.version, none: "Version not reported",
                           state: fw?.confirmed == true ? (online ? "Runs from here, confirmed" : "Ran from here, confirmed")
                               : fw != nil ? (online ? "Runs on trial" : "Was on trial") : "Nothing reported",
                           tone: fw?.confirmed == true ? .good : fw != nil ? .live : .idle,
                           icon: fw?.confirmed == true ? "check" : fw != nil ? "pulse" : nil)
        let target = DeploymentId.version(of: ota?.job)
        let (primary, secondary): (Slot, Slot) = {
            guard let ota, ota.state != "idle" else {
                return (running, Slot(version: nil, none: "Not reported by the board", state: "No update under way"))
            }
            switch ota.state {
            case "awaiting_user":
                return (running, Slot(version: nil, none: "Not reported by the board",
                                      state: online ? "Nothing is written until Button 1 is pressed" : Words.describeUpdate(device).title))
            case "testing":
                var trial = running
                trial.state = online ? "Runs on trial" : "Was on trial"
                trial.tone = online ? .live : .idle
                trial.icon = "pulse"
                return (trial, Slot(version: nil, none: "Previous firmware", state: "Kept to fall back on"))
            case "bluetooth":
                return (running, Slot(version: nil, none: "Not reported by the board",
                                      state: online ? "A phone may be sending an image over Bluetooth" : Words.describeUpdate(device).title))
            default:
                if !online { return (running, Slot(version: target, none: "No new image", state: Words.describeUpdate(device).title)) }
                if ota.state == "downloading" {
                    return (running, Slot(version: target, none: "No new image", state: "Receiving the image", tone: .live, icon: "download"))
                }
                return (running, Slot(version: target, none: "No new image", state: "Written, being checked", tone: .live, icon: "shield"))
            }
        }()
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(online ? "Flash memory now" : "Flash memory when last seen")
            row("Bootloader", Slot(version: "MCUboot", none: "", state: "Checks every signature"))
            row("Primary slot", primary)
            if ota?.state == "rebooting" && online {
                Image(systemName: "arrow.up.arrow.down").foregroundStyle(theme.ink3).accessibilityHidden(true)
            }
            row("Secondary slot", secondary)
            Text(ota != nil ? "Worked out from the step the board last reported." : "The board reports what it runs, and nothing about its other slot.")
                .font(Typeface.tiny).foregroundStyle(theme.ink3)
        }
    }

    private func row(_ name: String, _ slot: Slot) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(name).font(Typeface.small).foregroundStyle(theme.ink3).frame(width: 96, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                if let version = slot.version {
                    Mono(version, strong: true)
                } else {
                    Text(slot.none).foregroundStyle(theme.ink3)
                }
                HStack(spacing: 5) {
                    if let icon = slot.icon {
                        Image(systemName: Icon.symbol(icon)).foregroundStyle(theme.tone(slot.tone))
                    }
                    Text(slot.state)
                }
                .font(Typeface.small)
                .foregroundStyle(theme.ink2)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.well, in: RoundedRectangle(cornerRadius: 5))
        .accessibilityElement(children: .combine)
    }
}

/// How the board is doing: stuck restarts, Wi-Fi and memory (Diagnostics on the website).
struct DiagnosticsCard: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        Card("Diagnostics") {
            VStack(spacing: 0) {
                Fact("Stuck") {
                    if let stuck = Telemetry.stuckWords(device.stuck) {
                        if let badge = stuck.badge { Badge(.warn, "alert", badge) }
                        Text(stuck.text).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Not reported: firmware before 1.7.0 has no such timer").foregroundStyle(theme.ink3)
                    }
                }
                Fact("Wi-Fi") {
                    if let diag = device.diag {
                        Text(diag.channel.map { "Channel \($0)" } ?? "Not associated")
                        HStack(spacing: 4) {
                            Text("MAC").foregroundStyle(theme.ink3)
                            if let mac = diag.mac { Mono(mac, font: Typeface.mono) } else { Text("not reported").foregroundStyle(theme.ink3) }
                        }
                        .font(Typeface.small)
                    } else {
                        FactNote(Telemetry.diagMissing(device))
                    }
                }
                Fact("Memory") {
                    if let heap = device.diag?.heap {
                        HeapBar(heap: heap)
                    } else {
                        FactNote(device.diag != nil ? "The heap is not reported by this build." : Telemetry.diagMissing(device))
                    }
                }
            }
            if let at = device.diag?.at {
                Text("Diagnostics report \(Words.timeAgo(at, now: Date())).").font(Typeface.small).foregroundStyle(theme.ink3)
            }
        }
    }
}

/// How much of the heap is in use now, and the most that has been since the board started.
struct HeapBar: View {
    @Environment(\.theme) private var theme
    let heap: Device.Heap

    var body: some View {
        if let words = Telemetry.heapWords(heap) {
            VStack(alignment: .leading, spacing: 6) {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3).fill(theme.line)
                        RoundedRectangle(cornerRadius: 3).fill(theme.bar(words.tone == .live ? .live : words.tone))
                            .frame(width: geometry.size.width * CGFloat(words.used) / 100)
                        Rectangle().fill(theme.ink2)
                            .frame(width: 2)
                            .offset(x: max(0, geometry.size.width * CGFloat(words.leastUsed) / 100 - 1))
                    }
                }
                .frame(height: 10)
                .accessibilityElement()
                .accessibilityLabel("\(words.text), \(words.used)% in use. \(words.least).")
                HStack(spacing: 6) {
                    if words.tone == .bad { Badge(.bad, "alert", "Low now") }
                    Text(words.text)
                }
                HStack(spacing: 6) {
                    if words.ranLow { Badge(.warn, "alert", "Ran low") }
                    Text(words.least).font(Typeface.small).foregroundStyle(theme.ink3)
                }
            }
        }
    }
}

/// The last boots, newest first, decoded from the chip's own record of its resets.
struct BootTable: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        if let diary = device.diary {
            let rows = Telemetry.diaryRows(diary)
            if rows.isEmpty {
                Text("The diary is empty.").foregroundStyle(theme.ink3)
            } else {
                VStack(spacing: 0) {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text("#\(row.boot)").font(Typeface.body.weight(.semibold)).monospacedDigit()
                                if row.running { Text("(running)").foregroundStyle(theme.ink3) }
                                Spacer()
                                Mono(row.version, font: Typeface.mono)
                            }
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                if row.bad { Badge(.warn, "alert", "Fault") }
                                Text("The boot before it ended by \(row.before).")
                                    .font(Typeface.small).fixedSize(horizontal: false, vertical: true)
                            }
                            Text(row.running ? "\(row.reached) so far" : row.reached)
                                .font(Typeface.small).foregroundStyle(theme.ink2)
                        }
                        .padding(.vertical, 8)
                        .accessibilityElement(children: .combine)
                        RowRule()
                    }
                }
                Text("\(Words.plural(diary.boots, "boot")) in all since the diary began. Each line says why the boot before it ended, from the chip’s own record of its reset.")
                    .font(Typeface.small).foregroundStyle(theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text(Telemetry.diaryMissing(device)).foregroundStyle(theme.ink3)
        }
    }
}

/// The board's record of its last update over Bluetooth.
struct BluetoothRecordFacts: View {
    @Environment(\.theme) private var theme
    let device: Device

    var body: some View {
        if let record = device.bt {
            VStack(spacing: 0) {
                Fact("Update") {
                    HStack(spacing: 4) {
                        Mono(record.from)
                        Text("to")
                        Mono(record.to)
                    }
                }
                Fact("Result") {
                    let words = Telemetry.bluetoothResults[record.result] ?? record.result
                    if Telemetry.badBluetoothResults.contains(record.result) {
                        Badge(.warn, "alert", words)
                    } else {
                        Text(words)
                    }
                }
                Fact("Proof") { Text(Telemetry.proofWords[record.proof] ?? record.proof) }
                Fact("Updates") {
                    Text(Words.plural(record.count, "update"))
                    FactNote("over Bluetooth on this board, in all")
                }
            }
        } else {
            Text("No update over Bluetooth recorded. Boards on 1.9.0 or later keep a record of the last one.")
                .foregroundStyle(theme.ink3)
        }
    }
}

/// One update a board was offered.
struct HistoryRow: View {
    @Environment(\.theme) private var theme
    let execution: ExecutionSummary
    let last: String?

    var body: some View {
        let version = execution.version ?? DeploymentId.version(of: execution.deployment)
        let ours = DeploymentId.isValid(execution.deployment)
        let content = VStack(alignment: .leading, spacing: 4) {
            Mono(version ?? execution.deployment, strong: true)
            Text("Offered \(Words.timeAgo(execution.queuedAt, now: Date()))"
                 + (Words.isUnfinished(execution.status) ? "" : " · ended \(Words.timeAgo(execution.lastUpdatedAt, now: Date()))"))
                .font(Typeface.small).foregroundStyle(theme.ink3)
            if !ours {
                Text("Started outside this console").font(Typeface.small).foregroundStyle(theme.ink3)
            }
            StatusLine(Words.describeHistory(execution.status, last: last))
        }
        .padding(.vertical, 10)
        if ours {
            RowLink(.deployment(execution.deployment)) { content }
        } else {
            content
        }
    }
}
