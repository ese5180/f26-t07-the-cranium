#!/usr/bin/env python3
"""Tests for pi/cranium_link.py against a fake board that follows firmware/app/src/pi/pi_rx.c: it
delivers a DATA frame unless its (session, seq) is the last one it took, and its STATUS frame
acknowledges that last one. The fake can lose its replies, as a late READY or a glitch on MISO would.

    python3 pi/tests/test_cranium_link.py
Standard library only.
"""
import collections
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cranium_link as cl  # noqa: E402


class FakeBoard:
    """The SPI bus with the board on it. Each transfer clocks out the armed STATUS frame and takes
    the Pi's frame, as the board's peripheral does."""

    def __init__(self):
        self.delivered = []
        self.session, self.seq, self.accepted_any = 0, 0, False
        self.lose_replies = 0       # this many of the next transfers answer with 0xff (nothing)
        self.take_data = True       # False: DATA frames are not taken either (the board is away)

    def transfer(self, data):
        reply = cl.encode(cl.Frame(cl.STATUS, self.session if self.accepted_any else 0, 0,
                                   self.seq if self.accepted_any else 0))
        frame, _ = cl.decode(data)
        if frame is not None and frame.type == cl.DATA and self.take_data:
            if not (self.accepted_any and (frame.session, frame.seq) == (self.session, self.seq)):
                self.accepted_any, self.session, self.seq = True, frame.session, frame.seq
                self.delivered.append(frame.payload.decode())
        if self.lose_replies:
            self.lose_replies -= 1
            return b"\xff" * cl.FRAME_SIZE
        return reply


class Lines:
    """A follower with lines handed to it by the test."""

    def __init__(self):
        self.next = []

    def lines(self):
        out, self.next = self.next, []
        return out


def make(board, seq=100):
    link = cl.Link(board, cl.NoReady(), session=7, sleep=lambda s: None)
    link.seq = seq
    return link


def run(link, follower, waiting, rounds=1):
    cl.follow(link, follower, waiting, clock=lambda: 0.0, sleep=lambda s: None, rounds=rounds)


class LinkTest(unittest.TestCase):
    def test_sends_in_order(self):
        board = FakeBoard()
        link, lines, waiting = make(board), Lines(), collections.deque(maxlen=10)
        lines.next = ["a", "b", "c"]
        run(link, lines, waiting)
        self.assertEqual(board.delivered, ["a", "b", "c"])
        self.assertEqual(link.stats["sent"], 3)
        self.assertFalse(waiting)

    def test_lost_acks_do_not_deliver_twice(self):
        # The board takes "b", but every status reply of that round is lost: the sender keeps "b"
        # for the next round, and must send it with the same seq so that the board drops it.
        board = FakeBoard()
        link, lines, waiting = make(board), Lines(), collections.deque(maxlen=10)
        lines.next = ["a"]
        run(link, lines, waiting)
        lines.next = ["b"]
        board.lose_replies = 2 * cl.ATTEMPTS
        run(link, lines, waiting)
        self.assertEqual(list(waiting), ["b"])
        run(link, lines, waiting)
        self.assertEqual(board.delivered, ["a", "b"])
        self.assertFalse(waiting)

    def test_seq_moves_on_only_when_acknowledged(self):
        board = FakeBoard()
        board.take_data = False
        link = make(board, seq=100)
        self.assertFalse(link.send("x"))
        self.assertEqual(link.seq, 100)
        board.take_data = True
        self.assertTrue(link.send("x"))
        self.assertEqual(link.seq, 101)

    def test_dropped_message_uses_up_its_seq(self):
        # "a" reaches the board but its acks are lost. Then "b" arrives with the queue full, so "a" is
        # dropped unacknowledged. "b" must not reuse "a"'s seq, or the board would take it for "a" again
        # and acknowledge it without delivering it.
        board = FakeBoard()
        link, lines, waiting = make(board), Lines(), collections.deque(maxlen=1)
        lines.next = ["a"]
        board.lose_replies = 2 * cl.ATTEMPTS
        run(link, lines, waiting)
        self.assertEqual(list(waiting), ["a"])
        lines.next = ["b"]
        run(link, lines, waiting)
        self.assertEqual(link.stats["dropped"], 1)
        self.assertEqual(board.delivered, ["a", "b"])
        self.assertFalse(waiting)

    def test_board_restart_takes_the_waiting_message(self):
        board = FakeBoard()
        link, lines, waiting = make(board), Lines(), collections.deque(maxlen=10)
        lines.next = ["a"]
        run(link, lines, waiting)
        restarted = FakeBoard()             # a new board knows no session: it takes everything new
        link.bus = restarted
        lines.next = ["b"]
        run(link, lines, waiting)
        self.assertEqual(restarted.delivered, ["b"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
