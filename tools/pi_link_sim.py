#!/usr/bin/env python3
"""A simulator of the Raspberry Pi's end of the SPI protocol (docs/pi-ota.md, "The SPI protocol").

A test double only: the real Pi end is someone else's work, and this is what it has to behave like,
written as code. It checks every frame the board sends (magic, length, CRC-32, type, sequence,
offset, the BEGIN's fields and the final hash), keeps partition B in memory, and answers as the
contract says. Faults can be asked for, to see the board recover or give up: a frame that arrives
damaged, a READY that does not come, a status that arrives damaged, a Pi that stays busy, one that
lost chunks, one that refuses, and one that already has part of the image.

firmware/tests/hil/test_pi_link.py runs it against the board's real code (src/pi_link.c), built for
the host as firmware/tests/host/build/pi_link_harness. run() is that conversation.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass, field

MAGIC = b"CPI1"
STATUS_MAGIC = b"CPR1"
HEADER = struct.Struct("<4sBBHII")  # magic, type, flags, reserved, seq, payload length
STATUS = struct.Struct("<4sBBHII")  # magic, status, code, reserved, seq, next_seq
STATUS_SIZE = STATUS.size + 4

BEGIN, DATA, VERIFY, ABORT, POLL = 1, 2, 3, 4, 5
ACK, NAK, BUSY = 0, 1, 2
OK, BAD_CRC, BAD_SEQ, BAD_STATE, BAD_TARGET, BAD_VERSION, NO_SPACE, WRITE_ERROR, HASH_MISMATCH, ABORTED = range(10)
PROTOCOL = 1
PARTITION_B = 2


class ProtocolError(AssertionError):
    """The board broke the contract: a test fails with this."""


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def frame(kind: int, seq: int, payload: bytes = b"") -> bytes:
    """A frame as the board builds it: for tests of the simulator itself."""
    head = HEADER.pack(MAGIC, kind, 0, 0, seq, len(payload)) + payload
    return head + struct.pack("<I", crc32(head))


def parse_status(data: bytes):
    magic, status, code, _, seq, next_seq = STATUS.unpack_from(data)
    (crc,) = struct.unpack_from("<I", data, STATUS.size)
    if magic != STATUS_MAGIC or crc != crc32(data[: STATUS.size]):
        raise ValueError("not a status")
    return status, code, seq, next_seq


@dataclass
class Faults:
    """What goes wrong, each once, keyed by (frame type, sequence number)."""

    damaged_frames: set = field(default_factory=set)  # arrives with a bit flipped: NAK BAD_CRC
    no_ready: set = field(default_factory=set)  # READY does not rise after the frame
    damaged_status: set = field(default_factory=set)  # the status after it arrives damaged
    busy: dict = field(default_factory=dict)  # (type, seq) -> how many polls answer BUSY
    lose: dict = field(default_factory=dict)  # DATA seq -> the Pi says it expects this earlier one
    refuse: dict = field(default_factory=dict)  # (type, seq) -> a NAK with this code, for good
    resume_from: int = 0  # the BEGIN's next_seq: chunks the Pi already has
    not_ready: bool = False  # READY never goes high


@dataclass
class PiSim:
    faults: Faults = field(default_factory=Faults)
    # What the Pi received: frames by type, in order, as (type, seq).
    log: list = field(default_factory=list)
    partition: bytearray = field(default_factory=bytearray)
    size: int = 0
    chunk: int = 0
    sha256: bytes = b""
    version: str = ""
    expected: int = 0
    begun: bool = False
    verified: bool = False
    aborted: int | None = None
    crc_errors: int = 0
    duplicates: int = 0
    _status: bytes = b""
    _answered: tuple | None = None

    def _set_status(self, status: int, code: int, seq: int, damaged: bool = False):
        body = STATUS.pack(STATUS_MAGIC, status, code, 0, seq, self.expected)
        crc = crc32(body)
        if damaged:
            crc ^= 1
        self._status = body + struct.pack("<I", crc)

    def ready_level(self) -> bool:
        return not self.faults.not_ready

    def wait_edge(self) -> bool:
        return not self.faults.not_ready

    def transaction(self, mosi: bytes, want_rx: bool) -> tuple[bytes, bool]:
        """One SPI transaction with the Pi's chip select low: what it clocks out, and whether
        READY rises after it."""
        if self.faults.not_ready:
            return bytes(len(mosi)), False

        if len(mosi) >= HEADER.size + 4 and mosi[:4] == MAGIC and mosi[4] == POLL:
            return self._poll(mosi, want_rx)

        if want_rx:
            raise ProtocolError("the board reads during a frame: only a POLL reads")
        return bytes(len(mosi)), self._frame(mosi)

    def _poll(self, mosi: bytes, want_rx: bool):
        if not want_rx or len(mosi) != STATUS_SIZE:
            raise ProtocolError(f"a POLL is {STATUS_SIZE} bytes and reads as many")
        _, kind, _, _, seq, length = HEADER.unpack_from(mosi)
        if length != 0 or struct.unpack_from("<I", mosi, HEADER.size)[0] != crc32(mosi[: HEADER.size]):
            raise ProtocolError("a damaged POLL")
        key = self._answered
        if key is not None and seq != key[1]:
            raise ProtocolError(f"a POLL for {seq} after frame {key}")
        if key in self.faults.busy and self.faults.busy[key] > 0:
            self.faults.busy[key] -= 1
            body = STATUS.pack(STATUS_MAGIC, BUSY, 0, 0, seq, self.expected)
            return body + struct.pack("<I", crc32(body)), True
        return self._status, True

    def _frame(self, mosi: bytes) -> bool:
        """Take a frame. Returns whether READY rises: the status is then ready for a POLL."""
        if len(mosi) < HEADER.size + 4:
            raise ProtocolError("a frame shorter than its header")
        magic, kind, flags, reserved, seq, length = HEADER.unpack_from(mosi)
        key = (kind, seq)
        self._answered = key

        if key in self.faults.damaged_frames:
            self.faults.damaged_frames.discard(key)
            mosi = mosi[:-1] + bytes([mosi[-1] ^ 0x80])

        if magic != MAGIC or flags or reserved or len(mosi) != HEADER.size + length + 4:
            raise ProtocolError(f"a malformed frame {key}")
        if struct.unpack_from("<I", mosi, HEADER.size + length)[0] != crc32(mosi[: HEADER.size + length]):
            self.crc_errors += 1
            self._set_status(NAK, BAD_CRC, seq)
            return self._edge(key)

        self.log.append(key)
        payload = mosi[HEADER.size : HEADER.size + length]
        handler = {BEGIN: self._begin, DATA: self._data, VERIFY: self._verify, ABORT: self._abort}.get(kind)
        if handler is None:
            raise ProtocolError(f"an unknown frame type {kind}")
        if key in self.faults.refuse:
            self._set_status(NAK, self.faults.refuse.pop(key), seq)
        else:
            handler(seq, payload)
        return self._edge(key)

    def _edge(self, key) -> bool:
        damaged = key in self.faults.damaged_status
        if damaged:
            self.faults.damaged_status.discard(key)
            self._status = self._status[:-1] + bytes([self._status[-1] ^ 1])
        if key in self.faults.no_ready:
            self.faults.no_ready.discard(key)
            return False
        return True

    def _begin(self, seq: int, p: bytes):
        if seq != 0 or len(p) != 80:
            raise ProtocolError("a BEGIN is sequence 0 with 80 bytes")
        protocol, partition, reserved, chunk, size = struct.unpack_from("<HBBIQ", p)
        sha = p[16:48]
        version = p[48:80].rstrip(b"\0").decode("ascii")
        if protocol != PROTOCOL:
            self._set_status(NAK, BAD_VERSION, seq)
            return
        if partition != PARTITION_B or reserved:
            self._set_status(NAK, BAD_TARGET, seq)
            return
        if not 0 < chunk <= 32 * 1024 or size == 0:
            raise ProtocolError("a BEGIN with no chunk size or no image")
        same = self.begun and sha == self.sha256 and size == self.size
        self.begun, self.verified, self.aborted = True, False, None
        self.size, self.chunk, self.sha256, self.version = size, chunk, sha, version
        if not same:
            self.partition = bytearray(size)
        self.expected = self.faults.resume_from
        self._set_status(ACK, OK, seq)

    def _data(self, seq: int, p: bytes):
        if not self.begun:
            self._set_status(NAK, BAD_STATE, seq)
            return
        (offset,) = struct.unpack_from("<I", p)
        data = p[4:]
        chunks = -(-self.size // self.chunk)
        if seq >= chunks or offset != seq * self.chunk:
            raise ProtocolError(f"chunk {seq} at offset {offset}")
        want = min(self.chunk, self.size - offset)
        if len(data) != want:
            raise ProtocolError(f"chunk {seq} has {len(data)} bytes, not {want}")
        if seq < self.expected:
            # Sent again: its answer was lost. The same bytes, acknowledged, not applied twice.
            if bytes(self.partition[offset : offset + want]) != data and seq >= self.faults.resume_from:
                raise ProtocolError(f"chunk {seq} sent again with other bytes")
            self.duplicates += 1
            self._set_status(ACK, OK, seq)
            return
        if seq > self.expected:
            self._set_status(NAK, BAD_SEQ, seq)
            return
        if seq in self.faults.lose:
            # The Pi lost what came before: it asks for an earlier chunk.
            self.expected = self.faults.lose.pop(seq)
            self._set_status(NAK, BAD_SEQ, seq)
            return
        self.partition[offset : offset + want] = data
        self.expected = seq + 1
        self._set_status(ACK, OK, seq)

    def _verify(self, seq: int, p: bytes):
        (size,) = struct.unpack_from("<Q", p)
        sha = p[8:40]
        if len(p) != 40 or not self.begun:
            raise ProtocolError("a VERIFY before a BEGIN, or not 40 bytes")
        chunks = -(-self.size // self.chunk)
        if seq != chunks or self.expected != chunks:
            raise ProtocolError(f"VERIFY {seq} after {self.expected} of {chunks} chunks")
        if size != self.size or sha != self.sha256 or hashlib.sha256(self.partition).digest() != sha:
            self._set_status(NAK, HASH_MISMATCH, seq)
            return
        self.verified = True
        self._set_status(ACK, OK, seq)

    def _abort(self, seq: int, p: bytes):
        if len(p) != 4:
            raise ProtocolError("an ABORT has 4 bytes")
        self.aborted = struct.unpack_from("<H", p)[0]
        self.begun = False
        self._set_status(ACK, OK, seq)


def run(process, sim: PiSim) -> dict:
    """Play the Pi to the board's harness until it ends: its result, as it reports it."""
    out, inp = process.stdin, process.stdout

    def read(n: int) -> bytes:
        data = inp.read(n)
        if len(data) != n:
            raise ProtocolError("the board's harness ended early")
        return data

    while True:
        kind = read(1)
        if kind == b"X":
            (length,) = struct.unpack("<I", read(4))
            mosi = read(length)
            want_rx = read(1) == b"\x01"
            miso, edge = sim.transaction(mosi, want_rx)
            if want_rx:
                out.write(miso)
            out.write(b"\x01" if edge else b"\x00")
        elif kind == b"W":
            out.write(b"\x01" if sim.wait_edge() else b"\x00")
        elif kind == b"L":
            out.write(b"\x01" if sim.ready_level() else b"\x00")
        elif kind == b"E":
            err, code, resends, started = struct.unpack("<iBII", read(13))
            return {"err": err, "code": code, "resends": resends, "started_at": started}
        else:
            raise ProtocolError(f"unknown message {kind!r}")
        out.flush()
