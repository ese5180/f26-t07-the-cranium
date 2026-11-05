import CraniumBLE
import CraniumKit
import Foundation
#if canImport(UIKit)
import UIKit
import UniformTypeIdentifiers
#endif

/// An update over Bluetooth: pick a release, open the board's window, pair, send, press the
/// button, and follow the board until it keeps the image or goes back. See docs/mobile-apps.md,
/// "What a person does". The app's other screens talk to the console over the internet; this one
/// talks to a board in the room, then follows it: from firmware 1.14.0 by its own status over
/// Bluetooth, which it reads again with no pairing after the restart, and on the console.
@MainActor
final class BluetoothModel: ObservableObject {
    enum Stage: Equatable {
        case releases
        case boards
        case board
        /// After the send: what the board does, step by step (`UpdateWatch`).
        case watching
    }

    enum BoardStage: Equatable {
        /// Connecting and pairing: the phone asks for the passkey.
        case pairing
        /// The board has said what it runs; the newer releases are on offer.
        case choose
        /// Checking the image the phone holds for this release, if any.
        case checking(String)
        case downloading(String)
        /// Asking the console, right before the upload, whether the image may still be sent.
        case confirming(String)
        case uploading(UploadProgress)
        case failed(String)
    }

    @Published private(set) var stage: Stage = .releases
    @Published var preferred: String?
    @Published private(set) var busy = false
    @Published var message: String?
    /// While the chosen release's image is checked or downloaded, before going to the boards.
    @Published private(set) var preparing: String?

    /// Images that have passed their checks in this session, by release version, and where they
    /// came from. The checked images kept on the phone are in the app's cache.
    @Published private(set) var obtained: [String: ObtainedImage] = [:]

    @Published private(set) var boards: [DiscoveredBoard] = []
    @Published private(set) var radioProblem: String?
    @Published private(set) var scanStarted: Date?

    @Published private(set) var boardStage: BoardStage = .pairing
    @Published private(set) var boardName: String?
    @Published private(set) var running: FirmwareVersion?
    @Published private(set) var offered: [FirmwareRelease] = []
    @Published private(set) var passkey: String?
    /// The board the console says is pairing under this name, shown with the passkey.
    @Published private(set) var consoleThing: String?
    /// Set once the cloud has said, for a while, that it has no passkey for this board.
    @Published private(set) var passkeyNotInCloud = false
    @Published private(set) var uploadStarted: Date?
    /// The image being sent, for where it came from and its size.
    @Published private(set) var sending: ObtainedImage?

    /// After the send: the steps so far, the release and the board.
    @Published private(set) var watch: UpdateWatch.Timeline?
    @Published private(set) var watchVersion: String?
    @Published private(set) var watchBoard: String?
    /// The last update this phone followed on each board, by thing name, for the board's page.
    @Published private(set) var outcomes: [String: UpdateWatch.Record] = [:]

    private unowned let app: AppModel
    /// Made when first needed: making it is what has iOS ask for Bluetooth, which should happen at
    /// the board, not at launch.
    private var radioIfMade: BoardRadio?
    private var session: BoardSession?
    private var thing: String?
    private var pairingPoll: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?

    // Following the board after the send. The link is the watch's from then on, not the flow's.
    private var watchFacts: UpdateWatch.Facts?
    private var watchSession: BoardSession?
    private var watchTask: Task<Void, Never>?
    private var watchEndedAt: Date?
    /// The board's status on the link to the board in the room (firmware 1.14.0 on), the newest.
    private var linkStatus: BoardStatus?
    /// After the restart: the board's status, read with no pairing.
    private var statusWatcher: StatusWatcher?
    /// "Update another board": the person has moved on, so reopening the flow starts over.
    private var movedOn = false
    /// After the board's 2 minutes, how long a link that is still up is kept.
    static let linkGrace: TimeInterval = 15
    /// Image list reads that fail in a row before the link is taken to be gone.
    static let linkFailures = 3

    init(app: AppModel) {
        self.app = app
    }

    private var radio: BoardRadio {
        if let radio = radioIfMade { return radio }
        let radio = BoardRadio()
        radio.onChange = { [weak self, weak radio] in
            guard let self, let radio else { return }
            self.boards = radio.boards
            self.radioProblem = radio.state.problem
        }
        radioIfMade = radio
        return radio
    }

    /// The active releases, newest first: only those may be sent.
    var releases: [FirmwareRelease] { ReleaseOffer.active(app.releases ?? []) }

    var chosenRelease: FirmwareRelease? {
        releases.first { $0.version == preferred }
    }

    /// Opens the flow, with `release` chosen if it may be sent.
    func open(release: String?) async {
        // Within 5 minutes of the last follow, and not moved on since: the flow shows how it went.
        if watch != nil, !movedOn,
           watchTask != nil || watchEndedAt.map({ Date().timeIntervalSince($0) < UpdateWatch.keepSeconds }) == true {
            stage = .watching
            return
        }
        stage = .releases
        message = nil
        if app.firmware.value == nil { await app.loadFirmware() }
        if let release, releases.contains(where: { $0.version == release }) {
            preferred = release
        } else if chosenRelease == nil {
            preferred = ReleaseOffer.newest(releases)?.version
        }
        obtained = obtained.filter { _, held in releases.contains { held.isImage(of: $0) } }
        await app.ensureMe()
        if app.me == nil {
            message = "Your account could not be checked with the console\(app.meProblem.map { ": \($0)" } ?? ".") Check again below."
        } else if !app.canWrite {
            message = "Only a release manager can download firmware. Ask an administrator for the role."
        }
    }

    /// Gets the chosen release's image ready before anyone goes to the board, from the phone or
    /// downloaded, so that a refusal or a bad image shows up here, and the link to the board is
    /// not left idle later.
    func continueToBoards() async {
        guard let release = chosenRelease, !busy else { return }
        busy = true
        message = nil
        preparing = "Checking \(release.version)…"
        defer {
            busy = false
            preparing = nil
        }
        do {
            _ = try await image(for: release) { @MainActor [weak self] in
                self?.preparing = "Downloading \(release.version) from the console…"
            }
            stage = .boards
            lookForBoards()
        } catch {
            await fail(error)
        }
    }

    /// The checked image of `release`: one already checked in this session, else the one the
    /// phone keeps if it passes the check again, else a download that passes it (and is kept).
    private func image(for release: FirmwareRelease,
                       onDownload: @escaping @Sendable () async -> Void) async throws -> ObtainedImage {
        // An image on the phone is only for a phone that is still signed in.
        guard let api = app.api, await app.isSignedIn else { throw AuthError.sessionExpired }
        if let held = obtained[release.version], held.isImage(of: release) { return held }
        let result = try await app.cache.image(for: release, onDownload: onDownload) {
            try await api.image(of: release)
        }
        obtained[release.version] = result
        await app.noteFirmwareOnPhone()
        return result
    }

    /// What the phone held in this session goes when the cache is cleared.
    func forgetImages() {
        obtained = [:]
    }

    func backToReleases() {
        radioIfMade?.stopScanning()
        stage = .releases
    }

    // MARK: Boards

    func lookForBoards() {
        message = nil
        scanStarted = Date()
        radio.startScanning()
    }

    func connect(to board: DiscoveredBoard) async {
        guard let transport = radio.transport(for: board) else {
            message = UserMessage.noBoard
            return
        }
        radio.stopScanning()
        let session = BoardSession(transport: transport)
        self.session = session
        boardName = board.name
        running = nil
        offered = []
        passkey = nil
        consoleThing = nil
        passkeyNotInCloud = false
        thing = nil
        linkStatus = nil
        boardStage = .pairing
        stage = .board
        startPairingPoll(name: board.name)
        // From firmware 1.14.0: what the board says of its window, from the pairing on.
        session.transport.observeStatus { [weak self] status in
            Task { @MainActor in self?.boardSaid(status, session: session) }
        }
        do {
            let version = try await session.open()
            pairingPoll?.cancel()
            running = version
            offered = await session.offer(releases)
            preferred = ReleaseOffer.choice(keeping: preferred, in: offered)?.version ?? preferred
            boardStage = .choose
            startKeepAlive()
        } catch {
            pairingPoll?.cancel()
            await session.close()
            boardStage = .failed(UserMessage.text(for: error))
        }
    }

    /// While pairing: the passkey from the cloud, for a board that is online. The board draws a
    /// new one for each attempt, so this keeps asking, every 3 s for at most 90 s.
    private func startPairingPoll(name: String) {
        pairingPoll?.cancel()
        let started = Date()
        pairingPoll = Task { [weak self] in
            while !Task.isCancelled, Date().timeIntervalSince(started) < 90 {
                guard let self, let api = self.app.api else { return }
                if let pairing = try? await api.pairing(name: name) {
                    if self.passkey != pairing.passkey { BluetoothModel.offerToPaste(pairing.passkey) }
                    self.passkey = pairing.passkey
                    self.thing = pairing.thing
                    self.consoleThing = BoardName.isThing(pairing.thing) ? pairing.thing : nil
                    self.passkeyNotInCloud = false
                } else if self.passkey == nil, Date().timeIntervalSince(started) > 8 {
                    self.passkeyNotInCloud = true
                }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    /// The phone's pairing box covers the middle of the screen, and the passkey with it: so each new
    /// passkey also goes on the clipboard, for this phone only and for 2 minutes, to paste into the box.
    static func offerToPaste(_ passkey: String) {
        #if canImport(UIKit)
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: passkey]],
                                      options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
        #endif
    }

    /// The board's device ID, where the console knows the board that is pairing.
    var consoleName: String? {
        guard let consoleThing else { return nil }
        return app.deviceList?.first { $0.thing == consoleThing }?.name
    }

    /// The board drops an authenticated link with nothing on it for 120 s (30 s before 1.11.2).
    /// Reading the image list every 15 s keeps it while the person decides, and while another
    /// release downloads. (BoardSession reads nothing once an upload has started.)
    private func startKeepAlive() {
        keepAlive?.cancel()
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled, let self, let session = self.session else { return }
                switch self.boardStage {
                case .choose, .checking, .downloading, .confirming: break
                default: continue
                }
                do {
                    try await session.refresh()
                } catch {
                    self.boardStage = .failed(UserMessage.text(for: error))
                    return
                }
            }
        }
    }

    /// Sends the chosen release: its checked image, from this session, the phone or a download,
    /// once the console has said, right now, that it may still be sent. Without that answer,
    /// offline included, nothing is sent (docs/mobile-apps.md, step 6).
    func send() async {
        guard let session, let api = app.api, let release = offered.first(where: { $0.version == preferred }) else { return }
        do {
            boardStage = .checking(release.version)
            let obtained = try await image(for: release) { @MainActor [weak self] in
                self?.boardStage = .downloading(release.version)
            }
            boardStage = .confirming(release.version)
            try await api.confirmSend(obtained.image, board: boardName)
            keepAlive?.cancel()
            sending = obtained
            boardStage = .uploading(UploadProgress(sent: 0, total: obtained.size))
            uploadStarted = Date()
            setScreenAwake(true)
            defer { setScreenAwake(false) }
            try await session.send(obtained.image, keepingTheLink: true) { [weak self] progress in
                Task { @MainActor in
                    guard let self, case .uploading = self.boardStage else { return }
                    self.boardStage = .uploading(progress)
                }
            }
            // The link is kept: the board closes it when a button is pressed or its 2 minutes are up.
            self.session = nil
            follow(session, version: release.version, hash: obtained.image.imageHashPrefix)
        } catch {
            keepAlive?.cancel()
            await session.close()
            boardStage = .failed(UserMessage.text(for: error))
            await app.handle(error)
        }
    }

    // MARK: After the send

    /// Follows the board that `linked` has just sent `version` to: the board's own status and the link
    /// while it lasts, then the console and, from firmware 1.14.0, the board's status after its restart
    /// (`UpdateWatch`, docs/mobile-apps.md).
    private func follow(_ linked: BoardSession, version: String, hash: String?) {
        endWatch()
        movedOn = false
        watchEndedAt = nil
        watchSession = linked
        watchVersion = version
        watchBoard = boardName
        let now = Date()
        watchFacts = UpdateWatch.Facts(version: version, from: running?.description, sentAt: now, thing: thing,
                                       readings: linkStatus.map { [UpdateWatch.Reading($0, at: now)] } ?? [],
                                       sentHash: hash)
        showWatch()
        stage = .watching
        watchTask = Task { [weak self] in
            guard let self else { return }
            // The person is at the board for these 2 minutes: with the screen locked, the app would stop.
            // Over Bluetooth after the restart too: iOS does not let an app in the background look for it.
            self.setScreenAwake(true)
            await self.followLink(linked)
            async let console: Void = self.followConsole()
            async let board: Void = self.followBoard()
            _ = await (console, board)
            self.setScreenAwake(false)
            // A follow that was ended for a newer one leaves the newer one alone.
            guard !Task.isCancelled else { return }
            self.watchTask = nil
            self.watchEndedAt = Date()
        }
    }

    /// What the board says on its link: kept for the follow, and, once the image is sent, each status
    /// that says something new.
    private func boardSaid(_ status: BoardStatus, session: BoardSession) {
        guard status.isNews(after: linkStatus) else { return }
        linkStatus = status
        guard watchSession === session, watchFacts?.linkDroppedAt == nil else { return }
        changeWatch { $0.readings.append(UpdateWatch.Reading(status, at: Date())) }
    }

    /// After the restart: the board's status, as `StatusWatcher` reads it, when it says something new.
    private func boardSaidAfterRestart(_ status: BoardStatus) {
        changeWatch { facts in
            guard status.isNews(after: facts.readings.last(where: \.afterRestart)?.status) else { return }
            facts.readings.append(UpdateWatch.Reading(status, at: Date(), afterRestart: true))
        }
    }

    /// From firmware 1.14.0, once the link has gone: the board advertises its status for 2 minutes after
    /// the restart, into the new image or back into the old one, and it is read with no pairing until the
    /// follow ends (`UpdateWatch.followUntil`). A board without the status is followed on the console alone.
    private func followBoard() async {
        guard let facts = watchFacts, facts.tellsOverBluetooth, facts.linkDroppedAt != nil else { return }
        let watcher = StatusWatcher(radio: radio, accept: { facts.isAboutThisSend($0) }, onStatus: { [weak self] status in
            Task { @MainActor in self?.boardSaidAfterRestart(status) }
        })
        statusWatcher = watcher
        watcher.start()
        defer {
            watcher.stop()
            if statusWatcher === watcher { statusWatcher = nil }
        }
        while !Task.isCancelled, let facts = watchFacts {
            if UpdateWatch.timeline(facts).finished { return }
            if let until = UpdateWatch.followUntil(facts), Date() >= until {
                changeWatch { $0.gaveUp = true }
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    /// While the board keeps the link: one look at the console (is the board on it?), then the image
    /// list every few seconds, which the board allows while it waits for a button, until the link goes.
    private func followLink(_ linked: BoardSession) async {
        if let thing = watchFacts?.thing, let api = app.api {
            let online = try? await api.deviceDetail(thing: thing).device.online
            changeWatch { $0.onConsole = online }
        }
        var failures = 0
        while !Task.isCancelled, let facts = watchFacts, facts.linkDroppedAt == nil {
            // The board closes the link at the end of its 2 minutes: one still up after that is let go.
            if Date() > facts.sentAt.addingTimeInterval(UpdateWatch.offerSeconds + Self.linkGrace) {
                await watchLinkGone()
                return
            }
            do {
                try await linked.readAfterSend()
                failures = 0
            } catch BoardError.disconnected, BoardError.notFound {
                await watchLinkGone()
                return
            } catch BoardError.bluetoothUnavailable(_) {
                await watchLinkGone()
                return
            } catch {
                failures += 1
            }
            if failures >= Self.linkFailures {
                await watchLinkGone()
                return
            }
            try? await Task.sleep(nanoseconds: UInt64(UpdateWatch.linkReadSeconds * 1_000_000_000))
        }
    }

    /// After the link: the board's log, its connections and its report, every 3 s for up to 5 minutes, and
    /// longer while the board says over Bluetooth that it is on trial (`UpdateWatch.followUntil`).
    private func followConsole() async {
        guard watchFacts?.linkDroppedAt != nil else { return }
        var tick = 0
        var throttled = 0
        while !Task.isCancelled, let facts = watchFacts {
            if UpdateWatch.timeline(facts).finished { return }
            if let until = UpdateWatch.followUntil(facts), Date() >= until {
                changeWatch { $0.gaveUp = true }
                return
            }
            guard let api = app.api, let thing = facts.thing else { return }
            let from = facts.sentAt.addingTimeInterval(-UpdateWatch.clockSlack)
            do {
                let lines = try await api.boardLog(from: from, to: Date(), thing: thing, tags: ["BT", "bt_ota"], limit: 100).lines
                // Two calls each time at most: the log every time, and the connections and the report in turn.
                if tick % 2 == 0 {
                    let events = try await api.events(from: from, to: Date(), thing: thing, kinds: ["connection"]).events
                    changeWatch {
                        $0.lines = lines
                        $0.events = events
                        $0.consoleFailed = false
                    }
                } else {
                    let device = try await api.deviceDetail(thing: thing).device
                    changeWatch {
                        $0.lines = lines
                        $0.device = device
                        $0.consoleFailed = false
                    }
                }
                throttled = 0
            } catch let error as APIError where error.status == 429 {
                throttled += 1
            } catch is AuthError {
                return
            } catch {
                if Task.isCancelled { return }
                changeWatch { $0.consoleFailed = true }
            }
            tick += 1
            try? await Task.sleep(nanoseconds: UInt64(UpdateWatch.nextPoll(throttled: throttled) * 1_000_000_000))
        }
    }

    /// The board closed the link, or it is taken to have: the console is followed from here.
    private func watchLinkGone() async {
        if watchFacts?.linkDroppedAt == nil { changeWatch { $0.linkDroppedAt = Date() } }
        if let linked = watchSession {
            watchSession = nil
            await linked.close()
        }
    }

    private func changeWatch(_ change: (inout UpdateWatch.Facts) -> Void) {
        guard var facts = watchFacts else { return }
        change(&facts)
        watchFacts = facts
        showWatch()
    }

    private func showWatch() {
        guard let facts = watchFacts else { return }
        let timeline = UpdateWatch.timeline(facts)
        watch = timeline
        if let record = UpdateWatch.record(facts, timeline) { outcomes[record.thing] = record }
    }

    private func endWatch() {
        watchTask?.cancel()
        watchTask = nil
        statusWatcher?.stop()
        statusWatcher = nil
        if let linked = watchSession {
            watchSession = nil
            Task { await linked.close() }
        }
    }

    /// Stops everything, the following of a board included, and forgets what was followed: for a
    /// sign-out, when nothing of the console is kept.
    func leaveBoard() async {
        await letGo()
        endWatch()
        watchFacts = nil
        watch = nil
        outcomes = [:]
    }

    /// Stops whatever is going on with the board in the room, and lets go of its link. A board that was
    /// sent to is still followed.
    private func letGo() async {
        pairingPoll?.cancel()
        keepAlive?.cancel()
        radioIfMade?.stopScanning()
        if let session {
            self.session = nil
            await session.close()
        }
        setScreenAwake(false)
    }

    func backToBoards() async {
        await letGo()
        stage = .boards
        lookForBoards()
    }

    /// "Update another board", after a send: the board that was sent to is still followed, for its page.
    func anotherBoard() async {
        await letGo()
        movedOn = true
        sending = nil
        stage = .releases
        await open(release: nil)
    }

    /// Closes the flow. A board that was sent to is still followed, and reopening the flow within 5
    /// minutes shows it.
    func close() async {
        await letGo()
        guard stage != .watching else { return }
        stage = .releases
        sending = nil
    }

    // MARK: -

    private func fail(_ error: Error) async {
        message = UserMessage.text(for: error)
        await app.handle(error)
    }

    /// An upload takes minutes. With the screen locked the app stops, and so does the upload.
    private func setScreenAwake(_ awake: Bool) {
        #if canImport(UIKit)
        UIApplication.shared.isIdleTimerDisabled = awake
        #endif
    }
}
