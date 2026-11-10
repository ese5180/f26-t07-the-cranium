import AppKit
import CraniumBLE
import CraniumKit
import SwiftUI

// MARK: Bluetooth update

/// An update over Bluetooth from the Mac: the release, the board, its passkey, the send, Button 1, and
/// what the board does after it. The flow and every check are BluetoothModel's, the iPhone app's own
/// (apps/ios/App/BluetoothModel.swift): the console's "may still be sent" check right before the
/// upload, the image's checks, the pairing passkey from the console.
struct BluetoothPage: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        BluetoothSteps(model: app.bluetoothModel())
            .pageToolbar("Bluetooth update", subtitle: "Update a board in the room")
    }
}

private struct BluetoothSteps: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject var model: BluetoothModel

    var body: some View {
        Form {
            switch model.stage {
            case .releases: releases
            case .boards: boards
            case .board: board
            case .watching: watching
            }
            if let message = model.message {
                Section { Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            }
        }
        .formStyle(.grouped)
        .task { await model.open(release: app.bluetoothRelease) }
        .onChange(of: model.passkey) { passkey in
            // On the clipboard for the Mac's pairing box, as the iPhone puts it there.
            guard let passkey else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(passkey, forType: .string)
        }
    }

    @ViewBuilder private var releases: some View {
        Section {
            Label("At the board, hold Button 1 for 5 s. LED1 flashes four times.", systemImage: "hand.tap")
        }
        Section("Release") {
            if app.firmware.value == nil {
                ProgressView()
            } else if model.releases.isEmpty {
                Text("No active release.").foregroundStyle(.secondary)
            }
            Picker("Release", selection: $model.preferred) {
                ForEach(model.releases) { release in
                    Text(release.version).tag(release.version as String?)
                }
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
        }
        Section {
            HStack {
                Spacer()
                Button(model.preparing ?? (model.chosenRelease.map { "Continue with \($0.version)" } ?? "Continue")) {
                    Task { await model.continueToBoards() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!app.canWrite || model.chosenRelease == nil || model.busy)
            }
        }
    }

    @ViewBuilder private var boards: some View {
        Section {
            Label("Hold Button 1 for 5 s, until LED1 flashes four times.", systemImage: "hand.tap")
            if let release = model.chosenRelease, let image = model.obtained[release.version] {
                Text("\(release.version) is ready: \(image.origin == .phone ? "on this Mac" : "downloaded"), \(UserMessage.kilobytes(image.size)).")
                    .foregroundStyle(.secondary)
            }
        }
        Section("Boards with Bluetooth open") {
            if let problem = model.radioProblem {
                Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            } else if model.boards.isEmpty {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let started = model.scanStarted, context.date.timeIntervalSince(started) > 15 {
                        HStack {
                            Text("No board found.").foregroundStyle(.secondary)
                            Spacer()
                            Button("Look Again") { model.lookForBoards() }
                        }
                    } else {
                        HStack { ProgressView().controlSize(.small); Text("Looking…").foregroundStyle(.secondary) }
                    }
                }
            }
            ForEach(model.boards) { board in
                HStack {
                    Text(verbatim: board.name).font(.body.monospaced())
                    Spacer()
                    Text("\(board.rssi) dBm").foregroundStyle(.secondary)
                    Button("Connect") { Task { await model.connect(to: board) } }
                }
            }
        }
        Section {
            Button("Change the Release") { model.backToReleases() }
        }
    }

    @ViewBuilder private var board: some View {
        switch model.boardStage {
        case .pairing:
            Section("Passkey") {
                if let passkey = model.passkey {
                    Text(passkey).font(.system(size: 40, weight: .semibold, design: .monospaced)).textSelection(.enabled)
                    if let thing = model.consoleThing { BoardTitle(thing: thing, name: model.consoleName) }
                    Text("It is on the clipboard: in the Mac's pairing box, paste it, then Connect. A new one is drawn for each attempt.")
                        .foregroundStyle(.secondary)
                } else if model.passkeyNotInCloud {
                    Text("The board is offline: read its passkey on its serial console, the line [BT] passkey.")
                } else {
                    HStack { ProgressView().controlSize(.small); Text("Asking the cloud for the passkey…") }
                }
            }
            Section {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Pairing with \(model.boardName ?? "the board")…")
                    Spacer()
                    Button("Cancel") { Task { await model.backToBoards() } }
                }
            }
        case .choose:
            if let running = model.running {
                Section { FactRow("Runs now", running.description, mono: true) }
            }
            Section("Newer releases") {
                if model.offered.isEmpty {
                    Text("Nothing newer than what the board runs.").foregroundStyle(.secondary)
                }
                Picker("Release", selection: $model.preferred) {
                    ForEach(model.offered) { release in Text(release.version).tag(release.version as String?) }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
            }
            let ready = model.offered.contains { $0.version == model.preferred }
            Section {
                HStack {
                    Button("Disconnect") { Task { await model.backToBoards() } }
                    Spacer()
                    Button(ready ? "Send \(model.preferred ?? "")" : "Send") { Task { await model.send() } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!ready)
                }
                Text("Takes a few minutes. Keep the Mac near the board, and Cranium open.").font(.caption).foregroundStyle(.secondary)
            }
        case .checking(let version):
            Section { HStack { ProgressView().controlSize(.small); Text("Checking \(version)…") } }
        case .downloading(let version):
            Section { HStack { ProgressView().controlSize(.small); Text("Downloading \(version)…") } }
        case .confirming(let version):
            Section { HStack { ProgressView().controlSize(.small); Text("Asking the console about \(version)…") } }
        case .uploading(let progress):
            Section("Sending to \(model.boardName ?? "the board")") {
                ProgressView(value: progress.fraction) {
                    Text("\(Int((progress.fraction * 100).rounded()))% · \(progress.sent / 1024) of \(progress.total / 1024) KB")
                        .monospacedDigit()
                }
                Button("Stop", role: .destructive) { Task { await model.backToBoards() } }
            }
        case .failed(let text):
            Section {
                Label("Not sent. \(text)", systemImage: "xmark.circle").foregroundStyle(.red)
                Button("Back to the Boards") { Task { await model.backToBoards() } }
            }
        }
    }

    @ViewBuilder private var watching: some View {
        if let watch = model.watch {
            Section("\(model.watchVersion ?? "") to \(model.watchBoard ?? "the board")") {
                ForEach(Array(watch.rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: symbol(row)).foregroundStyle(color(row))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.title)
                            if let detail = row.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if let at = row.at {
                            Text(at.formatted(.dateTime.hour().minute().second())).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if watch.waitingForButton {
                Section("Now, at the board") {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(UpdateWatch.countdown(Int(watch.deadline.timeIntervalSince(context.date).rounded(.up))))
                            .font(.title2.weight(.semibold)).monospacedDigit()
                    }
                    Text("Press Button 1 on the board to install it.")
                }
            }
            if let note = watch.note { Section { Text(note) } }
        }
        Section {
            HStack {
                Button("Update Another Board") { Task { await model.anotherBoard() } }
                Spacer()
                Button("Done") { Task { await model.close() } }.keyboardShortcut(.defaultAction)
            }
        }
    }

    private func symbol(_ row: UpdateWatch.Row) -> String {
        switch row.state {
        case .done: return "checkmark.circle.fill"
        case .current: return "circle.inset.filled"
        case .likely: return "checkmark.circle"
        case .failed: return row.step == .end ? "arrow.uturn.backward.circle.fill" : "xmark.circle.fill"
        case .waiting: return "circle"
        }
    }

    private func color(_ row: UpdateWatch.Row) -> Color {
        switch row.state {
        case .done: return .green
        case .current: return .blue
        case .likely: return .secondary
        case .failed: return .orange
        case .waiting: return .secondary
        }
    }
}

// MARK: Serial console

/// The board's console over USB, read only: the J-Link's port at 115200 baud. Nothing is written to
/// the board from here (docs/mac-app.md, "Serial console").
@MainActor
final class SerialModel: ObservableObject {
    @Published private(set) var ports: [String] = []
    @Published var chosen: String?
    @Published private(set) var lines: [String] = []
    @Published private(set) var open = false
    @Published private(set) var problem: String?
    private var buffer = SerialLineBuffer()
    private var port: SerialPort?

    func look() {
        ports = SerialPorts.list()
        if chosen == nil || !ports.contains(chosen ?? "") { chosen = SerialPorts.likelyConsole(ports) }
    }

    func start() {
        guard let chosen, !open else { return }
        problem = nil
        let port = SerialPort(path: chosen)
        do {
            try port.open(onBytes: { [weak self] bytes in
                guard let self else { return }
                self.buffer.take(bytes)
                self.lines = self.buffer.lines
            }, onEnd: { [weak self] why in
                self?.open = false
                self?.problem = why.map { "The port closed: \($0)." } ?? "The port closed: the board was unplugged or restarted its USB."
            })
            self.port = port
            open = true
        } catch {
            problem = error.localizedDescription
        }
    }

    func stop() {
        port?.close()
        port = nil
        open = false
    }

    func clear() {
        buffer.clear()
        lines = []
    }
}

struct SerialPage: View {
    @StateObject private var model = SerialModel()
    @State private var follow = true

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Port", selection: $model.chosen) {
                    if model.ports.isEmpty { Text("No board plugged in").tag(String?.none) }
                    ForEach(model.ports, id: \.self) { Text($0).tag($0 as String?) }
                }
                .frame(maxWidth: 360)
                .disabled(model.open)
                Button { model.look() } label: { Image(systemName: "arrow.clockwise") }
                    .help("Look for ports again")
                    .disabled(model.open)
                Spacer()
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox)
                Button("Clear") { model.clear() }
                if model.open {
                    Button("Close") { model.stop() }
                } else {
                    Button("Open") { model.start() }.disabled(model.chosen == nil).keyboardShortcut(.defaultAction)
                }
            }
            .padding(10)
            if let problem = model.problem {
                Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).padding(.horizontal, 10)
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(model.lines.enumerated()), id: \.offset) { index, line in
                            Text(line.isEmpty ? " " : line).font(.system(.body, design: .monospaced)).id(index)
                        }
                    }
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.lines.count) { count in
                    if follow, count > 0 { proxy.scrollTo(count - 1, anchor: .bottom) }
                }
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .onAppear { model.look() }
        .onDisappear { model.stop() }
        .navigationTitle("Serial console")
        .navigationSubtitle(model.open ? "Reading \(model.chosen ?? "")" : "Read only, 115200 baud")
    }
}

// MARK: Settings

/// Cranium > Settings (⌘,): the account, Touch ID and its timing, live updates, and About.
struct SettingsView: View {
    var body: some View {
        TabView {
            SecuritySettings().tabItem { Label("Security", systemImage: "touchid") }
            AccountSettings().tabItem { Label("Account", systemImage: "person.crop.circle") }
            AboutSettings().tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 520)
        .padding(20)
    }
}

private struct SecuritySettings: View {
    @EnvironmentObject private var session: MacSession
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    @State private var preferences = MacLockPreferences.load()

    var body: some View {
        Form {
            if session.teamShown {
                touchID(biometry: app.biometry, usable: app.biometryUsable, on: app.biometricOn, busy: app.biometricBusy,
                        signedIn: app.stage == .signedIn, guarded: (app.lock?.gate as? MacBiometricGate)?.guarded,
                        turnOn: { await app.turnOnBiometrics() }, turnOff: { await app.turnOffBiometrics() })
            } else {
                touchID(biometry: customer.biometry, usable: customer.biometryUsable, on: customer.biometricOn,
                        busy: customer.biometricBusy, signedIn: customer.stage == .signedIn,
                        guarded: (customer.lock?.gate as? MacBiometricGate)?.guarded,
                        turnOn: { await customer.turnOnBiometrics() }, turnOff: { await customer.turnOffBiometrics() })
            }
            Section {
                Picker(MacLockWords.relock, selection: $preferences.relock) {
                    ForEach(RelockChoice.allCases) { Text($0.title).tag($0) }
                }
                Toggle(MacLockWords.lockWhenMacSleeps, isOn: $preferences.lockWhenMacSleeps)
            } footer: {
                Text("Away is another app in front, or every Cranium window closed. Lock Now (⌃⌘L) locks at once.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onChange(of: preferences) { changed in
            changed.save()
            session.setRelock(changed.relock)
        }
    }

    @ViewBuilder
    private func touchID(biometry: Biometry?, usable: Bool, on: Bool, busy: Bool, signedIn: Bool, guarded: SecretGuard?,
                         turnOn: @escaping () async -> Void, turnOff: @escaping () async -> Void) -> some View {
        Section {
            if let biometry {
                Toggle(MacLockWords.requireTouchID, isOn: Binding(get: { on }, set: { wanted in
                    Task { if wanted { await turnOn() } else { await turnOff() } }
                }))
                .disabled(busy || !signedIn || (!usable && !on))
                if !usable { Text(BiometricWords.cannotUse(biometry)).foregroundStyle(.secondary) }
            } else {
                Text(MacLockWords.noTouchID).foregroundStyle(.secondary)
            }
        } header: {
            Text("Touch ID")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let biometry { Text(BiometricWords.toggleFooter(biometry)) }
                if let guarded { Text(MacLockWords.guarded(guarded)) }
                if !signedIn { Text("Sign in first, then turn it on here.") }
            }
            .foregroundStyle(.secondary)
        }
    }
}

private struct AccountSettings: View {
    @EnvironmentObject private var session: MacSession
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        Form {
            if session.teamShown, let me = app.me {
                Section("Signed in to the console") {
                    FactRow("Name", Words.nameOf(Person(sub: me.sub, email: me.email ?? "")))
                    FactRow("E-mail", me.email ?? "")
                    FactRow("Role", app.canWrite ? "Release manager" : "Viewer")
                }
            } else if let me = customer.me.value {
                Section("Signed in") {
                    FactRow("Name", me.name)
                    FactRow("E-mail", me.email)
                    FactRow("Boards", "\(me.boards)")
                }
            } else {
                Text("Not signed in.").foregroundStyle(.secondary)
            }
            Section("Live updates") {
                LabeledContent("Now") { LiveBadge(state: session.liveState) }
                Text("While Cranium is open, a board's change shows within about a second; it reads again on a timer when the live connection is down.")
                    .foregroundStyle(.secondary)
            }
            if session.signedInShown {
                Section {
                    Button("Sign Out", role: .destructive) { Task { await session.signOut() } }
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct AboutSettings: View {
    var body: some View {
        let info = Bundle.main.infoDictionary ?? [:]
        Form {
            Section {
                FactRow("Version", "\(info["CFBundleShortVersionString"] as? String ?? "") (\(info["CFBundleVersion"] as? String ?? ""))")
                if let commit = info["CraniumCommit"] as? String { FactRow("Built from", commit, mono: true) }
                FactRow("Configuration", (try? CraniumConfig.load(from: .main))?.source == .example ? "The example: sign-in cannot work" : "This console's")
            }
            Section {
                Text("Cranium for Mac: the firmware console and the customer side, in native windows. docs/mac-app.md has how it works.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: The customer side

/// A customer's Cranium: their boards and what they did, as the customer site has them.
struct CustomerView: View {
    @EnvironmentObject private var session: MacSession
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        NavigationSplitView {
            List(selection: $session.customerSection) {
                ForEach(CustomerSection.allCases) { section in
                    Label(section.title, systemImage: section.symbol).tag(section)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            NavigationStack {
                switch session.customerSection ?? .boards {
                case .boards: CustomerBoardsPage()
                case .activity: CustomerActivityPage()
                case .help: CustomerHelpPage()
                case .account: CustomerAccountPage()
                }
            }
            .id(session.customerSection)
        }
    }
}

struct CustomerBoardsPage: View {
    @EnvironmentObject private var customer: CustomerModel
    @EnvironmentObject private var session: MacSession

    var body: some View {
        Group {
            if let boards = customer.boards.value {
                if boards.isEmpty {
                    PageState(kind: .empty, text: "No board is on your account yet. The team adds a board to it when they give you one.")
                } else {
                    List(boards) { board in
                        NavigationLink(value: board.id) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(board.name ?? board.boardName ?? "Your Cranium").font(.headline)
                                    Text(board.online ? "Online" : "Offline · \(Words.timeAgo(board.lastSeen, now: Date()))")
                                        .foregroundStyle(board.online ? .green : .secondary)
                                }
                                Spacer()
                                if let firmware = board.firmware { VersionText(firmware.version).foregroundStyle(.secondary) }
                            }
                            .padding(.vertical, 3)
                        }
                    }
                    .navigationDestination(for: String.self) { id in CustomerBoardPage(id: id) }
                }
            } else if let error = customer.boards.error {
                PageState(kind: .failed, text: Words.plainMessage(error)) { session.refreshNow() }
            } else {
                PageState(kind: .loading, text: "Loading your boards…")
            }
        }
        .refreshing(every: { Words.idleRefresh }) { _ in await customer.refreshOverview() }
        .pageToolbar(CustomerSection.boards.title)
    }
}

struct CustomerBoardPage: View {
    @EnvironmentObject private var customer: CustomerModel
    let id: String

    var body: some View {
        Group {
            if let detail = customer.details[id]?.value {
                let board = detail.board
                Form {
                    Section {
                        FactRow("Status", board.online ? "Online" : "Offline")
                        if let seen = board.lastSeen { FactRow("Last heard from", Words.whenAt(seen, now: Date())) }
                        if let firmware = board.firmware { FactRow("Firmware", firmware.version, mono: true) }
                        if let update = board.update, update.state != "idle" {
                            FactRow("Update", "\(update.state) · \(update.progress)%")
                        }
                    }
                }
                .formStyle(.grouped)
            } else if let error = customer.details[id]?.error {
                PageState(kind: .failed, text: Words.plainMessage(error)) { Task { await customer.loadBoard(id) } }
            } else {
                PageState(kind: .loading, text: "Loading…")
            }
        }
        .refreshing(every: { Words.idleRefresh }, concerns: { $0.boards.isEmpty || $0.boards.contains(id) }) { _ in
            await customer.loadBoard(id)
        }
        .pageToolbar(customer.boards.value?.first { $0.id == id }?.name ?? "Your Cranium")
    }
}

struct CustomerActivityPage: View {
    @EnvironmentObject private var customer: CustomerModel

    var body: some View {
        Group {
            if let events = customer.activity.value {
                if events.isEmpty {
                    PageState(kind: .empty, text: "Nothing yet.")
                } else {
                    List(Array(events.enumerated()), id: \.offset) { _, event in
                        HStack {
                            Text(event.what)
                            Spacer()
                            Text(Words.timeAgo(event.at, now: Date())).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                PageState(kind: .loading, text: "Loading…")
            }
        }
        .refreshing(every: { Words.idleRefresh }) { _ in await customer.loadActivity() }
        .pageToolbar(CustomerSection.activity.title)
    }
}

struct CustomerHelpPage: View {
    var body: some View {
        List {
            ForEach(Array(CustomerWords.help.enumerated()), id: \.offset) { _, section in
                Section(section.section) {
                    ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.question).font(.headline)
                            Text(item.answer).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 3)
                    }
                }
            }
        }
        .navigationTitle("Help")
    }
}
