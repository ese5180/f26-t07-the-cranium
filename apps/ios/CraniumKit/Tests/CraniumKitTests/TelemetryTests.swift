import Foundation
import Testing
@testable import CraniumKit

/// The Events and Diagnostics words and data (cloud/web/src/site/assets/telemetry.js).
@Suite struct TelemetryTests {
    let now = ConsoleTime.date("2026-11-03T12:00:00.000Z")!

    func at(_ minutesAgo: Double) -> Date { now.addingTimeInterval(-minutesAgo * 60) }

    func connection(_ what: String, _ minutesAgo: Double) -> Telemetry.Marker {
        Telemetry.Marker(id: "\(what)-\(minutesAgo)", thing: "cranium-0123456789abcdef", at: at(minutesAgo), kind: "connection",
                         what: what, warn: false, text: what, job: nil, link: nil)
    }

    @Test func onlineBandsFromConnections() {
        let bands = Telemetry.onlineBands([connection("connected", 50), connection("disconnected", 30)],
                                          from: at(60), to: now, device: nil, live: false)
        #expect(bands == [Telemetry.Band(from: at(50), to: at(30), inferred: false)])
        // Online from the start of the range when the first event says it went away.
        let first = Telemetry.onlineBands([connection("disconnected", 30)], from: at(60), to: now, device: nil, live: false)
        #expect(first == [Telemetry.Band(from: at(60), to: at(30), inferred: false)])
        // No event, and the range ends now: the heartbeat says it.
        let online = Device(thing: "cranium-0123456789abcdef", online: true, lastSeen: ConsoleTime.text(at(0.2)))
        #expect(Telemetry.onlineBands([], from: at(60), to: now, device: online, live: true)
            == [Telemetry.Band(from: at(60), to: now, inferred: false)])
        // A board that went quiet without a disconnect ends its band when its heartbeat stopped counting.
        let quiet = Device(thing: "cranium-0123456789abcdef", online: false, lastSeen: ConsoleTime.text(at(20)))
        let ended = Telemetry.onlineBands([connection("connected", 50)], from: at(60), to: now, device: quiet, live: true)
        #expect(ended == [Telemetry.Band(from: at(50), to: at(20).addingTimeInterval(90), inferred: false)])
    }

    @Test func lanesPerBoardAndTheConsoleLast() {
        let devices = [Device(thing: "cranium-fedcba9876543210", name: "B2"), Device(thing: "cranium-0123456789abcdef")]
        let lanes = Telemetry.lanes(events: [connection("connected", 5)], devices: devices,
                                    console: [Telemetry.Marker(id: "c", thing: nil, at: at(1), kind: "console", what: "x",
                                                               warn: false, text: "t", job: nil, link: nil)])
        #expect(lanes.map(\.id) == ["cranium-0123456789abcdef", "cranium-fedcba9876543210", "console"])
        #expect(lanes[0].markers.count == 1)
        #expect(lanes[1].device?.name == "B2")
        let one = Telemetry.lanes(events: [], devices: devices, thing: "cranium-fedcba9876543210", console: nil)
        #expect(one.map(\.id) == ["cranium-fedcba9876543210"])
        let shown = Telemetry.shown(lanes, hidden: ["connection"])
        #expect(shown.map(\.kind) == ["console"])
    }

    @Test func theConsoleLaneSaysWhoDidWhat() throws {
        let entry = AuditEntry(at: "2026-11-03T11:00:00.000Z", actor: Person(sub: "s", email: "a@b.test"),
                               action: "firmware.revoke", target: "1.8.0+0", outcome: "ok")
        let marker = try #require(Telemetry.consoleMarker(entry))
        #expect(marker.text == "a@b.test revoked firmware 1.8.0+0")
        #expect(marker.link == .firmware)
        #expect(marker.kind == "console")
    }

    @Test func rangesAsTheAPITakesThem() {
        let span = Telemetry.span(.preset("7d"), now: now)
        #expect(span.live)
        #expect(now.timeIntervalSince(span.from) == 7 * 86_400)
        #expect(Telemetry.rangeWords(.preset("1h"), now: now) == "the last hour, up to now")
        if case .failure(let problem) = Telemetry.customRange(from: now, to: at(10), now: now) {
            #expect(problem.message == "The start must be before the end, and before now.")
        } else {
            Issue.record("a backwards range was taken")
        }
        if case .failure(let problem) = Telemetry.customRange(from: at(32 * 24 * 60), to: now, now: now) {
            #expect(problem.message == "A range of events may be at most 31 days long.")
        } else {
            Issue.record("a long range was taken")
        }
        // A range that ends in the future ends now.
        if case .success(.fixed(_, let to)) = Telemetry.customRange(from: at(60), to: now.addingTimeInterval(600), now: now) {
            #expect(to == now)
        } else {
            Issue.record("a range was refused")
        }
    }

    @Test func theBootDiaryDecoded() {
        let diary = Device.Diary(boots: 42, entries: [
            Device.Boot(version: "1.11.3+0", cause: "10", causes: ["watchdog"], stage: 4),
            Device.Boot(version: "1.11.2+0", cause: "0", causes: ["power_on"], stage: 2),
            Device.Boot(version: "1.11.2+0", cause: "c", causes: ["brownout", "power_on", "brownout"], stage: 9),
        ])
        let rows = Telemetry.diaryRows(diary)
        #expect(rows.map(\.boot) == [42, 41, 40])
        #expect(rows[0].running)
        #expect(rows[0].before == "the watchdog")
        #expect(rows[0].bad)
        #expect(rows[0].reached == "Reached the cloud")
        #expect(rows[1].before == "a loss of power")
        #expect(!rows[1].bad)
        #expect(rows[2].before == "a brownout and a loss of power")
        #expect(rows[2].reached == "Stage 9")
    }

    @Test func stuckHeapAndFirmware() {
        #expect(Telemetry.stuckWords(Device.Stuck(count: 0, reason: "none"))?.tone == .good)
        #expect(Telemetry.stuckWords(Device.Stuck(count: 1, reason: "no_cloud"))?.text
            == "Restarted itself once for being stuck, because no connection to the cloud for 15 minutes")
        #expect(Telemetry.stuckWords(Device.Stuck(count: 3, reason: "new_timer"))?.badge == "3 in a row")
        let heap = Telemetry.heapWords(Device.Heap(free: 21_312, least: 4_000, size: 44_240))
        #expect(heap?.tone == .live)
        #expect(heap?.ranLow == true)
        #expect(heap?.text == "21 KiB free of 43 KiB")
        #expect(heap?.used == 52)
        #expect(Telemetry.heapWords(Device.Heap(free: 4_000, least: 4_000, size: 44_240))?.tone == .bad)
        #expect(Telemetry.diagMissing(Device(thing: "t", fw: .init(version: "1.9.0+0", confirmed: true)))
            == "Needs firmware 1.10.0 or later. This board runs 1.9.0+0.")
        #expect(Telemetry.diagMissing(Device(thing: "t")) == "Needs firmware 1.10.0 or later. This board has not said what it runs.")
        #expect(Telemetry.diaryMissing(Device(thing: "t", fw: .init(version: "1.7.3+0", confirmed: true)))
            == "Needs firmware 1.7.4 or later. This board runs 1.7.3+0.")
    }

    @Test func theHeartbeatTicks() {
        let board = Device(thing: "t", online: true, lastSeen: "2026-11-03T11:59:00.000Z", uptime: 100)
        #expect(Telemetry.heartbeatAge(board.lastSeen, now: now) == "60 s ago")
        #expect(Telemetry.heartbeatAge("2026-11-03T11:50:00.000Z", now: now) == "10 min ago")
        #expect(Telemetry.uptimeNow(board, now: now) == 160)
        #expect(Telemetry.uptimeNow(Device(thing: "t", online: false, lastSeen: "2026-11-03T11:00:00.000Z", uptime: 100), now: now) == 100)
    }

    @Test func linesBreakWhereTheBoardWasQuiet() {
        let samples = [
            Samples.Sample(at: ConsoleTime.text(at(30)), rssi: -60),
            Samples.Sample(at: ConsoleTime.text(at(29.5)), rssi: -61),
            Samples.Sample(at: ConsoleTime.text(at(10)), rssi: -62),
            Samples.Sample(at: ConsoleTime.text(at(9)), rssi: nil),
        ]
        let points = Telemetry.points(samples, \.rssi)
        #expect(points.count == 3)
        let runs = Telemetry.runs(points, gap: Telemetry.gap(bucketSeconds: 0))
        #expect(runs.map(\.count) == [2, 1])
        #expect(Telemetry.gap(bucketSeconds: 600) == 1500)
    }
}

/// What the app reads from a chosen file before it is uploaded.
@Suite struct UploadCheckTests {
    let image = makeImage(version: FirmwareVersion(major: 1, minor: 12, revision: 0, build: 3))

    func list(_ releases: [FirmwareRelease], slot: Int? = 794_624) -> FirmwareList {
        FirmwareList(releases: releases, slotSize: slot)
    }

    @Test func theHeaderIsReadLocally() {
        let header = ImagePreview(image)
        #expect(header.ok)
        #expect(header.version == "1.12.0+3")
        #expect(header.headerSize == 32)
        #expect(header.payloadSize == 200)
        #expect(ImagePreview(Data([1, 2, 3])).message == "The file is too small to be a firmware image.")
        #expect(ImagePreview(makeImage(version: FirmwareVersion(major: 1, minor: 0, revision: 0, build: 0), magic: 0x1234)).message
            == "This is not an MCUboot image. Choose the *.signed.bin file from the build.")
    }

    @Test func aFileIsReviewedAgainstTheReleases() {
        let header = ImagePreview(image)
        let digest = ImageCheck.sha256Hex(image)
        let first = UploadCheck.review(header, size: image.count, digest: digest, firmware: list([]))
        #expect(first.notes.map(\.text) == ["Fits the board’s 776 KiB slot.", "This will be the first release."])
        #expect(!first.blocked && !first.doomed)
        let older = UploadCheck.review(header, size: image.count, digest: digest,
                                       firmware: list([FirmwareRelease(version: "1.13.0+0", size: 1, sha256: "x", status: "revoked")]))
        #expect(older.doomed)
        #expect(older.notes.last?.text == "Not newer than 1.13.0+0, the highest version registered so far. The server will refuse it.")
        let same = UploadCheck.review(header, size: image.count, digest: digest,
                                      firmware: list([FirmwareRelease(version: "1.12.0+3", size: image.count, sha256: digest)]))
        #expect(same.notes.last?.text == "This exact file is already registered as 1.12.0+3.")
        let newer = UploadCheck.review(header, size: image.count, digest: digest,
                                       firmware: list([FirmwareRelease(version: "1.11.3+0", size: 1, sha256: "y")]))
        #expect(newer.notes.last?.text == "Newer than every registered release (highest so far: 1.11.3+0).")
        let tooBig = UploadCheck.review(header, size: image.count, digest: digest, firmware: list([], slot: 100))
        #expect(tooBig.blocked)
        #expect(tooBig.notes.first?.text == "Too large: the board’s slot holds 100 bytes.")
        let zero = UploadCheck.review(ImagePreview(makeImage(version: FirmwareVersion(major: 0, minor: 0, revision: 0, build: 0))),
                                      size: 10, digest: "z", firmware: nil)
        #expect(zero.doomed)
        let notAnImage = UploadCheck.review(ImagePreview(Data()), size: 0, digest: "", firmware: nil)
        #expect(notAnImage.blocked)
    }

    @Test func namesAndTextAsTheAPITakesThem() {
        #expect(UploadCheck.recordedFilename("latest.signed.bin") == "latest.signed.bin")
        #expect(UploadCheck.recordedFilename("my build (1).bin") == "my_build__1_.bin")
        #expect(UploadCheck.recordedFilename("") == "image.signed.bin")
        #expect(UploadCheck.recordedFilename(String(repeating: "a", count: 70) + ".bin").count == 64)
        #expect(UploadCheck.singleLine("  one\ntwo\u{200B}\tthree  ") == "one two three")
        #expect(UploadCheck.canRetry(APIError(status: 429, code: "throttled", message: "")))
        #expect(!UploadCheck.canRetry(APIError(status: 422, code: "wrong_key", message: "")))
        #expect(UploadCheck.canRetry(URLError(.timedOut)))
        #expect(TokenRules.days("30") == 30)
        #expect(TokenRules.days("0") == nil)
        #expect(TokenRules.days("91") == nil)
        #expect(TokenRules.days("3.5") == nil)
    }
}
