import CraniumBLE
import CraniumKit
import Foundation
#if canImport(UIKit)
import UIKit
import UniformTypeIdentifiers
#endif

/// An update over Bluetooth: pick a release, open the board's window, pair, send, press the
/// button. See docs/mobile-apps.md, "What a person does". The app's other screens talk to the
/// console over the internet; this one talks to a board in the room.
@MainActor
final class BluetoothModel: ObservableObject {
    enum Stage: Equatable {
        case releases
        case boards
        case board
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
        /// The image has arrived. The person presses Button 1.
        case sent(String)
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
    @Published private(set) var device: DeviceStatus?

    private unowned let app: AppModel
    /// Made when first needed: making it is what has iOS ask for Bluetooth, which should happen at
    /// the board, not at launch.
    private var radioIfMade: BoardRadio?
    private var session: BoardSession?
    private var thing: String?
    private var pairingPoll: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var devicePoll: Task<Void, Never>?

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
        device = nil
        boardStage = .pairing
        stage = .board
        startPairingPoll(name: board.name)
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
            try await session.send(obtained.image) { [weak self] progress in
                Task { @MainActor in
                    guard let self, case .uploading = self.boardStage else { return }
                    self.boardStage = .uploading(progress)
                }
            }
            boardStage = .sent(release.version)
            watchTheBoard(for: release.version)
        } catch {
            keepAlive?.cancel()
            await session.close()
            boardStage = .failed(UserMessage.text(for: error))
            await app.handle(error)
        }
    }

    /// After the upload, for a board that is online: show it coming back on the new version. The
    /// board's LEDs and console are the real answer; this only follows its reports.
    private func watchTheBoard(for version: String) {
        guard let thing, let api = app.api else { return }
        devicePoll?.cancel()
        devicePoll = Task { [weak self] in
            let until = Date().addingTimeInterval(12 * 60)
            while !Task.isCancelled, Date() < until {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled, let self else { return }
                if let status = try? await api.device(thing: thing) {
                    self.device = status
                    if status.fw?.version == version, status.fw?.confirmed == true { return }
                }
            }
        }
    }

    /// Stops whatever is going on with the board, and lets go of the link.
    func leaveBoard() async {
        pairingPoll?.cancel()
        keepAlive?.cancel()
        devicePoll?.cancel()
        radioIfMade?.stopScanning()
        if let session {
            self.session = nil
            await session.close()
        }
        setScreenAwake(false)
    }

    func backToBoards() async {
        await leaveBoard()
        stage = .boards
        lookForBoards()
    }

    /// Closes the flow.
    func close() async {
        await leaveBoard()
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
