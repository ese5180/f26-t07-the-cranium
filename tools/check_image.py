#!/usr/bin/env python3
"""Check a signed firmware image before it is uploaded to the console. Run it as scripts/check-image.sh.

    scripts/check-image.sh                                     binaries/latest.signed.bin
    scripts/check-image.sh binaries/cranium-1.9.0-0.signed.bin  that image
    scripts/check-image.sh --strict ...                        anything not checked fails too

The console checks the signature and the layout itself. This also checks where the image came from:

  Console's checks   the console's own code (cloud/api/verify-image.mjs): MCUboot header, flash
                     layout, slot size, SHA-256, and the signature with this project's public key
  Build record       the record tools/store_binary.py kept for this image: the same bytes, the same
                     version, built from a commit with nothing uncommitted in firmware/, and no -D
                     settings, which change an image without anything in git saying so
  Bluetooth          whether phones can update a board that runs it (docs/mobile-apps.md)
  On main            the commit is on GitHub's main, so that anyone can see what was built
  Built and tested   CI built that commit's firmware and every test passed: on that commit, or on a
                     later one on main whose firmware/ is the same, since a push cancels the run
                     of the one before
  Newer              newer than every release on the console, which refuses anything else. Needs a
                     console token (CRANIUM_TOKEN or ~/.cranium/console-token)

What it cannot check: whether the image works. Only a board can show that, and the trial after an
update is what catches an image that does not.

The exit status is 1 if a check fails, and with --strict also if one could not be made.
"""

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MCUBOOT_MAGIC = 0x96F3B83D
TOKEN_FILE = Path.home() / ".cranium" / "console-token"

PASS, WARN, FAIL, SKIP = "PASS", "WARN", "FAIL", "SKIP"


def header_version(data: bytes):
    """(major, minor, revision, build) from an MCUboot header, or None."""
    if len(data) < 32 or int.from_bytes(data[0:4], "little") != MCUBOOT_MAGIC:
        return None
    return (data[20], data[21], int.from_bytes(data[22:24], "little"), int.from_bytes(data[24:28], "little"))


def version_text(parts) -> str:
    return f"{parts[0]}.{parts[1]}.{parts[2]}+{parts[3]}"


def parse_version(text: str):
    """(major, minor, revision, build) from "1.9.0+0", or None."""
    try:
        base, _, build = text.partition("+")
        major, minor, revision = (int(n) for n in base.split("."))
        return (major, minor, revision, int(build or 0))
    except (ValueError, AttributeError):
        return None


def find_record(image: Path, data: bytes, binaries: Path):
    """The record kept for this image: next to it, by its version in binaries/, or latest.json."""
    digest = hashlib.sha256(data).hexdigest()
    candidates = [image.with_name(image.name.removesuffix(".signed.bin") + ".json")]
    parts = header_version(data)
    if parts is not None:
        candidates.append(binaries / f"cranium-{parts[0]}.{parts[1]}.{parts[2]}-{parts[3]}.json")
    candidates.append(binaries / "latest.json")
    for path in candidates:
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("sha256") == digest:
            return path, record
    return None, None


def check_record(record, data: bytes):
    """The build record against the image: [(status, title, detail)]."""
    if record is None:
        return [(FAIL, "Build record",
                 "no record of this image in binaries/: it was not built by scripts/build.sh or "
                 "west build in this checkout, so nothing says what it was built from")]
    results = []
    parts = header_version(data)
    commit = str(record.get("commit", "unknown"))
    problems = []
    if record.get("size") != len(data):
        problems.append("its size differs from the record")
    if parts is None or record.get("version") != version_text(parts):
        problems.append(f"the record says version {record.get('version')}")
    if commit == "unknown" or commit.endswith("+uncommitted"):
        problems.append(f"built from {commit}: firmware/ had changes that are in no commit")
    if problems:
        results.append((FAIL, "Build record", "; ".join(problems)))
    else:
        results.append((PASS, "Build record", f"built from {commit}, with nothing uncommitted in firmware/"))
    settings = record.get("command_line") or []
    if settings:
        results.append((WARN, "Build settings",
                        "built with -D settings that no commit records: " + ", ".join(settings)))
    if record.get("bluetooth") is True:
        results.append((PASS, "Bluetooth", "phones can update a board that runs it"))
    elif record.get("bluetooth") is False:
        results.append((WARN, "Bluetooth",
                        "built without it: a board running this cannot be updated from a phone until a "
                        "cloud update brings it back"))
    else:
        results.append((SKIP, "Bluetooth", "the record predates 1.9.0 and does not say"))
    return results


def ci_verdict(commit: str, runs, is_ancestor, same_firmware):
    """Whether CI built and tested this commit's firmware.

    runs: [{"headSha", "status", "conclusion", "databaseId"}] of the CI workflow on main, newest
    first. is_ancestor(a, b) says whether commit a is in b's history; same_firmware(a, b) whether
    the two have the same firmware/. Returns (status, detail).
    """
    for run in runs:
        if run.get("headSha") == commit and run.get("status") == "completed":
            if run.get("conclusion") == "success":
                return PASS, f"run {run.get('databaseId')} built this commit and passed every test"
            if run.get("conclusion") == "failure":
                return FAIL, f"run {run.get('databaseId')} failed on this commit"
    for run in runs:
        head = run.get("headSha", "")
        if head == commit or run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        if is_ancestor(commit, head) and same_firmware(commit, head):
            return PASS, (f"run {run.get('databaseId')} passed on {head[:7]}, a later commit on main "
                          "with the same firmware/")
    if any(run.get("headSha") == commit and run.get("status") != "completed" for run in runs):
        return WARN, "CI is still running on this commit"
    return FAIL, "no successful CI run for this commit's firmware: push it, and wait for CI"


def git(*args, timeout=30):
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True,
                          timeout=timeout, check=False)


def full_commit(commit: str):
    answer = git("rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}")
    return answer.stdout.strip() if answer.returncode == 0 else None


def check_source(record):
    """On main, and built and tested in CI: [(status, title, detail)]."""
    commit = str((record or {}).get("commit", "unknown"))
    if record is None or commit == "unknown" or commit.endswith("+uncommitted"):
        return [(SKIP, "On main", "no clean commit to look for"), (SKIP, "Built and tested", "no clean commit")]
    sha = full_commit(commit)
    if sha is None:
        return [(FAIL, "On main", f"{commit} is not in this checkout"), (SKIP, "Built and tested", "")]

    results = []
    fetched = git("fetch", "--quiet", "origin", "main", timeout=60).returncode == 0
    note = "" if fetched else " (GitHub could not be reached: checked against the last fetch)"
    if git("merge-base", "--is-ancestor", sha, "origin/main").returncode == 0:
        results.append((PASS, "On main", f"{commit} is on origin/main{note}"))
    else:
        results.append((FAIL, "On main", f"{commit} is not on origin/main{note}: push it first"))
        results.append((SKIP, "Built and tested", "CI only builds main"))
        return results

    if shutil.which("gh") is None:
        results.append((SKIP, "Built and tested", "gh is not installed, so CI could not be asked"))
        return results
    listing = subprocess.run(
        ["gh", "run", "list", "--workflow", "ci.yml", "--branch", "main", "--limit", "40",
         "--json", "headSha,status,conclusion,databaseId"],
        cwd=REPO, capture_output=True, text=True, timeout=60, check=False)
    if listing.returncode != 0:
        results.append((SKIP, "Built and tested", "GitHub's CI runs could not be read: is gh signed in?"))
        return results
    runs = json.loads(listing.stdout or "[]")
    status, detail = ci_verdict(
        sha, runs,
        is_ancestor=lambda a, b: git("merge-base", "--is-ancestor", a, b).returncode == 0,
        same_firmware=lambda a, b: git("diff", "--quiet", a, b, "--", "firmware", "tools/store_binary.py")
        .returncode == 0)
    results.append((status, "Built and tested", detail))
    return results


def console_token():
    """A console token from CRANIUM_TOKEN or ~/.cranium/console-token, or None. Never printed."""
    token = os.environ.get("CRANIUM_TOKEN", "").strip()
    if token:
        return token
    try:
        mode = TOKEN_FILE.stat().st_mode
    except OSError:
        return None
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise PermissionError(f"{TOKEN_FILE} can be read by others: chmod 600 it")
    return TOKEN_FILE.read_text().strip() or None


def console_url():
    url = os.environ.get("CRANIUM_CONSOLE_URL", "").strip()
    if not url:
        try:
            url = json.loads((REPO / "cloud/.deploy/outputs.json").read_text()).get("ConsoleUrl", "")
        except (OSError, ValueError):
            url = ""
    return url.rstrip("/") or None


def newer_than_releases(parts, releases):
    """(status, detail): whether this version is above every release the console has had."""
    versions = [v for v in (parse_version(r.get("version", "")) for r in releases) if v is not None]
    if not versions:
        return PASS, "the console has no releases yet"
    highest = max(versions)
    if parts > highest:
        return PASS, f"above the console's highest release, {version_text(highest)}"
    return FAIL, (f"not above the console's highest release, {version_text(highest)}: the console "
                  "refuses it, and a board would too. Build it again with the next version")


def check_console(parts):
    try:
        token = console_token()
    except PermissionError as error:
        return [(FAIL, "Newer", str(error))]
    url = console_url()
    if token is None or url is None:
        return [(SKIP, "Newer", "no console token: the console makes this check itself on upload")]
    request = urllib.request.Request(f"{url}/api/t/firmware", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=20) as answer:
            releases = json.loads(answer.read()).get("releases", [])
    except (urllib.error.URLError, ValueError, OSError) as error:
        reason = getattr(error, "code", None) or type(error).__name__
        return [(SKIP, "Newer", f"the console could not be asked ({reason})")]
    return [newer_than_releases(parts, releases)]


def check_console_code(image: Path):
    node = shutil.which("node")
    if node is None:
        return [(FAIL, "Console's checks", "node is needed to run the console's own checks")]
    answer = subprocess.run([node, str(REPO / "cloud/api/verify-image.mjs"), str(image)],
                            capture_output=True, text=True, timeout=60, check=False)
    text = " ".join((answer.stdout + answer.stderr).split())
    if answer.returncode == 0:
        return [(PASS, "Console's checks", "header, layout, size and signature as the console checks them")]
    return [(FAIL, "Console's checks", text[:300] or "the console's checks refused it")]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("image", nargs="?", type=Path, default=REPO / "binaries/latest.signed.bin")
    parser.add_argument("--strict", action="store_true", help="fail on anything that could not be checked")
    args = parser.parse_args()

    try:
        data = args.image.read_bytes()
    except OSError as error:
        sys.exit(f"check-image: {error}")
    parts = header_version(data)
    if parts is None:
        sys.exit(f"check-image: {args.image} is not an MCUboot image")

    shown = os.path.relpath(args.image, Path.cwd())
    print(f"Checking {shown}: firmware {version_text(parts)}, {len(data):,} bytes\n")

    _, record = find_record(args.image.resolve(), data, REPO / "binaries")
    results = (check_console_code(args.image) + check_record(record, data) + check_source(record)
               + check_console(parts))
    width = max(len(title) for _, title, _ in results)
    for status, title, detail in results:
        print(f"  {status}  {title:<{width}}  {detail}")

    failed = any(status == FAIL for status, _, _ in results)
    unchecked = any(status == SKIP for status, _, _ in results)
    print()
    if failed or (args.strict and unchecked):
        print("Not ready to upload.")
        sys.exit(1)
    print("Ready to upload." + (" Some checks could not be made: see SKIP above." if unchecked else ""))


if __name__ == "__main__":
    main()
