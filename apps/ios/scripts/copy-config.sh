#!/usr/bin/env bash
#
# Xcode build phase of the Cranium app (see project.yml): put the configuration in the built app.
#
# It copies apps/config/cranium.json, which apps/configure.sh writes and git ignores, into the app
# bundle in the build products, never into the source tree. Without that file a Debug build takes
# apps/config/cranium.example.json instead, made-up values with which sign-in cannot work, and the
# app shows a banner saying so on every screen. A Release build (an archive for TestFlight) stops.
#
# It never prints the values: they name the AWS account, and build logs get shared.

set -euo pipefail

: "${SRCROOT:?run by Xcode}" "${TARGET_BUILD_DIR:?run by Xcode}" "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?run by Xcode}"
CONFIG_DIR="$SRCROOT/../config"
DEPLOYED="$CONFIG_DIR/cranium.json"
EXAMPLE="$CONFIG_DIR/cranium.example.json"
DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"

# A file with the four values, each a string. Says which is missing, not what any is.
check() {
  local key
  for key in consoleUrl loginDomain mobileClientId redirectUri; do
    if ! plutil -extract "$key" raw -expect string -o /dev/null "$1" >/dev/null 2>&1; then
      echo "error: $(basename "$1") has no $key: run apps/configure.sh" >&2
      exit 1
    fi
  done
}

mkdir -p "$DEST"
# Whichever was copied last time goes: the app must never find both, or a stale one.
rm -f "$DEST/cranium.json" "$DEST/cranium.example.json"

if [ -f "$DEPLOYED" ]; then
  check "$DEPLOYED"
  cp "$DEPLOYED" "$DEST/cranium.json"
  echo "Copied apps/config/cranium.json into the app."
elif [ "${CONFIGURATION:-}" = "Release" ]; then
  echo "error: apps/config/cranium.json not found. Run apps/configure.sh first: a Release build does not ship the example configuration." >&2
  exit 1
else
  check "$EXAMPLE"
  cp "$EXAMPLE" "$DEST/cranium.example.json"
  echo "warning: apps/config/cranium.json not found: this build has apps/config/cranium.example.json, and sign-in will not work. Run apps/configure.sh, then build again."
fi
