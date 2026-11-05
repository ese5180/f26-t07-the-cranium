import Foundation
import Testing
@testable import CraniumKit

@Suite struct BoardSessionTests {
    func image(_ version: String) throws -> VerifiedImage {
        let data = makeImage(version: FirmwareVersion(release: version)!)
        return try ImageCheck.verify(data, for: release(for: data, version: version))
    }

    let releases = [
        FirmwareRelease(version: "1.8.0+0", size: 1, sha256: "", status: "active"),
        FirmwareRelease(version: "1.7.0+1", size: 1, sha256: "", status: "active"),
        FirmwareRelease(version: "1.7.0+0", size: 1, sha256: "", status: "active"),
        FirmwareRelease(version: "1.9.0+0", size: 1, sha256: "", status: "revoked"),
    ]

    @Test func openPairsAndReadsSlotZero() async throws {
        let board = FakeBoard(running: "1.7.0", secondary: "1.9.9")
        let session = BoardSession(transport: board)
        let running = try await session.open()
        #expect(running == FirmwareVersion(release: "1.7.0+0"))
        #expect(board.calls == [.connect, .list])
        #expect(await session.offer(releases).map(\.version) == ["1.8.0+0", "1.7.0+1"])
    }

    @Test func aBuildNumberInTheImageList() async throws {
        let session = BoardSession(transport: FakeBoard(running: "1.7.0.1"))
        #expect(try await session.open() == FirmwareVersion(release: "1.7.0+1"))
        #expect(await session.offer(releases).map(\.version) == ["1.8.0+0"])
    }

    @Test func sendsANewerImageThenDisconnectsAndNothingElse() async throws {
        let board = FakeBoard(running: "1.7.0")
        let session = BoardSession(transport: board)
        try await session.open()
        let seen = Seen()
        try await session.send(try image("1.8.0+0")) { seen.add($0) }
        #expect(board.calls == [.connect, .list, .upload("1.8.0+0"), .disconnect])
        #expect(seen.last?.fraction == 1)
        #expect(await session.hasSent)
    }

    @Test func aSendThatKeepsTheLinkReadsTheImageListAfterIt() async throws {
        let board = FakeBoard(running: "1.7.0")
        let session = BoardSession(transport: board)
        try await session.open()
        await #expect(throws: UpdateError.notConnected) { try await session.readAfterSend() }
        try await session.send(try image("1.8.0+0"), keepingTheLink: true) { _ in }
        try await session.readAfterSend()
        #expect(board.calls == [.connect, .list, .upload("1.8.0+0"), .list])
        await session.close()
        #expect(board.calls.last == .disconnect)
    }

    @Test func notNewerIsRefusedBeforeAnythingIsSent() async throws {
        let board = FakeBoard(running: "1.8.0")
        let session = BoardSession(transport: board)
        try await session.open()
        let running = FirmwareVersion(release: "1.8.0+0")!
        await #expect(throws: UpdateError.notNewer(release: running, running: running)) {
            try await session.send(try image("1.8.0+0")) { _ in }
        }
        await #expect(throws: UpdateError.notNewer(release: FirmwareVersion(release: "1.7.0+5")!, running: running)) {
            try await session.send(try image("1.7.0+5")) { _ in }
        }
        #expect(board.calls == [.connect, .list])
    }

    @Test func nothingIsSentBeforeTheBoardHasSaidWhatRuns() async throws {
        let board = FakeBoard()
        let session = BoardSession(transport: board)
        await #expect(throws: UpdateError.notConnected) { try await session.send(try image("1.8.0+0")) { _ in } }
        #expect(board.calls.isEmpty)
    }

    @Test func onePerWindow() async throws {
        let board = FakeBoard(running: "1.7.0")
        let session = BoardSession(transport: board)
        try await session.open()
        try await session.send(try image("1.8.0+0")) { _ in }
        await #expect(throws: UpdateError.alreadySent) { try await session.send(try image("1.8.0+1")) { _ in } }
        #expect(board.calls.filter { if case .upload = $0 { return true } else { return false } }.count == 1)
    }

    @Test func aRefusedUploadCanBeFollowedByAnother() async throws {
        let board = FakeBoard(running: "1.7.0")
        board.uploadError = BoardError.uploadRefused
        let session = BoardSession(transport: board)
        try await session.open()
        await #expect(throws: BoardError.uploadRefused) { try await session.send(try image("1.8.0+0")) { _ in } }
        #expect(await !session.hasSent)
        board.uploadError = nil
        try await session.send(try image("1.8.0+0")) { _ in }
        #expect(await session.hasSent)
    }

    @Test func aDropDuringTheUploadSaysToStartOver() async throws {
        for error in [BoardError.disconnected, .timedOut] {
            let board = FakeBoard(running: "1.7.0")
            board.uploadError = error
            let session = BoardSession(transport: board)
            try await session.open()
            await #expect(throws: BoardError.disconnectedDuringUpload) { try await session.send(try image("1.8.0+0")) { _ in } }
        }
        #expect(UserMessage.text(for: BoardError.disconnectedDuringUpload).contains("it starts over"))
    }

    @Test func aKeepAliveDuringTheUploadSendsNothing() async throws {
        let board = FakeBoard(running: "1.7.0")
        let session = BoardSession(transport: board)
        try await session.open()
        board.uploadStarted = {
            // The app's keep-alive firing in the middle of an upload.
            _ = try? await session.refresh()
        }
        try await session.send(try image("1.8.0+0")) { _ in }
        #expect(board.calls == [.connect, .list, .upload("1.8.0+0"), .disconnect])
    }

    @Test func noSlotZeroMeansNothingToCompareWith() async throws {
        let board = FakeBoard()
        board.slots = [ImageSlot(image: 0, slot: 1, version: "1.7.0")]
        await #expect(throws: BoardError.noRunningVersion) { try await BoardSession(transport: board).open() }
    }

    @Test func pairingFailureComesStraightThrough() async throws {
        let board = FakeBoard()
        board.connectError = BoardError.pairingFailed
        await #expect(throws: BoardError.pairingFailed) { try await BoardSession(transport: board).open() }
        #expect(board.calls == [.connect])
    }
}

/// Progress reports, from whichever thread.
final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [UploadProgress] = []
    func add(_ value: UploadProgress) { lock.withLock { values.append(value) } }
    var last: UploadProgress? { lock.withLock { values.last } }
}

@Suite struct UserMessageTests {
    /// docs/mobile-apps.md, "Errors to expect": what the app says.
    @Test func theContractsErrorTable() {
        #expect(UserMessage.text(for: BoardError.notFound).contains("Hold Button 1 for 5 s, then look again"))
        #expect(UserMessage.text(for: BoardError.pairingFailed).contains("Open the window again"))
        #expect(UserMessage.text(for: BoardError.pairingFailed).contains("use the new passkey"))
        #expect(UserMessage.text(for: BoardError.uploadRefused).contains("Pick a newer release, or open a new window"))
        #expect(UserMessage.text(for: BoardError.disconnectedDuringUpload).contains("Open a new window and send it again: it starts over"))
        #expect(UserMessage.text(for: APIError(status: 403, code: "forbidden", message: "No.")).contains("Ask an administrator for the role"))
    }

    @Test func boardNames() {
        #expect(BoardName.isValid("Cranium-1A2B"))
        #expect(BoardName.isValid("Cranium-0000"))
        for name in ["Cranium-1a2b", "Cranium-1A2", "Cranium-1A2B3", "cranium-1A2B", "Cranium-GHIJ", "Cranium", ""] {
            #expect(!BoardName.isValid(name), "\(name)")
        }
    }
}
