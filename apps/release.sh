#!/usr/bin/env bash
#
# Release a new version of the phone apps, in one command, from any computer with this checkout.
#
#   apps/release.sh 0.7.2            both apps at 0.7.2
#   apps/release.sh 0.7.2 android    only Android (or: ios)
#   apps/release.sh 0.7.2 --wait     ...then wait for GitHub to publish, and put the builds in git
#
# Before: write the version's entry at the top of the app's CHANGELOG ("## 0.7.2", first paragraph
# what people see, at most 440 characters), and commit your changes. Then this:
#   1. checks you are on main, clean and up to date with GitHub, and that each entry is there;
#   2. sets the version (iOS MARKETING_VERSION and its build number; Android craniumVersionName and
#      versionCode), commits "Phone apps <version>" and pushes it;
#   3. tags ios-v<version> / android-v<version> and pushes the tags. GitHub's "Release the apps"
#      workflow then builds, signs and publishes each app on the console's Apps page (docs/ci.md).
#      Every Android phone on 0.7.0 or later offers the update; SideStore shows the iPhone one; the
#      owner's iPhone gets it from the Mac (apps/ios/scripts/renew.sh).
#   4. with --wait: watches the workflow (needs gh), then runs apps/fetch-builds.sh and commits
#      apps/dist/, so the published builds are in git too.
# Tags are added, never moved: a mistake is a new version.

set -euo pipefail

APPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$APPS_DIR/.." && pwd)"
fail() { echo "error: $*" >&2; exit 1; }

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
shift
WHICH=both WAIT=0
for arg in "$@"; do
  case "$arg" in android|ios|both) WHICH="$arg" ;; --wait) WAIT=1 ;; *) fail "unknown argument $arg" ;; esac
done
apps=(); [ "$WHICH" != ios ] && apps+=(android); [ "$WHICH" != android ] && apps+=(ios)

cd "$REPO_DIR"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "check out main first"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "commit or put aside your changes first"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not the same as GitHub's: pull (or push) first"

changelog() { [ "$1" = ios ] && echo apps/ios/CHANGELOG.md || echo apps/android/CHANGELOG.md; }
for app in "${apps[@]}"; do
  grep -q "^## $VERSION\$" "$(changelog "$app")" || fail "$(changelog "$app") has no \"## $VERSION\" entry: write it first"
  ! git rev-parse -q --verify "refs/tags/$app-v$VERSION" >/dev/null || fail "$app-v$VERSION is already a tag"
done

for app in "${apps[@]}"; do
  if [ "$app" = ios ]; then
    build="$(sed -n 's/^ *CURRENT_PROJECT_VERSION: *"\{0,1\}\([0-9]*\)"\{0,1\} *$/\1/p' apps/ios/project.yml | head -1)"
    [ -n "$build" ] || fail "no CURRENT_PROJECT_VERSION in apps/ios/project.yml"
    sed -i.bak -E "s/^( *MARKETING_VERSION: *)\"?[0-9.]+\"?/\1\"$VERSION\"/; s/^( *CURRENT_PROJECT_VERSION: *)\"?[0-9]+\"?/\1\"$((build + 1))\"/" apps/ios/project.yml
    rm -f apps/ios/project.yml.bak
    git add apps/ios/project.yml
  else
    code="$(sed -n 's/^craniumVersionCode=//p' apps/android/gradle.properties | tail -1)"
    [ -n "$code" ] || fail "no craniumVersionCode in apps/android/gradle.properties"
    sed -i.bak -E "s/^craniumVersionName=.*/craniumVersionName=$VERSION/; s/^craniumVersionCode=.*/craniumVersionCode=$((code + 1))/" apps/android/gradle.properties
    rm -f apps/android/gradle.properties.bak
    git add apps/android/gradle.properties
  fi
done

if ! git diff --cached --quiet; then
  git commit -q -m "Phone apps $VERSION" -m "Released with apps/release.sh: $(printf '%s ' "${apps[@]}")"
  git push -q origin main
fi
commit="$(git rev-parse --short HEAD)"

note() {   # the first paragraph of the version's entry, for the tag
  python3 -I - "$1" "$VERSION" <<'EOF'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^## " + re.escape(sys.argv[2]) + r"\b.*?\n(.*?)(?=^## |\Z)", text, re.S | re.M)
paras = [p for p in m.group(1).strip().split("\n\n") if p.strip()]
print(" ".join(paras[0].split()))
EOF
}
tags=()
for app in "${apps[@]}"; do
  git tag -a "$app-v$VERSION" -m "$(note "$(changelog "$app")")" "$commit"
  tags+=("$app-v$VERSION")
done
git push -q origin "${tags[@]}"
echo "Tagged ${tags[*]} on $commit. GitHub now builds and publishes them (Actions > Release the apps)."

if [ "$WAIT" = 1 ]; then
  command -v gh >/dev/null || fail "--wait needs the GitHub CLI (gh)"
  sleep 15
  for tag in "${tags[@]}"; do
    run="$(gh run list --branch "$tag" --workflow release-apps.yml -L 1 --json databaseId --jq '.[0].databaseId')"
    [ -n "$run" ] || fail "no release run found for $tag"
    gh run watch "$run" --exit-status --interval 30 || fail "the release of $tag failed: gh run view $run --log-failed"
  done
  "$APPS_DIR/fetch-builds.sh" "$WHICH"
  # apps/dist/ is ignored for local builds; the published ones are added on purpose.
  git add -u -- apps/dist
  git add -f -- apps/dist/README.md apps/dist/SHA256SUMS apps/dist/latest.json
  for build in apps/dist/cranium-android-*.apk apps/dist/cranium-ios-*.ipa; do [ -e "$build" ] && git add -f -- "$build"; done
  git commit -q -m "Apps $VERSION: the published builds in apps/dist/" -m "From the console with apps/fetch-builds.sh, checked against its SHA-256."
  git push -q origin main
  echo "The builds are in git: apps/dist/."
fi
