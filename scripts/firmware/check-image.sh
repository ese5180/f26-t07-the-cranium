#!/usr/bin/env bash
#
# Check a signed firmware image before uploading it to the console: the console's own checks, the
# build record, that it was built from a commit on main that CI built and tested, and, with a
# console token, that it is newer than every release. Only a wrapper, so the command has a stable
# path under scripts/: every check is in tools/check_image.py, which says how it uses the console's
# own check, cloud/api/verify-image.mjs.
#
#   scripts/firmware/check-image.sh                                      binaries/latest.signed.bin
#   scripts/firmware/check-image.sh binaries/cranium-1.9.0-0.signed.bin  that image
#   scripts/firmware/check-image.sh --strict ...                         anything not checked fails too

set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 -I "$REPO_DIR/tools/check_image.py" "$@"
