# Offline updater FAT-name repair — 2026-11-09

The first boot of the touch-navigation update stopped before the helper could
run. The Pi's FAT check had renamed the staged folder to `FSCK0000.000`.
The archive in that recovered folder still matched the tested package.

A read-only image checked with Linux dosfstools 4.2 showed a duplicate short
name: both `cranium-bitedj` and `cranium-nauticmixxx` had `CRANI~11` as their
8.3 directory entry. macOS fsck_msdos reported a clean filesystem despite this
collision. Linux fsck.fat reported the duplicate and proposed renaming the
second entry, explaining the missing helper in the startup photo.

Repair:

- Backed up all readable boot files (excluding Spotlight's protected index).
- Restored the known normal boot command before touching the recovered folder.
- Retained the payload and moved its directory to exact 8.3 name `CNUPDATE`.
- Made `install.sh` discover its package directory from its own script path.
- Changed the staged boot command and future staging helper to use `CNUPDATE`.
- Future updates preserve the directory and overwrite payload files within it;
  `cmdline.txt` is written in place and fsynced as the final commit.

The app archive is unchanged, SHA-256:
`a122e97acf1d4ac43ce21553cf21c0f30f88ebb7eaa9a426efbd7f87363033c9`.
This is a boot-staging repair; it does not require another application build.
The update still restores normal boot arguments first and preserves the
existing NauticMixxx profile and previous application backup on the Pi.

Evidence is in `nauticmixxx-build/evidence/20261109T1732-boot-recovery/`.
Linux FAT checks use read-only copies, not the live SD partition. A cold image
of the repaired partition is checked after unmounting so cached macOS reads
cannot conceal missing on-disk directory entries.

Final verification: the cold image no longer had an updater/BiteDJ name
collision. Linux still found duplicate Spotlight index cache entries; a
Pi-style automatic fsck on a disposable copy repaired those and produced a
clean second check. After that repair, Linux mtools read `CNUPDATE/install.sh`
byte-identically to the fixed helper, read the correct staged boot command,
and extracted the archive with the expected SHA-256. The actual application
payload is unchanged. No Linux-root partition rewrite was performed.
