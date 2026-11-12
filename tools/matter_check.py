#!/usr/bin/env python3
"""Does Matter work on this board? One command, a PASS/FAIL table and a verdict (docs/matter-thread.md, "Test it").

    python3 tools/matter_check.py --port /dev/tty.usbmodemXXXXXXXX
    MATTER_WIFI_SSID=... MATTER_WIFI_PASSWORD=... python3 tools/matter_check.py --port ... --wifi

It talks to the Matter variant's shell (firmware/matter) over the board's USB serial port. Each check is a row:

  shell               the Matter image answers on the serial port
  selftest            "matter selftest": TLV, SHA-256, CASE and fabric-ID vectors, SPAKE2+ both ways, ECDH and
                      AES-CCM, certificates, onboarding codes, Thread, SRP, flash areas, on the board
  thread              "matter status": Thread up as leader (or router), SRP server running
  onboarding codes    the QR code and manual code the board prints are the Matter SDK's test vectors
  bluetooth advert    the board advertises as commissionable (CHIPoBLE, discriminator 3840), seen with bleak
  wifi                the board is on Wi-Fi (--wifi joins it, from MATTER_WIFI_SSID/MATTER_WIFI_PASSWORD)
  mdns                _matter._tcp (after commissioning) seen from this computer; _matterc._udp is not used:
                      the board is commissioned over Bluetooth
  chip-tool ...       with chip-tool on the PATH: commission over Bluetooth and Wi-Fi, read Basic Information,
                      toggle the light, restart the board and read again, and ask for an update
                      (with chip-ota-provider-app and --ota-image)

A check whose tool is missing is SKIP, never FAIL. The Wi-Fi password is read from the environment and never
printed. Needs pyserial; bleak and zeroconf if installed (else those rows are skipped, on macOS dns-sd is used).
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
TEST_QR = "MT:Y.K9042C00KA0648G00"
TEST_MANUAL = "34970112332"
TEST_DISCRIMINATOR = 3840
TEST_PASSCODE = 20202021
TEST_VENDOR = 0xFFF1
TEST_PRODUCT = 0x8000
NODE_ID = "0x3F00"  # what chip-tool calls the board in this check
PROMPT = "uart:~$"
BASE38 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-."


# ---- what the board prints, read (host-tested in firmware/tests/hil/test_matter_check.py) ----

def parse_status(text: str) -> dict:
    """'commissioning: idle; Thread: leader; SRP: running' -> {'thread': 'leader', 'srp': 'running', ...}"""
    m = re.search(r"commissioning: ([^;]+); Thread: (\w+)(?:; SRP: (\w+))?", text)
    if not m:
        return {}
    return {"commissioning": m.group(1).strip(), "thread": m.group(2), "srp": m.group(3) or ""}


def parse_device(text: str) -> dict:
    m = re.search(r"QR (MT:[0-9A-Z.\-]+), code (\d{11})", text)
    out = {"qr": m.group(1), "manual": m.group(2)} if m else {}
    out["commissioned"] = "added to a phone's fabric" in text
    return out


def parse_selftest(text: str):
    """Rows (name, PASS/FAIL, detail) and the board's own verdict (or None if it did not finish)."""
    rows, result = [], None
    for m in re.finditer(r"SELFTEST (\S+) (PASS|FAIL)(.*)", text):
        if m.group(1) == "RESULT":
            result = m.group(2)
        else:
            rows.append((m.group(1), m.group(2), m.group(3).strip()))
    return rows, result


def verhoeff_ok(digits: str) -> bool:
    d = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
         [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
         [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
         [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
    p = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
         [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
         [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = d[c][p[i % 8][int(ch)]]
    return c == 0


def decode_qr(qr: str) -> dict:
    """The fields of a version-0 Matter QR payload."""
    body = qr[3:]
    data = bytearray()
    i = 0
    while i < len(body):
        n = 5 if len(body) - i >= 5 else len(body) - i
        v = 0
        for k, ch in enumerate(body[i:i + n]):
            v += BASE38.index(ch) * 38 ** k
        data += v.to_bytes(3 if n == 5 else 2 if n == 4 else 1, "little")
        i += n
    bits = int.from_bytes(data, "little")

    def take(pos, width):
        return (bits >> pos) & ((1 << width) - 1)

    return {"version": take(0, 3), "vendor": take(3, 16), "product": take(19, 16), "flow": take(35, 2),
            "discovery": take(37, 8), "discriminator": take(45, 12), "passcode": take(57, 27)}


def check_codes(qr: str, manual: str):
    """(ok, detail): both are the Matter SDK's test codes and agree with each other."""
    try:
        f = decode_qr(qr)
    except (ValueError, IndexError):
        return False, f"unreadable QR payload {qr!r}"
    if not verhoeff_ok(manual):
        return False, "the manual code's check digit is wrong"
    passcode = int(manual[6:10]) << 14 | (int(manual[1:6]) & 0x3FFF)
    short = (int(manual[0]) & 3) << 2 | int(manual[1:6]) >> 14
    agree = (f["vendor"], f["product"], f["passcode"], f["discriminator"] >> 8) == \
        (TEST_VENDOR, TEST_PRODUCT, passcode, short)
    if qr != TEST_QR or manual != TEST_MANUAL or not agree or f["passcode"] != TEST_PASSCODE or \
            f["discriminator"] != TEST_DISCRIMINATOR or not f["discovery"] & 0x02:
        return False, f"{qr} / {manual} are not the test codes {TEST_QR} / {TEST_MANUAL}"
    return True, f"{qr} / {manual}"


def verdict(rows) -> str:
    return FAIL if any(r[1] == FAIL for r in rows) else PASS


def table(rows) -> str:
    width = max(len(r[0]) for r in rows) + 2
    lines = [f"{'check'.ljust(width)}result  detail", "-" * (width + 40)]
    lines += [f"{name.ljust(width)}{res.ljust(8)}{detail}" for name, res, detail in rows]
    lines.append("-" * (width + 40))
    lines.append(f"VERDICT: {verdict(rows)} " + ("(Matter works on this board)" if verdict(rows) == PASS
                                                  else "(see the FAIL rows)"))
    return "\n".join(lines)


# ---- the board ----

class Board:
    def __init__(self, port: str, baud: int = 115200):
        import serial  # pyserial

        self.s = serial.Serial(port, baud, timeout=0.2)

    def run(self, command: str, wait: float = 5.0, until: str = PROMPT) -> str:
        """Sends a shell command, returns what came back (never printed: it may hold a typed password)."""
        self.s.reset_input_buffer()
        self.s.write((command + "\r\n").encode())
        out, deadline = b"", time.monotonic() + wait
        while time.monotonic() < deadline:
            out += self.s.read(512)
            text = out.decode(errors="replace")
            if until and until in text.split(command, 1)[-1]:
                break
        return out.decode(errors="replace")

    def close(self):
        self.s.close()


def ble_seen(seconds: float = 12.0):
    try:
        import asyncio
        from bleak import BleakScanner
    except ImportError:
        return None, "bleak is not installed (pip install bleak)"

    async def scan():
        found = []

        def cb(device, adv):
            data = adv.service_data.get("0000fff6-0000-1000-8000-00805f9b34fb")
            if data and len(data) >= 3 and data[0] == 0 and (data[1] | (data[2] << 8)) & 0xFFF == TEST_DISCRIMINATOR:
                found.append(device.address)

        async with BleakScanner(cb):
            await asyncio.sleep(seconds)
        return found

    found = asyncio.run(scan())
    return bool(found), (f"seen ({found[0]})" if found else "no CHIPoBLE advertisement with discriminator 3840")


def mdns_seen(service: str, seconds: float = 8.0):
    if shutil.which("dns-sd"):
        try:
            p = subprocess.run(["dns-sd", "-B", service, "local"], capture_output=True, text=True,
                               timeout=seconds)
            out = p.stdout
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        names = [line.split()[-1] for line in out.splitlines() if " Add " in line]
        return bool(names), ", ".join(names) or f"no {service} instance"
    try:
        from zeroconf import ServiceBrowser, Zeroconf
    except ImportError:
        return None, "neither dns-sd nor zeroconf (pip install zeroconf)"
    seen = []

    class L:
        def add_service(self, zc, t, name):
            seen.append(name)

        def update_service(self, *a):
            pass

        def remove_service(self, *a):
            pass

    zc = Zeroconf()
    ServiceBrowser(zc, service + ".local.", L())
    time.sleep(seconds)
    zc.close()
    return bool(seen), ", ".join(seen) or f"no {service} instance"


def chip_tool(args, timeout=180, secret=None):
    p = subprocess.run(["chip-tool", *args], capture_output=True, text=True, timeout=timeout)
    out = p.stdout + p.stderr
    if secret:
        out = out.replace(secret, "***")
    return p.returncode == 0, out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", required=True, help="the board's serial port")
    parser.add_argument("--wifi", action="store_true",
                        help="join Wi-Fi from MATTER_WIFI_SSID and MATTER_WIFI_PASSWORD if the board is not on it")
    parser.add_argument("--ota-image", help="an OTA image for chip-ota-provider-app (the update row)")
    parser.add_argument("--no-chip-tool", action="store_true", help="skip the chip-tool rows")
    args = parser.parse_args()
    rows = []
    ssid = os.environ.get("MATTER_WIFI_SSID", "")
    password = os.environ.get("MATTER_WIFI_PASSWORD", "")

    board = Board(args.port)
    try:
        status_text = board.run("matter status")
        status = parse_status(status_text)
        rows.append(("shell", PASS if status else FAIL,
                     "the Matter image answers" if status else "no answer to 'matter status': is the Matter image on it?"))
        if not status:
            print(table(rows))
            return 1
        st_rows, st_result = parse_selftest(board.run("matter selftest", wait=60, until="SELFTEST RESULT"))
        failed = [n for n, r, _ in st_rows if r == FAIL]
        rows.append(("selftest", PASS if st_result == PASS else FAIL,
                     f"{len(st_rows)} on-board checks" + (f"; failed: {', '.join(failed)}" if failed else "")
                     if st_result else "did not finish"))
        thread_ok = status.get("thread") in ("leader", "router") and status.get("srp") == "running"
        rows.append(("thread", PASS if thread_ok else FAIL, f"role {status.get('thread')}, SRP {status.get('srp')}"))
        device = parse_device(board.run("matter device"))
        ok, detail = check_codes(device.get("qr", ""), device.get("manual", "")) if device.get("qr") else (False, "not printed")
        rows.append(("onboarding codes", PASS if ok else FAIL, detail))

        if device.get("commissioned"):
            rows.append(("bluetooth advert", SKIP, "already added to a fabric: no advertising expected"))
        else:
            board.run("matter open")
            seen, detail = ble_seen()
            rows.append(("bluetooth advert", SKIP if seen is None else PASS if seen else FAIL, detail))

        wifi_text = board.run("wifi status", wait=5)
        on_wifi = "COMPLETED" in wifi_text
        if not on_wifi and args.wifi and ssid and password:
            board.run(f'wifi cred add -s "{ssid}" -k 1 -p "{password}"', wait=5)
            board.run("matter reboot", wait=2, until="")
            time.sleep(25)
            on_wifi = "COMPLETED" in board.run("wifi status", wait=5)
        rows.append(("wifi", PASS if on_wifi else SKIP if not args.wifi else FAIL,
                     "joined" if on_wifi else "not on Wi-Fi (give --wifi and MATTER_WIFI_SSID/PASSWORD)"))

        if args.no_chip_tool or not shutil.which("chip-tool"):
            why = "--no-chip-tool" if args.no_chip_tool else "chip-tool is not on the PATH"
            for name in ("chip-tool commission", "chip-tool read", "chip-tool toggle", "chip-tool reconnect",
                         "chip-tool ota"):
                rows.append((name, SKIP, why))
        elif not (ssid and password):
            rows.append(("chip-tool commission", SKIP, "needs MATTER_WIFI_SSID and MATTER_WIFI_PASSWORD"))
        else:
            ok, out = chip_tool(["pairing", "ble-wifi", NODE_ID, ssid, password, str(TEST_PASSCODE),
                                 str(TEST_DISCRIMINATOR)], timeout=240, secret=password)
            rows.append(("chip-tool commission", PASS if ok else FAIL,
                         "over Bluetooth, then Wi-Fi" if ok else out.strip().splitlines()[-1][:80] if out else "failed"))
            if ok:
                ok, out = chip_tool(["basicinformation", "read", "vendor-id", NODE_ID, "0"])
                rows.append(("chip-tool read", PASS if ok and "65521" in out else FAIL, "VendorID 0xFFF1"))
                ok, _ = chip_tool(["onoff", "toggle", NODE_ID, "1"])
                rows.append(("chip-tool toggle", PASS if ok else FAIL, "the board's LED 2"))
                board.run("matter reboot", wait=2, until="")
                time.sleep(25)
                ok, _ = chip_tool(["basicinformation", "read", "software-version", NODE_ID, "0"])
                rows.append(("chip-tool reconnect", PASS if ok else FAIL, "read again after a restart"))
                if args.ota_image and shutil.which("chip-ota-provider-app"):
                    ok, out = chip_tool(["otasoftwareupdaterequestor", "announce-otaprovider", "1", "0", "0", "0",
                                         NODE_ID, "0"])
                    rows.append(("chip-tool ota", PASS if ok else FAIL, "AnnounceOTAProvider accepted"))
                else:
                    rows.append(("chip-tool ota", SKIP, "needs chip-ota-provider-app running and --ota-image"))
            m_ok, m_detail = mdns_seen("_matter._tcp")
            rows.append(("mdns", SKIP if m_ok is None else PASS if m_ok else FAIL, m_detail))
        if not any(r[0] == "mdns" for r in rows):
            if device.get("commissioned") and on_wifi:
                m_ok, m_detail = mdns_seen("_matter._tcp")
                rows.append(("mdns", SKIP if m_ok is None else PASS if m_ok else FAIL, m_detail))
            else:
                rows.append(("mdns", SKIP, "_matter._tcp appears once the board is commissioned and on Wi-Fi; "
                                           "_matterc._udp is not used (Bluetooth commissioning)"))
    finally:
        board.close()
    print(table(rows))
    return 0 if verdict(rows) == PASS else 1


if __name__ == "__main__":
    sys.exit(main())
