#!/usr/bin/env python3
"""Check the included native tree without requiring old nested Git tags."""
import argparse
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--engine', type=Path, default=root/'cranium-nauticmixxx-engine')
args = parser.parse_args()
engine = args.engine.resolve()
meta = json.loads((engine/'.cranium-source.json').read_text())
if meta['mixxx_base_commit'] != '3ebac449e7e5fe2a0186596657696e87ce8b0e56':
    raise SystemExit('Unexpected native baseline; review source provenance first.')
for name in ['CMakeLists.txt', 'src/widget/wrx3browser.h', 'src/widget/wrx3beatfx.h']:
    if not (engine/name).is_file():
        raise SystemExit('Missing full engine source: '+name)
if not (root/'cranium-nauticmixxx/skins/XDJ_RX3_Mixxx/skin.xml').is_file():
    raise SystemExit('Missing CRANIUM overlay.')
print('PASS: full prepared engine and overlay are included; no nested Git tags required')
