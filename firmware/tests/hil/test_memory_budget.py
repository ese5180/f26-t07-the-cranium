#!/usr/bin/env python3
"""Tests of tools/memory_budget.py, which every firmware job on GitHub Actions runs. No board, no build.

    python3 firmware/tests/hil/test_memory_budget.py

Made-up sysbuild build folders stand in for real ones, with the ELF and map files of
test_build_report.py: an application, MCUboot, TF-M and a network core image.
"""

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TOOL = REPO / "tools" / "memory_budget.py"
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import memory_budget  # noqa: E402
from test_build_report import make_elf, make_map  # noqa: E402

FLASH = 0x10000
RAM = 0x20000000


def image(flash_used: int, flash_total: int, ram_used: int, ram_total: int):
    """An ELF file's segments and a map file's regions for an image that uses this much of each."""
    segments = [(FLASH, FLASH, flash_used, flash_used), (RAM, RAM, 0, ram_used)]
    return make_elf(segments), make_map({"FLASH": (FLASH, flash_total), "RAM": (RAM, ram_total)})


# What 1.18.0's default build had (tools/memory_budgets.json, "_measured").
DEFAULT = {
    "app/zephyr/zephyr": image(749176, 794474, 404404, 405504),
    "mcuboot/zephyr/zephyr": image(50324, 65536, 22408, 458752),
    "app/tfm/bin/tfm_s": image(130008, 130560, 36620, 49152),
    "hci_ipc/zephyr/zephyr": image(150000, 262144, 40000, 65536),
}

FLOORS = {
    "default": {
        "_measured": "a note, which is not an image",
        "app": {"flash_free_min": 40960, "ram_free_min": 1000},
        "mcuboot": {"flash_free_min": 14336},
        "tfm": {"flash_free_min": 500, "ram_free_min": 12288},
    }
}


class Build(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.build = self.root / "build"
        self.budgets = self.root / "budgets.json"
        self.write_budgets(FLOORS)

    def write_build(self, images):
        for stem, (elf, map_text) in images.items():
            path = self.build / stem
            path.parent.mkdir(parents=True, exist_ok=True)
            path.with_suffix(".elf").write_bytes(elf)
            path.with_suffix(".map").write_text(map_text)
        # A folder of the build that is no image.
        (self.build / "_sysbuild").mkdir(parents=True, exist_ok=True)

    def write_budgets(self, budgets):
        self.budgets.write_text(json.dumps(budgets))

    def run_tool(self, configuration="default"):
        summary, numbers = self.root / "summary.md", self.root / "out" / "memory.json"
        result = subprocess.run(
            [sys.executable, "-I", str(TOOL), "--build", str(self.build), "--configuration", configuration,
             "--budgets", str(self.budgets), "--summary", str(summary), "--json", str(numbers)],
            capture_output=True, text=True)
        return result, summary, numbers


class Report(Build):
    def test_a_build_within_its_floors_is_reported_image_by_image_and_passes(self):
        self.write_build(DEFAULT)
        result, summary, numbers = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = summary.read_text()
        self.assertIn("## Memory headroom, default", text)
        # The application first, then TF-M, then the other images by their folders' names.
        rows = [line.split("|")[1].strip() for line in text.splitlines() if re.match(r"\| [a-z_]+ \|", line)]
        self.assertEqual(rows, ["app", "tfm", "hci_ipc", "mcuboot"])
        self.assertIn("| app | 749176 | 794474 | 45298 | 40960 | 404404 | 405504 | 1100 | 1000 |", text)
        self.assertIn("| mcuboot | 50324 | 65536 | 15212 | 14336 | 22408 | 458752 | 436344 | — |", text)
        # An image with no floor is reported all the same.
        self.assertIn("| hci_ipc | 150000 | 262144 | 112144 | — | 40000 | 65536 | 25536 | — |", text)
        data = json.loads(numbers.read_text())
        self.assertEqual(data["configuration"], "default")
        self.assertEqual(data["problems"], [])
        app = data["images"][0]
        self.assertEqual(app, {"image": "app", "flash": {"used": 749176, "total": 794474, "free": 45298},
                               "ram": {"used": 404404, "total": 405504, "free": 1100},
                               "floors": {"flash_free_min": 40960, "ram_free_min": 1000}})
        self.assertNotIn("::error::", result.stdout)

    def test_ram_under_its_floor_fails_with_a_line_that_says_which_image_how_much_and_where_the_floor_is(self):
        self.write_build({**DEFAULT, "app/zephyr/zephyr": image(749176, 794474, 404600, 405504)})
        result, summary, numbers = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error::default: app has 904 bytes of RAM free, under its floor of 1000 "
                      "(tools/memory_budgets.json).", result.stdout)
        self.assertEqual(result.stdout.count("::error::"), 1)
        self.assertIn("**default: app has 904 bytes of RAM free", summary.read_text())
        self.assertEqual(len(json.loads(numbers.read_text())["problems"]), 1)

    def test_flash_under_its_floor_fails_too(self):
        self.write_build({**DEFAULT, "app/tfm/bin/tfm_s": image(130100, 130560, 36620, 49152)})
        result, _, _ = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error::default: tfm has 460 bytes of flash free, under its floor of 500", result.stdout)

    def test_an_image_over_its_region_fails_even_with_no_floor(self):
        self.write_build({**DEFAULT, "hci_ipc/zephyr/zephyr": image(150000, 262144, 70000, 65536)})
        result, _, _ = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error::default: hci_ipc uses 4464 bytes of RAM more than its region of 65536 holds",
                      result.stdout)

    def test_a_floor_for_an_image_the_build_does_not_have_fails(self):
        self.write_build({key: value for key, value in DEFAULT.items() if not key.startswith("mcuboot")})
        result, _, _ = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertIn('the build has no image "mcuboot"', result.stdout)

    def test_a_configuration_with_no_floors_fails_before_anything_is_read(self):
        self.write_build(DEFAULT)
        result, summary, _ = self.run_tool("new board")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('has no floors for the configuration "new board"', result.stdout)
        self.assertFalse(summary.exists())

    def test_floors_that_are_not_whole_numbers_of_bytes_are_refused(self):
        self.write_build(DEFAULT)
        for bad in ({"flash_free_min": "40 KiB"}, {"flash_free_min": -1}, {"flash_free_min": True},
                    {"stack_free_min": 10}, {}):
            with self.subTest(bad=bad):
                self.write_budgets({"default": {"app": bad}})
                result, _, _ = self.run_tool()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('"default" / "app" must give', result.stdout)

    def test_a_folder_that_is_not_a_sysbuild_build_is_refused(self):
        self.build.mkdir()
        result, _, _ = self.run_tool()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is it a sysbuild build folder?", result.stdout)


class TheProjectsFloors(unittest.TestCase):
    def test_every_configuration_of_the_firmware_job_has_floors_that_read(self):
        workflow = (REPO / ".github" / "workflows" / "ci.yml").read_text()
        job = workflow.split("\n  firmware:\n", 1)[1].split("\n  # A release of firmware", 1)[0]
        configurations = re.findall(r"^ +- configuration: (.+)$", job, re.MULTILINE)
        self.assertGreaterEqual(len(configurations), 3)
        for configuration in configurations:
            with self.subTest(configuration=configuration):
                floors = memory_budget.load_budgets(memory_budget.DEFAULT_BUDGETS, configuration)
                self.assertIn("app", floors)
        # And the job runs the check for every one of them, before anything else is reported.
        self.assertIn("python3 -I tools/memory_budget.py --build build --configuration", job)
        self.assertLess(job.index("tools/memory_budget.py"), job.index("tools/build_report.py"))

    def test_every_floor_is_for_a_configuration_of_the_matrix_or_one_on_its_way(self):
        # Configurations of the firmware job on open pull requests, by their names in those PRs' ci.yml,
        # so that their first run finds floors. Once such a job is on main it is in the matrix as well,
        # and this still passes; take its name out of here then.
        coming = {"Pi image updates"}  # #165, the Raspberry Pi work
        workflow = (REPO / ".github" / "workflows" / "ci.yml").read_text()
        job = workflow.split("\n  firmware:\n", 1)[1].split("\n  # A release of firmware", 1)[0]
        in_matrix = set(re.findall(r"^ +- configuration: (.+)$", job, re.MULTILINE))
        keys = {key for key in json.loads(memory_budget.DEFAULT_BUDGETS.read_text()) if not key.startswith("_")}
        self.assertEqual(keys - in_matrix - coming, set(), "floors for a configuration no job has")
        for configuration in in_matrix | coming:
            with self.subTest(configuration=configuration):
                self.assertIn("app", memory_budget.load_budgets(memory_budget.DEFAULT_BUDGETS, configuration))

    def test_the_nrf7002_dk_keeps_the_floors_it_was_given(self):
        floors = memory_budget.load_budgets(memory_budget.DEFAULT_BUDGETS, "default")
        self.assertGreaterEqual(floors["app"]["ram_free_min"], 1000)
        self.assertGreaterEqual(floors["app"]["flash_free_min"], 40 * 1024)
        self.assertGreaterEqual(floors["tfm"]["flash_free_min"], 500)


if __name__ == "__main__":
    unittest.main()
