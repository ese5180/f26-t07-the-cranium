#!/usr/bin/env python3
"""Prepare a pinned, persistent native source checkout without resetting edits."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

if (Path(__file__).resolve().parents[2] / "SOURCE-PROVENANCE.json").is_file():
    sys.exit("This monorepo already contains the full engine. Edit and commit it directly; see the root README.")

PROJECT = Path(__file__).resolve().parent.parent
ENGINE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else PROJECT.parent / 'cranium-nauticmixxx-engine'
BASE = '3ebac449e7e5fe2a0186596657696e87ce8b0e56'
OVERLAY = 'c73631bafbc7150587cf9de0c32437531d295103'
TAG = 'cranium/nautic-2.0.0-base'
AUTHOR = ['-c', 'user.name=Cranium local build', '-c', 'user.email=cranium@localhost']


def git(*args, capture=False):
    command = ['git', '-C', str(ENGINE), *args]
    if capture:
        return subprocess.check_output(command, text=True).strip()
    subprocess.run(command, check=True)


if not ENGINE.exists():
    subprocess.run(['git', 'clone', '--depth', '1', '--branch', '2.5.6',
                    'https://github.com/mixxxdj/mixxx.git', str(ENGINE)], check=True)
    git('remote', 'rename', 'origin', 'upstream')
    git('switch', '-c', 'cranium/pi4-adaptation')
if subprocess.run(['git', '-C', str(ENGINE), 'rev-parse', '--verify', TAG],
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
    print('Editable engine already prepared; existing files and edits preserved:', ENGINE)
    sys.exit(0)
if git('rev-parse', 'HEAD', capture=True) != BASE or git('status', '--porcelain', capture=True):
    sys.exit('Expected a clean Mixxx 2.5.6 source checkout. Existing files were preserved.')
patches = sorted((PROJECT / 'patches').glob('00[0-9][0-9]-*.patch'))
if len(patches) != 44:
    sys.exit('The pinned NauticMixxx baseline must contain 44 native patches.')
if subprocess.check_output(['git', '-C', str(PROJECT), 'rev-parse', 'upstream/main'], text=True).strip() != OVERLAY:
    sys.exit('Upstream overlay changed; review and update the pinned source contract first.')
for patch in patches:
    git('apply', '--check', str(patch))
    git('apply', str(patch))
subprocess.run([sys.executable, str(PROJECT / 'packaging/linux/prepare-branding.py'),
                str(ENGINE), str(PROJECT)], check=True)
metadata = {'mixxx_base_commit': BASE, 'nautic_overlay_commit': OVERLAY,
            'patches': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in patches},
            'baseline_tag': TAG, 'application_compiled': False}
(ENGINE / '.cranium-source.json').write_text(json.dumps(metadata, indent=2) + '\n')
(ENGINE / 'AGENTS.md').write_text(
    '# Cranium NauticMixxx native source\n\n'
    'This is the persistent native engine; do not reset it to regenerate a build.\n'
    'Keep `near` and `far` out of shared C++ identifiers, including tests; Windows headers define macros with those names.\n'
    'Use explicit names such as `nearArtistRow` and `farArtistRow`.\n'
    'Keep upstream licenses and attribution.\n'
    'Commit native changes, then run the sibling overlay’s `cranium/export-engine-patch.py` so they are retained as a numbered patch.\n'
    'Run the overlay Windows identifier contract before any Windows build.\n')
git('add', '-A')
git(*AUTHOR, 'commit', '-m', 'Prepare NauticMixxx 2.0 native source from pinned Mixxx and 44 patches')
git('tag', TAG)
for patch in sorted((PROJECT / 'cranium/patches').glob('*.patch')):
    git('apply', '--check', str(patch))
    git('apply', str(patch))
if git('status', '--porcelain', capture=True):
    git('add', '-A')
    git(*AUTHOR, 'commit', '-m', 'Apply saved Cranium native changes')
print('Persistent native engine ready:', ENGINE)
