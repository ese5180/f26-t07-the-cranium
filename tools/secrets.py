#!/usr/bin/env python3
"""Create and lock the local Wi-Fi secrets file.

    python tools/secrets.py wifi      ask for the network and write secrets/wifi_secrets.h
    python tools/secrets.py status    show which local secrets exist and who can read them

`wifi` writes the file owned by root with mode 0600, so reading it afterwards needs an
administrator password (the provisioning tool asks for it through sudo). The passphrase
is typed without echo and never appears on a command line.
"""

import argparse
import getpass
import os
import stat
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SECRETS = REPO / "secrets"
WIFI = SECRETS / "wifi_secrets.h"
SECURITIES = ("WPA2_PSK", "WPA2_PSK_SHA256", "WPA3_SAE")

TEMPLATE = """/*
 * Wi-Fi credentials used to provision a development board.
 * Written by tools/secrets.py. Not compiled into firmware and never committed.
 */
#ifndef WIFI_SECRETS_H_
#define WIFI_SECRETS_H_

#define WIFI_SECRETS_SSID "{ssid}"
#define WIFI_SECRETS_PASSPHRASE "{passphrase}"
#define WIFI_SECRETS_SECURITY {security}

#endif /* WIFI_SECRETS_H_ */
"""


def c_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def wifi() -> None:
    if os.name != "posix":
        sys.exit("Locking the file is only implemented for macOS and Linux")

    ssid = input("Wi-Fi network name (SSID): ").strip()
    if not 1 <= len(ssid.encode()) <= 32:
        sys.exit("An SSID is 1 to 32 bytes long")

    passphrase = getpass.getpass("Passphrase (not shown): ")
    if passphrase != getpass.getpass("Passphrase again: "):
        sys.exit("The two entries differ")
    if not 8 <= len(passphrase) <= 63 or not passphrase.isascii():
        sys.exit("A WPA2/WPA3 passphrase is 8 to 63 ASCII characters")

    security = input(f"Security {SECURITIES} [WPA2_PSK]: ").strip() or "WPA2_PSK"
    if security not in SECURITIES:
        sys.exit("Open, WEP and WPA (TKIP) networks are not supported")

    content = TEMPLATE.format(ssid=c_string(ssid), passphrase=c_string(passphrase),
                              security=security)
    SECRETS.mkdir(mode=0o700, exist_ok=True)

    print("Writing the file as root so that reading it needs an administrator password.")
    # tee runs as root and receives the content on stdin, so the passphrase is never
    # an argument that other processes could see.
    subprocess.run(["sudo", "sh", "-c",
                    'umask 077 && cat > "$1" && chown root "$1" && chmod 600 "$1"',
                    "sh", str(WIFI)], input=content.encode(), check=True,
                   stdout=subprocess.DEVNULL)
    print(f"Wrote {WIFI.relative_to(REPO)} (owner root, mode 600, ignored by git)")


def status() -> None:
    for path in sorted(SECRETS.iterdir()) if SECRETS.is_dir() else []:
        if path.name == "README.md" or path.name.endswith(".example"):
            continue
        info = path.stat()
        owner = "root" if info.st_uid == 0 else "you" if info.st_uid == os.getuid() else str(info.st_uid)
        mode = stat.filemode(info.st_mode)
        note = "" if not (info.st_mode & 0o077) else "  <- readable by others: chmod 600"
        print(f"{mode}  owner {owner:<4}  {path.relative_to(REPO)}{note}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["wifi", "status"])
    args = parser.parse_args()
    {"wifi": wifi, "status": status}[args.command]()


if __name__ == "__main__":
    main()
