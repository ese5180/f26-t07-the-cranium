#!/usr/bin/env bash
#
# Put the Cranium app on your own iPhone for free, with a free Apple ID's "Personal Team".
#
#   apps/ios/scripts/phone.sh            make the project and open it in Xcode, to press Run
#   apps/ios/scripts/phone.sh --check    compile it for iPhone without signing, and open nothing
#
# What a free team can do: install on your own devices (at most 3), for 7 days at a time; after
# that the app does not open until you press Run in Xcode again, and what it stored stays. No
# TestFlight and no App Store: those need the paid Apple Developer Program. Bluetooth, the
# console's sign-in and the Keychain all work.
#
# Once, before the first run:
#   1. Xcode selected:  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
#   2. Your Apple ID in Xcode: Xcode > Settings > Accounts > + > Apple ID. That makes the team.
#   3. On the iPhone: Settings > Privacy & Security > Developer Mode, on (it restarts).
# This script then finds the team's ID and keeps it in ~/.cranium/apple-team-id. If Xcode says
# the bundle ID is taken, put another, such as com.<yourname>.cranium, in ~/.cranium/apple-bundle-id
# and run this again.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/../.." && pwd)"
TEAM_FILE="$HOME/.cranium/apple-team-id"
check_only=false

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

case "${1:-}" in
  "") ;;
  --check) check_only=true ;;
  -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown option: $1" ;;
esac

developer="$(xcode-select -p 2>/dev/null || true)"
[[ "$developer" == *Xcode*.app/Contents/Developer ]] || die "Xcode is not selected (now: ${developer:-nothing})" \
  "Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -license accept && xcodebuild -runFirstLaunch"
sdks="$(xcodebuild -showsdks 2>&1 || true)"
case "$sdks" in
  *"agreed to the Xcode license"*)
    die "Xcode's license has not been accepted yet" \
      "Run: sudo xcodebuild -license accept && xcodebuild -runFirstLaunch" ;;
  *"-sdk iphoneos"*) ;;
  *) die "Xcode has no iOS platform yet" "Run: xcodebuild -downloadPlatform iOS" ;;
esac
[ -f "$REPO_DIR/apps/config/cranium.json" ] || die "apps/config/cranium.json is missing" \
  "Run apps/configure.sh first: the app needs the console's address to sign in."

# The free team's ID, from what Xcode keeps about the accounts added to it.
if [ ! -s "$TEAM_FILE" ] && [ -z "${CRANIUM_TEAM_ID:-}" ]; then
  team="$(defaults export com.apple.dt.Xcode - 2>/dev/null | python3 -I -c '
import plistlib, sys
try:
    prefs = plistlib.loads(sys.stdin.buffer.read())
except Exception:
    sys.exit(0)
found = set()
for teams in (prefs.get("IDEProvisioningTeamByIdentifier") or {}).values():
    for team in teams or []:
        if team.get("isFreeProvisioningTeam") and team.get("teamID"):
            found.add(team["teamID"])
print("\n".join(sorted(found)))' || true)"
  count="$(printf '%s' "$team" | grep -c . || true)"
  if [ "$count" -eq 1 ]; then
    umask 077
    mkdir -p "$HOME/.cranium"
    printf '%s\n' "$team" > "$TEAM_FILE"
    echo "Found your free Personal Team; kept its ID in ~/.cranium/apple-team-id."
  elif [ "$count" -gt 1 ]; then
    die "Xcode has more than one free team" "Put the one to use in ~/.cranium/apple-team-id."
  elif [ "$check_only" = false ]; then
    echo "note: no free team yet. Add your Apple ID in Xcode > Settings > Accounts, then run this again," >&2
    echo "      or pick the team in Xcode's Signing & Capabilities." >&2
  fi
fi

"$IOS_DIR/scripts/generate.sh"

if [ "$check_only" = true ]; then
  echo "Compiling for iPhone, without signing. This takes a few minutes the first time."
  log="$(mktemp)"
  if ! nice -n 5 xcodebuild -project "$IOS_DIR/Cranium.xcodeproj" -scheme Cranium -configuration Debug \
      -destination 'generic/platform=iOS' -derivedDataPath "$IOS_DIR/build/check" \
      CODE_SIGNING_ALLOWED=NO -jobs 4 build > "$log" 2>&1; then
    grep -E "error:" "$log" | sort -u | head -20 >&2
    die "the app did not compile for iPhone" "The whole log is in $log."
  fi
  rm -f "$log"
  echo "It compiles for iPhone."
  exit 0
fi

open "$IOS_DIR/Cranium.xcodeproj"
cat <<'EOF'

Xcode is opening the project. Then:
  1. Plug the iPhone into the Mac, and tap Trust on it.
  2. At the top of Xcode, choose your iPhone as the place to run.
  3. Under the Cranium target's Signing & Capabilities, the team should be your Personal Team.
  4. Press Run (the triangle). The first time, on the iPhone: Settings > General >
     VPN & Device Management > your Apple ID > Trust. Then open the app.
In 7 days the app stops opening: press Run again to renew it, or let the Mac do it every week:
  apps/ios/scripts/renew.sh --schedule
EOF
