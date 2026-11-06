#!/usr/bin/env bash
#
# Make apps/macos/Cranium.xcodeproj from apps/macos/project.yml with XcodeGen (brew install xcodegen).
# The project is not in git; run this after changing project.yml, and after a pull.
#
#   apps/macos/scripts/generate.sh            signed with your team, if one is found (below)
#   apps/macos/scripts/generate.sh --ad-hoc   "Sign to Run Locally": no team at all
#
# The team comes from CRANIUM_TEAM_ID, else from ~/.cranium/apple-team-id (the free Personal Team the
# iPhone app uses, apps/ios/scripts/phone.sh). Signed with a team, the data protection keychain holds
# Touch ID to the saved sign-in itself; without one, the app asks for Touch ID before it reads it
# (docs/mac-app.md, "Touch ID"). The bundle ID is com.craniumiot.cranium.mac unless
# CRANIUM_MAC_BUNDLE_ID names another.
set -euo pipefail
MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() {
  echo "error: $1" >&2
  exit 1
}
command -v xcodegen >/dev/null || die "xcodegen not found: brew install xcodegen"
ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --ad-hoc) ADHOC=1 ;;
    *) die "unknown option: $arg (only --ad-hoc)" ;;
  esac
done
TEAM_FILE="$HOME/.cranium/apple-team-id"
if [ "$ADHOC" = 1 ]; then
  CRANIUM_TEAM_ID=""
elif [ -z "${CRANIUM_TEAM_ID:-}" ] && [ -f "$TEAM_FILE" ]; then
  CRANIUM_TEAM_ID="$(tr -d '[:space:]' < "$TEAM_FILE")"
fi
export CRANIUM_TEAM_ID="${CRANIUM_TEAM_ID:-}"
if [ -n "$CRANIUM_TEAM_ID" ] && ! [[ "$CRANIUM_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  die "a team ID is ten capital letters and digits"
fi
export CRANIUM_MAC_BUNDLE_ID="${CRANIUM_MAC_BUNDLE_ID:-com.craniumiot.cranium.mac}"
[[ "$CRANIUM_MAC_BUNDLE_ID" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || die "not a bundle ID: $CRANIUM_MAC_BUNDLE_ID"
if [ -n "$CRANIUM_TEAM_ID" ]; then
  export CRANIUM_MAC_SIGN_IDENTITY="Apple Development"
  echo "signed with your team: Touch ID is held by the Keychain"
else
  export CRANIUM_MAC_SIGN_IDENTITY="-"
  echo "no team: signed to run locally; Cranium asks for Touch ID before it reads the saved sign-in"
fi
xcodegen generate --spec "$MAC_DIR/project.yml" --project "$MAC_DIR" --quiet
echo "made $MAC_DIR/Cranium.xcodeproj"
