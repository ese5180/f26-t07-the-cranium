#!/usr/bin/env bash
#
# Put the newest published phone app builds into apps/dist/, byte for byte what the console serves,
# so that they are in git with the source: cranium-android-<version>.apk, cranium-ios-<version>.ipa,
# SHA256SUMS and latest.json. Older builds in apps/dist/ are removed (the console keeps every one).
#
#   apps/fetch-builds.sh              the newest Android and iPhone builds
#   apps/fetch-builds.sh android      only Android (or: ios)
#
# The console's address comes from CRANIUM_CONSOLE_URL, else from apps/config/cranium.json. The API
# token comes from CRANIUM_TOKEN, else from ~/.cranium/console-token (make one on the console's
# Tokens page). Each file is checked against the size and SHA-256 the console recorded when it was
# published; a file that does not match is not kept. Download links are never printed.
#
# The builds hold apps/config/cranium.json: the console's address, its Cognito domain and its user
# pool and client IDs, which the public website serves to every visitor anyway. No secret is in them.

set -euo pipefail

APPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$APPS_DIR/dist"
CONFIG="$APPS_DIR/config/cranium.json"
WHICH="${1:-both}"
case "$WHICH" in android|ios|both) ;; -h|--help) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "error: unknown argument $WHICH (android, ios, or nothing for both)" >&2; exit 1 ;; esac

fail() { echo "error: $*" >&2; exit 1; }
command -v curl >/dev/null || fail "curl is needed"
command -v python3 >/dev/null || fail "python3 is needed"

CONSOLE="${CRANIUM_CONSOLE_URL:-}"
if [ -z "$CONSOLE" ] && [ -f "$CONFIG" ]; then
  CONSOLE="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("consoleUrl", ""))' "$CONFIG")"
fi
[ -n "$CONSOLE" ] || fail "the console's address is not known: set CRANIUM_CONSOLE_URL, or run apps/configure.sh"
CONSOLE="${CONSOLE%/}"

TOKEN="${CRANIUM_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.cranium/console-token" ]; then TOKEN="$(tr -d '[:space:]' < "$HOME/.cranium/console-token")"; fi
[ -n "$TOKEN" ] || fail "no API token: set CRANIUM_TOKEN, or save one in ~/.cranium/console-token (the console's Tokens page)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
(umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$WORK/auth")

api() { curl -fsS --config "$WORK/auth" --max-time 30 "$CONSOLE/api/t/$1"; }

api apps > "$WORK/apps.json" || fail "the console did not answer GET /api/t/apps"
mkdir -p "$DIST"

fetch() {
  local kind="$1" ext="$2" version
  version="$(python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1])).get(sys.argv[2]) or {}
rel = d.get("releases") or []
print(rel[0]["version"] if rel else "")' "$WORK/apps.json" "$kind")"
  if [ -z "$version" ]; then echo "$kind: nothing published yet"; return 0; fi
  api "apps/$kind/$version/download" > "$WORK/$kind.json" || fail "$kind $version: the console gave no download"
  python3 -I - "$WORK/$kind.json" "$WORK/$kind.url" "$WORK/$kind.meta" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))["download"]
open(sys.argv[2], "w").write(d["url"])
open(sys.argv[3], "w").write("%s %s %s\n" % (d["filename"], d["size"], d["sha256"]))
EOF
  local filename size sha
  read -r filename size sha < "$WORK/$kind.meta"
  case "$filename" in "cranium-$kind-$version.$ext") ;; *) fail "$kind: an unexpected file name from the console" ;; esac
  curl -fsS --max-time 300 -o "$WORK/$filename" "$(cat "$WORK/$kind.url")" || fail "$kind $version: the download failed"
  local got_size got_sha
  got_size="$(wc -c < "$WORK/$filename" | tr -d ' ')"
  got_sha="$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$WORK/$filename")"
  [ "$got_size" = "$size" ] && [ "$got_sha" = "$sha" ] || fail "$kind $version: the file does not match what the console recorded"
  # Older builds of this app go: the newest is the one in git.
  local old
  for old in "$DIST"/cranium-"$kind"-*."$ext"; do
    [ -e "$old" ] || continue
    [ "$(basename "$old")" = "$filename" ] || rm -f "$old"
  done
  mv "$WORK/$filename" "$DIST/$filename"
  echo "$kind: $filename, $size bytes, SHA-256 $sha"
}

case "$WHICH" in android|both) fetch android apk ;; esac
case "$WHICH" in ios|both) fetch ios ipa ;; esac

# SHA256SUMS and latest.json, for every build now in apps/dist/.
python3 -I - "$DIST" <<'EOF'
import hashlib, json, os, re, sys
dist = sys.argv[1]
sums, latest = [], {}
for name in sorted(os.listdir(dist)):
    m = re.fullmatch(r"cranium-(android|ios)-(\d+\.\d+\.\d+)\.(apk|ipa)", name)
    if not m:
        continue
    data = open(os.path.join(dist, name), "rb").read()
    digest = hashlib.sha256(data).hexdigest()
    sums.append("%s  %s" % (digest, name))
    latest[m.group(1)] = {"version": m.group(2), "file": name, "size": len(data), "sha256": digest}
open(os.path.join(dist, "SHA256SUMS"), "w").write("\n".join(sums) + ("\n" if sums else ""))
open(os.path.join(dist, "latest.json"), "w").write(json.dumps(latest, indent=2, sort_keys=True) + "\n")
EOF
echo "Wrote apps/dist/SHA256SUMS and latest.json. Commit apps/dist/ to put these builds in git."
