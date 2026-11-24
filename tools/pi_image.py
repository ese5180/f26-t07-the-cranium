#!/usr/bin/env python3
"""Raspberry Pi images for delta updates through the board (docs/pi-delta-update.md).

    tools/pi_image.py package IMAGE --version 2026.11.24-1 [--block-size 65536] [--key KEY]
                              [--previous OLD.cpd] [--out OUT.cpd]
    tools/pi_image.py verify PACKAGE [--key PUBLIC_KEY]
    tools/pi_image.py diff OLD NEW
    tools/pi_image.py card PACKAGE --out CARD.img [--max-blocks N] [--card-size BYTES]

`package` cuts the image into blocks, hashes each one, and writes the package a board downloads in
ranges: a 512-byte manifest header signed with the project's firmware signing key
(~/.cranium/mcuboot_signing_key.pem by default), the table of block hashes, then the image. It also
writes PACKAGE.json, the record the console needs, and prints the commands that upload the package
and create the job. It runs none of them: who deploys, and when, is a person's decision. With
--previous it also says how much a board holding that package's image downloads: only the blocks that
differ.

`verify` checks a package against the public key the board has built in
(firmware/keys/fw_signing_pub.pem): the signature, the table and the image.

`diff` says which blocks of two packages differ, and what a board would download.

`card` writes what a board's SD card holds once it has the package's image (a partition table that
marks the card as taken, the state header, the manifest, the list and the mirror), as a file to
write onto a card from a computer, so that the first update over the air is a delta and not the
whole image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_KEY = Path.home() / ".cranium" / "mcuboot_signing_key.pem"
PUBLIC_KEY = REPO / "firmware" / "keys" / "fw_signing_pub.pem"

# The formats: src/pi/pi_delta_fmt.h.
SECTOR = 512
MAGIC = b"CPDM"
FORMAT = 1
HEADER_SIZE = 512
SIGNED_SIZE = 448
HASH_SIZE = 32
BLOCK_MIN = 4096
BLOCK_MAX = 1024 * 1024
DEFAULT_BLOCK = 64 * 1024
IMAGE_ALIGN = 4096
VERSION = re.compile(r"^[A-Za-z0-9._+-]{1,31}$")
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

STATE_MAGIC = b"CPDS"
STATE_FORMAT = 1
CARD_BASE_LBA = 2048
CARD_ALIGN = 2048
CARD_MIRROR_ALIGN = 8192
# CONFIG_APP_PI_DELTA_MAX_BLOCKS: 16 GiB of 64 KiB blocks.
DEFAULT_MAX_BLOCKS = 262144
STATE_EMPTY, STATE_READY, STATE_UPDATING = 0, 1, 2
FLAG_HAS_CUR, FLAG_LIST_VALID, FLAG_DIRTY = 1, 2, 4
# The partition type that marks the card as taken: "non-filesystem data".
PARTITION_TYPE = 0xDA


@dataclass
class Manifest:
    block_size: int
    block_count: int
    image_size: int
    table_offset: int
    image_offset: int
    image_sha256: bytes
    table_sha256: bytes
    version: str
    sig: bytes = bytes(64)

    def signed_bytes(self) -> bytes:
        version = self.version.encode()
        head = struct.pack(
            "<4sHHIIQQQ32s32s32sI",
            MAGIC,
            FORMAT,
            HEADER_SIZE,
            self.block_size,
            self.block_count,
            self.image_size,
            self.table_offset,
            self.image_offset,
            self.image_sha256,
            self.table_sha256,
            version + bytes(32 - len(version)),
            0,
        )
        return head + bytes(SIGNED_SIZE - len(head))

    def encode(self) -> bytes:
        return self.signed_bytes() + self.sig

    @classmethod
    def decode(cls, raw: bytes) -> "Manifest":
        """The header, with every check the board makes but the signature (pi_manifest_decode())."""
        if len(raw) < HEADER_SIZE:
            raise ValueError("the header is 512 bytes")
        (magic, fmt, size, block_size, count, image_size, table_offset, image_offset, image_sha,
         table_sha, version, flags) = struct.unpack_from("<4sHHIIQQQ32s32s32sI", raw)
        if magic != MAGIC or fmt != FORMAT or size != HEADER_SIZE:
            raise ValueError("not a manifest header this format reads")
        if block_size & (block_size - 1) or not BLOCK_MIN <= block_size <= BLOCK_MAX:
            raise ValueError("the block size is not a power of two from 4 KiB to 1 MiB")
        if image_size == 0 or image_size % SECTOR or image_size > 1 << 48:
            raise ValueError("the image size is not a whole number of 512-byte sectors")
        if count != -(-image_size // block_size):
            raise ValueError("the block count does not match the size")
        if (table_offset != HEADER_SIZE or image_offset % IMAGE_ALIGN
                or image_offset < table_offset + count * HASH_SIZE):
            raise ValueError("the offsets do not fit together")
        text = version.rstrip(b"\0")
        if b"\0" in text or not VERSION.match(text.decode("ascii", "replace")) or flags != 0:
            raise ValueError("a bad version or flags")
        if any(raw[140:SIGNED_SIZE]):
            raise ValueError("the reserved bytes are not zero")
        return cls(block_size, count, image_size, table_offset, image_offset, image_sha, table_sha,
                   text.decode(), bytes(raw[SIGNED_SIZE:HEADER_SIZE]))

    def block_len(self, block: int) -> int:
        start = block * self.block_size
        return min(self.block_size, self.image_size - start)


# --- keys and signatures ---------------------------------------------------------------------------

def _crypto():
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

    return InvalidSignature, hashes, serialization, ec, decode_dss_signature, encode_dss_signature


def load_private(path: Path):
    _, _, serialization, ec, _, _ = _crypto()
    key = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError(f"{path} is not a P-256 key")
    return key


def load_public(path: Path):
    _, _, serialization, ec, _, _ = _crypto()
    key = serialization.load_pem_public_key(Path(path).read_bytes())
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
        raise ValueError(f"{path} is not a P-256 public key")
    return key


def public_point(path: Path = PUBLIC_KEY) -> bytes:
    """The public key as src/pi/pi_key.h holds it: an uncompressed P-256 point, 65 bytes."""
    _, _, serialization, _, _, _ = _crypto()
    return load_public(path).public_bytes(serialization.Encoding.X962,
                                          serialization.PublicFormat.UncompressedPoint)


def sign(message: bytes, private_key) -> bytes:
    """ECDSA P-256 with SHA-256, as r || s, 32 bytes each, big-endian."""
    _, hashes, _, ec, decode_dss_signature, _ = _crypto()
    r, s = decode_dss_signature(private_key.sign(message, ec.ECDSA(hashes.SHA256())))
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def verify_signature(message: bytes, sig: bytes, public_key) -> bool:
    InvalidSignature, hashes, _, ec, _, encode_dss_signature = _crypto()
    if len(sig) != 64:
        return False
    signature = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
    try:
        public_key.verify(signature, message, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return False
    return True


# --- packages --------------------------------------------------------------------------------------

def block_hashes(image: Path, block_size: int) -> tuple[int, bytes, list[bytes]]:
    """The image's size, its SHA-256, and one SHA-256 per block, reading it once."""
    whole = hashlib.sha256()
    hashes = []
    size = 0
    with Path(image).open("rb") as f:
        while True:
            block = f.read(block_size)
            if not block:
                break
            whole.update(block)
            hashes.append(hashlib.sha256(block).digest())
            size += len(block)
    return size, whole.digest(), hashes


def build_manifest(image: Path, version: str, block_size: int = DEFAULT_BLOCK) -> tuple[Manifest, bytes]:
    if not VERSION.match(version):
        raise ValueError("the version is 1 to 31 letters, digits or . _ + -")
    if block_size & (block_size - 1) or not BLOCK_MIN <= block_size <= BLOCK_MAX:
        raise ValueError("the block size is a power of two from 4096 to 1048576")
    size, digest, hashes = block_hashes(image, block_size)
    if size == 0 or size % SECTOR:
        raise ValueError("a disk image is a whole number of 512-byte sectors; this one is not")
    table = b"".join(hashes)
    image_offset = -(-(HEADER_SIZE + len(table)) // IMAGE_ALIGN) * IMAGE_ALIGN
    manifest = Manifest(block_size, len(hashes), size, HEADER_SIZE, image_offset, digest,
                        hashlib.sha256(table).digest(), version)
    return manifest, table


def write_package(image: Path, out: Path, version: str, private_key, block_size: int = DEFAULT_BLOCK) -> Manifest:
    manifest, table = build_manifest(image, version, block_size)
    manifest.sig = sign(manifest.signed_bytes(), private_key)
    with Path(out).open("wb") as f, Path(image).open("rb") as src:
        f.write(manifest.encode())
        f.write(table)
        f.write(bytes(manifest.image_offset - HEADER_SIZE - len(table)))
        for chunk in iter(lambda: src.read(1 << 20), b""):
            f.write(chunk)
    return manifest


def read_package(path: Path) -> tuple[Manifest, bytes]:
    with Path(path).open("rb") as f:
        manifest = Manifest.decode(f.read(HEADER_SIZE))
        table = f.read(manifest.block_count * HASH_SIZE)
    if len(table) != manifest.block_count * HASH_SIZE:
        raise ValueError("the package ends inside its table")
    return manifest, table


def verify_package(path: Path, public_key) -> list[str]:
    """What is wrong with a package, or nothing."""
    problems = []
    manifest, table = read_package(path)
    if not verify_signature(manifest.signed_bytes(), manifest.sig, public_key):
        problems.append("the signature does not hold")
    if hashlib.sha256(table).digest() != manifest.table_sha256:
        problems.append("the table is not the one the header signs")
    whole = hashlib.sha256()
    with Path(path).open("rb") as f:
        f.seek(manifest.image_offset)
        for block in range(manifest.block_count):
            data = f.read(manifest.block_len(block))
            if hashlib.sha256(data).digest() != table[block * HASH_SIZE:(block + 1) * HASH_SIZE]:
                problems.append(f"block {block} does not match its hash")
                break
            whole.update(data)
        if f.read(1):
            problems.append("bytes after the image")
    if whole.digest() != manifest.image_sha256:
        problems.append("the image does not match its SHA-256")
    return problems


def changed_blocks(old: tuple[Manifest, bytes] | None, new: tuple[Manifest, bytes]) -> list[int]:
    """The blocks a board fetches to go from old to new: what pi_delta.c's comparison lists."""
    manifest, table = new
    if old is None or old[0].block_size != manifest.block_size:
        return list(range(manifest.block_count))
    old_manifest, old_table = old
    out = []
    for block in range(manifest.block_count):
        if block >= old_manifest.block_count or (
                old_table[block * HASH_SIZE:(block + 1) * HASH_SIZE] != table[block * HASH_SIZE:(block + 1) * HASH_SIZE]):
            out.append(block)
    return out


def download_estimate(old, new) -> dict:
    manifest, table = new
    blocks = changed_blocks(old, new)
    runs = 0
    previous = -2
    for block in blocks:
        if block != previous + 1:
            runs += 1
        previous = block
    data = sum(manifest.block_len(b) for b in blocks)
    return {
        "blocks": manifest.block_count,
        "changed": len(blocks),
        "bytes": HEADER_SIZE + len(table) + data,
        "image_bytes": manifest.image_size,
        "runs": runs,
    }


def object_key(version: str, sha256: bytes) -> str:
    """Where the package goes in the firmware bucket: under firmware/, the prefix a board downloads from."""
    return f"firmware/pi-{version.replace('+', '~')}-{sha256.hex()}.cpd"


def job_id(version: str, now: float | None = None, suffix: str | None = None) -> str:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() if now is None else now))
    ident = f"pi-{re.sub(r'[^A-Za-z0-9_-]', '-', version)}-{stamp}-{suffix or os.urandom(2).hex()}"
    if not JOB_ID.match(ident):
        raise ValueError(f"{ident} is not a job ID")
    return ident


def job_document(manifest: Manifest, url: str) -> dict:
    return {"op": "pi_delta", "v": 1,
            "pi": {"version": manifest.version, "sha256": manifest.image_sha256.hex(), "url": url}}


def record(manifest: Manifest, package: Path) -> dict:
    return {
        "version": manifest.version,
        "size": manifest.image_size,
        "sha256": manifest.image_sha256.hex(),
        "blockSize": manifest.block_size,
        "blocks": manifest.block_count,
        "tableSha256": manifest.table_sha256.hex(),
        "header": manifest.encode().hex(),
        "packageSize": Path(package).stat().st_size,
        "object": object_key(manifest.version, manifest.image_sha256),
    }


# --- the card --------------------------------------------------------------------------------------

def _round_up(value: int, to: int) -> int:
    return -(-value // to) * to


def card_layout(max_blocks: int) -> dict:
    """pi_card_layout_for(): where each area starts, in sectors."""
    slot = _round_up(1 + _round_up(max_blocks * HASH_SIZE, SECTOR) // SECTOR, CARD_ALIGN)
    listing = _round_up(_round_up(max_blocks * 4, SECTOR) // SECTOR, CARD_ALIGN)
    slot0 = CARD_BASE_LBA + CARD_ALIGN
    slot1 = slot0 + slot
    list_lba = slot1 + slot
    staging = list_lba + listing
    return {"state": [CARD_BASE_LBA, CARD_BASE_LBA + 1], "slot": [slot0, slot1], "list": list_lba,
            "staging": staging, "mirror": _round_up(staging + BLOCK_MAX // SECTOR, CARD_MIRROR_ALIGN)}


def encode_state(seq: int, max_blocks: int, state: int, cur: int, new: int, phase: int, flags: int,
                 generation: int, changed: int, next_: int, base_version: str = "", base_sha256: bytes = bytes(32)) -> bytes:
    version = base_version.encode()
    raw = struct.pack("<4sHHIIBBBBB3xIII32s32s", STATE_MAGIC, STATE_FORMAT, 0, seq, max_blocks, state, cur, new,
                      phase, flags, generation, changed, next_, version + bytes(32 - len(version)), base_sha256)
    raw += bytes(SECTOR - 4 - len(raw))
    return raw + struct.pack("<I", zlib.crc32(raw))


def decode_state(raw: bytes) -> dict | None:
    if raw[:4] != STATE_MAGIC or zlib.crc32(raw[:SECTOR - 4]) != struct.unpack_from("<I", raw, SECTOR - 4)[0]:
        return None
    (_, _, _, seq, max_blocks, state, cur, new, phase, flags, generation, changed, next_, base_version,
     base_sha) = struct.unpack_from("<4sHHIIBBBBB3xIII32s32s", raw)
    return {"seq": seq, "max_blocks": max_blocks, "state": state, "cur": cur, "new": new, "phase": phase,
            "flags": flags, "generation": generation, "changed": changed, "next": next_,
            "base_version": base_version.rstrip(b"\0").decode(), "base_sha256": base_sha}


def mbr(total_sectors: int) -> bytes:
    """A partition table with one partition of type 0xDA from CARD_BASE_LBA to the end."""
    sectors = min(total_sectors - CARD_BASE_LBA, 0xFFFFFFFF)
    entry = struct.pack("<B3sB3sII", 0, b"\xfe\xff\xff", PARTITION_TYPE, b"\xfe\xff\xff", CARD_BASE_LBA, sectors)
    return bytes(446) + entry + bytes(48) + b"\x55\xaa"


def write_card(package: Path, out: Path, max_blocks: int = DEFAULT_MAX_BLOCKS, card_size: int | None = None) -> dict:
    """The card of a board that holds the package's image: ready, generation 1, every block listed as new."""
    manifest, table = read_package(package)
    if manifest.block_count > max_blocks:
        raise ValueError(f"{manifest.block_count} blocks: more than the layout's {max_blocks}")
    layout = card_layout(max_blocks)
    end = layout["mirror"] * SECTOR + manifest.image_size
    total = card_size if card_size else end
    if total < end:
        raise ValueError(f"the card needs at least {end} bytes")
    state = encode_state(1, max_blocks, STATE_READY, 0, 1, 0, FLAG_HAS_CUR | FLAG_LIST_VALID, 1,
                         manifest.block_count, 0)
    listing = b"".join(struct.pack("<I", b) for b in range(manifest.block_count))
    listing += b"\xff" * (_round_up(len(listing), SECTOR) - len(listing))
    with Path(out).open("wb") as f, Path(package).open("rb") as src:
        f.write(mbr(total // SECTOR))
        f.seek(layout["state"][0] * SECTOR)
        f.write(state)
        f.seek(layout["slot"][0] * SECTOR)
        f.write(manifest.encode())
        f.write(table)
        f.seek(layout["list"] * SECTOR)
        f.write(listing)
        f.seek(layout["mirror"] * SECTOR)
        src.seek(manifest.image_offset)
        for chunk in iter(lambda: src.read(1 << 20), b""):
            f.write(chunk)
        f.truncate(total)
    return {"layout": layout, "bytes": total}


# --- commands --------------------------------------------------------------------------------------

def _human(n: int) -> str:
    for unit in ("bytes", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n} {unit}" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def cmd_package(args) -> int:
    image = Path(args.image)
    out = Path(args.out) if args.out else image.with_name(image.name + ".cpd")
    manifest = write_package(image, out, args.version, load_private(Path(args.key)), args.block_size)
    if not verify_signature(manifest.signed_bytes(), manifest.sig, load_public(PUBLIC_KEY)):
        print(f"warning: {args.key} is not the key of {PUBLIC_KEY.relative_to(REPO)}: boards will refuse this package",
              file=sys.stderr)
    rec = record(manifest, out)
    Path(str(out) + ".json").write_text(json.dumps(rec, indent=2) + "\n")
    print(f"Packaged {image.name}: {manifest.image_size} bytes in {manifest.block_count} blocks of "
          f"{manifest.block_size}, SHA-256 {manifest.image_sha256.hex()}. Package: {out}")
    if args.previous:
        est = download_estimate(read_package(Path(args.previous)), (manifest, read_package(out)[1]))
        print(f"From {args.previous}: {est['changed']} of {est['blocks']} blocks changed, a board downloads "
              f"{_human(est['bytes'])} of {_human(est['image_bytes'])} in {est['runs']} ranges")
    url = "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/" + rec["object"] + "}"
    print("To deploy it (nothing here runs them):")
    print(f"  aws s3 cp {out} s3://<bucket>/{rec['object']} --profile cranium")
    print(f"  job ID: {job_id(manifest.version)}")
    print(f"  job document: {json.dumps(job_document(manifest, url))}")
    return 0


def cmd_verify(args) -> int:
    problems = verify_package(Path(args.package), load_public(Path(args.key)))
    for problem in problems:
        print(problem)
    print("package good" if not problems else "package BAD")
    return 0 if not problems else 1


def cmd_diff(args) -> int:
    est = download_estimate(read_package(Path(args.old)), read_package(Path(args.new)))
    print(json.dumps(est))
    return 0


def cmd_card(args) -> int:
    result = write_card(Path(args.package), Path(args.out), args.max_blocks, args.card_size)
    print(f"Wrote {args.out}: {_human(result['bytes'])}. The mirror starts at sector {result['layout']['mirror']}.")
    print("Write it to the card from a computer, with the card's whole device (it replaces the partition table).")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("package", help="build and sign the package of an image")
    p.add_argument("image")
    p.add_argument("--version", required=True)
    p.add_argument("--block-size", type=int, default=DEFAULT_BLOCK)
    p.add_argument("--key", default=os.environ.get("CRANIUM_SIGNING_KEY", str(DEFAULT_KEY)))
    p.add_argument("--previous", help="the package the boards hold now, to say what they download")
    p.add_argument("--out")
    p.set_defaults(run=cmd_package)
    v = commands.add_parser("verify", help="check a package")
    v.add_argument("package")
    v.add_argument("--key", default=str(PUBLIC_KEY))
    v.set_defaults(run=cmd_verify)
    d = commands.add_parser("diff", help="what a board downloads to go from one package to another")
    d.add_argument("old")
    d.add_argument("new")
    d.set_defaults(run=cmd_diff)
    c = commands.add_parser("card", help="write a card that holds a package's image")
    c.add_argument("package")
    c.add_argument("--out", required=True)
    c.add_argument("--max-blocks", type=int, default=DEFAULT_MAX_BLOCKS)
    c.add_argument("--card-size", type=int)
    c.set_defaults(run=cmd_card)
    args = parser.parse_args(argv)
    try:
        return args.run(args)
    except (OSError, ValueError, KeyError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
