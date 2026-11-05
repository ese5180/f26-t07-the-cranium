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
}
