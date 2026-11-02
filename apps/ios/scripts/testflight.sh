#!/usr/bin/env bash
#
# Build the Cranium iPhone app and upload it to TestFlight.
#
#   apps/ios/scripts/testflight.sh                    build number from the UTC time, 20261102.153045
#   BUILD_NUMBER=7 apps/ios/scripts/testflight.sh     that build number instead
#
# Needs, and checks before it starts:
#   - Xcode 16 or later, selected (xcode-select -p), with the iOS platform. The Command Line Tools
#     alone cannot build an iPhone app.
#   - xcodegen (brew install xcodegen).
#   - apps/config/cranium.json, from apps/configure.sh. A TestFlight build never ships the example.
#   - An App Store Connect API key with the App Manager role, outside the repository:
#       ~/.cranium/appstoreconnect/key.json        {"keyId": "...", "issuerId": "...", "teamId": "..."}
#       ~/.cranium/appstoreconnect/AuthKey_<keyId>.p8
#
# It makes the Xcode project afresh, archives a Release build for any iOS device, and exports the
# archive with destination "upload", which signs it (automatic signing, through the key) and sends
# it to App Store Connect. The version is MARKETING_VERSION in project.yml. App Store Connect then
# takes some minutes to process the build before it shows in TestFlight. The archive stays in
# apps/ios/build/, which git ignores.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/../.." && pwd)"
KEY_DIR="$HOME/.cranium/appstoreconnect"
KEY_JSON="$KEY_DIR/key.json"
CONFIG="$REPO_DIR/apps/config/cranium.json"
BUILD_DIR="$IOS_DIR/build"
ARCHIVE="$BUILD_DIR/Cranium.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
EXPORT_OPTIONS="$BUILD_DIR/ExportOptions.plist"

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

step() {
  echo
  echo "== $1"
}

# --- What it needs ------------------------------------------------------------------------------

DEVELOPER_DIR_NOW="$(xcode-select -p 2>/dev/null || true)"
case "$DEVELOPER_DIR_NOW" in
  "" | *CommandLineTools*)
    die "Xcode is not selected: xcode-select -p says ${DEVELOPER_DIR_NOW:-nothing}." \
        "Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    ;;
esac
XCODE_VERSION="$(xcodebuild -version 2>/dev/null | sed -n 's/^Xcode \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
[ -n "$XCODE_VERSION" ] || die "xcodebuild does not run." "Open Xcode once to finish installing it, and accept its license: sudo xcodebuild -license accept"
[ "${XCODE_VERSION%%.*}" -ge 16 ] || die "Xcode $XCODE_VERSION is too old: CraniumKit needs Xcode 16 or later, and App Store Connect takes uploads only from a recent Xcode."
xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1 || die "Xcode has no iOS platform." "Add it in Xcode, Settings, Components."
command -v xcodegen >/dev/null || die "xcodegen not found." "brew install xcodegen"

[ -f "$CONFIG" ] || die "apps/config/cranium.json not found." "Run apps/configure.sh. A TestFlight build does not ship the example configuration."

[ -f "$KEY_JSON" ] || die "$KEY_JSON not found." \
  "Write it with the App Store Connect API key's keyId and issuerId, and the team's teamId: {\"keyId\": \"...\", \"issuerId\": \"...\", \"teamId\": \"...\"}"
field() {
  plutil -extract "$1" raw -expect string -o - "$KEY_JSON" 2>/dev/null || true
}
KEY_ID="$(field keyId)"
ISSUER_ID="$(field issuerId)"
TEAM_ID="$(field teamId)"
[[ "$KEY_ID" =~ ^[A-Z0-9]{8,12}$ ]] || die "key.json has no keyId, or not one like 2X9R4HXF34."
[[ "$ISSUER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || die "key.json has no issuerId, or not a UUID. It is on App Store Connect, Users and Access, Integrations."
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || die "key.json has no teamId, or not one like ABCDE12345. It is on developer.apple.com, Membership."

KEY_PATH="$KEY_DIR/AuthKey_$KEY_ID.p8"
[ -f "$KEY_PATH" ] || die "$KEY_DIR/AuthKey_<keyId>.p8 not found: download the key from App Store Connect (it can be downloaded only once)."
grep -q "BEGIN PRIVATE KEY" "$KEY_PATH" || die "$KEY_DIR/AuthKey_<keyId>.p8 is not a private key."
KEY_MODE="$(stat -f %Lp "$KEY_PATH")"
[ "${KEY_MODE: -2}" = "00" ] || echo "warning: others can read the key: chmod 600 $KEY_PATH" >&2

BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d).$((10#$(date -u +%H%M%S)))}"
[[ "$BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || die "BUILD_NUMBER must be one to three numbers joined by dots, not $BUILD_NUMBER."
VERSION="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([0-9.]*\)"\{0,1\} *$/\1/p' "$IOS_DIR/project.yml" | head -n 1)"
[ -n "$VERSION" ] || die "project.yml has no MARKETING_VERSION."

if [ -n "$(git -C "$REPO_DIR" status --porcelain -- apps/ios 2>/dev/null)" ]; then
  echo "note: apps/ios has changes that are not committed; they go into this build." >&2
fi

# --- Build and upload ---------------------------------------------------------------------------

echo "Cranium $VERSION, build $BUILD_NUMBER, with Xcode $XCODE_VERSION."

step "Making the Xcode project"
CRANIUM_TEAM_ID="$TEAM_ID" "$IOS_DIR/scripts/generate.sh"

rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p "$BUILD_DIR"

# The key signs in to App Store Connect for signing certificates, profiles and the upload.
AUTH=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$KEY_PATH"
  -authenticationKeyID "$KEY_ID"
  -authenticationKeyIssuerID "$ISSUER_ID"
)

step "Archiving"
xcodebuild archive \
  -project "$IOS_DIR/Cranium.xcodeproj" \
  -scheme Cranium \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$BUILD_DIR/DerivedData" \
  "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

[ -f "$ARCHIVE/Products/Applications/Cranium.app/cranium.json" ] \
  || die "the archived app has no cranium.json: the configuration step did not run."

cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>uploadSymbols</key>
	<true/>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
PLIST
plutil -lint -s "$EXPORT_OPTIONS" || die "could not write $EXPORT_OPTIONS"

step "Signing and uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath "$EXPORT_DIR" \
  "${AUTH[@]}"

echo
echo "Uploaded Cranium $VERSION ($BUILD_NUMBER). App Store Connect processes it for a few minutes;"
echo "then it is in TestFlight, under the app with bundle ID com.craniumiot.cranium."
