#!/usr/bin/env python3
"""Tests of scripts/board/new-board.sh and tools/new_board.py, with no board, no AWS and no console.

    python3 firmware/tests/hil/test_new_board.py

The helper is tested as a module: how it finds the boards in `nrfutil device list --json` and the serial
ports, picks exactly one or refuses, chooses the image to install, and leaves secrets out of what it shows.
The script runs in a scratch copy of the repository, with a PATH of stand-ins for nrfutil, west, aws, node
and python3 that record how they were called. The python3 stand-in answers for the tools that talk to a
board (provision_device.py, golden.py, recover.py, keys.py) and for the helper's commands that open a serial
port or reach the console, and hands everything else to the real Python. So these show what the script
runs, in which order, what it refuses, and what it prints; not what a board does.
"""

import hashlib
import io
import json
import os
import pty
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import tty
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib.util import find_spec
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import check_image  # noqa: E402
import new_board  # noqa: E402

# The console's real code on a pseudo-terminal, which `make -C firmware/tests/host build/console_sim` builds.
# CI builds it first, so there a test of it fails if it is missing instead of being skipped.
SIMULATOR = REPO / "firmware/tests/host/build/console_sim"
IN_CI = os.environ.get("CI") == "true"

SERIAL_A = "001050797470"
SERIAL_B = "001050123456"
THING = "cranium-0123456789abcdef"
TOKEN = "crn_" + "A" * 43


def signed(version=(1, 14, 0, 0), board=b"nrf7002dk", body=b"\x5a" * 200, layout=b"1"):
    """An image laid out as imgtool lays it out, as in test_check_image.py: header, body, the board type
    and layout as protected TLVs, then its SHA-256 and a stand-in signature."""
    protected = ((0xA1, board), (0xA2, layout)) if board else ()
    prot = b"".join(struct.pack("<HH", kind, len(value)) + value for kind, value in protected)
    prot = struct.pack("<HH", 0x6908, 4 + len(prot)) + prot if protected else b""
    header = bytearray(0x200)
    struct.pack_into("<IIHHII", header, 0, 0x96F3B83D, 0x30000, 0x200, len(prot), len(body), 0x100)
    header[20], header[21] = version[0], version[1]
    struct.pack_into("<HI", header, 22, version[2], version[3])
    covered = bytes(header) + body + prot
    entries = [(0x10, hashlib.sha256(covered).digest()), (0x01, bytes(32)), (0x22, bytes(71))]
    tlvs = b"".join(struct.pack("<HH", kind, len(value)) + value for kind, value in entries)
    return covered + struct.pack("<HH", 0x6907, 4 + len(tlvs)) + tlvs


def device(serial=SERIAL_A, pca="PCA10143", ports=2, macos=True):
    """One device as `nrfutil device list --json` lists it."""
    name = (lambda n: f"/dev/tty.usbmodem{serial}{2 * n + 1}") if macos else (lambda n: f"/dev/ttyACM{n}")
    return {"serialNumber": serial, "traits": {"jlink": True, "seggerUsb": True, "serialPorts": True},
            "devkit": {"boardVersion": pca, "deviceFamily": "NRF53_FAMILY"},
            "jlink": {"boardVersion": pca, "serialNumber": serial},
            "serialPorts": [{"comName": name(n), "path": name(n), "vcom": n, "serialNumber": serial,
                             "vendorId": "1366"} for n in range(ports)]}


def nrfutil_output(*devices):
    """What nrfutil prints with --json: one event per line, the list in an info event."""
    return "\n".join([json.dumps({"type": "task_begin", "data": {"task": {"name": "list"}}}),
                      json.dumps({"type": "info", "data": {"devices": list(devices)}}),
                      json.dumps({"type": "task_end", "data": {"task": {"name": "list"}}})]) + "\n"


# ---- the helper --------------------------------------------------------------------------------


class BoardsTest(unittest.TestCase):
    def test_an_nrf7002dk_with_its_two_ports(self):
        [board] = new_board.find_boards(nrfutil_output(device()), [], platform="darwin")
        self.assertEqual(board.type, "nrf7002dk")
        self.assertTrue(board.debugger)
        # The callout devices on macOS, the console on VCOM1 and the bootloader's log on VCOM0.
        self.assertEqual(board.console_port(), f"/dev/cu.usbmodem{SERIAL_A}3")
        self.assertEqual(board.log_port(), f"/dev/cu.usbmodem{SERIAL_A}1")

    def test_an_nrf5340dk(self):
        [board] = new_board.find_boards(nrfutil_output(device(pca="PCA10095")), [])
        self.assertEqual(board.type, "nrf5340dk")

    def test_linux_ports_without_a_vcom_number_sort_as_numbers(self):
        dev = device(macos=False)
        for port in dev["serialPorts"]:
            del port["vcom"]
        dev["serialPorts"] = [{"comName": "/dev/ttyACM10"}, {"comName": "/dev/ttyACM9"}]
        [board] = new_board.find_boards(nrfutil_output(dev), [], platform="linux")
        self.assertEqual(board.console_port(), "/dev/ttyACM10")
        self.assertEqual(board.log_port(), "/dev/ttyACM9")

    def test_a_device_with_no_jlink_is_no_board(self):
        dongle = {"serialNumber": "C0FFEE", "traits": {"jlink": False, "nordicUsb": True}}
        self.assertEqual(new_board.find_boards(nrfutil_output(dongle), []), [])

    def test_lines_that_are_not_json_are_passed_over(self):
        text = "warning: something\n" + nrfutil_output(device()) + "{broken\n"
        self.assertEqual(len(new_board.find_boards(text, [])), 1)

    def test_the_serial_ports_join_the_board_of_their_serial_number(self):
        ports = [{"device": f"/dev/cu.usbmodem{SERIAL_A}3", "serial_number": "1050797470", "vid": 0x1366},
                 {"device": "/dev/cu.Bluetooth-Incoming-Port", "serial_number": "", "vid": None}]
        [board] = new_board.find_boards(nrfutil_output(device()), ports, platform="darwin")
        self.assertEqual(len(board.ports), 2)

    def test_a_serial_port_whose_debugger_nrfutil_does_not_see(self):
        ports = [{"device": "/dev/ttyACM0", "serial_number": SERIAL_B, "vid": 0x1366},
                 {"device": "/dev/ttyACM1", "serial_number": SERIAL_B, "vid": 0x1366}]
        [board] = new_board.find_boards("", ports, platform="linux")
        self.assertFalse(board.debugger)
        self.assertEqual(board.console_port(), "/dev/ttyACM1")
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick([board], None, "nrf7002dk", need_debugger=True)
        self.assertIn("does not see the debugger", str(caught.exception))
        # Its status needs no debugger.
        self.assertEqual(new_board.pick([board], None, "nrf7002dk", need_debugger=False)[1], "nrf7002dk")


class PickTest(unittest.TestCase):
    def boards(self, *devices):
        return new_board.find_boards(nrfutil_output(*devices), [], platform="darwin")

    def test_no_board(self):
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick([], None, None, True)
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("no board is plugged in", str(caught.exception))

    def test_two_boards_and_no_choice(self):
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick(self.boards(device(SERIAL_A), device(SERIAL_B)), None, None, True)
        self.assertEqual(caught.exception.code, 3)
        self.assertIn(SERIAL_A, str(caught.exception))
        self.assertIn(SERIAL_B, str(caught.exception))
        self.assertIn("--serial-number", str(caught.exception))

    def test_two_boards_and_a_serial_number_with_or_without_its_zeros(self):
        boards = self.boards(device(SERIAL_A), device(SERIAL_B, pca="PCA10095"))
        board, board_type = new_board.pick(boards, SERIAL_B.lstrip("0"), None, True)
        self.assertEqual((board.serial, board_type), (SERIAL_B, "nrf5340dk"))

    def test_a_serial_number_that_is_not_plugged_in(self):
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick(self.boards(device()), "009999999999", None, True)
        self.assertEqual(caught.exception.code, 4)

    def test_a_board_type_the_debugger_contradicts(self):
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick(self.boards(device()), None, "nrf5340dk", True)
        self.assertEqual(caught.exception.code, 5)
        self.assertIn("--board nrf7002dk", str(caught.exception))

    def test_a_board_the_debugger_does_not_name(self):
        boards = self.boards(device(pca="PCA10040"))
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick(boards, None, None, True)
        self.assertIn("--board nrf7002dk or --board nrf5340dk", str(caught.exception))
        self.assertEqual(new_board.pick(boards, None, "nrf5340dk", True)[1], "nrf5340dk")
        self.assertEqual(new_board.pick(boards, None, None, True, any_type=True)[1], "")

    def test_a_board_with_no_serial_port(self):
        with self.assertRaises(new_board.Refusal) as caught:
            new_board.pick(self.boards(device(ports=0)), None, None, True)
        self.assertIn("no serial port", str(caught.exception))

    def test_the_command_prints_one_line_for_the_script(self):
        with mock.patch.dict(os.environ, {"NEW_BOARD_PORTS": "none"}), \
                mock.patch("sys.stdin", io.StringIO(nrfutil_output(device()))), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as out, \
                mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(new_board.main(["boards", "--pick"]), 0)
        self.assertEqual(out.getvalue().strip(), "|".join(
            (SERIAL_A, "nrf7002dk", "PCA10143", f"/dev/cu.usbmodem{SERIAL_A}3", f"/dev/cu.usbmodem{SERIAL_A}1")))


class RedactTest(unittest.TestCase):
    NAMES = ["cranium-ota-firmware-bucket-0123", "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"]

    def redact(self, line):
        return new_board.redact_line(line, sorted(self.NAMES, key=len, reverse=True))

    def test_the_status_lines_that_name_the_network_or_the_account(self):
        for key in ("wifi network", "wifi address", "endpoint", "download from"):
            self.assertEqual(self.redact(f"  {key:<14} something secret"), f"  {key:<14} (hidden)")
        self.assertEqual(self.redact("  wifi link      up"), "  wifi link      up")

    def test_the_network_provisioning_stored(self):
        line = 'Wi-Fi network "Vihaan’s "iPhone"" (WPA2_PSK) stored on the board'
        self.assertEqual(self.redact(line), "Wi-Fi network (name not shown) (WPA2_PSK) stored on the board")

    def test_what_names_the_account(self):
        line = ("aws iot create-thing failed: arn:aws:iot:us-east-1:123456789012:thing/x at "
                "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com, s3://cranium-ota-firmware-bucket-0123/f, "
                "account 123456789012, https://example.org/path")
        shown = self.redact(line)
        for secret in ("123456789012", "amazonaws", "bucket-0123", "example.org"):
            self.assertNotIn(secret, shown)

    def test_what_is_no_secret_stays(self):
        line = f"Board {THING} on /dev/cu.usbmodem{SERIAL_A}3, firmware 1.14.0+0"
        self.assertEqual(self.redact(line), line)

    def test_the_names_come_from_the_outputs_but_the_region(self):
        with tempfile.TemporaryDirectory() as folder:
            outputs = Path(folder) / "outputs.json"
            outputs.write_text(json.dumps({"Region": "us-east-1", "DeployedTree": "clean",
                                           "FirmwareBucketName": "cranium-ota-firmware-bucket-0123"}))
            self.assertEqual(new_board.account_names(outputs), ["cranium-ota-firmware-bucket-0123"])


class StatusTest(unittest.TestCase):
    STATUS = {"state": "OPERATING", "id": "CRVIHAAN01", "thing name": THING, "firmware": "1.14.0+0",
              "wifi network": "Vihaan’s iPhone", "wifi password": "set", "wifi address": "f4:ce:36:00:00:01",
              "endpoint": "a1b2-ats.iot.us-east-1.amazonaws.com", "download from": "https://bucket/x",
              "cloud": "connected", "update": "idle (last: none)"}

    def expectations(self, **given):
        fields = {"expect_state": None, "expect_version": None, "expect_board": None, "expect_cloud": None,
                  "expect_bt_window": None}
        fields.update(given)
        return mock.Mock(**fields)

    def test_only_what_names_nothing_is_shown(self):
        lines, hidden = new_board.shown_status(self.STATUS)
        text = "\n".join(lines)
        for secret in ("Vihaan", "amazonaws", "bucket", "f4:ce"):
            self.assertNotIn(secret, text)
        self.assertIn(THING, text)
        self.assertEqual(hidden, ["wifi network", "wifi address", "endpoint", "download from"])

    def test_what_is_expected_of_it(self):
        self.assertEqual(new_board.status_unmet(self.STATUS, self.expectations(
            expect_state="OPERATING", expect_version="1.14.0", expect_board="nrf7002dk",
            expect_cloud="connected")), [])
        unmet = new_board.status_unmet(self.STATUS, self.expectations(
            expect_state="FACTORY", expect_version="1.15.0+0", expect_board="nrf5340dk"))
        self.assertEqual(len(unmet), 3)

    def test_versions_with_and_without_the_build_number(self):
        self.assertTrue(new_board.same_version("1.5.0+0", "1.5.0"))
        self.assertFalse(new_board.same_version("1.5.0+0", "1.5.1+0"))
        self.assertFalse(new_board.same_version("", "1.5.0"))

    def test_what_the_bootloader_says_of_the_gesture(self):
        self.assertEqual(new_board.seal_result("[00:00:01.000,000] <inf> golden: sealed, restarting"), "sealed")
        self.assertEqual(new_board.seal_result("golden: nothing to do"), "nothing to do")
        self.assertEqual(new_board.seal_result("golden: refused: neither copy passes"), "refused")
        self.assertIsNone(new_board.seal_result("golden: Button 2 let go too early or too late"))

    def test_the_seal_strings_are_the_bootloaders(self):
        source = (REPO / "firmware/app/sysbuild/mcuboot/golden/src/golden.c").read_text()
        strings = re.findall(r'BOOT_LOG_\w+\("([^"]+)"', source)
        for said in new_board.SEAL_DONE:
            self.assertIn(said, strings)
        self.assertTrue(any(text.startswith(new_board.SEAL_REFUSED) for text in strings))


class ConsoleViewTest(unittest.TestCase):
    def test_a_board_online(self):
        board = {"thing": THING, "type": "nrf7002dk", "online": True, "lastSeen": "2026-11-05T12:00:00Z",
                 "version": "1.14.0+0", "versionFrom": "board"}
        now = new_board.datetime.fromisoformat("2026-11-05T12:00:30+00:00").timestamp()
        lines = new_board.describe_fleet_board(board, now)
        self.assertIn("online, last seen 30 s ago", lines[0])
        self.assertIn("1.14.0+0 (as the board reported it)", lines[1])
        args = mock.Mock(expect_online=True, expect_version="1.14.0")
        self.assertEqual(new_board.console_unmet(board, args), [])
        args.expect_version = "1.15.0"
        self.assertEqual(len(new_board.console_unmet(board, args)), 1)

    def test_a_bluetooth_only_board_and_one_not_registered(self):
        lines = new_board.describe_fleet_board({"thing": THING, "type": "nrf5340dk", "bluetoothOnly": True}, 0)
        self.assertIn("nRF5340 DK, Bluetooth only", lines[0])
        self.assertIn("not known yet", lines[1])
        self.assertIn("not registered", new_board.describe_fleet_board(None, 0)[0])

    def test_the_token(self):
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(check_image, "TOKEN_FILE", Path(folder) / "console-token"), \
                mock.patch.dict(os.environ, {"CRANIUM_TOKEN": "", "CRANIUM_CONSOLE_URL": "https://console.example.com"}):
            with self.assertRaises(new_board.Refusal) as caught:
                new_board.console()
            self.assertEqual(caught.exception.code, 2)
            os.environ["CRANIUM_TOKEN"] = "crn_short"
            with self.assertRaises(new_board.Refusal) as caught:
                new_board.console()
            self.assertEqual(caught.exception.code, 1)
            os.environ["CRANIUM_TOKEN"] = TOKEN
            os.environ["CRANIUM_CONSOLE_URL"] = "http://console.example.com"
            with self.assertRaises(new_board.Refusal):
                new_board.console()
            os.environ["CRANIUM_CONSOLE_URL"] = "https://console.example.com"
            self.assertEqual(new_board.console().url, "https://console.example.com")


class FakeConsole:
    def __init__(self, releases, images=None, image_status=200):
        self.releases = releases
        self.images = images or {}
        self.image_status = image_status
        self.asked = []

    def get_json(self, path):
        self.asked.append(path)
        return 200, {"releases": self.releases}

    def request(self, path, timeout=30):
        self.asked.append(path)
        version = path.split("/")[2]
        return self.image_status, self.images.get(version, b"")


def release_of(data, version, board="nrf7002dk", status="active"):
    return {"version": version, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "board": board,
            "status": status}


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.binaries = self.root / "binaries"
        self.out = self.root / "out"
        self.binaries.mkdir()
        self.no_check = mock.patch.object(new_board, "signature_checked", lambda image: None)
        self.no_check.start()
        self.addCleanup(self.no_check.stop)

    def put(self, name, data):
        (self.binaries / name).write_bytes(data)
        return data

    def args(self, board="nrf7002dk", image=None, fallback=None, layout=None):
        return mock.Mock(board=board, image=image, fallback=fallback, layout=layout, out_dir=str(self.out),
                         binaries=str(self.binaries))

    def choose(self, api=None, **given):
        console = mock.patch.object(new_board, "console", return_value=api) if api else \
            mock.patch.object(new_board, "console", side_effect=new_board.Refusal("no console token", 2))
        with console, redirect_stderr(io.StringIO()) as said:
            image = new_board.choose_image(self.args(**given))
        return image, said.getvalue()

    def test_the_newest_in_binaries_for_the_board_type(self):
        self.put("cranium-1.13.0-0.signed.bin", signed((1, 13, 0, 0)))
        self.put("cranium-1.14.0-0.signed.bin", signed((1, 14, 0, 0)))
        self.put("cranium-nrf5340dk-1.15.0-0.signed.bin", signed((1, 15, 0, 0), b"nrf5340dk"))
        self.put("latest.signed.bin", signed((1, 16, 0, 0)))
        self.put("cranium-1.17.0-0.signed.bin", b"not an image")
        image, said = self.choose()
        self.assertEqual((image.version, image.source), ((1, 14, 0, 0), "binaries"))
        self.assertIn("may not be a release", said)
        image, _ = self.choose(board="nrf5340dk")
        self.assertEqual(image.path.name, "cranium-nrf5340dk-1.15.0-0.signed.bin")

    def test_an_image_from_before_board_types_is_an_nrf7002dks(self):
        self.put("cranium-1.12.0-0.signed.bin", signed((1, 12, 0, 0), board=None))
        self.assertEqual(self.choose()[0].board, "nrf7002dk")
        with self.assertRaises(new_board.Refusal):
            self.choose(board="nrf5340dk")

    def test_the_consoles_newest_release_from_its_copy_in_binaries(self):
        old = self.put("cranium-1.13.0-0.signed.bin", signed((1, 13, 0, 0)))
        newest = self.put("cranium-1.14.0-0.signed.bin", signed((1, 14, 0, 0)))
        other = signed((1, 15, 0, 0), b"nrf5340dk")
        revoked = signed((1, 16, 0, 0))
        api = FakeConsole([release_of(old, "1.13.0+0"), release_of(newest, "1.14.0+0"),
                           release_of(other, "1.15.0+0", "nrf5340dk"), release_of(revoked, "1.16.0+0", status="revoked")])
        image, _ = self.choose(api)
        self.assertEqual((image.version, image.source), ((1, 14, 0, 0), "console"))
        self.assertEqual(api.asked, ["/firmware"])  # nothing downloaded

    def test_the_consoles_newest_release_downloaded_and_checked(self):
        # The same version in binaries/ with other bytes, as a rebuild would leave it, is not the release.
        self.put("cranium-1.14.0-0.signed.bin", signed((1, 14, 0, 0), body=b"\x11" * 200))
        data = signed((1, 14, 0, 0))
        api = FakeConsole([release_of(data, "1.14.0+0")], {"1.14.0%2B0": data})
        image, _ = self.choose(api)
        self.assertEqual(image.source, "console")
        self.assertEqual(image.path.parent, self.out)
        self.assertEqual(image.path.read_bytes(), data)

    def test_bytes_that_are_not_the_releases_are_refused(self):
        data = signed((1, 14, 0, 0))
        api = FakeConsole([release_of(data, "1.14.0+0")], {"1.14.0%2B0": signed((1, 14, 0, 0), body=b"\x22" * 200)})
        with self.assertRaises(new_board.Refusal):
            self.choose(api)
        self.assertFalse(self.out.exists() and any(self.out.iterdir()))

    def test_a_viewers_token_cannot_download_and_binaries_does(self):
        self.put("cranium-1.13.0-0.signed.bin", signed((1, 13, 0, 0)))
        data = signed((1, 14, 0, 0))
        image, said = self.choose(FakeConsole([release_of(data, "1.14.0+0")], image_status=403))
        self.assertEqual((image.version, image.source), ((1, 13, 0, 0), "binaries"))
        self.assertIn("only a release manager", said)

    def test_a_newer_image_in_binaries_is_mentioned(self):
        data = self.put("cranium-1.14.0-0.signed.bin", signed((1, 14, 0, 0)))
        self.put("cranium-1.14.1-0.signed.bin", signed((1, 14, 1, 0)))
        image, said = self.choose(FakeConsole([release_of(data, "1.14.0+0")]))
        self.assertEqual(image.version, (1, 14, 0, 0))
        self.assertIn("--image binaries/cranium-1.14.1-0.signed.bin", said)

    def test_the_builds_own_image_when_there_is_nothing_else(self):
        build = self.root / "zephyr.signed.bin"
        build.write_bytes(signed((1, 14, 0, 0)))
        image, said = self.choose(fallback=str(build))
        self.assertEqual(image.source, "build")
        self.assertIn("no release", said)
        with self.assertRaises(new_board.Refusal):
            self.choose()

    def test_an_image_for_another_flash_layout_is_not_taken(self):
        self.put("cranium-1.14.0-0.signed.bin", signed((1, 14, 0, 0), layout=b"2"))
        self.put("cranium-1.13.0-0.signed.bin", signed((1, 13, 0, 0)))
        self.assertEqual(self.choose(layout=1)[0].version, (1, 13, 0, 0))
        self.assertEqual(self.choose(layout=2)[0].version, (1, 14, 0, 0))
        data = signed((1, 15, 0, 0), layout=b"2")
        api = FakeConsole([release_of(data, "1.15.0+0") | {"layout": 2}], {"1.15.0%2B0": data})
        image, _ = self.choose(api, layout=1)
        self.assertEqual((image.version, image.source), ((1, 13, 0, 0), "binaries"))
        given = self.root / "given.signed.bin"
        given.write_bytes(data)
        with self.assertRaises(new_board.Refusal) as caught:
            self.choose(image=str(given), layout=1)
        self.assertIn("flash layout 2", str(caught.exception))

    def test_a_given_image_must_be_for_the_board(self):
        given = self.root / "given.signed.bin"
        given.write_bytes(signed((1, 14, 0, 0), b"nrf5340dk"))
        with self.assertRaises(new_board.Refusal):
            self.choose(image=str(given))
        self.assertEqual(self.choose(board="nrf5340dk", image=str(given))[0].source, "given")


class PtyLink:
    """The parent side of a pseudo-terminal, as the part of pyserial that tools/board.py uses."""

    def __init__(self, descriptor):
        self.descriptor = descriptor
        os.set_blocking(descriptor, False)

    def read(self, size):
        try:
            return os.read(self.descriptor, size)
        except BlockingIOError:
            time.sleep(0.005)
            return b""
        except OSError:
            return b""

    def write(self, data):
        os.write(self.descriptor, data)

    def close(self):
        pass


@unittest.skipUnless(IN_CI or (SIMULATOR.exists() and find_spec("serial")),
                     "needs pyserial and `make -C firmware/tests/host build/console_sim`")
class SimulatedConsoleTest(unittest.TestCase):
    """serial-status against the console's real code: what STATUS really says, and what is shown of it."""

    def setUp(self):
        import board

        self.board = board
        self.parent, child = pty.openpty()
        tty.setraw(child)
        self.process = subprocess.Popen([str(SIMULATOR)], stdin=child, stdout=child, stderr=subprocess.DEVNULL)
        os.close(child)
        self.addCleanup(os.close, self.parent)
        self.addCleanup(self.process.wait)
        self.addCleanup(self.process.kill)
        opener = mock.patch.object(board.serial, "Serial", lambda *args, **kwargs: PtyLink(self.parent))
        opener.start()
        self.addCleanup(opener.stop)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.record = Path(folder.name) / "status"
        self.console = board.Console("/dev/simulated", PtyLink(self.parent))
        self.console.wait_until_up(3)

    def serial_status(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = new_board.main(["serial-status", "--port", "/dev/simulated", "--record", str(self.record),
                                   "--poll", "0.2", *args])
        return code, out.getvalue(), err.getvalue()

    def recorded(self):
        return dict(line.split("=", 1) for line in self.record.read_text().splitlines())

    def test_a_board_in_factory_mode(self):
        code, out, _ = self.serial_status("--wait", "5", "--expect-state", "FACTORY")
        self.assertEqual(code, 0)
        self.assertEqual(self.recorded()["state"], "FACTORY")
        self.assertEqual(self.recorded()["thing name"], "cranium-fe5b26c0c5b1dcd7")
        self.assertIn("thing name     cranium-fe5b26c0c5b1dcd7", out)

    def test_what_names_the_network_is_not_shown(self):
        self.console.run("INIT|ABC123", wait=3)
        self.console.wait_until_up(3)
        self.console.run("WIFI|Tester’s iPhone|password-0123")
        code, out, _ = self.serial_status("--expect-state", "OPERATING")
        self.assertEqual(code, 0)
        self.assertEqual(self.console.status()["wifi network"], "Tester’s iPhone")
        self.assertNotIn("Tester", out)
        self.assertNotIn("Tester", self.record.read_text())
        self.assertIn("wifi password  set", out)
        self.assertIn("(not shown: wifi network, wifi address, endpoint, download from)", out)

    def test_an_expectation_that_is_not_met(self):
        code, _, err = self.serial_status("--wait", "1", "--expect-state", "OPERATING", "--expect-version", "9.9.9")
        self.assertEqual(code, 1)
        self.assertIn("its state is FACTORY, not OPERATING", err)
        self.assertIn("not 9.9.9", err)


# ---- the script --------------------------------------------------------------------------------

STUB = """#!/bin/sh
echo "{name} $*" >> "$CALLS"
{body}
"""

NRFUTIL = """case "$*" in
  --version) echo "nrfutil 8.1.1" ;;
  "device list --json") cat "$FAKE/devices.json" 2> /dev/null ;;
  "sdk-manager toolchain env"*) echo "export FAKE_TOOLCHAIN=1" ;;
esac
exit 0"""

WEST = """case "$1" in
  --version) echo "West version: v1.4.0" ;;
  flash) exit "${FAKE_WEST_EXIT:-0}" ;;
esac
exit 0"""

AWS = """case "$1" in
  --version) echo "aws-cli/2.31.0 Python/3.13.7 Darwin/25.0.0 exe/arm64" ;;
  sts) echo '{"UserId": "AIDA", "Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/x"}'
       exit "${FAKE_AWS_EXIT:-0}" ;;
esac
exit 0"""

BUILD = """case "$*" in *--board*) dir=build-nrf5340dk ;; *) dir=build ;; esac
mkdir -p "$dir/mcuboot/zephyr" "$dir/app/zephyr" "$dir/hci_ipc/zephyr"
: > "$dir/mcuboot/zephyr/zephyr.hex"; : > "$dir/mcuboot/zephyr/.config"; : > "$dir/hci_ipc/zephyr/zephyr.hex"
echo CONFIG_BT_HCI_RAW=y > "$dir/hci_ipc/zephyr/.config"
echo CONFIG_APP_IMAGE_LAYOUT=1 > "$dir/app/zephyr/.config"
cp "$FAKE/build-image.bin" "$dir/app/zephyr/zephyr.signed.bin"
# What a rebuild of a released version does to binaries/.
echo rebuilt > binaries/cranium-1.14.0-0.signed.bin
echo '{}' > binaries/latest.json
exit "${FAKE_BUILD_EXIT:-0}"
"""

# The stand-in for python3. It records every call, answers for what talks to a board or the console,
# and runs the rest with the real Python.
PYTHON = """#!{python}
import json, os, sys
args = sys.argv[1:]
with open(os.environ["CALLS"], "a") as calls:
    calls.write("python3 " + " ".join(args) + "\\n")
script = next((a for a in args if a.endswith(".py")), None)
key = os.path.basename(script) if script else None
if key == "new_board.py":
    command = args[args.index(script) + 1]
    key = "new_board.py " + command if command in ("serial-status", "console-status", "watch-seal", "ble-scan",
                                                    "token", "pydeps") else None
elif key not in ("provision_device.py", "golden.py", "recover.py", "keys.py", "secrets.py"):
    key = None
if key is None:
    os.execv({python!r}, [{python!r}] + args)
answers = json.load(open(os.path.join(os.environ["FAKE"], "answers.json")))
answer = answers.get(key, {{}})
if "--record" in args:
    record = dict(answers.get("record", {{}}))
    with open(args[args.index("--record") + 1], "w") as file:
        file.write("".join(f"{{k}}={{v}}\\n" for k, v in record.items()))
sys.stdout.write(answer.get("stdout", ""))
sys.stderr.write(answer.get("stderr", ""))
sys.exit(answer.get("exit", 0))
"""

RECORD = {"state": "OPERATING", "thing name": THING, "firmware": "1.14.0+0", "board": "nrf7002dk",
          "cloud": "connected", "bt passkey": "set", "bt name": "Cranium-3F9C", "bt window": "open"}


class ScriptTest(unittest.TestCase):
    """scripts/board/new-board.sh in a scratch copy of the repository, with stand-ins on the PATH."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        self.repo, self.home, self.bin, self.fake = root / "repo", root / "home", root / "bin", root / "fake"
        for path in (self.home / ".cranium", self.bin, self.fake, self.repo / "scripts" / "board", self.repo / "scripts" / "firmware", self.repo / "binaries",
                     self.repo / "firmware/app", self.repo / "cloud/.deploy", self.repo / "cloud/api",
                     root / "ncs/zephyr", root / "ncs/nrf"):
            path.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / "scripts/board/new-board.sh", self.repo / "scripts/board/new-board.sh")
        shutil.copytree(REPO / "tools", self.repo / "tools", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(REPO / "firmware/golden.json", self.repo / "firmware/golden.json")
        shutil.copy(REPO / "firmware/app/VERSION", self.repo / "firmware/app/VERSION")
        (self.repo / "cloud/api/verify-image.mjs").write_text("// the stand-in node passes every image\n")
        (self.repo / "cloud/.deploy/outputs.json").write_text(json.dumps({
            "Region": "us-east-1", "DeviceGroupName": "cranium-devices", "DevicePolicyName": "cranium-device",
            "FirmwareDownloadPrefix": "https://cranium-firmware-0123.s3.amazonaws.com/firmware/",
            "ConsoleUrl": "https://console.example.com", "IotEndpoint": "a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com"}))
        (root / "ncs/nrf/VERSION").write_text("VERSION_MAJOR = 3\nVERSION_MINOR = 4\nPATCHLEVEL = 0\n")
        self.release = signed((1, 14, 0, 0))
        (self.repo / "binaries/cranium-1.14.0-0.signed.bin").write_bytes(self.release)
        (self.repo / "binaries/README.md").write_text("binaries\n")
        (self.fake / "build-image.bin").write_bytes(signed((1, 14, 0, 0), body=b"\x33" * 200))

        self.write_stub("nrfutil", NRFUTIL)
        self.write_stub("west", WEST)
        self.write_stub("aws", AWS)
        self.write_stub("node", "exit 0")
        self.write_executable(self.repo / "scripts/firmware/build.sh", STUB.format(name="build.sh", body=BUILD))
        self.write_executable(self.bin / "python3", PYTHON.format(python=sys.executable))
        self.answers({})
        self.devices(device())
        self.calls_file = root / "calls.log"
        self.env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home), "CALLS": str(self.calls_file),
                    "FAKE": str(self.fake), "NCS_DIR": str(root / "ncs"), "NEW_BOARD_PORTS": "none",
                    "CRANIUM_CONSOLE_URL": "http://127.0.0.1:9", "PYTHONIOENCODING": "utf-8",
                    "TMPDIR": str(root)}

    def write_executable(self, path, text):
        path.write_text(text)
        path.chmod(0o755)

    def write_stub(self, name, body):
        self.write_executable(self.bin / name, STUB.format(name=name, body=body))

    def answers(self, given):
        answers = {"record": RECORD, "new_board.py token": {"stdout": "no console token\n", "exit": 2}}
        answers.update(given)
        (self.fake / "answers.json").write_text(json.dumps(answers))

    def devices(self, *devices):
        (self.fake / "devices.json").write_text(nrfutil_output(*devices))

    def secrets(self, key=True, wifi=True, token=False):
        folder = self.home / ".cranium"
        for name, wanted, text in (("mcuboot_signing_key.pem", key, "a key\n"),
                                   ("wifi_secrets.h", wifi, "#define WIFI_SECRETS_SSID \"x\"\n"),
                                   ("console-token", token, TOKEN + "\n")):
            path = folder / name
            if wanted:
                path.write_text(text)
                path.chmod(0o600)
            elif path.exists():
                path.unlink()

    def run_script(self, *args, stdin="", **env):
        result = subprocess.run(["bash", str(self.repo / "scripts/board/new-board.sh"), *args], cwd=self.repo,
                                input=stdin, capture_output=True, text=True, timeout=120,
                                env={**self.env, **env})
        self.output = result.stdout + result.stderr
        return result

    def calls(self):
        return self.calls_file.read_text().splitlines() if self.calls_file.exists() else []

    def called(self, text):
        return [call for call in self.calls() if text in call]

    def assertNothingWritten(self):
        for what in ("west flash", "build.sh", "golden.py restore", "recover.py", "provision_device.py"):
            self.assertEqual(self.called(what), [], f"{what} was run:\n{self.output}")

    def board_files(self, folder="build"):
        for name in ("mcuboot/zephyr/zephyr.hex", "app/zephyr/zephyr.signed.bin", "hci_ipc/zephyr/zephyr.hex",
                     "mcuboot/zephyr/.config"):
            path = self.repo / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(signed((1, 14, 0, 0)) if name.endswith(".bin") else b"")
        (self.repo / folder / "hci_ipc/zephyr/.config").write_text("CONFIG_BT_HCI_RAW=y\n")

    def state(self, serial=SERIAL_A):
        path = self.repo / "build-new-board" / f"{serial}.state"
        return dict(line.split("=", 1) for line in path.read_text().splitlines()) if path.exists() else {}

    # check

    def test_check_says_what_is_there(self):
        self.secrets(token=True)
        self.answers({"new_board.py token": {"stdout": "the console takes the token, and its owner is a release manager\n"},
                      "keys.py": {"stdout": "ok: the private key matches firmware/keys/fw_signing_pub.pem\n"}})
        result = self.run_script("check")
        self.assertEqual(result.returncode, 0, self.output)
        for line in ("ok    nrfutil (nrfutil 8.1.1)", "ok    nRF Connect SDK v3.4.0",
                     "ok    the signing key matches", "ok    the golden image agrees",
                     "ok    the Wi-Fi network for the board", "ok    signed in to AWS with the profile cranium",
                     "ok    a console token: the console takes the token", SERIAL_A, "nRF7002 DK (PCA10143)", "Ready"):
            self.assertIn(line, self.output)
        # aws sts names the account: none of it is shown. Nor is the Wi-Fi file read.
        self.assertNotIn("123456789012", self.output)
        self.assertEqual(self.called("wifi_secrets"), [])

    def test_check_without_the_key_says_where_it_comes_from_and_makes_none(self):
        self.secrets(key=False)
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  no signing key at ~/.cranium/mcuboot_signing_key.pem", self.output)
        self.assertIn("custodian", self.output)
        self.assertIn("Never make a new one with tools/keys.py generate", self.output)
        self.assertEqual(self.called("keys.py"), [])
        self.assertFalse((self.home / ".cranium/mcuboot_signing_key.pem").exists())

    def test_check_signed_out_of_aws_and_with_no_wifi_network(self):
        self.secrets(wifi=False)
        result = self.run_script("check", FAKE_AWS_EXIT="255")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL  not signed in to AWS with the profile cranium", self.output)
        self.assertIn("aws login --profile cranium --region us-east-1", self.output)
        self.assertIn("FAIL  no Wi-Fi network for the board", self.output)
        self.assertIn("python3 tools/secrets.py wifi", self.output)
        self.assertIn("warn  no console token", self.output)

    def test_check_of_an_nrf5340dk_needs_a_token_and_a_checkout_that_knows_it(self):
        self.secrets()
        self.devices(device(pca="PCA10095"))
        self.answers({"new_board.py token": {"stdout": "no console token\n", "exit": 2}})
        result = self.run_script("check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("set up an nRF5340 DK", self.output)
        self.assertIn("FAIL  no console token, which an nRF5340 DK's passkey needs", self.output)
        self.assertIn("FAIL  this checkout cannot build or provision an nRF5340 DK yet", self.output)
        self.assertNotIn("golden", self.output)

    # which board

    def test_setup_refuses_with_no_board(self):
        self.secrets()
        self.devices()
        result = self.run_script(stdin="7470\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no board is plugged in", self.output)
        self.assertNothingWritten()

    def test_setup_refuses_with_two_boards(self):
        self.secrets()
        self.devices(device(SERIAL_A), device(SERIAL_B))
        result = self.run_script(stdin="7470\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("2 boards are plugged in", self.output)
        self.assertIn(SERIAL_A, self.output)
        self.assertIn(SERIAL_B, self.output)
        self.assertNothingWritten()

    def test_two_boards_and_a_serial_number(self):
        self.secrets()
        self.devices(device(SERIAL_A), device(SERIAL_B))
        result = self.run_script("--only", "verify", "--serial-number", SERIAL_B)
        self.assertEqual(result.returncode, 0, self.output)
        [status] = self.called("serial-status")
        self.assertIn(f"--port /dev/cu.usbmodem{SERIAL_B}3" if sys.platform == "darwin" else
                      f"--port /dev/tty.usbmodem{SERIAL_B}3", status)
        self.assertNothingWritten()

    # the erase

    def test_the_erase_needs_the_boards_last_four_digits(self):
        self.secrets()
        self.board_files()
        result = self.run_script("--only", "flash", stdin="1234\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"This ERASES the board {SERIAL_A} (nRF7002 DK)", self.output)
        self.assertIn("Type its last 4 digits to go on", self.output)
        self.assertIn(f"that is not the last 4 digits of {SERIAL_A}: nothing was done", self.output)
        self.assertNothingWritten()
        # And with nothing typed at all.
        self.run_script("--only", "flash")
        self.assertNothingWritten()

    def test_the_erase_goes_on_with_them(self):
        self.secrets()
        self.board_files()
        result = self.run_script("--only", "flash", stdin="7470\n")
        self.assertEqual(result.returncode, 0, self.output)
        [flash] = self.called("west flash")
        self.assertEqual(flash, f"west flash -d build --recover --dev-id {SERIAL_A}")
        self.assertIn("--expect-state FACTORY", self.called("serial-status")[0])
        self.assertEqual(self.state()["last_step"], "flash")

    def test_a_failed_step_says_how_to_go_on(self):
        self.secrets()
        self.board_files()
        result = self.run_script("--only", "flash", "--confirm", "7470", FAKE_WEST_EXIT="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Stopped in the flash step", self.output)
        self.assertIn(f"scripts/board/new-board.sh --from flash --serial-number {SERIAL_A}", self.output)
        self.assertEqual(self.state(), {})

    def test_an_unready_computer_touches_no_board(self):
        self.secrets(key=False)
        result = self.run_script(stdin="7470\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("this computer is not ready", self.output)
        self.assertNotIn("Type its last 4 digits", self.output)
        self.assertNothingWritten()

    # the dry run

    def test_a_dry_run_runs_nothing(self):
        result = self.run_script("--dry-run")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual(self.calls(), [])
        for command in ("scripts/firmware/build.sh --keep --no-upload", "west flash -d build --recover --dev-id <serial>",
                        "python3 tools/golden.py restore --reset --serial-number <serial> --port <console port>",
                        "python3 tools/recover.py --reset --serial-number <serial> --port <console port> upload <that image>",
                        "python3 -u tools/provision_device.py --port <console port> --profile cranium",
                        "would ask: This ERASES the board <serial>", "Dry run: nothing was run."):
            self.assertIn(command, self.output)

    def test_a_dry_run_of_an_nrf5340dk(self):
        result = self.run_script("--dry-run", "--board", "nrf5340dk", "--serial-number", SERIAL_B, "--no-register")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual(self.calls(), [])
        self.assertIn("scripts/firmware/build.sh --keep --no-upload --board nrf5340dk", self.output)
        self.assertIn(f"west flash -d build-nrf5340dk --recover --dev-id {SERIAL_B}", self.output)
        self.assertIn("--board nrf5340dk --no-register", self.output)
        self.assertIn("ble-scan", self.output)
        self.assertNotIn("golden.py", self.output)
        self.assertIn("Step 4 of 5: provision", self.output)

    def test_a_dry_run_from_a_step(self):
        result = self.run_script("--dry-run", "--from", "release", "--serial-number", SERIAL_A)
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual(self.calls(), [])
        self.assertNotIn("west flash", self.output)
        self.assertIn("would ask: This writes to the board", self.output)
        self.assertIn("Step 4 of 6: release", self.output)

    # going on where it stopped

    def test_from_starts_at_that_step(self):
        self.secrets()
        result = self.run_script("--from", "provision", "--confirm", "7470")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertNotIn("ERASES", self.output)
        for what in ("west flash", "build.sh", "golden.py", "recover.py"):
            self.assertEqual(self.called(what), [], what)
        [provision] = self.called("provision_device.py")
        port = f"/dev/{'cu' if sys.platform == 'darwin' else 'tty'}.usbmodem{SERIAL_A}3"
        self.assertEqual(provision, f"python3 -u tools/provision_device.py --port {port} --profile cranium")
        self.assertEqual(self.state()["last_step"], "verify")
        self.assertIn("Step 5 of 6: provision", self.output)

    def test_resume_goes_on_after_the_last_step_done(self):
        self.secrets()
        (self.repo / "build-new-board").mkdir()
        (self.repo / "build-new-board" / f"{SERIAL_A}.state").write_text("last_step=golden\nboard=nrf7002dk\n")
        result = self.run_script("--resume", "--confirm", "7470")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertIn("got through the golden step: going on from release", self.output)
        self.assertEqual(self.called("west flash") + self.called("golden.py"), [])
        [upload] = self.called("recover.py")
        self.assertTrue(upload.endswith(" upload binaries/cranium-1.14.0-0.signed.bin"), upload)
        self.assertEqual(len(self.called("provision_device.py")), 1)
        self.assertEqual(self.state()["release"], "1.14.0+0")

    def test_a_step_that_is_not_one(self):
        result = self.run_script("--from", "nothing", "--confirm", "7470")
        self.assertEqual(result.returncode, 1)
        self.assertIn("there is no step nothing", self.output)
        result = self.run_script("--dry-run", "--board", "nrf5340dk", "--only", "golden")
        self.assertIn("an nRF5340 DK has no golden step", self.output)

    # the whole of it

    def test_a_whole_setup_of_an_nrf7002dk(self):
        self.secrets()
        self.answers({"provision_device.py": {"stdout": "\n".join((
            f"Board {THING} on the port, firmware 1.14.0+0",
            'Wi-Fi network "Vihaan’s iPhone" (WPA2_PSK) stored on the board',
            "Registered it with arn:aws:iot:us-east-1:123456789012:cert/abc",
            "  endpoint       a1b2c3d4e5f6g7-ats.iot.us-east-1.amazonaws.com",
            "  download from  https://cranium-firmware-0123.s3.amazonaws.com/firmware/",
            "Done: the board is connected to AWS IoT.")) + "\n"}})
        result = self.run_script(stdin="7470\nskip\n")
        self.assertEqual(result.returncode, 0, self.output)
        def name(call):
            words = call.split()
            return next((Path(word).name for word in words if word.endswith(".py")), words[0]) \
                if words[0] == "python3" else " ".join(words[:2])
        order = [name(call) for call in self.calls()]
        steps = [what for what in order if what in ("build.sh --keep", "west flash", "golden.py", "recover.py",
                                                    "provision_device.py")]
        # The golden image checked before anything, the build, its bootloader's pin checked (after the
        # build and before the flash), the flash, the golden image put on, the release, provisioning.
        self.assertEqual(steps, ["golden.py", "build.sh --keep", "golden.py", "golden.py", "west flash", "golden.py",
                                 "golden.py", "recover.py", "provision_device.py"])
        self.assertTrue(self.called("watch-seal"))
        self.assertIn("Now seal it, at the board", self.output)
        # The release must be for the flash layout the bootloader was built with.
        [release] = self.called("new_board.py release")
        self.assertIn("--board nrf7002dk", release)
        self.assertIn("--layout 1", release)
        # What provisioning printed, with neither the network's name nor the account's.
        self.assertIn("Done: the board is connected to AWS IoT.", self.output)
        for secret in ("Vihaan", "123456789012", "amazonaws", "a1b2c3d4e5f6g7"):
            self.assertNotIn(secret, self.output)
        # The build changed nothing in binaries/.
        self.assertEqual((self.repo / "binaries/cranium-1.14.0-0.signed.bin").read_bytes(), self.release)
        self.assertFalse((self.repo / "binaries/latest.json").exists())
        self.assertIn("binaries/ is as it was before the build", self.output)
        self.assertEqual(self.state()["last_step"], "verify")
        self.assertIn("Done: the nRF7002 DK 001050797470 got through build flash golden release provision verify.",
                      self.output)

    def test_a_whole_setup_of_an_nrf5340dk(self):
        self.secrets(wifi=False, token=True)
        self.devices(device(pca="PCA10095"))
        # A checkout that has the nRF5340 DK: its build.sh, here a stand-in, and provision_device.py know it.
        with open(self.repo / "scripts/firmware/build.sh", "a") as file:
            file.write("# scripts/firmware/build.sh --board nrf5340dk\n")
        with open(self.repo / "tools/provision_device.py", "a") as file:
            file.write("# python tools/provision_device.py --board nrf5340dk\n")
        (self.fake / "build-image.bin").write_bytes(signed((1, 14, 0, 0), b"nrf5340dk"))
        self.answers({"record": {**RECORD, "board": "nrf5340dk", "cloud": ""},
                      "new_board.py token": {"stdout": "the console takes the token, and its owner is a release manager\n"}})
        result = self.run_script(stdin="7470\n")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertEqual(self.called("golden.py"), [])
        [build] = self.called("build.sh")
        self.assertIn("--board nrf5340dk", build)
        self.assertEqual(self.called("west flash")[0], f"west flash -d build-nrf5340dk --recover --dev-id {SERIAL_A}")
        # No release in binaries/ for it, so the build's own image, said to be no release.
        self.assertIn("build-nrf5340dk/app/zephyr/zephyr.signed.bin", self.called("recover.py")[0])
        self.assertIn("which is no release", self.output)
        [provision] = self.called("provision_device.py")
        self.assertIn("--board nrf5340dk", provision)
        self.assertIn("hold Button 1 for 5 s", self.output)
        self.assertTrue(self.called("ble-scan --name Cranium-3F9C"))
        self.assertTrue(self.called("console-status --thing " + THING + " --wait 60 --expect-listed"))

    # status

    def test_status_shows_the_board_and_the_consoles_view(self):
        self.answers({"new_board.py serial-status": {"stdout": "  state          OPERATING\n"},
                      "new_board.py console-status": {"stdout": "  console        registered, nRF7002 DK, online\n"}})
        result = self.run_script("status", SERIAL_A)
        self.assertEqual(result.returncode, 0, self.output)
        self.assertIn(f"Board {SERIAL_A}: nRF7002 DK (PCA10143)", self.output)
        self.assertIn("registered, nRF7002 DK, online", self.output)
        self.assertTrue(self.called(f"console-status --thing {THING}"))
        self.assertNothingWritten()

    def test_status_without_a_console_token(self):
        self.answers({"new_board.py console-status": {"stderr": "error: no console token\n", "exit": 2}})
        result = self.run_script("status")
        self.assertEqual(result.returncode, 0, self.output)
        self.assertIn("The console's view needs a console token", self.output)

    def test_help(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("scripts/board/new-board.sh check", self.output)
        self.assertIn("--from <step>", self.output)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
