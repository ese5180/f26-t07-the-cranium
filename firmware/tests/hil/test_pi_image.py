#!/usr/bin/env python3
"""Tests of tools/pi_image.py, from 1.20.0 (docs/pi-ota.md, "Signing"): the manifest is the board's,
byte for byte; a signature holds and a changed field breaks it; the key built into the board is the
firmware signing key; and the record and the job document are what the board parses. A throwaway key
signs here: the project's key never leaves ~/.cranium."""

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools"))

import pi_image  # noqa: E402

SHA = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
# The same text as GOLDEN_MANIFEST in firmware/tests/host/test_pi_ota.c.
GOLDEN = (
    "cranium-pi-image-v1\nversion=2026.11.06-1\nsize=104857600\nsha256=" + SHA + "\nmin_firmware=none\n"
).encode()


def throwaway_key(folder):
    key = ec.generate_private_key(ec.SECP256R1())
    private = Path(folder) / "key.pem"
    public = Path(folder) / "pub.pem"
    private.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    public.write_bytes(
        key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    )
    return key, private, public


class Manifest(unittest.TestCase):
    def test_it_is_the_boards(self):
        self.assertEqual(pi_image.manifest("2026.11.06-1", 104857600, SHA), GOLDEN)
        c_test = (REPO / "firmware" / "tests" / "host" / "test_pi_ota.c").read_text()
        self.assertIn('"cranium-pi-image-v1\\nversion=2026.11.06-1\\nsize=104857600\\nsha256="', c_test)
        self.assertIn('"\\nmin_firmware=none\\n"', c_test)
        self.assertTrue(
            pi_image.manifest("1", 1, SHA, "1.15.1").endswith(b"\nmin_firmware=1.15.1+0\n")
        )
        self.assertIn("min_firmware=1.15.1+0", c_test)
        self.assertEqual(pi_image.firmware_version("1.15.0+7"), "1.15.0+7")

    def test_it_refuses_what_the_board_would(self):
        for args in (("a b", 1, SHA), ("x" * 32, 1, SHA), ("1", 0, SHA), ("1", 1 << 32, SHA),
                     ("1", 1, SHA.upper()), ("1", 1, SHA[:-1]), ("1\n2", 1, SHA)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                pi_image.manifest(*args)
        for bad in ("latest", "1.2", "256.0.0", "1.0.65536"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                pi_image.firmware_version(bad)


class Signature(unittest.TestCase):
    def test_a_signature_holds_and_a_changed_field_breaks_it(self):
        with tempfile.TemporaryDirectory() as folder:
            key, private, public = throwaway_key(folder)
            sig = pi_image.sign_manifest(GOLDEN, pi_image.load_private(private))
            self.assertRegex(sig, r"^[0-9a-f]{128}$")
            pub = pi_image.load_public(public)
            self.assertTrue(pi_image.verify_manifest(GOLDEN, sig, pub))
            for changed in (
                GOLDEN.replace(b"size=104857600", b"size=104857601"),
                GOLDEN.replace(b"version=2026.11.06-1", b"version=2026.11.06-2"),
                GOLDEN.replace(b"min_firmware=none", b"min_firmware=1.15.0+0"),
                GOLDEN.replace(b"sha256=00", b"sha256=01"),
            ):
                self.assertFalse(pi_image.verify_manifest(changed, sig, pub))
            self.assertFalse(pi_image.verify_manifest(GOLDEN, sig[:-2], pub))
            other = ec.generate_private_key(ec.SECP256R1()).public_key()
            self.assertFalse(pi_image.verify_manifest(GOLDEN, sig, other))

    def test_the_board_has_the_firmware_signing_key(self):
        header = (REPO / "firmware" / "app" / "src" / "pi" / "pi_key.h").read_text()
        body = header[header.index("pi_public_key[65] = {") :]
        built_in = bytes(int(x, 16) for x in re.findall(r"0x([0-9a-f]{2})", body[: body.index("};")]))
        self.assertEqual(built_in, pi_image.public_point())
        self.assertEqual(len(built_in), 65)


class Commands(unittest.TestCase):
    def test_sign_writes_a_record_that_verifies(self):
        with tempfile.TemporaryDirectory() as folder:
            _, private, public = throwaway_key(folder)
            image = Path(folder) / "pi.img"
            image.write_bytes(bytes(range(256)) * 1000)
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()) as err:
                code = pi_image.main(["sign", str(image), "--version", "2026.11.06-1", "--min-firmware",
                                      "1.15.0", "--key", str(private)])
            self.assertEqual(code, 0)
            # Not the project's key, and it says so.
            self.assertIn("boards will refuse this image", err.getvalue())
            record = json.loads((Path(folder) / "pi.img.pi.json").read_text())
            self.assertEqual(record["size"], 256000)
            self.assertEqual(record["object"], f"firmware/pi-{record['sha256']}.img")
            self.assertEqual(record["minFirmware"], "1.15.0")
            # It prints the commands and runs none.
            self.assertIn("aws s3 cp", out.getvalue())
            self.assertIn('"op": "pi_image"', out.getvalue())

            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(pi_image.main(["verify", str(Path(folder) / "pi.img.pi.json"), "--key",
                                                str(public)]), 0)
                record["size"] += 1
                (Path(folder) / "bad.json").write_text(json.dumps(record))
                self.assertEqual(pi_image.main(["verify", str(Path(folder) / "bad.json"), "--key",
                                                str(public)]), 1)

    def test_the_job_id_and_document_are_what_a_board_takes(self):
        ident = pi_image.job_id("2026.11.06+1", now=0, suffix="ab12")
        self.assertEqual(ident, "pi-2026-11-06-1-19700101T000000Z-ab12")
        self.assertLessEqual(len(pi_image.job_id("x" * 31)), 64)
        document = pi_image.job_document(
            {"version": "1", "size": 2, "sha256": SHA, "sig": "00" * 64}, "https://example/firmware/x"
        )
        self.assertEqual(document["op"], "pi_image")
        self.assertEqual(document["v"], 1)
        self.assertNotIn("minFirmware", document["pi"])


if __name__ == "__main__":
    unittest.main()
