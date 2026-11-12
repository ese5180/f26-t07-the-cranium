#!/usr/bin/env python3
"""Promotion records for the golden image: make the golden key, sign a record, check one.

    python tools/golden_promote.py genkey --private ~/.cranium-offline/golden_promote_key.pem
    python tools/golden_promote.py sign --key <private key> --image binaries/cranium-1.19.2-0.signed.bin \\
        --counter 1 --out binaries/golden/cranium-1.19.2-0.golden
    python tools/golden_promote.py verify <record> [--image <signed image>] [--key <public key>]
    python tools/golden_promote.py show <record>
    python tools/golden_promote.py c-key --key <public key> --out golden_key.h

A promotion record names one signed image (its hash TLV, size and version) under a golden counter
that only goes up, signed with the golden key: ECDSA P-256, not the image signing key, and kept
offline, on no build machine and in no CI. The bootloader has the public half compiled in
(firmware/keys/golden_promote_pub.pem), and seals the image as the new golden image only when the
record's signature is good, its counter is above the last one it took, and the image runs on the
board and is confirmed there. The format is in firmware/app/sysbuild/mcuboot/golden/src/golden_record.h;
firmware/README.md, "Golden image", has the flow.

genkey writes the private key where you say, never inside this repository, and the public key to
firmware/keys/golden_promote_pub.pem, to be committed. sign refuses an image that does not match its
own hash, and checks what it wrote with the public key. verify checks a record's signature, and with
--image that it names that image. c-key is for the bootloader's build, and needs nothing beyond
Python itself. The other commands need the Python package cryptography, which the SDK's toolchain has.
"""

import argparse
import base64
import hashlib
import os
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PUBLIC = REPO / "firmware" / "keys" / "golden_promote_pub.pem"

MAGIC = b"CGLD"
FORMAT = 1
SIGNED = 56
SIG_MIN = 8
SIG_MAX = 72
SIZE = SIGNED + 2 + SIG_MAX  # 130

MCUBOOT_MAGIC = 0x96F3B83D
TLV_INFO_MAGIC = 0x6907
TLV_PROTECTED_INFO_MAGIC = 0x6908
TLV_SHA256 = 0x10


class PromoteError(RuntimeError):
    """Something does not agree, and nothing has been written."""


@dataclass(frozen=True)
class Record:
    counter: int
    size: int
    version: tuple  # (major, minor, revision, build)
    sha256: bytes
    signature: bytes

    @property
    def version_text(self) -> str:
        major, minor, revision, build = self.version
        return f"{major}.{minor}.{revision}+{build}"

    def signed_bytes(self) -> bytes:
        return signed_bytes(self.counter, self.size, self.version, self.sha256)

    def encode(self) -> bytes:
        if not SIG_MIN <= len(self.signature) <= SIG_MAX:
            raise PromoteError(f"a signature of {len(self.signature)} bytes does not fit a record")
        return (self.signed_bytes() + bytes([len(self.signature), 0]) +
                self.signature + bytes(SIG_MAX - len(self.signature)))


def signed_bytes(counter: int, size: int, version: tuple, sha256: bytes) -> bytes:
    major, minor, revision, build = version
    if not 1 <= counter <= 0xFFFFFFFF:
        raise PromoteError("the counter goes from 1 to 4294967295")
    if not 1 <= size <= 0xFFFFFFFF or len(sha256) != 32:
        raise PromoteError("the image's size or digest is not usable")
    return (MAGIC + bytes([FORMAT, 0, 0, 0]) + struct.pack("<II", counter, size) +
            struct.pack("<BBHI", major, minor, revision, build) + sha256)


def parse_record(data: bytes) -> Record:
    """A record's format, as the board reads it. The signature is not checked here."""
    if len(data) != SIZE:
        raise PromoteError(f"a promotion record is {SIZE} bytes, and this is {len(data)}")
    if data[:4] != MAGIC or data[4] != FORMAT or data[5:8] != bytes(3):
        raise PromoteError("this is not a promotion record of format 1")
    counter, size = struct.unpack_from("<II", data, 8)
    version = struct.unpack_from("<BBHI", data, 16)
    sha256 = data[24:56]
    sig_len = data[SIGNED]
    if counter == 0 or size == 0 or data[SIGNED + 1] != 0 or not SIG_MIN <= sig_len <= SIG_MAX:
        raise PromoteError("the record's counter, size or signature length is not usable")
    if any(data[SIGNED + 2 + sig_len:]):
        raise PromoteError("the record has bytes after its signature")
    return Record(counter, size, tuple(version), bytes(sha256), bytes(data[SIGNED + 2:SIGNED + 2 + sig_len]))


@dataclass(frozen=True)
class Image:
    size: int
    version: tuple
    sha256: bytes


def parse_image(data: bytes) -> Image:
    """An MCUboot image's size, version and hash TLV, after checking the hash against its bytes."""
    if len(data) < 32:
        raise PromoteError("this is not an MCUboot image: too short")
    magic, _, header_size, protected_size, body_size = struct.unpack_from("<IIHHI", data)
    if magic != MCUBOOT_MAGIC:
        raise PromoteError("this is not an MCUboot image: wrong magic")
    version = struct.unpack_from("<BBHI", data, 20)
    protected_at = header_size + body_size
    tlv_at = protected_at + protected_size
    if protected_size and (len(data) < protected_at + 4 or
                           struct.unpack_from("<H", data, protected_at)[0] != TLV_PROTECTED_INFO_MAGIC):
        raise PromoteError("the image's protected metadata is damaged")
    if len(data) < tlv_at + 4:
        raise PromoteError("the image is cut short: its metadata is missing")
    tlv_magic, tlv_total = struct.unpack_from("<HH", data, tlv_at)
    end = tlv_at + tlv_total
    if tlv_magic != TLV_INFO_MAGIC or len(data) < end:
        raise PromoteError("the image's metadata is damaged or cut short")
    digest = None
    offset = tlv_at + 4
    while offset + 4 <= end:
        tlv_type, length = struct.unpack_from("<BxH", data, offset)
        offset += 4
        if offset + length > end:
            raise PromoteError("the image's metadata is damaged")
        if tlv_type == TLV_SHA256 and length == 32:
            digest = bytes(data[offset:offset + 32])
        offset += length
    if digest is None:
        raise PromoteError("the image has no SHA-256")
    if hashlib.sha256(data[:tlv_at]).digest() != digest:
        raise PromoteError("the image does not match its own hash: it has been damaged")
    if len(data) != end:
        raise PromoteError(f"the file is {len(data)} bytes and the image says {end}")
    return Image(end, tuple(version), digest)


def _crypto():
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError as error:
        raise PromoteError("this needs the Python package cryptography: run it from an nRF Connect "
                           "SDK terminal") from error
    return ec, hashes, serialization, InvalidSignature


def load_public(path: Path):
    ec, _, serialization, _ = _crypto()
    try:
        key = serialization.load_pem_public_key(path.read_bytes())
    except (OSError, ValueError) as error:
        raise PromoteError(f"{path} is not a public key: {error}") from error
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
        raise PromoteError(f"{path} is not an ECDSA P-256 public key")
    return key


def load_private(path: Path):
    ec, _, serialization, _ = _crypto()
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except (OSError, ValueError, TypeError) as error:
        raise PromoteError(f"{path} is not an unencrypted private key: {error}") from error
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise PromoteError(f"{path} is not an ECDSA P-256 private key")
    return key


def signature_ok(record: Record, public_key) -> bool:
    ec, hashes, _, invalid = _crypto()
    try:
        public_key.verify(record.signature, record.signed_bytes(), ec.ECDSA(hashes.SHA256()))
    except invalid:
        return False
    return True


def inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO)
    except ValueError:
        return False
    return True


# ---- the commands --------------------------------------------------------------------------


def genkey(private: Path, public: Path) -> None:
    ec, _, serialization, _ = _crypto()
    if inside_repo(private):
        raise PromoteError("the private key never goes inside the repository: give a path outside it")
    if private.exists():
        raise PromoteError(f"{private} exists already: a new golden key is never written over the old one")
    key = ec.generate_private_key(ec.SECP256R1())
    private.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as out:
        out.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))
    public.parent.mkdir(parents=True, exist_ok=True)
    public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,
                                                     serialization.PublicFormat.SubjectPublicKeyInfo))


def sign(key_path: Path, image_path: Path, counter: int, out: Path, public: Path | None) -> Record:
    ec, hashes, serialization, _ = _crypto()
    image = parse_image(image_path.read_bytes())
    key = load_private(key_path)
    body = signed_bytes(counter, image.size, image.version, image.sha256)
    signature = key.sign(body, ec.ECDSA(hashes.SHA256()))
    record = Record(counter, image.size, image.version, image.sha256, signature)
    check_key = load_public(public) if public is not None and public.exists() else key.public_key()
    if not signature_ok(record, check_key):
        raise PromoteError(f"the key does not match {public}: a board would refuse this record")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(record.encode())
    return record


def verify(record_path: Path, key_path: Path, image_path: Path | None) -> Record:
    record = parse_record(record_path.read_bytes())
    if not signature_ok(record, load_public(key_path)):
        raise PromoteError("the signature does not verify with this golden key")
    if image_path is not None:
        image = parse_image(image_path.read_bytes())
        if (image.size, image.version, image.sha256) != (record.size, record.version, record.sha256):
            raise PromoteError("the record names another image")
    return record


def public_der(path: Path) -> bytes:
    """The DER of a PEM public key, with Python alone: what the bootloader's build needs."""
    lines = path.read_text().strip().splitlines()
    if len(lines) < 3 or lines[0] != "-----BEGIN PUBLIC KEY-----" or lines[-1] != "-----END PUBLIC KEY-----":
        raise PromoteError(f"{path} is not a PEM public key")
    der = base64.b64decode("".join(lines[1:-1]), validate=True)
    # SubjectPublicKeyInfo of a P-256 key, uncompressed point: 91 bytes, with the two OIDs.
    ec_oid = bytes.fromhex("06072a8648ce3d0201")
    p256_oid = bytes.fromhex("06082a8648ce3d030107")
    if len(der) != 91 or ec_oid not in der or p256_oid not in der or der[26] != 0x04:
        raise PromoteError(f"{path} is not an ECDSA P-256 public key")
    return der


def c_key(key_path: Path, out: Path) -> None:
    """The key's point, X and Y, 64 bytes: what tinycrypt's uECC_verify() in the bootloader takes."""
    der = public_der(key_path)
    point = der[27:]
    rows = [", ".join(f"0x{b:02x}" for b in point[i:i + 12]) for i in range(0, len(point), 12)]
    body = ",\n\t".join(rows)
    out.write_text(
        "/* The golden public key, X and Y, made by tools/golden_promote.py c-key. Do not edit. */\n"
        f"/* SHA-256 of its DER: {hashlib.sha256(der).hexdigest()} */\n"
        "#include <stdint.h>\n"
        f"static const uint8_t golden_promote_key[{len(point)}] = {{\n\t{body}\n}};\n")


def describe(record: Record) -> str:
    return (f"version {record.version_text}, counter {record.counter}, size {record.size}, "
            f"sha256 {record.sha256.hex()}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("genkey", help="make the golden key pair")
    p.add_argument("--private", type=Path, required=True, help="where the private key goes, outside the repository")
    p.add_argument("--public", type=Path, default=DEFAULT_PUBLIC)

    p = sub.add_parser("sign", help="sign a promotion record for a signed image")
    p.add_argument("--key", type=Path, required=True, help="the golden private key")
    p.add_argument("--image", type=Path, required=True)
    p.add_argument("--counter", type=int, required=True,
                   help="above every counter used before, on any board")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--public", type=Path, default=DEFAULT_PUBLIC,
                   help="the public key the bootloader has, to check against")

    p = sub.add_parser("verify", help="check a record's signature, and that it names an image")
    p.add_argument("record", type=Path)
    p.add_argument("--key", type=Path, default=DEFAULT_PUBLIC)
    p.add_argument("--image", type=Path)

    p = sub.add_parser("show", help="what a record says, without checking its signature")
    p.add_argument("record", type=Path)

    p = sub.add_parser("c-key", help="the public key as a C array, for the bootloader's build")
    p.add_argument("--key", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "genkey":
            genkey(args.private, args.public)
            print(f"Private key: {args.private}. Keep it offline. Public key: {args.public}: commit it.")
        elif args.command == "sign":
            record = sign(args.key, args.image, args.counter, args.out, args.public)
            print(f"{args.out}: {describe(record)}")
        elif args.command == "verify":
            record = verify(args.record, args.key, args.image)
            print(f"OK: {describe(record)}")
        elif args.command == "show":
            print(describe(parse_record(args.record.read_bytes())))
        else:
            c_key(args.key, args.out)
    except (PromoteError, OSError) as error:
        print(f"golden_promote: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
