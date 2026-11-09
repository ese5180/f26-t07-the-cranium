#!/usr/bin/env python3
"""Sign a Raspberry Pi image for an update through a board (docs/pi-ota.md, "Signing" and "Cloud").

    tools/pi_image.py sign IMAGE --version 2026.11.06-1 [--min-firmware 1.15.0] [--key KEY]
    tools/pi_image.py verify IMAGE.pi.json [--key PUBLIC_KEY]

`sign` reads the image, takes its size and SHA-256, builds the manifest that the board checks
(src/pi_image.h) and signs it with the project's firmware signing key, ~/.cranium/mcuboot_signing_key.pem
by default: ECDSA P-256 over SHA-256, the signature as r||s in hex. It writes IMAGE.pi.json next to the
image, with what goes into a job document, and prints the commands that upload the image and create
the job. It runs none of them: who deploys, and when, is a person's decision.

`verify` checks such a record against the public key, firmware/keys/fw_signing_pub.pem by default,
the one the board has built in (src/pi_key.h).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

REPO = Path(__file__).resolve().parents[1]
MAGIC = "cranium-pi-image-v1"
DEFAULT_KEY = Path.home() / ".cranium" / "mcuboot_signing_key.pem"
PUBLIC_KEY = REPO / "firmware" / "keys" / "fw_signing_pub.pem"
VERSION = re.compile(r"^[A-Za-z0-9._+-]{1,31}$")
FIRMWARE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,5})(?:\+(\d{1,10}))?$")
# The board takes images of up to 4095 MiB: the size travels as 32 bits.
MAX_SIZE = 0xFFFFFFFF
# AWS IoT job IDs: 64 characters of letters, digits, "-" and "_".
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def firmware_version(text: str) -> str:
    """"1.15.0" as the board writes it into the manifest: "1.15.0+0"."""
    match = FIRMWARE.match(text)
    if not match:
        raise ValueError(f"{text!r} is not a firmware version such as 1.15.0")
    major, minor, revision, build = (int(g or 0) for g in match.groups())
    if major > 255 or minor > 255 or revision > 65535 or build > 0xFFFFFFFF:
        raise ValueError(f"{text!r} is out of range")
    return f"{major}.{minor}.{revision}+{build}"


def manifest(version: str, size: int, sha256: str, min_firmware: str | None = None) -> bytes:
    """The text that the signature covers: what src/pi_image.c's pi_manifest_text() builds."""
    if not VERSION.match(version):
        raise ValueError("the version is 1 to 31 letters, digits or . _ + -")
    if not 0 < size <= MAX_SIZE:
        raise ValueError("the image is empty or larger than 4 GiB")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("the digest is not lowercase SHA-256 hex")
    minimum = firmware_version(min_firmware) if min_firmware else "none"
    return (f"{MAGIC}\nversion={version}\nsize={size}\nsha256={sha256}\nmin_firmware={minimum}\n").encode()


def sign_manifest(text: bytes, private_key) -> str:
    r, s = decode_dss_signature(private_key.sign(text, ec.ECDSA(hashes.SHA256())))
    return (r.to_bytes(32, "big") + s.to_bytes(32, "big")).hex()


def verify_manifest(text: bytes, sig_hex: str, public_key) -> bool:
    raw = bytes.fromhex(sig_hex)
    if len(raw) != 64:
        return False
    signature = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    try:
        public_key.verify(signature, text, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return False
    return True


def load_private(path: Path):
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError(f"{path} is not a P-256 key")
    return key


def load_public(path: Path):
    key = serialization.load_pem_public_key(path.read_bytes())
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
        raise ValueError(f"{path} is not a P-256 public key")
    return key


def public_point(path: Path = PUBLIC_KEY) -> bytes:
    """The public key as src/pi_key.h holds it: an uncompressed P-256 point."""
    return load_public(path).public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def digest_file(path: Path) -> tuple[int, str]:
    sha = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            sha.update(block)
            size += len(block)
    return size, sha.hexdigest()


def object_key(sha256: str) -> str:
    """Where the image goes in the firmware bucket: under firmware/, the prefix a board downloads from."""
    return f"firmware/pi-{sha256}.img"


def job_id(version: str, now: float | None = None, suffix: str | None = None) -> str:
    """pi-<version>-<yyyymmddThhmmssZ>-<4 hex>: "pi-" is how a board tells it from firmware in a list."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() if now is None else now))
    clean = re.sub(r"[^A-Za-z0-9_-]", "-", version)
    ident = f"pi-{clean}-{stamp}-{suffix or os.urandom(2).hex()}"
    if not JOB_ID.match(ident):
        raise ValueError(f"{ident} is not a job ID")
    return ident


def job_document(record: dict, url: str) -> dict:
    pi = {key: record[key] for key in ("version", "size", "sha256", "sig")}
    pi["url"] = url
    if record.get("minFirmware"):
        pi["minFirmware"] = record["minFirmware"]
    return {"op": "pi_image", "v": 1, "pi": pi}


def sign(args) -> int:
    image = Path(args.image)
    size, sha256 = digest_file(image)
    text = manifest(args.version, size, sha256, args.min_firmware)
    record = {
        "version": args.version,
        "size": size,
        "sha256": sha256,
        "sig": sign_manifest(text, load_private(Path(args.key))),
        "object": object_key(sha256),
    }
    if args.min_firmware:
        record["minFirmware"] = args.min_firmware
    if not verify_manifest(text, record["sig"], load_public(PUBLIC_KEY)):
        print(
            f"warning: {args.key} is not the key of {PUBLIC_KEY.relative_to(REPO)}: boards will refuse this image",
            file=sys.stderr,
        )
    out = Path(args.out) if args.out else image.with_name(image.name + ".pi.json")
    out.write_text(json.dumps(record, indent=2) + "\n")
    placeholder = "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/" + record["object"] + "}"
    print(f"Signed {image.name}: {size} bytes, SHA-256 {sha256}. Record: {out}")
    print("To deploy it (nothing here runs them):")
    print(f"  aws s3 cp {image} s3://<bucket>/{record['object']} --profile cranium")
    print(f"  job document: {json.dumps(job_document(record, placeholder))}")
    print(f"  job ID: {job_id(args.version)} (docs/pi-ota.md, \"Cloud\")")
    return 0


def verify(args) -> int:
    record = json.loads(Path(args.record).read_text())
    text = manifest(record["version"], record["size"], record["sha256"], record.get("minFirmware"))
    good = verify_manifest(text, record["sig"], load_public(Path(args.key)))
    print("signature good" if good else "signature BAD")
    return 0 if good else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    s = commands.add_parser("sign", help="sign an image and write its record")
    s.add_argument("image")
    s.add_argument("--version", required=True)
    s.add_argument("--min-firmware")
    s.add_argument("--key", default=os.environ.get("CRANIUM_SIGNING_KEY", str(DEFAULT_KEY)))
    s.add_argument("--out")
    s.set_defaults(run=sign)
    v = commands.add_parser("verify", help="check a record's signature")
    v.add_argument("record")
    v.add_argument("--key", default=str(PUBLIC_KEY))
    v.set_defaults(run=verify)
    args = parser.parse_args(argv)
    try:
        return args.run(args)
    except (OSError, ValueError, KeyError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
