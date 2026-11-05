#!/usr/bin/env bash
#
# Xcode build phase of the Cranium app (see project.yml): put the web bundle in the built app.
#
# From 0.8.0 the app's screens are the console's own pages (docs/mobile-apps.md, "The app shell"). The app
# fetches them from the console and keeps them; this is the copy it carries inside itself, for its first
# start and for when what it fetched does not check out. cloud/web/build-bundle.mjs writes it from
# cloud/web/src, exactly as the console serves it, into WebBundle/ in the app's resources. That needs
# Node.js (18 or newer); without it the build stops, because an app without its pages has nothing to show.

set -euo pipefail

: "${SRCROOT:?run by Xcode}" "${TARGET_BUILD_DIR:?run by Xcode}" "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?run by Xcode}"
REPO="$(cd "$SRCROOT/../.." && pwd)"
DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/WebBundle"

# Xcode gives a build phase a short PATH: look where Node.js is usually installed as well.
find_node() {
  local candidate
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node \
      "$HOME/.asdf/shims/node" "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] &&
        "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! NODE="$(find_node)"; then
  echo "error: Node.js 18 or newer is needed to build the app's web bundle (cloud/web/build-bundle.mjs). Install it (brew install node) and build again." >&2
  exit 1
fi

"$NODE" "$REPO/cloud/web/build-bundle.mjs" --out "$DEST"
