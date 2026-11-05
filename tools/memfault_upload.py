#!/usr/bin/env python3
"""Give Memfault what it needs of a build: the ELF's symbols, and the signed image as a release.

    python3 -I tools/memfault_upload.py --build build              what scripts/build.sh runs
    python3 -I tools/memfault_upload.py --build build-bench/build-crash-demo --symbols-only

From firmware 1.14.0 (docs/memfault.md). Memfault turns a coredump into a backtrace only with the
symbols of the very build that crashed, which it finds by the ELF's GNU build ID: every image that
goes on a board needs its symbols uploaded, a demonstration image too. The signed image goes up as
an OTA payload of software type "app", for the board type as hardware version, so that Memfault's
releases list each version. That is a record only: boards are updated through AWS IoT, never from
Memfault. A build with a test fault, or the crash demonstration (CONFIG_APP_CRASH_DEMO), gets its
symbols and no release.

Nothing happens, and that is no error, unless all of these are there:

    ~/.cranium/memfault_org_token    an organization auth token, made in Memfault's settings
    the organization and project     MEMFAULT_ORG and MEMFAULT_PROJECT, or ~/.cranium/memfault.json:
                                     {"org": "<organization slug>", "project": "<project slug>"}
    the memfault command             pip install memfault-cli

The token goes to the memfault command in its environment, as MEMFAULT_ORG_TOKEN, never on its
command line, and it is never printed: a line of the command's output that holds it is shown with
the token replaced.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

MCUBOOT_MAGIC = 0x96F3B83D
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
DOCS = "docs/memfault.md"


def note(text: str) -> None:
    print(f"memfault_upload: {text}")


def image_version(path: Path) -> str:
    """The version in an MCUboot header, as MCUboot and the shadow write it: 1.14.0+0."""
    data = path.read_bytes()[:32]
    if len(data) < 32 or int.from_bytes(data[0:4], "little") != MCUBOOT_MAGIC:
        sys.exit(f"memfault_upload: {path} is not an MCUboot image")
    revision = int.from_bytes(data[22:24], "little")
    build = int.from_bytes(data[24:28], "little")
    return f"{data[20]}.{data[21]}.{revision}+{build}"


def kconfig(config: Path) -> dict:
    """The settings of a .config file, strings without their quotes."""
    values = {}
    for line in config.read_text().splitlines():
        found = re.fullmatch(r"(CONFIG_\w+)=(.*)", line)
        if found:
            value = found[2]
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            values[found[1]] = value
    return values


def read_token(home: Path) -> str | None:
    path = home / ".cranium" / "memfault_org_token"
    if not path.is_file():
        return None
    token = path.read_text().strip()
    return token or None


def read_slugs(home: Path) -> tuple[str | None, str | None]:
    """MEMFAULT_ORG and MEMFAULT_PROJECT, else ~/.cranium/memfault.json. Neither is a secret."""
    org, project = os.environ.get("MEMFAULT_ORG"), os.environ.get("MEMFAULT_PROJECT")
    path = home / ".cranium" / "memfault.json"
    if (org is None or project is None) and path.is_file():
        try:
            saved = json.loads(path.read_text())
        except json.JSONDecodeError:
            sys.exit(f"memfault_upload: {path} is not JSON: see {DOCS}")
        if not isinstance(saved, dict):
            sys.exit(f"memfault_upload: {path} is not a JSON object: see {DOCS}")
        org = org if org is not None else saved.get("org")
        project = project if project is not None else saved.get("project")
    for name, value in (("organization", org), ("project", project)):
        if value is not None and (not isinstance(value, str) or not SLUG.fullmatch(value)):
            sys.exit(f"memfault_upload: the {name} is not a Memfault slug (lower case, digits and -)")
    return org, project


def run(command: list[str], token: str, org: str, project: str) -> bool:
    environment = dict(os.environ, MEMFAULT_ORG_TOKEN=token, MEMFAULT_ORG=org, MEMFAULT_PROJECT=project)
    result = subprocess.run(command, env=environment, capture_output=True, text=True)
    for line in (result.stdout + result.stderr).splitlines():
        print(f"  {line.replace(token, '***')}")
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", required=True, type=Path, help="the sysbuild build directory")
    parser.add_argument("--symbols-only", action="store_true", help="upload the symbols and no release")
    args = parser.parse_args()

    home = Path(os.environ.get("HOME", "~")).expanduser()
    zephyr = args.build / "app" / "zephyr"
    elf, image, config = zephyr / "zephyr.elf", zephyr / "zephyr.signed.bin", zephyr / ".config"
    for path in (elf, image, config):
        if not path.is_file():
            sys.exit(f"memfault_upload: {path} is missing: build first")

    settings = kconfig(config)
    if settings.get("CONFIG_APP_MEMFAULT") != "y":
        note("this build has no Memfault (CONFIG_APP_MEMFAULT), so nothing goes to Memfault")
        return 0

    version = image_version(image)
    said = settings.get("CONFIG_MEMFAULT_NCS_FW_VERSION")
    if said != version:
        sys.exit(f"memfault_upload: the image is {version} and tells Memfault it is {said}: build it again")
    hardware = settings.get("CONFIG_MEMFAULT_NCS_HW_VERSION", "")
    software = settings.get("CONFIG_MEMFAULT_NCS_FW_TYPE", "")
    if not hardware or not software:
        sys.exit("memfault_upload: the build does not say its Memfault hardware version and software type")
    test_image = settings.get("CONFIG_APP_CRASH_DEMO") == "y" or any(
        name.startswith("CONFIG_APP_TEST_FAULT_") and name != "CONFIG_APP_TEST_FAULT_NONE" and value == "y"
        for name, value in settings.items())

    token = read_token(home)
    org, project = read_slugs(home)
    if token is None or org is None or project is None:
        note(f"no organization token, organization or project for Memfault, so nothing was uploaded: see {DOCS}")
        return 0
    cli = shutil.which("memfault")
    if cli is None:
        note(f"the memfault command is not installed (pip install memfault-cli), so nothing was uploaded: see {DOCS}")
        return 0

    note(f"symbols of {version} to {org}/{project}")
    # The version and software type as well as the ELF: memfault-cli 1.12 does not find the GNU build
    # ID this build carries (.note.gnu.build-id, kept by the Memfault SDK), and refuses symbols with
    # neither. The board tells Memfault the same version string (CONFIG_MEMFAULT_NCS_FW_VERSION).
    if not run([cli, "upload-mcu-symbols", "--software-type", software, "--software-version", version, str(elf)],
               token, org, project):
        print("memfault_upload: the symbols were not uploaded", file=sys.stderr)
        return 1

    if args.symbols_only or test_image:
        why = "a test image" if test_image else "--symbols-only"
        note(f"no release in Memfault for {version}: {why}")
        return 0

    note(f"{version} as a release for {hardware}, software type {software}")
    if not run([cli, "upload-ota-payload", "--hardware-version", hardware, "--software-type", software,
                "--software-version", version, str(image)], token, org, project):
        print("memfault_upload: the release was not uploaded", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
