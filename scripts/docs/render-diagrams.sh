#!/usr/bin/env bash
# Render the README diagrams from pics/src/*.html into pics/*.png at twice their layout size.
# Needs Google Chrome (or Chromium). Usage: scripts/docs/render-diagrams.sh [name ...]
# Names: block-diagram communication-diagram boot-process (all three when none are given).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
src="$root/pics/src"

chrome="${CHROME:-}"
if [[ -z "$chrome" ]]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    if [[ -n "$c" && -x "$c" ]]; then chrome="$c"; break; fi
  done
fi
[[ -n "$chrome" ]] || { echo "Chrome not found; set CHROME=/path/to/chrome" >&2; exit 1; }

# name, output file, layout height (the width is always 1920)
diagrams=(
  "block-diagram|Block Diagram.png|1100"
  "communication-diagram|Communication Diagram.png|1110"
  "boot-process|Boot Process.png|1790"
)

profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT

for entry in "${diagrams[@]}"; do
  IFS='|' read -r name out height <<<"$entry"
  if [[ $# -gt 0 ]]; then
    case " $* " in *" $name "*) ;; *) continue ;; esac
  fi
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$profile" --force-device-scale-factor=2 \
    --window-size="1920,$height" --screenshot="$root/pics/$out" \
    "file://$src/$name.html" >/dev/null 2>&1
  echo "pics/$out"
done
