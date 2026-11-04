#!/usr/bin/env python3
"""Tests of tools/check_image.py: what it decides from an image, its board type TLV, its record, CI's
runs and the console's releases. The calls to git, gh, node and the console are thin and are not run
here. Where the SDK's imgtool can run, an image it signs is read too."""

import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import check_image  # noqa: E402

PASS, WARN, FAIL, SKIP = check_image.PASS, check_image.WARN, check_image.FAIL, check_image.SKIP


def image(version=(1, 9, 0, 0), size=1024):
    header = bytearray(32)
    struct.pack_into("<I", header, 0, 0x96F3B83D)
    header[20], header[21] = version[0], version[1]
    struct.pack_into("<HI", header, 22, version[2], version[3])
    return bytes(header) + bytes(size - 32)


THIS_BOARD = ((0xA1, b"nrf7002dk"), (0xA2, b"1"))


def signed(version=(1, 13, 0, 0), protected=THIS_BOARD, body=b"\x5a" * 200, digest=None, unprotected=(),
           header_size=0x200):
    """An image laid out as imgtool lays it out: header, body, protected TLVs, then SHA-256 and a
    signature that is only its size. digest replaces the SHA-256 the image would have."""
    prot = b"".join(struct.pack("<HH", kind, len(value)) + value for kind, value in protected)
    prot = struct.pack("<HH", 0x6908, 4 + len(prot)) + prot if protected else b""
    header = bytearray(header_size)
    struct.pack_into("<IIHHII", header, 0, 0x96F3B83D, 0x30000, header_size, len(prot), len(body), 0x100)
    header[20], header[21] = version[0], version[1]
    struct.pack_into("<HI", header, 22, version[2], version[3])
    covered = bytes(header) + body + prot
    entries = [(0x10, digest if digest is not None else hashlib.sha256(covered).digest()), (0x01, bytes(32)),
               (0x22, bytes(71)), *unprotected]
    tlvs = b"".join(struct.pack("<HH", kind, len(value)) + value for kind, value in entries)
    return covered + struct.pack("<HH", 0x6907, 4 + len(tlvs)) + tlvs


def record_for(data, **changes):
    record = {
        "version": check_image.version_text(check_image.header_version(data)),
        "file": "cranium-1.9.0-0.signed.bin",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bluetooth": True,
        "commit": "41f9a30",
        "command_line": [],
    }
    record.update(changes)
    return record


class VersionTest(unittest.TestCase):
    def test_the_header_gives_the_version(self):
        self.assertEqual(check_image.header_version(image((1, 9, 2, 7))), (1, 9, 2, 7))
        self.assertEqual(check_image.version_text((1, 9, 2, 7)), "1.9.2+7")

    def test_what_is_not_an_mcuboot_image_has_none(self):
        self.assertIsNone(check_image.header_version(b"\x00" * 64))
        self.assertIsNone(check_image.header_version(b"short"))

    def test_versions_from_the_console_parse(self):
        self.assertEqual(check_image.parse_version("1.10.0+3"), (1, 10, 0, 3))
        self.assertEqual(check_image.parse_version("1.8.0"), (1, 8, 0, 0))
        for bad in ("", "1.8", "a.b.c+d", None):
            self.assertIsNone(check_image.parse_version(bad), bad)


class RecordTest(unittest.TestCase):
    def test_a_clean_record_passes(self):
        data = image()
        results = check_image.check_record(record_for(data), data)
        self.assertEqual([r[0] for r in results], [PASS, PASS])

    def test_no_record_fails(self):
        self.assertEqual(check_image.check_record(None, image())[0][0], FAIL)

    def test_uncommitted_changes_fail(self):
        data = image()
        for commit in ("41f9a30+uncommitted", "unknown"):
            results = check_image.check_record(record_for(data, commit=commit), data)
            self.assertEqual(results[0][0], FAIL, commit)

    def test_a_record_of_other_bytes_fails(self):
        data = image()
        self.assertEqual(check_image.check_record(record_for(data, size=5), data)[0][0], FAIL)
        self.assertEqual(check_image.check_record(record_for(data, version="1.8.0+0"), data)[0][0], FAIL)

    def test_command_line_settings_and_no_bluetooth_are_warnings(self):
        data = image()
        results = dict((title, status) for status, title, _ in check_image.check_record(
            record_for(data, command_line=["app_CONFIG_LOG=n"], bluetooth=False), data))
        self.assertEqual(results["Build settings"], WARN)
        self.assertEqual(results["Bluetooth"], WARN)
        self.assertEqual(results["Build record"], PASS)

    def test_an_old_record_does_not_say_about_bluetooth(self):
        data = image()
        old = record_for(data)
        del old["bluetooth"]
        self.assertEqual(dict((t, s) for s, t, _ in check_image.check_record(old, data))["Bluetooth"], SKIP)


class BoardTest(unittest.TestCase):
    def test_the_board_type_is_read_from_the_protected_area(self):
        self.assertEqual(check_image.board_of(signed()), "nrf7002dk")
        other = signed(protected=((0xA1, b"nrf5340dk"), (0xA2, b"1")))
        self.assertEqual(check_image.board_of(other), "nrf5340dk")
        # Among other protected TLVs, before or after it.
        self.assertEqual(check_image.board_of(signed(protected=((0x50, b"\x01\0\0\0"), (0xA1, b"nrf5340dk"),
                                                                (0xA2, b"x")))), "nrf5340dk")
        status, title, detail = check_image.check_board(signed(), None)[0]
        self.assertEqual((status, title), (PASS, "Board"))
        self.assertIn("nrf7002dk", detail)

    def test_an_image_before_1_13_0_is_for_the_nrf7002dk(self):
        old = signed(version=(1, 12, 0, 0), protected=())
        self.assertIsNone(check_image.board_of(old))
        status, _, detail = check_image.check_board(old, None)[0]
        self.assertEqual(status, PASS)
        self.assertIn("nrf7002dk", detail)

    def test_an_image_from_1_13_0_without_one_fails(self):
        for version in ((1, 13, 0, 0), (1, 13, 1, 0), (2, 0, 0, 0)):
            self.assertEqual(check_image.check_board(signed(version=version, protected=()), None)[0][0], FAIL)
        self.assertEqual(check_image.check_board(signed(protected=((0x50, b"\x01\0\0\0"),)), None)[0][0], FAIL)

    def test_a_protected_area_that_does_not_verify_fails(self):
        good = signed(protected=((0xA1, b"nrf7002dk"),))
        prot_at = 0x200 + 200
        cases = {
            # Changed after signing: the SHA-256, which the signature covers, no longer matches.
            "a changed type": good[:prot_at + 8] + b"nrf5340dk" + good[prot_at + 17:],
            "a changed digest": signed(digest=bytes(32)),
            "no digest": good[:prot_at + 17] + struct.pack("<HH", 0x6907, 4),
            # Not well formed.
            "the wrong magic": good[:prot_at] + struct.pack("<H", 0x6907) + good[prot_at + 2:],
            "a total that is not the header's": good[:prot_at + 2] + struct.pack("<H", 16) + good[prot_at + 4:],
            "an entry longer than the area": good[:prot_at + 6] + struct.pack("<H", 10) + good[prot_at + 8:],
            "a file shorter than its header says": good[:prot_at + 10],
        }
        for what, image in cases.items():
            with self.subTest(what):
                with self.assertRaises(check_image.ImageError):
                    check_image.board_of(image)
                status, _, detail = check_image.check_board(image, None)[0]
                self.assertEqual(status, FAIL)
                self.assertIn("does not verify", detail)

    def test_what_cannot_be_a_board_type_fails(self):
        for value in (b"", b"NRF7002DK", b"nrf7002dk\0", b"nrf-7002", b"a" * 17, b"\xff"):
            with self.subTest(value=value):
                image = signed(protected=((0xA1, value),))
                self.assertEqual(check_image.check_board(image, None)[0][0], FAIL)
        # Twice, or outside the signed area.
        self.assertEqual(check_image.check_board(
            signed(protected=((0xA1, b"nrf7002dk"), (0xA1, b"nrf5340dk"), (0xA2, b"1"))), None)[0][0], FAIL)
        self.assertEqual(check_image.check_board(
            signed(protected=(), unprotected=((0xA1, b"nrf7002dk"),)), None)[0][0], FAIL)
        # Well formed, and a type the console does not know.
        unknown = signed(protected=((0xA1, b"nrf9160dk"), (0xA2, b"1")))
        status, _, detail = check_image.check_board(unknown, None)[0]
        self.assertEqual(status, FAIL)
        self.assertIn("nrf9160dk", detail)

    def test_the_build_record_must_say_the_same_board(self):
        image = signed()
        self.assertEqual(check_image.check_board(image, {"board": "nrf7002dk"})[0][0], PASS)
        self.assertEqual(check_image.check_board(image, {"board": "nrf5340dk"})[0][0], FAIL)
        old = signed(version=(1, 12, 0, 0), protected=())
        self.assertEqual(check_image.check_board(old, {"board": "nrf7002dk"})[0][0], PASS)
        self.assertEqual(check_image.check_board(old, {"board": "nrf5340dk"})[0][0], FAIL)

    def test_board_and_layout_on_the_command_line(self):
        with tempfile.TemporaryDirectory() as folder:
            for name, image, option, status, out in (
                    ("new.bin", signed(), "--board", 0, "nrf7002dk\n"),
                    ("new.bin", signed(), "--layout", 0, "1\n"),
                    ("two.bin", signed(protected=((0xA1, b"nrf7002dk"), (0xA2, b"12"))), "--layout", 0, "12\n"),
                    ("old.bin", signed(version=(1, 12, 0, 0), protected=()), "--board", 1, ""),
                    ("old.bin", signed(version=(1, 12, 0, 0), protected=()), "--layout", 1, ""),
                    ("bad.bin", signed(digest=bytes(32)), "--board", 1, ""),
                    ("bad.bin", signed(digest=bytes(32)), "--layout", 1, "")):
                path = Path(folder) / name
                path.write_bytes(image)
                command = [sys.executable, "-I", str(REPO / "tools/check_image.py"), option, str(path)]
                ran = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
                self.assertEqual((ran.returncode, ran.stdout), (status, out), f"{name} {option}")


class LayoutTest(unittest.TestCase):
    def layouts(self, folder, content):
        path = Path(folder) / "flash_layouts.json"
        path.write_text(json.dumps(content))
        return path

    def test_the_layout_is_read_from_the_protected_area(self):
        with tempfile.TemporaryDirectory() as folder:
            known = self.layouts(folder, {"_": "x", "nrf7002dk": {"1": {}, "2": {}}})
            self.assertEqual(check_image.layout_of(signed()), 1)
            status, title, detail = check_image.check_layout(signed(), None, known)[0]
            self.assertEqual((status, title), (PASS, "Layout"))
            self.assertIn("0xa2", detail)
            two = signed(protected=((0xA2, b"2"), (0xA1, b"nrf7002dk")))
            self.assertEqual(check_image.check_layout(two, None, known)[0][0], PASS)

    def test_an_image_before_1_13_0_is_for_layout_1(self):
        with tempfile.TemporaryDirectory() as folder:
            known = self.layouts(folder, {"nrf7002dk": {"1": {}}})
            old = signed(version=(1, 12, 0, 0), protected=())
            self.assertIsNone(check_image.layout_of(old))
            status, _, detail = check_image.check_layout(old, None, known)[0]
            self.assertEqual(status, PASS)
            self.assertIn("1", detail)

    def test_an_image_from_1_13_0_without_one_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            known = self.layouts(folder, {"nrf7002dk": {"1": {}}})
            image = signed(protected=((0xA1, b"nrf7002dk"),))
            self.assertEqual(check_image.check_layout(image, None, known)[0][0], FAIL)

    def test_a_layout_its_board_type_does_not_have_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            known = self.layouts(folder, {"nrf7002dk": {"1": {}}})
            status, _, detail = check_image.check_layout(
                signed(protected=((0xA1, b"nrf7002dk"), (0xA2, b"3"))), None, known)[0]
            self.assertEqual(status, FAIL)
            self.assertIn("3", detail)
            # The type decides which layouts there are: none yet for the nRF5340 DK.
            self.assertEqual(check_image.check_layout(
                signed(protected=((0xA1, b"nrf5340dk"), (0xA2, b"1"))), None, known)[0][0], FAIL)
            # Without the file, the number is only read.
            missing = Path(folder) / "none.json"
            self.assertEqual(check_image.check_layout(
                signed(protected=((0xA1, b"nrf7002dk"), (0xA2, b"3"))), None, missing)[0][0], PASS)

    def test_what_cannot_be_a_layout_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            known = self.layouts(folder, {"nrf7002dk": {"1": {}}})
            for value in (b"", b"0", b"01", b"-1", b"1.0", b"abc", b"1234567890", b"1 "):
                with self.subTest(value=value):
                    image = signed(protected=((0xA1, b"nrf7002dk"), (0xA2, value)))
                    self.assertEqual(check_image.check_layout(image, None, known)[0][0], FAIL)
            for image in (signed(protected=((0xA1, b"nrf7002dk"), (0xA2, b"1"), (0xA2, b"1"))),
                          signed(protected=((0xA1, b"nrf7002dk"),), unprotected=((0xA2, b"1"),))):
                self.assertEqual(check_image.check_layout(image, None, known)[0][0], FAIL)

    def test_the_build_record_must_say_the_same_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            known = self.layouts(folder, {"nrf7002dk": {"1": {}, "2": {}}})
            self.assertEqual(check_image.check_layout(signed(), {"layout": 1}, known)[0][0], PASS)
            self.assertEqual(check_image.check_layout(signed(), {"layout": 2}, known)[0][0], FAIL)

    def test_the_committed_layouts_file_has_this_board(self):
        self.assertEqual(check_image.known_layouts("nrf7002dk"), [1])


def imgtool():
    """The SDK's imgtool, if it is there and this Python can run it."""
    zephyr = Path(os.environ.get("ZEPHYR_BASE", "/opt/nordic/ncs/v3.4.0/zephyr"))
    script = zephyr.parent / "bootloader/mcuboot/scripts/imgtool.py"
    if not script.exists():
        return None
    try:
        ran = subprocess.run([sys.executable, str(script), "version"], capture_output=True, timeout=60,
                             check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return script if ran.returncode == 0 else None


IMGTOOL = imgtool()


@unittest.skipIf(IMGTOOL is None, "the SDK's imgtool, or what it needs, is not here")
class ImgtoolTest(unittest.TestCase):
    """What imgtool --custom-tlv 0xa1 makes, as the build signs with it (firmware/app/Kconfig)."""

    def test_imgtool_puts_the_board_type_in_the_protected_area(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            key, body, out = work / "key.pem", work / "body.bin", work / "signed.bin"
            body.write_bytes(os.urandom(1024))
            subprocess.run([sys.executable, str(IMGTOOL), "keygen", "-k", str(key), "-t", "ecdsa-p256"],
                           check=True, capture_output=True, timeout=60)
            # The arguments the build gives it (build/app/build.ninja), with the TLV from app/Kconfig.
            subprocess.run([sys.executable, str(IMGTOOL), "sign", "--version", "1.13.0+0", "--slot-size",
                            "0xe4000", "--header-size", "0x200", "--pad-header", "--align", "4", "--rom-fixed",
                            "0x30000", "-k", str(key), "--custom-tlv", "0xa1", "nrf7002dk",
                            "--custom-tlv", "0xa2", "1", str(body), str(out)],
                           check=True, capture_output=True, timeout=60)
            data = out.read_bytes()
            protected, _ = check_image.tlv_areas(data)
            self.assertEqual(sorted(protected), [(0xA1, b"nrf7002dk"), (0xA2, b"1")])
            self.assertEqual(check_image.board_of(data), "nrf7002dk")
            self.assertEqual(check_image.layout_of(data), 1)
            self.assertEqual(check_image.check_board(data, None)[0][0], PASS)
            self.assertEqual(check_image.check_layout(data, None)[0][0], PASS)
            # And what the board reads of it, the same: tests/host/test_image_compat.c builds such
            # images by hand, so this ties those to imgtool's.
            self.assertEqual(int.from_bytes(data[10:12], "little"), 4 + 4 + 9 + 4 + 1)


class FindRecordTest(unittest.TestCase):
    def test_the_record_next_to_the_image_comes_first_and_must_match(self):
        data = image()
        with tempfile.TemporaryDirectory() as folder:
            binaries = Path(folder)
            path = binaries / "cranium-1.9.0-0.signed.bin"
            path.write_bytes(data)
            (binaries / "cranium-1.9.0-0.json").write_text(json.dumps(record_for(data)))
            found, record = check_image.find_record(path, data, binaries)
            self.assertEqual(found.name, "cranium-1.9.0-0.json")
            self.assertEqual(record["commit"], "41f9a30")

            # A record of other bytes is not this image's.
            (binaries / "cranium-1.9.0-0.json").write_text(json.dumps(record_for(image(size=2048))))
            self.assertEqual(check_image.find_record(path, data, binaries), (None, None))

    def test_latest_json_counts_when_it_is_these_bytes(self):
        data = image()
        with tempfile.TemporaryDirectory() as folder:
            binaries = Path(folder)
            elsewhere = binaries / "copy.bin"
            elsewhere.write_bytes(data)
            (binaries / "latest.json").write_text(json.dumps(record_for(data)))
            self.assertEqual(check_image.find_record(elsewhere, data, binaries)[0].name, "latest.json")


class CiTest(unittest.TestCase):
    COMMIT = "a" * 40
    LATER = "b" * 40

    def verdict(self, runs, ancestor=True, same=True):
        return check_image.ci_verdict(self.COMMIT, runs, lambda a, b: ancestor, lambda a, b: same)

    def run_of(self, sha, conclusion, status="completed"):
        return {"headSha": sha, "status": status, "conclusion": conclusion, "databaseId": 7}

    def test_a_passing_run_on_the_commit_passes(self):
        self.assertEqual(self.verdict([self.run_of(self.COMMIT, "success")])[0], PASS)

    def test_a_failing_run_on_the_commit_fails(self):
        self.assertEqual(self.verdict([self.run_of(self.COMMIT, "failure")])[0], FAIL)

    def test_a_cancelled_run_is_covered_by_a_later_one_with_the_same_firmware(self):
        runs = [self.run_of(self.LATER, "success"), self.run_of(self.COMMIT, "cancelled")]
        status, detail = self.verdict(runs)
        self.assertEqual(status, PASS)
        self.assertIn("bbbbbbb", detail)

    def test_a_later_run_does_not_count_if_the_firmware_changed_or_it_is_elsewhere(self):
        runs = [self.run_of(self.LATER, "success"), self.run_of(self.COMMIT, "cancelled")]
        self.assertEqual(self.verdict(runs, same=False)[0], FAIL)
        self.assertEqual(self.verdict(runs, ancestor=False)[0], FAIL)

    def test_a_run_still_going_is_a_warning(self):
        self.assertEqual(self.verdict([self.run_of(self.COMMIT, "", status="in_progress")])[0], WARN)

    def test_no_run_at_all_fails(self):
        self.assertEqual(self.verdict([])[0], FAIL)


class ConsoleTest(unittest.TestCase):
    def test_newer_than_every_release_passes_and_anything_else_fails(self):
        releases = [{"version": "1.8.0+0"}, {"version": "1.9.0+0"}, {"version": "garbage"}]
        self.assertEqual(check_image.newer_than_releases((1, 9, 1, 0), releases)[0], PASS)
        self.assertEqual(check_image.newer_than_releases((1, 9, 0, 0), releases)[0], FAIL)
        self.assertEqual(check_image.newer_than_releases((1, 8, 5, 0), releases)[0], FAIL)
        self.assertEqual(check_image.newer_than_releases((1, 0, 0, 0), [])[0], PASS)

    def test_a_token_file_others_can_read_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            token = Path(folder) / "console-token"
            token.write_text("crn_x\n")
            with mock.patch.object(check_image, "TOKEN_FILE", token), mock.patch.dict(os.environ, {}, clear=True):
                os.chmod(token, 0o644)
                with self.assertRaises(PermissionError):
                    check_image.console_token()
                os.chmod(token, 0o600)
                self.assertEqual(check_image.console_token(), "crn_x")

    def test_without_a_token_the_check_is_skipped_not_failed(self):
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(check_image, "TOKEN_FILE", Path(folder) / "none"), \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(check_image.check_console((1, 9, 0, 0))[0][0], SKIP)


if __name__ == "__main__":
    unittest.main()
