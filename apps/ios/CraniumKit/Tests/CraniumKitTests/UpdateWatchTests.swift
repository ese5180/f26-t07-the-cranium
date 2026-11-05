import Foundation
import Testing
@testable import CraniumKit

/// The steps after a Bluetooth send. The Android app's UpdateWatchTest has the same cases and the
/// same words.
@Suite struct UpdateWatchTests {
    static let thing = "cranium-0123456789abcdef"
    let sent = ConsoleTime.date("2026-11-05T12:13:00.000Z")!

    func t(_ seconds: Double) -> Date { sent.addingTimeInterval(seconds) }
    func iso(_ seconds: Double) -> String { ConsoleTime.text(t(seconds)) }

    func line(_ seconds: Double, _ text: String, tag: String = "BT", seq: Int = 1) -> BoardLine {
        BoardLine(thing: Self.thing, at: iso(seconds), id: "7.\(seq)", kind: "bluetooth", tag: tag, text: text, boot: 7, seq: seq)
    }

    func connection(_ seconds: Double, _ what: String) -> BoardEvent {
        BoardEvent(thing: Self.thing, at: iso(seconds), kind: "connection", what: what)
    }

    /// A board that reported at `seen` s after the send, up for `uptime` s, running `version`.
    func device(seen: Double, uptime: Int, version: String, confirmed: Bool, online: Bool = true,
                bt: Device.BluetoothRecord? = nil) -> Device {
        Device(thing: Self.thing, online: online, lastSeen: iso(seen), fw: Device.Firmware(version: version, confirmed: confirmed),
               uptime: uptime, bt: bt)
    }

    func facts(thing: String? = thing, onConsole: Bool? = true, dropped: Double? = nil) -> UpdateWatch.Facts {
        UpdateWatch.Facts(version: "1.13.0+0", from: "1.12.0+0", sentAt: sent, thing: thing, onConsole: onConsole,
                          linkDroppedAt: dropped.map(t))
    }

    func states(_ timeline: UpdateWatch.Timeline) -> [UpdateWatch.State] { timeline.rows.map(\.state) }

    @Test func waitingForAButtonCountsDown() {
        let timeline = UpdateWatch.timeline(facts())
        #expect(timeline.rows.map(\.title) == ["Sent 1.13.0+0", "Button 1 pressed, accepted", "Installing and restarting",
                                               "Running 1.13.0+0 on trial", "Kept 1.13.0+0"])
        #expect(timeline.rows[0].detail == "Press Button 1 on the board within 2 minutes to install it (Button 2 throws it away).")
        #expect(timeline.rows[0].at == sent)
        #expect(states(timeline) == [.done, .current, .waiting, .waiting, .waiting])
        #expect(timeline.waitingForButton)
        #expect(timeline.deadline == t(120))
        #expect(!timeline.finished && timeline.outcome == nil && timeline.note == nil)
        #expect(UpdateWatch.countdown(102) == "1:42 left")
        #expect(UpdateWatch.countdown(120) == "2:00 left")
        #expect(UpdateWatch.countdown(9) == "0:09 left")
        #expect(UpdateWatch.countdown(0) == "The 2 minutes are up.")
    }

    @Test func kept() {
        // The real one: offline at the press, back 15 s later on the new version, kept when it reached AWS IoT.
        var f = facts(dropped: 47)
        f.events = [connection(45, "disconnected"), connection(60, "connected")]
        let watching = UpdateWatch.timeline(f)
        #expect(states(watching) == [.done, .done, .done, .waiting, .waiting])
        #expect(watching.rows[1].at == t(45))
        #expect(watching.rows[1].detail == nil)
        #expect(watching.rows[2].at == t(45))
        #expect(!watching.finished && !watching.waitingForButton)

        f.lines = [line(52, "on trial: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board", seq: 1)]
        let trial = UpdateWatch.timeline(f)
        #expect(states(trial) == [.done, .done, .done, .current, .waiting])
        #expect(trial.rows[3].detail == "Back online with the new version, not yet kept.")
        #expect(trial.rows[3].at == t(52))

        f.lines.append(line(61, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 3 of this board", seq: 9))
        let kept = UpdateWatch.timeline(f)
        #expect(states(kept) == [.done, .done, .done, .done, .done])
        #expect(kept.rows[4].title == "Kept 1.13.0+0")
        #expect(kept.rows[4].detail == "It reached AWS IoT, so the board keeps it.")
        #expect(kept.rows[4].at == t(61))
        #expect(kept.outcome == .kept && !kept.tentative && kept.finished && kept.note == nil)
        #expect(kept.acceptedAt == t(45))
        #expect(UpdateWatch.record(f, kept) == UpdateWatch.Record(thing: Self.thing, version: "1.13.0+0", at: t(45), outcome: .kept))
    }

    @Test func keptFromTheBoardsReportAlone() {
        // No lines (firmware before 1.12.0, or lost from a full queue): the board's report says it.
        var f = facts(dropped: 47)
        f.device = device(seen: 70, uptime: 12, version: "1.13.0+0", confirmed: false)
        let trial = UpdateWatch.timeline(f)
        #expect(states(trial) == [.done, .done, .done, .current, .waiting])
        #expect(trial.rows[3].at == t(58))
        f.device = device(seen: 75, uptime: 17, version: "1.13.0+0", confirmed: true,
                          bt: Device.BluetoothRecord(from: "1.12.0+0", to: "1.13.0+0", result: "succeeded", proof: "cloud", count: 3))
        let kept = UpdateWatch.timeline(f)
        #expect(kept.outcome == .kept && kept.finished)
        #expect(kept.rows[4].detail == "It reached AWS IoT, so the board keeps it.")
        // A report from before the send says nothing about it.
        f.device = device(seen: -20, uptime: 4000, version: "1.12.0+0", confirmed: true)
        #expect(UpdateWatch.timeline(f).outcome == nil)
    }

    @Test func rolledBack() {
        var f = facts(dropped: 40)
        f.events = [connection(38, "disconnected"), connection(400, "connected")]
        f.lines = [line(52, "on trial: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board", seq: 1),
                   line(395, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, rolled_back, proof none, update 3 of this board", seq: 2)]
        let timeline = UpdateWatch.timeline(f)
        #expect(states(timeline) == [.done, .done, .done, .done, .failed])
        #expect(timeline.rows[4].title == "Rolled back to 1.12.0+0")
        #expect(timeline.rows[4].detail == "The new image was not kept: the bootloader put the old one back.")
        #expect(timeline.rows[4].at == t(395))
        #expect(timeline.outcome == .rolledBack && timeline.finished && timeline.rolledBackTo == "1.12.0+0")

        // Not installed at all: it never ran on trial.
        f.lines = [line(60, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, not_installed, proof none, update 3 of this board")]
        let notInstalled = UpdateWatch.timeline(f)
        #expect(states(notInstalled) == [.done, .done, .done, .waiting, .failed])
        #expect(notInstalled.rows[4].detail == "The bootloader did not install the new image.")

        // Only the board's report: back after the send, on the old version.
        f.lines = []
        f.events = [connection(38, "disconnected")]
        f.device = device(seen: 90, uptime: 20, version: "1.12.0+0", confirmed: true)
        let back = UpdateWatch.timeline(f)
        #expect(back.outcome == .rolledBack && back.rows[4].title == "Rolled back to 1.12.0+0")
        #expect(back.rows[4].detail == "Back on the old version.")
        #expect(back.rows[4].at == t(70))
    }

    @Test func button2() {
        var f = facts(dropped: 31)
        let linkOnly = UpdateWatch.timeline(f)
        #expect(states(linkOnly) == [.done, .likely, .waiting, .waiting, .waiting])
        #expect(linkOnly.rows[1].detail == "The board closed the link: it is installing.")
        #expect(linkOnly.rows[1].at == t(31))
        #expect(!linkOnly.finished)

        f.lines = [line(30, "closed: by Button 2")]
        let timeline = UpdateWatch.timeline(f)
        #expect(timeline.rows.map(\.title) == ["Sent 1.13.0+0", "Button 2 pressed: the image was thrown away"])
        #expect(states(timeline) == [.done, .failed])
        #expect(timeline.rows[1].at == t(30))
        #expect(timeline.outcome == .declined && timeline.finished && !timeline.tentative)
        #expect(UpdateWatch.record(f, timeline)?.at == sent)
    }

    @Test func theWindowRanOut() {
        var f = facts(dropped: 121)
        f.lines = [line(120, "closed: no image to install")]
        let timeline = UpdateWatch.timeline(f)
        #expect(timeline.rows.map(\.title) == ["Sent 1.13.0+0", "The 2 minutes ran out: the image was thrown away"])
        #expect(timeline.outcome == .expired && timeline.finished && !timeline.tentative)

        // The link closing at the end of the 2 minutes, before the console has said so: most likely that.
        f.lines = []
        let likely = UpdateWatch.timeline(f)
        #expect(likely.rows.map(\.title) == ["Sent 1.13.0+0", "The 2 minutes ran out"])
        #expect(likely.rows[1].state == .likely)
        #expect(likely.rows[1].detail == "The board closed the link at the end of its 2 minutes: it has most likely thrown the image away.")
        #expect(likely.outcome == .expired && likely.tentative && !likely.finished)
        // And Button 1 after all, if the board then goes offline: the console's word wins.
        f.events = [connection(118, "disconnected")]
        #expect(UpdateWatch.timeline(f).rows[1].title == "Button 1 pressed, accepted")
        #expect(UpdateWatch.timeline(f).outcome == nil)
    }

    @Test func anOfflineBoard() {
        let timeline = UpdateWatch.timeline(facts(onConsole: false, dropped: 40))
        #expect(states(timeline) == [.done, .likely, .waiting, .waiting, .waiting])
        #expect(timeline.rows[1].detail == "The board closed the link: it is installing.")
        #expect(timeline.note == "The board is not on the console, so the app can't follow it from here. After it restarts, check its version over Bluetooth.")
        #expect(timeline.finished && timeline.outcome == nil)
        // While the link is up the link is what is followed: nothing to say yet.
        #expect(UpdateWatch.timeline(facts(onConsole: false)).note == nil)
    }

    @Test func aLinkDropWithNoCloud() {
        let timeline = UpdateWatch.timeline(facts(thing: nil, onConsole: nil, dropped: 40))
        #expect(states(timeline) == [.done, .likely, .waiting, .waiting, .waiting])
        #expect(timeline.note == UpdateWatch.cannotFollow)
        #expect(timeline.finished)
        #expect(UpdateWatch.record(facts(thing: nil), timeline) == nil)
        // At the end of the 2 minutes, with nothing to ask: most likely thrown away, and said so.
        let late = UpdateWatch.timeline(facts(thing: nil, onConsole: nil, dropped: 119))
        #expect(late.outcome == .expired && late.tentative && late.finished && late.note == UpdateWatch.cannotFollow)
    }

    @Test func fiveMinutesWithoutAnEnd() {
        var f = facts(dropped: 40)
        f.events = [connection(39, "disconnected")]
        f.consoleFailed = true
        let failing = UpdateWatch.timeline(f)
        #expect(states(failing) == [.done, .done, .current, .waiting, .waiting])
        #expect(failing.rows[2].detail == "The board is offline on the console while it installs.")
        #expect(failing.note == "The console could not be reached just now. The app keeps asking.")
        #expect(!failing.finished)
        f.gaveUp = true
        let gaveUp = UpdateWatch.timeline(f)
        #expect(gaveUp.note == "5 minutes have passed, so the app has stopped following it. The board's page shows how it ends.")
        #expect(gaveUp.finished)
    }

    @Test func onlyThisSendCounts() {
        var f = facts(dropped: 40)
        f.lines = [
            // An earlier window, and another version.
            line(-200, "closed: by Button 2"),
            line(60, "update over Bluetooth: 1.12.0+0 from 1.11.0+0, succeeded, proof cloud, update 2 of this board"),
            // Not a line of the Bluetooth update, though it says the words.
            line(61, "update over Bluetooth: 1.13.0+0 from 1.12.0+0, succeeded, proof cloud, update 3 of this board", tag: "CMD"),
        ]
        f.events = [connection(-100, "disconnected"), BoardEvent(thing: Self.thing, at: iso(45), kind: "bluetooth", what: "closed")]
        let timeline = UpdateWatch.timeline(f)
        #expect(timeline.outcome == nil)
        #expect(states(timeline) == [.done, .likely, .waiting, .waiting, .waiting])
        // The record of the board's restart into the bootloader, if it ever gets out before the restart, is Button 1.
        f.lines = [line(44, "restarting into the bootloader: 1.13.0+0 from 1.12.0+0, pending, proof none, update 3 of this board")]
        let restarting = UpdateWatch.timeline(f)
        #expect(restarting.rows[1].state == .done && restarting.rows[1].at == t(44))
    }

    @Test func theBoardsPage() {
        let time: (Date) -> String = { _ in "12:14" }
        let kept = UpdateWatch.Record(thing: Self.thing, version: "1.13.0+0", at: t(45), outcome: .kept)
        #expect(UpdateWatch.summary(record: kept, bt: nil, time: time) == "1.13.0+0 over Bluetooth at 12:14, kept")
        let back = UpdateWatch.Record(thing: Self.thing, version: "1.13.0+0", at: t(45), outcome: .rolledBack, rolledBackTo: "1.12.0+0")
        #expect(UpdateWatch.summary(record: back, bt: nil, time: time) == "1.13.0+0 over Bluetooth at 12:14, rolled back to 1.12.0+0")
        let declined = UpdateWatch.Record(thing: Self.thing, version: "1.13.0+0", at: t(0), outcome: .declined)
        #expect(UpdateWatch.summary(record: declined, bt: nil, time: time) == "1.13.0+0 over Bluetooth at 12:14, thrown away with Button 2")
        let expired = UpdateWatch.Record(thing: Self.thing, version: "1.13.0+0", at: t(0), outcome: .expired)
        #expect(UpdateWatch.summary(record: expired, bt: nil, time: time) == "1.13.0+0 over Bluetooth at 12:14, not installed: the 2 minutes ran out")
        // Not followed to the end here: the board's own record finishes the sentence.
        let open = UpdateWatch.Record(thing: Self.thing, version: "1.13.0+0", at: t(45), outcome: nil)
        let record = Device.BluetoothRecord(from: "1.12.0+0", to: "1.13.0+0", result: "succeeded", proof: "cloud", count: 3)
        #expect(UpdateWatch.summary(record: open, bt: nil, time: time) == "1.13.0+0 over Bluetooth at 12:14, not followed to the end")
        #expect(UpdateWatch.summary(record: open, bt: record, time: time) == "1.13.0+0 over Bluetooth at 12:14, kept")
        // Only the board's record: no time, which it does not keep.
        #expect(UpdateWatch.summary(record: nil, bt: record, time: time) == "1.13.0+0 over Bluetooth, kept")
        let lost = Device.BluetoothRecord(from: "1.12.0+0", to: "1.13.0+0", result: "rolled_back")
        #expect(UpdateWatch.summary(record: nil, bt: lost, time: time) == "1.13.0+0 over Bluetooth, rolled back to 1.12.0+0")
        #expect(UpdateWatch.summary(record: nil, bt: nil, time: time) == nil)
    }

    @Test func pollingBacksOffOnA429() {
        #expect([0, 1, 2, 3, 4, 9].map(UpdateWatch.nextPoll(throttled:)) == [3, 6, 12, 24, 30, 30])
    }

    // MARK: The board's own status over Bluetooth (firmware 1.14.0 on)

    static let hash = "deadbeef01020304"

    /// What the board says on the link of the send: an image on offer, by default.
    func onLink(_ seconds: Double, window: BoardStatus.Window = .offer, left: Int = 100, image: BoardStatus.Image = .verified,
                result: BoardStatus.Result = .none, refusal: BoardStatus.Refusal = .none) -> UpdateWatch.Reading {
        let installing = result == .installing
        return UpdateWatch.Reading(BoardStatus(
            window: window, secondsLeft: left, image: image, refusal: refusal, imageBytes: 872_000, imageVersion: "1.13.0+0",
            result: result, closedReason: 0, running: "1.12.0+0", onTrial: false, swap: .none,
            lastVia: .bluetooth, lastOutcome: installing ? .pending : .kept, lastProof: installing ? .none : .cloud,
            lastTarget: installing ? "1.13.0+0" : "1.12.0+0", lastFrom: installing ? "1.12.0+0" : "1.11.4+0",
            lastHash: installing ? Self.hash : "0102030405060708", lastCount: installing ? 3 : 2, uptime: 4000), at: t(seconds))
    }

    /// What the board says after its restart, to a phone that reads it with no pairing.
    func afterRestart(_ seconds: Double, running: String = "1.13.0+0", onTrial: Bool = true,
                      outcome: BoardStatus.Outcome = .pending, proof: BoardStatus.Proof = .none,
                      target: String = "1.13.0+0", hash: String? = hash) -> UpdateWatch.Reading {
        UpdateWatch.Reading(BoardStatus(
            window: .status, secondsLeft: 100, image: .none, refusal: .none, imageBytes: 0, imageVersion: nil,
            result: .none, closedReason: 0, running: running, onTrial: onTrial, swap: onTrial ? .revert : .none,
            lastVia: .bluetooth, lastOutcome: outcome, lastProof: proof, lastTarget: target, lastFrom: "1.12.0+0",
            lastHash: hash, lastCount: 3, uptime: 20), at: t(seconds), afterRestart: true)
    }

    func told(dropped: Double? = nil, thing: String? = thing, onConsole: Bool? = true,
              _ readings: UpdateWatch.Reading...) -> UpdateWatch.Facts {
        var f = facts(thing: thing, onConsole: onConsole, dropped: dropped)
        f.readings = readings
        f.sentHash = Self.hash
        return f
    }

    @Test func theBoardCountsItsTwoMinutesDown() {
        let timeline = UpdateWatch.timeline(told(onLink(5, left: 100)))
        #expect(timeline.deadline == t(105))
        #expect(timeline.waitingForButton)
        #expect(states(timeline) == [.done, .current, .waiting, .waiting, .waiting])
        // A board without the characteristic: the phone's own count, as before.
        #expect(UpdateWatch.timeline(facts()).deadline == t(120))
    }

    @Test func button1FromTheBoard() {
        var f = told(onLink(5), onLink(30, result: .installing))
        let pressed = UpdateWatch.timeline(f)
        #expect(states(pressed) == [.done, .done, .current, .waiting, .waiting])
        #expect(pressed.rows[1].title == "Button 1 pressed, accepted")
        #expect(pressed.rows[1].detail == "The board said so over Bluetooth, and is restarting to install it.")
        #expect(pressed.rows[1].at == t(30))
        #expect(pressed.rows[2].detail == "The board is restarting into the bootloader, which checks the image and swaps it in.")
        #expect(pressed.rows[2].at == t(30))
        #expect(!pressed.waitingForButton && pressed.acceptedAt == t(30) && !pressed.finished)

        // The link goes, and the console has it offline: its word for the time it went.
        f.linkDroppedAt = t(31)
        f.events = [connection(31, "disconnected")]
        let offline = UpdateWatch.timeline(f)
        #expect(offline.rows[1].at == t(30))
        #expect(offline.rows[2].detail == "The board is offline on the console while it installs.")
        #expect(offline.rows[2].at == t(31))
        #expect(UpdateWatch.record(f, offline)?.at == t(30))
    }

    @Test func keptFromTheBoardAfterItsRestart() {
        var f = told(dropped: 31, onLink(5), onLink(30, result: .installing), afterRestart(140))
        let trial = UpdateWatch.timeline(f)
        #expect(states(trial) == [.done, .done, .done, .current, .waiting])
        #expect(trial.rows[3].detail == "The board says so over Bluetooth: not yet kept.")
        #expect(trial.rows[3].at == t(140))
        #expect(!trial.finished && trial.note == nil)
        #expect(UpdateWatch.followUntil(f) == t(740))

        f.readings.append(afterRestart(150, onTrial: false, outcome: .kept, proof: .cloud))
        let kept = UpdateWatch.timeline(f)
        #expect(states(kept) == [.done, .done, .done, .done, .done])
        #expect(kept.rows[4].title == "Kept 1.13.0+0")
        #expect(kept.rows[4].detail == "It reached AWS IoT, so the board keeps it.")
        #expect(kept.rows[4].at == t(150))
        #expect(kept.rows[3].at == t(140))
        #expect(kept.outcome == .kept && kept.finished && !kept.tentative)
    }

    @Test func rolledBackFromTheBoard() {
        // On trial, and 5 minutes later back on the old image, which says so.
        let f = told(dropped: 31, onLink(30, result: .installing), afterRestart(140),
                     afterRestart(500, running: "1.12.0+0", onTrial: false, outcome: .rolledBack))
        let timeline = UpdateWatch.timeline(f)
        #expect(states(timeline) == [.done, .done, .done, .done, .failed])
        #expect(timeline.rows[4].title == "Rolled back to 1.12.0+0")
        #expect(timeline.rows[4].detail == "The new image was not kept: the bootloader put the old one back.")
        #expect(timeline.rows[4].at == t(500))
        #expect(timeline.outcome == .rolledBack && timeline.rolledBackTo == "1.12.0+0" && timeline.finished)

        // The bootloader did not take it, a bad signature for one: it never ran on trial.
        let notInstalled = UpdateWatch.timeline(told(dropped: 31, onLink(30, result: .installing),
            afterRestart(130, running: "1.12.0+0", onTrial: false, outcome: .notInstalled)))
        #expect(states(notInstalled) == [.done, .done, .done, .waiting, .failed])
        #expect(notInstalled.rows[4].detail == "The bootloader did not install the new image.")
    }

    @Test func button2AndTheTimeFromTheBoard() {
        let discarded = UpdateWatch.timeline(told(onLink(5), onLink(30, window: .closed, result: .discarded)))
        #expect(discarded.rows.map(\.title) == ["Sent 1.13.0+0", "Button 2 pressed: the image was thrown away"])
        #expect(discarded.rows[1].detail == "The board said so over Bluetooth.")
        #expect(discarded.rows[1].at == t(30))
        #expect(discarded.outcome == .declined && discarded.finished)

        let expired = UpdateWatch.timeline(told(dropped: 121, onLink(5), onLink(120, window: .closed, left: 0, result: .timedOut)))
        #expect(expired.rows.map(\.title) == ["Sent 1.13.0+0", "The 2 minutes ran out: the image was thrown away"])
        #expect(expired.rows[1].state == .failed && expired.rows[1].detail == "The board said so over Bluetooth.")
        #expect(expired.outcome == .expired && !expired.tentative && expired.finished)
    }

    @Test func aRefusalFromTheBoardSaysWhy() {
        let f = told(onLink(3, window: .closed, image: .refused, result: .closed, refusal: .incompatibleLayout))
        let timeline = UpdateWatch.timeline(f)
        #expect(timeline.rows.map(\.title) == ["Sent 1.13.0+0", "The board did not take the image"])
        #expect(timeline.rows[1].detail == "It is for another flash layout.")
        #expect(timeline.outcome == .refused && timeline.finished)
    }

    @Test func onlyThisSendsStatusCountsAfterTheRestart() {
        // Another board's, or another image of the same version: nothing.
        let other = told(dropped: 31, onLink(30, result: .installing), afterRestart(140, hash: "0000000000000001"))
        #expect(states(UpdateWatch.timeline(other)) == [.done, .done, .current, .waiting, .waiting])
        let otherVersion = told(dropped: 31, onLink(30, result: .installing),
                                afterRestart(140, onTrial: false, outcome: .kept, target: "1.12.0+0"))
        #expect(UpdateWatch.timeline(otherVersion).outcome == nil)
        // An image the app could not read the hash of: the version alone.
        var noHash = told(dropped: 31, onLink(30, result: .installing), afterRestart(140, onTrial: false, outcome: .kept))
        noHash.sentHash = nil
        #expect(UpdateWatch.timeline(noHash).outcome == .kept)
    }

    @Test func aBoardWithNoConsoleIsFollowedOverBluetooth() {
        // A board with no Wi-Fi, which the console does not know: before 1.14.0 the app could not follow it.
        var f = told(dropped: 31, thing: nil, onConsole: nil, onLink(30, result: .installing))
        let looking = UpdateWatch.timeline(f)
        #expect(looking.note == "Looking for the board over Bluetooth: for 2 minutes after its restart, a phone can read how it went with no pairing.")
        #expect(!looking.finished)

        f.readings.append(afterRestart(140))
        #expect(UpdateWatch.timeline(f).note == nil)

        // A person proved it at the board.
        f.readings.append(afterRestart(260, onTrial: false, outcome: .kept, proof: .person))
        let kept = UpdateWatch.timeline(f)
        #expect(kept.outcome == .kept && kept.finished)
        #expect(kept.rows[4].detail == "A person at the board proved it.")
        #expect(UpdateWatch.record(f, kept) == nil)

        // Not seen again.
        var lost = told(dropped: 31, thing: nil, onConsole: nil, onLink(30, result: .installing))
        lost.gaveUp = true
        let gaveUp = UpdateWatch.timeline(lost)
        #expect(gaveUp.note == "The board was not seen over Bluetooth again, so the app has stopped looking for it. Its version shows when Button 1 opens its window again.")
        #expect(gaveUp.finished)
    }

    @Test func howLongTheBoardIsFollowed() {
        #expect(UpdateWatch.followUntil(facts()) == nil)
        #expect(UpdateWatch.followUntil(facts(dropped: 31)) == t(331))
        // A status from before the restart, or of another send, does not stretch it.
        #expect(UpdateWatch.followUntil(told(dropped: 31, onLink(30, result: .installing))) == t(331))
        #expect(UpdateWatch.followUntil(told(dropped: 31, afterRestart(140, target: "1.12.0+0"))) == t(331))
        #expect(UpdateWatch.followUntil(told(dropped: 31, afterRestart(140), afterRestart(200))) == t(800))
    }
}
