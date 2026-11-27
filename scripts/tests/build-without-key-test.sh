#!/usr/bin/env bash
#
# scripts/firmware/build.sh --without-key puts binaries/ back as it was when the build stops part way.
# It runs build.sh in a scratch copy of the repository, with stand-ins for nrfutil and west: the stand-in
# build stores a throwaway image, prunes an older one, as tools/store_binary.py does, and then the image's
# board check fails. Afterwards binaries/ must hold exactly what it held before, and firmware/app/VERSION
# too. It needs no SDK, only a python3 with cryptography (firmware/tests/requirements.txt), which build.sh
# makes its throwaway key with. scripts/ci/local-ci.sh runs it in its Python job.
#
#   scripts/tests/build-without-key-test.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 -c 'import cryptography' 2> /dev/null ||
  { echo "error: this test needs a python3 with cryptography (firmware/tests/requirements.txt)" >&2; exit 1; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
copy="$scratch/repo"
mkdir -p "$copy/scripts/firmware" "$copy/firmware/app" "$copy/firmware/keys" "$copy/binaries" "$copy/tools" \
  "$scratch/bin" "$scratch/toolchain" "$scratch/ncs"
cp "$REPO/scripts/firmware/build.sh" "$copy/scripts/firmware/"
cp "$REPO/firmware/app/VERSION" "$copy/firmware/app/"
cp "$REPO/firmware/keys/fw_signing_pub.pem" "$copy/firmware/keys/"
printf 'an older image\n' > "$copy/binaries/cranium-1.0.0-0.signed.bin"
printf 'the latest image\n' > "$copy/binaries/latest.signed.bin"
printf '{"version": "1.0.0+0"}\n' > "$copy/binaries/latest.json"

# nrfutil's toolchain environment: only a PATH with the stand-in west first.
cat > "$scratch/bin/nrfutil" << EOF
#!/bin/sh
echo 'export PATH="$scratch/toolchain:\$PATH"'
EOF
# The build stores this version's image and the latest copies, and prunes the older image.
cat > "$scratch/toolchain/west" << EOF
#!/bin/sh
mkdir -p "$copy/build"
version=\$(awk '\$1 == "VERSION_MAJOR" { a = \$3 } \$1 == "VERSION_MINOR" { b = \$3 } \$1 == "PATCHLEVEL" { c = \$3 }
  END { print a "." b "." c }' "$copy/firmware/app/VERSION")
printf 'signed with a throwaway key\n' > "$copy/binaries/cranium-\$version-0.signed.bin"
cp "$copy/binaries/cranium-\$version-0.signed.bin" "$copy/binaries/latest.signed.bin"
printf '{"version": "%s+0"}\n' "\$version" > "$copy/binaries/latest.json"
rm -f "$copy/binaries/cranium-1.0.0-0.signed.bin"
EOF
# The check that fails, after the image is stored.
cat > "$copy/tools/check_image.py" << 'EOF'
import sys
sys.exit("this image carries no board type")
EOF
chmod +x "$scratch/bin/nrfutil" "$scratch/toolchain/west"

listing() {
  (cd "$1" && for file in *; do printf '%s %s\n' "$file" "$(cksum < "$file")"; done)
}
before="$(listing "$copy/binaries")"
version_before="$(cat "$copy/firmware/app/VERSION")"

status=0
NRFUTIL="$scratch/bin/nrfutil" NCS_DIR="$scratch/ncs" \
  "$copy/scripts/firmware/build.sh" --keep --no-upload --without-key > "$scratch/build.log" 2>&1 || status=$?

failures=0
check() {
  if [ "$1" = "$2" ]; then
    echo "ok: $3"
  else
    echo "FAILED: $3" >&2
    failures=$((failures + 1))
  fi
}
grep -q 'carries no board type\|does not say its board type' "$scratch/build.log" && reached=yes || reached=no
check "$reached" yes "the build stopped at the board check, after storing its image"
[ "$status" -ne 0 ] && failed=yes || failed=no
check "$failed" yes "build.sh exited with a failure ($status)"
check "$(listing "$copy/binaries")" "$before" "binaries/ holds exactly what it held before: the older image is back, no throwaway image"
check "$(cat "$copy/firmware/app/VERSION")" "$version_before" "firmware/app/VERSION is unchanged"
if [ "$failures" -ne 0 ]; then
  sed 's/^/    | /' "$scratch/build.log" >&2
  exit 1
fi
echo "4 of 4 checks passed"
