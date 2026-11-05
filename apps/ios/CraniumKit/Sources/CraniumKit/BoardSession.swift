import Foundation

/// Why the app itself will not send an image. The board would refuse each of these too; checking
/// first gives a clearer answer, and spends nothing of the window.
public enum UpdateError: Error, Equatable, LocalizedError {
    /// The release is not strictly newer than what runs in slot 0.
    case notNewer(release: FirmwareVersion, running: FirmwareVersion)
    /// An image has already arrived in this window.
    case alreadySent
    /// The board has not said what it runs yet.
    case notConnected
    /// An upload is already under way.
    case busy

    public var errorDescription: String? { UserMessage.text(for: self) }
}

/// One connection to one board, for one window: pair, read what runs, send one newer image,
/// disconnect. Everything goes through `BoardTransport`, so tests drive it with a fake.
public actor BoardSession {
    public nonisolated let transport: BoardTransport
    public nonisolated var name: String { transport.name }

    /// What runs, from slot 0 of image 0. It decides what may be sent.
    public private(set) var running: FirmwareVersion?
    public private(set) var slots: [ImageSlot] = []
    /// True once an image has arrived: the board takes one per window.
    public private(set) var hasSent = false
    private var uploading = false

    public init(transport: BoardTransport) {
        self.transport = transport
    }

    /// Connects, pairs (the phone asks for the passkey), and reads what runs.
    @discardableResult
    public func open() async throws -> FirmwareVersion {
        try await transport.connect()
        return try await refresh()
    }

    /// Reads the image list again. Besides saying what runs, it keeps the link busy: the board
    /// drops an authenticated link on which nothing happens for 30 s. Does nothing during an
    /// upload.
    @discardableResult
    public func refresh() async throws -> FirmwareVersion {
        if uploading || hasSent, let running {
            return running
        }
        let slots = try await transport.readImageState()
        guard let slot0 = slots.first(where: { $0.image == 0 && $0.slot == 0 }),
              let text = slot0.version,
              let version = FirmwareVersion(imageList: text) else {
            throw BoardError.noRunningVersion
        }
        self.slots = slots
        running = version
        return version
    }

    /// The releases this board may be sent: active, and strictly newer than what runs.
    public func offer(_ releases: [FirmwareRelease]) -> [FirmwareRelease] {
        guard let running else { return [] }
        return ReleaseOffer.newer(than: running, in: releases)
    }

    /// Uploads a checked image, and only that: no test, confirm or reset afterwards, which the
    /// board refuses. Then disconnects, unless `keepingTheLink`: the app then reads the image list
    /// until the board closes the link, which it does when a button is pressed or its 2 minutes are
    /// up (`readAfterSend`). The board offers the image to the person at it, who presses Button 1 to
    /// install it.
    public func send(_ image: VerifiedImage, keepingTheLink: Bool = false,
                     progress: @escaping @Sendable (UploadProgress) -> Void) async throws {
        guard let running else { throw UpdateError.notConnected }
        guard !hasSent else { throw UpdateError.alreadySent }
        guard !uploading else { throw UpdateError.busy }
        guard image.version > running else {
            throw UpdateError.notNewer(release: image.version, running: running)
        }
        uploading = true
        defer { uploading = false }
        do {
            try await transport.upload(image, progress: progress)
        } catch BoardError.disconnected, BoardError.timedOut {
            throw BoardError.disconnectedDuringUpload
        }
        hasSent = true
        if !keepingTheLink { await transport.disconnect() }
    }

    /// After the send, on a link that was kept: the image list, which the board still allows while it
    /// waits for a button. It throws `BoardError.disconnected` once the board has closed the link.
    @discardableResult
    public func readAfterSend() async throws -> [ImageSlot] {
        guard hasSent else { throw UpdateError.notConnected }
        return try await transport.readImageState()
    }

    public func close() async {
        await transport.disconnect()
    }
}
