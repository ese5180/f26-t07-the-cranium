#!/usr/bin/env bash
#
# Tests scripts/release/notes.sh against a temporary repository with a commit in each area, a merge
# commit and an ignored revision. Run: scripts/tests/notes-test.sh

set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../release" && pwd)/notes.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fails=0
checks=0

check() { # description, output, text, want (yes|no)
  local got=no
  checks=$((checks + 1))
  if grep -qF -- "$3" <<< "$2"; then got=yes; fi
  if [ "$got" != "$4" ]; then
    echo "FAIL: $1 (wanted '$3' to be present: $4)"
    fails=$((fails + 1))
  fi
}

g() { git -C "$WORK" "$@"; }

commit() { # subject, file, content
  mkdir -p "$(dirname "$WORK/$2")"
  printf '%s\n' "$3" >> "$WORK/$2"
  g add "$2"
  g commit -q -m "$1"
}

g init -q -b main
g config user.email t@example.com
g config user.name t
g config commit.gpgsign false
# The script finds its repository from its own place, so a copy sits in the temporary one.
mkdir -p "$WORK/scripts/release"
cp "$SCRIPT" "$WORK/scripts/release/notes.sh"
NOTES="$WORK/scripts/release/notes.sh"

commit base README.md x
g tag v0
commit "Console thing (#12)" cloud/a.js a
commit "Firmware thing" firmware/b.c b
commit "Apps thing" apps/c.kt c
commit "Docs thing" docs/d.md d
commit "Moves only" cloud/moved.js m
{ echo "# moves"; g rev-parse HEAD; } > "$WORK/.git-blame-ignore-revs"
g add .git-blame-ignore-revs
g commit -q -m "Ignore list"
g checkout -q -b side
commit "Side work" cloud/side.js s
g checkout -q main
g merge -q --no-ff side -m "Merge pull request #7 from side"
printf '%s\n' "# Console changes" "## 1.2.3" "x" > "$WORK/cloud/CHANGELOG.md"
g add cloud/CHANGELOG.md
g commit -q -m "Console 1.2.3 changelog"
g tag v1

all=$("$NOTES" v0 v1 all)
con=$("$NOTES" v0 v1 console)
fw=$("$NOTES" v0 v1 firmware)

check "console commit with its PR" "$all" "Console thing (PR #12)" yes
check "firmware commit" "$all" "Firmware thing" yes
check "apps commit" "$all" "Apps thing" yes
check "other commit" "$all" "Docs thing" yes
check "merge commit left out" "$all" "Merge pull request" no
check "ignored rev left out" "$all" "Moves only" no
check "side branch commit kept" "$all" "Side work" yes
check "versions header" "$all" "- console: 1.2.3" yes
check "console area has console" "$con" "Console thing" yes
check "console area has no firmware" "$con" "Firmware thing" no
check "firmware area" "$fw" "Firmware thing" yes
check "firmware area has no console" "$fw" "Console thing" no

for bad in "v0 nope console" "v0 v1 bogus" "-x v1 all"; do
  checks=$((checks + 1))
  # shellcheck disable=SC2086 # the words are the point
  if "$NOTES" $bad > /dev/null 2>&1; then
    echo "FAIL: accepted: $bad"
    fails=$((fails + 1))
  fi
done

echo "$((checks - fails)) of $checks checks passed"
[ "$fails" = 0 ]
