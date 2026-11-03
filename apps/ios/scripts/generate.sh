#!/usr/bin/env bash
#
# Make apps/ios/Cranium.xcodeproj from apps/ios/project.yml with XcodeGen (brew install xcodegen).
# The project is not in git; run this after changing project.yml, and after a pull.
#
# The signing team comes from CRANIUM_TEAM_ID, else from ~/.cranium/apple-team-id (one line: the
# ten-character ID of a free Personal Team, which scripts/phone.sh saves), else from
# ~/.cranium/appstoreconnect/key.json ("teamId"). Without any, pick the team in Xcode's Signing &
# Capabilities. The bundle ID is com.craniumiot.cranium unless CRANIUM_BUNDLE_ID or
# ~/.cranium/apple-bundle-id names another: a bundle ID belongs to one team, so a second free team
# needs its own.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_JSON="$HOME/.cranium/appstoreconnect/key.json"

die() {
  echo "error: $1" >&2
  exit 1
}

command -v xcodegen >/dev/null || die "xcodegen not found: brew install xcodegen"

TEAM_FILE="$HOME/.cranium/apple-team-id"
BUNDLE_FILE="$HOME/.cranium/apple-bundle-id"
if [ -z "${CRANIUM_TEAM_ID:-}" ] && [ -f "$TEAM_FILE" ]; then
  CRANIUM_TEAM_ID="$(tr -d '[:space:]' < "$TEAM_FILE")"
fi
if [ -z "${CRANIUM_BUNDLE_ID:-}" ] && [ -f "$BUNDLE_FILE" ]; then
  CRANIUM_BUNDLE_ID="$(tr -d '[:space:]' < "$BUNDLE_FILE")"
fi
export CRANIUM_BUNDLE_ID="${CRANIUM_BUNDLE_ID:-com.craniumiot.cranium}"
[[ "$CRANIUM_BUNDLE_ID" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] || die "not a bundle ID: $CRANIUM_BUNDLE_ID"
if [ -n "${CRANIUM_TEAM_ID:-}" ] && ! [[ "$CRANIUM_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  die "a team ID is ten capital letters and digits"
fi
if [ -z "${CRANIUM_TEAM_ID:-}" ] && [ -f "$KEY_JSON" ]; then
  CRANIUM_TEAM_ID="$(plutil -extract teamId raw -expect string -o - "$KEY_JSON" 2>/dev/null || true)"
fi
export CRANIUM_TEAM_ID="${CRANIUM_TEAM_ID:-}"
[ -n "$CRANIUM_TEAM_ID" ] || echo "note: no team ID: pick the team in Xcode's Signing & Capabilities" >&2

xcodegen generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR" --quiet
echo "made $IOS_DIR/Cranium.xcodeproj"
