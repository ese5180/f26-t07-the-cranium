#!/usr/bin/env python3
"""Tests of Raspberry Pi delta updates with no board, no card and no Pi (docs/pi-delta-update.md).

    python3 firmware/tests/hil/test_pi_delta.py

- tools/pi_image.py: the package, its signature, its checks, the comparison and the card it writes.
- The board's real C code (src/pi/), built for the host as firmware/tests/host/build/pi_delta_harness
  (made here if it is missing): an update from packages this tool signed, checked with MCUboot's own
  ECDSA against the test's key, onto a card in a file.
- tools/pi_delta_sim.py as the Pi, the SPI controller, against that card: it takes only the blocks
  that changed and ends with the new image's SHA-256.
- The link the requests share with the Pi's messages (src/pi/pi_link.c, docs/pi-link.md): messages
  between the requests, and pi/cranium_link.py itself, the Pi's sender, beside them.

Every key here is made by the test, in a temporary directory, and thrown away with it.
"""

import hashlib
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import pi_delta_sim as sim  # noqa: E402
import pi_image as pi  # noqa: E402

sys.path.insert(0, str(REPO / "pi"))
import cranium_link  # noqa: E402  (the Pi's sender, read only: pi/ is the Pi side's)

HOST = REPO / "firmware" / "tests" / "host"
HARNESS = HOST / "build" / "pi_delta_harness"
MAX_BLOCKS = 1024


def build_harness() -> bool:
    if HARNESS.exists():
        return True
    env = dict(os.environ)
    env.setdefault("ZEPHYR_BASE", "/opt/nordic/ncs/v3.4.0/zephyr")
    result = subprocess.run(["make", "-C", str(HOST), "build/pi_delta_harness"], env=env,
                            capture_output=True, text=True)
    return result.returncode == 0 and HARNESS.exists()


def make_key(directory: Path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    private = directory / "key.pem"
    public = directory / "key_pub.pem"
    private.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,
                                                     serialization.PublicFormat.SubjectPublicKeyInfo))
    return private, public


def image_bytes(seed: int, size: int) -> bytearray:
    rng = random.Random(seed)
    data = bytearray(rng.randbytes(size))
    # Free space in a disk image is zeros: three 4 KiB blocks of it, a third of the way in.
    start = size // 3 // 4096 * 4096
    end = min(size, start + 3 * 4096)
    data[start:end] = bytes(end - start)
    return data


def changed(data: bytearray, block: int, block_size: int, value: int):
    out = bytearray(data)
    start = block * block_size + 77
    out[start:start + 300] = bytes([value]) * 300
    return out


class Base(unittest.TestCase):
    block_size = 4096
    size = 256 * 4096

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pi-delta-"))
        self.private, self.public = make_key(self.tmp)
        self.key = pi.load_private(self.private)
        self.point = pi.public_point(self.public).hex()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def package(self, data: bytes, version: str, key=None, block_size=None) -> tuple[Path, pi.Manifest]:
        image = self.tmp / f"{version}.img"
        image.write_bytes(data)
        out = self.tmp / f"{version}.cpd"
        manifest = pi.write_package(image, out, version, key or self.key, block_size or self.block_size)
        return out, manifest


class PackageTests(Base):
    def test_package_layout_and_signature(self):
        data = image_bytes(1, 70 * 1024)
        out, m = self.package(data, "2026.11.24-1", block_size=64 * 1024)
        raw = out.read_bytes()
        self.assertEqual(raw[:4], b"CPDM")
        self.assertEqual(struct.unpack_from("<HHIIQQQ", raw, 4), (1, 512, 65536, 2, len(data), 512, 4096))
        self.assertEqual(raw[40:72], hashlib.sha256(data).digest())
        table = raw[512:512 + 64]
        self.assertEqual(table[:32], hashlib.sha256(data[:65536]).digest())
        self.assertEqual(table[32:], hashlib.sha256(data[65536:]).digest())
        self.assertEqual(raw[72:104], hashlib.sha256(table).digest())
        self.assertEqual(raw[104:136].rstrip(b"\0"), b"2026.11.24-1")
        self.assertEqual(raw[136:448], bytes(312))
        self.assertEqual(raw[4096:], bytes(data))
        decoded = pi.Manifest.decode(raw)
        self.assertEqual(decoded.block_len(1), len(data) - 65536)
        self.assertTrue(pi.verify_signature(raw[:448], raw[448:512], pi.load_public(self.public)))
        self.assertEqual(pi.verify_package(out, pi.load_public(self.public)), [])

    def test_verify_finds_what_is_wrong(self):
        data = image_bytes(2, 64 * 4096)
        out, m = self.package(data, "v1")
        public = pi.load_public(self.public)
        raw = bytearray(out.read_bytes())

        bad = self.tmp / "bad.cpd"
        broken = bytearray(raw)
        broken[m.image_offset + 5 * 4096 + 1] ^= 1
        bad.write_bytes(broken)
        self.assertIn("block 5 does not match its hash", pi.verify_package(bad, public))

        broken = bytearray(raw)
        broken[512 + 3] ^= 1
        bad.write_bytes(broken)
        self.assertIn("the table is not the one the header signs", pi.verify_package(bad, public))

        other_private, other_public = make_key(Path(tempfile.mkdtemp(dir=self.tmp)))
        self.assertIn("the signature does not hold", pi.verify_package(out, pi.load_public(other_public)))

    def test_refusals(self):
        image = self.tmp / "odd.img"
        image.write_bytes(bytes(1000))
        with self.assertRaises(ValueError):
            pi.build_manifest(image, "v1")
        image.write_bytes(bytes(4096))
        for version in ("", "a b", "x" * 32, "é"):
            with self.assertRaises(ValueError):
                pi.build_manifest(image, version)
        for block_size in (2048, 3 * 4096, 2 * 1024 * 1024):
            with self.assertRaises(ValueError):
                pi.build_manifest(image, "v1", block_size)

        out, m = self.package(bytes(8192), "v1")
        raw = out.read_bytes()
        for at, value in ((0, ord("X")), (12, 9), (16, 1), (25, 0), (104, ord("/")), (136, 1), (300, 1)):
            broken = bytearray(raw[:512])
            broken[at] = value
            with self.assertRaises(ValueError):
                pi.Manifest.decode(bytes(broken))

    def test_comparison_and_estimate(self):
        v1 = image_bytes(3, 64 * 4096)
        v2 = changed(changed(changed(v1, 0, 4096, 1), 10, 4096, 2), 11, 4096, 3)
        p1, _ = self.package(v1, "v1")
        p2, _ = self.package(v2, "v2")
        self.assertEqual(pi.changed_blocks(pi.read_package(p1), pi.read_package(p2)), [0, 10, 11])
        est = pi.download_estimate(pi.read_package(p1), pi.read_package(p2))
        self.assertEqual(est, {"blocks": 64, "changed": 3, "bytes": 512 + 64 * 32 + 3 * 4096,
                               "image_bytes": 64 * 4096, "runs": 2})
        self.assertEqual(len(pi.changed_blocks(None, pi.read_package(p2))), 64)
        # A larger image: the new blocks are changed.
        p3, _ = self.package(v2 + image_bytes(4, 2 * 4096), "v3")
        self.assertEqual(pi.changed_blocks(pi.read_package(p2), pi.read_package(p3)), [64, 65])

    def test_records(self):
        out, m = self.package(bytes(8192), "1.2+3")
        rec = pi.record(m, out)
        self.assertEqual(rec["object"], f"firmware/pi-1.2~3-{m.image_sha256.hex()}.cpd")
        self.assertEqual(rec["header"], m.encode().hex())
        doc = pi.job_document(m, "https://x/y")
        self.assertEqual(doc, {"op": "pi_delta", "v": 1,
                               "pi": {"version": "1.2+3", "sha256": m.image_sha256.hex(), "url": "https://x/y"}})
        self.assertRegex(pi.job_id("1.2+3", now=0, suffix="abcd"), r"^pi-1-2-3-19700101T000000Z-abcd$")

    def test_built_in_key_is_the_signing_key(self):
        header = (REPO / "firmware" / "app" / "src" / "pi" / "pi_key.h").read_text()
        built_in = bytes(int(b, 16) for b in re.findall(r"0x([0-9a-f]{2})", header))
        self.assertEqual(built_in, pi.public_point(pi.PUBLIC_KEY))

    def test_card_layout_matches_the_board(self):
        source = (REPO / "firmware" / "app" / "src" / "pi" / "pi_delta_fmt.h").read_text()
        self.assertIn("#define PI_CARD_BASE_LBA   2048u", source)
        layout = pi.card_layout(262144)
        self.assertEqual(layout["slot"][0], 4096)
        self.assertEqual(layout["mirror"] % 8192, 0)
        state = pi.encode_state(3, 1024, pi.STATE_READY, 0, 1, 0, 3, 7, 5, 0, "v0", bytes(range(32)))
        self.assertEqual(pi.decode_state(state)["generation"], 7)
        self.assertIsNone(pi.decode_state(state[:100] + b"x" + state[101:]))


@unittest.skipUnless(build_harness(), "the host harness could not be built (needs the nRF Connect SDK)")
class BoardTests(Base):
    def card_from(self, package: Path) -> Path:
        card = self.tmp / "card.img"
        pi.write_card(package, card, MAX_BLOCKS)
        return card

    def update(self, card: Path, package: Path, m: pi.Manifest, *extra: str) -> dict:
        result = subprocess.run([str(HARNESS), "update", str(card), str(package), m.version, m.image_sha256.hex(),
                                 self.point, "--max-blocks", str(MAX_BLOCKS), *extra],
                                capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stderr)
        return dict(item.split("=") for item in result.stdout.split())

    def pi_takes(self, card: Path, current: bytes, version: str, flip_every: int = 0):
        transport = sim.HarnessTransport(HARNESS, card, flip_every)
        try:
            return sim.take_update(sim.PiClient(transport), current, version)
        finally:
            transport.close()

    def test_only_the_changed_blocks_travel(self):
        v1 = image_bytes(10, self.size)
        v2 = v1
        for block in (0, 1, 2, 77, 200, 255):
            v2 = changed(v2, block, self.block_size, block & 0xFF)
        p1, m1 = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        card = self.card_from(p1)

        # The board: header, table and six blocks, in three ranges after the header and table.
        r = self.update(card, p2, m2)
        self.assertEqual(r["result"], "ok")
        self.assertEqual(int(r["fetched"]), 6)
        self.assertEqual(int(r["changed"]), 6)
        self.assertEqual(int(r["bytes"]), 512 + 256 * 32 + 6 * 4096)
        self.assertEqual(int(r["requests"]), 2 + 4)

        # The Pi on v1: the list, six blocks, and the new image's digest.
        image, stats = self.pi_takes(card, bytes(v1), "v1")
        self.assertEqual(stats["how"], "listed")
        self.assertEqual(stats["blocks"], 6)
        self.assertEqual(hashlib.sha256(image).digest(), m2.image_sha256)
        self.assertEqual(image, bytes(v2))

        # The same job again: nothing is downloaded.
        r = self.update(card, p2, m2)
        self.assertEqual((r["result"], r["already"], r["requests"]), ("ok", "1", "0"))

    def test_a_pi_two_versions_behind_compares(self):
        v0 = image_bytes(11, self.size)
        v1 = changed(v0, 9, self.block_size, 1)
        v2 = changed(v1, 100, self.block_size, 2)
        p1, _ = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        card = self.card_from(p1)
        self.assertEqual(self.update(card, p2, m2)["result"], "ok")

        image, stats = self.pi_takes(card, bytes(v0), "v0")
        self.assertEqual(stats["how"], "compared")
        self.assertEqual(stats["blocks"], 2)
        self.assertEqual(image, bytes(v2))

    def test_first_image_onto_an_empty_card(self):
        v1 = image_bytes(12, 64 * 4096)
        p1, m1 = self.package(v1, "v1")
        card = self.tmp / "blank.img"
        r = self.update(card, p1, m1)
        self.assertEqual(r["result"], "ok")
        # The zero blocks are already on a blank card.
        self.assertEqual(int(r["skipped"]), 3)
        image, stats = self.pi_takes(card, b"", "none")
        self.assertEqual(image, bytes(v1))
        self.assertEqual(stats["blocks"], 64)

    def test_a_wrong_signature_changes_nothing(self):
        v1 = image_bytes(13, 32 * 4096)
        p1, _ = self.package(v1, "v1")
        card = self.card_from(p1)
        before = card.read_bytes()
        other = make_key(Path(tempfile.mkdtemp(dir=self.tmp)))[0]
        p2, m2 = self.package(changed(v1, 1, 4096, 9), "v2", key=pi.load_private(other))
        self.assertEqual(self.update(card, p2, m2)["result"], "bad_signature")
        self.assertEqual(card.read_bytes(), before)
        # A job naming another digest than the signed header's.
        p3, m3 = self.package(changed(v1, 1, 4096, 9), "v3")
        m3.image_sha256 = bytes(32)
        self.assertEqual(self.update(card, p3, m3)["result"], "manifest_mismatch")

    def test_a_block_that_arrives_wrong(self):
        v1 = image_bytes(14, 64 * 4096)
        v2 = changed(changed(v1, 5, 4096, 1), 40, 4096, 2)
        p1, _ = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        card = self.card_from(p1)
        r = self.update(card, p2, m2, "--corrupt-at", str(m2.image_offset + 40 * 4096 + 3))
        self.assertEqual(r["result"], "digest_mismatch")
        # The card says updating: the Pi takes nothing, and a READ is refused.
        with self.assertRaises(sim.BoardError) as caught:
            self.pi_takes(card, bytes(v1), "v1")
        self.assertEqual(caught.exception.name, "updating")
        self.assert_read_refused(card, "updating")
        # Fixed at the server: the same job finishes, and the Pi takes it.
        self.assertEqual(self.update(card, p2, m2)["result"], "ok")
        self.assertEqual(self.pi_takes(card, bytes(v1), "v1")[0], bytes(v2))

    def test_power_cut_then_resume(self):
        v1 = image_bytes(15, self.size)
        v2 = v1
        for block in range(0, 256, 9):
            v2 = changed(v2, block, self.block_size, 3)
        p1, _ = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        for cut in (3, 40, 151, 333):
            card = self.card_from(p1)
            self.assertEqual(self.update(card, p2, m2, "--cut-after-writes", str(cut))["result"], "sd_io")
            r = self.update(card, p2, m2)
            self.assertEqual(r["result"], "ok", cut)
            self.assertLessEqual(int(r["fetched"]), 29)
            self.assertEqual(self.pi_takes(card, bytes(v1), "v1")[0], bytes(v2))

    def test_lost_connection_then_resume(self):
        v1 = image_bytes(16, self.size)
        v2 = v1
        for block in range(100, 140):
            v2 = changed(v2, block, self.block_size, 4)
        p1, _ = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        card = self.card_from(p1)
        r = self.update(card, p2, m2, "--drop-after", str(512 + 256 * 32 + 10 * 4096 + 99))
        self.assertEqual(r["result"], "download_failed")
        self.assertEqual(int(r["fetched"]), 10)
        r = self.update(card, p2, m2)
        self.assertEqual((r["result"], r["fetched"]), ("ok", "30"))
        self.assertEqual(self.pi_takes(card, bytes(v1), "v1")[0], bytes(v2))

    def test_a_noisy_wire(self):
        v1 = image_bytes(17, 64 * 4096)
        v2 = changed(changed(v1, 3, 4096, 1), 60, 4096, 2)
        p1, _ = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        card = self.card_from(p1)
        self.assertEqual(self.update(card, p2, m2)["result"], "ok")
        image, stats = self.pi_takes(card, bytes(v1), "v1", flip_every=5)
        self.assertEqual(image, bytes(v2))
        self.assertGreater(stats["retries"], 0)

    def test_64k_blocks(self):
        size = 40 * 64 * 1024
        v1 = image_bytes(18, size)
        v2 = changed(v1, 7, 64 * 1024, 1)
        p1, _ = self.package(v1, "v1", block_size=65536)
        p2, m2 = self.package(v2, "v2", block_size=65536)
        card = self.card_from(p1)
        r = self.update(card, p2, m2)
        self.assertEqual((r["result"], r["fetched"]), ("ok", "1"))
        self.assertEqual(int(r["bytes"]), 512 + 40 * 32 + 65536)
        self.assertEqual(self.pi_takes(card, bytes(v1), "v1")[0], bytes(v2))

    def assert_read_refused(self, card: Path, name: str):
        transport = sim.HarnessTransport(HARNESS, card)
        try:
            client = sim.PiClient(transport)
            with self.assertRaises(sim.BoardError) as caught:
                client.read(0, 0, 16)
            self.assertEqual(caught.exception.name, name)
        finally:
            transport.close()

    def test_malformed_requests(self):
        v1 = image_bytes(19, 16 * 4096)
        p1, _ = self.package(v1, "v1")
        card = self.card_from(p1)
        transport = sim.HarnessTransport(HARNESS, card)
        try:
            client = sim.PiClient(transport)
            info = client.info()
            self.assertEqual((info["state"], info["version"], info["generation"]), (sim.STATE_READY, "v1", 1))
            self.assertEqual((info["flags"], info["changed"], info["block_count"]), (sim.INFO_LIST, 16, 16))
            cases = [
                (sim.READ, struct.pack("<IIHH", 16, 0, 16, 0), "out_of_range"),
                (sim.READ, struct.pack("<IIHH", 0, 4090, 16, 0), "out_of_range"),
                (sim.READ, struct.pack("<IIHH", 0, 0, 481, 0), "bad_request"),
                (sim.READ, struct.pack("<IIHH", 0, 0, 0, 0), "bad_request"),
                (sim.READ, struct.pack("<IIH", 0, 0, 4), "bad_request"),
                (sim.MANIFEST, struct.pack("<IHH", 0, 16, 0), "bad_request"),
                (sim.MANIFEST, struct.pack("<IHH", 16, 1, 0), "out_of_range"),
                (sim.CHANGED, struct.pack("<IHH", 0, 121, 0), "bad_request"),
                (sim.CHANGED, struct.pack("<IHH", 17, 1, 0), "out_of_range"),
                (sim.INFO, b"x", "bad_request"),
            ]
            for kind, payload, name in cases:
                with self.assertRaises(sim.BoardError, msg=(kind, payload)) as caught:
                    client.request(kind, payload)
                self.assertEqual(caught.exception.name, name, (kind, payload))
            # What is not a delta request goes to the message link, which answers it with STATUS:
            # a type nobody takes, DATA, and garbage on the wire.
            for mosi in (sim.encode(0x7E, 1, 3), sim.encode(sim.DATA, 1, 4, b"{}"), b"\x13\x37" * 256):
                transport.transfer(mosi)
                answer = sim.decode(transport.transfer(sim.encode(sim.POLL, 1, 0)))
                self.assertEqual(answer.kind, sim.STATUS, mosi[:4])
            self.assertEqual((answer.session, answer.ack), (1, 4))
            # A request with no answer of its own is sent again, then given up.
            with self.assertRaises(sim.LinkError):
                client.request(0x14)
            # And the link still works after all of that.
            self.assertEqual(client.manifest(0, 2)[1], hashlib.sha256(v1[4096:8192]).digest())
        finally:
            board = transport.close()
        self.assertRegex(board, r"refused=10 ")
        self.assertRegex(board, r"delivered=1 ")
        # 0x7E, garbage, and 0x14 five times.
        self.assertRegex(board, r"bad=7 ")
        self.assertRegex(board, r"unknown=6\b")

    def test_messages_share_the_link(self):
        """The Pi's messages between the requests: each delivered once, and the update unharmed."""
        v1 = image_bytes(20, 64 * 4096)
        v2 = changed(changed(v1, 4, 4096, 1), 50, 4096, 2)
        p1, _ = self.package(v1, "v1")
        p2, m2 = self.package(v2, "v2")
        card = self.card_from(p1)
        self.assertEqual(self.update(card, p2, m2)["result"], "ok")
        for flip_every in (0, 7):
            transport = sim.HarnessTransport(HARNESS, card, flip_every)
            messages = sim.MessageSender(transport)
            try:
                client = sim.PiClient(transport, messages=messages, messages_every=1)
                image, stats = sim.take_update(client, bytes(v1), "v1")
            finally:
                board = transport.close()
            self.assertEqual(image, bytes(v2))
            self.assertGreaterEqual(messages.sent, client.asked)
            self.assertRegex(board, rf"delivered={messages.sent} ")
            if flip_every == 0:
                self.assertEqual((stats["retries"], messages.not_status), (0, 0))
                self.assertRegex(board, r"duplicates=0 ")

    def test_the_pis_sender_beside_delta_requests(self):
        """pi/cranium_link.py takes only STATUS: a delta answer it reads costs it a transfer, nothing more."""
        v1 = image_bytes(21, 16 * 4096)
        p1, _ = self.package(v1, "v1")
        card = self.card_from(p1)
        transport = sim.HarnessTransport(HARNESS, card)
        try:
            link = cranium_link.Link(transport, cranium_link.NoReady(), session=0x77, sleep=lambda _: None)
            client = sim.PiClient(transport)
            # A delta request whose answer nobody took (a process stopped half way): the sender's DATA
            # transfer brings that answer, which it counts as a bad reply, and its POLL the STATUS.
            transport.transfer(sim.encode(sim.INFO, 0x5A5A, 9))
            self.assertTrue(link.send('{"t":"hb"}'))
            self.assertEqual((link.stats["bad_reply"], link.stats["resent"]), (1, 0))
            # cranium-link --status is one POLL: right after a delta request it reads the delta answer,
            # and finds no status; the POLL after it always has STATUS.
            transport.transfer(sim.encode(sim.INFO, 0x5A5A, 10))
            self.assertIsNone(link.status())
            got = link.status()
            self.assertEqual((got.type, got.session, got.ack), (cranium_link.STATUS, 0x77, link.seq))
            # A whole update between two messages: the delta client ends each request with the POLL that
            # takes its answer, so STATUS is what the sender meets next.
            image, _ = sim.take_update(client, bytes(v1), "none")
            self.assertEqual(image, bytes(v1))
            self.assertIsNotNone(link.status())
            self.assertTrue(link.send('{"t":"np"}'))
            self.assertEqual((link.stats["sent"], link.stats["bad_reply"], link.stats["resent"]), (2, 2, 0))
        finally:
            board = transport.close()
        self.assertRegex(board, r"delivered=2 ")
        self.assertRegex(board, r"duplicates=0 ")


if __name__ == "__main__":
    unittest.main()
