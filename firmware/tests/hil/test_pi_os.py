#!/usr/bin/env python3
"""Tests of Raspberry Pi OS updates with no board, no card and no Pi (docs/pi-os-update.md).

    /opt/nordic/ncs/toolchains/<id>/bin/python3 firmware/tests/hil/test_pi_os.py

- The board's real C code (src/pi/), built for the host as firmware/tests/host/build/pi_delta_harness
  (made here if it is missing): a "pi_os" job's download of an update file into the card's file area,
  with a lost connection, a power cut, a wrong SHA-256; then the board's end of the Pi's link.
- tools/pi_os_sim.py as the Pi's `cranium-update fetch`, the SPI controller, against that card: it
  says what it runs, asks what is offered, declines what is not for it, reads the file with resume,
  checks its SHA-256 and its manifest's Ed25519 signature, and says how it went.
- An update file as `cranium_ota.py make` writes one (pi/ on the tryboot branch): a tar of
  manifest.json, manifest.sig, boot.delta and root.delta. The board never looks inside it.
- A delta update's image (tools/pi_image.py, docs/pi-delta-update.md) and an OS update's file on one
  card, each taken by its own stand-in.

Every key here is made by the test, in a temporary directory, and thrown away with it. Needs the
`cryptography` package (the nRF Connect SDK's Python has it).
"""

import hashlib
import io
import json
import os
import random
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import pi_delta_sim as dsim  # noqa: E402
import pi_os_sim as sim  # noqa: E402

HOST = REPO / "firmware" / "tests" / "host"
HARNESS = HOST / "build" / "pi_delta_harness"


def build_harness() -> bool:
    env = dict(os.environ)
    env.setdefault("ZEPHYR_BASE", "/opt/nordic/ncs/v3.4.0/zephyr")
    result = subprocess.run(["make", "-C", str(HOST), "build/pi_delta_harness"], env=env,
                            capture_output=True, text=True)
    return result.returncode == 0 and HARNESS.exists()


def ed25519_key(directory: Path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = Ed25519PrivateKey.generate()
    public = directory / "pi_os_signing_pub.pem"
    public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,
                                                     serialization.PublicFormat.SubjectPublicKeyInfo))
    return key, public


def update_file(key, version: str, start: str | None, size: int = 120_000, seed: int = 1) -> bytes:
    """An update file as cranium_ota.py make lays it out; the deltas are random bytes here."""
    rng = random.Random(seed)
    boot, root = rng.randbytes(size // 4), rng.randbytes(size - size // 4)
    manifest = {"format": 1, "version": version, "block": 4096,
                "from": None if start is None else {"version": start, "boot": {}, "root": {}},
                "boot": {"sha256": hashlib.sha256(boot).hexdigest()},
                "root": {"sha256": hashlib.sha256(root).hexdigest()}}
    body = json.dumps(manifest, indent=1, sort_keys=True).encode()
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as tar:
        for name, data in (("manifest.json", body), ("manifest.sig", key.sign(body)),
                           ("boot.delta", boot), ("root.delta", root)):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


def fields(line: str) -> dict:
    """key=value pairs of a line; the reason runs to its end."""
    head, _, reason = line.partition(" reason=")
    out = dict(re.findall(r"(\w+)=(\S+)", head))
    out["reason"] = reason.strip()
    return out


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not build_harness():
            raise unittest.SkipTest("the host harness does not build (ZEPHYR_BASE?)")
        try:
            import cryptography  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("needs the cryptography package")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.key, self.pub = ed25519_key(self.dir)
        self.card = self.dir / "card.img"

    def tearDown(self):
        self.tmp.cleanup()

    def download(self, data: bytes, version: str, start: str | None, *options, sha: str | None = None) -> dict:
        path = self.dir / f"{version}-{len(data)}.update"
        path.write_bytes(data)
        result = subprocess.run([str(HARNESS), "os-update", str(self.card), str(path), version, start or "",
                                 sha or hashlib.sha256(data).hexdigest(), *map(str, options)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        return fields(result.stdout)

    def fetch(self, pi: sim.Pi, offer: bool = True, healthy: bool = True, budget=None, flip_every=0,
              messages_every=0, pubkey=True) -> tuple[str, dict, dict, sim.OsClient]:
        transport = dsim.HarnessTransport(HARNESS, self.card, flip_every, ("--offer",) if offer else ())
        messages = dsim.MessageSender(transport)
        client = sim.OsClient(transport, session=0x0505, messages=messages, messages_every=messages_every)
        try:
            outcome = sim.fetch(client, pi, self.pub if pubkey else None, healthy, budget)
        except dsim.BoardError as e:
            outcome = f"board: {e.name}"
        finally:
            lines = transport.close().strip().splitlines()
        counts = dict(re.findall(r"(\w+)=(\S+)", lines[0]))
        return outcome, counts, fields(lines[1]), client


class DownloadTests(Base):
    def test_the_file_whole_and_checked(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        got = self.download(data, "1.1.0", "1.0.0")
        self.assertEqual(got["result"], "ok")
        self.assertEqual((got["generation"], got["state"], got["bytes"], got["requests"]),
                         ("1", "2", str(len(data)), "1"))
        card = self.card.read_bytes()
        lba = int(got["lba"])
        self.assertEqual(card[lba * 512:lba * 512 + len(data)], data)
        # The same job again: nothing downloaded.
        got = self.download(data, "1.1.0", "1.0.0")
        self.assertEqual((got["result"], got["bytes"], got["generation"]), ("ok", "0", "1"))
        # Another job for it: offered anew.
        got = self.download(data, "1.1.0", "1.0.0", "--job", 2)
        self.assertEqual((got["result"], got["bytes"], got["generation"]), ("ok", "0", "2"))

    def test_resume_after_a_lost_connection_and_a_power_cut(self):
        data = update_file(self.key, "1.1.0", "1.0.0", size=200_000)
        got = self.download(data, "1.1.0", "1.0.0", "--drop-after", 70_000)
        self.assertEqual(got["result"], "download_failed")
        first = int(got["bytes"])
        got = self.download(data, "1.1.0", "1.0.0", "--cut-after-writes", 60)
        self.assertIn(got["result"], ("sd_absent", "sd_io"))
        second = int(got["bytes"])
        got = self.download(data, "1.1.0", "1.0.0")
        self.assertEqual(got["result"], "ok")
        # Only what was not on the card yet, give or take a save's worth each time.
        self.assertLess(first + second + int(got["bytes"]), len(data) + 2 * 65 * 512)

    def test_a_wrong_sha256_is_never_offered(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        got = self.download(data, "1.1.0", "1.0.0", sha="00" * 32)
        self.assertEqual(got["result"], "digest_mismatch")
        self.assertEqual(got["state"], "1")
        outcome, _, board, _ = self.fetch(sim.Pi(self.dir / "pi", "1.0.0"))
        self.assertEqual(outcome, "downloading")
        self.assertEqual(board["result"], "none")


class FetchTests(Base):
    def test_an_update_end_to_end(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        self.assertEqual(self.download(data, "1.1.0", "1.0.0")["result"], "ok")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        outcome, counts, board, client = self.fetch(pi)
        self.assertEqual(outcome, "confirmed")
        self.assertEqual((pi.state["version"], pi.state["slot"], pi.state["trial"]), ("1.1.0", "b", False))
        # The board kept the Pi's result with the file, and its last status.
        self.assertEqual((board["result"], board["read"]), ("confirmed", str(len(data))))
        self.assertEqual((board["os_version"], board["os_slot"], board["os_trial"], board["os_last"]),
                         ("1.1.0", "b", "0", "confirmed"))
        self.assertEqual(counts["refused"], "0")
        # About two transfers per 480 bytes: each carries the next request and brings the last answer.
        self.assertLess(client.transfers, len(data) // 480 + 40)
        # The next run finds nothing new to do; the board, restarted, still has the result.
        outcome, _, board, _ = self.fetch(pi)
        self.assertEqual((outcome, board["result"]), ("handled already", "confirmed"))

    def test_nothing_without_a_job(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        outcome, _, board, _ = self.fetch(pi, offer=False)
        self.assertEqual((outcome, board["read"], pi.state["version"]), ("nothing offered", "0", "1.0.0"))
        # The board still has its status.
        self.assertEqual(board["os_version"], "1.0.0")

    def test_a_pi_cut_off_half_way_goes_on(self):
        data = update_file(self.key, "1.1.0", "1.0.0", size=150_000)
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        outcome, _, _, first = self.fetch(pi, budget=120)
        self.assertEqual(outcome, "cut off")
        part = next((self.dir / "pi").glob("*.part"))
        self.assertGreater(part.stat().st_size, 40_000)
        outcome, _, board, second = self.fetch(pi)
        self.assertEqual((outcome, board["result"]), ("confirmed", "confirmed"))
        self.assertLess(first.transfers + second.transfers, len(data) // 480 * 2 + 60)

    def test_refused_before_reading(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "0.9.0")
        outcome, _, board, _ = self.fetch(pi)
        self.assertEqual((outcome, board["read"], board["result"]), ("refused", "0", "refused"))
        # The board keeps 32 characters of a reason.
        self.assertEqual(board["reason"], "a delta from 1.0.0, this Pi runs")
        self.assertEqual(pi.state["version"], "0.9.0")

    def test_not_newer(self):
        data = update_file(self.key, "1.1.0", None)
        self.download(data, "1.1.0", "")
        outcome, _, board, _ = self.fetch(sim.Pi(self.dir / "pi", "1.1.0"))
        self.assertEqual((outcome, board["result"]), ("refused", "refused"))
        self.assertEqual(board["reason"], "1.1.0 is not newer than 1.1.0")

    def test_a_bad_signature_is_refused(self):
        (self.dir / "other").mkdir()
        other, _ = ed25519_key(self.dir / "other")
        data = update_file(other, "1.1.0", "1.0.0")
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        outcome, _, board, _ = self.fetch(pi)
        self.assertEqual((outcome, board["result"], board["read"]), ("refused", "refused", str(len(data))))
        self.assertEqual(board["reason"], "the signature does not match")
        self.assertEqual(pi.state["version"], "1.0.0")

    def test_rolled_back(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        outcome, _, board, _ = self.fetch(pi, healthy=False)
        self.assertEqual(outcome, "rolled_back")
        self.assertEqual((pi.state["version"], pi.state["slot"]), ("1.0.0", "a"))
        self.assertEqual((board["result"], board["reason"]), ("rolled_back", "health check failed"))
        self.assertEqual((board["os_version"], board["os_last"]), ("1.0.0", "rolled_back"))

    def test_a_full_image(self):
        data = update_file(self.key, "2.0.0", None)
        self.assertEqual(self.download(data, "2.0.0", "")["result"], "ok")
        pi = sim.Pi(self.dir / "pi", "1.4.0")
        outcome, _, board, _ = self.fetch(pi)
        self.assertEqual((outcome, board["result"], pi.state["version"]), ("confirmed", "confirmed", "2.0.0"))

    def test_a_noisy_wire_and_messages_beside(self):
        data = update_file(self.key, "1.1.0", "1.0.0", size=60_000)
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        outcome, counts, board, client = self.fetch(pi, flip_every=37, messages_every=3)
        self.assertEqual((outcome, board["result"]), ("confirmed", "confirmed"))
        self.assertGreater(client.retries, 0)
        self.assertGreater(int(counts["delivered"]), 0)
        self.assertEqual(counts["duplicates"], "0")

    def test_a_result_the_board_did_not_take_is_sent_again(self):
        data = update_file(self.key, "1.1.0", "1.0.0")
        self.download(data, "1.1.0", "1.0.0")
        pi = sim.Pi(self.dir / "pi", "1.0.0")
        # A RESULT the Pi kept unanswered, as if it restarted before the board answered it.
        info_generation = 1
        pi.state["pending"] = {"code": sim.REFUSED, "generation": info_generation, "version": "1.1.0",
                               "reason": "kept from before"}
        pi.save()
        outcome, _, board, _ = self.fetch(pi)
        self.assertEqual((outcome, board["result"], board["reason"]),
                         ("handled already", "refused", "kept from before"))

    def test_malformed_requests(self):
        data = update_file(self.key, "1.1.0", "1.0.0", size=5000)
        self.download(data, "1.1.0", "1.0.0")
        end = len(data).to_bytes(4, "little")
        transport = dsim.HarnessTransport(HARNESS, self.card, 0, ("--offer",))
        client = sim.OsClient(transport)
        codes = []
        for kind, payload in ((sim.FILE_READ, b"\0" * 8),
                              (sim.FILE_READ, (0).to_bytes(4, "little") + (481).to_bytes(2, "little") + b"\0\0"),
                              (sim.FILE_READ, end + (1).to_bytes(2, "little") + b"\0\0"),
                              (sim.FILE_READ, b"\0" * 7),
                              (sim.RESULT, b"\x09" + b"\0" * 39),
                              (sim.RESULT, b"\x01\x05" + b"\0" * 38),
                              (sim.OS_STATUS, b"c" + b"\0" * 67),
                              (sim.OS_STATUS, b"a" + b"\0" * 66)):
            try:
                client.request(kind, payload)
                codes.append("answered")
            except dsim.BoardError as e:
                codes.append(e.name)
        board = transport.close()
        self.assertEqual(codes, ["bad_request", "bad_request", "out_of_range", "bad_request",
                                 "bad_request", "bad_request", "bad_request", "bad_request"])
        self.assertIn("refused=8", board)


class BothKindsTests(Base):
    def test_a_delta_image_and_an_os_file_on_one_card(self):
        import pi_image as pimg
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        ecdsa = ec.generate_private_key(ec.SECP256R1())
        private = self.dir / "fw.pem"
        private.write_bytes(ecdsa.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()))
        point = ecdsa.public_key().public_bytes(serialization.Encoding.X962,
                                                serialization.PublicFormat.UncompressedPoint).hex()
        image = random.Random(5).randbytes(64 * 4096)
        img = self.dir / "pi.img"
        img.write_bytes(image)
        pkg = self.dir / "pi.img.cpd"
        pimg.write_package(img, pkg, "img-1", pimg.load_private(private), block_size=4096)
        done = subprocess.run([str(HARNESS), "update", str(self.card), str(pkg), "img-1",
                               hashlib.sha256(image).hexdigest(), point, "--card-sectors", str(16384 + 8192)],
                              capture_output=True, text=True, timeout=120)
        self.assertIn("result=ok", done.stdout, done.stderr)

        data = update_file(self.key, "1.1.0", "1.0.0")
        got = self.download(data, "1.1.0", "1.0.0")
        self.assertEqual(got["result"], "ok")
        # Past the mirror's image (the harness lays a new card out for 1024 blocks).
        self.assertGreaterEqual(int(got["lba"]) * 512, pimg.card_layout(1024)["mirror"] * 512 + len(image))

        # The delta image is as it was: its stand-in takes it whole.
        transport = dsim.HarnessTransport(HARNESS, self.card)
        try:
            taken, _ = dsim.take_update(dsim.PiClient(transport), b"", "")
        finally:
            transport.close()
        self.assertEqual(taken, image)
        # And the OS file goes to the Pi.
        outcome, _, board, _ = self.fetch(sim.Pi(self.dir / "pi", "1.0.0"))
        self.assertEqual((outcome, board["result"]), ("confirmed", "confirmed"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
