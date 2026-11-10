#!/usr/bin/env python3
"""Cranium step 2: send the collector's messages to the nRF7002 DK over SPI.

Follows ~/.cranium/messages.jsonl (written by cranium_collect.py) and sends each new line, one
message per frame, to the board. The Pi is the SPI controller; the board is the peripheral and
raises READY while it can take a transfer. The frame format and the wiring are in docs/pi-link.md;
the board's side is firmware/app/src/pi/.

A message is sent again until the board acknowledges it, and the board never delivers one twice.
While the board is away the messages wait here, the newest MAX_WAITING of them.

Usage:
  python3 cranium_link.py                      # follow ~/.cranium/messages.jsonl until Ctrl+C
  python3 cranium_link.py --send '{"t":"hb"}'  # send one message; exit 0 once the board has it
  python3 cranium_link.py --status             # read the board's status frame once
Needs python3-spidev and python3-libgpiod (both in Raspberry Pi OS), and the user in the spi and
gpio groups. SPI must be on: dtparam=spi=on in /boot/firmware/config.txt.
"""
import argparse
import collections
import os
import random
import sys
import time
import zlib

FRAME_SIZE = 512
HEADER = 12
CRC = 4
PAYLOAD_MAX = FRAME_SIZE - HEADER - CRC
VERSION = 1
DATA, POLL, STATUS = 0x01, 0x02, 0x81

READY_TIMEOUT = 0.5      # seconds to wait for the board to raise READY before a transfer
ATTEMPTS = 5             # transfers of one message before it waits for the next round
MAX_WAITING = 500        # messages kept while the board is away
HOME = os.path.expanduser("~")


class Frame:
    __slots__ = ("type", "session", "seq", "ack", "payload")

    def __init__(self, type, session=0, seq=0, ack=0, payload=b""):
        self.type, self.session, self.seq, self.ack, self.payload = type, session, seq, ack, payload

    def __repr__(self):
        return (f"Frame(type=0x{self.type:02x}, session={self.session}, seq={self.seq}, ack={self.ack}, "
                f"payload={self.payload!r})")


def encode(frame):
    """The frame, padded with zeros to FRAME_SIZE bytes."""
    if len(frame.payload) > PAYLOAD_MAX:
        raise ValueError(f"payload of {len(frame.payload)} bytes; at most {PAYLOAD_MAX}")
    head = (b"CL" + bytes([VERSION, frame.type]) + frame.session.to_bytes(2, "little")
            + frame.seq.to_bytes(2, "little") + frame.ack.to_bytes(2, "little")
            + len(frame.payload).to_bytes(2, "little") + frame.payload)
    body = head + zlib.crc32(head).to_bytes(4, "little")
    return body + bytes(FRAME_SIZE - len(body))


def decode(buf):
    """(Frame, None), or (None, why not): "nothing", "magic", "version", "length" or "crc"."""
    buf = bytes(buf)
    if not buf or buf.count(0) == len(buf) or buf.count(0xff) == len(buf):
        return None, "nothing"
    if len(buf) < HEADER + CRC or buf[:2] != b"CL":
        return None, "magic"
    if buf[2] != VERSION:
        return None, "version"
    length = int.from_bytes(buf[10:12], "little")
    end = HEADER + length
    if length > PAYLOAD_MAX or end + CRC > len(buf):
        return None, "length"
    if int.from_bytes(buf[end:end + CRC], "little") != zlib.crc32(buf[:end]):
        return None, "crc"
    return Frame(buf[3], int.from_bytes(buf[4:6], "little"), int.from_bytes(buf[6:8], "little"),
                 int.from_bytes(buf[8:10], "little"), buf[HEADER:end]), None


# ---- the hardware

class SpidevBus:
    """/dev/spidevB.D, mode 0."""

    def __init__(self, bus=0, device=0, hz=1_000_000):
        import spidev
        self.spi = spidev.SpiDev()
        self.spi.open(bus, device)
        self.spi.mode = 0
        self.spi.max_speed_hz = hz
        self.spi.bits_per_word = 8

    def transfer(self, data):
        return bytes(self.spi.xfer2(list(data)))

    def close(self):
        self.spi.close()


class GpiodReady:
    """The board's READY pin, an input with a pull-down: low while the board is away."""

    def __init__(self, chip="/dev/gpiochip0", line=25):
        import gpiod
        from gpiod.line import Bias, Direction, Value
        self.line, self.active = line, Value.ACTIVE
        self.request = gpiod.request_lines(chip, consumer="cranium-link", config={
            line: gpiod.LineSettings(direction=Direction.INPUT, bias=Bias.PULL_DOWN)})

    def is_high(self):
        return self.request.get_value(self.line) == self.active

    def close(self):
        self.request.release()


class NoReady:
    """No READY wire: every transfer is tried at once."""

    def is_high(self):
        return True

    def close(self):
        pass


# ---- the protocol

class Link:
    """Sends messages; each is acknowledged in the transfer after the one that carried it."""

    def __init__(self, bus, ready, session=None, clock=time.monotonic, sleep=time.sleep,
                 ready_timeout=READY_TIMEOUT):
        self.bus, self.ready, self.clock, self.sleep = bus, ready, clock, sleep
        self.ready_timeout = ready_timeout
        self.session = session or random.randint(1, 0xffff)
        self.seq = random.randint(0, 0xffff)
        self.stats = collections.Counter()
        # The last message could not be sent: the board is away (for follow()'s notices).
        self.away = False

    def wait_ready(self):
        deadline = self.clock() + self.ready_timeout
        while not self.ready.is_high():
            if self.clock() >= deadline:
                return False
            self.sleep(0.0005)
        return True

    def transfer(self, frame):
        """One transfer: sends the frame, returns the board's frame (or None, and counts why)."""
        if not self.wait_ready():
            self.stats["not_ready"] += 1
            return None
        reply = self.bus.transfer(encode(frame))
        # Give the board time to lower READY before the next wait_ready() looks at it.
        self.sleep(0.0005)
        got, why = decode(reply)
        if got is None or got.type != STATUS:
            self.stats["no_status" if got is None and why == "nothing" else "bad_reply"] += 1
            return None
        return got

    def status(self):
        """The board's status: a POLL, and what the board answered."""
        return self.transfer(Frame(POLL))

    def send(self, payload, attempts=ATTEMPTS):
        """True once the board has acknowledged the message."""
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if len(payload) > PAYLOAD_MAX:
            raise ValueError(f"message of {len(payload)} bytes; at most {PAYLOAD_MAX}")
        self.seq = (self.seq + 1) & 0xffff
        data = Frame(DATA, self.session, self.seq, 0, payload)
        for attempt in range(attempts):
            if attempt:
                self.stats["resent"] += 1
            self.transfer(data)
            got = self.status()
            if got is not None and got.session == self.session and got.ack == self.seq:
                self.stats["sent"] += 1
                return True
        self.stats["failed"] += 1
        return False


# ---- where the messages come from

class JsonlFollower:
    """New lines of messages.jsonl. A file that is there at startup is read from its end."""

    def __init__(self, path):
        self.path, self.f, self.buf = path, None, ""
        self._open(at_end=True)

    def _open(self, at_end=False):
        try:
            self.f = open(self.path, "r", encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return
        if at_end:
            self.f.seek(0, os.SEEK_END)
        self.buf = ""

    def lines(self):
        if self.f is None:
            self._open()
            if self.f is None:
                return []
        try:
            if os.stat(self.path).st_size < self.f.tell():      # truncated or replaced
                self.f.close()
                self._open()
        except FileNotFoundError:
            return []
        chunk = self.f.read()
        if not chunk:
            return []
        self.buf += chunk
        *out, self.buf = self.buf.split("\n")
        return [line.strip() for line in out if line.strip()]


def follow(link, follower, waiting=None, report_every=60.0, clock=time.monotonic, sleep=time.sleep,
           rounds=None):
    """Sends every new line; messages wait in order, in `waiting`, while the board is away."""
    if waiting is None:
        waiting = collections.deque(maxlen=MAX_WAITING)
    next_report = clock() + report_every
    n = 0
    while rounds is None or n < rounds:
        n += 1
        for line in follower.lines():
            if len(line.encode("utf-8")) > PAYLOAD_MAX:
                print(f"# skipped a message of {len(line.encode())} bytes (at most {PAYLOAD_MAX})", flush=True)
                link.stats["too_long"] += 1
                continue
            if len(waiting) == waiting.maxlen:
                link.stats["dropped"] += 1
            waiting.append(line)
        while waiting:
            if not link.send(waiting[0]):
                if not link.away:
                    print("# the board does not answer: messages wait here until it does", flush=True)
                link.away = True
                break
            if link.away:
                print("# the board answers again", flush=True)
                link.away = False
            waiting.popleft()
        if clock() >= next_report:
            s = link.stats
            print(f"# sent {s['sent']}, resent {s['resent']}, waiting {len(waiting)}, "
                  f"not ready {s['not_ready']}, bad replies {s['bad_reply']}", flush=True)
            next_report = clock() + report_every
        sleep(1.0 if link.away else 0.2)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--messages", default=os.path.join(HOME, ".cranium", "messages.jsonl"),
                    help="the collector's messages (default ~/.cranium/messages.jsonl)")
    ap.add_argument("--spi", default="0.0", help="SPI bus.device: /dev/spidev0.0 is 0.0 (CE0)")
    ap.add_argument("--hz", type=int, default=1_000_000, help="SPI clock (default 1 MHz)")
    ap.add_argument("--gpiochip", default="/dev/gpiochip0")
    ap.add_argument("--ready-gpio", type=int, default=25, help="the READY pin's GPIO number (default 25)")
    ap.add_argument("--no-ready", action="store_true", help="no READY wire: transfer without waiting")
    ap.add_argument("--send", metavar="MESSAGE", help="send this one message and exit")
    ap.add_argument("--status", action="store_true", help="print the board's status once and exit")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    bus_no, dev_no = (int(x) for x in args.spi.split("."))
    bus = SpidevBus(bus_no, dev_no, args.hz)
    ready = NoReady() if args.no_ready else GpiodReady(args.gpiochip, args.ready_gpio)
    link = Link(bus, ready)
    try:
        if args.status:
            got = link.status()
            print(got if got else f"no status frame: {dict(link.stats)}")
            return 0 if got else 1
        if args.send is not None:
            ok = link.send(args.send)
            print("sent" if ok else f"not acknowledged: {dict(link.stats)}")
            return 0 if ok else 1
        print(f"# following {args.messages}; SPI {args.spi} at {args.hz} Hz, "
              f"READY {'none' if args.no_ready else f'GPIO{args.ready_gpio}'}  (Ctrl+C to stop)", flush=True)
        follow(link, JsonlFollower(args.messages))
    except KeyboardInterrupt:
        pass
    finally:
        ready.close()
        bus.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
