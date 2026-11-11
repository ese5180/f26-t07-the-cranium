#!/usr/bin/env python3
"""How much flash and RAM each image of a firmware build has left, against a floor. Run by every firmware
job on GitHub Actions, right after the build (docs/ci.md, "Memory headroom").

    python3 -I tools/memory_budget.py --build build --configuration default \\
        [--budgets tools/memory_budgets.json] [--summary file] [--json file]

It finds every image of the sysbuild build folder: the application (app), MCUboot (mcuboot), TF-M
(tfm) and whatever runs on the network core (hci_ipc, ipc_radio, netcore_blinky, ...), and for each
reads flash and RAM used and the size of each, as tools/build_report.py does: the sizes from the
region table in the linker's map file, the used parts from the ELF file.

tools/memory_budgets.json gives, for each configuration of the firmware job (the matrix's
"configuration"), the least free flash and RAM in bytes that each image must keep:

    {"default": {"app": {"flash_free_min": 40960, "ram_free_min": 1000}, ...}, ...}

An image the file names that the build does not have is an error, as is a configuration it does not
name: a new build job gets its floors when it is added. An image the build has that the file does
not name is reported with no floor. It fails, with one GitHub error line per image, when an image
keeps less than its floor or uses more than its region holds.

--summary appends a Markdown table to that file ($GITHUB_STEP_SUMMARY); --json writes the numbers
there, for the job's artifact.

-I, so that nothing in tools/ or the environment stands in for a standard module: build_report.py is
loaded by its path. Nothing here needs the SDK.
"""

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BUDGETS = HERE / "memory_budgets.json"
FLOOR_KEYS = ("flash_free_min", "ram_free_min")


def _build_report():
    spec = importlib.util.spec_from_file_location("build_report", HERE / "build_report.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_report = _build_report()


class BudgetError(Exception):
    """Why the build or the budgets cannot be read."""


@dataclass(frozen=True)
class Image:
    key: str
    flash_used: int
    flash_total: int
    ram_used: int
    ram_total: int

    @property
    def flash_free(self) -> int:
        return self.flash_total - self.flash_used

    @property
    def ram_free(self) -> int:
        return self.ram_total - self.ram_used


def measure(key: str, elf: Path, map_file: Path) -> Image:
    try:
        flash, ram = build_report.image_rows(key, elf, map_file)
    except build_report.ReportError as error:
        raise BudgetError(str(error)) from error
    return Image(key, flash.used, flash.limit, ram.used, ram.limit)


def images_of(build: Path) -> list[Image]:
    """Every image of a sysbuild build folder, the application first."""
    if not (build / "app" / "zephyr" / "zephyr.elf").is_file():
        raise BudgetError(f"{build} has no app/zephyr/zephyr.elf: is it a sysbuild build folder?")
    found = [measure("app", build / "app/zephyr/zephyr.elf", build / "app/zephyr/zephyr.map")]
    tfm = build / "app" / "tfm" / "bin"
    if (tfm / "tfm_s.elf").is_file():
        found.append(measure("tfm", tfm / "tfm_s.elf", tfm / "tfm_s.map"))
    for folder in sorted(path for path in build.iterdir() if path.is_dir() and path.name != "app"):
        elf = folder / "zephyr" / "zephyr.elf"
        if elf.is_file():
            found.append(measure(folder.name, elf, folder / "zephyr" / "zephyr.map"))
    return found


def load_budgets(path: Path, configuration: str) -> dict[str, dict[str, int]]:
    try:
        budgets = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise BudgetError(f"{path} cannot be read: {error}") from error
    floors = budgets.get(configuration) if isinstance(budgets, dict) else None
    if not isinstance(floors, dict):
        raise BudgetError(f"{path.name} has no floors for the configuration \"{configuration}\": "
                          "add them when a build job is added")
    for image, values in floors.items():
        if image.startswith("_"):
            continue
        if not isinstance(values, dict) or not values or set(values) - set(FLOOR_KEYS) or not all(
                isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in values.values()):
            raise BudgetError(f"{path.name}: \"{configuration}\" / \"{image}\" must give "
                              f"{' and/or '.join(FLOOR_KEYS)} as whole numbers of bytes")
    return {image: values for image, values in floors.items() if not image.startswith("_")}


def check(images: list[Image], floors: dict[str, dict[str, int]], configuration: str) -> list[str]:
    """One line for each image that breaks its floor or its region, and for each floor with no image."""
    problems = []
    by_key = {image.key: image for image in images}
    for key in floors:
        if key not in by_key:
            problems.append(f"{configuration}: the build has no image \"{key}\", which "
                            "tools/memory_budgets.json gives a floor")
    for image in images:
        floor = floors.get(image.key, {})
        for what, free, total, wanted in (
            ("flash", image.flash_free, image.flash_total, floor.get("flash_free_min")),
            ("RAM", image.ram_free, image.ram_total, floor.get("ram_free_min")),
        ):
            if free < 0:
                problems.append(f"{configuration}: {image.key} uses {-free} bytes of {what} more than its "
                                f"region of {total} holds")
            elif wanted is not None and free < wanted:
                problems.append(f"{configuration}: {image.key} has {free} bytes of {what} free, "
                                f"under its floor of {wanted} (tools/memory_budgets.json). Free some, or lower "
                                "the floor in the same pull request and say why")
    return problems


def table(images: list[Image], floors: dict[str, dict[str, int]], configuration: str) -> str:
    def floor_of(image, key):
        value = floors.get(image.key, {}).get(key)
        return "—" if value is None else str(value)

    lines = [
        f"## Memory headroom, {configuration}",
        "",
        "| Image | Flash used | Flash total | Flash free | Floor | RAM used | RAM total | RAM free | Floor |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for image in images:
        lines.append(
            f"| {image.key} | {image.flash_used} | {image.flash_total} | {image.flash_free} | "
            f"{floor_of(image, 'flash_free_min')} | {image.ram_used} | {image.ram_total} | {image.ram_free} | "
            f"{floor_of(image, 'ram_free_min')} |")
    return "\n".join(lines) + "\n"


def as_json(images: list[Image], floors: dict[str, dict[str, int]], configuration: str, problems: list[str]) -> str:
    return json.dumps({
        "configuration": configuration,
        "images": [{
            "image": image.key,
            "flash": {"used": image.flash_used, "total": image.flash_total, "free": image.flash_free},
            "ram": {"used": image.ram_used, "total": image.ram_total, "free": image.ram_free},
            "floors": floors.get(image.key, {}),
        } for image in images],
        "problems": problems,
    }, indent=2) + "\n"


def run(build: Path, configuration: str, budgets: Path, summary: Path | None, json_file: Path | None) -> int:
    floors = load_budgets(budgets, configuration)
    images = images_of(build)
    problems = check(images, floors, configuration)
    text = table(images, floors, configuration)
    if problems:
        text += "\n" + "\n".join(f"- **{problem}**" for problem in problems) + "\n"
    print(text)
    if summary is not None:
        with summary.open("a") as file:
            file.write(text)
    if json_file is not None:
        json_file.parent.mkdir(parents=True, exist_ok=True)
        json_file.write_text(as_json(images, floors, configuration, problems))
    for problem in problems:
        print(f"::error::{problem}")
    return 1 if problems else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", required=True, type=Path, help="the sysbuild build folder")
    parser.add_argument("--configuration", required=True, help="the firmware job's configuration, as in the matrix")
    parser.add_argument("--budgets", type=Path, default=DEFAULT_BUDGETS, help="the floors (tools/memory_budgets.json)")
    parser.add_argument("--summary", type=Path, help="append the table to this file")
    parser.add_argument("--json", type=Path, help="write the numbers to this file")
    args = parser.parse_args()
    try:
        sys.exit(run(args.build, args.configuration, args.budgets, args.summary, args.json))
    except BudgetError as error:
        print(f"::error::memory_budget: {error}")
        sys.exit(f"memory_budget: {error}")


if __name__ == "__main__":
    main()
