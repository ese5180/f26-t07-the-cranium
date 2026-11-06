#!/usr/bin/env bash
#
# Put back together an installer that apps/dist/ keeps in parts, because GitHub takes no file over 100 MB
# in git (apps/fetch-desktop-builds.sh splits it): <installer>.part01, .part02, ... and <installer>.sha256.
# Joins the parts in order, checks the whole file against its SHA-256, and only then keeps it. An AppImage
# is made executable.
#
#   apps/join-build.sh apps/dist/Cranium-0.1.0.AppImage           writes apps/dist/Cranium-0.1.0.AppImage
#   apps/join-build.sh apps/dist/Cranium-0.1.0.AppImage ~/Apps    writes ~/Apps/Cranium-0.1.0.AppImage
#
# Works on Linux and macOS (sha256sum or shasum).
set -euo pipefail

fail() { echo "error: $*" >&2; exit 1; }

target="${1:-}"
[ -n "$target" ] || fail "say which installer, e.g. apps/dist/Cranium-0.1.0.AppImage"
name="$(basename "$target")"
from="$(cd "$(dirname "$target")" && pwd)"
to="${2:-$from}"
mkdir -p "$to"

[ -f "$from/$name.sha256" ] || fail "$name.sha256 is not next to the parts in $from"
shopt -s nullglob
parts=("$from/$name".part[0-9][0-9])
[ "${#parts[@]}" -gt 0 ] || fail "no parts of $name in $from"

# The parts are numbered 01, 02, ...: a gap means one is missing.
for index in "${!parts[@]}"; do
  expected="$(printf '%s/%s.part%02d' "$from" "$name" $((index + 1)))"
  [ "${parts[$index]}" = "$expected" ] || fail "part $((index + 1)) of $name is missing"
done

partial="$to/.$name.joining"
trap 'rm -f "$partial"' EXIT
cat "${parts[@]}" > "$partial"

want="$(awk '{print $1; exit}' "$from/$name.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  have="$(sha256sum "$partial" | awk '{print $1}')"
else
  have="$(shasum -a 256 "$partial" | awk '{print $1}')"
fi
[ "$have" = "$want" ] || fail "the joined $name does not have the SHA-256 in $name.sha256: nothing was kept"

mv "$partial" "$to/$name"
trap - EXIT
case "$name" in *.AppImage) chmod +x "$to/$name" ;; esac
echo "$to/$name: joined from ${#parts[@]} parts, SHA-256 checked."
