#!/usr/bin/env python3
"""Retain committed native changes as one replayable Cranium patch."""
import argparse
from pathlib import Path
import subprocess
import sys

if (Path(__file__).resolve().parents[2] / "SOURCE-PROVENANCE.json").is_file():
    sys.exit("This monorepo already contains the full engine. Edit and commit it directly; see the root README.")

project = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('engine', nargs='?', type=Path,
                    default=project.parent / 'cranium-nauticmixxx-engine')
parser.add_argument('--output', type=Path,
                    default=project / 'cranium/patches/0099-cranium-native.patch')
args = parser.parse_args()
engine = args.engine.resolve()
output = args.output.resolve()
baseline = 'cranium/nautic-2.0.0-base'
def git(*args):
    return subprocess.check_output(['git', '-C', str(engine), *args])
if git('status', '--porcelain').strip():
    sys.exit('Commit native edits first so newly added files are included. No patch was changed.')
patch = git('diff', '--binary', '--full-index', baseline, 'HEAD')
if not patch:
    if output.exists():
        sys.exit('Engine is back at baseline but a saved patch exists. Review that obsolete patch before rebuilding.')
    print('No native changes since the prepared NauticMixxx baseline.')
    sys.exit(0)
output.parent.mkdir(parents=True, exist_ok=True)
# Confirm that the complete patch describes the current native checkout.
subprocess.run(['git', '-C', str(engine), 'apply', '--reverse', '--check', '-'],
               input=patch, check=True)
output.write_bytes(patch)
print('Saved native changes; commit this patch in the overlay repository:', output)
