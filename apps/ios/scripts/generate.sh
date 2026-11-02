#!/usr/bin/env bash
#
# Make apps/ios/Cranium.xcodeproj from apps/ios/project.yml with XcodeGen (brew install xcodegen).
# The project is not in git; run this after changing project.yml, and after a pull.
#
# The signing team comes from ~/.cranium/appstoreconnect/key.json ("teamId") when that file is
# there, or from CRANIUM_TEAM_ID. Without either, pick the team in Xcode's Signing & Capabilities.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_JSON="$HOME/.cranium/appstoreconnect/key.json"

die() {
  echo "error: $1" >&2
  exit 1
}

command -v xcodegen >/dev/null || die "xcodegen not found: brew install xcodegen"

if [ -z "${CRANIUM_TEAM_ID:-}" ] && [ -f "$KEY_JSON" ]; then
  CRANIUM_TEAM_ID="$(plutil -extract teamId raw -expect string -o - "$KEY_JSON" 2>/dev/null || true)"
fi
export CRANIUM_TEAM_ID="${CRANIUM_TEAM_ID:-}"
[ -n "$CRANIUM_TEAM_ID" ] || echo "note: no team ID: pick the team in Xcode's Signing & Capabilities" >&2

xcodegen generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR" --quiet
echo "made $IOS_DIR/Cranium.xcodeproj"
