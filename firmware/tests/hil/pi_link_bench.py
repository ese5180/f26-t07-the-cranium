#!/usr/bin/env python3
"""Hardware checks of the SPI link from the Raspberry Pi to the nRF7002 DK (docs/pi-link.md).

Runs on the Pi, wired to the DK as in docs/pi-link.md, with the DK's USB in the Pi as well, so
that it can read on the board's serial console what the board received:

    python3 firmware/tests/hil/pi_link_bench.py plan          show the steps; touches nothing
    python3 firmware/tests/hil/pi_link_bench.py run           all of them
    python3 firmware/tests/hil/pi_link_bench.py run --only deliver --only burst
    python3 firmware/tests/hil/pi_link_bench.py run --hz 4000000 --port /dev/ttyACM1
    python firmware/tests/hil/pi_link_bench.py run --pi cranium@10.0.0.65 --port COM13
                                                     the board's USB in this machine instead; SPI and
                                                     READY on the Pi, over SSH

Each step sends frames over SPI with pi/cranium_link.py and checks two things: what the board
answered on SPI, and what it printed on its console ("[PI] <message>" lines, and STATUS|pi).
Each step ends with PASS or FAIL and appends one line to results.jsonl in --out, as the other
benches do. Nothing here changes the board: no command it sends writes to flash.

Needs pyserial, python3-spidev and python3-libgpiod (all in Raspberry Pi OS).
"""

import argparse
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pi"))
sys.path.insert(0, str(REPO / "tools"))

import cranium_link as link_mod  # noqa: E402
from cranium_link import DATA, PAYLOAD_MAX, Frame, Link, decode, encode  # noqa: E402

# What the board prints of a message, at most (src/pi/pi_link.c, PRINT_MAX).
PRINT_MAX = 300
MESSAGE_LINE = "[PI] "


class StepFailed(AssertionError):
    pass


class BoardConsole:
    """What the steps need of the board's console: STATUS|pi, and the [PI] lines of messages."""

    def __init__(self, console):
        self.console = console
        self.seen = []

    def pi_status(self):
        from board import parse_key_values
        return parse_key_values(self.console.run("STATUS|pi"))

    def messages(self, count, timeout=3.0):
        """The next `count` messages the board printed, or fewer if the time runs out."""
        got = []
        for line in self.console.lines(time.time() + timeout):
            if line.startswith(MESSAGE_LINE + "{") or line.startswith(MESSAGE_LINE + "\""):
                got.append(line[len(MESSAGE_LINE):])
                if len(got) >= count:
                    break
        self.seen.extend(got)
        return got

    def quiet(self, seconds=0.5):
        """Messages printed in the next moments, which should be none."""
        return self.messages(1_000_000, timeout=seconds)


def count(status, key):
    value = status.get(key, "")
    try:
        return int(value.split()[0])
    except (ValueError, IndexError):
        raise StepFailed(f"STATUS|pi has no number for {key!r}: {status}")


def expect(condition, message):
    if not condition:
        raise StepFailed(message)


class Bench:
    def __init__(self, link, console, out=None, log=print):
        self.link, self.console, self.out, self.log = link, console, out, log

    # ---- the steps, in order
    def step_firmware(self):
        """The board's firmware has the link, and its thread runs (STATUS|pi)."""
        status = self.console.pi_status()
        expect("pi link" in status, "STATUS|pi has no 'pi link': is this firmware without the Pi link?")
        expect(not status["pi link"].startswith("not running"), f"the link does not run: {status['pi link']}")
        return status["pi link"]

    def step_ready(self):
        """READY is high: the board is armed and the READY wire (D9 to GPIO25) works."""
        expect(self.link.wait_ready(), "READY stayed low for 0.5 s: check the D9-GPIO25 wire and GND")
        return "high"

    def step_status(self):
        """A POLL gets the board's STATUS frame back: SCK, CS and MISO work."""
        got = self.link.status()
        expect(got is not None, f"no STATUS frame came back ({dict(self.link.stats)}): check SCK, CS, MISO")
        return f"session {got.session}, ack {got.ack}"

    def step_deliver(self):
        """A message is acknowledged on SPI, printed once on the console, and kept by STATUS|pi."""
        before = count(self.console.pi_status(), "pi messages")
        message = json.dumps({"t": "hb", "up": int(time.time()) % 100000, "mx": 1, "pl": 0},
                             separators=(",", ":"))
        expect(self.link.send(message), f"not acknowledged ({dict(self.link.stats)}): check MOSI")
        got = self.console.messages(1)
        expect(got == [message], f"the console printed {got!r}, not {message!r}")
        status = self.console.pi_status()
        expect(count(status, "pi messages") == before + 1, f"pi messages went from {before} to {status}")
        expect(status.get("pi last hb") == message, f"pi last hb is {status.get('pi last hb')!r}")
        return "acknowledged and printed"

    def step_utf8(self):
        """Titles with letters outside ASCII arrive as they were sent."""
        message = json.dumps({"t": "np", "ti": "Can’t Knock the Hustle", "ar": "Jaÿ‐Z", "ge": "Rap",
                              "bpm10": 948, "dur": 317}, ensure_ascii=False, separators=(",", ":"))
        expect(self.link.send(message), f"not acknowledged ({dict(self.link.stats)})")
        got = self.console.messages(1)
        expect(got == [message], f"the console printed {got!r}, not {message!r}")
        return "as sent"

    def step_repeat(self):
        """A message sent twice (its acknowledgement lost) is printed once."""
        before = count(self.console.pi_status(), "pi repeats")
        self.link.seq = (self.link.seq + 1) & 0xffff
        message = json.dumps({"t": "hb", "repeat": self.link.seq}, separators=(",", ":"))
        frame = Frame(DATA, self.link.session, self.link.seq, 0, message.encode())
        self.link.transfer(frame)
        self.link.transfer(frame)
        got = self.link.status()
        expect(got is not None and got.session == self.link.session and got.ack == self.link.seq,
               f"the board did not acknowledge it: {got}")
        printed = self.console.messages(2, timeout=1.5)
        expect(printed == [message], f"the console printed {printed!r}, not the message once")
        after = count(self.console.pi_status(), "pi repeats")
        expect(after == before + 1, f"pi repeats went from {before} to {after}")
        return "printed once"

    def step_corrupt(self):
        """A frame with a bad CRC is refused: nothing printed, the acknowledgement unchanged."""
        status = self.console.pi_status()
        before = count(status, "pi bad frames")
        acked = self.link.status()
        expect(acked is not None, "no STATUS frame before the bad one")
        bad = bytearray(encode(Frame(DATA, self.link.session, (self.link.seq + 1) & 0xffff, 0,
                                     b'{"t":"hb","bad":1}')))
        bad[14] ^= 0x20
        expect(self.link.wait_ready(), "READY stayed low")
        self.link.bus.transfer(bytes(bad))
        time.sleep(0.001)
        after_ack = self.link.status()
        expect(after_ack is not None and (after_ack.session, after_ack.ack) == (acked.session, acked.ack),
               f"the acknowledgement changed after a bad frame: {acked} then {after_ack}")
        printed = self.console.quiet()
        expect(printed == [], f"the board printed {printed!r} for a bad frame")
        after = count(self.console.pi_status(), "pi bad frames")
        expect(after == before + 1, f"pi bad frames went from {before} to {after}")
        return "refused"

    def step_largest(self):
        """The largest message a frame holds is acknowledged; the console prints its start."""
        head = '{"t":"big","p":"'
        message = head + "x" * (PAYLOAD_MAX - len(head) - 2) + '"}'
        expect(len(message.encode()) == PAYLOAD_MAX, "the test message is not the largest")
        expect(self.link.send(message), f"not acknowledged ({dict(self.link.stats)})")
        got = self.console.messages(1)
        expect(got == [message[:PRINT_MAX]], f"the console printed {got!r:.80}")
        return f"{PAYLOAD_MAX} bytes"

    def step_burst(self, n=100):
        """Many messages back to back: all acknowledged, all printed, in order."""
        start = time.monotonic()
        sent = []
        for i in range(n):
            message = json.dumps({"t": "hb", "burst": i}, separators=(",", ":"))
            expect(self.link.send(message), f"message {i} not acknowledged ({dict(self.link.stats)})")
            sent.append(message)
        seconds = max(time.monotonic() - start, 1e-3)
        printed = self.console.messages(n, timeout=5.0)
        expect(printed == sent, f"printed {len(printed)} of {n}; first difference at "
               f"{next((i for i, (a, b) in enumerate(zip(printed, sent)) if a != b), len(printed))}")
        return f"{n} messages in {seconds:.2f} s ({n / seconds:.0f}/s), resent {self.link.stats['resent']}"

    STEPS = ["firmware", "ready", "status", "deliver", "utf8", "repeat", "corrupt", "largest", "burst"]

    def run(self, only=None):
        results = []
        for name in self.STEPS:
            if only and name not in only:
                continue
            step = getattr(self, f"step_{name}")
            started = time.time()
            try:
                detail = step()
                verdict = "PASS"
            except StepFailed as e:
                detail, verdict = str(e), "FAIL"
            except Exception as e:  # noqa: BLE001 - a step that crashed failed, and the rest still run
                detail, verdict = f"{type(e).__name__}: {e}", "FAIL"
            result = {"step": name, "result": verdict, "detail": detail,
                      "seconds": round(time.time() - started, 2), "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
            results.append(result)
            self.log(f"{verdict}  {name:9} {detail}")
            if self.out is not None:
                with open(self.out / "results.jsonl", "a", encoding="utf-8") as f:
                    f.write(json.dumps(result, ensure_ascii=False) + "\n")
        return results


# ---- the Pi's SPI and READY from another machine (--pi): the board's USB console stays where it is

# Runs on the Pi, over one SSH session: "T <hex>" does a transfer and answers with what came back,
# "R" answers 1 if READY is high. Only spidev and gpiod, which Raspberry Pi OS has.
PI_HELPER = r"""
import sys, spidev, gpiod
from gpiod.line import Bias, Direction, Value
bus, dev, hz, chip, line = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
spi = spidev.SpiDev(); spi.open(int(bus), int(dev)); spi.mode = 0; spi.max_speed_hz = hz
req = gpiod.request_lines(chip, consumer="cranium-bench", config={
    line: gpiod.LineSettings(direction=Direction.INPUT, bias=Bias.PULL_DOWN)})
print("ready", flush=True)
for request in sys.stdin:
    word = request.split()
    if not word:
        continue
    if word[0] == "T":
        print(bytes(spi.xfer2(list(bytes.fromhex(word[1])))).hex(), flush=True)
    elif word[0] == "R":
        print(1 if req.get_value(line) == Value.ACTIVE else 0, flush=True)
    elif word[0] == "Q":
        break
req.release(); spi.close()
"""


class RemotePi:
    """SPI transfers and READY done on the Pi, through one SSH session to it."""

    def __init__(self, target, spi="0.0", hz=1_000_000, gpiochip="/dev/gpiochip0", ready_gpio=25):
        import base64
        import subprocess
        bus_no, dev_no = spi.split(".")
        code = base64.b64encode(PI_HELPER.encode()).decode()
        command = (f"python3 -u -c \"import base64; exec(base64.b64decode('{code}'))\" "
                   f"{bus_no} {dev_no} {hz} {gpiochip} {ready_gpio}")
        self.proc = subprocess.Popen(["ssh", "-o", "BatchMode=yes", target, command], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1)
        first = self.proc.stdout.readline().strip()
        if first != "ready":
            raise RuntimeError(f"the helper on {target} did not start ({first!r}): is SPI on, and the user in "
                               "the spi and gpio groups?")

    def call(self, request):
        self.proc.stdin.write(request + "\n")
        self.proc.stdin.flush()
        answer = self.proc.stdout.readline()
        if not answer:
            raise RuntimeError("the helper on the Pi stopped")
        return answer.strip()

    def transfer(self, data):
        return bytes.fromhex(self.call("T " + bytes(data).hex()))

    def is_high(self):
        return self.call("R") == "1"

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write("Q\n")
                self.proc.stdin.flush()
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001 - it is going away either way
                self.proc.kill()


def plan():
    for name in Bench.STEPS:
        doc = getattr(Bench, f"step_{name}").__doc__
        print(f"{name:9} {doc}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["plan", "run"])
    ap.add_argument("--only", action="append", choices=Bench.STEPS, help="run only this step (repeatable)")
    ap.add_argument("--port", help="the board's console (default: the J-Link's last virtual COM port)")
    ap.add_argument("--spi", default="0.0")
    ap.add_argument("--hz", type=int, default=1_000_000)
    ap.add_argument("--gpiochip", default="/dev/gpiochip0")
    ap.add_argument("--ready-gpio", type=int, default=25)
    ap.add_argument("--out", type=Path, default=Path("pi-link-bench"))
    ap.add_argument("--pi", metavar="USER@HOST",
                    help="run from another machine: the board's USB is here, and SPI and READY are done on the "
                         "Pi over SSH (key login). Each transfer then waits for the network: the burst's rate "
                         "is the network's, not the link's")
    args = ap.parse_args(argv)

    if args.command == "plan":
        plan()
        return 0

    from board import Console
    args.out.mkdir(parents=True, exist_ok=True)
    if args.pi:
        bus = ready = RemotePi(args.pi, args.spi, args.hz, args.gpiochip, args.ready_gpio)
    else:
        bus_no, dev_no = (int(x) for x in args.spi.split("."))
        bus = link_mod.SpidevBus(bus_no, dev_no, args.hz)
        ready = link_mod.GpiodReady(args.gpiochip, args.ready_gpio)
    console = Console(args.port)
    try:
        print(f"# board console {console.port}; SPI {args.spi} at {args.hz} Hz"
              f"{' on ' + args.pi if args.pi else ''}; READY GPIO{args.ready_gpio}; "
              f"results in {args.out}/results.jsonl")
        results = Bench(Link(bus, ready), BoardConsole(console), args.out).run(args.only)
    finally:
        console.close()
        ready.close()
        bus.close()
    failed = [r["step"] for r in results if r["result"] != "PASS"]
    print(f"\n{'FAILED: ' + ', '.join(failed) if failed else 'ALL PASSED'} ({len(results)} steps)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
