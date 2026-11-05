#!/usr/bin/env python3
"""Tests of tools/memfault_upload.py, which scripts/build.sh runs after a build. No board, no build,
no Memfault account.

    python3 firmware/tests/hil/test_memfault_upload.py

A made-up build folder stands in for a real one, a made-up home folder for ~/.cranium, and a fake
`memfault` command on the PATH writes down how it was called: its arguments, and the organization,
project and token it got in its environment. It also prints the token, as a careless command might.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOL = REPO / "tools" / "memfault_upload.py"
TOKEN = "oat_0123456789abcdefFAKEFAKE"

CONFIG = """CONFIG_MEMFAULT=y
CONFIG_APP_MEMFAULT=y
CONFIG_MEMFAULT_NCS_FW_VERSION="1.14.0+0"
CONFIG_MEMFAULT_NCS_HW_VERSION="nrf7002dk"
CONFIG_MEMFAULT_NCS_FW_TYPE="app"
CONFIG_APP_TEST_FAULT_NONE=y
"""

FAKE_CLI = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "org": os.environ.get("MEMFAULT_ORG"),
                          "project": os.environ.get("MEMFAULT_PROJECT"),
                          "token": os.environ.get("MEMFAULT_ORG_TOKEN")}) + "\\n")
print("using token " + os.environ.get("MEMFAULT_ORG_TOKEN", ""))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
"""


def image(version=(1, 14, 0, 0)) -> bytes:
    """An MCUboot header with this version, and a body."""
    major, minor, revision, build = version
    header = (0x96F3B83D).to_bytes(4, "little") + bytes(16) + bytes([major, minor])
    header += revision.to_bytes(2, "little") + build.to_bytes(4, "little") + bytes(4)
    return header + b"\x41" * 64


class MemfaultUpload(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        root = Path(self.work.name)
        self.build = root / "build"
        zephyr = self.build / "app" / "zephyr"
        zephyr.mkdir(parents=True)
        (zephyr / "zephyr.elf").write_bytes(b"\x7fELF fake")
        (zephyr / "zephyr.signed.bin").write_bytes(image())
        (zephyr / ".config").write_text(CONFIG)
        self.config = zephyr / ".config"
        self.home = root / "home"
        (self.home / ".cranium").mkdir(parents=True)
        self.bin = root / "bin"
        self.bin.mkdir()
        cli = self.bin / "memfault"
        cli.write_text(FAKE_CLI)
        cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
        self.log = root / "calls.jsonl"

    def tearDown(self):
        self.work.cleanup()

    def give_token(self):
        (self.home / ".cranium" / "memfault_org_token").write_text(TOKEN + "\n")

    def give_slugs(self, org="cranium-team", project="cranium-boards"):
        (self.home / ".cranium" / "memfault.json").write_text(json.dumps({"org": org, "project": project}))

    def run_tool(self, *extra, env=None, cli=True):
        environment = {"HOME": str(self.home), "FAKE_LOG": str(self.log),
                       "PATH": (f"{self.bin}{os.pathsep}" if cli else "") + "/usr/bin:/bin"}
        environment.update(env or {})
        return subprocess.run([sys.executable, "-I", str(TOOL), "--build", str(self.build), *extra],
                              env=environment, capture_output=True, text=True)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_without_a_token_or_the_slugs_nothing_happens_and_that_is_no_error(self):
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing was uploaded", result.stdout)
        self.give_token()
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing was uploaded", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_symbols_then_the_release_with_the_token_only_in_the_environment(self):
        self.give_token()
        self.give_slugs()
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["argv"], ["upload-mcu-symbols", str(self.build / "app/zephyr/zephyr.elf")])
        self.assertEqual(calls[1]["argv"], ["upload-ota-payload", "--hardware-version", "nrf7002dk",
                                            "--software-type", "app", "--software-version", "1.14.0+0",
                                            str(self.build / "app/zephyr/zephyr.signed.bin")])
        for call in calls:
            self.assertEqual((call["org"], call["project"], call["token"]),
                             ("cranium-team", "cranium-boards", TOKEN))
            self.assertNotIn(TOKEN, " ".join(call["argv"]))
        # The command printed the token: it is never shown.
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("using token ***", result.stdout)

    def test_the_environment_names_the_project_before_the_file(self):
        self.give_token()
        self.give_slugs()
        result = self.run_tool(env={"MEMFAULT_ORG": "other-org", "MEMFAULT_PROJECT": "other-project"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({(c["org"], c["project"]) for c in self.calls()}, {("other-org", "other-project")})

    def test_a_slug_that_is_not_one_is_refused(self):
        self.give_token()
        self.give_slugs(org="Cranium Team")
        result = self.run_tool()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a Memfault slug", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_test_image_and_symbols_only_get_no_release(self):
        self.give_token()
        self.give_slugs()
        self.config.write_text(CONFIG + "CONFIG_APP_CRASH_DEMO=y\n")
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c["argv"][0] for c in self.calls()], ["upload-mcu-symbols"])
        self.assertIn("a test image", result.stdout)

        self.log.unlink()
        self.config.write_text(CONFIG.replace("CONFIG_APP_TEST_FAULT_NONE=y", "CONFIG_APP_TEST_FAULT_HANG=y"))
        self.assertEqual(self.run_tool().returncode, 0)
        self.assertEqual([c["argv"][0] for c in self.calls()], ["upload-mcu-symbols"])

        self.log.unlink()
        self.config.write_text(CONFIG)
        self.assertEqual(self.run_tool("--symbols-only").returncode, 0)
        self.assertEqual([c["argv"][0] for c in self.calls()], ["upload-mcu-symbols"])

    def test_an_image_that_is_not_what_memfault_is_told_is_refused(self):
        self.give_token()
        self.give_slugs()
        (self.build / "app/zephyr/zephyr.signed.bin").write_bytes(image((1, 14, 1, 0)))
        result = self.run_tool()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("1.14.1+0", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_build_without_memfault_and_a_missing_command_are_skipped(self):
        self.give_token()
        self.give_slugs()
        result = self.run_tool(cli=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pip install memfault-cli", result.stdout)
        self.config.write_text("CONFIG_MEMFAULT=n\n")
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("has no Memfault", result.stdout)
        self.assertEqual(self.calls(), [])

    def test_a_failure_of_the_command_is_a_failure(self):
        self.give_token()
        self.give_slugs()
        result = self.run_tool(env={"FAKE_EXIT": "2"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("symbols were not uploaded", result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
