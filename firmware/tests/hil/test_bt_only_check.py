#!/usr/bin/env python3
"""Tests of firmware/app/bt_only_check.py, which looks at the linked image of a board with Bluetooth only.

It has to find what only the cloud's code puts in an image, by symbol and by text, and leave alone what
such a board has: the stubs of src/bt_only_stubs.c, which only answer questions, and the Bluetooth
update. No toolchain here: the symbol list is given as nm prints it.

    python3 firmware/tests/hil/test_bt_only_check.py
"""

import importlib.util
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("bt_only_check", REPO / "firmware/app/bt_only_check.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

ALLOWED = ["net_is_up", "net_status_get", "cloud_is_connected", "cloud_stats_get", "cloud_disconnect",
           "console_port_keygen_create", "bt_ota_on_tick", "bt_passkey_for_pairing", "main", "stuck_count",
           "boot_diary_object", "img_mgmt_reset_upload", "bt_enable"]


class ProblemsTest(unittest.TestCase):
    def test_what_such_a_board_has_passes(self):
        self.assertEqual(check.problems(ALLOWED, b"\x00[BT] passkey %06u\x00{\"thing\":\"%s\"\x00"), [])

    def test_the_clouds_functions_are_found(self):
        for name in ("cloud_shadow_report", "cloud_jobs_update", "cloud_event_publish", "publish_report",
                     "boot_diary_report", "report_pairing", "aws_iot_send", "mqtt_helper_connect",
                     "fota_download_start", "cJSON_Parse", "net_if_get_default", "wifi_credentials_get_by_ssid",
                     "zsock_socket", "diag_format", "cloud_events_add"):
            self.assertEqual(check.problems(ALLOWED + [name], b""), [f"symbol {name}"], name)

    def test_the_clouds_text_is_found(self):
        for text in (b'{"fw":{"version"', b'{"diag":{', b'{"diary":', b'"btpair"', b"$aws/things/",
                     b"/shadow/update"):
            self.assertEqual(check.problems(ALLOWED, b"\x00" + text + b"\x00"), [f"text {text.decode()}"])

    def test_nm_is_read_and_suffixes_are_dropped(self):
        listing = ("00012345 T main\n00012346 t publish_report.lto_priv.0\n         U cloud_shadow_report\n"
                   "00012347 D cloud_is_connected\n")
        answer = mock.Mock(stdout=listing)
        with mock.patch.object(check.subprocess, "run", return_value=answer) as run:
            names = check.defined_symbols("nm", Path("zephyr.elf"))
        self.assertEqual(run.call_args.args[0], ["nm", "--defined-only", "zephyr.elf"])
        self.assertEqual(names, ["main", "publish_report", "cloud_is_connected"])
        self.assertEqual(check.problems(names, b""), ["symbol publish_report"])


if __name__ == "__main__":
    unittest.main()
