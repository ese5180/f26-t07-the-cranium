#!/usr/bin/env bash
#
# Check what can be checked on a Mac without a phone, and even without Xcode:
#
#   - CraniumKit builds, with its Bluetooth target, and its tests pass (swift build, swift test)
#   - the app's sources type-check against the macOS SDK and the package (a few lines that only
#     exist for iOS, under #if canImport(UIKit), are not seen)
#   - the scripts parse, and Info.plist is a property list
#
#   apps/ios/scripts/check.sh            two compile jobs
#   JOBS=8 apps/ios/scripts/check.sh     more
#
# With only the Command Line Tools, swift test does not find Swift Testing by itself, so the
# paths are given. Building the app for iOS needs Xcode: scripts/testflight.sh, or Xcode itself.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${JOBS:-2}"

TEST_FLAGS=()
if [[ "$(xcode-select -p 2>/dev/null)" == *CommandLineTools* ]]; then
  CLT="$(xcode-select -p)/Library/Developer"
  TEST_FLAGS=(
    -Xswiftc -F -Xswiftc "$CLT/Frameworks"
    -Xlinker -F -Xlinker "$CLT/Frameworks"
    -Xlinker -rpath -Xlinker "$CLT/Frameworks"
    -Xlinker -rpath -Xlinker "$CLT/usr/lib"
  )
fi

cd "$IOS_DIR/CraniumKit"

echo "== swift build"
swift build -j "$JOBS"

echo "== swift test"
swift test -j "$JOBS" ${TEST_FLAGS[@]+"${TEST_FLAGS[@]}"}

echo "== the app's sources, type-checked for macOS 13 (the nearest to iOS 16 this Mac has)"
MODULES="$(swift build -j "$JOBS" --show-bin-path)/Modules"
xcrun swiftc -typecheck -parse-as-library -swift-version 5 \
  -sdk "$(xcrun --show-sdk-path)" -target "$(uname -m)-apple-macosx13.0" \
  -I "$MODULES" "$IOS_DIR"/App/*.swift "$IOS_DIR"/App/Views/*.swift
echo "ok"

echo "== scripts and Info.plist"
for script in "$IOS_DIR"/scripts/*.sh; do
  bash -n "$script"
done
plutil -lint -s "$IOS_DIR/App/Info.plist"
echo "ok"

echo
echo "All passed. Not checked here: the app built for iOS, signing, the upload, and anything on a phone or a board."
