#!/usr/bin/env python3
"""Tests of tools/golden_promote.py: promotion records for the golden image. No board.

    python3 firmware/tests/hil/test_golden_promote.py

Every key here is made by the test, in a temporary directory, and thrown away with it.
"""

import contextlib
import hashlib
import io
import re
import struct
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import golden_promote as gp  # noqa: E402

HEADER = REPO / "firmware" / "app" / "sysbuild" / "mcuboot" / "golden" / "src" / "golden_record.h"


def make_image(version=(1, 19, 2, 0), body=b"\x5a" * 1000, protected=True) -> bytes:
    """A small MCUboot image: header, body, protected TLVs, and the hash TLV over all that."""
    header_size = 32
    protected_tlvs = b""
    if protected:
        entry = struct.pack("<BxH", 0xA1, 9) + b"nrf7002dk"
        protected_tlvs = struct.pack("<HH", gp.TLV_PROTECTED_INFO_MAGIC, 4 + len(entry)) + entry
    header = struct.pack("<IIHHII", gp.MCUBOOT_MAGIC, 0, header_size, len(protected_tlvs), len(body), 0)
    header += struct.pack("<BBHI", *version) + bytes(4)
    assert len(header) == header_size
    hashed = header + body + protected_tlvs
    digest = hashlib.sha256(hashed).digest()
    tlvs = struct.pack("<BxH", gp.TLV_SHA256, 32) + digest + struct.pack("<BxH", 0x22, 8) + bytes(8)
    return hashed + struct.pack("<HH", gp.TLV_INFO_MAGIC, 4 + len(tlvs)) + tlvs


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="golden-promote-"))
        self.private = self.tmp / "keys" / "golden.pem"
        self.public = self.tmp / "golden_pub.pem"
        gp.genkey(self.private, self.public)
        self.image = self.tmp / "image.bin"
        self.image.write_bytes(make_image())
        self.record = self.tmp / "image.golden"

    def tearDown(self):
        for path in sorted(self.tmp.rglob("*"), reverse=True):
            path.rmdir() if path.is_dir() else path.unlink()
        self.tmp.rmdir()


class TestFormat(Base):
    def test_the_c_header_has_the_same_layout(self):
        text = HEADER.read_text()

        def define(name):
            return re.search(rf"#define {name}\s+(\S+)", text).group(1)

        self.assertEqual(int(define("GOLDEN_RECORD_SIGNED")), gp.SIGNED)
        self.assertEqual(int(define("GOLDEN_RECORD_SIG_MAX")), gp.SIG_MAX)
        self.assertEqual(int(define("GOLDEN_RECORD_SIG_MIN")), gp.SIG_MIN)
        self.assertEqual(int(define("GOLDEN_RECORD_FORMAT")), gp.FORMAT)
        magic = "".join(define(f"GOLDEN_RECORD_MAGIC_{i}").strip("'") for i in range(4))
        self.assertEqual(magic.encode(), gp.MAGIC)

    def test_a_signed_record_round_trips(self):
        record = gp.sign(self.private, self.image, 3, self.record, self.public)
        data = self.record.read_bytes()
        self.assertEqual(len(data), gp.SIZE)
        parsed = gp.parse_record(data)
        self.assertEqual(parsed, record)
        self.assertEqual(parsed.version_text, "1.19.2+0")
        self.assertEqual(parsed.counter, 3)
        self.assertEqual(parsed.size, len(self.image.read_bytes()))
        self.assertEqual(gp.verify(self.record, self.public, self.image), record)

    def test_the_parser_refuses_what_the_board_refuses(self):
        gp.sign(self.private, self.image, 1, self.record, self.public)
        good = self.record.read_bytes()
        cases = {
            "short": good[:-1],
            "magic": b"XGLD" + good[4:],
            "format": good[:4] + b"\x02" + good[5:],
            "reserved": good[:5] + b"\x01" + good[6:],
            "counter zero": good[:8] + bytes(4) + good[12:],
            "signature too long": good[:56] + b"\x49" + good[57:],
            "signature too short": good[:56] + b"\x07" + good[57:],
        }
        # A byte that is not zero after the signature: one taken off its length, and made 1.
        trailing = bytearray(good)
        trailing[56] -= 1
        trailing[58 + trailing[56]] = 1
        cases["trailing bytes"] = bytes(trailing)
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(gp.PromoteError):
                gp.parse_record(data)


class TestSignatures(Base):
    def test_another_key_does_not_verify(self):
        gp.sign(self.private, self.image, 1, self.record, self.public)
        other_private = self.tmp / "other" / "key.pem"
        other_public = self.tmp / "other_pub.pem"
        gp.genkey(other_private, other_public)
        with self.assertRaisesRegex(gp.PromoteError, "does not verify"):
            gp.verify(self.record, other_public, None)

    def test_a_changed_counter_does_not_verify(self):
        gp.sign(self.private, self.image, 1, self.record, self.public)
        data = bytearray(self.record.read_bytes())
        data[8] = 2
        self.record.write_bytes(bytes(data))
        with self.assertRaisesRegex(gp.PromoteError, "does not verify"):
            gp.verify(self.record, self.public, None)

    def test_a_record_names_one_image(self):
        gp.sign(self.private, self.image, 1, self.record, self.public)
        other = self.tmp / "other.bin"
        other.write_bytes(make_image(version=(1, 19, 3, 0)))
        with self.assertRaisesRegex(gp.PromoteError, "another image"):
            gp.verify(self.record, self.public, other)

    def test_sign_refuses_a_key_that_is_not_the_bootloaders(self):
        other_private = self.tmp / "other" / "key.pem"
        gp.genkey(other_private, self.tmp / "other_pub.pem")
        with self.assertRaisesRegex(gp.PromoteError, "does not match"):
            gp.sign(other_private, self.image, 1, self.record, self.public)
        self.assertFalse(self.record.exists())

    def test_sign_refuses_a_damaged_image(self):
        data = bytearray(self.image.read_bytes())
        data[40] ^= 1
        self.image.write_bytes(bytes(data))
        with self.assertRaisesRegex(gp.PromoteError, "own hash"):
            gp.sign(self.private, self.image, 1, self.record, self.public)

    def test_the_counter_starts_at_one(self):
        for counter in (0, -1, 2**32):
            with self.subTest(counter), self.assertRaises(gp.PromoteError):
                gp.sign(self.private, self.image, counter, self.record, self.public)


class TestKeys(Base):
    def test_genkey_never_writes_a_private_key_into_the_repository(self):
        with self.assertRaisesRegex(gp.PromoteError, "outside"):
            gp.genkey(REPO / "golden_test_key.pem", self.tmp / "pub.pem")
        self.assertFalse((REPO / "golden_test_key.pem").exists())

    def test_genkey_never_writes_over_a_key(self):
        with self.assertRaisesRegex(gp.PromoteError, "exists already"):
            gp.genkey(self.private, self.public)

    def test_the_private_key_is_for_its_owner_only(self):
        self.assertEqual(self.private.stat().st_mode & 0o777, 0o600)

    def test_c_key_writes_the_der(self):
        header = self.tmp / "golden_key.h"
        gp.c_key(self.public, header)
        text = header.read_text()
        values = bytes(int(v, 16) for v in re.findall(r"0x([0-9a-f]{2})", text))
        der = gp.public_der(self.public)
        self.assertEqual(values, der[27:])
        self.assertEqual(len(values), 64)
        self.assertIn("golden_promote_key[64]", text)

    def test_c_key_refuses_what_is_not_a_p256_public_key(self):
        self.private.with_name("bad.pem").write_text("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")
        with self.assertRaises(gp.PromoteError):
            gp.public_der(self.private.with_name("bad.pem"))


class TestCommandLine(Base):
    def test_sign_then_verify(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.run_all()
        self.assertIn("OK: version 1.19.2+0, counter 5", out.getvalue())

    def run_all(self):
        self.assertEqual(gp.main(["sign", "--key", str(self.private), "--image", str(self.image),
                                  "--counter", "5", "--out", str(self.record), "--public", str(self.public)]), 0)
        self.assertEqual(gp.main(["verify", str(self.record), "--key", str(self.public),
                                  "--image", str(self.image)]), 0)
        self.assertEqual(gp.main(["show", str(self.record)]), 0)

    def test_a_failure_exits_1(self):
        self.record.write_bytes(b"nope")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gp.main(["show", str(self.record)]), 1)


if __name__ == "__main__":
    unittest.main()
