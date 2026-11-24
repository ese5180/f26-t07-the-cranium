#!/usr/bin/env python3
"""A stand-in for the Raspberry Pi's side of a delta update, as SPI controller (docs/pi-delta-update.md).

    tools/pi_delta_sim.py --harness firmware/tests/host/build/pi_delta_harness --card CARD \\
        --image CURRENT.img --version CURRENT_VERSION --out NEW.img

This is not the Pi's program: that is the Pi's owner's to write. It is the protocol's executable
contract, used by firmware/tests/hil/test_pi_delta.py against the board's real C code
(src/pi/pi_dlink.c, through firmware/tests/host/pi_delta_harness.c). It does what a Pi does: asks
INFO, takes the list of changed blocks when the card's update started from the image it runs (or
compares the board's block hashes with its own otherwise), reads only the blocks that differ, checks
each one's SHA-256, and checks the whole image's SHA-256 at the end.

Every transfer is 512 bytes each way (the frames of the Pi's message link, PR #58). The board
answers a request in the transfer after it; the Pi sends its next request in that same transfer
(pipelining), or a POLL when it has none.
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import subprocess
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

FRAME = 512
HEADER = 12
VERSION = 1
POLL = 0x02
INFO, MANIFEST, CHANGED, READ = 0x10, 0x11, 0x12, 0x13
ANSWER = 0x80
ERROR = 0xFF
MANIFEST_MAX, CHANGED_MAX, READ_MAX = 15, 120, 480
STATE_EMPTY, STATE_READY, STATE_UPDATING = 0, 1, 2
INFO_LIST, INFO_PREPARING, INFO_NO_CARD = 1, 2, 4
CODES = {1: "bad_frame", 2: "bad_request", 3: "unknown_type", 4: "no_image", 5: "updating",
         6: "out_of_range", 7: "card", 8: "no_list"}


def encode(kind: int, session: int, seq: int, payload: bytes = b"", ack: int = 0) -> bytes:
    """One frame, padded with zeros to the transfer's 512 bytes."""
    head = struct.pack("<2sBBHHHH", b"CL", VERSION, kind, session, seq, ack, len(payload))
    body = head + payload
    frame = body + struct.pack("<I", zlib.crc32(body))
    return frame + bytes(FRAME - len(frame))


@dataclass
class Frame:
    kind: int
    session: int
    seq: int
    ack: int
    payload: bytes


def decode(raw: bytes) -> Frame | None:
    if len(raw) < HEADER + 4 or raw[:2] != b"CL" or raw[2] != VERSION:
        return None
    kind, session, seq, ack, length = struct.unpack_from("<BHHHH", raw, 3)
    if HEADER + length + 4 > len(raw):
        return None
    if zlib.crc32(raw[:HEADER + length]) != struct.unpack_from("<I", raw, HEADER + length)[0]:
        return None
    return Frame(kind, session, seq, ack, raw[HEADER:HEADER + length])


class BoardError(Exception):
    def __init__(self, code: int, state: int, generation: int):
        super().__init__(f"{CODES.get(code, code)} (state {state}, generation {generation})")
        self.code = code
        self.name = CODES.get(code, str(code))
        self.state = state
        self.generation = generation


class LinkError(Exception):
    pass


class HarnessTransport:
    """The board's C code on the host: pi_delta_harness serve CARD."""

    def __init__(self, harness: Path, card: Path, flip_every: int = 0):
        self.proc = subprocess.Popen([str(harness), "serve", str(card)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.flip_every = flip_every
        self.count = 0

    def transfer(self, mosi: bytes) -> bytes:
        assert len(mosi) == FRAME
        self.count += 1
        if self.flip_every and self.count % self.flip_every == 0:
            # A wire that picks up noise: one bit of what the Pi sends goes wrong.
            mosi = bytearray(mosi)
            mosi[20] ^= 0x04
            mosi = bytes(mosi)
        self.proc.stdin.write(mosi)
        self.proc.stdin.flush()
        miso = self.proc.stdout.read(FRAME)
        if len(miso) != FRAME:
            raise LinkError("the board went away")
        if self.flip_every and self.count % self.flip_every == self.flip_every // 2:
            miso = bytearray(miso)
            miso[30] ^= 0x01
            miso = bytes(miso)
        return miso

    def close(self) -> str:
        self.proc.stdin.close()
        self.proc.wait(timeout=30)
        return self.proc.stderr.read().decode()


class PiClient:
    def __init__(self, transport, session: int = 0x5A5A, attempts: int = 5):
        self.t = transport
        self.session = session
        self.seq = 0
        self.attempts = attempts
        self.transfers = 0
        self.retries = 0
        self.generation: int | None = None

    def _next_seq(self) -> int:
        self.seq = (self.seq + 1) & 0xFFFF or 1
        return self.seq

    def _xfer(self, mosi: bytes) -> bytes:
        self.transfers += 1
        return self.t.transfer(mosi)

    def _answer(self, raw: bytes, seq: int, kind: int) -> Frame | None:
        frame = decode(raw)
        if frame is None or frame.ack != seq or frame.session != self.session:
            return None
        if frame.kind == ERROR:
            code, state = frame.payload[0], frame.payload[1]
            generation = struct.unpack_from("<I", frame.payload, 4)[0]
            if code == 1:
                return None  # the board got a damaged frame: send it again
            raise BoardError(code, state, generation)
        return frame if frame.kind == (kind | ANSWER) else None

    def request(self, kind: int, payload: bytes = b"") -> Frame:
        """Send a request, then POLL for its answer, and again on anything damaged."""
        for _ in range(self.attempts):
            seq = self._next_seq()
            self._xfer(encode(kind, self.session, seq, payload))
            answer = self._answer(self._xfer(encode(POLL, self.session, 0)), seq, kind)
            if answer is not None:
                return answer
            self.retries += 1
        raise LinkError(f"no answer to request 0x{kind:02x}")

    def _check_generation(self, generation: int):
        if self.generation is None:
            self.generation = generation
        elif generation != self.generation:
            raise LinkError("the card's image changed while it was being read")

    def info(self) -> dict:
        p = self.request(INFO).payload
        info = {
            "protocol": struct.unpack_from("<H", p, 0)[0], "state": p[2], "flags": p[3],
            "generation": struct.unpack_from("<I", p, 4)[0],
            "block_size": struct.unpack_from("<I", p, 8)[0], "block_count": struct.unpack_from("<I", p, 12)[0],
            "image_size": struct.unpack_from("<Q", p, 16)[0], "image_sha256": p[24:56], "table_sha256": p[56:88],
            "version": p[88:120].rstrip(b"\0").decode(), "changed": struct.unpack_from("<I", p, 120)[0],
            "base_version": p[124:156].rstrip(b"\0").decode(), "base_sha256": p[156:188],
            "done": struct.unpack_from("<I", p, 188)[0], "total": struct.unpack_from("<I", p, 192)[0],
        }
        return info

    def manifest(self, first: int, count: int) -> list[bytes]:
        p = self.request(MANIFEST, struct.pack("<IHH", first, count, 0)).payload
        generation, got_first, got = struct.unpack_from("<IIH", p, 0)
        self._check_generation(generation)
        assert got_first == first
        return [p[16 + 32 * i:48 + 32 * i] for i in range(got)]

    def changed(self, first: int, count: int) -> tuple[int, list[int]]:
        p = self.request(CHANGED, struct.pack("<IHH", first, count, 0)).payload
        generation, total, got_first, got = struct.unpack_from("<IIIH", p, 0)
        self._check_generation(generation)
        assert got_first == first
        return total, list(struct.unpack_from(f"<{got}I", p, 16))

    def read(self, block: int, offset: int, length: int) -> bytes:
        p = self.request(READ, struct.pack("<IIHH", block, offset, length, 0)).payload
        generation, got_block, got_offset, got = struct.unpack_from("<IIIH", p, 0)
        self._check_generation(generation)
        assert (got_block, got_offset, got) == (block, offset, length)
        return p[16:16 + got]

    def read_block(self, block: int, length: int) -> bytes:
        """A whole block, pipelined: each transfer carries the next READ and brings the last answer."""
        pieces = [(off, min(READ_MAX, length - off)) for off in range(0, length, READ_MAX)]
        out = bytearray(length)
        pending: tuple[int, int, int] | None = None
        i = 0
        while i < len(pieces) or pending is not None:
            if i < len(pieces):
                seq = self._next_seq()
                off, n = pieces[i]
                mosi = encode(READ, self.session, seq, struct.pack("<IIHH", block, off, n, 0))
                current = (seq, off, n)
            else:
                mosi = encode(POLL, self.session, 0)
                current = None
            raw = self._xfer(mosi)
            if pending is not None:
                answer = self._answer(raw, pending[0], READ)
                if answer is None:
                    # Damaged on the way: fetch that piece again on its own, then go on.
                    self.retries += 1
                    out[pending[1]:pending[1] + pending[2]] = self.read(block, pending[1], pending[2])
                    if current is not None:
                        # The board's answer to the request just sent was lost to the retry.
                        out[current[1]:current[1] + current[2]] = self.read(block, current[1], current[2])
                        i += 1
                        pending = None
                        continue
                else:
                    generation = struct.unpack_from("<I", answer.payload, 0)[0]
                    self._check_generation(generation)
                    out[pending[1]:pending[1] + pending[2]] = answer.payload[16:16 + pending[2]]
            pending = current
            i += 1 if current is not None else 0
        return bytes(out)


def block_len(info: dict, block: int) -> int:
    return min(info["block_size"], info["image_size"] - block * info["block_size"])


def take_update(client: PiClient, current: bytes, current_version: str) -> tuple[bytes, dict]:
    """What a Pi does: take only the blocks that differ from its image. Returns the new image."""
    info = client.info()
    if info["flags"] & INFO_NO_CARD:
        raise LinkError("the board has no card")
    if info["state"] != STATE_READY:
        raise BoardError(5 if info["state"] == STATE_UPDATING else 4, info["state"], info["generation"])
    client.generation = info["generation"]
    count, size = info["block_count"], info["image_size"]
    hashes: list[bytes] = []
    for first in range(0, count, MANIFEST_MAX):
        hashes += client.manifest(first, min(MANIFEST_MAX, count - first))
    if hashlib.sha256(b"".join(hashes)).digest() != info["table_sha256"]:
        raise LinkError("the board's block hashes are not its manifest's")

    current_sha = hashlib.sha256(current).digest()
    how = "compared"
    if (info["flags"] & INFO_LIST and info["base_version"] == current_version
            and info["base_sha256"] == current_sha):
        how = "listed"
        wanted: list[int] = []
        while len(wanted) < info["changed"]:
            total, entries = client.changed(len(wanted), CHANGED_MAX)
            wanted += entries
    else:
        bs = info["block_size"]
        wanted = [b for b in range(count)
                  if hashlib.sha256(current[b * bs:b * bs + block_len(info, b)]).digest() != hashes[b]
                  or b * bs + block_len(info, b) > len(current)]

    image = bytearray(current[:size].ljust(size, b"\0"))
    bs = info["block_size"]
    for block in wanted:
        data = client.read_block(block, block_len(info, block))
        if hashlib.sha256(data).digest() != hashes[block]:
            raise LinkError(f"block {block} does not match its hash")
        image[block * bs:block * bs + len(data)] = data
    if hashlib.sha256(image).digest() != info["image_sha256"]:
        raise LinkError("the image does not match the board's SHA-256")
    return bytes(image), {"how": how, "blocks": len(wanted), "of": count, "transfers": client.transfers,
                          "retries": client.retries, "version": info["version"]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--harness", required=True)
    parser.add_argument("--card", required=True)
    parser.add_argument("--image", required=True, help="the image the Pi runs now")
    parser.add_argument("--version", required=True, help="its version")
    parser.add_argument("--out", required=True)
    parser.add_argument("--flip-every", type=int, default=0, help="damage one transfer in this many")
    args = parser.parse_args(argv)
    transport = HarnessTransport(Path(args.harness), Path(args.card), args.flip_every)
    try:
        image, stats = take_update(PiClient(transport), Path(args.image).read_bytes(), args.version)
    finally:
        board = transport.close()
    Path(args.out).write_bytes(image)
    print(f"took {stats['blocks']} of {stats['of']} blocks ({stats['how']}) in {stats['transfers']} transfers, "
          f"{stats['retries']} again; now {stats['version']}, SHA-256 {hashlib.sha256(image).hexdigest()}; board: {board.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
