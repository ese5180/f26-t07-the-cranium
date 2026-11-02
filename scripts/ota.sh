#!/usr/bin/env bash
#
# Update the board over the air with what is in binaries/.
#
#   scripts/ota.sh                     install binaries/latest.signed.bin
#   scripts/ota.sh <image>             install that signed image
#   scripts/ota.sh --cloud-only        use no serial port, also if one is there
#   scripts/ota.sh --thing <name>      which board, if the account has more than one
#   scripts/ota.sh --aws               use AWS credentials even if there is an API token
#
# It uploads the image through the console's API, which checks the signature before it
# stores anything, deploys it to the board, and follows the update until the new firmware
# has confirmed itself. The same thing can be done by hand on the console's Firmware page.
# The version must be newer than every release uploaded so far: set it in
# firmware/app/VERSION and build. A build puts its image in binaries/ by itself.
#
# With an API token (made on the console: Developer > API tokens) it needs no AWS
# credentials. The token is taken from CRANIUM_TOKEN, or else from ~/.cranium/console-token,
# which must be a file of your own with mode 600. The script then talks to the console's
# API under /api/t/ with curl, as the token's owner, who has to be a release manager, and
# follows the board through the console alone. The console's address comes from
# CRANIUM_CONSOLE_URL, or else from ConsoleUrl in cloud/.deploy/outputs.json. The token is
# never printed and never put on a command line.
#
# Without a token, the API function is invoked directly with AWS credentials. The board does
# not have to be on USB. With no console found, or with --cloud-only, the update is
# followed through the job and the device shadow with AWS credentials. Firmware from 1.7.2 on starts
# the update by itself. Older firmware, such as the frozen golden image 1.5.0, reports that it waits
# for Button 1: the button is then pressed through the board's development console if it has one, and
# otherwise the script says so and waits for a person. The AWS profile comes from AWS_PROFILE (default
# cranium). The release manager to act as comes from CRANIUM_RELEASE_MANAGER; if it is not set, the
# one active release manager is used, and if there are several the script asks you to choose.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NRFUTIL="${NRFUTIL:-$HOME/.nrfutil/bin/nrfutil}"
NCS_VERSION=v3.4.0
TOKEN_FILE="$HOME/.cranium/console-token"
OUTPUTS="$REPO_DIR/cloud/.deploy/outputs.json"

export AWS_PROFILE="${AWS_PROFILE:-cranium}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

die() {
  printf 'error: %s\n' "$1" >&2
  shift
  if [ $# -gt 0 ]; then
    printf '       %s\n' "$@" >&2
  fi
  exit 1
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

image="$REPO_DIR/binaries/latest.signed.bin"
extra=()
thing=""
cloud_only=no
force_aws=no
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --cloud-only)
      extra+=("--cloud-only")
      cloud_only=yes
      ;;
    --thing)
      [ $# -ge 2 ] || die "--thing needs the board's thing name"
      extra+=("--thing" "$2")
      thing="$2"
      shift
      ;;
    --aws)
      force_aws=yes
      ;;
    -*)
      die "unknown option: $1" "See scripts/ota.sh --help."
      ;;
    *)
      image="$1"
      ;;
  esac
  shift
done

[ -f "$image" ] || die "there is no image at $image" \
  "Build the firmware first: a build stores its signed image in binaries/."

# ---------------------------------------------------------------------------------------
# With an API token: curl to the console's /api/t/, no AWS credentials.
# ---------------------------------------------------------------------------------------

# What the token mode reads and writes as JSON, and the few file checks bash cannot make
# portably. Everything a server or a board said is cut to printable ASCII before it is shown.
read -r -d '' TOKEN_HELPER <<'PY' || true
import base64, json, os, re, stat, sys

def say(value, limit=300):
    text = str(value).lower() if isinstance(value, bool) else str(value)
    return re.sub(r'[^\x20-\x7e]', '?', text).replace('|', '/')[:limit]

def load(path):
    try:
        with open(path, encoding='utf-8') as file:
            return json.load(file)
    except (OSError, ValueError):
        return None

def main(command, *args):
    if command == 'stat':
        # Mode, owner and kind of the file itself, a link not followed; and who runs this.
        info = os.lstat(args[0])
        print(f"{stat.S_IMODE(info.st_mode):o} {info.st_uid} {int(stat.S_ISREG(info.st_mode))} {os.getuid()}")
    elif command == 'outputs':
        data = load(args[0])
        value = data.get('ConsoleUrl') if isinstance(data, dict) else None
        print(value if isinstance(value, str) else '')
    elif command == 'image':
        # The version in the MCUboot header, which is the one the console registers, and the
        # body of the upload.
        path, out = args
        with open(path, 'rb') as file:
            data = file.read()
        if len(data) < 32 or int.from_bytes(data[0:4], 'little') != 0x96F3B83D:
            sys.exit(2)
        version = f"{data[20]}.{data[21]}.{int.from_bytes(data[22:24], 'little')}+{int.from_bytes(data[24:28], 'little')}"
        name = re.sub(r'[^A-Za-z0-9._-]', '-', os.path.basename(path))[:64] or 'cranium.signed.bin'
        with open(out, 'w', encoding='utf-8') as file:
            json.dump({'filename': name, 'notes': 'Uploaded by scripts/ota.sh with an API token',
                       'data': base64.b64encode(data).decode('ascii')}, file)
        print(version)
    elif command == 'deploy-body':
        version, thing, out = args
        with open(out, 'w', encoding='utf-8') as file:
            json.dump({'version': version, 'things': [thing], 'note': 'scripts/ota.sh'}, file)
    elif command == 'field':
        data = load(args[0])
        for part in args[1].split('.'):
            data = data.get(part) if isinstance(data, dict) else None
        print('' if data is None or isinstance(data, (dict, list)) else say(data))
    elif command == 'error':
        data = load(args[0])
        error = data.get('error') if isinstance(data, dict) else None
        if isinstance(error, dict):
            print(f"{say(error.get('message', ''))} ({say(error.get('code', ''), 64)})")
        elif isinstance(data, dict) and isinstance(data.get('message'), str):
            print(f"{say(data['message'])} (from the gateway)")
        else:
            print('an answer the script could not read')
    elif command == 'devices':
        data = load(args[0])
        for device in data.get('devices', []) if isinstance(data, dict) else []:
            name = device.get('thing') if isinstance(device, dict) else None
            if isinstance(name, str) and re.fullmatch(r'cranium-[0-9a-f]{16}', name):
                print(name)
    elif command == 'execution':
        # status|phase|progress|reason|detail|ranAtEnd of one board's part of a deployment.
        data = load(args[0])
        deployment = data.get('deployment') if isinstance(data, dict) else None
        executions = deployment.get('executions', []) if isinstance(deployment, dict) else []
        mine = next((item for item in executions if isinstance(item, dict) and item.get('thing') == args[1]), {})
        fields = [mine.get(key) for key in ('status', 'phase', 'progress', 'reason', 'detail', 'ranAtEnd')]
        print('|'.join('' if value is None else say(value, 96) for value in fields))
    else:
        sys.exit(f'unknown command {command}')

main(*sys.argv[1:])
PY

py() {
  python3 -I -c "$TOKEN_HELPER" "$@"
}

# The token, from the environment or from its file, into `token`; where it came from into
# `token_source`. Refuses a file that someone else could read or replace.
read_token() {
  if [ -n "${CRANIUM_TOKEN:-}" ]; then
    token="$CRANIUM_TOKEN"
    token_source="CRANIUM_TOKEN"
    # Not handed on to curl or python3.
    unset CRANIUM_TOKEN
  else
    local mode owner regular me
    read -r mode owner regular me <<< "$(py stat "$TOKEN_FILE")" ||
      die "$TOKEN_FILE cannot be read"
    [ "$regular" = 1 ] || die "$TOKEN_FILE is not a plain file" "Put the token itself there, not a link."
    [ "$owner" = "$me" ] || die "$TOKEN_FILE belongs to another user" "Make it yours, with mode 600."
    [ "$mode" = 600 ] || die "$TOKEN_FILE can be read or changed by others (mode $mode)" \
      "Make it readable by you alone: chmod 600 $TOKEN_FILE"
    token=""
    IFS= read -r token < "$TOKEN_FILE" || true
    token_source="$TOKEN_FILE"
  fi
  token="${token//[[:space:]]/}"
  [[ "$token" =~ ^crn_[A-Za-z0-9_-]{43}$ ]] || die "the API token in $token_source is not one the console makes" \
    "A token is crn_ and 43 more characters. Make one on the console: Developer > API tokens."
}

# The console's address, without a trailing slash, into `console_url`; curl's protocol
# list into `protocols`. Plain http only for the local preview on this computer.
read_console_url() {
  console_url="${CRANIUM_CONSOLE_URL:-}"
  if [ -z "$console_url" ]; then
    [ -f "$OUTPUTS" ] || die "the console's address is not known" \
      "Set CRANIUM_CONSOLE_URL=https://<console>, or run cloud/deploy.sh, which writes $OUTPUTS."
    console_url="$(py outputs "$OUTPUTS")"
  fi
  console_url="${console_url%/}"
  [[ "$console_url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "not the address of a console: $console_url" \
    "It is https:// and a host name, such as https://console.example.com"
  case "$console_url" in
    https://*) protocols='=https' ;;
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) protocols='=http' ;;
    *) die "the console's address must start with https://: $console_url" ;;
  esac
}

# One request to /api/t/<path>. The answer goes to $reply, its HTTP status to `http_status`
# (000 when there was no answer). The token goes to curl in a file of this run only.
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-q --silent --show-error --proto "$protocols" --max-time 90 --config "$work/auth"
    --output "$reply" --write-out '%{http_code}' --request "$method" --header 'accept: application/json')
  if [ -n "$body" ]; then
    args+=(--header 'content-type: application/json' --data-binary "@$body")
  fi
  : > "$reply"
  http_status="$(curl "${args[@]}" "$console_url/api/t$path" 2> "$work/curl.err")" || http_status=000
}

refused() {
  local what="$1"
  case "$http_status" in
    000) die "$what: the console at $console_url could not be reached" "$(tr -cd '\40-\176' < "$work/curl.err" | head -c 300)" ;;
    401) die "$what: the console did not accept the API token" \
      "It is unknown, revoked or expired. Make a new one on the console: Developer > API tokens." ;;
    *) die "$what: the console answered $http_status" "$(py error "$reply")" ;;
  esac
}

token_update() {
  command -v curl > /dev/null || die "curl was not found"
  command -v python3 > /dev/null || die "python3 was not found"
  read_token
  read_console_url
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  reply="$work/reply.json"
  (umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$token" > "$work/auth")
  token=""

  local poll="${CRANIUM_POLL_SECONDS:-4}" follow="${CRANIUM_FOLLOW_SECONDS:-1800}"
  [[ "$poll" =~ ^[1-9][0-9]?$ ]] || die "CRANIUM_POLL_SECONDS must be 1 to 99 seconds"
  [[ "$follow" =~ ^[1-9][0-9]{0,4}$ ]] || die "CRANIUM_FOLLOW_SECONDS must be a number of seconds"

  echo "Using the API token from $token_source with $console_url, no AWS credentials."
  if [ "$cloud_only" = yes ]; then
    echo "(--cloud-only is what this mode always does: the board is followed through the console.)"
  fi

  api GET /me
  [ "$http_status" = 200 ] || refused "the token could not be checked"
  local who can_write
  who="$(py field "$reply" email)"
  can_write="$(py field "$reply" canWrite)"
  [ "$can_write" = true ] || die "the token's owner${who:+, $who,} is not a release manager now, so it can only read"

  local version
  version="$(py image "$image" "$work/upload.json")" || die "$image is not a signed MCUboot image"

  if [ -z "$thing" ]; then
    api GET /devices
    [ "$http_status" = 200 ] || refused "the boards could not be listed"
    local boards
    boards="$(py devices "$reply")"
    case "$(printf '%s' "$boards" | grep -c . || true)" in
      1) thing="$boards" ;;
      0) die "the console has no board registered" ;;
      *) die "the console has several boards: say which with --thing <name>" "$(printf '%s' "$boards" | tr '\n' ' ')" ;;
    esac
  fi
  [[ "$thing" =~ ^cranium-[0-9a-f]{16}$ ]] || die "not a board name: $thing" "A board is cranium- and 16 hex digits."

  echo "Installing $image ($version) on $thing, as ${who:-the owner of the token}"
  api POST /firmware "$work/upload.json"
  if [ "$http_status" = 201 ]; then
    echo "Uploaded release $version; the console checked its signature."
  elif [ "$http_status" = 409 ] && [ "$(py field "$reply" error.code)" = version_exists ]; then
    echo "Release $version is registered already."
  else
    refused "the upload of $version was refused"
  fi

  py deploy-body "$version" "$thing" "$work/deploy.json"
  api POST /deployments "$work/deploy.json"
  [ "$http_status" = 201 ] || refused "the deployment of $version was refused"
  local job
  job="$(py field "$reply" deployment.id)"
  [[ "$job" =~ ^cranium-[A-Za-z0-9-]{1,56}$ ]] || die "the console's answer named no deployment"
  echo "Deployment $job created: $console_url/#/deployments/$job"

  local deadline last="" asked=no misses=0 line state phase progress reason detail ran
  deadline=$(( $(date +%s) + follow ))
  while :; do
    api GET "/deployments/$job"
    case "$http_status" in
      200) misses=0 ;;
      401|403) refused "following $job" ;;
      *)
        misses=$((misses + 1))
        [ "$misses" -lt 5 ] || refused "following $job"
        sleep "$poll"
        continue
        ;;
    esac
    IFS='|' read -r state phase progress reason detail ran <<< "$(py execution "$reply" "$thing")"
    line="${state:-unknown} ${phase:-} ${progress:-}"
    if [ "$line" != "$last" ]; then
      printf '%s  %s: %s%s\n' "$(date +%H:%M:%S)" "$thing" "${phase:-${state:-not listed yet}}" "${progress:+ ($progress %)}"
      last="$line"
    fi
    if [ "$phase" = waiting_for_button ] && [ "$asked" = no ]; then
      echo "THE FIRMWARE ON THE BOARD WAITS FOR BUTTON 1: PRESS IT ON THE BOARD NOW."
      asked=yes
    fi
    case "$state" in
      SUCCEEDED)
        echo "Done: $thing installed $version${ran:+ and reported running $ran}."
        exit 0
        ;;
      FAILED|REJECTED|CANCELED|TIMED_OUT|REMOVED)
        die "the update ended $state${phase:+ ($phase)}${reason:+: $reason}${detail:+, $detail}" \
          "See $console_url/#/deployments/$job"
        ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || die "the update has not finished after $follow s; it goes on without this script" \
      "Follow it at $console_url/#/deployments/$job, or cancel it there."
    sleep "$poll"
  done
}

if [ "$force_aws" = no ] && { [ -n "${CRANIUM_TOKEN:-}" ] || [ -e "$TOKEN_FILE" ] || [ -L "$TOKEN_FILE" ]; }; then
  token_update
fi

# ---------------------------------------------------------------------------------------
# With AWS credentials: invoke the API function directly (firmware/tests/hil/ota_bench.py).
# ---------------------------------------------------------------------------------------

who="${CRANIUM_RELEASE_MANAGER:-}"
if [ -z "$who" ]; then
  who="$("$REPO_DIR/cloud/users.sh" list | awk '$2 == "release-manager" && $3 == "active" { print $1 }')"
fi
case "$who" in
  "") die "no active release manager: finish a first sign-in to the console" ;;
  *[[:space:]]*) die "there are several active release managers" \
    "Say which one with CRANIUM_RELEASE_MANAGER=<email> scripts/ota.sh" ;;
esac

[ -x "$NRFUTIL" ] || die "nrfutil was not found at $NRFUTIL" "Set NRFUTIL to where it is."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$NRFUTIL" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh > "$work/env.sh"
# shellcheck disable=SC1091
. "$work/env.sh"
export ZEPHYR_BASE="${ZEPHYR_BASE:-/opt/nordic/ncs/$NCS_VERSION/zephyr}"

echo "Installing $image, acting as $who"
exec python3 "$REPO_DIR/firmware/tests/hil/ota_bench.py" update "$image" \
  --via api --as "$who" ${extra[@]+"${extra[@]}"}
