#!/usr/bin/env python3
"""Combine an existing verified Bookworm app bundle with current startup helpers.

Does not build the engine, touch an SD card or change the source bundle.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PI = ROOT / 'cranium-nauticmixxx/cranium/pi'


def prepare(source, output):
    spec = importlib.util.spec_from_file_location('installer', PI / 'installer.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    archive, manifest = installer.verify_archive(source)
    if manifest.get('arch') != 'aarch64' or manifest.get('os') != 'Debian 12 Bookworm':
        raise ValueError('Expected an ARM64 Bookworm app bundle.')
    if output.exists():
        raise ValueError('Use a new output directory; existing updates are preserved.')
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'], text=True)
    if dirty.strip():
        raise ValueError('Commit and test the startup sources before preparing a reproducible update.')
    output.mkdir(parents=True)
    for name in (archive.name, 'manifest.json'):
        shutil.copyfile(source / name, output / name)
    for name in installer.HELPERS:
        shutil.copyfile(PI / name, output / name)
    shutil.copyfile(ROOT / 'cranium-nauticmixxx/cranium/PI-TRIAL.md', output / 'README.txt')
    metadata = {'revision': 'appliance-v1', 'source_commit': revision,
                'app_payload_sha256': manifest['sha256'],
                'native_engine_rebuilt': False, 'physical_pi_tested': False,
                'files': {name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                          for name in installer.HELPERS}}
    (output / 'startup-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    installer.verify_archive(output)
    installer.verify_helpers(output)
    print(json.dumps({'package': str(output), 'startup_source_commit': revision,
                      'app_payload_sha256': manifest['sha256'],
                      'sd_card_written': False, 'physical_pi_tested': False}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('existing_bundle', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    prepare(args.existing_bundle.resolve(), args.output.resolve())
