import Foundation

/// One pool's sign-in for the shell's bridge (`auth.*` and `biometric.*` in apps/shared/bridge.json): the
/// page signs in on its own sign-in page and hands the tokens over (`store`); from then on it gets only
/// access tokens (`session`), and never sees the refresh token again.
///
/// Everything is kept as the classic app keeps it, with the same pieces: `AuthSession` (the same Keychain
/// items, so the classic app and the shell share one sign-in per pool) and `BiometricLock` (Face ID or
/// Touch ID, the 60-minute rule without it, the 5 minutes in the background with it). Nothing here prints
/// a token.
@MainActor
public final class ShellAuthPool {
    public enum Pool: String, Sendable, CaseIterable {
        case admin
        case customer
    }

    /// What `biometric.status` and `auth.store` say of the biometric.
    public struct BiometricState: Equatable, Sendable {
        public let available: Bool
        public let kind: Biometry?
        public let enabled: Bool
        /// After a sign-in: the app may offer to turn it on, once per person.
        public let offer: Bool

        public var json: JSONValue {
            ["available": .bool(available), "kind": .string(kind?.rawValue), "enabled": .bool(enabled)]
        }
    }

    /// An access token, and how long it is good for.
    public struct Access: Equatable, Sendable {
        public let token: String
        public let expiresIn: Int
    }

    /// `auth.session` refreshes a token with less than this left.
    public static let refreshBefore: TimeInterval = 120

    public let pool: Pool
    public let session: AuthSession
    public let lock: BiometricLock
    private let now: () -> Date
    /// The lock was asked once, at the first use: whether the session needs the biometric first.
    private var launched = false
    /// The biometric released the refresh token in this run (or none is needed).
    private var unlocked = false
    private var unlocking: Task<Bool, Error>?

    public init(pool: Pool, session: AuthSession, lock: BiometricLock, now: @escaping () -> Date = { Date() }) {
        self.pool = pool
        self.session = session
        self.lock = lock
        self.now = now
    }

    public var isUnlocked: Bool { unlocked }

    // MARK: auth.store

    /// The tokens of a full sign-in on the page (password and code): kept as the classic app keeps a sign-in
    /// on its own screen. A refresh token goes behind the biometric while that is on for this person;
    /// another person's sign-in turns it off.
    public func store(refreshToken: String, accessToken: String, expiresIn: Int) async throws -> BiometricState {
        guard !refreshToken.isEmpty, !accessToken.isEmpty, expiresIn > 0 else { throw BridgeError.badRequest("No tokens.") }
        let tokens = Tokens(accessToken: accessToken, refreshToken: refreshToken,
                            expiresAt: now().addingTimeInterval(TimeInterval(expiresIn)))
        do {
            try await session.completeSignIn(tokens: tokens)
        } catch {
            throw BridgeError.failed("The sign-in could not be kept on this iPhone.")
        }
        launched = true
        unlocked = true
        var offer = false
        if let account = await session.subject {
            await lock.afterFullSignIn(account: account)
            if lock.shouldOffer(account: account) {
                lock.markOffered(account: account)
                offer = true
            }
        }
        return await biometricState(offer: offer)
    }

    // MARK: auth.session

    /// An access token with at least `refreshBefore` left where the session can still be renewed; nil when
    /// nobody is signed in to this pool. Asks for the biometric first where that is on and has not been
    /// asked in this run (or was asked again after 5 minutes in the background).
    public func access() async throws -> Access? {
        guard try await ensureUnlocked() else { return nil }
        do {
            var token = try await session.accessToken()
            if let expiry = await session.accessTokenExpiresAt, expiry.timeIntervalSince(now()) < Self.refreshBefore,
               await session.hasRefreshToken {
                token = try await session.accessToken(replacing: token)
            }
            let left = (await session.accessTokenExpiresAt).map { Int($0.timeIntervalSince(now())) } ?? 0
            guard left > 0 else { return nil }
            return Access(token: token, expiresIn: left)
        } catch AuthError.notSignedIn, AuthError.sessionExpired {
            return nil
        } catch let error as URLError {
            throw BridgeError(.network, "Cognito could not be reached: \(error.localizedDescription)")
        } catch {
            throw BridgeError.failed(UserMessage.text(for: error))
        }
    }

    /// Whether there is a session to give a token from, asking for the biometric first if it has to.
    private func ensureUnlocked() async throws -> Bool {
        if !launched {
            launched = true
            switch await lock.launch() {
            case .signedOut, .signIn:
                return false
            case .open:
                unlocked = true
            case .locked:
                unlocked = false
            }
        }
        guard await session.isSignedIn else { return false }
        if unlocked { return true }
        if let unlocking { return try await unlocking.value }
        let task = Task { @MainActor [lock] () throws -> Bool in
            switch await lock.unlock() {
            case .unlocked:
                return true
            case .stay(let message):
                // No message: the person cancelled. A message: not recognised, or locked out.
                if let message { throw BridgeError(.locked, message) }
                throw BridgeError(.cancelled, "The saved sign-in was not opened.")
            case .password:
                // The prompt's own "Enter password": the page asks for the password and code.
                return false
            case .signIn(let reason):
                throw BridgeError(.locked, reason)
            }
        }
        unlocking = task
        defer { unlocking = nil }
        let opened = try await task.value
        unlocked = opened
        return opened
    }

    /// For the shell's own lock screen: asks for the biometric now, if the session needs it.
    public func unlockIfNeeded() async throws -> Bool {
        try await ensureUnlocked()
    }

    // MARK: auth.signOut

    public func signOut() async {
        await session.signOut()
        lock.signedOut()
        unlocked = false
        launched = true
    }

    // MARK: biometric.*

    public func biometricState(offer: Bool = false) async -> BiometricState {
        let kind = lock.biometry
        let account = await session.subject
        return BiometricState(available: kind != nil && lock.gate.isUsable(), kind: kind,
                              enabled: account.map { lock.isOn(for: $0) } ?? false, offer: offer)
    }

    /// Turns it on (one prompt, then the refresh token goes behind it) or off.
    public func setBiometric(_ enabled: Bool) async throws -> Bool {
        guard let account = await session.subject else { throw BridgeError(.signedOut, "Nobody is signed in here.") }
        guard enabled else {
            await lock.turnOff()
            return false
        }
        switch await lock.turnOn(account: account) {
        case .on: return true
        case .needsSignIn: throw BridgeError(.signedOut, "Sign in with your password and code first.")
        case .notNow: throw BridgeError(.cancelled, "It was not turned on.")
        case .failed(let text): throw BridgeError.failed(text)
        }
    }

    // MARK: The 5 minutes

    public func enteredBackground() async {
        lock.enteredBackground()
        await session.forgetRefreshTokenIfDue()
    }

    /// Back in the foreground. True when the biometric is asked again (5 minutes or more away): the
    /// next `access()` asks for it, and the page is told (`auth.locked`).
    public func becameActive() async -> Bool {
        await session.forgetRefreshTokenIfDue()
        guard lock.becameActive() else { return false }
        unlocked = false
        return true
    }

    /// Whether the biometric is on for whoever is signed in, and the session is waiting for it.
    public var needsUnlock: Bool {
        get async {
            guard launched, !unlocked, lock.isOn else { return false }
            return await session.isSignedIn
        }
    }
}

// MARK: Bluetooth, for the bridge

public enum ShellBluetooth {
    /// The largest image `ble.upload` takes: 2.5 MiB, which bridge.json's base64 limit allows.
    public static let maxImageBytes = 2_621_440

    /// `ble.watch`'s rule, as `UpdateWatch.Facts.isAboutThisSend`: the board's last update over Bluetooth
    /// is the version sent, and the image sent where both hashes are known.
    public static func isAboutThisSend(_ status: BoardStatus, version: String, hash: String?) -> Bool {
        guard status.lastVia == .bluetooth, UpdateWatch.same(status.lastTarget, version) else { return false }
        guard let hash, let theirs = status.lastHash else { return true }
        return hash == theirs
    }

    /// `ble.images`'s answer.
    public static func images(_ slots: [ImageSlot]) -> [String: JSONValue] {
        ["images": .array(slots.map { slot in
            ["image": .int(slot.image), "slot": .int(slot.slot), "version": .string(slot.version), "active": .bool(slot.active),
             "confirmed": .bool(slot.confirmed), "pending": .bool(slot.pending), "permanent": .bool(slot.permanent)]
        })]
    }

    /// The page's image for `ble.upload`, checked again here: its SHA-256 is the one the page names (and
    /// the console cleared), it is not larger than a slot can be, it starts with MCUboot's magic, and the
    /// sizes in its header fit the file. The version is the header's.
    public static func image(base64: String, sha256: String) throws -> VerifiedImage {
        guard let data = Data(base64Encoded: base64), !data.isEmpty else { throw BridgeError.badRequest("The image is not base64.") }
        guard data.count <= maxImageBytes else { throw BridgeError.badRequest("The image is larger than a board's slot.") }
        let digest = ImageCheck.sha256Hex(data)
        guard digest == sha256 else { throw BridgeError.badRequest(ImageCheckError.wrongHash.localizedDescription) }
        guard let header = MCUbootHeader(data) else { throw BridgeError.badRequest(ImageCheckError.notAnImage.localizedDescription) }
        let declared = UInt64(header.headerSize) + UInt64(header.protectedTLVSize) + UInt64(header.imageSize)
        guard declared <= UInt64(data.count) else { throw BridgeError.badRequest(ImageCheckError.badSizes.localizedDescription) }
        return VerifiedImage(release: header.version.description, version: header.version, data: data, sha256: digest, header: header)
    }

    /// `ble.state`'s words for the radio's state.
    public static func stateWord(ready: Bool, off: Bool, unauthorized: Bool, unsupported: Bool) -> String {
        if ready { return "on" }
        if off { return "off" }
        if unauthorized { return "unauthorized" }
        if unsupported { return "unsupported" }
        return "unknown"
    }
}
