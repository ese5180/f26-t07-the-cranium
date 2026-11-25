#!/usr/bin/env python3
"""A stand-in for the Raspberry Pi's `cranium-update fetch`, against the board (docs/pi-os-update.md).

    tools/pi_os_sim.py --harness firmware/tests/host/build/pi_delta_harness --card CARD \\
        --version 1.0.0 --slot a --work DIR [--pubkey PUB.pem] [--unhealthy]

This is not the Pi's program: `cranium-update fetch` is the Pi's owner's to write (pi/, on the
tryboot branch). It is the contract's executable form, run by firmware/tests/hil/test_pi_os.py against
the board's real C code (src/pi/pi_rx.c and pi_dlink.c, as src/pi/pi_link.c has them, through
firmware/tests/host/pi_delta_harness.c). It does what docs/pi-os-update.md asks of the Pi, in order:

1. OS_STATUS: what it runs (`cranium-update status`).
2. FILE_INFO. Nothing to do unless a file is offered; a generation it has handled already only has
   its result sent again, if the board has not taken it yet.
3. It declines a file that is not for it, before reading any of it: not newer, or a delta from a
   version it does not run. RESULT "refused", with the reason.
4. FILE_READ from where its partial file ends (a restart goes on), 480 bytes at a time, pipelined;
   every answer's generation must be FILE_INFO's, or it starts again from 2.
5. The whole file's SHA-256 must be FILE_INFO's.
6. "apply": the tar's manifest.json, its Ed25519 signature (manifest.sig) when given the key, its
   version and the version it starts from. A file that fails is refused, with the reason.
7. RESULT "applied", then the restart into the new slot on trial, OS_STATUS (on trial), the health
   check, and RESULT "confirmed" or "rolled_back", then OS_STATUS again.

Every request is sent again until its answer comes (PiClient.request(): STATUS, a damaged frame or
another seq is not the answer). RESULT is sent until the board answers it; a result it has not had
answered is kept in the work directory, as /data/cranium-ota/ would keep it on the Pi, and sent first
on the next run.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pi_delta_sim import (ANSWER, ERROR, POLL, READ_MAX, BoardError, HarnessTransport,  # noqa: E402
                          LinkError, MessageSender, PiClient, decode, encode)

FILE_INFO, FILE_READ, RESULT, OS_STATUS = 0x20, 0x21, 0x22, 0x23
NONE, DOWNLOADING, OFFERED, HELD = 0, 1, 2, 3
APPLIED, CONFIRMED, ROLLED_BACK, REFUSED = 1, 2, 3, 4
RESULT_NAMES = {APPLIED: "applied", CONFIRMED: "confirmed", ROLLED_BACK: "rolled_back", REFUSED: "refused"}
FLAG_FULL, FLAG_NO_CARD = 1, 4
REASON_MAX = 64


def version_key(text: str) -> tuple[int, ...]:
    """As cranium_ota.py compares versions: dotted whole numbers."""
    return tuple(int(x) for x in text.split("."))


class OsClient(PiClient):
    """The four requests of a Pi OS update, on the link PiClient already speaks."""

    def file_info(self) -> dict:
        p = self.request(FILE_INFO).payload
        return {
            "protocol": struct.unpack_from("<H", p, 0)[0], "state": p[2], "flags": p[3],
            "generation": struct.unpack_from("<I", p, 4)[0], "size": struct.unpack_from("<I", p, 8)[0],
            "done": struct.unpack_from("<I", p, 12)[0], "result": p[16], "sha256": p[20:52],
            "version": p[52:84].rstrip(b"\0").decode(), "from": p[84:116].rstrip(b"\0").decode(),
        }

    def os_status(self, slot: str, default: str, trial: bool, last: int, version: str,
                  last_version: str = "") -> None:
        payload = struct.pack("<BBBB32s32s", ord(slot), ord(default), int(trial), last,
                              version.encode(), last_version.encode())
        self.request(OS_STATUS, payload)

    def result(self, code: int, generation: int, version: str, reason: str = "") -> bool:
        """RESULT; True if the board kept it (it names the generation and version it holds)."""
        text = reason.encode()[:REASON_MAX]
        payload = struct.pack("<BBHI32s", code, len(text), 0, generation, version.encode()) + text
        answer = self.request(RESULT, payload).payload
        return answer[5] == 1

    def read_file(self, generation: int, size: int, start: int, out, budget: int | None = None) -> int:
        """Bytes start to size into out, pipelined: each transfer carries the next FILE_READ and brings
        the last answer. Returns how far it got (budget: at most that many transfers, as a Pi cut off
        half way would)."""
        self._between()
        pending: tuple[int, int, int] | None = None
        at = start
        written = start
        transfers = 0
        while at < size or pending is not None:
            if budget is not None and transfers >= budget:
                return written
            transfers += 1
            if at < size:
                n = min(READ_MAX, size - at)
                seq = self._next_seq()
                mosi = encode(FILE_READ, self.session, seq, struct.pack("<IHH", at, n, 0))
                current = (seq, at, n)
                at += n
            else:
                mosi = encode(POLL, self.session, 0)
                current = None
            raw = self._xfer(mosi)
            if pending is not None:
                answer = self._answer(raw, pending[0], FILE_READ)
                if answer is None:
                    # Lost on the way: that piece again on its own, then the one just asked for.
                    self.retries += 1
                    data = self.read_one(generation, pending[1], pending[2])
                    out.write(data)
                    written += len(data)
                    if current is not None:
                        data = self.read_one(generation, current[1], current[2])
                        out.write(data)
                        written += len(data)
                        pending = None
                        continue
                else:
                    got_generation, got_offset, got = struct.unpack_from("<IIH", answer.payload, 0)
                    if got_generation != generation:
                        raise LinkError("the file changed while it was being read")
                    assert (got_offset, got) == (pending[1], pending[2])
                    out.write(answer.payload[16:16 + got])
                    written += got
            pending = current
        return written

    def read_one(self, generation: int, offset: int, length: int) -> bytes:
        p = self.request(FILE_READ, struct.pack("<IHH", offset, length, 0)).payload
        got_generation, got_offset, got = struct.unpack_from("<IIH", p, 0)
        if got_generation != generation:
            raise LinkError("the file changed while it was being read")
        assert (got_offset, got) == (offset, length)
        return p[16:16 + got]


class Pi:
    """What the Pi keeps: its slots and versions (cranium-update's state), and fetch's own file."""

    def __init__(self, work: Path, version: str, slot: str = "a"):
        self.work = work
        self.work.mkdir(parents=True, exist_ok=True)
        self.state_path = work / "fetch.json"
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text())
        else:
            self.state = {"version": version, "slot": slot, "trial": False, "last": 0, "last_version": "",
                          "handled": {}, "pending": None}
            self.save()

    def save(self):
        self.state_path.write_text(json.dumps(self.state, sort_keys=True))

    def status(self, client: OsClient):
        s = self.state
        client.os_status(s["slot"], s["slot"] if not s["trial"] else ("b" if s["slot"] == "a" else "a"),
                         s["trial"], s["last"], s["version"], s["last_version"])

    def send_result(self, client: OsClient, code: int, generation: int, version: str, reason: str = ""):
        """Kept until the board answers it: a restart sends it first."""
        self.state["pending"] = {"code": code, "generation": generation, "version": version, "reason": reason}
        self.save()
        client.result(code, generation, version, reason)
        self.state["pending"] = None
        self.state["handled"][str(generation)] = RESULT_NAMES[code]
        self.save()


def check_update(data: bytes, info: dict, pubkey: Path | None, running: str):
    """What `cranium_ota.py apply` checks before it writes anything; the reason, or None."""
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            manifest_raw = tar.extractfile("manifest.json").read()
            signature = tar.extractfile("manifest.sig").read()
    except (tarfile.TarError, KeyError, AttributeError):
        return "not an update file"
    if pubkey is not None:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import serialization

        key = serialization.load_pem_public_key(pubkey.read_bytes())
        try:
            key.verify(signature, manifest_raw)
        except InvalidSignature:
            return "the signature does not match"
    manifest = json.loads(manifest_raw)
    if manifest["version"] != info["version"]:
        return "the manifest is not the board's version"
    start = manifest.get("from") or {}
    if (start.get("version") or "") != info["from"]:
        return "the manifest does not start where the board says"
    if start and start["version"] != running:
        return f"a delta from {start['version']}, this Pi runs {running}"
    if version_key(manifest["version"]) <= version_key(running):
        return f"{manifest['version']} is not newer than {running}"
    return None


def fetch(client: OsClient, pi: Pi, pubkey: Path | None = None, healthy: bool = True,
          budget: int | None = None) -> str:
    """One run of `cranium-update fetch`. Returns what happened."""
    s = pi.state
    if s["pending"] is not None:
        p = s["pending"]
        pi.send_result(client, p["code"], p["generation"], p["version"], p["reason"])
    pi.status(client)
    info = client.file_info()
    if info["flags"] & FLAG_NO_CARD:
        return "no card"
    if info["state"] != OFFERED:
        return "nothing offered" if info["state"] != DOWNLOADING else "downloading"
    generation = info["generation"]
    if str(generation) in s["handled"]:
        return "handled already"

    # Not for this Pi: said at once, before any of it is read.
    if info["from"] and info["from"] != s["version"]:
        pi.send_result(client, REFUSED, generation, info["version"],
                       f"a delta from {info['from']}, this Pi runs {s['version']}")
        return "refused"
    if version_key(info["version"]) <= version_key(s["version"]):
        pi.send_result(client, REFUSED, generation, info["version"],
                       f"{info['version']} is not newer than {s['version']}")
        return "refused"

    part = pi.work / f"{info['sha256'].hex()}.part"
    start = part.stat().st_size if part.exists() else 0
    with open(part, "ab") as out:
        got = client.read_file(generation, info["size"], start, out, budget)
    if got < info["size"]:
        return "cut off"
    data = part.read_bytes()
    if hashlib.sha256(data).digest() != info["sha256"]:
        part.unlink()
        raise LinkError("the file does not match the board's SHA-256")

    reason = check_update(data, info, pubkey, s["version"])
    if reason is not None:
        pi.send_result(client, REFUSED, generation, info["version"], reason)
        part.unlink()
        return "refused"

    # apply: the spare slot written, then the restart into it on trial.
    pi.send_result(client, APPLIED, generation, info["version"])
    part.unlink()
    old_version, old_slot = s["version"], s["slot"]
    s.update(version=info["version"], slot="b" if old_slot == "a" else "a", trial=True)
    pi.save()
    pi.status(client)
    # confirm, at the next boot: kept if healthy, else the old slot boots again.
    if healthy:
        s.update(trial=False, last=CONFIRMED, last_version=info["version"])
        pi.save()
        pi.send_result(client, CONFIRMED, generation, info["version"])
        outcome = "confirmed"
    else:
        s.update(version=old_version, slot=old_slot, trial=False, last=ROLLED_BACK,
                 last_version=info["version"])
        pi.save()
        pi.send_result(client, ROLLED_BACK, generation, info["version"], "health check failed")
        outcome = "rolled_back"
    pi.status(client)
    return outcome


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--harness", required=True)
    parser.add_argument("--card", required=True)
    parser.add_argument("--version", required=True, help="the version the Pi runs, on its first run")
    parser.add_argument("--slot", default="a")
    parser.add_argument("--work", required=True, help="the Pi's /data/cranium-ota/, kept between runs")
    parser.add_argument("--pubkey", help="the Ed25519 public key (PEM) the manifest is checked with")
    parser.add_argument("--unhealthy", action="store_true", help="the health check fails on trial")
    parser.add_argument("--budget", type=int, help="stop after this many transfers of the file")
    parser.add_argument("--offer", action="store_true", help="the board's job offers the file it holds")
    parser.add_argument("--flip-every", type=int, default=0, help="damage one transfer in this many")
    parser.add_argument("--messages-every", type=int, default=0,
                        help="send a message on the same link before every Nth request")
    args = parser.parse_args(argv)
    transport = HarnessTransport(Path(args.harness), Path(args.card), args.flip_every,
                                 ("--offer",) if args.offer else ())
    messages = MessageSender(transport)
    client = OsClient(transport, session=0x0505, messages=messages, messages_every=args.messages_every)
    pi = Pi(Path(args.work), args.version, args.slot)
    try:
        outcome = fetch(client, pi, Path(args.pubkey) if args.pubkey else None, not args.unhealthy,
                        args.budget)
    except BoardError as e:
        outcome = f"board: {e.name}"
    finally:
        board = transport.close()
    print(f"{outcome}; runs {pi.state['version']} in slot {pi.state['slot']}; {client.transfers} transfers, "
          f"{client.retries} again, {messages.sent} messages beside them; board: {' '.join(board.split())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
