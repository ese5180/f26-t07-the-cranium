#!/usr/bin/env bash
#
# Publish the iPhone app on the console, where every member's SideStore source lists it (docs/mobile-apps.md,
# "Updates on every phone"). build-ipa.sh --publish runs this after a build; it can also be run by hand.
#
#   apps/ios/scripts/publish.sh                                  apps/dist/cranium-ios-<version>.ipa
#   apps/ios/scripts/publish.sh apps/dist/cranium-ios-0.6.0.ipa   that IPA
#
# The version is the one in the IPA's name, which build-ipa.sh gives it, and the IPA's own Info.plist must say
# it too; the build (CFBundleVersion) is read from there. The note is the first paragraph of the version's entry
# in apps/ios/CHANGELOG.md, which must have one. The console checks the IPA again once it has it: its bundle ID,
# version and build, and that its configuration is that console's.
#
# An IPA is too big for API Gateway, so it goes to S3 directly: the console hands out a URL for exactly this size
# and SHA-256, good for 15 minutes; curl sends the file with it; then the console checks what arrived and
# publishes it. A version is published once and only upward, by version and by build. One that is already there
# with the same bytes counts as published; with other bytes it is an error.
#
# The token comes from CRANIUM_TOKEN, or else from ~/.cranium/console-token, a plain file of your own with mode
# 600. Its owner must be a release manager. The console's address comes from CRANIUM_CONSOLE_URL, or else from
# ConsoleUrl in cloud/.deploy/outputs.json. Neither the token nor the upload URL is ever printed or put on a
# command line.
#
# Exit status: 0 published or already there, 1 refused or failed, 2 no token, so nothing was tried.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/../.." && pwd)"
TOKEN_FILE="$HOME/.cranium/console-token"
OUTPUTS="$REPO_DIR/cloud/.deploy/outputs.json"
CHANGELOG="$IOS_DIR/CHANGELOG.md"

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

ipa=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" "See apps/ios/scripts/publish.sh --help." ;;
    *) [ -z "$ipa" ] || die "one IPA at a time"; ipa="$1"; shift ;;
  esac
done

command -v curl > /dev/null || die "curl was not found"
command -v python3 > /dev/null || die "python3 was not found"

if [ -z "$ipa" ]; then
  marketing="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([0-9.]*\)"\{0,1\} *$/\1/p' "$IOS_DIR/project.yml" | head -n 1)"
  ipa="$REPO_DIR/apps/dist/cranium-ios-$marketing.ipa"
fi
[ -f "$ipa" ] || die "no IPA at $ipa" "Build it with apps/ios/scripts/build-ipa.sh."

read -r -d '' HELPER <<'PY' || true
import hashlib, json, os, plistlib, re, stat, sys, zipfile

def say(value, limit=300):
    return re.sub(r'[^\x20-\x7e]', '?', str(value))[:limit]

def load(path):
    try:
        with open(path, encoding='utf-8') as file:
            return json.load(file)
    except (OSError, ValueError):
        return None

def entry(path, version):
    """The first paragraph of the version's entry in the changelog, on one line, or ''."""
    try:
        with open(path, encoding='utf-8') as file:
            text = file.read()
    except OSError:
        return ''
    found = re.search(r'^## ' + re.escape(version) + r'[ \t]*\n\s*\n(.*?)(?:\n[ \t]*\n|\n## |\Z)', text, re.S | re.M)
    return ' '.join(found.group(1).split()) if found else ''

command, *args = sys.argv[1:]
if command == 'stat':
    info = os.lstat(args[0])
    print(f"{stat.S_IMODE(info.st_mode):o} {info.st_uid} {int(stat.S_ISREG(info.st_mode))} {os.getuid()}")
elif command == 'outputs':
    data = load(args[0])
    value = data.get('ConsoleUrl') if isinstance(data, dict) else None
    print(value if isinstance(value, str) else '')
elif command == 'note':
    print(say(entry(args[0], args[1]), 500))
elif command == 'info':
    # What the IPA says of itself: its bundle ID, version and build, from Payload/<Name>.app/Info.plist.
    try:
        with zipfile.ZipFile(args[0]) as archive:
            names = [n for n in archive.namelist() if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', n)]
            if len(names) != 1:
                sys.exit('it is not an IPA of one app')
            info = plistlib.loads(archive.read(names[0]))
            example = any(n.endswith('.app/cranium.example.json') for n in archive.namelist())
    except (OSError, zipfile.BadZipFile, plistlib.InvalidFileException, ValueError) as error:
        sys.exit('it cannot be read as an IPA: ' + say(error, 120))
    values = [info.get(key) for key in ('CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion')]
    if not all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9.-]{1,155}', value) for value in values):
        sys.exit('its Info.plist has no bundle ID, version and build')
    print(*values, 'example' if example else 'configured')
elif command == 'body':
    # The description of the IPA, for both calls: the first with the version, the second without it.
    path, version, build, note, first, second = args
    digest, size = hashlib.sha256(), 0
    with open(path, 'rb') as file:
        for chunk in iter(lambda: file.read(1 << 20), b''):
            digest.update(chunk)
            size += len(chunk)
    described = {'buildVersion': build, 'sha256': digest.hexdigest(), 'size': size, 'notes': note}
    with open(first, 'w', encoding='utf-8') as file:
        json.dump({'version': version, **described}, file)
    with open(second, 'w', encoding='utf-8') as file:
        json.dump(described, file)
    print(digest.hexdigest(), size)
elif command == 'upload':
    # The URL and the headers S3 takes the file with, as a curl configuration: never on a command line.
    reply, console_url, out = args
    data = load(reply)
    upload = data.get('upload') if isinstance(data, dict) else None
    url = upload.get('url') if isinstance(upload, dict) else None
    headers = upload.get('headers') if isinstance(upload, dict) else None
    if not isinstance(url, str) or not isinstance(headers, dict):
        sys.exit('the console gave no upload URL')
    local = re.fullmatch(r'http://(?:127\.0\.0\.1|localhost)(?::\d{1,5})?', console_url)
    if not (re.fullmatch(r'https://[a-z0-9.-]+\.amazonaws\.com/apps/ios/[A-Za-z0-9._-]+\.ipa\?[\x21-\x7e]+', url)
            or (local and url.startswith(console_url + '/'))):
        sys.exit('the upload URL is not one of S3: ' + say(url.split('?')[0].split('/')[-1], 120))
    lines = [f'url = "{url}"']
    for name, value in headers.items():
        if not re.fullmatch(r'[a-z0-9-]{1,64}', str(name)) or not re.fullmatch(r'[\x20-\x7e]{1,200}', str(value)) or '"' in str(value):
            sys.exit('the console asked for a header the script does not send: ' + say(name, 64))
        # curl works out content-length from the file itself, and sends that.
        if name != 'content-length':
            lines.append(f'header = "{name}: {value}"')
    with open(out, 'w', encoding='utf-8') as file:
        file.write('\n'.join(lines) + '\n')
elif command == 'published':
    # The SHA-256 of a version already on the console, from GET /api/apps, or ''.
    data = load(args[0])
    releases = ((data or {}).get('ios') or {}).get('releases') if isinstance(data, dict) else None
    match = [r for r in releases or [] if isinstance(r, dict) and r.get('version') == args[1]]
    value = match[0].get('sha256') if match else None
    print(value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) else '')
elif command == 'code':
    data = load(args[0])
    error = data.get('error') if isinstance(data, dict) else None
    print(say(error.get('code', ''), 64) if isinstance(error, dict) else '')
elif command == 'error':
    data = load(args[0])
    error = data.get('error') if isinstance(data, dict) else None
    if isinstance(error, dict):
        print(f"{say(error.get('message', ''))} ({say(error.get('code', ''), 64)})")
    elif isinstance(data, dict) and isinstance(data.get('message'), str):
        print(f"{say(data['message'])} (from the gateway)")
    else:
        print('an answer the script could not read')
elif command == 's3error':
    try:
        with open(args[0], encoding='utf-8', errors='replace') as file:
            found = re.search(r'<Code>([A-Za-z]{1,64})</Code>', file.read())
    except OSError:
        found = None
    print(found.group(1) if found else 'no reason given')
PY

py() {
  python3 -I -c "$HELPER" "$@"
}

# The version, from the IPA's name, and what the IPA says of itself.
name="$(basename "$ipa")"
[[ "$name" =~ ^cranium-ios-([0-9]+\.[0-9]+\.[0-9]+)\.ipa$ ]] \
  || die "$name is not named as build-ipa.sh names an IPA: cranium-ios-<version>.ipa"
version="${BASH_REMATCH[1]}"
described="$(py info "$ipa")" || die "$name: see above"
read -r bundle_id own_version build configured <<< "$described"
[ "$bundle_id" = com.craniumiot.cranium ] || die "$name is the app $bundle_id, not com.craniumiot.cranium"
[ "$own_version" = "$version" ] || die "$name says it is version $own_version in its Info.plist"
[[ "$build" =~ ^[1-9][0-9]{0,9}$ ]] || die "$name has the build $build, which is not a whole number"
[ "$configured" = configured ] || die "$name has the example configuration and could not sign in" "Run apps/configure.sh, then build again."

note="$(py note "$CHANGELOG" "$version")"
[ -n "$note" ] || die "apps/ios/CHANGELOG.md has no entry for $version" \
  "Add one at the top, its first paragraph saying what changed (docs/versions.md), then publish."

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
  echo "Not published: no API token. Make one on the console (Developer > API tokens), and keep it in" >&2
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
[[ "$console_url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "CRANIUM_CONSOLE_URL is not the address of a console"
case "$console_url" in
  https://*) protocols='=https' ;;
  http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) protocols='=http' ;;
  *) die "the console's address must start with https://" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$token" > "$work/auth")
token=""
reply="$work/reply.json"

digest_and_size="$(py body "$ipa" "$version" "$build" "$note" "$work/start.json" "$work/finish.json")" || die "$ipa cannot be read"
read -r sha256 size <<< "$digest_and_size"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-q --silent --show-error --proto "$protocols" --max-redirs 0 --max-time 120 --config "$work/auth"
    --output "$reply" --write-out '%{http_code}' --request "$method" --header 'accept: application/json')
  [ -z "$body" ] || args+=(--header 'content-type: application/json' --data-binary "@$body")
  : > "$reply"
  http_status="$(curl "${args[@]}" "$console_url/api/t$path" 2> "$work/curl.err")" || http_status=000
}

# A version the console has already: published, if it is these same bytes.
already_there() {
  api GET /apps
  if [ "$http_status" = 200 ] && [ "$(py published "$reply" "$version")" = "$sha256" ]; then
    echo "iPhone app $version is on the console already, with these same bytes."
    exit 0
  fi
  die "the console has iPhone app $version already, with other bytes" \
    "A version is published once. Raise MARKETING_VERSION and CURRENT_PROJECT_VERSION, add its changelog entry, and build again."
}

refused() {
  case "$http_status" in
    000) die "the console could not be reached" "$(tr -cd '\40-\176' < "$work/curl.err" | sed 's#https\{0,1\}://[^ ]*#<address>#g' | head -c 300)" ;;
    401) die "the console did not accept the API token" \
      "It is unknown, revoked or expired. Make a new one on the console: Developer > API tokens." ;;
    *) die "the console refused to publish $version ($http_status)" "$(py error "$reply")" ;;
  esac
}

echo "Publishing iPhone app $version (build $build, $size bytes) on the console."
api POST /apps/ios/uploads "$work/start.json"
case "$http_status" in
  201) ;;
  409) [ "$(py code "$reply")" = version_exists ] && already_there; refused ;;
  *) refused ;;
esac

# The file, straight to S3, with exactly the headers the URL was signed for.
(umask 077 && py upload "$reply" "$console_url" "$work/s3") || die "the console's answer could not be used"
s3_status="$(curl -q --silent --show-error --proto "$protocols" --max-redirs 0 --max-time 900 --config "$work/s3" \
  --upload-file "$ipa" --output "$work/s3.reply" --write-out '%{http_code}' 2> "$work/curl.err")" || s3_status=000
case "$s3_status" in
  200) ;;
  000) die "the IPA could not be sent to S3" "$(tr -cd '\40-\176' < "$work/curl.err" | sed 's#https\{0,1\}://[^ ]*#<address>#g' | head -c 300)" ;;
  *) die "S3 refused the IPA ($s3_status, $(py s3error "$work/s3.reply"))" \
    "The upload URL is good for 15 minutes; run apps/ios/scripts/publish.sh again for a new one." ;;
esac

api POST "/apps/ios/releases/$version" "$work/finish.json"
case "$http_status" in
  201)
    echo "Published iPhone app $version. Every member's SideStore source lists it now."
    exit 0 ;;
  409) [ "$(py code "$reply")" = version_exists ] && already_there; refused ;;
  *) refused ;;
esac
