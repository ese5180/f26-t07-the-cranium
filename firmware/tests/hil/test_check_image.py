#!/usr/bin/env python3
"""Tests of tools/check_image.py: what it decides from an image, its record, CI's runs and the
console's releases. The calls to git, gh, node and the console are thin and are not run here."""

import hashlib
import json
import os
import struct
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
