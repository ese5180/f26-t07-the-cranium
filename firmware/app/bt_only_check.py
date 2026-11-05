#!/usr/bin/env python3
"""Check that an image for a board with Bluetooth only has nothing of the cloud in it.

    bt_only_check.py --nm <nm> --elf zephyr.elf --bin zephyr.bin

CMakeLists.txt runs it after every link of such an image (CONFIG_APP_BT_ONLY), and the build fails if
it finds anything: no function of the heartbeat, the device shadow, the jobs, the events, MQTT, AWS IoT,
the downloader, Wi-Fi or the network stack in the symbol table, and none of the shadow's JSON or of the
AWS IoT topics in the bytes that are flashed. The stubs in src/bt_only_stubs.c answer questions about
Wi-Fi and the cloud, and they are allowed: they send nothing.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Defined functions and objects that only the cloud's code has.
FORBIDDEN_SYMBOLS = [
    r"cloud_shadow_report", r"cloud_event_publish", r"cloud_jobs_\w+", r"cloud_job_message_\w+",
    r"cloud_init", r"cloud_connect", r"cloud_events_\w+",
    r"publish_report", r"publish_diag", r"report_changes", r"boot_diary_report", r"report_pairing",
    r"diag_collect", r"diag_format", r"ota_job_parse", r"ota_on_job_message",
    r"aws_iot_\w+", r"mqtt_\w+", r"fota_download\w*", r"downloader_\w+", r"cJSON_\w+",
    r"net_if_\w+", r"net_mgmt_\w+", r"zsock_\w+", r"wifi_\w+", r"wpa_\w+", r"nrf_wifi_\w+",
    r"tls_credential_\w+",
]

# Text that only the cloud's code puts in an image.
FORBIDDEN_TEXT = [
    b'{"fw":{"version"',  # the heartbeat
    b'{"diag":{',  # the diagnostics report
    b'{"diary":',  # the boot diary in the shadow
    b'"btpair"',  # the passkey in the shadow
    b"$aws/things/",  # the jobs and shadow topics
    b"/events",  # cranium/<thing>/events
    b"/shadow/update",
]

SYMBOL = re.compile(r"^[0-9a-fA-F]+\s+[A-Za-z]\s+(\S+)$")


def defined_symbols(nm: str, elf: Path) -> list[str]:
    listing = subprocess.run([nm, "--defined-only", str(elf)], capture_output=True, text=True, check=True)
    names = []
    for line in listing.stdout.splitlines():
        found = SYMBOL.match(line.strip())
        if found:
            # LTO and static functions can carry a suffix, as in publish_report.lto_priv.0.
            names.append(found.group(1).split(".")[0])
    return names


def problems(symbols: list[str], image: bytes) -> list[str]:
    found = []
    pattern = re.compile("^(?:" + "|".join(FORBIDDEN_SYMBOLS) + ")$")
    for name in sorted(set(symbols)):
        if pattern.match(name):
            found.append(f"symbol {name}")
    for text in FORBIDDEN_TEXT:
        if text in image:
            found.append(f"text {text.decode()}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--nm", required=True)
    parser.add_argument("--elf", required=True, type=Path)
    parser.add_argument("--bin", required=True, type=Path)
    args = parser.parse_args()

    found = problems(defined_symbols(args.nm, args.elf), args.bin.read_bytes())
    if found:
        print("bt_only_check: this image has Bluetooth only, and yet it has the cloud's code in it:",
              file=sys.stderr)
        for item in found:
            print(f"  {item}", file=sys.stderr)
        return 1
    print("bt_only_check: nothing of the cloud in this image")
    return 0


if __name__ == "__main__":
    sys.exit(main())
