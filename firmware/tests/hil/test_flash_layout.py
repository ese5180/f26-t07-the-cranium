#!/usr/bin/env python3
"""Tests of firmware/app/flash_layout.py, the check that a build's flash layout number is the one of
its partitions, and of firmware/app/flash_layouts.json, which holds those. The devicetree library is
the SDK's (ZEPHYR_BASE): without it, the tests that read a devicetree are skipped."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ZEPHYR_BASE = Path(os.environ.get("ZEPHYR_BASE", "/opt/nordic/ncs/v3.4.0/zephyr"))
LAYOUTS = REPO / "firmware/app/flash_layouts.json"

spec = importlib.util.spec_from_file_location("flash_layout", REPO / "firmware/app/flash_layout.py")
flash_layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flash_layout)

HAVE_DTLIB = (ZEPHYR_BASE / "scripts/dts/python-devicetree/src/devicetree/dtlib.py").exists()

APP = """/dts-v1/;
/ {
	chosen { zephyr,code-partition = &slot0_ns_partition; };
	soc {
		flash-controller@39000 {
			flash0: flash@0 {
				partitions {
					compatible = "fixed-partitions";
					#address-cells = <1>;
					#size-cells = <1>;
					boot_partition: partition@0 { reg = <0x0 0x10000>; };
					slot0_partition: partition@10000 {
						reg = <0x10000 0xe4000>;
						#address-cells = <1>;
						#size-cells = <1>;
						slot0_ns_partition: partition@20000 { reg = <0x20000 0xc4000>; };
					};
				};
			};
		};
		spi@a000 {
			mx25r64: mx25r6435f@0 {
				partitions {
					compatible = "fixed-partitions";
					#address-cells = <1>;
					#size-cells = <1>;
					slot1_partition: partition@0 { reg = <0x0 0xe4000>; };
				};
			};
		};
	};
};
"""


def write(folder, name, text):
    path = Path(folder) / name
    path.write_text(text)
    return path


class CheckTest(unittest.TestCase):
    LINES = ["app flash0 boot_partition 0x0 0x10000", "app mx25r64 slot1_partition 0x0 0xe4000"]

    def known(self, lines=None):
        lines = self.LINES if lines is None else lines
        return {"nrf7002dk": {"1": {"sha256": flash_layout.digest(lines), "partitions": lines}}}

    def test_the_same_partitions_pass(self):
        self.assertEqual(flash_layout.check(self.LINES, "nrf7002dk", "1", self.known()), [])

    def test_a_change_without_a_new_number_fails_and_says_what_changed(self):
        changed = ["app flash0 boot_partition 0x0 0x20000", "app mx25r64 slot1_partition 0x0 0xe4000"]
        problems = flash_layout.check(changed, "nrf7002dk", "1", self.known())
        text = "\n".join(problems)
        self.assertIn("has changed", text)
        self.assertIn("was: app flash0 boot_partition 0x0 0x10000", text)
        self.assertIn("now: app flash0 boot_partition 0x0 0x20000", text)
        self.assertIn(flash_layout.digest(changed), text)
        # A partition more, or one fewer, is a change too.
        self.assertTrue(flash_layout.check(self.LINES + ["mcuboot mx25r64 golden 0x700000 0xe4000"],
                                           "nrf7002dk", "1", self.known()))
        self.assertTrue(flash_layout.check(self.LINES[:1], "nrf7002dk", "1", self.known()))

    def test_a_number_or_a_board_that_is_not_there_fails(self):
        self.assertIn("no flash layout 2", flash_layout.check(self.LINES, "nrf7002dk", "2", self.known())[0])
        self.assertIn("no flash layout 1", flash_layout.check(self.LINES, "nrf5340dk", "1", self.known())[0])

    def test_a_layouts_file_that_does_not_hold_together_fails(self):
        broken = self.known()
        broken["nrf7002dk"]["1"]["partitions"] = self.LINES[:1]
        self.assertIn("does not hold together", flash_layout.check(self.LINES, "nrf7002dk", "1", broken)[0])

    def test_the_committed_layouts_hold_together(self):
        layouts = json.loads(LAYOUTS.read_text())
        self.assertIn("1", layouts["nrf7002dk"])
        for board, numbers in layouts.items():
            if board == "_":
                continue
            for number, layout in numbers.items():
                self.assertTrue(number.isdigit() and not number.startswith("0"), number)
                self.assertEqual(flash_layout.digest(layout["partitions"]), layout["sha256"], f"{board} {number}")
                self.assertEqual(layout["partitions"], sorted(layout["partitions"]))

    def test_the_kconfig_number_has_its_layout(self):
        kconfig = (REPO / "firmware/app/Kconfig").read_text()
        self.assertIn("CRANIUM_NRF7002DK_LAYOUT := 1", kconfig)
        self.assertIn("--custom-tlv $(CRANIUM_LAYOUT_TLV) $(CRANIUM_NRF7002DK_LAYOUT)", kconfig)


@unittest.skipUnless(HAVE_DTLIB, "the SDK's devicetree library is not here")
class DevicetreeTest(unittest.TestCase):
    def describe(self, *pairs):
        return flash_layout.describe([f"{image}={path}" for image, path in pairs], ZEPHYR_BASE)

    def test_every_partition_is_a_line_and_nothing_else_is(self):
        with tempfile.TemporaryDirectory() as folder:
            lines = self.describe(("app", write(folder, "app.dts", APP)))
        self.assertEqual(lines, [
            "app code slot0_ns_partition",
            "app flash0 boot_partition 0x0 0x10000",
            "app flash0 slot0_partition 0x10000 0xe4000",
            "app flash0 slot0_partition/slot0_ns_partition 0x20000 0xc4000",
            "app mx25r64 slot1_partition 0x0 0xe4000",
        ])

    def test_what_does_not_place_a_partition_changes_nothing(self):
        moved = APP.replace("\t\t\t\t\tboot_partition: partition@0 { reg = <0x0 0x10000>; };\n", "")
        moved = moved.replace("slot1_partition: partition@0 { reg = <0x0 0xe4000>; };",
                              "slot1_partition: partition@0 { reg = <0x0 0xe4000>; label = \"x\"; };\n"
                              "\t\t\t\t\t/* a comment */")
        moved = moved.replace("\t\t\t\t\tslot0_partition:",
                              "\t\t\t\t\tboot_partition: partition@0 { reg = <0x0 0x10000>; };\n"
                              "\t\t\t\t\tslot0_partition:")
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(self.describe(("app", write(folder, "a.dts", APP))),
                             self.describe(("app", write(folder, "b.dts", moved))))

    def test_a_size_an_offset_a_label_or_the_code_partition_is_a_change(self):
        changes = [APP.replace("0x10000 0xe4000", "0x10000 0xe3000"),
                   APP.replace("partition@20000 { reg = <0x20000", "partition@20000 { reg = <0x21000"),
                   APP.replace("slot1_partition:", "slot2_partition:"),
                   APP.replace("code-partition = &slot0_ns_partition", "code-partition = &boot_partition")]
        with tempfile.TemporaryDirectory() as folder:
            base = flash_layout.digest(self.describe(("app", write(folder, "a.dts", APP))))
            for i, text in enumerate(changes):
                self.assertNotEqual(flash_layout.digest(self.describe(("app", write(folder, f"{i}.dts", text)))),
                                    base, i)

    def test_the_last_build_is_layout_1(self):
        app = REPO / "build/app/zephyr/zephyr.dts"
        mcuboot = REPO / "build/mcuboot/zephyr/zephyr.dts"
        if not app.exists() or not mcuboot.exists():
            self.skipTest("no build in this checkout")
        lines = self.describe(("app", app), ("mcuboot", mcuboot))
        layouts = json.loads(LAYOUTS.read_text())
        self.assertEqual(flash_layout.check(lines, "nrf7002dk", "1", layouts), [])
        self.assertIn("mcuboot mx25r64 golden_partition 0x700000 0xe4000", lines)


if __name__ == "__main__":
    unittest.main()
