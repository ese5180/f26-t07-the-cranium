#!/usr/bin/env python3
"""Keep the signed image of the latest build in binaries/. Run by every `west build`.

    binaries/cranium-1.2.0-0.signed.bin    this version, named so that the console accepts it
    binaries/latest.signed.bin             a copy of the newest build
    binaries/latest.json                   its version, size, digest, git commit and -D settings
    binaries/cranium-1.2.0-0.json          the same record, kept next to each version's image, so
                                           that scripts/check-image.sh can check any of them

That is for an nRF7002 DK. A build for another board type (CONFIG_APP_BOARD_TYPE, docs/fleet.md) has the
type in its names, and a latest of its own, so that nothing that takes latest.signed.bin to an nRF7002
DK can take it by mistake:

    binaries/cranium-nrf5340dk-1.2.0-0.signed.bin
    binaries/cranium-nrf5340dk-1.2.0-0.json    its record, which also says "board": "nrf5340dk"
    binaries/latest-nrf5340dk.signed.bin
    binaries/latest-nrf5340dk.json

Only a build of the checkout itself is kept: the test bench builds from scratch copies,
which have no .git, and an image built with a test fault is refused. latest.json says whether
the image has firmware update over Bluetooth, which every build has from 1.9.0. A signed image
is not a secret, but it is large and can be rebuilt, so git ignores these files.

Install what is stored here with scripts/ota.sh, or upload it on the console's Firmware page.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MCUBOOT_MAGIC = 0x96f3b83d
KEEP = 10
# The board type of an image whose build does not say: every build up to 1.12.0 was for this one.
DEFAULT_BOARD = "nrf7002dk"
# What CMake writes above a cache entry that came from -D.
FROM_THE_COMMAND_LINE = "//No help, variable specified on the command line."


def image_version(data: bytes) -> tuple[str, str]:
    """The version in an MCUboot header, as text and as it can be used in a file name."""
    if len(data) < 32 or int.from_bytes(data[0:4], "little") != MCUBOOT_MAGIC:
        sys.exit("store_binary: this is not an MCUboot image")
    major, minor = data[20], data[21]
    revision = int.from_bytes(data[22:24], "little")
    build = int.from_bytes(data[24:28], "little")
    return f"{major}.{minor}.{revision}+{build}", f"{major}.{minor}.{revision}-{build}"


def has_test_fault(config: Path) -> bool:
    text = config.read_text() if config.exists() else ""
    return re.search(r"^CONFIG_APP_TEST_FAULT_(?!NONE)\w+=y$", text, re.MULTILINE) is not None


def board_type(config: Path) -> str:
    """The board type the build was for: CONFIG_APP_BOARD_TYPE, or DEFAULT_BOARD before it existed."""
    text = config.read_text() if config.exists() else ""
    found = re.search(r'^CONFIG_APP_BOARD_TYPE="([a-z0-9]+)"$', text, re.MULTILINE)
    return found.group(1) if found else DEFAULT_BOARD


def names(board: str, version_name: str) -> tuple[str, str]:
    """The stem of the image's own file, and of its latest: today's names for an nRF7002 DK."""
    if board == DEFAULT_BOARD:
        return f"cranium-{version_name}", "latest"
    return f"cranium-{board}-{version_name}", f"latest-{board}"


def has_bluetooth_update(config: Path) -> bool:
    text = config.read_text() if config.exists() else ""
    return re.search(r"^CONFIG_APP_BT_OTA=y$", text, re.MULTILINE) is not None


def command_line_settings(build: Path) -> list[str]:
    """What -D gave this build. CMake keeps it in the build directory's cache, so it goes on
    changing images after the command that set it is forgotten, on a tree that git calls clean.

    A type or a name cannot tell these from the build's own entries: every sysbuild has
    SB_CONF_FILE:STRING and mcuboot_EXTRA_CONF_FILE:STRING. CMake marks them instead: an entry of
    -DNAME=value has the type UNINITIALIZED, and an entry of -DNAME:TYPE=value has the comment
    above. This is a record, not a lock: a setting that reached the build in any other way, or
    that the build's own CMake code then sets again, is not in it."""
    cache = build / "CMakeCache.txt"
    text = cache.read_text() if cache.exists() else ""
    found = []
    comment = ""
    for line in text.splitlines():
        entry = re.fullmatch(r"([^/#:][^:]*):(\w+)=(.*)", line)
        if entry and (entry[2] == "UNINITIALIZED" or comment == FROM_THE_COMMAND_LINE):
            found.append((entry[1], entry[3]))
        comment = line
    # West's own, which every build has.
    return [f"{name}={value}" for name, value in found if name != "WEST_PYTHON"]


def git_commit(repo: Path) -> str:
    try:
        commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                                capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "firmware"],
                               capture_output=True, text=True, check=True).stdout.strip()
        listing = subprocess.run(["git", "-C", str(repo), "ls-files", "-v", "firmware"],
                                 capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    # status says nothing about a file marked --skip-worktree or --assume-unchanged.
    # ls-files -v shows those as S and in lower case.
    hidden = re.search(r"^[a-zS] ", listing, re.MULTILINE)
    return f"{commit}+uncommitted" if dirty or hidden else commit


def prune(folder: Path) -> None:
    """Keep the newest versions; a folder that nobody tidies does not grow for ever."""
    images = sorted(folder.glob("cranium-*.signed.bin"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in images[KEEP:]:
        old.unlink()
        old.with_name(old.name.removesuffix(".signed.bin") + ".json").unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", required=True, type=Path, help="the sysbuild build directory")
    parser.add_argument("--repo", required=True, type=Path, help="the root of the source tree")
    args = parser.parse_args()

    if not (args.repo / ".git").exists():
        print(f"store_binary: {args.repo} is not the checkout, so nothing is kept")
        return
    if has_test_fault(args.build / "app" / "zephyr" / ".config"):
        print("store_binary: this image has a test fault built in, so it is not kept")
        return
    image = args.build / "app" / "zephyr" / "zephyr.signed.bin"
    if not image.exists():
        sys.exit(f"store_binary: {image} is missing")
    data = image.read_bytes()
    version, name = image_version(data)
    config = args.build / "app" / "zephyr" / ".config"
    board = board_type(config)
    stem, latest = names(board, name)

    folder = args.repo / "binaries"
    folder.mkdir(exist_ok=True)
    shutil.copyfile(image, folder / f"{stem}.signed.bin")
    shutil.copyfile(image, folder / f"{latest}.signed.bin")
    fields = {
        "version": version,
        "file": f"{stem}.signed.bin",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bluetooth": has_bluetooth_update(config),
        "commit": git_commit(args.repo),
        "command_line": command_line_settings(args.build),
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    # An nRF7002 DK's record stays as it was; any other says what it is for.
    if board != DEFAULT_BOARD:
        fields["board"] = board
    record = json.dumps(fields, indent=2) + "\n"
    (folder / f"{stem}.json").write_text(record)
    (folder / f"{latest}.json").write_text(record)
    prune(folder)
    print(f"store_binary: {version} for the {board} is in binaries/{stem}.signed.bin ({len(data)} bytes)")


if __name__ == "__main__":
    main()
