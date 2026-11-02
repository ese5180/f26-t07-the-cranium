#!/usr/bin/env bash
#
# Check a signed firmware image before uploading it to the console: the console's own checks, the
# build record, that it was built from a commit on main that CI built and tested, and, with a
# console token, that it is newer than every release. See tools/check_image.py.
#
#   scripts/check-image.sh                                      binaries/latest.signed.bin
#   scripts/check-image.sh binaries/cranium-1.9.0-0.signed.bin  that image
#   scripts/check-image.sh --strict ...                         anything not checked fails too

set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 -I "$REPO_DIR/tools/check_image.py" "$@"
