#!/usr/bin/env python3
"""Write apps/dist/SHA256SUMS and apps/dist/latest.json for every published build in apps/dist/.

apps/fetch-builds.sh (the phone apps, from the console) and apps/fetch-desktop-builds.sh (the desktop app,
from its release run) both end with this, so that each keeps the other's entries. A file counts only by
its name; anything else in the folder (a local build) is left out.

    python3 -I apps/write-dist-index.py apps/dist

latest.json, one entry for each app:

    "android", "ios"       {version, file, size, sha256}
    "desktop-windows",     {version, file, size, sha256, files: [{file, size, sha256}, ...]}: file is the one
    "desktop-linux"        to offer first (the Windows installer; on Linux the AppImage, else the .deb)

No dependencies.
"""

import hashlib
import json
import os
import re
import sys

V = r"(\d+\.\d+\.\d+)"
PART = re.compile(r"(.+)\.part(\d\d)")
PHONE = re.compile(r"cranium-(android|ios)-" + V + r"\.(apk|ipa)")
# The desktop app's installers, as electron-builder.<platform>.yml names them, in the order they are offered.
DESKTOP = {
    "desktop-windows": [
        re.compile(r"Cranium-Setup-" + V + r"\.exe"),
        re.compile(r"Cranium-Setup-" + V + r"-arm64\.exe"),
        re.compile(r"Cranium-" + V + r"-portable\.exe"),
    ],
    "desktop-linux": [
        re.compile(r"Cranium-" + V + r"\.AppImage"),
        re.compile(r"Cranium-" + V + r"-arm64\.AppImage"),
        re.compile(r"cranium_" + V + r"_amd64\.deb"),
        re.compile(r"cranium_" + V + r"_arm64\.deb"),
        re.compile(r"cranium-" + V + r"\.x86_64\.rpm"),
        re.compile(r"cranium-" + V + r"\.aarch64\.rpm"),
    ],
}


def digest(path):
    hash_ = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            hash_.update(chunk)
    return hash_.hexdigest(), os.path.getsize(path)


def main(dist):
    sums, latest = [], {}
    desktop = {app: [] for app in DESKTOP}
    names = sorted(os.listdir(dist))
    # An installer over GitHub's 100 MB is kept in parts, <installer>.part01, .part02, ..., with its own
    # SHA-256 in <installer>.sha256 (apps/fetch-desktop-builds.sh; apps/join-build.sh joins them).
    parts = {}
    for name in names:
        piece = PART.fullmatch(name)
        if piece:
            parts.setdefault(piece.group(1), []).append(name)
            sha, _ = digest(os.path.join(dist, name))
            sums.append("%s  %s" % (sha, name))
        elif name.endswith(".sha256") and name[: -len(".sha256")] in {PART.fullmatch(n).group(1) for n in names if PART.fullmatch(n)}:
            sha, _ = digest(os.path.join(dist, name))
            sums.append("%s  %s" % (sha, name))
    for name in names + [base for base in parts if base not in names]:
        if PART.fullmatch(name) or name.endswith(".sha256"):
            continue
        phone = PHONE.fullmatch(name)
        rank = None
        for app, patterns in DESKTOP.items():
            for index, pattern in enumerate(patterns):
                match = pattern.fullmatch(name)
                if match:
                    rank = (app, index, match.group(1))
        if not phone and rank is None:
            continue
        if name in parts:
            with open(os.path.join(dist, name + ".sha256")) as file:
                sha = file.read().split()[0]
            size = sum(os.path.getsize(os.path.join(dist, piece)) for piece in parts[name])
            app, index, version = rank
            desktop[app].append((index, version, {"file": name, "size": size, "sha256": sha, "parts": sorted(parts[name])}))
            continue
        sha, size = digest(os.path.join(dist, name))
        sums.append("%s  %s" % (sha, name))
        if phone:
            latest[phone.group(1)] = {"version": phone.group(2), "file": name, "size": size, "sha256": sha}
        else:
            app, index, version = rank
            desktop[app].append((index, version, {"file": name, "size": size, "sha256": sha}))
    for app, found in desktop.items():
        if not found:
            continue
        versions = {version for _, version, _ in found}
        if len(versions) != 1:
            sys.exit("error: apps/dist has %s builds of more than one version: %s" % (app, ", ".join(sorted(versions))))
        found.sort(key=lambda item: item[0])
        first = found[0][2]
        latest[app] = dict(first, version=found[0][1], files=[item[2] for item in found])
    with open(os.path.join(dist, "SHA256SUMS"), "w") as file:
        file.write("\n".join(sorted(sums, key=lambda line: line.split("  ", 1)[1])) + ("\n" if sums else ""))
    with open(os.path.join(dist, "latest.json"), "w") as file:
        file.write(json.dumps(latest, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: write-dist-index.py <apps/dist>")
    main(sys.argv[1])
