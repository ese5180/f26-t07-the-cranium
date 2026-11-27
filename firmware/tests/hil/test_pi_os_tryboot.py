#!/usr/bin/env python3
"""Raspberry Pi OS updates through the board, against the Pi's own update tool (docs/pi-os-update.md).

    /opt/nordic/ncs/toolchains/<id>/bin/python3 firmware/tests/hil/test_pi_os_tryboot.py

test_pi_os.py checks the board with update files laid out as `cranium_ota.py make` lays them out.
This one takes the Pi's real `pi/cranium_ota.py`, from the tryboot branch (docs/pi-tryboot.md), and
runs it on both ends of the board:

- `make` builds and signs a real update (throwaway Ed25519 key, small boot and root images, as the
  Pi's own tests do), the board's C code (pi_delta_harness, as test_pi_os.py builds it) downloads it
  onto its card and offers it, and it is read back whole over FILE_READ;
- `apply` checks the bytes the board served (signature, parts, starting point, newer) and rebuilds the
  spare slot from them, on files that stand for the card's partitions, as the Pi's tests do; `confirm`
  keeps or rolls back the trial; `status` goes to the board as OS_STATUS, and each outcome as RESULT;
- `pi/cranium_link.py` (the message link's sender, in this tree since PR #58) sends between those
  requests, and its `--status` runs right after one.

What `cranium-update fetch` will do between them (the frames, and the words of `status` mapped to
RESULT's and OS_STATUS's codes) is this file's, as docs/pi-os-update.md describes it.

Nothing of the tryboot branch is copied into this tree. `cranium_ota.py` is read when the tests run,
from CRANIUM_OTA_PY (a path) or with `git show origin/feature/tryboot:pi/cranium_ota.py` (another ref:
CRANIUM_OTA_REF), into a temporary directory; without it, the tests are skipped and say so. Needs the
openssl command with Ed25519 (OpenSSL 3 or later), as the Pi's tool does.
"""

import contextlib
import hashlib
import importlib.util
import io
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pi_delta_sim as dsim  # noqa: E402
import pi_os_sim as sim  # noqa: E402
from test_pi_os import HARNESS, build_harness, fields  # noqa: E402

sys.path.insert(0, str(REPO / "pi"))
import cranium_link  # noqa: E402  (the Pi's sender, read only: pi/ is the Pi side's)

BLOCK = 4096
REF = os.environ.get("CRANIUM_OTA_REF", "origin/feature/tryboot")
# What the Pi's `status` and `apply` say, as RESULT's and OS_STATUS's codes (docs/pi-os-update.md).
RESULT_OF = {"applied": sim.APPLIED, "confirmed": sim.CONFIRMED, "rolled back": sim.ROLLED_BACK,
             "refused": sim.REFUSED}
LAST_OF = {None: 0, "confirmed": sim.CONFIRMED, "rolled back": sim.ROLLED_BACK}
# What the board keeps of a RESULT's reason (PI_OS_REASON_MAX).
REASON_KEPT = 32


def load_cranium_ota(into: Path):
    """The Pi's cranium_ota.py as a module, or the reason it is not there."""
    path = os.environ.get("CRANIUM_OTA_PY")
    if path:
        source = Path(path)
        if not source.is_file():
            return None, f"CRANIUM_OTA_PY={path} is not a file"
    else:
        got = subprocess.run(["git", "-C", str(REPO), "show", f"{REF}:pi/cranium_ota.py"],
                             capture_output=True)
        if got.returncode != 0:
            return None, (f"the Pi's pi/cranium_ota.py is not here: fetch {REF} "
                          "(git fetch origin feature/tryboot) or set CRANIUM_OTA_PY to its path")
        source = into / "cranium_ota.py"
        source.write_bytes(got.stdout)
    spec = importlib.util.spec_from_file_location("cranium_ota", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, None


def openssl_key(directory: Path, name: str):
    key, pub = directory / f"{name}.pem", directory / f"{name}_pub.pem"
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(key)], check=True,
                   capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(pub)], check=True,
                   capture_output=True)
    return key, pub


def changed(data: bytes, blocks, seed: int) -> bytes:
    out = bytearray(data)
    for b in blocks:
        out[b * BLOCK:(b + 1) * BLOCK] = hashlib.sha256(b"%d-%d" % (seed, b)).digest() * (BLOCK // 32)
    return bytes(out)


class Base(unittest.TestCase):
    SIZE_BOOT, SIZE_ROOT = 16 * BLOCK, 48 * BLOCK
    MARKER_AT = 5 * BLOCK + 100

    @classmethod
    def setUpClass(cls):
        cls.loaded = Path(tempfile.mkdtemp(prefix="cranium-ota-"))
        cls.ota, why = load_cranium_ota(cls.loaded)
        if cls.ota is None:
            raise unittest.SkipTest(why)
        if shutil.which("openssl") is None:
            raise unittest.SkipTest("needs the openssl command (OpenSSL 3 or later, for Ed25519)")
        try:
            cls.key, cls.pub = openssl_key(cls.loaded, "team")
            cls.stranger, _ = openssl_key(cls.loaded, "stranger")
        except subprocess.CalledProcessError:
            raise unittest.SkipTest("this openssl has no Ed25519: needs OpenSSL 3 or later")
        if not build_harness():
            raise unittest.SkipTest("the host harness does not build (ZEPHYR_BASE?)")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.loaded, ignore_errors=True)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.board_card = self.dir / "board-card.img"
        # The Pi's card, as the Pi's own tests lay it out: slot A runs 1.0.0, slot B is empty.
        for name in ("dt", "autoboot", "data"):
            (self.dir / name).mkdir()
        self.conf = dict(self.ota.DEFAULTS)
        self.conf.update({
            "CRANIUM_OTA_DISK": str(self.dir / "disk"),
            "CRANIUM_OTA_AUTOBOOT": str(self.dir / "autoboot" / "autoboot.txt"),
            "CRANIUM_OTA_STATE": str(self.dir / "data" / "cranium-ota" / "state.json"),
            "CRANIUM_OTA_BOOTLOADER_DT": str(self.dir / "dt"),
            "CRANIUM_OTA_VERSION_FILE": str(self.dir / "cranium-os"),
            "CRANIUM_OTA_PUBKEY": str(self.pub),
            "CRANIUM_OTA_WORKDIR": str(self.dir / "data"),
        })
        self.card = self.ota.Card(self.conf)
        boot = bytearray(hashlib.sha256(b"boot").digest() * (self.SIZE_BOOT // 32))
        marker = self.ota.MARKER + b"a"
        boot[self.MARKER_AT:self.MARKER_AT + len(marker)] = marker
        self.v1 = {"boot": bytes(boot), "root": hashlib.sha256(b"root").digest() * (self.SIZE_ROOT // 32)}
        for name in ("boot", "root"):
            Path(self.card.part("a", name)).write_bytes(self.v1[name])
            Path(self.card.part("b", name)).write_bytes(bytes(BLOCK))
            (self.dir / f"1.0.0.{name}").write_bytes(self.v1[name])
        self.versions = {"a": "1.0.0", "b": None}
        self.card.write_autoboot(default_slot="a", try_slot="b")
        self.boot_from("a", tryboot=False)

    def tearDown(self):
        self.tmp.cleanup()

    # ---- the Pi
    def boot_from(self, slot: str, tryboot: bool):
        """What the bootloader tells Linux (the device tree), and the booted root's /etc/cranium-os."""
        for name, value in (("partition", {"a": 2, "b": 3}[slot]), ("tryboot", int(tryboot))):
            (self.dir / "dt" / name).write_bytes(struct.pack(">I", value))
        (self.dir / "cranium-os").write_text((self.versions[slot] or "") + "\n")

    def make(self, version: str, delta_from: str | None = "1.0.0", key: Path | None = None) -> Path:
        """`cranium_ota.py make`, on its command line: a delta from 1.0.0, or a full image."""
        new = {"boot": changed(self.v1["boot"], [0], seed=len(version)),
               "root": changed(self.v1["root"], [1, 2, 40], seed=len(version))}
        for name in ("boot", "root"):
            (self.dir / f"{version}.{name}").write_bytes(new[name])
        out = self.dir / f"{version}.update"
        argv = ["make", "--version", version, "--boot", str(self.dir / f"{version}.boot"),
                "--root", str(self.dir / f"{version}.root"), "--key", str(key or self.key), "--out", str(out)]
        if delta_from:
            argv += ["--from-version", delta_from, "--from-boot", str(self.dir / f"{delta_from}.boot"),
                     "--from-root", str(self.dir / f"{delta_from}.root")]
        with contextlib.redirect_stdout(io.StringIO()) as said:
            self.assertEqual(self.ota.main(argv), 0)
        self.assertIn(f"{out}: {version}, ", said.getvalue())
        return out

    def status_frame(self) -> bytes:
        """`cranium-update status` as OS_STATUS's payload."""
        s = self.ota.status(self.card)
        last = s["last"] or {}
        return struct.pack("<BBBB32s32s", ord(s["slot"]), ord(s["default"] or "\0"), int(s["trial"]),
                           LAST_OF[last.get("result")], (s["version"] or "").encode(),
                           (last.get("version") or "").encode())

    # ---- the board
    def download(self, update: Path, version: str, start: str | None) -> dict:
        data = update.read_bytes()
        got = subprocess.run([str(HARNESS), "os-update", str(self.board_card), str(update), version, start or "",
                              hashlib.sha256(data).hexdigest()], capture_output=True, text=True, timeout=120)
        self.assertEqual(got.returncode, 0, got.stderr)
        out = fields(got.stdout)
        self.assertEqual((out["result"], out["state"], out["bytes"]), ("ok", "2", str(len(data))))
        return out

    @contextlib.contextmanager
    def link(self, offer: bool = True, messages_every: int = 0):
        """The board serving its card; the Pi's sender and fetch's requests on its one link."""
        transport = dsim.HarnessTransport(HARNESS, self.board_card, 0, ("--offer",) if offer else ())
        sender = cranium_link.Link(transport, cranium_link.NoReady(), session=0x4D4D, sleep=lambda _: None)
        client = sim.OsClient(transport, session=0x0505, messages=sender, messages_every=messages_every)
        board = {}
        try:
            yield client, sender, transport
        finally:
            lines = transport.close().strip().splitlines()
            board.update(dict(re.findall(r"(\w+)=(\S+)", lines[0])))
            board.update(fields(lines[1]))
            self.board = board

    def read_all(self, client) -> tuple[dict, bytes]:
        info = client.file_info()
        self.assertEqual(info["state"], sim.OFFERED)
        out = io.BytesIO()
        self.assertEqual(client.read_file(info["generation"], info["size"], 0, out), info["size"])
        data = out.getvalue()
        self.assertEqual(hashlib.sha256(data).digest(), info["sha256"])
        return info, data

    def result(self, client, word: str, info: dict, reason: str = "") -> bool:
        return client.result(RESULT_OF[word], info["generation"], info["version"], reason)


class EndToEnd(Base):
    def test_his_update_through_the_board_applied_and_confirmed(self):
        update = self.make("1.1.0")
        self.download(update, "1.1.0", "1.0.0")
        with self.link() as (client, sender, _):
            client.request(sim.OS_STATUS, self.status_frame())
            info = client.file_info()
            self.assertEqual((info["version"], info["from"], info["flags"] & sim.FLAG_FULL), ("1.1.0", "1.0.0", 0))
            # The manifest first, as phase 2 asks: the tar's first two members, read and checked
            # with the Pi's own verify() before the rest is fetched.
            head = io.BytesIO()
            client.read_file(info["generation"], min(info["size"], 4096), 0, head)
            with tarfile.open(fileobj=io.BytesIO(head.getvalue()), mode="r|") as tar:
                members = {}
                for member in tar:
                    members[member.name] = tar.extractfile(member).read()
                    if len(members) == 2:
                        break
            self.assertEqual(sorted(members), ["manifest.json", "manifest.sig"])
            self.assertTrue(self.ota.verify(members["manifest.json"], members["manifest.sig"], str(self.pub)))
            info, data = self.read_all(client)
            self.assertEqual(data, update.read_bytes())
            served = self.dir / "data" / "served.update"
            served.write_bytes(data)
            # apply, on the bytes the board served: signature, parts, starting point, newer.
            log = []
            spare = self.ota.apply_update(self.card, self.conf, str(served), reboot=False, log=log.append)
            self.assertEqual(spare, "b")
            for name in ("boot", "root"):
                size = os.path.getsize(self.dir / f"1.1.0.{name}")
                self.assertEqual(self.ota.release_hash(self.card.part("b", name), size, name),
                                 hashlib.sha256((self.dir / f"1.1.0.{name}").read_bytes()).hexdigest())
            self.assertTrue(self.result(client, "applied", info))
        self.assertEqual((self.board["result"], self.board["read"]), ("applied", str(info["size"])))

        # The restart into slot B on trial, as `reboot '0 tryboot'` makes it; a new run of fetch.
        self.versions["b"] = "1.1.0"
        self.boot_from("b", tryboot=True)
        with self.link() as (client, _, _):
            client.request(sim.OS_STATUS, self.status_frame())
        self.assertEqual((self.board["os_slot"], self.board["os_trial"], self.board["os_version"]),
                         ("b", "1", "1.1.0"))

        # confirm, at that boot: healthy, so slot B is kept. The Pi stays on this boot (its
        # device tree still says tryboot) until it next restarts.
        self.assertEqual(self.ota.confirm(self.card, self.conf, reboot=False, log=log.append,
                                          check=lambda conf, log: True), "confirmed")
        s = self.ota.status(self.card)
        self.assertEqual((s["slot"], s["default"], s["trial"], s["last"]["result"]), ("b", "b", True, "confirmed"))
        with self.link() as (client, _, _):
            self.assertTrue(self.result(client, s["last"]["result"], info))
            client.request(sim.OS_STATUS, self.status_frame())
        # Kept: the running slot is the one [all] boots, so the board counts it off trial, although
        # `status` says trial until that restart.
        self.assertEqual((self.board["result"], self.board["os_slot"], self.board["os_trial"],
                          self.board["os_last"], self.board["os_version"]),
                         ("confirmed", "b", "0", "confirmed", "1.1.0"))

        # And after the Pi's next restart, slot B from [all].
        self.boot_from("b", tryboot=False)
        with self.link() as (client, _, _):
            client.request(sim.OS_STATUS, self.status_frame())
            self.assertEqual(client.file_info()["result"], sim.CONFIRMED)
        self.assertEqual((self.board["os_slot"], self.board["os_trial"], self.board["os_last"]), ("b", "0", "confirmed"))

    def test_a_failed_trial_rolls_back_and_the_board_hears_it(self):
        update = self.make("1.1.0")
        self.download(update, "1.1.0", "1.0.0")
        with self.link() as (client, _, _):
            info, data = self.read_all(client)
            (self.dir / "data" / "served.update").write_bytes(data)
            self.ota.apply_update(self.card, self.conf, str(self.dir / "data" / "served.update"), reboot=False,
                                  log=lambda _: None)
            self.result(client, "applied", info)
        self.versions["b"] = "1.1.0"
        self.boot_from("b", tryboot=True)
        self.assertEqual(self.ota.confirm(self.card, self.conf, reboot=False, log=lambda _: None,
                                          check=lambda conf, log: False), "failed")
        # The reboot after a failed check: [all] still names slot A.
        self.boot_from("a", tryboot=False)
        self.assertEqual(self.ota.confirm(self.card, self.conf, reboot=False, log=lambda _: None), "normal")
        s = self.ota.status(self.card)
        self.assertEqual((s["slot"], s["version"], s["last"]["result"], s["last"]["version"]),
                         ("a", "1.0.0", "rolled back", "1.1.0"))
        with self.link() as (client, _, _):
            self.assertTrue(self.result(client, s["last"]["result"], info, "health check failed"))
            client.request(sim.OS_STATUS, self.status_frame())
        self.assertEqual((self.board["result"], self.board["reason"], self.board["os_slot"], self.board["os_trial"],
                          self.board["os_last"], self.board["os_version"]),
                         ("rolled_back", "health check failed", "a", "0", "rolled_back", "1.0.0"))

    def test_a_full_image(self):
        update = self.make("2.0.0", delta_from=None)
        self.download(update, "2.0.0", None)
        with self.link() as (client, _, _):
            info, data = self.read_all(client)
            self.assertEqual((info["from"], info["flags"] & sim.FLAG_FULL), ("", sim.FLAG_FULL))
            (self.dir / "data" / "served.update").write_bytes(data)
            self.assertEqual(self.ota.apply_update(self.card, self.conf, str(self.dir / "data" / "served.update"),
                                                   reboot=False, log=lambda _: None), "b")
            self.assertTrue(self.result(client, "applied", info))

    def refused(self, update: Path) -> str:
        """apply refuses what the board served: RESULT refused, with apply's own words."""
        self.download(update, "1.1.0", "1.0.0")
        with self.link() as (client, _, _):
            info, data = self.read_all(client)
            (self.dir / "data" / "served.update").write_bytes(data)
            with self.assertRaises(self.ota.UpdateError) as refused:
                self.ota.apply_update(self.card, self.conf, str(self.dir / "data" / "served.update"),
                                      reboot=False, log=lambda _: None)
            reason = str(refused.exception)
            self.assertTrue(self.result(client, "refused", info, reason))
        self.assertEqual(self.board["result"], "refused")
        # The board keeps the reason's first REASON_KEPT bytes (ASCII, as apply's are).
        self.assertEqual(self.board["reason"], reason.encode()[:REASON_KEPT].decode().strip())
        self.assertEqual(self.card.default_slot(), "a")
        return reason

    def test_signed_with_another_key_is_refused(self):
        self.assertIn("signature does not match", self.refused(self.make("1.1.0", key=self.stranger)))

    def test_not_newer_is_refused(self):
        self.versions["a"] = "1.2.0"
        self.boot_from("a", tryboot=False)
        self.assertIn("is not newer than the running 1.2.0", self.refused(self.make("1.1.0")))

    def test_another_starting_point_is_refused(self):
        Path(self.card.part("a", "root")).write_bytes(changed(self.v1["root"], [9], seed=7))
        self.assertIn("this delta does not apply to it", self.refused(self.make("1.1.0")))


class SharedLink(Base):
    def test_his_sender_between_the_requests_of_a_whole_update(self):
        update = self.make("1.1.0")
        self.download(update, "1.1.0", "1.0.0")
        with self.link(messages_every=1) as (client, sender, _):
            client.request(sim.OS_STATUS, self.status_frame())
            info, data = self.read_all(client)
            self.assertEqual(data, update.read_bytes())
            self.assertTrue(self.result(client, "applied", info))
            self.assertTrue(sender.send('{"t":"np","ti":"Strobe","ar":"deadmau5","ge":"","bpm10":1280,"dur":600}'))
        self.assertEqual(sender.stats["sent"], client.asked + 1)
        self.assertEqual((sender.stats["resent"], sender.stats["failed"], client.retries), (0, 0, 0))
        self.assertEqual((self.board["delivered"], self.board["duplicates"]), (str(client.asked + 1), "0"))

    def test_his_status_right_after_an_os_request(self):
        """`cranium-link --status` is one POLL, and only STATUS will do: right after a request whose answer
        nobody took, it reads that answer, prints that it found no status and exits 1. The next one passes."""
        update = self.make("1.1.0")
        self.download(update, "1.1.0", "1.0.0")
        with self.link() as (client, _, transport):
            class Bus:
                def __init__(self, *args):
                    pass

                transfer = staticmethod(transport.transfer)

                def close(self):
                    pass

            def status_command():
                with mock_attr(cranium_link, "SpidevBus", Bus), \
                        contextlib.redirect_stdout(io.StringIO()) as out:
                    code = cranium_link.main(["--status", "--no-ready"])
                return code, out.getvalue().strip()

            transport.transfer(dsim.encode(sim.FILE_INFO, 0x0505, 77))     # fetch stopped half way
            code, said = status_command()
            self.assertEqual((code, said), (1, "no status frame: {'bad_reply': 1}"))
            code, said = status_command()
            self.assertEqual(code, 0, said)
            self.assertIn("type=0x81", said)
            # A whole request in between, which ends with the POLL that takes its answer, is no trouble.
            client.file_info()
            self.assertEqual(status_command()[0], 0)


@contextlib.contextmanager
def mock_attr(owner, name, value):
    old = getattr(owner, name)
    setattr(owner, name, value)
    try:
        yield
    finally:
        setattr(owner, name, old)


if __name__ == "__main__":
    unittest.main()
