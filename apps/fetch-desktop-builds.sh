#!/usr/bin/env bash
#
# Put a released build of the desktop app into apps/dist/, so that it is in git with the source, as the phone
# apps' builds are (apps/fetch-builds.sh). A release is a tag desktop-windows-v<version> or
# desktop-linux-v<version>: its job in .github/workflows/release-apps.yml builds the installers and keeps
# them as that run's artifact for 7 days (docs/desktop-app.md, "Releases").
#
#   apps/fetch-desktop-builds.sh windows 0.1.0     that release
#   apps/fetch-desktop-builds.sh linux             the newest release of linux whose artifact is still kept
#   apps/fetch-desktop-builds.sh linux 0.1.0 --allow-large
#                                                  files over 100 MB too (only with Git LFS for them: GitHub
#                                                  refuses such a file in git). Without it, such a
#                                                  file goes in parts of 90 MiB (apps/join-build.sh)
#
# Each file is checked against the SHA256SUMS the release job wrote, and must be one of the installers the
# app publishes by its name. Older builds of the same system in apps/dist/ are removed. SHA256SUMS and
# latest.json are written again for every build there (apps/write-dist-index.py). Then the script says
# exactly what to commit; it commits nothing itself.
#
# Needs the GitHub CLI, signed in (gh auth login), and python3.

set -euo pipefail

APPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$APPS_DIR/dist"
REPO="ese5180/f26-t07-the-cranium"
LIMIT=104857600

fail() { echo "error: $*" >&2; exit 1; }

PLATFORM="${1:-}"
VERSION=""
ALLOW_LARGE=0
shift || true
for arg in "$@"; do
  case "$arg" in
    --allow-large) ALLOW_LARGE=1 ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION="$arg" ;;
    *) fail "unknown argument $arg" ;;
  esac
done
case "$PLATFORM" in windows|linux) ;; *) fail "name the system: apps/fetch-desktop-builds.sh windows|linux [version]" ;; esac
[[ -z "$VERSION" || "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "a version is like 0.1.0"
command -v gh >/dev/null || fail "the GitHub CLI is needed (https://cli.github.com), signed in with gh auth login"
command -v python3 >/dev/null || fail "python3 is needed"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The artifact: the newest one of that name that GitHub still keeps.
gh api --paginate "repos/$REPO/actions/artifacts?per_page=100" > "$WORK/artifacts.json" || fail "GitHub did not list the artifacts"
python3 -I - "$WORK/artifacts.json" "$PLATFORM" "$VERSION" > "$WORK/pick" <<'EOF'
import json, re, sys
text = open(sys.argv[1]).read()
platform, version = sys.argv[2], sys.argv[3]
artifacts = []
decoder = json.JSONDecoder()
at = 0
while at < len(text):  # --paginate prints one JSON object per page
    while at < len(text) and text[at].isspace():
        at += 1
    if at >= len(text):
        break
    page, at = decoder.raw_decode(text, at)
    artifacts += page.get("artifacts", [])
pattern = re.compile(r"cranium-desktop-%s-(\d+\.\d+\.\d+)" % platform)
found = []
for a in artifacts:
    m = pattern.fullmatch(a.get("name", ""))
    if not m or a.get("expired") or (version and m.group(1) != version):
        continue
    found.append((tuple(int(p) for p in m.group(1).split(".")), a["created_at"], a["workflow_run"]["id"], a["name"], m.group(1)))
if found:
    found.sort()
    _, _, run, name, ver = found[-1]
    print(run, name, ver)
EOF
read -r RUN NAME VERSION < "$WORK/pick" || fail "no kept artifact of a $PLATFORM release${VERSION:+ $VERSION}: release it (docs/desktop-app.md, \"Releases\"), or fetch within 7 days of the release"

gh run download "$RUN" -R "$REPO" -n "$NAME" -D "$WORK/files" || fail "the artifact $NAME of run $RUN did not download"

# Every file the release listed, with its SHA-256, and nothing else.
python3 -I - "$WORK/files" "$PLATFORM" "$VERSION" <<'EOF' || fail "the files are not what the release listed"
import hashlib, os, re, sys
folder, platform, v = sys.argv[1], sys.argv[2], re.escape(sys.argv[3])
names = {
    "windows": [r"Cranium-Setup-%s\.exe", r"Cranium-Setup-%s-arm64\.exe", r"Cranium-%s-portable\.exe"],
    "linux": [r"Cranium-%s\.AppImage", r"Cranium-%s-arm64\.AppImage", r"cranium_%s_amd64\.deb", r"cranium_%s_arm64\.deb",
              r"cranium-%s\.x86_64\.rpm", r"cranium-%s\.aarch64\.rpm"],
}[platform]
allowed = [re.compile(p % v) for p in names]
listed = {}
for line in open(os.path.join(folder, "SHA256SUMS")):
    if line.strip():
        sha, name = line.split(None, 1)
        listed[name.strip().lstrip("*")] = sha
present = sorted(n for n in os.listdir(folder) if n != "SHA256SUMS")
if sorted(listed) != present or not present:
    sys.exit("error: the files are not the ones SHA256SUMS lists")
for name in present:
    if not any(p.fullmatch(name) for p in allowed):
        sys.exit("error: %s is not an installer this app publishes" % name)
    h = hashlib.sha256()
    with open(os.path.join(folder, name), "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != listed[name]:
        sys.exit("error: %s does not have the SHA-256 the release listed" % name)
EOF

mkdir -p "$DIST"
added=()
left=()
split=()
for path in "$WORK/files"/*; do
  name="$(basename "$path")"
  [ "$name" = SHA256SUMS ] && continue
  size="$(wc -c < "$path" | tr -d ' ')"
  if [ "$size" -gt "$LIMIT" ] && [ "$ALLOW_LARGE" = 0 ]; then
    # Over what GitHub takes in one file: in parts of 90 MiB, <name>.part01, .part02, ..., with the whole
    # file's SHA-256 in <name>.sha256. apps/join-build.sh puts it back together and checks it.
    python3 -I - "$path" "$WORK/parts" <<'SPLIT'
import hashlib, os, sys
path, out = sys.argv[1], sys.argv[2]
name, part, whole = os.path.basename(path), 0, hashlib.sha256()
os.makedirs(out, exist_ok=True)
with open(path, "rb") as source:
    while True:
        chunk = source.read(90 * 1024 * 1024)
        if not chunk:
            break
        whole.update(chunk)
        part += 1
        with open(os.path.join(out, "%s.part%02d" % (name, part)), "wb") as target:
            target.write(chunk)
with open(os.path.join(out, name + ".sha256"), "w") as target:
    target.write("%s  %s\n" % (whole.hexdigest(), name))
SPLIT
    for piece in "$WORK/parts/$name".part[0-9][0-9] "$WORK/parts/$name.sha256"; do
      mv "$piece" "$WORK/files/"
      added+=("$(basename "$piece")")
    done
    split+=("$name ($size bytes, in $(find "$WORK/files" -name "$name.part*" | wc -l | tr -d ' ') parts)")
    continue
  fi
  added+=("$name")
done
[ "${#added[@]}" -gt 0 ] || fail "nothing to put in apps/dist"

# Older builds of this system go: the newest is the one in git.
removed=()
for old in "$DIST"/*; do
  name="$(basename "$old")"
  case "$PLATFORM:$name" in
    windows:Cranium-Setup-*.exe* | windows:Cranium-*-portable.exe* | linux:Cranium-*.AppImage* | linux:cranium_*.deb* | linux:cranium-*.rpm*) ;;
    *) continue ;;
  esac
  keep=0
  for new in "${added[@]}"; do [ "$new" = "$name" ] && keep=1; done
  if [ "$keep" = 0 ]; then rm -f "$old"; removed+=("$name"); fi
done
for name in "${added[@]}"; do mv "$WORK/files/$name" "$DIST/$name"; echo "$PLATFORM: $name"; done

python3 -I "$APPS_DIR/write-dist-index.py" "$DIST"

echo
for name in "${left[@]+"${left[@]}"}"; do
  echo "Left out, over the 100 MB GitHub takes in git: $name. It stays in the run's artifact for 7 days."
done
for name in "${split[@]+"${split[@]}"}"; do
  echo "In parts, as it is over the 100 MB GitHub takes in one file: $name. apps/join-build.sh joins them."
done
echo "Wrote apps/dist/SHA256SUMS and latest.json. To put $PLATFORM $VERSION in git:"
echo
printf '  git add -f --'
for name in "${added[@]}"; do printf ' apps/dist/%s' "$name"; done
printf ' apps/dist/SHA256SUMS apps/dist/latest.json\n'
if [ "${#removed[@]}" -gt 0 ]; then
  printf '  git rm --cached -q --ignore-unmatch --'
  for name in "${removed[@]}"; do printf ' apps/dist/%s' "$name"; done
  printf '\n'
fi
echo "  git commit -m \"Desktop app $VERSION for $PLATFORM in apps/dist\""
