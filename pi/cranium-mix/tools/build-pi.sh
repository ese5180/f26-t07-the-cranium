#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export CRANIUM_NAUTIC_ENGINE_SOURCE="$root/cranium-nauticmixxx-engine"
export CRANIUM_NAUTIC_BUILD_ROOT=${CRANIUM_NAUTIC_BUILD_ROOT:-$root/build/pi}
python3 "$root/tools/check-layout.py"
exec bash "$root/cranium-nauticmixxx/cranium/build-editable.sh"
