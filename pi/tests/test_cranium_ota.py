#!/usr/bin/env python3
"""Tests of pi/cranium_ota.py: deltas, signed updates, and the A/B slots with tryboot, on files that
stand for the SD card's partitions (no Pi needed). Run with: python3 pi/tests/test_cranium_ota.py
Needs the openssl command (OpenSSL 3), for Ed25519."""
import io
import json
import os
import random
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cranium_ota as ota  # noqa: E402

BLOCK = ota.BLOCK


def random_image(path, size, seed):
    rnd = random.Random(seed)
    with open(path, "wb") as f:
        f.write(bytes(rnd.getrandbits(8) for _ in range(size)))


def change_blocks(src, dst, blocks, seed=1, size=None):
    """dst = src with some 4 KiB blocks changed, and optionally a new size."""
    rnd = random.Random(seed)
    with open(src, "rb") as f:
        data = bytearray(f.read())
    if size is not None:
        data = data[:size] + bytes(max(0, size - len(data)))
    for b in blocks:
        start = b * BLOCK
        data[start:start + BLOCK] = bytes(rnd.getrandbits(8) for _ in range(len(data[start:start + BLOCK])))
    with open(dst, "wb") as f:
        f.write(data)


MARKER_AT = 5 * BLOCK + 100          # where the stand-in boot images say which root to mount


def put_marker(path, letter="a"):
    """A stand-in for cmdline.txt's root=PARTLABEL=root_<slot>, in block 5 (block 0 is what changes)."""
    with open(path, "r+b") as f:
        f.seek(MARKER_AT)
        f.write(ota.MARKER + letter.encode())


def letter_of(path):
    with open(path, "rb") as f:
        f.seek(MARKER_AT + len(ota.MARKER))
        return f.read(1).decode()


def openssl_key(d, name):
    key, pub = os.path.join(d, name + ".pem"), os.path.join(d, name + "_pub.pem")
    subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", key], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-out", pub], check=True, capture_output=True)
    return key, pub


@unittest.skipIf(shutil.which("openssl") is None, "needs the openssl command")
class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.mkdtemp()
        cls.key, cls.pub = openssl_key(cls.keys, "team")
        cls.other_key, _ = openssl_key(cls.keys, "stranger")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.keys, ignore_errors=True)

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.d, name)


class Deltas(Base):
    def roundtrip(self, old_size, new_size, changed):
        old, new, delta, out = (self.path(n) for n in ("old", "new", "delta", "out"))
        random_image(old, old_size, seed=3)
        change_blocks(old, new, changed, size=new_size)
        with open(delta, "wb") as f:
            written = ota.make_delta(old, new, f)
        ota.apply_delta(delta, old, old_size, out, new_size)
        with open(out, "rb") as a, open(new, "rb") as b:
            self.assertEqual(a.read(), b.read())
        return written

    def test_only_the_changed_blocks_are_sent(self):
        self.assertEqual(self.roundtrip(64 * BLOCK, 64 * BLOCK, [0, 5, 6, 7, 63]), 5)

    def test_a_larger_or_smaller_image_with_a_short_last_block(self):
        self.roundtrip(10 * BLOCK, 12 * BLOCK + 100, [2])
        self.roundtrip(12 * BLOCK + 100, 9 * BLOCK + 7, [1])

    def test_nothing_changed_is_almost_nothing(self):
        old, delta = self.path("old"), self.path("delta")
        random_image(old, 256 * BLOCK, seed=5)
        with open(delta, "wb") as f:
            self.assertEqual(ota.make_delta(old, old, f), 0)
        self.assertLess(os.path.getsize(delta), 200)

    def test_a_full_image_is_a_delta_from_nothing(self):
        new, delta, out = self.path("new"), self.path("delta"), self.path("out")
        random_image(new, 7 * BLOCK + 3, seed=9)
        with open(delta, "wb") as f:
            self.assertEqual(ota.make_delta(None, new, f), 8)
        ota.apply_delta(delta, None, 0, out, 7 * BLOCK + 3)
        with open(out, "rb") as a, open(new, "rb") as b:
            self.assertEqual(a.read(), b.read())

    def test_long_runs_are_split(self):
        self.assertEqual(self.roundtrip(600 * BLOCK, 600 * BLOCK, range(0, 600)), 600)

    def test_a_cut_or_wrong_delta_is_refused(self):
        old, new, delta, out = (self.path(n) for n in ("old", "new", "delta", "out"))
        random_image(old, 8 * BLOCK, seed=1)
        change_blocks(old, new, [3])
        with open(delta, "wb") as f:
            ota.make_delta(old, new, f)
        with self.assertRaises(ota.UpdateError):
            ota.apply_delta(delta, old, 8 * BLOCK, out, 9 * BLOCK)       # another size
        import lzma
        with lzma.open(delta, "rb") as z:
            whole = z.read()
        with lzma.open(delta, "wb") as z:
            z.write(whole[:-30])                                        # cut short
        with self.assertRaises(ota.UpdateError):
            ota.apply_delta(delta, old, 8 * BLOCK, out, 8 * BLOCK)


class CardTest(Base):
    """A card with slots A and B, booted from A, with version 1.0.0 in A."""

    SIZE_BOOT, SIZE_ROOT = 16 * BLOCK, 48 * BLOCK

    def setUp(self):
        super().setUp()
        for n in ("dt", "autoboot", "data"):
            os.makedirs(self.path(n))
        self.conf = dict(ota.DEFAULTS)
        self.conf.update({
            "CRANIUM_OTA_DISK": self.path("disk"),
            "CRANIUM_OTA_AUTOBOOT": self.path("autoboot/autoboot.txt"),
            "CRANIUM_OTA_STATE": self.path("data/cranium-ota/state.json"),
            "CRANIUM_OTA_BOOTLOADER_DT": self.path("dt"),
            "CRANIUM_OTA_VERSION_FILE": self.path("cranium-os"),
            "CRANIUM_OTA_PUBKEY": self.pub,
            "CRANIUM_OTA_WORKDIR": self.path("data"),
            "CRANIUM_OTA_CONFIRM_SECONDS": "0",
            "CRANIUM_OTA_CONFIRM_EVERY": "0",
        })
        self.card = ota.Card(self.conf)
        # Slot A: version 1.0.0, as the setup leaves it. Slot B: whatever is there (zeros).
        random_image(self.card.part("a", "boot"), self.SIZE_BOOT, seed=11)
        put_marker(self.card.part("a", "boot"), "a")
        random_image(self.card.part("a", "root"), self.SIZE_ROOT, seed=12)
        for name in ("boot", "root"):
            with open(self.card.part("b", name), "wb") as f:
                f.write(bytes(BLOCK))       # slot B is empty until the first update
        self.v1 = {n: self.path(f"v1.{n}") for n in ("boot", "root")}
        shutil.copy(self.card.part("a", "boot"), self.v1["boot"])
        shutil.copy(self.card.part("a", "root"), self.v1["root"])
        # What each slot's root says in /etc/cranium-os; the running one's is the stand-in file.
        self.slot_versions = {"a": "1.0.0", "b": None}
        self.card.write_autoboot(default_slot="a", try_slot="b")
        self.boot_from(partition=2, tryboot=False)
        self.log = []

    def boot_from(self, partition, tryboot):
        for name, value in (("partition", partition), ("tryboot", int(tryboot))):
            with open(os.path.join(self.path("dt"), name), "wb") as f:
                f.write(struct.pack(">I", value))
        slot = {2: "a", 3: "b"}.get(partition)
        with open(self.conf["CRANIUM_OTA_VERSION_FILE"], "w") as f:
            f.write((self.slot_versions.get(slot) or "") + "\n")

    def new_version(self, version, changed=(1, 2), size_root=None):
        new = {n: self.path(f"{version}.{n}") for n in ("boot", "root")}
        change_blocks(self.v1["boot"], new["boot"], [0])
        change_blocks(self.v1["root"], new["root"], list(changed), size=size_root)
        return new

    def make(self, version, new, delta_from=True, key=None):
        out = self.path(f"{version}.update")
        kw = dict(old_boot=self.v1["boot"], old_root=self.v1["root"], old_version="1.0.0") if delta_from else {}
        with redirect_stdout(io.StringIO()):
            ota.make_update(version, new["boot"], new["root"], key or self.key, out, **kw)
        return out

    def apply(self, update, **kw):
        spare = ota.apply_update(self.card, self.conf, update, reboot=False, log=self.log.append, **kw)
        # The slot now holds the new release, and its root says so in /etc/cranium-os.
        self.slot_versions[spare] = self.card.load_state()["pending"]["version"]
        return spare

    def same(self, a, b):
        with open(a, "rb") as x, open(b, "rb") as y:
            return x.read() == y.read()

    def autoboot(self):
        with open(self.conf["CRANIUM_OTA_AUTOBOOT"]) as f:
            return f.read()


class Apply(CardTest):
    def test_a_delta_rebuilds_the_spare_slot_and_sets_up_the_trial(self):
        new = self.new_version("1.1.0", size_root=50 * BLOCK + 9)
        update = self.make("1.1.0", new)
        self.assertEqual(self.apply(update), "b")
        # The release byte for byte, except that slot B's boot names root_b.
        self.assertEqual(ota.release_hash(self.card.part("b", "boot"), os.path.getsize(new["boot"]), "boot"),
                         ota.image_info(new["boot"])["sha256"])
        self.assertEqual(letter_of(self.card.part("b", "boot")), "b")
        self.assertTrue(self.same(self.card.part("b", "root"), new["root"]))
        self.assertTrue(self.same(self.card.part("a", "root"), self.v1["root"]), "the running slot is untouched")
        self.assertIn("[all]\ntryboot_a_b=1\nboot_partition=2\n[tryboot]\nboot_partition=3", self.autoboot())
        state = self.card.load_state()
        self.assertEqual((state["pending"]["slot"], state["pending"]["version"]), ("b", "1.1.0"))

    def test_the_delta_is_small_for_a_small_change(self):
        update = self.make("1.1.0", self.new_version("1.1.0", changed=(4,)))
        full = self.make("1.1.1", self.new_version("1.1.1", changed=(4,)), delta_from=False)
        self.assertLess(os.path.getsize(update), os.path.getsize(full) / 4)

    def test_a_full_image_needs_no_starting_point(self):
        with open(self.card.part("a", "root"), "r+b") as f:
            f.write(b"someone changed the running root")        # a delta could not apply now
        new = self.new_version("2.0.0")
        self.apply(self.make("2.0.0", new, delta_from=False))
        self.assertTrue(self.same(self.card.part("b", "root"), new["root"]))

    def test_a_delta_for_another_starting_point_is_refused(self):
        with open(self.card.part("a", "root"), "r+b") as f:
            f.write(b"not 1.0.0 any more")
        update = self.make("1.1.0", self.new_version("1.1.0"))
        with self.assertRaisesRegex(ota.UpdateError, "does not apply"):
            self.apply(update)
        self.assertIsNone(self.card.load_state()["pending"])
        self.assertIn("boot_partition=2\n[tryboot]\nboot_partition=3", self.autoboot())

    def test_a_wrong_signature_or_a_changed_part_is_refused(self):
        stranger = self.make("1.1.0", self.new_version("1.1.0"), key=self.other_key)
        with self.assertRaisesRegex(ota.UpdateError, "signature"):
            self.apply(stranger)
        good = self.make("1.1.1", self.new_version("1.1.1"))
        tampered = self.path("tampered.update")
        with tarfile.open(good) as src, tarfile.open(tampered, "w") as dst:
            for m in src.getmembers():
                data = src.extractfile(m).read()
                if m.name == "root.delta":
                    data = data[:-1] + bytes([data[-1] ^ 1])
                m.size = len(data)
                dst.addfile(m, io.BytesIO(data))
        with self.assertRaisesRegex(ota.UpdateError, "does not match the manifest"):
            self.apply(tampered)

    def test_an_older_or_same_version_is_refused(self):
        for running in ("1.5.0", "1.1.0"):
            self.slot_versions["a"] = running
            self.boot_from(partition=2, tryboot=False)
            update = self.make("1.1.0", self.new_version("1.1.0"))
            with self.assertRaisesRegex(ota.UpdateError, "not newer"):
                self.apply(update)
        self.assertIsNone(self.card.load_state()["pending"])

    def test_no_update_during_a_trial(self):
        self.boot_from(partition=3, tryboot=True)
        with self.assertRaisesRegex(ota.UpdateError, "trial"):
            self.apply(self.make("1.1.0", self.new_version("1.1.0")))

    def test_a_card_that_is_not_ab_is_said_so(self):
        self.boot_from(partition=1, tryboot=False)
        with self.assertRaisesRegex(ota.UpdateError, "A/B"):
            self.apply(self.make("1.1.0", self.new_version("1.1.0")))


class SlotLetter(CardTest):
    def test_slot_b_names_root_b_and_still_checks_out_as_the_release(self):
        new = self.new_version("1.1.0")
        self.apply(self.make("1.1.0", new))
        self.assertEqual(letter_of(self.card.part("b", "boot")), "b")
        self.assertEqual(letter_of(self.card.part("a", "boot")), "a")
        size = os.path.getsize(new["boot"])
        self.assertEqual(ota.release_hash(self.card.part("b", "boot"), size, "boot"),
                         ota.image_info(new["boot"])["sha256"])

    def test_the_next_update_from_slot_b_writes_slot_a_with_root_a(self):
        v11 = self.new_version("1.1.0")
        self.apply(self.make("1.1.0", v11))
        self.boot_from(partition=3, tryboot=True)
        ota.confirm(self.card, self.conf, reboot=False, log=self.log.append, check=lambda conf, log: True)
        self.boot_from(partition=3, tryboot=False)
        # 1.2.0, made from 1.1.0's release images: slot B's boot says root_b, the delta says root_a.
        v12 = {n: self.path(f"1.2.0.{n}") for n in ("boot", "root")}
        change_blocks(v11["boot"], v12["boot"], [1])
        change_blocks(v11["root"], v12["root"], [9])
        out = self.path("1.2.0.update")
        with redirect_stdout(io.StringIO()):
            ota.make_update("1.2.0", v12["boot"], v12["root"], self.key, out,
                            old_boot=v11["boot"], old_root=v11["root"], old_version="1.1.0")
        self.assertEqual(self.apply(out), "a")
        self.assertEqual(letter_of(self.card.part("a", "boot")), "a")
        self.assertTrue(self.same(self.card.part("a", "root"), v12["root"]))
        self.assertIn("[all]\ntryboot_a_b=1\nboot_partition=3\n[tryboot]\nboot_partition=2", self.autoboot())

    def test_export_saves_release_images_with_root_a(self):
        v11 = self.new_version("1.1.0")
        self.apply(self.make("1.1.0", v11))
        out = ota.export_slot(self.card, "b", self.path("exported"), log=self.log.append)
        self.assertEqual(letter_of(out["boot"]), "a")
        self.assertTrue(self.same(out["boot"], v11["boot"]))
        self.assertTrue(self.same(out["root"], v11["root"]))

    def test_make_refuses_a_boot_image_that_names_root_b(self):
        new = self.new_version("1.1.0")
        put_marker(new["boot"], "b")
        with self.assertRaisesRegex(ota.UpdateError, "names root_a"):
            self.make("1.1.0", new)

    def test_the_marker_is_found_across_a_read_and_must_be_there_once(self):
        path = self.path("big.boot")
        with open(path, "wb") as f:
            f.write(bytes(ota.COPY_CHUNK + 64))
        with open(path, "r+b") as f:
            f.seek(ota.COPY_CHUNK - 7)           # the marker straddles the first read
            f.write(ota.MARKER + b"b")
        self.assertEqual(ota.find_marker(path, os.path.getsize(path)), ota.COPY_CHUNK - 7 + len(ota.MARKER))
        with open(path, "r+b") as f:
            f.seek(100)
            f.write(ota.MARKER + b"a")
        with self.assertRaisesRegex(ota.UpdateError, "found 2"):
            ota.find_marker(path, os.path.getsize(path))
        empty = self.path("empty.boot")
        with open(empty, "wb") as f:
            f.write(bytes(BLOCK))
        with self.assertRaisesRegex(ota.UpdateError, "found 0"):
            ota.find_marker(empty, BLOCK)


class Confirm(CardTest):
    def trial(self):
        self.apply(self.make("1.1.0", self.new_version("1.1.0")))
        self.boot_from(partition=3, tryboot=True)            # the bootloader took [tryboot]

    def confirm(self, healthy_result):
        return ota.confirm(self.card, self.conf, reboot=False, log=self.log.append,
                           check=lambda conf, log: healthy_result)

    def test_a_healthy_trial_is_kept(self):
        self.trial()
        self.assertEqual(self.confirm(True), "confirmed")
        self.assertIn("boot_partition=3\n[tryboot]\nboot_partition=2", self.autoboot())
        state = self.card.load_state()
        self.assertIsNone(state["pending"])
        self.assertEqual(state["last"]["result"], "confirmed")
        self.boot_from(partition=3, tryboot=False)            # and from now on B boots
        self.assertEqual(ota.status(self.card)["version"], "1.1.0")

    def test_an_unhealthy_trial_goes_back_to_the_old_slot(self):
        self.trial()
        self.assertEqual(self.confirm(False), "failed")
        self.assertIn("[all]\ntryboot_a_b=1\nboot_partition=2", self.autoboot(), "A stays the default")
        self.boot_from(partition=2, tryboot=False)            # the reboot after a failed check
        self.assertEqual(self.confirm(True), "normal")
        state = self.card.load_state()
        self.assertIsNone(state["pending"])
        self.assertEqual((state["last"]["version"], state["last"]["result"]), ("1.1.0", "rolled back"))
        self.assertEqual(ota.status(self.card)["version"], "1.0.0")

    def test_a_trial_that_never_got_to_confirm_is_rolled_back(self):
        self.trial()
        self.boot_from(partition=2, tryboot=False)            # B hung, the power was cut: A boots
        self.assertEqual(self.confirm(True), "normal")
        self.assertEqual(self.card.load_state()["last"]["result"], "rolled back")

    def test_a_normal_boot_with_nothing_on_trial_changes_nothing(self):
        before = self.autoboot()
        self.assertEqual(self.confirm(True), "normal")
        self.assertEqual(self.autoboot(), before)

    def test_the_health_check_runs_the_command_until_it_passes_or_time_runs_out(self):
        conf = dict(self.conf, CRANIUM_OTA_HEALTH=f'"{sys.executable}" -c "raise SystemExit(0)"')
        self.assertTrue(ota.healthy(conf, log=self.log.append))
        conf = dict(self.conf, CRANIUM_OTA_HEALTH=f'"{sys.executable}" -c "raise SystemExit(1)"',
                    CRANIUM_OTA_CONFIRM_SECONDS="0")
        self.assertFalse(ota.healthy(conf, log=self.log.append))


class Status(CardTest):
    def test_status_says_what_the_nrf_needs(self):
        s = ota.status(self.card)
        self.assertEqual((s["slot"], s["version"], s["trial"], s["default"]), ("a", "1.0.0", False, "a"))
        json.dumps(s)


if __name__ == "__main__":
    unittest.main()
