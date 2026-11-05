#!/usr/bin/env bash
#
# Build the Cranium iPhone app as an unsigned IPA, apps/dist/cranium-ios-<version>.ipa, for SideStore.
#
#   apps/ios/scripts/build-ipa.sh              build it
#   apps/ios/scripts/build-ipa.sh --publish    build it, then publish it on the console (scripts/publish.sh)
#
# Nobody signs it here: SideStore signs it on each iPhone with that person's own Apple ID (docs/mobile-apps.md,
# "Updates on every phone"), so it needs no Apple Developer Program, no certificate and no profile. The
# GitHub Actions workflow release-apps.yml runs this on a macOS runner for a tag ios-v<version>.
#
# Needs, and checks before it starts:
#   - Xcode 16 or later, selected (xcode-select -p), with the iOS platform.
#   - xcodegen (brew install xcodegen).
#   - apps/config/cranium.json, from apps/configure.sh: a Release build refuses the example (copy-config.sh).
#
# It makes the Xcode project afresh with the bundle ID com.craniumiot.cranium, archives a Release build for
# any iOS device with code signing off, checks that the app holds the real configuration and says the
# version and build of apps/ios/project.yml, and zips Payload/Cranium.app as the IPA. The version is
# MARKETING_VERSION, the build CURRENT_PROJECT_VERSION. The archive stays in apps/ios/build/ipa/, which git
# ignores, and so does apps/dist/. The IPA holds this console's address and client IDs: never attach it to a
# public release. It prints no value of the configuration.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/../.." && pwd)"
CONFIG="$REPO_DIR/apps/config/cranium.json"
BUILD_DIR="$IOS_DIR/build/ipa"
ARCHIVE="$BUILD_DIR/Cranium.xcarchive"
STAGE="$BUILD_DIR/stage"
DIST_DIR="$REPO_DIR/apps/dist"
BUNDLE_ID="com.craniumiot.cranium"

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

step() {
  echo
  echo "== $1"
}

publish=false
for argument in "$@"; do
  case "$argument" in
    --publish) publish=true ;;
    -h|--help) sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $argument (see --help)" ;;
  esac
done

# --- What it needs ------------------------------------------------------------------------------

DEVELOPER_DIR_NOW="$(xcode-select -p 2>/dev/null || true)"
case "$DEVELOPER_DIR_NOW" in
  "" | *CommandLineTools*)
    die "Xcode is not selected: xcode-select -p says ${DEVELOPER_DIR_NOW:-nothing}." \
        "Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    ;;
esac
XCODE_VERSION="$(xcodebuild -version 2>/dev/null | sed -n 's/^Xcode \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
[ -n "$XCODE_VERSION" ] || die "xcodebuild does not run." "Open Xcode once to finish installing it: sudo xcodebuild -license accept"
[ "${XCODE_VERSION%%.*}" -ge 16 ] || die "Xcode $XCODE_VERSION is too old: CraniumKit needs Xcode 16 or later."
xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1 || die "Xcode has no iOS platform." "Add it in Xcode, Settings, Components."
command -v xcodegen >/dev/null || die "xcodegen not found." "brew install xcodegen"
command -v zip >/dev/null || die "zip not found."
[ -f "$CONFIG" ] || die "apps/config/cranium.json not found." "Run apps/configure.sh. An IPA for the team never has the example configuration."

setting() {
  sed -n "s/^ *$1: *\"\{0,1\}\([0-9.]*\)\"\{0,1\} *$/\1/p" "$IOS_DIR/project.yml" | head -n 1
}
VERSION="$(setting MARKETING_VERSION)"
BUILD="$(setting CURRENT_PROJECT_VERSION)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "project.yml has no MARKETING_VERSION like 0.6.0."
[[ "$BUILD" =~ ^[1-9][0-9]{0,9}$ ]] || die "project.yml has no CURRENT_PROJECT_VERSION that is a whole number."

if [ -n "$(git -C "$REPO_DIR" status --porcelain -- apps/ios apps/shared 2>/dev/null)" ]; then
  echo "note: apps/ios or apps/shared has changes that are not committed; they go into this build." >&2
fi

# --- Build --------------------------------------------------------------------------------------

echo "Cranium $VERSION, build $BUILD, unsigned, with Xcode $XCODE_VERSION."

step "Making the Xcode project"
# The console takes only the app's own bundle ID (cloud/api/src/lib/apps.mjs). The team does not matter:
# nothing is signed.
CRANIUM_BUNDLE_ID="$BUNDLE_ID" "$IOS_DIR/scripts/generate.sh"

rm -rf "$ARCHIVE" "$STAGE"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

step "Archiving, without signing"
# CRANIUM_BUILD_JOBS keeps xcodebuild to that many jobs, on a Mac shared with other work.
jobs=()
[ -z "${CRANIUM_BUILD_JOBS:-}" ] || jobs=(-jobs "$CRANIUM_BUILD_JOBS")
xcodebuild archive ${jobs[@]+"${jobs[@]}"} \
  -project "$IOS_DIR/Cranium.xcodeproj" \
  -scheme Cranium \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$BUILD_DIR/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  DEVELOPMENT_TEAM=""

APP="$ARCHIVE/Products/Applications/Cranium.app"
[ -d "$APP" ] || die "the archive has no Cranium.app."
[ -f "$APP/cranium.json" ] || die "the archived app has no cranium.json: the configuration step did not run."
[ ! -e "$APP/cranium.example.json" ] || die "the archived app has the example configuration."

info() {
  plutil -extract "$1" raw -expect string -o - "$APP/Info.plist" 2>/dev/null || true
}
[ "$(info CFBundleIdentifier)" = "$BUNDLE_ID" ] || die "the app's bundle ID is not $BUNDLE_ID."
[ "$(info CFBundleShortVersionString)" = "$VERSION" ] || die "the app says it is version $(info CFBundleShortVersionString), not $VERSION."
[ "$(info CFBundleVersion)" = "$BUILD" ] || die "the app says it is build $(info CFBundleVersion), not $BUILD."

step "Making the IPA"
mkdir -p "$STAGE/Payload"
ditto "$APP" "$STAGE/Payload/Cranium.app"
OUT="$DIST_DIR/cranium-ios-$VERSION.ipa"
rm -f "$OUT"
# -y keeps symbolic links as links, -X leaves out the Mac's extended attributes: what an IPA holds.
(cd "$STAGE" && zip -q -r -y -X "$OUT" Payload)
SHA256="$(shasum -a 256 "$OUT" | cut -d ' ' -f 1)"
SIZE="$(stat -f %z "$OUT")"

echo
echo "Built $OUT"
echo "  version $VERSION, build $BUILD, $SIZE bytes, SHA-256 $SHA256"
echo "It holds this stack's console address and client IDs: share it through the console, never in a public release."

if [ "$publish" = true ]; then
  echo
  exec "$IOS_DIR/scripts/publish.sh" "$OUT"
fi
echo "Next: publish it on the console with apps/ios/scripts/publish.sh, and SideStore installs it on every iPhone."
