#!/usr/bin/env bash
#
# Release notes in Markdown from the commits between two refs, grouped by what each commit touched.
#
#   scripts/release/notes.sh console-v2.10.0 console-v2.11.0 console    the console's changes
#   scripts/release/notes.sh v1.14.0 v1.15.0 firmware                   firmware only
#   scripts/release/notes.sh ios-v0.8.0 ios-v0.8.8 apps                 the phone and desktop apps
#   scripts/release/notes.sh <from> <to> all                            every area
#
# The area is console, firmware, apps or all. A commit is listed under every area whose files it
# touched: cloud/ is console, firmware/ is firmware, apps/ is apps, and anything else (docs, scripts,
# tools) is other, which "all" adds. Merge commits are left out, and so are the commits listed in
# .git-blame-ignore-revs (they only reformat or move files). Each line is the commit's subject, its
# PR number if the subject has one, and the short hash. The "Versions" header lists the CHANGELOG
# headings added between the two refs. It reads git history only and writes to standard output.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

git_here() {
  git --no-optional-locks -C "$REPO_DIR" "$@"
}

# The areas a commit touched, one per line, from the first path of each file.
areas_of() {
  git_here diff-tree --no-commit-id --name-only -r --root "$1" | awk '
    /^cloud\//    { seen["console"] = 1; next }
    /^firmware\// { seen["firmware"] = 1; next }
    /^apps\//     { seen["apps"] = 1; next }
    NF            { seen["other"] = 1 }
    END { for (a in seen) print a }'
}

versions_header() {
  local from=$1 to=$2 area=$3 entry file label added any=0
  echo '## Versions'
  echo
  for entry in cloud/CHANGELOG.md:console firmware/CHANGELOG.md:firmware apps/android/CHANGELOG.md:android apps/ios/CHANGELOG.md:ios; do
    label=${entry#*:}
    file=${entry%:*}
    case "$area" in
      all) ;;
      console) [ "$label" = console ] || continue ;;
      firmware) [ "$label" = firmware ] || continue ;;
      apps) case "$label" in android|ios) ;; *) continue ;; esac ;;
    esac
    added=$(git_here diff "$from" "$to" -- "$file" | sed -n 's/^+## \([0-9][^ ]*\).*/\1/p' | paste -sd, - | sed 's/,/, /g')
    if [ -n "$added" ]; then
      echo "- $label: $added"
      any=1
    fi
  done
  [ "$any" = 1 ] || echo '- no CHANGELOG entry in this range'
  echo
}

main() {
  local from to area
  case "${1:-}" in -h|--help) usage; exit 0 ;; esac
  [ $# -eq 3 ] || { usage >&2; exit 2; }
  from=$1 to=$2 area=$3
  case "$area" in console|firmware|apps|all) ;; *) usage >&2; exit 2 ;; esac
  case "$from" in -*) echo "refused: not a ref" >&2; exit 2 ;; esac
  case "$to" in -*) echo "refused: not a ref" >&2; exit 2 ;; esac
  git_here rev-parse -q --verify "$from^{commit}" > /dev/null || { echo "refused: unknown ref $from" >&2; exit 1; }
  git_here rev-parse -q --verify "$to^{commit}" > /dev/null || { echo "refused: unknown ref $to" >&2; exit 1; }

  local ignored=''
  if [ -f "$REPO_DIR/.git-blame-ignore-revs" ]; then
    ignored=$(grep -E '^[0-9a-f]{40}$' "$REPO_DIR/.git-blame-ignore-revs" || true)
  fi

  local areas="console firmware apps other" listing line hash subject a pr body
  [ "$area" = all ] || areas=$area
  listing=$(git_here log --no-merges --reverse --format='%H %s' "$from..$to")

  echo "# Release notes: $from to $to"
  echo
  versions_header "$from" "$to" "$area"

  for a in $areas; do
    body=''
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      hash=${line%% *}
      subject=${line#* }
      if [ -n "$ignored" ] && grep -qx "$hash" <<< "$ignored"; then continue; fi
      areas_of "$hash" | grep -qx "$a" || continue
      pr=''
      if [[ $subject =~ \(#([0-9]+)\)[[:space:]]*$ ]]; then
        pr=" (PR #${BASH_REMATCH[1]})"
        subject=${subject% \(#*}
      fi
      body+="- ${subject}${pr} (\`${hash:0:7}\`)"$'\n'
    done <<< "$listing"
    if [ "$area" = all ] && [ -z "$body" ]; then continue; fi
    echo "## $(tr '[:lower:]' '[:upper:]' <<< "${a:0:1}")${a:1}"
    echo
    if [ -n "$body" ]; then printf '%s\n' "$body"; else printf '%s\n\n' '- no commits'; fi
  done
}

main "$@"
