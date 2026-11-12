#!/usr/bin/env python3
"""Tests of tools/matter_check.py, the one command that says whether Matter works on a board.

The parsers and the code checks run anywhere, on what the Matter image prints. The whole run is tested
against a pretend board. The last test is the real one: it is marked hardware and runs only when
MATTER_PORT names a board with the Matter image (the owner's run; CI skips it).

    python3 firmware/tests/hil/test_matter_check.py
    MATTER_PORT=/dev/tty.usbmodemXXXXXXXX python3 firmware/tests/hil/test_matter_check.py
"""

import importlib.util
import io
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("matter_check", REPO / "tools/matter_check.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

STATUS = "matter status\r\ncommissioning: idle; Thread: leader; SRP: running\r\nuart:~$ "
DEVICE = ("as a device: not added yet; QR MT:Y.K9042C00KA0648G00, code 34970112332 (test credentials)\r\n"
          "uart:~$ ")
SELFTEST = "\r\n".join(["SELFTEST tlv PASS", "SELFTEST spake2p PASS", "SELFTEST thread_leader PASS role=leader",
                        "SELFTEST flash_areas PASS", "SELFTEST RESULT PASS", "uart:~$ "])


class ParseTest(unittest.TestCase):
    def test_status(self):
        self.assertEqual(check.parse_status(STATUS), {"commissioning": "idle", "thread": "leader", "srp": "running"})
        self.assertEqual(check.parse_status("command not found"), {})

    def test_device(self):
        d = check.parse_device(DEVICE)
        self.assertEqual((d["qr"], d["manual"], d["commissioned"]), (check.TEST_QR, check.TEST_MANUAL, False))
        self.assertTrue(check.parse_device(DEVICE.replace("not added yet", "added to a phone's fabric"))["commissioned"])

    def test_selftest(self):
        rows, result = check.parse_selftest(SELFTEST)
        self.assertEqual(result, "PASS")
        self.assertEqual(rows[2], ("thread_leader", "PASS", "role=leader"))
        rows, result = check.parse_selftest("SELFTEST tlv FAIL\r\nSELFTEST RESULT FAIL")
        self.assertEqual((rows, result), ([("tlv", "FAIL", "")], "FAIL"))
        self.assertIsNone(check.parse_selftest("SELFTEST tlv PASS")[1])


class CodesTest(unittest.TestCase):
    def test_the_sdk_test_vectors(self):
        f = check.decode_qr(check.TEST_QR)
        self.assertEqual((f["vendor"], f["product"], f["discriminator"], f["passcode"], f["discovery"]),
                         (0xFFF1, 0x8000, 3840, 20202021, 2))
        self.assertTrue(check.check_codes(check.TEST_QR, check.TEST_MANUAL)[0])

    def test_wrong_codes_fail(self):
        self.assertFalse(check.verhoeff_ok("34970112333"))
        self.assertFalse(check.check_codes(check.TEST_QR, "34970112333")[0])
        self.assertFalse(check.check_codes("MT:Y.K9042C00KA0648G01", check.TEST_MANUAL)[0])
        self.assertFalse(check.check_codes("MT:??", check.TEST_MANUAL)[0])


class FakeBoard:
    def __init__(self, answers):
        self.answers, self.sent = answers, []

    def run(self, command, wait=5.0, until=check.PROMPT):
        self.sent.append(command)
        return self.answers.get(command, "")

    def close(self):
        pass


class RunTest(unittest.TestCase):
    def run_main(self, answers, env=None, argv=("--port", "fake")):
        board = FakeBoard(answers)
        out = io.StringIO()
        with mock.patch.object(check, "Board", lambda port: board), \
                mock.patch.object(check, "ble_seen", lambda: (None, "bleak is not installed")), \
                mock.patch.object(check.shutil, "which", lambda name: None), \
                mock.patch.object(check.time, "sleep", lambda s: None), \
                mock.patch.dict(os.environ, env or {}, clear=True), \
                mock.patch.object(sys, "argv", ["matter_check.py", *argv]), redirect_stdout(out):
            code = check.main()
        return code, out.getvalue(), board

    def test_a_working_board_passes_with_skips(self):
        code, out, _ = self.run_main({"matter status": STATUS, "matter selftest": SELFTEST, "matter device": DEVICE,
                                      "wifi status": "State: DISCONNECTED"})
        self.assertEqual(code, 0, out)
        self.assertIn("VERDICT: PASS", out)
        self.assertIn("chip-tool is not on the PATH", out)
        self.assertNotIn("FAIL", out)

    def test_no_matter_image_fails(self):
        code, out, _ = self.run_main({})
        self.assertEqual(code, 1)
        self.assertIn("VERDICT: FAIL", out)

    def test_a_thread_detached_board_fails(self):
        code, out, _ = self.run_main({"matter status": STATUS.replace("leader", "detached"),
                                      "matter selftest": SELFTEST, "matter device": DEVICE})
        self.assertEqual(code, 1)
        self.assertRegex(out, r"thread\s+FAIL")

    def test_the_wifi_password_is_never_printed(self):
        secret = "not-a-real-password-1234"
        code, out, board = self.run_main(
            {"matter status": STATUS, "matter selftest": SELFTEST, "matter device": DEVICE,
             "wifi status": "State: DISCONNECTED"},
            env={"MATTER_WIFI_SSID": "test-net", "MATTER_WIFI_PASSWORD": secret}, argv=("--port", "fake", "--wifi"))
        self.assertNotIn(secret, out)
        self.assertTrue(any(secret in c for c in board.sent))  # it went to the board, only there

    def test_chip_tool_output_hides_the_password(self):
        secret = "hidden-pw"
        with mock.patch.object(check.subprocess, "run",
                               lambda *a, **k: subprocess.CompletedProcess(a, 0, f"pw {secret}", "")):
            ok, out = check.chip_tool(["x"], secret=secret)
        self.assertTrue(ok)
        self.assertNotIn(secret, out)


@unittest.skipUnless(os.environ.get("MATTER_PORT"), "hardware: set MATTER_PORT to the board's serial port")
class HardwareTest(unittest.TestCase):
    """Marked hardware: the real board, run by its owner."""

    def test_matter_works_on_the_board(self):
        p = subprocess.run([sys.executable, str(REPO / "tools/matter_check.py"), "--port", os.environ["MATTER_PORT"]],
                           capture_output=True, text=True, timeout=900)
        print(p.stdout)
        self.assertIn("VERDICT: PASS", p.stdout)


if __name__ == "__main__":
    unittest.main()
