#!/usr/bin/env python3
"""Cranium OS updates on the Pi: A/B slots with tryboot, and updates as deltas (docs/pi-tryboot.md).

The SD card has two copies of the system, slot A (boot_a + root_a) and slot B (boot_b + root_b), and
the Pi's bootloader picks one through autoboot.txt (tryboot_a_b=1). An update rebuilds the slot that is
not running, boots it once with tryboot, and keeps it only if the health check passes; otherwise the
next boot is the old slot again, as with MCUboot's test swap on the nRF.

An update file is a tar of:
  manifest.json      what it is: the version, the slot it starts from (or none, for a full image),
                     the SHA-256 and size of the boot and root partitions it produces, and its parts
  manifest.sig       Ed25519 signature of manifest.json (openssl), by the Pi OS signing key
  boot.delta         for each partition: the 4 KiB blocks that differ from the running slot's,
  root.delta         lzma-compressed. A full image is a delta from nothing: all its blocks.

Commands:
  make     (on a PC or in CI) build and sign an update from two slot images, or from one (full)
  apply    (on the Pi, as root) check an update, rebuild the spare slot, boot it once with tryboot
  confirm  (on the Pi, at every boot, as root) after a tryboot: keep the new slot if healthy, else go back
  status   which slot runs, its version, and whether an update is on trial: what the nRF is told
  export   (on the Pi) save a slot's partitions as release images, to make deltas from

Standard library only, plus the openssl command for signatures.
"""
import argparse
import hashlib
import io
import json
import lzma
import os
import shlex
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time

FORMAT = 1
BLOCK = 4096
RUN_MAX = 256                      # blocks per record: at most 1 MiB of data in one
COPY_CHUNK = 1 << 20
DELTA_MAGIC = b"CRD1"
END = 0xFFFFFFFFFFFFFFFF
PARTS = ("boot", "root")
HOME = os.path.expanduser("~")


class UpdateError(Exception):
    """An update that must not be installed; the message says why."""


# ---- the one byte that differs between the slots
#
# Each slot's boot partition names its own root in cmdline.txt: root=PARTLABEL=root_a in slot A,
# root_b in slot B. Releases, deltas and their hashes always hold "a"; the installer writes the slot's
# letter after the check, and puts "a" back before it hashes or copies a slot.

MARKER = b"root=PARTLABEL=root_"


def find_marker(path, size):
    """The offset of the slot letter after MARKER in the first `size` bytes; there must be one."""
    found, offset, tail = [], 0, b""
    with open(path, "rb") as f:
        while offset < size:
            chunk = f.read(min(COPY_CHUNK, size - offset))
            if not chunk:
                break
            data = tail + chunk
            start = 0
            while True:
                i = data.find(MARKER, start)
                if i < 0 or i + len(MARKER) >= len(data):
                    break
                found.append(offset - len(tail) + i + len(MARKER))
                start = i + 1
            tail = data[-(len(MARKER) + 1):]
            offset += len(chunk)
    found = sorted(set(found))
    if len(found) != 1:
        raise UpdateError(f"{path}: expected one '{MARKER.decode()}<slot>' in cmdline.txt, found {len(found)}")
    return found[0]


def set_slot_letter(path, size, slot):
    at = find_marker(path, size)
    with open(path, "r+b") as f:
        f.seek(at)
        f.write(slot.encode())
        f.flush()
        os.fsync(f.fileno())


# ---- hashing and versions

def sha256_of(path, size, letter_at=None):
    """SHA-256 of the first `size` bytes of a file or block device. With letter_at, the byte there
    counts as "a": a boot partition's hash in the form releases have."""
    h = hashlib.sha256()
    left, pos = size, 0
    with open(path, "rb") as f:
        while left:
            chunk = f.read(min(COPY_CHUNK, left))
            if not chunk:
                raise UpdateError(f"{path} is shorter than {size} bytes")
            if letter_at is not None and pos <= letter_at < pos + len(chunk):
                chunk = chunk[:letter_at - pos] + b"a" + chunk[letter_at - pos + 1:]
            h.update(chunk)
            pos += len(chunk)
            left -= len(chunk)
    return h.hexdigest()


def release_hash(path, size, name):
    """A partition's hash as a release has it: for boot, with the slot letter as "a"."""
    return sha256_of(path, size, find_marker(path, size) if name == "boot" else None)


def image_info(path):
    size = os.path.getsize(path)
    return {"size": size, "sha256": sha256_of(path, size)}


def version_key(text):
    try:
        return tuple(int(x) for x in text.split("."))
    except (AttributeError, ValueError):
        raise UpdateError(f"not a version: {text!r}")


# ---- deltas

def make_delta(old_path, new_path, out):
    """Write to `out` (a binary file) the blocks of new_path that differ from old_path, or all of
    them if old_path is None. Returns the number of blocks written."""
    size = os.path.getsize(new_path)
    old = open(old_path, "rb") if old_path else None
    written = 0
    try:
        with open(new_path, "rb") as new, lzma.open(out, "wb", preset=6) as z:
            z.write(DELTA_MAGIC + struct.pack("<IQ", BLOCK, size))
            run_start, run = None, []

            def flush():
                nonlocal run_start, run
                if run:
                    z.write(struct.pack("<QI", run_start, len(run)))
                    for b in run:
                        z.write(b)
                run_start, run = None, []

            index = 0
            while True:
                block = new.read(BLOCK)
                if not block:
                    break
                same = old is not None and old.read(BLOCK) == block
                if same:
                    flush()
                else:
                    if run_start is None:
                        run_start = index
                    run.append(block)
                    written += 1
                    if len(run) == RUN_MAX:
                        flush()
                index += 1
            flush()
            z.write(struct.pack("<QI", END, 0))
    finally:
        if old:
            old.close()
    return written


def apply_delta(delta, source, source_size, target, target_size, letter_a=False):
    """Rebuild `target` (a partition or file) as the new image: first a copy of `source` (the running
    slot's partition, or None for a full image), then the delta's blocks on top. With letter_a, the
    copy's slot letter is put back to "a" first, as the delta was made from the release's bytes."""
    with lzma.open(delta, "rb") as z:
        head = z.read(16)
        if len(head) != 16 or head[:4] != DELTA_MAGIC:
            raise UpdateError("not a Cranium delta")
        block, size = struct.unpack("<IQ", head[4:])
        if block != BLOCK or size != target_size:
            raise UpdateError(f"delta for {size} bytes in blocks of {block}; expected {target_size} in {BLOCK}")
        mode = "r+b" if os.path.exists(target) else "w+b"
        with open(target, mode) as out:
            if source is not None:
                left = min(source_size, target_size)
                with open(source, "rb") as src:
                    while left:
                        chunk = src.read(min(COPY_CHUNK, left))
                        if not chunk:
                            raise UpdateError(f"{source} ended early")
                        out.write(chunk)
                        left -= len(chunk)
                if letter_a:
                    out.flush()
                    at = find_marker(target, min(source_size, target_size))
                    out.seek(at)
                    out.write(b"a")
            while True:
                rec = z.read(12)
                if len(rec) != 12:
                    raise UpdateError("the delta ends early")
                index, count = struct.unpack("<QI", rec)
                if index == END:
                    break
                start = index * BLOCK
                length = min(count * BLOCK, target_size - start)
                if count == 0 or start >= target_size or length <= 0:
                    raise UpdateError("the delta writes outside the image")
                data = z.read(length)
                if len(data) != length:
                    raise UpdateError("the delta ends early")
                out.seek(start)
                out.write(data)
            if stat.S_ISREG(os.fstat(out.fileno()).st_mode):
                out.truncate(target_size)       # a file (the tests); a partition keeps its size
            out.flush()
            os.fsync(out.fileno())


# ---- signatures (openssl, Ed25519)

def sign(data, key):
    with tempfile.TemporaryDirectory() as d:
        msg, sig = os.path.join(d, "m"), os.path.join(d, "s")
        with open(msg, "wb") as f:
            f.write(data)
        run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", key, "-in", msg, "-out", sig])
        with open(sig, "rb") as f:
            return f.read()


def verify(data, signature, pubkey):
    with tempfile.TemporaryDirectory() as d:
        msg, sig = os.path.join(d, "m"), os.path.join(d, "s")
        with open(msg, "wb") as f:
            f.write(data)
        with open(sig, "wb") as f:
            f.write(signature)
        r = subprocess.run(["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", pubkey,
                            "-in", msg, "-sigfile", sig], capture_output=True)
        return r.returncode == 0


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise UpdateError(f"{cmd[0]} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


# ---- update files

def make_update(version, new_boot, new_root, key, out_path, old_boot=None, old_root=None, old_version=None):
    """Build and sign an update. With old_* it is a delta from that slot; without, a full image."""
    if (old_boot is None) != (old_root is None) or (old_boot is not None and not old_version):
        raise UpdateError("a delta needs the old boot and root images and the old version")
    version_key(version)
    for boot in (new_boot, old_boot):
        if boot is not None:
            with open(boot, "rb") as f:
                f.seek(find_marker(boot, os.path.getsize(boot)))
                if f.read(1) != b"a":
                    raise UpdateError(f"{boot}: a release's boot image names root_a (use `export`, which does)")
    with tempfile.TemporaryDirectory() as d:
        parts, blocks = {}, {}
        for name, old, new in (("boot", old_boot, new_boot), ("root", old_root, new_root)):
            path = os.path.join(d, f"{name}.delta")
            with open(path, "wb") as f:
                blocks[name] = make_delta(old, new, f)
            parts[name] = {"file": f"{name}.delta", **image_info(path)}
        manifest = {
            "format": FORMAT,
            "version": version,
            "from": None if old_boot is None else {
                "version": old_version, "boot": image_info(old_boot), "root": image_info(old_root)},
            "to": {"boot": image_info(new_boot), "root": image_info(new_root)},
            "parts": parts,
        }
        body = json.dumps(manifest, indent=1, sort_keys=True).encode()
        with tarfile.open(out_path, "w") as tar:
            for name, data in (("manifest.json", body), ("manifest.sig", sign(body, key))):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            for name in PARTS:
                tar.add(os.path.join(d, parts[name]["file"]), arcname=parts[name]["file"])
    return manifest, blocks


def open_update(path, pubkey, workdir):
    """Check the signature and unpack the parts into workdir. Returns the manifest."""
    with tarfile.open(path, "r") as tar:
        names = set(tar.getnames())
        for need in ("manifest.json", "manifest.sig", "boot.delta", "root.delta"):
            if need not in names:
                raise UpdateError(f"the update has no {need}")
        body = tar.extractfile("manifest.json").read()
        sig = tar.extractfile("manifest.sig").read()
        if not verify(body, sig, pubkey):
            raise UpdateError("the signature does not match the Pi OS signing key")
        manifest = json.loads(body)
        if manifest.get("format") != FORMAT:
            raise UpdateError(f"update format {manifest.get('format')}; this Pi takes {FORMAT}")
        for name in PARTS:
            member = tar.getmember(manifest["parts"][name]["file"])
            if not member.isfile() or os.path.basename(member.name) != member.name:
                raise UpdateError(f"bad file name in the update: {member.name!r}")
            tar.extract(member, workdir, filter="data")
            got = image_info(os.path.join(workdir, member.name))
            if got != {k: manifest["parts"][name][k] for k in ("size", "sha256")}:
                raise UpdateError(f"{member.name} does not match the manifest")
    return manifest


# ---- the card: slots, autoboot.txt, state

class Card:
    """Where the slots are. On a Pi the partitions are /dev/mmcblk0p2.. ; the tests use files."""

    SLOTS = {"a": {"boot": 2, "root": 4}, "b": {"boot": 3, "root": 5}}

    def __init__(self, conf):
        self.disk = conf["CRANIUM_OTA_DISK"]
        self.autoboot = conf["CRANIUM_OTA_AUTOBOOT"]
        self.state_path = conf["CRANIUM_OTA_STATE"]
        self.bootloader = conf["CRANIUM_OTA_BOOTLOADER_DT"]
        self.version_file = conf["CRANIUM_OTA_VERSION_FILE"]

    def part(self, slot, name):
        sep = "p" if self.disk[-1].isdigit() else ""
        return f"{self.disk}{sep}{self.SLOTS[slot][name]}"

    def _dt_u32(self, name):
        try:
            with open(os.path.join(self.bootloader, name), "rb") as f:
                return struct.unpack(">I", f.read(4))[0]
        except (OSError, struct.error):
            return None

    def booted_partition(self):
        return self._dt_u32("partition")

    def is_tryboot(self):
        return self._dt_u32("tryboot") == 1

    def active(self):
        part = self.booted_partition()
        for slot, p in self.SLOTS.items():
            if p["boot"] == part:
                return slot
        raise UpdateError(f"booted from partition {part}, which is not a slot's boot partition: "
                          "is this card set up for A/B (cranium-ab-setup)?")

    @staticmethod
    def other(slot):
        return "b" if slot == "a" else "a"

    def write_autoboot(self, default_slot, try_slot):
        text = ("# Written by cranium_ota.py. The Pi's bootloader boots [all]'s partition, and once\n"
                "# [tryboot]'s after `reboot \"0 tryboot\"`.\n"
                f"[all]\ntryboot_a_b=1\nboot_partition={self.SLOTS[default_slot]['boot']}\n"
                f"[tryboot]\nboot_partition={self.SLOTS[try_slot]['boot']}\n")
        atomic_write(self.autoboot, text.encode())

    def default_slot(self):
        """The slot [all] boots, from autoboot.txt."""
        try:
            with open(self.autoboot, encoding="utf-8") as f:
                section = None
                for line in f:
                    line = line.strip()
                    if line.startswith("["):
                        section = line
                    elif section == "[all]" and line.startswith("boot_partition="):
                        part = int(line.split("=", 1)[1])
                        return next(s for s, p in self.SLOTS.items() if p["boot"] == part)
        except (OSError, ValueError, StopIteration):
            pass
        return None

    def running_version(self):
        """The running release's version, from its own root (/etc/cranium-os), or None."""
        try:
            with open(self.version_file, encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError:
            return None

    def load_state(self):
        try:
            with open(self.state_path, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {"pending": None, "last": None}

    def save_state(self, state):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        atomic_write(self.state_path, json.dumps(state, indent=1, sort_keys=True).encode())


def atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---- the commands on the Pi

def apply_update(card, conf, update_path, reboot=True, log=print):
    state = card.load_state()
    active = card.active()
    spare = card.other(active)
    if card.is_tryboot():
        raise UpdateError("this boot is a trial: confirm or roll it back before the next update")
    running = card.running_version()
    with tempfile.TemporaryDirectory(dir=conf.get("CRANIUM_OTA_WORKDIR") or None) as work:
        m = open_update(update_path, conf["CRANIUM_OTA_PUBKEY"], work)
        log(f"# update {m['version']} ({'delta from ' + m['from']['version'] if m['from'] else 'full image'}),"
            f" running slot {active} ({running or 'unknown version'})")
        if running and version_key(m["version"]) <= version_key(running):
            raise UpdateError(f"{m['version']} is not newer than the running {running}")
        if m["from"]:
            for name in PARTS:
                want = m["from"][name]
                log(f"# checking the running {name} partition against the update's starting point")
                if release_hash(card.part(active, name), want["size"], name) != want["sha256"]:
                    raise UpdateError(f"the running slot's {name} partition is not {m['from']['version']}: "
                                      "this delta does not apply to it (a full image does)")
        for name in PARTS:
            log(f"# writing {name} into slot {spare}")
            src = card.part(active, name) if m["from"] else None
            apply_delta(os.path.join(work, m["parts"][name]["file"]), src,
                        m["from"][name]["size"] if m["from"] else 0,
                        card.part(spare, name), m["to"][name]["size"],
                        letter_a=(name == "boot" and m["from"] is not None))
        for name in PARTS:
            size = m["to"][name]["size"]
            if release_hash(card.part(spare, name), size, name) != m["to"][name]["sha256"]:
                raise UpdateError(f"slot {spare}'s {name} partition does not match the update after writing")
        set_slot_letter(card.part(spare, "boot"), m["to"]["boot"]["size"], spare)
    state["pending"] = {"slot": spare, "version": m["version"], "since": int(time.time())}
    card.save_state(state)
    card.write_autoboot(default_slot=active, try_slot=spare)
    log(f"# slot {spare} holds {m['version']}; booting it once on trial")
    if reboot:
        run(shlex.split(conf["CRANIUM_OTA_REBOOT_TRY"]))
    return spare


def healthy(conf, log=print, clock=time.monotonic, sleep=time.sleep):
    """The health check, again and again until it passes or CRANIUM_OTA_CONFIRM_SECONDS run out."""
    deadline = clock() + float(conf["CRANIUM_OTA_CONFIRM_SECONDS"])
    cmd = shlex.split(conf["CRANIUM_OTA_HEALTH"])
    while True:
        try:
            if subprocess.run(cmd, capture_output=True, timeout=30).returncode == 0:
                return True
        except (OSError, subprocess.TimeoutExpired) as e:
            log(f"# health check: {e}")
        if clock() >= deadline:
            return False
        sleep(float(conf["CRANIUM_OTA_CONFIRM_EVERY"]))


def confirm(card, conf, reboot=True, log=print, check=None):
    """At every boot. After a tryboot: keep the new slot if healthy, otherwise boot the old one."""
    state = card.load_state()
    active = card.active()
    pending = state.get("pending")
    if not card.is_tryboot():
        if pending:
            # The trial is over and the old slot booted: the new one was not kept.
            log(f"# slot {pending['slot']} ({pending['version']}) was on trial and is not kept")
            state["last"] = {**pending, "result": "rolled back", "at": int(time.time())}
            state["pending"] = None
            card.save_state(state)
        return "normal"
    if not pending or pending["slot"] != active:
        log("# a tryboot with no update on trial: going back to the default slot")
        if reboot:
            run(shlex.split(conf["CRANIUM_OTA_REBOOT"]))
        return "unexpected"
    log(f"# slot {active} ({pending['version']}) is on trial: health check")
    if (check or healthy)(conf, log=log):
        card.write_autoboot(default_slot=active, try_slot=card.other(active))
        state["last"] = {**pending, "result": "confirmed", "at": int(time.time())}
        state["pending"] = None
        card.save_state(state)
        log(f"# slot {active} ({pending['version']}) confirmed: it boots from now on")
        return "confirmed"
    log(f"# slot {active} ({pending['version']}) failed its health check: going back")
    if reboot:
        run(shlex.split(conf["CRANIUM_OTA_REBOOT"]))
    return "failed"


def device_size(path):
    """The size of a file or a block device (os.path.getsize says 0 for a device)."""
    with open(path, "rb") as f:
        return f.seek(0, os.SEEK_END)


def export_slot(card, slot, out_dir, log=print):
    """Save a slot's boot and root partitions as release images (boot with the letter "a"), to make
    deltas from: boot.img and root.img in out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    paths = {}
    for name in PARTS:
        src, dst = card.part(slot, name), os.path.join(out_dir, f"{name}.img")
        size = device_size(src)
        log(f"# saving slot {slot}'s {name} partition ({size} bytes) to {dst}")
        with open(src, "rb") as i, open(dst, "wb") as o:
            left = size
            while left:
                chunk = i.read(min(COPY_CHUNK, left))
                if not chunk:
                    raise UpdateError(f"{src} ended early")
                o.write(chunk)
                left -= len(chunk)
        if name == "boot":
            set_slot_letter(dst, size, "a")
        paths[name] = dst
    return paths


def status(card):
    state = card.load_state()
    active = card.active()
    return {"slot": active, "version": card.running_version(), "trial": card.is_tryboot(),
            "pending": state.get("pending"),
            "default": card.default_slot(), "last": state.get("last")}


# ---- configuration and the command line

DEFAULTS = {
    "CRANIUM_OTA_DISK": "/dev/mmcblk0",
    "CRANIUM_OTA_AUTOBOOT": "/boot/autoboot/autoboot.txt",
    "CRANIUM_OTA_STATE": "/data/cranium-ota/state.json",
    "CRANIUM_OTA_VERSION_FILE": "/etc/cranium-os",
    "CRANIUM_OTA_BOOTLOADER_DT": "/proc/device-tree/chosen/bootloader",
    "CRANIUM_OTA_PUBKEY": os.path.join(os.path.dirname(os.path.abspath(__file__)), "ota", "pi_os_signing_pub.pem"),
    "CRANIUM_OTA_WORKDIR": "/data/cranium-ota",
    "CRANIUM_OTA_HEALTH": os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "cranium-link") + " --status",
    "CRANIUM_OTA_CONFIRM_SECONDS": "300",
    "CRANIUM_OTA_CONFIRM_EVERY": "10",
    # As Raspberry Pi documents it: the "0 tryboot" argument makes the next boot a trial.
    "CRANIUM_OTA_REBOOT_TRY": "reboot '0 tryboot'",
    "CRANIUM_OTA_REBOOT": "systemctl reboot",
}


def load_conf(environ=None):
    environ = os.environ if environ is None else environ
    return {k: environ.get(k, v) for k, v in DEFAULTS.items()}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    mk = sub.add_parser("make", help="build and sign an update (on a PC or in CI)")
    mk.add_argument("--version", required=True, help="the new image's version, e.g. 1.4.0")
    mk.add_argument("--boot", required=True, help="the new boot partition image")
    mk.add_argument("--root", required=True, help="the new root partition image")
    mk.add_argument("--from-version", help="the version a delta starts from")
    mk.add_argument("--from-boot", help="that version's boot partition image (a delta; else a full image)")
    mk.add_argument("--from-root", help="that version's root partition image")
    mk.add_argument("--key", default=os.path.join(HOME, ".cranium", "pi_os_signing_key.pem"))
    mk.add_argument("--out", required=True)
    ap_apply = sub.add_parser("apply", help="install an update into the spare slot and boot it on trial")
    ap_apply.add_argument("update")
    ap_apply.add_argument("--no-reboot", action="store_true", help="prepare the trial, reboot later")
    ap_confirm = sub.add_parser("confirm", help="at boot: keep a slot on trial if healthy, else go back")
    ap_confirm.add_argument("--no-reboot", action="store_true")
    sub.add_parser("status", help="the running slot and version, as JSON")
    ap_export = sub.add_parser("export", help="save a slot as release images (boot.img, root.img), for `make`")
    ap_export.add_argument("--slot", choices=("a", "b"), help="default: the running slot")
    ap_export.add_argument("--out", required=True, help="a folder with room for both partitions")
    args = ap.parse_args(argv)
    conf = load_conf()
    try:
        if args.cmd == "make":
            m, blocks = make_update(args.version, args.boot, args.root, args.key, args.out,
                                    args.from_boot, args.from_root, args.from_version)
            kind = f"delta from {m['from']['version']}" if m["from"] else "full image"
            print(f"{args.out}: {m['version']}, {kind}, {blocks['boot']} + {blocks['root']} blocks of {BLOCK} "
                  f"bytes, {os.path.getsize(args.out)} bytes in all")
        elif args.cmd == "apply":
            apply_update(Card(conf), conf, args.update, reboot=not args.no_reboot)
        elif args.cmd == "confirm":
            confirm(Card(conf), conf, reboot=not args.no_reboot)
        elif args.cmd == "export":
            card = Card(conf)
            export_slot(card, args.slot or card.active(), args.out)
        else:
            print(json.dumps(status(Card(conf)), sort_keys=True))
    except UpdateError as e:
        print(f"cranium_ota: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
