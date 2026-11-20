#!/usr/bin/env python3
"""Stage the offline trial only on the inspected Pi boot volume."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

work = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pi_installer', work / 'pi/installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('artifacts', type=Path)
parser.add_argument('--boot-volume', type=Path, required=True)
parser.add_argument('--expected-volume-uuid', required=True)
parser.add_argument('--expected-root-partuuid', required=True)
args = parser.parse_args()
artifacts = args.artifacts.resolve()
volume = args.boot_volume.resolve()
info = plistlib.loads(subprocess.check_output(['diskutil', 'info', '-plist', str(volume)]))
if (info.get('VolumeUUID') != args.expected_volume_uuid
        or info.get('Size') != 536870912 or info.get('Internal') is not False
        or info.get('MountPoint') != str(volume)):
    raise SystemExit('This is not the inspected Raspberry Pi SD card; no changes made.')
before = (volume / 'cmdline.txt').read_bytes()
entry_before = before
suffix = (' systemd.run="/bin/bash /boot/firmware/CNUPDATE/install.sh"'
          ' systemd.run_success_action=reboot systemd.run_failure_action=none'
          ' systemd.unit=kernel-command-line.target')
pending = b'systemd.run' in before
if pending:
    # Replace only our exact, verified pending installer, retaining the real
    # normal boot command rather than saving an armed command as its backup.
    before = (volume / 'CNUPDATE/cmdline.before.txt').read_bytes()
    expected = (volume / 'CNUPDATE/cmdline.before.sha256').read_text().split()[0]
    if (hashlib.sha256(before).hexdigest() != expected or b'systemd.run' in before
            or entry_before != before.rstrip(b'\r\n') + suffix.encode() + b'\n'):
        raise SystemExit('Unexpected pending installer; no changes made.')
if ('root=PARTUUID=' + args.expected_root_partuuid).encode() not in before:
    raise SystemExit('Unexpected boot arguments; no changes made.')
old_result = json.loads((volume / 'cranium-bitedj/install-result.json').read_text())
if old_result.get('status') != 'installed':
    raise SystemExit('The existing BiteDJ install must be complete first.')
archive, manifest = installer.verify_archive(artifacts)
installer.verify_helpers(artifacts)
# The staging code and the reviewed update must use the same startup sources.
for name in installer.HELPERS:
    if (artifacts / name).read_bytes() != (work / 'pi' / name).read_bytes():
        raise SystemExit('Bundle startup sources differ from this checkout: ' + name)
if shutil.disk_usage(volume).free < archive.stat().st_size + 15_000_000:
    raise SystemExit('Insufficient free boot-partition space.')
# An exact 8.3 directory name avoids macOS-generated short aliases that can
# collide with cranium-bitedj and be renamed by Linux fsck.
target = volume / 'CNUPDATE'
previous_manifest = None
if target.exists():
    previous_result = json.loads((target / 'install-result.json').read_text())
    if previous_result.get('status') != 'installed':
        raise SystemExit('The previous NauticMixxx install must be complete before an update.')
    _, previous_manifest = installer.verify_archive(target)
stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
evidence = work.parent.parent / 'build/pi-deployment/evidence' / stamp
evidence.mkdir(parents=True)
config = (volume / 'config.txt').read_bytes()
(evidence / 'cmdline.before.txt').write_bytes(before)
(evidence / 'cmdline.staging-entry.txt').write_bytes(entry_before)
(evidence / 'config.before.txt').write_bytes(config)
(evidence / 'cranium-app.before.txt').write_bytes((volume / 'cranium-app.txt').read_bytes())
if target.exists():
    # Keep the completed installer and its verified payload on the Mac before
    # replacing staging files. The installed Linux app is backed up separately
    # by installer.py, and the SD boot arguments remain normal until verification.
    previous_backup = evidence / 'previous-nauticmixxx-stage'
    shutil.copytree(target, previous_backup)
    installer.verify_archive(previous_backup)
    # Keep the existing FAT directory entry and cluster chain, and only
    # replace the verified payload files inside it.
target.mkdir(exist_ok=True)
if pending:
    # A failed replacement must leave the previously installed app bootable.
    with (volume / 'cmdline.txt').open('r+b') as stream:
        stream.write(before)
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())
    os.sync()
for name in ('nauticmixxx-arm64-bookworm.tar.gz', 'manifest.json'):
    shutil.copyfile(artifacts / name, target / name)
for name in installer.HELPERS:
    shutil.copyfile(work / 'pi' / name, target / name)
    assert (work / 'pi' / name).read_bytes() == (target / name).read_bytes()
shutil.copyfile(artifacts / 'startup-manifest.json', target / 'startup-manifest.json')
shutil.copyfile(work / 'PI-TRIAL.md', target / 'README.txt')
(target / 'cmdline.before.txt').write_bytes(before)
(target / 'cmdline.before.sha256').write_text(hashlib.sha256(before).hexdigest() + '  cmdline.before.txt\n')
installer.verify_archive(target)
installer.verify_helpers(target)
after = before.rstrip(b'\r\n') + suffix.encode() + b'\n'
# Preserve this FAT directory entry too; cmdline.txt is the final commit.
with (volume / 'cmdline.txt').open('r+b') as stream:
    stream.write(after)
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())
os.sync()
assert (volume / 'cmdline.txt').read_bytes() == after
assert (volume / 'config.txt').read_bytes() == config
report = {'status': 'staged_for_next_pi_boot', 'device': info['DeviceIdentifier'],
          'parent_disk': info['ParentWholeDisk'], 'volume_uuid': info['VolumeUUID'],
          'archive_sha256': manifest['sha256'], 'archive_bytes': archive.stat().st_size,
          'unpacked_bytes': manifest['unpacked_bytes'], 'overlay_commit': manifest['overlay_commit'],
          'engine_commit': manifest['engine_commit'], 'previous_manifest': previous_manifest,
          'startup_revision': 'appliance-v1',
          'replaced_pending_update': pending,
          'boot_entry_sha256': hashlib.sha256(entry_before).hexdigest(),
          'display_config_unchanged': True,
          'boot_before_sha256': hashlib.sha256(before).hexdigest(),
          'boot_after_sha256': hashlib.sha256(after).hexdigest(),
          'evidence': str(evidence), 'physical_playback_tested': False}
installer.atomic_write(evidence / 'stage-report.json', (json.dumps(report, indent=2) + '\n').encode())
installer.atomic_write(work / 'stage-report.json', (json.dumps(report, indent=2) + '\n').encode())
print(json.dumps({key: value for key, value in report.items() if key != 'previous_manifest'}, indent=2))
