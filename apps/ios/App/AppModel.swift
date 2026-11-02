import CraniumBLE
import CraniumKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// The app's one flow: sign in, pick a release, open the board's window, pair, send, press the
/// button. See docs/mobile-apps.md, "What a person does".
@MainActor
final class AppModel: ObservableObject {
    enum Stage: Equatable {
        case loading
        /// The configuration in the app cannot be used. Nothing works until it is rebuilt.
        case broken(String)
        case signedOut
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
        case uploading(UploadProgress)
        /// The image has arrived. The person presses Button 1.
        case sent(String)
        case failed(String)
    }

    @Published private(set) var stage: Stage = .loading
    @Published private(set) var configSource: ConfigSource?
    @Published private(set) var me: Me?
    @Published private(set) var releases: [FirmwareRelease] = []
    @Published var preferred: String?
    @Published private(set) var busy = false
    @Published var message: String?
    /// While the chosen release's image is checked or downloaded, before going to the boards.
    @Published private(set) var preparing: String?

    /// Images that have passed their checks in this session, by release version, and where they
    /// came from. The checked images kept on the phone are in `cache`.
    @Published private(set) var obtained: [String: ObtainedImage] = [:]
    /// What the phone keeps, for the release list and "Clear downloaded firmware".
    @Published private(set) var firmwareOnPhone: CacheSummary = .empty

    @Published private(set) var boards: [DiscoveredBoard] = []
    @Published private(set) var radioProblem: String?
    @Published private(set) var scanStarted: Date?

    @Published private(set) var boardStage: BoardStage = .pairing
    @Published private(set) var boardName: String?
    @Published private(set) var running: FirmwareVersion?
    @Published private(set) var offered: [FirmwareRelease] = []
    @Published private(set) var passkey: String?
    /// Set once the cloud has said, for a while, that it has no passkey for this board.
    @Published private(set) var passkeyNotInCloud = false
    @Published private(set) var uploadStarted: Date?
    /// The image being sent, for where it came from and its size.
    @Published private(set) var sending: ObtainedImage?
    @Published private(set) var device: DeviceStatus?

    private var auth: AuthSession?
    private var api: ConsoleAPI?
    private var callbackScheme = "cranium"
    /// Made when first needed: making it is what has iOS ask for Bluetooth, which should happen at
    /// the board, not at launch.
    private var radioIfMade: BoardRadio?
    private var session: BoardSession?
    private var thing: String?
    /// Application Support/firmware, out of the iCloud backup (docs/mobile-apps.md, "Cache").
    private let cache = FirmwareCache.standard()
    private var pairingPoll: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var devicePoll: Task<Void, Never>?
    private let webSignIn = WebSignIn()

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

    var canDownload: Bool { me?.canWrite == true }

    var chosenRelease: FirmwareRelease? {
        releases.first { $0.version == preferred }
    }

    // MARK: Start and sign-in

    func start() async {
        guard stage == .loading else { return }
        let loaded: LoadedConfig
        do {
            loaded = try CraniumConfig.load(from: .main)
        } catch {
            stage = .broken(UserMessage.text(for: error))
            return
        }
        configSource = loaded.source
        callbackScheme = loaded.config.callbackScheme
        let auth = AuthSession(config: loaded.config, http: URLSession.shared, store: KeychainTokenStore())
        self.auth = auth
        api = ConsoleAPI(config: loaded.config, http: URLSession.shared, tokens: auth)
        if await auth.isSignedIn {
            stage = .releases
            await refresh()
        } else {
            stage = .signedOut
            // A signed-out phone keeps nothing from the console, even after a sign-out cut short.
            await forgetFirmware()
        }
    }

    func signIn() async {
        guard let auth, !busy else { return }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let pending = await auth.beginSignIn()
            let callback = try await webSignIn.signIn(url: pending.url, callbackScheme: callbackScheme,
                                                      anchor: WebSignIn.currentAnchor())
            try await auth.completeSignIn(callback: callback, pending: pending)
            stage = .releases
            await refresh()
        } catch AuthError.cancelled {
            // The person closed the sheet: nothing to say.
        } catch {
            message = UserMessage.text(for: error)
        }
    }

    func signOut() async {
        await leaveBoard()
        radioIfMade?.stopScanning()
        await auth?.signOut()
        await forgetFirmware()
        me = nil
        releases = []
        sending = nil
        preferred = nil
        message = nil
        stage = .signedOut
    }

    // MARK: Releases

    /// Who is signed in, and the releases. The newest active one is the default choice.
    func refresh() async {
        guard let api else { return }
        busy = true
        defer { busy = false }
        do {
            async let who = api.me()
            async let list = api.firmware()
            let (me, firmware) = try await (who, list)
            self.me = me
            releases = ReleaseOffer.active(firmware.releases)
            // Keep only images of active releases, and none for an account that cannot download.
            if me.canWrite {
                firmwareOnPhone = await cache.prune(keepingActiveIn: firmware.releases)
                obtained = obtained.filter { _, held in releases.contains { held.isImage(of: $0) } }
            } else {
                await forgetFirmware()
            }
            if chosenRelease == nil {
                preferred = ReleaseOffer.newest(releases)?.version
            }
            message = me.canWrite ? nil
                : "Only a release manager can download firmware. Ask an administrator for the role."
        } catch {
            await handle(error)
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
            await handle(error)
        }
    }

    /// The checked image of `release`: one already checked in this session, else the one the
    /// phone keeps if it passes the check again, else a download that passes it (and is kept).
    private func image(for release: FirmwareRelease,
                       onDownload: @escaping @Sendable () async -> Void) async throws -> ObtainedImage {
        // An image on the phone is only for a phone that is still signed in.
        guard let api, let auth, await auth.isSignedIn else { throw AuthError.sessionExpired }
        if let held = obtained[release.version], held.isImage(of: release) { return held }
        let result = try await cache.image(for: release, onDownload: onDownload) {
            try await api.image(of: release)
        }
        obtained[release.version] = result
        firmwareOnPhone = await cache.summary()
        return result
    }

    /// "Clear downloaded firmware": the next update downloads its image again.
    func clearFirmware() async {
        await forgetFirmware()
    }

    private func forgetFirmware() async {
        await cache.clear()
        obtained = [:]
        firmwareOnPhone = .empty
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
    /// new one for each attempt, so this keeps asking.
    private func startPairingPoll(name: String) {
        pairingPoll?.cancel()
        let started = Date()
        pairingPoll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let api = self.api else { return }
                if let pairing = try? await api.pairing(name: name) {
                    self.passkey = pairing.passkey
                    self.thing = pairing.thing
                    self.passkeyNotInCloud = false
                } else if self.passkey == nil, Date().timeIntervalSince(started) > 8 {
                    self.passkeyNotInCloud = true
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// The board drops an authenticated link with nothing on it for 30 s. Reading the image list
    /// every 20 s keeps it while the person decides, and while another release downloads.
    /// (BoardSession reads nothing once an upload has started.)
    private func startKeepAlive() {
        keepAlive?.cancel()
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled, let self, let session = self.session else { return }
                switch self.boardStage {
                case .choose, .checking, .downloading: break
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

    func send() async {
        guard let session, let release = offered.first(where: { $0.version == preferred }) else { return }
        do {
            boardStage = .checking(release.version)
            let obtained = try await image(for: release) { @MainActor [weak self] in
                self?.boardStage = .downloading(release.version)
            }
            keepAlive?.cancel()
            sending = obtained
            boardStage = .uploading(UploadProgress(sent: 0, total: obtained.size))
            uploadStarted = Date()
            setScreenAwake(true)
            defer { setScreenAwake(false) }
            try await session.send(obtained.image) { progress in
                Task { @MainActor [weak self] in
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
            if case AuthError.sessionExpired = error {
                await handle(error)
            }
        }
    }

    /// After the upload, for a board that is online: show it coming back on the new version. The
    /// board's LEDs and console are the real answer; this only follows its reports.
    private func watchTheBoard(for version: String) {
        guard let thing, let api else { return }
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

    func done() async {
        await leaveBoard()
        stage = .releases
        await refresh()
    }

    // MARK: -

    private func handle(_ error: Error) async {
        if case AuthError.sessionExpired = error {
            await signOut()
        }
        message = UserMessage.text(for: error)
    }

    /// An upload takes minutes. With the screen locked the app stops, and so does the upload.
    private func setScreenAwake(_ awake: Bool) {
        #if canImport(UIKit)
        UIApplication.shared.isIdleTimerDisabled = awake
        #endif
    }
}
