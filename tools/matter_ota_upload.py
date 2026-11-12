#!/usr/bin/env python3
"""Stores an OTA image on the Matter variant's board (firmware/matter), which then offers it to its devices as
their OTA provider (docs/matter-thread.md, "Firmware updates over Matter").

    python3 tools/matter_ota_upload.py --port /dev/tty.usbmodemXXXX --vid 0xFFF1 --pid 0x8000 \\
        --version 2 --name light-2 image.ota

It types the board's shell commands over the serial console: "matter ota begin", "matter ota write" in chunks,
"matter ota finish", waiting for each "OK". Then "matter ota announce <node>" on the board tells a device.
Needs pyserial.
"""

import argparse
import sys
import time

CHUNK = 224  # bytes per "matter ota write": 448 hex digits, within the shell's 600-character line


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--vid", required=True, type=lambda s: int(s, 0))
    parser.add_argument("--pid", required=True, type=lambda s: int(s, 0))
    parser.add_argument("--version", required=True, type=lambda s: int(s, 0))
    parser.add_argument("--name", required=True, help="1 to 16 of a-z A-Z 0-9 . - _; the BDX file name")
    parser.add_argument("image")
    args = parser.parse_args()

    import serial  # pyserial

    data = open(args.image, "rb").read()
    if not data or len(data) > 1024 * 1024 - 32:
        sys.exit("the image must be 1 byte to 1 MB less 32")
    with serial.Serial(args.port, args.baud, timeout=10) as port:

        def run(line: str) -> None:
            port.write((line + "\r\n").encode())
            deadline = time.monotonic() + 30
            seen = b""
            while time.monotonic() < deadline:
                seen += port.read(port.in_waiting or 1)
                if b"OK" in seen:
                    return
                if b"failed" in seen or b"could not" in seen or b"error" in seen.lower():
                    sys.exit(f"the board refused: {line[:60]}... {seen[-200:]!r}")
            sys.exit(f"no answer to: {line[:60]}")

        run(f"matter ota begin {args.vid} {args.pid} {args.version} {args.name} {len(data)}")
        for offset in range(0, len(data), CHUNK):
            run(f"matter ota write {offset} {data[offset:offset + CHUNK].hex()}")
            if offset // CHUNK % 100 == 0:
                print(f"{offset} of {len(data)} bytes", file=sys.stderr)
        run("matter ota finish")
    print("stored; announce it with: matter ota announce <node>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
