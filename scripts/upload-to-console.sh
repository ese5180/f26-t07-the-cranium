#!/usr/bin/env bash
#
# Upload a signed firmware image to the console's Firmware page with an API token. It only uploads:
# no board gets it until a person deploys it on the console. scripts/build.sh runs this after every
# build; it can also be run by hand.
#
#   scripts/upload-to-console.sh                                     binaries/latest.signed.bin
#   scripts/upload-to-console.sh binaries/cranium-1.11.4-0.signed.bin  that image
#   scripts/upload-to-console.sh <image> "notes for the release"
#
# The release's note is the first paragraph of the version's entry in firmware/CHANGELOG.md, with the
# note given here after it in brackets (scripts/build.sh gives the commit it built from). A version with
# no entry there gets the subjects of the firmware commits since the version before it instead.
#
# The token comes from CRANIUM_TOKEN, or else from ~/.cranium/console-token, which must be a plain file
# of your own with mode 600. Make one on the console under Developer > API tokens; an upload-only token
# is enough and is the safest. Its owner must be a release manager. The console's address comes from
# CRANIUM_CONSOLE_URL, or else from ConsoleUrl in cloud/.deploy/outputs.json.
#
# The console checks the signature itself and registers a version once. A version that is already
# there with the same bytes counts as uploaded; with other bytes it is an error. The token is never
# printed and never put on a command line.
#
# Exit status: 0 uploaded or already there, 1 refused or failed, 2 no token, so nothing was tried.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="$HOME/.cranium/console-token"
OUTPUTS="$REPO_DIR/cloud/.deploy/outputs.json"

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

case "${1:-}" in
  -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

image="${1:-$REPO_DIR/binaries/latest.signed.bin}"
notes="${2:-Uploaded by scripts/upload-to-console.sh}"
[ -f "$image" ] || die "no image at $image"
command -v curl > /dev/null || die "curl was not found"
command -v python3 > /dev/null || die "python3 was not found"

read -r -d '' HELPER <<'PY' || true
import base64, hashlib, json, os, re, stat, sys

def say(value, limit=300):
    return re.sub(r'[^\x20-\x7e]', '?', str(value))[:limit]

def load(path):
    try:
        with open(path, encoding='utf-8') as file:
            return json.load(file)
    except (OSError, ValueError):
        return None

def entry(repo, version):
    """The first paragraph of the version's entry in firmware/CHANGELOG.md, on one line, or ''."""
    try:
        with open(os.path.join(repo, 'firmware', 'CHANGELOG.md'), encoding='utf-8') as file:
            text = file.read()
    except OSError:
        return ''
    found = re.search(r'^## ' + re.escape(version) + r'\s*\n\s*\n(.*?)(?:\n\s*\n|\Z)', text, re.S | re.M)
    return ' '.join(found.group(1).split()) if found else ''

def since_last(repo, version):
    """The subjects of the firmware commits since the commit that set the version before this one."""
    import subprocess
    def git(*words):
        return subprocess.run(['git', '-C', repo, *words], capture_output=True, text=True, timeout=20).stdout
    try:
        previous = None
        for commit in git('log', '--format=%H', '--', 'firmware/app/VERSION').split():
            fields = dict(re.findall(r'^(VERSION_MAJOR|VERSION_MINOR|PATCHLEVEL) = (\d+)',
                                     git('show', f'{commit}:firmware/app/VERSION'), re.M))
            if len(fields) == 3 and f"{fields['VERSION_MAJOR']}.{fields['VERSION_MINOR']}.{fields['PATCHLEVEL']}" != version:
                previous = commit
                break
        if previous is None:
            return ''
        subjects = [line for line in git('log', '--format=%s', f'{previous}..HEAD', '--', 'firmware').splitlines() if line]
    except (OSError, subprocess.SubprocessError):
        return ''
    return ('Changes: ' + '; '.join(subjects))[:440] if subjects else ''

def changed(repo, version):
    return entry(repo, version) or since_last(repo, version)

command, *args = sys.argv[1:]
if command == 'stat':
    info = os.lstat(args[0])
    print(f"{stat.S_IMODE(info.st_mode):o} {info.st_uid} {int(stat.S_ISREG(info.st_mode))} {os.getuid()}")
elif command == 'outputs':
    data = load(args[0])
    value = data.get('ConsoleUrl') if isinstance(data, dict) else None
    print(value if isinstance(value, str) else '')
elif command == 'body':
    # The version in the MCUboot header, the file's SHA-256, and the body of the upload.
    path, notes, out, repo = args
    with open(path, 'rb') as file:
        data = file.read()
    if len(data) < 32 or int.from_bytes(data[0:4], 'little') != 0x96F3B83D:
        sys.exit(2)
    version = f"{data[20]}.{data[21]}.{int.from_bytes(data[22:24], 'little')}+{int.from_bytes(data[24:28], 'little')}"
    name = re.sub(r'[^A-Za-z0-9._-]', '-', os.path.basename(path))[:64] or 'cranium.signed.bin'
    what = changed(repo, version.split('+')[0])
    note = f"{what} ({notes})" if what and notes else (what or notes)
    if len(note) > 500 and what:
        # The entry is what matters; the bracketed note is cut first.
        note = what[:500] if len(what) + 4 > 500 else f"{what} ({notes[:500 - len(what) - 4]})"
    with open(out, 'w', encoding='utf-8') as file:
        json.dump({'filename': name, 'notes': say(note, 500),
                   'data': base64.b64encode(data).decode('ascii')}, file)
    print(version, hashlib.sha256(data).hexdigest())
elif command == 'sha256':
    data = load(args[0])
    release = data.get('release') if isinstance(data, dict) else None
    value = release.get('sha256') if isinstance(release, dict) else None
    print(value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) else '')
elif command == 'error':
    data = load(args[0])
    error = data.get('error') if isinstance(data, dict) else None
    if isinstance(error, dict):
        print(f"{say(error.get('message', ''))} ({say(error.get('code', ''), 64)})")
    elif isinstance(data, dict) and isinstance(data.get('message'), str):
        print(f"{say(data['message'])} (from the gateway)")
    else:
        print('an answer the script could not read')
    print(say(error.get('code', ''), 64) if isinstance(error, dict) else '', file=sys.stderr)
PY

py() {
  python3 -I -c "$HELPER" "$@"
}

# The token, from the environment or from its file.
if [ -n "${CRANIUM_TOKEN:-}" ]; then
  token="$CRANIUM_TOKEN"
  source_name="CRANIUM_TOKEN"
  unset CRANIUM_TOKEN
elif [ -e "$TOKEN_FILE" ]; then
  read -r mode owner regular me <<< "$(py stat "$TOKEN_FILE")" || die "$TOKEN_FILE cannot be read"
  [ "$regular" = 1 ] || die "$TOKEN_FILE is not a plain file" "Put the token itself there, not a link."
  [ "$owner" = "$me" ] || die "$TOKEN_FILE belongs to another user" "Make it yours, with mode 600."
  [ "$mode" = 600 ] || die "$TOKEN_FILE can be read or changed by others (mode $mode)" \
    "Make it readable by you alone: chmod 600 $TOKEN_FILE"
  token=""
  IFS= read -r token < "$TOKEN_FILE" || true
  source_name="$TOKEN_FILE"
else
  echo "Not uploaded: no API token. Make one on the console (Developer > API tokens), and keep it in" >&2
  echo "$TOKEN_FILE with mode 600, or set CRANIUM_TOKEN." >&2
  exit 2
fi
token="${token//[[:space:]]/}"
[[ "$token" =~ ^crn_[A-Za-z0-9_-]{43}$ ]] || die "the API token in $source_name is not one the console makes" \
  "A token is crn_ and 43 more characters. Make one on the console: Developer > API tokens."

# The console's address. Plain http only for the local preview on this computer.
console_url="${CRANIUM_CONSOLE_URL:-}"
if [ -z "$console_url" ]; then
  [ -f "$OUTPUTS" ] || die "the console's address is not known" \
    "Set CRANIUM_CONSOLE_URL=https://<console>, or run cloud/deploy.sh, which writes $OUTPUTS."
  console_url="$(py outputs "$OUTPUTS")"
fi
console_url="${console_url%/}"
[[ "$console_url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "not the address of a console: $console_url"
case "$console_url" in
  https://*) protocols='=https' ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) protocols='=http' ;;
  *) die "the console's address must start with https://: $console_url" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$token" > "$work/auth")
token=""
reply="$work/reply.json"

read -r version sha256 <<< "$(py body "$image" "$notes" "$work/body.json" "$REPO_DIR")" \
  || die "$image is not an MCUboot image"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-q --silent --show-error --proto "$protocols" --max-redirs 0 --max-time 120 --config "$work/auth"
    --output "$reply" --write-out '%{http_code}' --request "$method" --header 'accept: application/json')
  [ -z "$body" ] || args+=(--header 'content-type: application/json' --data-binary "@$body")
  : > "$reply"
  http_status="$(curl "${args[@]}" "$console_url/api/t$path" 2> "$work/curl.err")" || http_status=000
}

echo "Uploading firmware $version to the console."
api POST /firmware "$work/body.json"
case "$http_status" in
  201)
    echo "Uploaded release $version. It is on the console's Firmware page; no board gets it until it is deployed."
    exit 0 ;;
  000)
    die "the console at $console_url could not be reached" "$(tr -cd '\40-\176' < "$work/curl.err" | head -c 300)" ;;
  401)
    die "the console did not accept the API token" \
      "It is unknown, revoked or expired. Make a new one on the console: Developer > API tokens." ;;
  409)
    # Already registered: only the same bytes count as uploaded.
    encoded="$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$version")"
    api GET "/firmware/$encoded"
    if [ "$http_status" = 200 ] && [ "$(py sha256 "$reply")" = "$sha256" ]; then
      echo "Release $version is already on the console, with these same bytes."
      exit 0
    fi
    die "the console already has a release $version, with other bytes" \
      "A version is registered once. Build again: scripts/build.sh takes the next version." ;;
  *)
    die "the console refused the upload ($http_status)" "$(py error "$reply" 2> /dev/null)" ;;
esac
