#!/usr/bin/env bash
#
# Build the firmware with the next version, and leave the signed image in binaries/.
#
#   scripts/build.sh                   the next unused version, for example 1.7.10 after 1.7.9
#   scripts/build.sh --version 1.8.0   that version instead
#   scripts/build.sh --keep            the version already in firmware/app/VERSION
#   scripts/build.sh --jobs 8          compile with that many jobs (default 4)
#   scripts/build.sh --no-upload       build, and upload it nowhere: not to the console, not to Memfault
#   scripts/build.sh --board nrf5340dk for that board type (docs/fleet.md): nrf7002dk (the default)
#                                      or nrf5340dk, which has Bluetooth only
#   scripts/build.sh --pi              from 1.15.0, for an nrf7002dk wired to a Raspberry Pi: Pi image
#                                      updates and no Bluetooth (docs/pi-ota.md)
#
# Each build starts clean, and stores binaries/cranium-<version>-0.signed.bin, along with
# binaries/latest.signed.bin and binaries/latest.json. For a board type other than nrf7002dk the type
# is in the names, as binaries/cranium-nrf5340dk-<version>-0.signed.bin and latest-nrf5340dk.*, and it
# builds in build-nrf5340dk/. From 1.13.0 the image says its board type and flash layout in protected
# TLVs (firmware/README.md, "Board type and compatibility"): this reads them back with
# tools/check_image.py, stops if they are missing or not this build's, and writes them into both
# records as "board" and "layout". It then checks the image's signature with the same code the console
# uses, and uploads it to the console's Firmware page with your API token (scripts/upload-to-console.sh):
# only uploads, so no board gets it until it is deployed, and the console offers a release only to
# boards of its type and layout. Without a token it says how to make one, and the image stays in
# binaries/. A version can be uploaded only once, which is why each build takes a new one. Exit status
# 3: built, but the upload failed. From 1.14.0 an nRF7002 DK's build also gives Memfault its symbols
# and the image as a release (tools/memfault_upload.py, docs/memfault.md), when ~/.cranium has a
# Memfault token. An nRF5340 DK has no Memfault: it has no AWS IoT to send it over.
#
# The next version is one above the highest in firmware/app/VERSION, binaries/ and ota-demo/, of any
# board type: one version is one image, and a build for another type takes the next number
# (docs/fleet.md). This checkout cannot see what else has been uploaded, so the console may still
# refuse a number. A failed build puts firmware/app/VERSION back. A good one leaves it changed and not
# committed: commit it before you build anything you mean to release, because the image records its
# commit.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NRFUTIL="${NRFUTIL:-$HOME/.nrfutil/bin/nrfutil}"
NCS_VERSION=v3.4.0
# Where nrfutil sdk-manager puts it on macOS; elsewhere, set NCS_DIR (docs/new-board-setup.md).
NCS_DIR="${NCS_DIR:-/opt/nordic/ncs/$NCS_VERSION}"
VERSION_FILE="$REPO_DIR/firmware/app/VERSION"
KEY="$HOME/.cranium/mcuboot_signing_key.pem"

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

usage() {
  sed -n '3,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

field() {
  awk -v name="$1" '$1 == name { print $3 }' "$VERSION_FILE"
}

set_version() {
  local major="$1" minor="$2" patch="$3" file
  file="$(mktemp)"
  awk -v major="$major" -v minor="$minor" -v patch="$patch" '
    $1 == "VERSION_MAJOR" { print "VERSION_MAJOR = " major; next }
    $1 == "VERSION_MINOR" { print "VERSION_MINOR = " minor; next }
    $1 == "PATCHLEVEL" { print "PATCHLEVEL = " patch; next }
    $1 == "VERSION_TWEAK" { print "VERSION_TWEAK = 0"; next }
    { print }' "$VERSION_FILE" > "$file"
  cat "$file" > "$VERSION_FILE"
  rm -f "$file"
}

# The next patch number above everything this checkout knows about, of any board type, as
# "major minor patch". An nRF7002 DK's images are named cranium-<version>, any other's
# cranium-<type>-<version>.
next_version() {
  python3 -I - "$(field VERSION_MAJOR).$(field VERSION_MINOR).$(field PATCHLEVEL)" \
    "$REPO_DIR"/binaries/cranium-*.signed.bin "$REPO_DIR"/ota-demo/cranium-*.signed.bin <<'EOF'
import re, sys
seen = [tuple(int(n) for n in sys.argv[1].split("."))]
for name in sys.argv[2:]:
    found = re.search(r"(?:^|/)cranium-(?:[a-z][a-z0-9]*-)?(\d+)\.(\d+)\.(\d+)-", name)
    if found:
        seen.append(tuple(int(n) for n in found.groups()))
major, minor, patch = max(seen)
print(major, minor, patch + 1)
EOF
}

jobs=4
keep=false
pi=false
upload=true
version=""
board_type=nrf7002dk
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=true ;;
    --no-upload) upload=false ;;
    --pi) pi=true ;;
    --board)
      [ $# -ge 2 ] || die "--board needs a board type: nrf7002dk or nrf5340dk"
      board_type="$2"
      shift
      ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value, for example --version 1.8.0"
      version="$2"
      shift
      ;;
    --jobs)
      [ $# -ge 2 ] || die "--jobs needs a number"
      jobs="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || die "--jobs must be a number, not $jobs"

# From 1.15.0, a board wired to a Raspberry Pi: Pi image updates, and no Bluetooth (docs/pi-ota.md).
extra_args=()
if $pi; then
  [ "$board_type" = nrf7002dk ] || die "--pi is for an nrf7002dk: the nRF5340 DK has no cloud"
  extra_args=(-DSB_EXTRA_CONF_FILE=pi_ota_sysbuild.conf)
  echo "A build for a board with a Raspberry Pi, and without Bluetooth: deploy it only to such boards."
fi

# The board types of docs/fleet.md. An nRF7002 DK keeps the names and the build directory it always had.
case "$board_type" in
  nrf7002dk)
    BOARD=nrf7002dk/nrf5340/cpuapp/ns
    BUILD_DIR="$REPO_DIR/build"
    name_prefix=cranium-
    latest=latest
    ;;
  nrf5340dk)
    BOARD=nrf5340dk/nrf5340/cpuapp/ns
    BUILD_DIR="$REPO_DIR/build-nrf5340dk"
    name_prefix=cranium-nrf5340dk-
    latest='latest-nrf5340dk'
    ;;
  *) die "--board takes nrf7002dk or nrf5340dk, not $board_type" ;;
esac
[ -n "$version" ] && [ "$keep" = true ] && die "use --keep or --version, not both"
if [ -n "$version" ] && ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "--version must look like 1.8.0, not $version"
fi

[ -x "$NRFUTIL" ] || die "nrfutil was not found at $NRFUTIL" "Set NRFUTIL to where it is."
[ -d "$NCS_DIR" ] || die "nRF Connect SDK $NCS_VERSION was not found at $NCS_DIR" "Set NCS_DIR to where it is."
[ -f "$KEY" ] || die "the signing key was not found at $KEY" \
  "See secrets/README.md. An image signed with another key will not install on a board."

work="$(mktemp -d)"
version_before="$work/VERSION.before"
cp "$VERSION_FILE" "$version_before"
built=false
finish() {
  # A build that failed has used no number.
  [ "$built" = true ] || cat "$version_before" > "$VERSION_FILE"
  rm -rf "$work"
}
trap finish EXIT
# Ctrl-C has to go through the same way.
trap 'exit 130' INT TERM

if [ -n "$version" ]; then
  IFS=. read -r major minor patch <<< "$version"
  set_version "$major" "$minor" "$patch"
elif [ "$keep" = false ]; then
  # shellcheck disable=SC2046
  set_version $(next_version)
fi
expected="$(field VERSION_MAJOR).$(field VERSION_MINOR).$(field PATCHLEVEL)+$(field VERSION_TWEAK)"

log="$work/build.log"
"$NRFUTIL" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh > "$work/env.sh"
# shellcheck disable=SC1091
. "$work/env.sh"
export ZEPHYR_BASE="$NCS_DIR/zephyr"
export CMAKE_BUILD_PARALLEL_LEVEL="$jobs"

build_name="$(basename "$BUILD_DIR")"
echo "Building firmware $expected for the $board_type with $jobs jobs. This takes a minute or two."
if ! (cd "$NCS_DIR" && nice -n 5 west build -p always -d "$BUILD_DIR" -b "$BOARD" \
    --sysbuild "$REPO_DIR/firmware/app" -- ${extra_args[@]+"${extra_args[@]}"} ) > "$log" 2>&1; then
  mkdir -p "$BUILD_DIR"
  cp "$log" "$BUILD_DIR/last-build.log"
  grep -E "error:|FATAL_ERROR|CMake Error" "$log" | head -10 >&2 || true
  die "the build failed" "The whole log is in $build_name/last-build.log."
fi
cp "$log" "$BUILD_DIR/last-build.log"

name="${name_prefix}${expected%+*}-${expected#*+}.signed.bin"
file="$REPO_DIR/binaries/$name"
[ -f "$file" ] || die "the build left no image at binaries/$name"
cmp -s "$file" "$REPO_DIR/binaries/$latest.signed.bin" \
  || die "binaries/$latest.signed.bin is not the image that was just built"

# The board type and the flash layout, as the image itself says them, under its signature.
# tools/store_binary.py, which the build runs, does not write them: this adds them to both records of
# this image. The layout the build was configured with is in its .config.
board="$(python3 -I "$REPO_DIR/tools/check_image.py" --board "$file")" \
  || die "the image does not say its board type, or its protected TLV area does not verify" \
    "Every image from 1.13.0 carries it: see \"Board type and compatibility\" in firmware/README.md."
[ "$board" = "$board_type" ] || die "the image says it is for $board, and this build is for $board_type"
layout="$(python3 -I "$REPO_DIR/tools/check_image.py" --layout "$file")" \
  || die "the image does not say its flash layout, or its protected TLV area does not verify"
configured="$(awk -F= '$1 == "CONFIG_APP_IMAGE_LAYOUT" { print $2 }' "$BUILD_DIR/app/zephyr/.config")"
[ "$layout" = "$configured" ] \
  || die "the image says flash layout $layout, and the build was configured for ${configured:-none}"
record="binaries/${name%.signed.bin}.json"
python3 -I - "$board" "$layout" "$REPO_DIR/binaries/$latest.json" "$REPO_DIR/$record" <<'EOF' \
  || die "the board type and layout could not be written into binaries/$latest.json and $record"
import json, sys
board, layout = sys.argv[1], int(sys.argv[2])
for path in sys.argv[3:]:
    with open(path) as source:
        record = json.load(source)
    # After "bluetooth", where store_binary.py puts what the image can do.
    updated = {}
    for key, value in record.items():
        if key not in ("board", "layout"):
            updated[key] = value
        if key == "bluetooth":
            updated["board"] = board
            updated["layout"] = layout
    updated.setdefault("board", board)
    updated.setdefault("layout", layout)
    with open(path, "w") as target:
        target.write(json.dumps(updated, indent=2) + "\n")
EOF

python3 -I - "$REPO_DIR/binaries/$latest.json" "$expected" "$board_type" <<'EOF' || die "binaries/$latest.json does not match this build"
import json, sys
info = json.load(open(sys.argv[1]))
if info.get("version") != sys.argv[2]:
    sys.exit(f"it says {info.get('version')}, and this build is {sys.argv[2]}")
if info.get("board", "nrf7002dk") != sys.argv[3]:
    sys.exit(f"it says it is for {info.get('board', 'nrf7002dk')}, and this build is for {sys.argv[3]}")
print()
print(f"Version   {info['version']}")
print(f"Board     {info.get('board', 'not recorded')}, flash layout {info.get('layout', 'not recorded')}")
print(f"File      binaries/{info['file']}")
print(f"Size      {info['size']:,} bytes, of a 933,888 byte slot")
print(f"SHA-256   {info['sha256']}")
print(f"Commit    {info['commit']}")
EOF

if command -v node > /dev/null; then
  if ! node "$REPO_DIR/cloud/api/verify-image.mjs" "$file" > "$work/verify.txt" 2>&1; then
    cat "$work/verify.txt" >&2
    die "the image failed the signature check" \
      "A build signed with another key will not install: see secrets/README.md."
  fi
  echo "Signature checked with this project's public key."
else
  echo "node was not found, so the signature was not checked here. The console checks it on upload."
fi
built=true

echo
if git -C "$REPO_DIR" status --porcelain -- firmware tools 2>/dev/null \
    | grep -qv ' firmware/app/VERSION$'; then
  echo "warning: firmware has uncommitted changes, so this image does not match any one commit."
elif ! git -C "$REPO_DIR" diff --quiet -- firmware/app/VERSION 2>/dev/null; then
  echo "firmware/app/VERSION now says ${expected%+*}, and that change is not committed."
fi

if [ "$upload" = false ]; then
  echo "Next: upload binaries/$name on the console's Firmware page, or run scripts/upload-to-console.sh."
  if [ "$board_type" = nrf7002dk ]; then
    echo "Memfault gets nothing either: while build/ holds this image, run tools/memfault_upload.py --build build."
  fi
  exit 0
fi

# From 1.14.0 (docs/memfault.md): the ELF's symbols, without which Memfault cannot read a coredump of
# this image, and the image as a release there. Only with an organization token and the project's
# slugs; without them it says so in one line. A failure here leaves the console's upload as it is.
# An nRF5340 DK's image has no Memfault in it.
if [ "$board_type" = nrf7002dk ]; then
  echo
  if ! python3 -I "$REPO_DIR/tools/memfault_upload.py" --build "$REPO_DIR/build"; then
    echo "warning: Memfault did not get all of this build: see above. Run tools/memfault_upload.py --build build" \
      "again while build/ holds it." >&2
  fi
fi

echo
commit="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("commit", "unknown"))' \
  "$REPO_DIR/binaries/$latest.json")"
notes="Built by scripts/build.sh from commit $commit"
case "$commit" in
  *+uncommitted) notes="$notes: firmware/ had changes that are in no commit" ;;
esac
set +e
"$REPO_DIR/scripts/upload-to-console.sh" "$file" "$notes"
uploaded=$?
set -e
case "$uploaded" in
  0) echo "Deploy it to a board on the console's Firmware page, or with scripts/ota.sh." ;;
  2) echo "The image is in binaries/$name: upload it on the console's Firmware page by hand." ;;
  *)
    echo "warning: built, but not uploaded: see above. The image is in binaries/$name." >&2
    exit 3 ;;
esac
