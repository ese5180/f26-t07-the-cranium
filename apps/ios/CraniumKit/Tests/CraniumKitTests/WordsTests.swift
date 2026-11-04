import Foundation
import Testing
@testable import CraniumKit

/// The console's words (cloud/web/src/site/assets/core.js), said the same way in the app.
@Suite struct WordsTests {
    let now = ConsoleTime.date("2026-11-03T12:00:00.000Z")!
    let deployment = "cranium-1-8-0-b0-20261103T110000Z-1a2b"

    func execution(_ phase: String, status: String = "IN_PROGRESS", online: Bool = true, progress: Int? = nil,
                   reason: String? = nil, ranAtEnd: String? = nil, reported: String? = nil, startedAt: String? = nil) -> Execution {
        Execution(thing: "cranium-0123456789abcdef", status: status, phase: phase, progress: progress, reason: reason,
                  ranAtEnd: ranAtEnd, reported: reported, online: online, startedAt: startedAt)
    }

    @Test func numbersAndTimes() {
        #expect(Words.timeAgo("2026-11-03T11:59:58.000Z", now: now) == "just now")
        #expect(Words.timeAgo("2026-11-03T11:59:30.000Z", now: now) == "30 s ago")
        #expect(Words.timeAgo("2026-11-03T11:57:00Z", now: now) == "3 min ago")
        #expect(Words.timeAgo("2026-11-03T09:00:00.000Z", now: now) == "3 h ago")
        #expect(Words.timeAgo("2026-10-30T12:00:00.000Z", now: now) == "4 d ago")
        #expect(Words.timeAgo(nil, now: now) == "")
        #expect(Words.duration(42) == "42 s")
        #expect(Words.duration(300) == "5 min")
        #expect(Words.duration(2 * 3600 + 14 * 60) == "2 h 14 min")
        #expect(Words.duration(7200) == "2 h")
        #expect(Words.duration(3 * 86_400 + 4 * 3600) == "3 d 4 h")
        #expect(Words.fileSize(512) == "512 bytes")
        #expect(Words.fileSize(794_624) == "776 KiB")
        #expect(Words.fileSize(2 * 1024 * 1024) == "2.00 MiB")
        #expect(Words.exactBytes(1_264_000) == "1,264,000 bytes")
        #expect(Words.sizeWords(512) == "512 bytes")
        #expect(Words.sizeWords(2048) == "2,048 bytes (2 KiB)")
        #expect(Words.signalQuality(-50)?.label == "Excellent")
        #expect(Words.signalQuality(-67)?.bars == 3)
        #expect(Words.signalQuality(-75)?.label == "Fair")
        #expect(Words.signalQuality(-90)?.label == "Weak")
        #expect(Words.signed(-67) == "\u{2212}67")
        #expect(Words.plural(1, "board") == "1 board")
        #expect(Words.plural(2, "entry", "entries") == "2 entries")
        #expect(Words.sentence("Done") == "Done.")
        #expect(Words.sentence("Done?") == "Done?")
    }

    @Test func peopleAreTheirAddressOrTheirAccount() {
        #expect(Words.nameOf(Person(sub: "abcdef0123456789", email: "a@b.test")) == "a@b.test")
        #expect(Words.nameOf(Person(sub: "abcdef0123456789", email: "")) == "account abcdef01…")
        #expect(Words.nameOf(nil) == "an unknown account")
    }

    @Test func waitingForTheBoard() {
        let board = Device(thing: "cranium-0123456789abcdef")
        let never = Words.describeExecution(execution("waiting_for_device", status: "QUEUED", online: false), board: board)
        #expect(never.title == "Never connected")
        #expect(never.tone == .wait)
        let offline = Words.describeExecution(execution("waiting_for_device", status: "QUEUED", online: false))
        #expect(offline.title == "Board offline")
        #expect(offline.text == "The board is offline; it will see this update when it reconnects.")
        let online = Words.describeExecution(execution("waiting_for_device", status: "QUEUED"))
        #expect(online.title == "Not picked up yet")
        #expect(online.steps[0].state == .current)
    }

    @Test func theButtonIsAPersonsTurn() {
        let words = Words.describeExecution(execution("waiting_for_button", status: "QUEUED"))
        #expect(words.tone == .act)
        #expect(words.title == "Press Button\u{00A0}1 on the board")
        #expect(words.steps[1].label == "Waiting for Button\u{00A0}1")
        #expect(words.steps[0].state == .done)
    }

    @Test func downloadingAndGoneQuiet() {
        let live = Words.describeExecution(execution("downloading", progress: 42), version: "1.8.0+0")
        #expect(live.title == "Downloading 42%")
        #expect(live.said == "Downloading")
        #expect(live.progress == 42)
        #expect(live.brief == "The board is downloading the image into its spare flash slot.")
        #expect(live.steps.map(\.state) == [.done, .done, .current, .upcoming, .upcoming, .upcoming, .upcoming])
        let quiet = Words.describeExecution(execution("downloading", online: false, progress: 42), version: "1.8.0+0")
        #expect(quiet.title == "Was downloading 1.8.0+0 when last seen")
        #expect(quiet.text == "The board went offline with the download at 42%. The update stays open until the board reports back or the time limit ends.")
        #expect(quiet.tone == .idle)
        #expect(quiet.steps[2].word == "last seen here")
        #expect(quiet.steps[3].state == .unknown)
    }

    @Test func theStepsOfAnUpdateUnderWay() {
        #expect(Words.describeExecution(execution("verifying")).title == "Checking the download")
        #expect(Words.describeExecution(execution("rebooting")).steps[4].state == .current)
        let trial = Words.describeExecution(execution("testing"))
        #expect(trial.title == "On trial")
        #expect(trial.text.hasSuffix("if it cannot, the bootloader puts the previous firmware back."))
    }

    @Test func installedAndConfirmed() {
        let board = Device(thing: "cranium-0123456789abcdef", online: true, fw: .init(version: "1.8.0+0", confirmed: true))
        let words = Words.describeExecution(execution("succeeded", status: "SUCCEEDED", ranAtEnd: "1.8.0+0"), board: board)
        #expect(words.title == "Installed and confirmed")
        #expect(words.text == "The board runs 1.8.0+0 and has confirmed it.")
        #expect(words.steps.allSatisfy { $0.state == .done })
        let moved = Device(thing: "cranium-0123456789abcdef", online: true, fw: .init(version: "1.9.0+0", confirmed: true))
        #expect(Words.describeExecution(execution("succeeded", status: "SUCCEEDED", ranAtEnd: "1.8.0+0"), board: moved).text
            == "The board confirmed 1.8.0+0 when this update ended. It has since moved to 1.9.0+0.")
    }

    @Test func failuresInTheConsolesWords() {
        let back = Words.describeExecution(execution("rolled_back", status: "FAILED", ranAtEnd: "1.7.0+0"), version: "1.8.0+0")
        #expect(back.title == "Rolled back")
        #expect(back.text.contains("That left the board on 1.7.0+0."))
        #expect(back.steps[5] == Step(label: "Rolled back", state: .failed, word: nil))
        #expect(back.next == "Fix the build, then upload a newer version and deploy that.")
        let damaged = Words.describeExecution(execution("failed", status: "FAILED", reason: "digest_mismatch", ranAtEnd: "1.7.0+0"))
        #expect(damaged.title == "The download was damaged")
        #expect(damaged.text.hasSuffix(" It kept running the firmware it had, 1.7.0+0."))
        #expect(damaged.steps[3].label == "Check failed")
        #expect(damaged.retry)
        let odd = Words.describeExecution(execution("failed", status: "FAILED", reason: "SOMETHING_ELSE"))
        #expect(odd.title == "Failed")
        #expect(odd.code == "SOMETHING_ELSE")
    }

    @Test func refusalsAndDeclines() {
        let declined = Words.describeExecution(execution("declined", status: "REJECTED", ranAtEnd: "1.7.0+0"))
        #expect(declined.title == "Declined on the board")
        #expect(declined.text == "Someone pressed Button 2 on the board to decline this update. Nothing was installed. The board was running 1.7.0+0 at the time.")
        let notNewer = Words.describeExecution(execution("refused", status: "REJECTED", reason: "not_newer"))
        #expect(notNewer.text == "Refused: the board already ran this version or a newer one.")
        #expect(notNewer.next == "To put something else on it, upload a newer version and deploy that.")
        #expect(notNewer.steps[1].label == "Refused")
        #expect(!notNewer.retry)
        #expect(Words.describeExecution(execution("refused", status: "REJECTED")).title == "Refused or declined")
    }

    @Test func aBoardThatRunsTheReleaseIsNotOfferedItAgain() {
        let runs = Device(thing: "cranium-0123456789abcdef", online: true, fw: .init(version: "1.8.0+0", confirmed: true))
        let words = Words.describeExecution(execution("timed_out", status: "TIMED_OUT"), board: runs, version: "1.8.0+0")
        #expect(words.title == "Timed out")
        #expect(!words.retry)
        #expect(words.next == nil)
        #expect(Words.describeExecution(execution("timed_out", status: "TIMED_OUT"), version: "1.8.0+0").retry)
        #expect(!Words.describeExecution(execution("timed_out", status: "TIMED_OUT"), version: "1.8.0+0", unread: true).retry)
    }

    @Test func cancelledBeforeAndAfterTheBoardStarted() {
        let before = Words.describeExecution(execution("cancelled", status: "CANCELED", online: false), version: "1.8.0+0")
        #expect(before.text == "Cancelled before the board started. Nothing was installed.")
        let after = Words.describeExecution(execution("cancelled", status: "CANCELED", reported: "1.7.0+0",
                                                      startedAt: "2026-11-03T11:00:00.000Z"),
                                            board: Device(thing: "cranium-0123456789abcdef", online: true), deployment: deployment,
                                            version: "1.8.0+0")
        #expect(after.text == "Cancelled after the board had started. A board asks AWS before it installs, so it stops there and keeps the firmware it had. The board reports that it runs 1.7.0+0.")
        let board = Device(thing: "cranium-0123456789abcdef", online: true, fw: .init(version: "1.8.0+0", confirmed: true),
                           ota: .init(state: "idle", last: "succeeded"))
        let through = Words.describeExecution(execution("cancelled", status: "CANCELED", reported: "1.8.0+0",
                                                        startedAt: "2026-11-03T11:00:00.000Z"),
                                              board: board, deployment: deployment, version: "1.8.0+0", history: [])
        #expect(through.title == "Installed despite the cancellation")
        #expect(through.installed)
        let other = ExecutionSummary(deployment: "cranium-1-8-0-b0-20261103T113000Z-ffff", version: "1.8.0+0", status: "SUCCEEDED")
        let elsewhere = Words.describeExecution(execution("cancelled", status: "CANCELED", reported: "1.8.0+0",
                                                          startedAt: "2026-11-03T11:00:00.000Z"),
                                                board: board, deployment: deployment, version: "1.8.0+0", history: [other])
        #expect(elsewhere.installedBy == "cranium-1-8-0-b0-20261103T113000Z-ffff")
    }

    @Test func whatABoardSaysAboutUpdates() {
        #expect(Words.describeUpdate(Device(thing: "t")).title == "Nothing reported")
        let idle = Device(thing: "t", online: true, ota: .init(state: "idle", last: "failed", error: "digest_mismatch"))
        #expect(Words.describeUpdate(idle).title == "Last update failed")
        #expect(Words.describeUpdate(idle).text == "The download was damaged")
        let refused = Device(thing: "t", online: true, ota: .init(state: "idle", last: "refused", error: "not_newer"))
        #expect(Words.describeUpdate(refused).text == "Because the board already ran this version or a newer one.")
        let quiet = Device(thing: "t", online: false, lastSeen: "2026-11-03T11:00:00.000Z", ota: .init(state: "idle"))
        #expect(Words.describeUpdate(quiet).title == "No update in progress when last seen")
        let downloading = Device(thing: "t", online: true, ota: .init(state: "downloading", job: deployment, progress: 12))
        #expect(Words.describeUpdate(downloading).title == "Downloading 1.8.0+0")
        #expect(Words.describeUpdate(downloading).progress == 12)
        let gone = Device(thing: "t", online: false, ota: .init(state: "testing", job: deployment))
        #expect(Words.describeUpdate(gone).title == "Was on trial with 1.8.0+0 when last seen")
        let button = Device(thing: "t", online: true, ota: .init(state: "awaiting_user", job: deployment))
        #expect(Words.describeUpdate(button).text == "1.8.0+0 is on offer. Button 1 on the board installs it, Button 2 declines.")
        let phone = Device(thing: "t", online: true, ota: .init(state: "bluetooth"))
        #expect(Words.describeUpdate(phone).title == "Open for an update over Bluetooth")
        #expect(Words.describeHistory("FAILED", last: "rolled_back").label == "Rolled back")
        #expect(Words.describeHistory("REJECTED").label == "Refused or declined")
    }

    @Test func aDeploymentAsAWhole() {
        let things = ["cranium-0123456789abcdef", "cranium-fedcba9876543210"]
        func made(_ status: String, _ counts: Counts) -> Deployment {
            Deployment(id: deployment, version: "1.8.0+0", status: status, things: things, counts: counts)
        }
        #expect(Words.describeDeployment(made("IN_PROGRESS", Counts(queued: 2))).label == "Waiting for boards")
        #expect(Words.describeDeployment(made("IN_PROGRESS", Counts(queued: 1, inProgress: 1))).label == "Updating")
        let done = Words.describeDeployment(made("COMPLETED", Counts(succeeded: 2)))
        #expect(done.label == "Succeeded")
        #expect(done.said == "1.8.0+0 was installed and confirmed on 2 boards.")
        let current = things.map { Device(thing: $0, online: true, fw: .init(version: "1.8.0+0", confirmed: true)) }
        #expect(Words.describeDeployment(made("COMPLETED", Counts(succeeded: 2)), devices: current).said
            == "1.8.0+0 is installed and confirmed on 2 boards.")
        #expect(Words.describeDeployment(made("COMPLETED", Counts(succeeded: 1, failed: 1))).label == "Partly succeeded")
        #expect(Words.describeDeployment(made("COMPLETED", Counts(failed: 2))).label == "Failed")
        #expect(Words.describeDeployment(made("CANCELED", Counts(inProgress: 1, canceled: 1))).label == "Cancelled, 1 board still working")
        #expect(Words.describeDeployment(made("CANCELED", Counts(canceled: 2))).label == "Cancelled")
    }

    @Test func countsInAFixedOrderWithTheButtonFirst() {
        let lines = Words.describeCounts(Counts(queued: 3, inProgress: 1, succeeded: 2), atButton: 1)
        #expect(lines.map(\.name) == ["atButton", "succeeded", "inProgress", "queued"])
        #expect(lines[0].label == "waiting for Button\u{00A0}1")
        #expect(lines[3].count == 2)
        #expect(Words.countSentence(Counts(failed: 1, timedOut: 2)) == "1 failed, 2 timed out")
    }

    @Test func polling() {
        #expect(Words.pollInterval(["SUCCEEDED", "IN_PROGRESS"]) == 3)
        #expect(Words.pollInterval(["QUEUED"]) == 10)
        #expect(Words.pollInterval(["SUCCEEDED"]) == 0)
        let waiting = Execution(thing: "t", status: "QUEUED", phase: "waiting_for_device", online: true)
        #expect(Words.executionActivity(waiting) == "IN_PROGRESS")
    }

    @Test func boardsAndReleases() {
        let old = Device(thing: "t", fw: .init(version: "1.7.1+0", confirmed: true))
        #expect(Words.asksForButton(old))
        #expect(!Words.asksForButton(Device(thing: "t", fw: .init(version: "1.7.2+0", confirmed: true))))
        #expect(Words.alreadyRuns(old, version: "1.7.1+0"))
        #expect(!Words.alreadyRuns(old, version: "1.8.0+0"))
        let releases = [FirmwareRelease(version: "1.8.0+0", size: 1, sha256: "")]
        #expect(Words.isUnregistered("1.7.1+0", releases: releases))
        #expect(!Words.isUnregistered("1.7.1+0", releases: []))
        let online = Device(thing: "a", online: true, lastSeen: "2026-11-03T11:59:50.000Z")
        #expect(Words.heartbeatWords(online, now: now) == "Online, heartbeat 10 s ago")
        #expect(Words.seenLine(Device(thing: "b"), now: now) == Words.neverReported)
        #expect(Words.boardsCounted([online, Device(thing: "b"), Device(thing: "c", lastSeen: "2026-11-01T00:00:00.000Z")])
            == (1, 1, 1))
        let groups = Words.versionGroups([Device(thing: "a", fw: .init(version: "1.7.0+0", confirmed: true)), Device(thing: "b"),
                                          Device(thing: "c", fw: .init(version: "1.10.0+0", confirmed: false))])
        #expect(groups.map(\.version) == ["1.10.0+0", "1.7.0+0", ""])
    }

    @Test func cancellingAndRevokingSaid() {
        #expect(Words.cancelNotice(force: false, withdrawn: false, started: 2) == "Cancelled. 2 boards that had started carry on.")
        #expect(Words.cancelNotice(force: true, withdrawn: false, started: 0)
            == "Cancelled. Boards that had not started are no longer offered this update.")
        #expect(Words.revocationNotice("1.8.0+0", cancelled: [], again: false) == "Revoked 1.8.0+0. No deployment of it was still open.")
        #expect(Words.revocationNotice("1.8.0+0", cancelled: ["a", "b"], again: false) == "Revoked 1.8.0+0. 2 unfinished deployments were cancelled.")
        #expect(Words.revocationNotice("1.8.0+0", cancelled: nil, again: false) == "1.8.0+0 was revoked already, and that revocation is in place.")
        let board = Device(thing: "cranium-0123456789abcdef", online: true)
        #expect(Words.stillRunning([board]) == "cranium-0123456789abcdef still runs it; to replace it there, upload a newer version and deploy that.")
        let open = FirmwareRelease(version: "1.8.0+0", size: 1, sha256: "", status: "revoked",
                                   revoked: Revocation(by: nil, at: nil, reason: "x", enforcedAt: nil))
        #expect(Words.revocationState(open) == .incomplete)
        let unknown = FirmwareRelease(version: "1.8.0+0", size: 1, sha256: "", status: "revoked",
                                      revoked: Revocation(by: nil, at: nil, reason: "x", enforcedAt: nil, recordsEnforcement: false))
        #expect(Words.revocationState(unknown) == .unknown)
        #expect(Words.revocationState(FirmwareRelease(version: "1.8.0+0", size: 1, sha256: "")) == nil)
    }

    @Test func refusalsInPlainWords() {
        let jargon = APIError(status: 422, code: "unexpected_tlv", message: "Unexpected TLV 0x10")
        #expect(Words.plainMessage(jargon).hasPrefix("This image is not signed the way this project requires"))
        #expect(Words.failure("Not cancelled.", APIError(status: 409, code: "already_finished", message: "It has finished"))
            == "Not cancelled. It has finished.")
        #expect(Words.failure("Not cancelled.", APIError(status: 500, code: "internal_error", message: "Oops."))
            == "It is not certain whether this went through. Oops.")
        #expect(UploadCheck.failedCheck("wrong_key") == "Signing key")
        #expect(UploadCheck.failedCheck("version_not_newer") == "Version")
    }

    @Test func theActivityLogInWords() {
        let upload = AuditEntry(at: "2026-11-03T12:00:00.000Z", actor: Person(sub: "s", email: "a@b.test"), action: "firmware.upload",
                                target: "1.8.0+0", outcome: "ok",
                                detail: [.init("filename", "latest.signed.bin"), .init("size", "1264"), .init("version", "1.8.0+0")],
                                requestId: "r1")
        let words = Words.describeAudit(upload)
        #expect(words.verb == "uploaded firmware")
        #expect(words.label == "1.8.0+0")
        #expect(words.link == .firmware)
        #expect(words.facts.map(\.key) == ["filename", "size"], "the version is said by the sentence")
        #expect(words.facts[1].value == "1,264 bytes")
        #expect(words.outcome == nil)

        let refused = AuditEntry(at: nil, actor: nil, action: "deployment.create", target: deployment, outcome: "rejected",
                                 detail: [.init("code", "device_busy"), .init("from", "phone")], requestId: "bench-1")
        let said = Words.describeAudit(refused)
        #expect(said.verb == "tried to deploy")
        #expect(said.label == "1.8.0+0")
        #expect(said.outcome?.label == "Refused")
        #expect(said.facts.first?.words == "A board had an unfinished update")
        #expect(said.facts.last?.value == deployment)
        #expect(said.link == .deployment(deployment))
        #expect(said.scripted)

        let alone = AuditEntry(at: nil, actor: nil, action: "deployment.cancel", outcome: "denied")
        #expect(Words.describeAudit(alone).verb == "tried to cancel a deployment")
        let resumed = AuditEntry(at: nil, actor: nil, action: "firmware.revoke", target: "1.8.0+0", detail: [.init("resumed", "true")])
        #expect(Words.describeAudit(resumed).verb == "finished revoking firmware")
        // The plain sentence, as the website's, says nothing of how it ended; what VoiceOver hears does.
        #expect(Words.auditSentence(refused) == "an unknown account tried to deploy 1.8.0+0")
        #expect(Words.auditSpoken(refused) == "an unknown account tried to deploy 1.8.0+0 (refused)")
    }
}
