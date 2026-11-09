#!/usr/bin/env python3
"""The board's end of the SPI protocol to the Raspberry Pi (src/pi_link.c), from 1.15.0, against
tools/pi_link_sim.py, a simulator of the Pi's end (docs/pi-ota.md, "The SPI protocol").

The board's real code runs, built for the host as firmware/tests/host/build/pi_link_harness, with its
SPI bus and READY line on a pipe. The simulator checks every frame, its CRC, the order, the offsets,
the BEGIN and the final hash, and makes things go wrong. No board and no Pi: what this cannot show
is in docs/pi-ota.md, "Untested on hardware".
"""

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import pi_link_sim as sim  # noqa: E402

HOST = REPO / "firmware" / "tests" / "host"
HARNESS = HOST / "build" / "pi_link_harness"


def setUpModule():
    """The harness is built here if it is not yet: make needs ZEPHYR_BASE, as for the host tests."""
    if not HARNESS.exists():
        subprocess.run(["make", "-s", "-C", str(HOST), "build/pi_link_harness"], check=True)


def image(size, seed=7):
    out = bytearray(size)
    x = seed
    for i in range(size):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        out[i] = x >> 16 & 0xFF
    return bytes(out)


class Link(unittest.TestCase):
    def send(self, data, chunk=4096, faults=None, args=()):
        pi = sim.PiSim(faults=faults or sim.Faults())
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "image.bin")
            with open(path, "wb") as f:
                f.write(data)
            process = subprocess.Popen(
                [str(HARNESS), path, str(chunk), *args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                result = sim.run(process, pi)
            finally:
                process.stdin.close()
                reason = process.stderr.read().decode().strip()
                process.stdout.close()
                process.stderr.close()
                self.assertEqual(process.wait(timeout=30), 0, reason)
        result["reason"] = reason
        return pi, result

    def test_an_image_goes_to_partition_b_in_order_and_verified(self):
        for size, chunk in ((1, 4096), (4096, 4096), (4097, 4096), (100_000, 4096), (65_536, 16_384),
                            (70_001, 32_768), (5_000, 1_024)):
            with self.subTest(size=size, chunk=chunk):
                data = image(size)
                pi, result = self.send(data, chunk)
                self.assertEqual(result["reason"], "ok")
                self.assertTrue(pi.verified)
                self.assertEqual(bytes(pi.partition), data)
                self.assertEqual(pi.sha256, hashlib.sha256(data).digest())
                self.assertEqual(pi.version, "2026.11.06-1")
                chunks = -(-size // chunk)
                self.assertEqual(pi.log, [(sim.BEGIN, 0)] + [(sim.DATA, i) for i in range(chunks)]
                                 + [(sim.VERIFY, chunks)])
                self.assertEqual(result["resends"], 0)
                self.assertEqual(pi.crc_errors, 0)

    def test_a_damaged_frame_is_sent_again(self):
        data = image(20_000)
        faults = sim.Faults(damaged_frames={(sim.DATA, 2), (sim.BEGIN, 0), (sim.VERIFY, 5)})
        pi, result = self.send(data, faults=faults)
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(pi.crc_errors, 3)
        self.assertEqual(result["resends"], 3)
        self.assertEqual(bytes(pi.partition), data)

    def test_no_ready_or_a_damaged_status_means_send_it_again_and_not_apply_it_twice(self):
        data = image(20_000)
        faults = sim.Faults(no_ready={(sim.DATA, 1)}, damaged_status={(sim.DATA, 3)})
        pi, result = self.send(data, faults=faults)
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(result["resends"], 2)
        # The Pi had both frames: the second copies were acknowledged and not written again.
        self.assertEqual(pi.duplicates, 2)
        self.assertEqual(bytes(pi.partition), data)

    def test_a_busy_pi_is_waited_for(self):
        data = image(9_000)
        pi, result = self.send(data, faults=sim.Faults(busy={(sim.DATA, 1): 5, (sim.VERIFY, 3): 20}))
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(result["resends"], 0)

    def test_a_pi_that_lost_chunks_gets_them_again(self):
        data = image(40_000)
        pi, result = self.send(data, faults=sim.Faults(lose={6: 3}))
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(bytes(pi.partition), data)
        self.assertEqual([s for k, s in pi.log if k == sim.DATA], [0, 1, 2, 3, 4, 5, 6, 3, 4, 5, 6, 7, 8, 9])

    def test_a_pi_that_has_the_start_already_gets_the_rest(self):
        data = image(40_000)
        pi = sim.PiSim()
        pi.partition = bytearray(data[:4 * 4096] + bytes(len(data) - 4 * 4096))
        pi, result = self.send(data, faults=sim.Faults(resume_from=4))
        # A fresh simulator holds nothing, so the Pi's own hash fails: that is the Pi's end to keep.
        self.assertEqual(result["started_at"], 4)
        self.assertEqual([s for k, s in pi.log if k == sim.DATA], list(range(4, 10)))
        self.assertEqual(result["reason"], "pi_verify_failed")

    def test_the_pi_hash_check_failing_is_reported(self):
        data = image(10_000)
        faults = sim.Faults(refuse={(sim.VERIFY, 3): sim.HASH_MISMATCH})
        pi, result = self.send(data, faults=faults)
        self.assertEqual(result["reason"], "pi_verify_failed")
        self.assertEqual(result["code"], sim.HASH_MISMATCH)

    def test_a_refusal_is_final_and_reported_with_its_code(self):
        data = image(10_000)
        for key, code in (((sim.BEGIN, 0), sim.NO_SPACE), ((sim.DATA, 1), sim.WRITE_ERROR)):
            with self.subTest(code=code):
                pi, result = self.send(data, faults=sim.Faults(refuse={key: code}))
                self.assertEqual(result["reason"], "pi_rejected")
                self.assertEqual(result["code"], code)
                self.assertFalse(pi.verified)
                self.assertEqual(pi.log[-1], key)

    def test_a_pi_that_never_answers(self):
        data = image(10_000)
        pi, result = self.send(data, faults=sim.Faults(not_ready=True))
        self.assertEqual(result["reason"], "pi_not_ready")
        self.assertEqual(pi.log, [])

        # Answers BEGIN, then stops raising READY: given up after the attempts, with an ABORT.
        faults = sim.Faults(no_ready={(sim.DATA, 1)})
        pi, result = self.send(data, faults=faults, args=("--attempts", "1"))
        self.assertEqual(result["reason"], "pi_timeout")
        self.assertEqual(pi.aborted, sim.ABORTED)

    def test_a_card_that_went_bad_is_caught_before_the_pi_commits(self):
        data = image(30_000)
        pi, result = self.send(data, args=("--corrupt-at", "12345"))
        self.assertEqual(result["reason"], "sd_readback_mismatch")
        self.assertEqual(pi.aborted, sim.HASH_MISMATCH)
        self.assertNotIn(sim.VERIFY, [k for k, _ in pi.log])

    def test_a_withdrawn_job_aborts_the_transfer(self):
        data = image(30_000)
        pi, result = self.send(data, args=("--abort-at", "3"))
        self.assertEqual(result["reason"], "aborted")
        self.assertEqual(pi.aborted, sim.ABORTED)
        self.assertEqual([s for k, s in pi.log if k == sim.DATA], [0, 1, 2, 3])


class Simulator(unittest.TestCase):
    """The simulator holds the board to the contract: it refuses what the Pi end would refuse."""

    def test_it_refuses_frames_that_break_the_contract(self):
        pi = sim.PiSim()
        begin = bytearray(80)
        begin[0], begin[2], begin[4] = 1, 2, 16
        begin[8] = 32
        _, edge = pi.transaction(sim.frame(sim.BEGIN, 0, bytes(begin)), False)
        self.assertTrue(edge)
        with self.assertRaises(sim.ProtocolError):
            pi.transaction(sim.frame(sim.DATA, 0, (5).to_bytes(4, "little") + bytes(16)), False)
        with self.assertRaises(sim.ProtocolError):
            pi.transaction(sim.frame(sim.DATA, 0, bytes(4) + bytes(3)), False)
        with self.assertRaises(sim.ProtocolError):
            pi.transaction(b"XXXX" + bytes(16), False)
        with self.assertRaises(sim.ProtocolError):
            pi.transaction(sim.frame(sim.DATA, 0, bytes(4) + bytes(16)), True)

    def test_its_status_and_crc_are_the_ones_the_board_checks(self):
        self.assertEqual(sim.crc32(b"123456789"), 0xCBF43926)
        pi = sim.PiSim()
        begin = bytearray(80)
        begin[0], begin[2], begin[4] = 1, 7, 16
        begin[8] = 32
        pi.transaction(sim.frame(sim.BEGIN, 0, bytes(begin)), False)
        poll = sim.frame(sim.POLL, 0)
        miso, _ = pi.transaction(poll, True)
        self.assertEqual(sim.parse_status(miso), (sim.NAK, sim.BAD_TARGET, 0, 0))


if __name__ == "__main__":
    unittest.main()
