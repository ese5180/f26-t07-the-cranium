#!/usr/bin/env bash
#
# Xcode build phase of the Cranium app (see project.yml): write the commit the app was built from
# into the built app's Info.plist, as CraniumCommit, for Help, About. A tree with changes that
# are not committed gets "-dirty" after it. Without git, or outside a checkout, nothing is written
# and the app says "Not recorded". Never fails the build.

set -uo pipefail

: "${SRCROOT:?run by Xcode}" "${TARGET_BUILD_DIR:?run by Xcode}" "${INFOPLIST_PATH:?run by Xcode}"
PLIST="$TARGET_BUILD_DIR/$INFOPLIST_PATH"
[ -f "$PLIST" ] || exit 0

commit="$(git -C "$SRCROOT" rev-parse --short HEAD 2>/dev/null || true)"
[ -n "$commit" ] || exit 0
if [ -n "$(git -C "$SRCROOT" status --porcelain 2>/dev/null | head -1)" ]; then
  commit="$commit-dirty"
fi
/usr/libexec/PlistBuddy -c "Delete :CraniumCommit" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CraniumCommit string $commit" "$PLIST" >/dev/null 2>&1 || true
echo "Built from $commit."
