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
    for name in sorted(os.listdir(dist)):
        phone = PHONE.fullmatch(name)
        rank = None
        for app, patterns in DESKTOP.items():
            for index, pattern in enumerate(patterns):
                match = pattern.fullmatch(name)
                if match:
                    rank = (app, index, match.group(1))
        if not phone and rank is None:
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
        file.write("\n".join(sums) + ("\n" if sums else ""))
    with open(os.path.join(dist, "latest.json"), "w") as file:
        file.write(json.dumps(latest, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: write-dist-index.py <apps/dist>")
    main(sys.argv[1])
