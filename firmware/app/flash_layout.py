#!/usr/bin/env python3
"""The flash layout of a build, and the check that its number is the right one. Run by every build.

    flash_layout.py check --zephyr-base <ZEPHYR_BASE> --config <app .config> \\
        --dts app=<app zephyr.dts> --dts mcuboot=<mcuboot zephyr.dts> --layouts flash_layouts.json
    flash_layout.py show --zephyr-base <ZEPHYR_BASE> --dts app=<...> --dts mcuboot=<...>

Every image says the flash layout it is built for in a protected TLV (0xa2, CONFIG_APP_IMAGE_LAYOUT),
and a board refuses an image of another layout. That is only worth something if the number changes
whenever the partitions do. So the build describes its partitions, as the application and the
bootloader each see them in their final devicetree (zephyr.dts), one line for each:

    <image> <flash device> <partition, and the partitions it is inside> <offset> <size>

and the chosen code partition. Comments, node order and properties that do not place a partition
change nothing. The SHA-256 of the sorted lines must be the one firmware/app/flash_layouts.json
holds for this board type and layout number, or the build stops and says what changed. A new
layout is a new number there, with its lines and their SHA-256, which `show` prints, and a new
default for APP_IMAGE_LAYOUT in firmware/app/Kconfig.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


def partition_lines(image: str, dts: Path, dtlib) -> list:
    """The lines of one image's devicetree."""
    tree = dtlib.DT(str(dts))
    lines = []

    def name_of(node):
        return node.labels[0] if node.labels else node.name

    for node in tree.node_iter():
        chain = []
        at = node
        while at is not None and at.name != "partitions":
            if not at.name.startswith("partition@"):
                break
            chain.append(name_of(at))
            at = at.parent
        if not chain or at is None or at.name != "partitions" or at.parent is None:
            continue
        reg = node.props.get("reg")
        if reg is None:
            raise SystemExit(f"flash_layout: {node.path} in {dts} has no reg")
        cells = reg.to_nums()
        if len(cells) != 2:
            raise SystemExit(f"flash_layout: {node.path} in {dts} is not one address and one size")
        device = name_of(at.parent)
        lines.append(f"{image} {device} {'/'.join(reversed(chain))} {cells[0]:#x} {cells[1]:#x}")

    chosen = tree.get_node("/chosen") if tree.has_node("/chosen") else None
    if chosen is not None and "zephyr,code-partition" in chosen.props:
        lines.append(f"{image} code {name_of(chosen.props['zephyr,code-partition'].to_path())}")
    return sorted(lines)


def describe(dts_args: list, zephyr_base: Path) -> list:
    sys.path.insert(0, str(zephyr_base / "scripts/dts/python-devicetree/src"))
    from devicetree import dtlib  # noqa: E402  From the SDK, at the path just given.

    lines = []
    for argument in dts_args:
        image, _, path = argument.partition("=")
        if not image or not path:
            raise SystemExit(f"flash_layout: --dts wants <image>=<zephyr.dts>, not {argument}")
        lines += partition_lines(image, Path(path), dtlib)
    return sorted(lines)


def digest(lines: list) -> str:
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def config_value(config: Path, name: str) -> str:
    found = re.search(rf"^CONFIG_{name}=(.*)$", config.read_text(), re.MULTILINE)
    if found is None:
        raise SystemExit(f"flash_layout: {config} has no CONFIG_{name}")
    return found.group(1).strip().strip('"')


def check(lines: list, board: str, layout: str, layouts: dict) -> list:
    """What is wrong, as lines to print: none if the number is the one of these partitions."""
    now = digest(lines)
    known = layouts.get(board, {}).get(layout)
    how = (f'Give the new layout a new number: set CRANIUM_{board.upper()}_LAYOUT in firmware/app/Kconfig to it, '
           f'and add it under "{board}" in firmware/app/flash_layouts.json with these partitions and '
           f'"sha256": "{now}". Boards of the old layout will refuse its images, as they must.')
    if known is None:
        return [f"{board} has no flash layout {layout} in firmware/app/flash_layouts.json.", how,
                "Its partitions are:", *lines]
    if digest(known.get("partitions", [])) != known.get("sha256"):
        return [f"firmware/app/flash_layouts.json does not hold together: the partitions of {board} layout "
                f"{layout} do not hash to its sha256."]
    if now != known["sha256"]:
        gone = sorted(set(known["partitions"]) - set(lines))
        new = sorted(set(lines) - set(known["partitions"]))
        return [f"The flash layout of {board} has changed, and its number has not: this is not layout {layout}.",
                how, *[f"  was: {line}" for line in gone], *[f"  now: {line}" for line in new]]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("check", "show"))
    parser.add_argument("--zephyr-base", required=True, type=Path)
    parser.add_argument("--dts", action="append", required=True, help="<image>=<its zephyr.dts>")
    parser.add_argument("--config", type=Path, help="the application's .config, for check")
    parser.add_argument("--layouts", type=Path, help="flash_layouts.json, for check")
    args = parser.parse_args()

    lines = describe(args.dts, args.zephyr_base)
    if args.action == "show":
        print(json.dumps({"partitions": lines, "sha256": digest(lines)}, indent=2))
        return 0

    if args.config is None or args.layouts is None:
        parser.error("check needs --config and --layouts")
    board = config_value(args.config, "APP_BOARD_TYPE")
    layout = config_value(args.config, "APP_IMAGE_LAYOUT")
    problems = check(lines, board, layout, json.loads(args.layouts.read_text()))
    if problems:
        print("flash_layout: " + "\n".join(problems), file=sys.stderr)
        return 1
    print(f"flash_layout: {board} layout {layout}, as its partitions are")
    return 0


if __name__ == "__main__":
    sys.exit(main())
