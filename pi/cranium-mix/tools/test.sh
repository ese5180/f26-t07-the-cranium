#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
python3 "$root/tools/check-layout.py"
cd "$root/cranium-nauticmixxx"
python3 scripts/test-windows-installer-contract.py
python3 -m unittest discover -s cranium -p 'test_*.py' -v
for test in scripts/test-*.js; do node "$test"; done
python3 scripts/test-flx4-preset.py
python3 scripts/test-pioneer-roland-presets.py
python3 scripts/test-flx4-fx-labels.py
python3 scripts/test-linux-package.py
python3 - <<'PY'
from pathlib import Path
import xml.etree.ElementTree as ET
paths = [p for folder in ['skins/XDJ_RX3_Mixxx','controllers','effects']
         for p in Path(folder).rglob('*.xml')]
for path in paths:
    ET.parse(path)
print('PASS:', len(paths), 'skin/controller/effect XML files parsed')
PY
