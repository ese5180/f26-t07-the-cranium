# Pi OS updates: A/B slots, tryboot, and deltas

The Pi's system is updated the way the nRF's firmware is (the bootloading poster): a new image goes into the slot
that is not running, boots once on trial, and is kept only if it is healthy; otherwise the old one boots again.
On the nRF, MCUboot does this with its test swap. On the Pi, the bootloader's `tryboot` does it, with two copies of
the system on the SD card. An update carries only the 4 KiB blocks that changed, so most are a few MB: small
enough to come from the nRF over SPI.

| nRF (MCUboot) | Pi (tryboot) |
| --- | --- |
| Secondary slot | The slot that is not running (`boot_b` + `root_b`, or A) |
| Download, check SHA-256 | Apply the delta onto a copy of the running slot, check SHA-256 |
| Mark test swap, reset | `[tryboot]` names the new slot, `reboot '0 tryboot'` |
| Boots on trial | The bootloader boots `[tryboot]`'s slot, once |
| Confirmed if it reaches AWS IoT in 5 min | Kept if the health check passes in 5 min (`cranium-link --status`) |
| Else MCUboot swaps the old one back | Else the next boot is `[all]`'s slot: the old one |

## The files

| File | Runs on | What it does |
| --- | --- | --- |
| `pi/cranium_ota.py` | Pi, PC, CI | `make` an update; `apply` it; `confirm` at boot; `status`; `export` a slot as release images |
| `pi/bin/cranium-update` | Pi | Runs `cranium_ota.py` with the settings of `cranium.conf` |
| `pi/bin/cranium-ab-setup` | Pi | Sets up a second SD card for A/B from the running system (it erases that card) |
| `pi/ota/cranium-update-confirm.service` | Pi, at boot | Runs `cranium-update confirm` at every boot |
| `pi/cranium.conf.default` | Pi | The health check and its time limit (`CRANIUM_OTA_HEALTH`, `CRANIUM_OTA_CONFIRM_SECONDS`) |
| `pi/tests/test_cranium_ota.py` | PC, Pi, CI | 25 tests on files that stand for the card's partitions |
| `pi/ota/pi_os_signing_pub.pem` | Pi | The public key updates are checked with (to be made: see Step 0) |

## The card

| Partition | Label | What |
| --- | --- | --- |
| 1 | `autoboot` (FAT, 64 MB) | `autoboot.txt`: which slot boots, and which one a `tryboot` boots |
| 2 | `boot_a` (FAT, 512 MB) | Slot A: kernel, device tree, `config.txt`, `cmdline.txt` |
| 3 | `boot_b` (FAT, 512 MB) | Slot B |
| 4 | `root_a` (ext4, 6 GB) | Slot A's root filesystem, mounted read-only |
| 5 | `root_b` (ext4, 6 GB) | Slot B's |
| 6 | `data` (ext4, the rest) | `/home` (Mixxx's settings and library, `~/.cranium`, this repository), the Wi-Fi connections, the update state |

```
[all]
tryboot_a_b=1
boot_partition=2
[tryboot]
boot_partition=3
```

Three things make it work, and they are all `cranium-ab-setup` changes in the system:

- **The root is read-only**, with Raspberry Pi OS's overlay file system (`overlayroot=tmpfs:recurse=0` in
  `cmdline.txt`, the `overlayroot` package): changes go to RAM and are gone at the next boot. So a slot stays,
  byte for byte, the release it was installed as, and a delta made from that release applies to it.
  (`recurse=0` keeps `/data` writable; raspi-config's own option would overlay it as well.)
- **What must outlive a reboot is on `data`**: `/home` and the Wi-Fi connections, mounted from it in `fstab`.
  Swap is zram only, as a swap file would now be in RAM. A udev rule
  (`/etc/udev/rules.d/90-cranium-ab.rules`) keeps the desktop from mounting the slots' partitions: a mounted
  slot changes its bytes, and a delta no longer applies to it.
- **Each slot mounts its own root**: `cmdline.txt` says `root=PARTLABEL=root_a` in slot A and `root_b` in slot B.
  That one letter is the only byte where the two slots differ. Releases, deltas and their hashes always have
  `a`; the installer writes the slot's letter after it has checked the slot.

The running version is the one in the running root's own `/etc/cranium-os`, which is part of the release, so it
cannot disagree with what runs. `/data/cranium-ota/state.json` holds only what is not in a release: the update
on trial, and the last result.

## How to use it

### Step 0: the signing key (once, on your PC)

```bash
openssl genpkey -algorithm ed25519 -out ~/.cranium/pi_os_signing_key.pem
openssl pkey -in ~/.cranium/pi_os_signing_key.pem -pubout -out pi/ota/pi_os_signing_pub.pem
```

The private key stays off git, like the firmware key; whoever builds releases needs it. The public key is
committed in `pi/ota/`, and the Pi refuses any update it did not sign.

### Step 1: set up the A/B card (once per card, on the Pi)

1. Put the new card in a USB card reader on the Pi. `lsblk` shows it, for example as `sda`.
2. Copy this repository to the Pi (`~/cranium`), with the public key in it.
3. Run, naming the card twice (it is erased):

   ```bash
   sudo ~/cranium/pi/bin/cranium-ab-setup --device /dev/sda --erase /dev/sda
   ```

   It refuses the card the Pi runs from, a mounted card, and a card too small for two slots. It takes a few
   minutes: it copies this Pi's system into slot A (version 1.0.0), and `/home` and the Wi-Fi connections to `data`.
4. Shut the Pi down, put the new card in its SD slot (keep the old one: it is the way back), and start it.
5. Check: `~/cranium/pi/bin/cranium-update status` says `"slot": "a"`, `"version": "1.0.0"`, `"trial": false`.
   `findmnt /` shows an `overlay` root; `findmnt /data` shows `data` mounted.

### Step 2: save release 1.0.0 (to make deltas from)

Every delta is made from the images of the release the Pi runs, so keep each release's images (about 6.5 GB),
off the card. On the Pi, to a USB drive:

```bash
sudo ~/cranium/pi/bin/cranium-update export --out /media/usb/cranium-os/1.0.0
```

### Step 3: make a new version (on the Pi or a Linux PC)

A new version is the old one with something changed. For a first test, one changed file:

```bash
cp -r /media/usb/cranium-os/1.0.0 /media/usb/cranium-os/1.1.0
sudo mount -o loop /media/usb/cranium-os/1.1.0/root.img /mnt
echo 1.1.0 | sudo tee /mnt/etc/cranium-os
sudo umount /mnt
```

### Step 4: make the update (on your PC, with the private key)

```bash
python3 pi/cranium_ota.py make --version 1.1.0 \
    --boot 1.1.0/boot.img --root 1.1.0/root.img \
    --from-version 1.0.0 --from-boot 1.0.0/boot.img --from-root 1.0.0/root.img \
    --out cranium-os-1.1.0.update
```

It prints how many blocks changed and the update's size; for one file, a few KB. Without the `--from-*`
options it makes a full image, which works on any Pi but is large.

### Step 5: install it (on the Pi; later, from the nRF over SPI)

```bash
sudo ~/cranium/pi/bin/cranium-update apply cranium-os-1.1.0.update
```

It checks the signature, that each part matches the manifest, that 1.1.0 is newer than what runs, and that
the running slot really is 1.0.0. Then it writes slot B (a copy of A, then the delta), checks slot B's
SHA-256, points `[tryboot]` at it, and reboots with `tryboot`. Slot A is never written, and `[all]` still
names it.

### Step 6: the trial (automatic)

The Pi starts slot B once. `cranium-update-confirm.service` runs the health check, `cranium-link --status`
(the nRF answers over SPI), every 10 s for up to 5 min:

- **It passes:** `[all]` now names slot B, and it boots from now on. `status` says `"slot": "b"`,
  `"version": "1.1.0"`, `"last": {"result": "confirmed"}`.
- **It fails** (or slot B hangs, or the power goes): the Pi reboots, and the bootloader starts slot A, as
  `[all]` still names it. `status` says `"version": "1.0.0"`, `"last": {"result": "rolled back"}`.

To see a rollback on purpose, unplug the SPI wires before step 5.

The next update goes the other way: from slot B into slot A.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| `apply`: the signature does not match | The update was signed with another key than `pi/ota/pi_os_signing_pub.pem` |
| `apply`: this delta does not apply to it | The Pi does not run the delta's starting version: send a full image, or the delta from the version `status` shows |
| `apply`: not newer | Updates only go forward. To go back to older contents, release them again under a higher version |
| `status`: not a slot's boot partition | The Pi did not boot from an A/B card |
| Neither slot boots | Put the old card back in: it was never changed |

## What the nRF side needs (phase 2)

The update file reaches the Pi from the nRF over SPI, not from a laptop. What `apply` does stays the same; it
gets the file from the nRF instead of a path. For that:

**On the Pi (this repository, `pi/`)**

1. A receiver, `cranium-update fetch`: asks the nRF over the message link (`docs/pi-link.md`) whether it has an
   update, reads the manifest first, and declines it if it is not for this Pi (wrong starting version, not
   newer); then pulls the file in chunks into `/data/cranium-ota/`, resuming where it stopped after a reset,
   and runs `apply` on it. The Pi stays the SPI controller: Linux on a Pi cannot be an SPI target
   (`spi-dw`: "spi-slave is not yet supported").
2. New frame types on the link, the Pi asking and the nRF answering: "what update do you have" (the
   manifest), "give me bytes from offset X" (a chunk with its CRC), and "here is the result" (applied,
   confirmed, rolled back, refused and why).
3. The Pi telling the nRF what it runs: the output of `cranium-update status` (slot, version, last result),
   at startup and after each update, so the cloud can pick the delta. This is a new message type on the link;
   the `np`/`hb` messages stay as they are.

**On the nRF (`firmware/app`)**

1. **Storing the update.** A delta of a few MB fits the DK's external flash: per the poster, about 6 MB is
   unused between the secondary slot and the golden image (it needs a partition there that keeps clear of
   both). Larger ones need the SD card of PR #196.
2. **Getting it from the cloud.** An update job like the firmware's, with the update file's URL, size and
   SHA-256: download over HTTPS with resume, check the SHA-256, and only then offer it to the Pi (PR #196's
   `pi_dl` does this part).
3. **Answering the Pi** on the message link (`src/pi/`): the manifest, and chunks from storage. RAM is short
   (about 2 KB free), so a chunk is at most about 490 bytes per frame: roughly 100–300 KB/s, so a delta of a
   few MB takes seconds to a minute; a full image would take hours.
4. **Reporting** the Pi's version and each update's result to the cloud (shadow and job status), like its
   own firmware's.
5. **Agreeing with PR #196**, whose contract has the nRF as SPI controller and the Pi as target: that cannot
   run on the Pi, so its SPI part becomes the responder above, on the message link's pins.

**In the cloud and CI**

1. Keep the images of every release (`export`), and make a signed delta from each version still in use to
   the new one (`make`); a full image for any other.
2. The update job picks the delta whose starting version is the one the Pi reported.
