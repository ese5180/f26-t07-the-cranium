#!/usr/bin/env bash
#
# Set up a new board, from out of the box to online on the console, in one guided run.
#
#   scripts/new-board.sh check                what this computer still needs, and how to get each thing
#   scripts/new-board.sh                      set up the one board plugged in by USB (the same as: setup)
#   scripts/new-board.sh --dry-run            print every command of the setup, and run none of them
#   scripts/new-board.sh status [<serial>]    one screen on a board: its serial console, and the console's view
#   scripts/new-board.sh list                 the boards plugged in, with their serial numbers
#
# Setup takes the board through these steps, each of which says what it does, checks what it did, and
# can be run again on its own. An nRF5340 DK has no golden image, so it has no golden step.
#
#   build      scripts/build.sh --keep --no-upload: the bootloader, TF-M with the application and the
#              network core's Bluetooth controller, signed with your key. binaries/ is left as it was
#   flash      west flash --recover: ERASES the whole board, then writes all of that. It starts in factory mode
#   golden     tools/golden.py restore puts the golden image on, and you seal it with the gesture (nRF7002 DK)
#   release    tools/recover.py upload: the newest release for the board's type, from the console or binaries/
#   provision  tools/provision_device.py: device ID; Wi-Fi network, key and certificate (nRF7002 DK) or
#              Bluetooth passkey (nRF5340 DK); the thing in AWS IoT
#   verify     what the board's console says, the console's view of it, and Bluetooth (nRF5340 DK)
#
# Options of setup:
#   --serial-number <n>   which board, when more than one is plugged in: the debugger's serial number
#   --board <type>        nrf7002dk or nrf5340dk, when the debugger does not say which DK it is
#   --from <step>         start at that step, after it stopped there; --resume starts after the last one done
#   --only <step>         run that one step
#   --dry-run             print every command, run none, and touch nothing
#   --confirm <digits>    the board's last 4 digits, in place of typing them at the question
#   --image <file>        install this signed image in place of the newest release
#   --id <name>           the device ID (default: the SoC's identifier), for tools/provision_device.py
#   --new-identity        nRF7002 DK: a new key and certificate (tools/provision_device.py --new-identity)
#   --no-register         nRF5340 DK: no passkey of its own (tools/provision_device.py --no-register)
#   --new-passkey         nRF5340 DK: a new passkey (tools/provision_device.py --new-passkey)
#   --port <port>         the board's console port, if the one found is wrong; --log-port, its log port
#   --deep                check: also run scripts/check-west-workspace.sh on the SDK
#
# Before it touches a board it checks this computer, finds the boards, refuses to go on unless exactly one is
# chosen, says which one it is, and asks for the last 4 digits of its serial number. It never makes a signing
# key: a new key would make every board refuse the images signed with it. It prints no secret, Wi-Fi network,
# AWS account, endpoint or bucket. What each step did is kept in build-new-board/<serial>.state.
#
# The SDK is looked for in NCS_DIR (default /opt/nordic/ncs/v3.4.0), nrfutil in NRFUTIL (default
# ~/.nrfutil/bin/nrfutil, or the one on the PATH), and AWS with AWS_PROFILE (default cranium). The console
# token is CRANIUM_TOKEN or ~/.cranium/console-token, as for scripts/ota.sh. docs/new-board-setup.md has the
# same steps by hand, for when one of them fails. On Windows, run this in WSL2 (that document says how).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NCS_VERSION=v3.4.0
# The commit of that tag in sdk-nrf, as NCS_COMMIT in .github/workflows/ci.yml.
NCS_COMMIT=99553055607b2e9885fbc80ccd11fa9da81c2df0
NCS_DIR="${NCS_DIR:-/opt/nordic/ncs/$NCS_VERSION}"
NRFUTIL="${NRFUTIL:-$HOME/.nrfutil/bin/nrfutil}"
if [ ! -x "$NRFUTIL" ] && command -v nrfutil > /dev/null 2>&1; then
  NRFUTIL="$(command -v nrfutil)"
fi
# scripts/build.sh looks for both in these.
export NRFUTIL NCS_DIR
export AWS_PROFILE="${AWS_PROFILE:-cranium}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""

HELPER=tools/new_board.py
STATE_DIR=build-new-board
KEY="$HOME/.cranium/mcuboot_signing_key.pem"
WIFI="$HOME/.cranium/wifi_secrets.h"

MODE=setup
DRY_RUN=false
SERIAL=""
BOARD_TYPE=""
PCA=""
PORT=""
LOG_PORT=""
FROM=""
ONLY=""
RESUME=false
CONFIRM=""
IMAGE=""
DEVICE_ID=""
NO_REGISTER=false
NEW_PASSKEY=false
NEW_IDENTITY=false
DEEP=false
CURRENT_STEP=""
TOOLCHAIN_LOADED=false
CHECK_FAILS=0
CHECK_WARNS=0
CHECKED=" "
LABEL=""
BUILD_NAME=""
STEPS=""
WORK=""

# ---- output ------------------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
ok() { printf '  ok: %s\n' "$*"; }

die() {
  printf 'error: %s\n' "$1" >&2
  shift
  local line
  for line in "$@"; do
    printf '       %s\n' "$line" >&2
  done
  exit 1
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# A command as it would be typed, with each argument quoted where it needs it. A <placeholder> of a dry
# run is shown as it is.
show_cmd() {
  local word
  printf '  $'
  for word in "$@"; do
    case "$word" in
      "<"*">") printf ' %s' "$word" ;;
      *) printf ' %q' "$word" ;;
    esac
  done
  printf '\n'
}

# Show a command, and run it unless this is a dry run.
run() {
  show_cmd "$@"
  [ "$DRY_RUN" = true ] && return 0
  "$@"
}

helper() {
  python3 "$HELPER" "$@"
}

# A path in the home folder as ~/..., to show it.
tilde() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$CURRENT_STEP" ] && [ "$DRY_RUN" = false ]; then
    printf '\nStopped in the %s step. Once that is put right, go on from there:\n' "$CURRENT_STEP" >&2
    printf '  scripts/new-board.sh --from %s%s\n' "$CURRENT_STEP" "${SERIAL:+ --serial-number $SERIAL}" >&2
  fi
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---- arguments ---------------------------------------------------------------------------------

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" "See scripts/new-board.sh --help."
}

absolute() {
  printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
}

case "${1:-}" in
  setup|check|status|list) MODE="$1"; shift ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --serial-number) need_value "$@"; SERIAL="$2"; shift ;;
    --board) need_value "$@"; BOARD_TYPE="$2"; shift ;;
    --from) need_value "$@"; FROM="$2"; shift ;;
    --only) need_value "$@"; ONLY="$2"; shift ;;
    --resume) RESUME=true ;;
    --dry-run) DRY_RUN=true ;;
    --confirm) need_value "$@"; CONFIRM="$2"; shift ;;
    --image)
      need_value "$@"
      [ -f "$2" ] || die "there is no image at $2"
      IMAGE="$(absolute "$2")"
      shift ;;
    --id) need_value "$@"; DEVICE_ID="$2"; shift ;;
    --port) need_value "$@"; PORT="$2"; shift ;;
    --log-port) need_value "$@"; LOG_PORT="$2"; shift ;;
    --no-register) NO_REGISTER=true ;;
    --new-passkey) NEW_PASSKEY=true ;;
    --new-identity) NEW_IDENTITY=true ;;
    --deep) DEEP=true ;;
    -*) die "unknown option: $1" "See scripts/new-board.sh --help." ;;
    *)
      if [ "$MODE" = status ] && [ -z "$SERIAL" ]; then
        SERIAL="$1"
      else
        die "unexpected argument: $1" "See scripts/new-board.sh --help."
      fi ;;
  esac
  shift
done

case "$BOARD_TYPE" in
  ""|nrf7002dk|nrf5340dk) ;;
  *) die "--board takes nrf7002dk or nrf5340dk, not $BOARD_TYPE" ;;
esac
[ -z "$SERIAL" ] || [[ "$SERIAL" =~ ^[0-9]{4,20}$ ]] || die "a serial number is digits, such as 001050797470, not $SERIAL"
modes=0
[ -z "$FROM" ] || modes=$((modes + 1))
[ -z "$ONLY" ] || modes=$((modes + 1))
[ "$RESUME" = false ] || modes=$((modes + 1))
[ "$modes" -le 1 ] || die "use one of --from, --only and --resume"
[ "$NO_REGISTER" = false ] || [ "$NEW_PASSKEY" = false ] || die "--no-register and --new-passkey: pick one"

cd "$REPO_DIR"
WORK="$(mktemp -d)"

# ---- the board and its type --------------------------------------------------------------------

set_board_paths() {
  case "$BOARD_TYPE" in
    nrf7002dk)
      LABEL="nRF7002 DK"
      BUILD_NAME=build
      STEPS="build flash golden release provision verify"
      ;;
    nrf5340dk)
      LABEL="nRF5340 DK"
      BUILD_NAME=build-nrf5340dk
      STEPS="build flash release provision verify"
      ;;
  esac
  if [ "$BOARD_TYPE" = nrf7002dk ] && { [ "$NO_REGISTER" = true ] || [ "$NEW_PASSKEY" = true ]; }; then
    die "--no-register and --new-passkey are for an nRF5340 DK, which has Bluetooth only"
  fi
  if [ "$BOARD_TYPE" = nrf5340dk ] && [ "$NEW_IDENTITY" = true ]; then
    die "--new-identity is for an nRF7002 DK: an nRF5340 DK has no key or certificate in AWS IoT"
  fi
}

# The nRF5340 DK's build and provisioning came with PR #5 (feature/nrf5340dk).
has_nrf5340dk_support() {
  grep -q -- '--board nrf5340dk' scripts/build.sh && grep -q -- '--board nrf5340dk' tools/provision_device.py
}

# So that tools/recover.py and tools/golden.py, which run `nrfutil` from the PATH, find this one.
use_nrfutil_path() {
  if [ -x "$NRFUTIL" ]; then
    case ":$PATH:" in
      *":$(dirname "$NRFUTIL"):"*) ;;
      *) PATH="$(dirname "$NRFUTIL"):$PATH" ;;
    esac
  fi
}

# The SDK's toolchain on the PATH: west, and a Python with pyserial, cbor2 and cryptography.
load_toolchain() {
  [ "$TOOLCHAIN_LOADED" = true ] && return 0
  [ -x "$NRFUTIL" ] || return 1
  if "$NRFUTIL" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh > "$WORK/env.sh" 2> /dev/null; then
    # shellcheck disable=SC1091
    . "$WORK/env.sh"
    export ZEPHYR_BASE="$NCS_DIR/zephyr"
    TOOLCHAIN_LOADED=true
    return 0
  fi
  return 1
}

need_toolchain() {
  load_toolchain || die "the nRF Connect SDK $NCS_VERSION toolchain did not load" \
    "Install it: nrfutil sdk-manager install $NCS_VERSION. Then: scripts/new-board.sh check"
  command -v west > /dev/null || die "the toolchain has no west"
}

# What nrfutil sees of the debuggers plugged in, as JSON, into $WORK/devices.json: once, and empty
# without nrfutil.
read_devices() {
  [ ! -f "$WORK/devices.json" ] || return 0
  : > "$WORK/devices.json"
  [ -x "$NRFUTIL" ] || return 0
  "$NRFUTIL" device list --json > "$WORK/devices.json" 2> /dev/null || true
}

# Exactly one board, into SERIAL, BOARD_TYPE, PCA, PORT and LOG_PORT, or a refusal that says why.
# $1: yes if its debugger must be there (to flash or restart it); $2: yes if its type need not be known.
choose_board() {
  local args=(boards --pick) line found_port found_log
  [ -z "$SERIAL" ] || args+=(--serial-number "$SERIAL")
  [ -z "$BOARD_TYPE" ] || args+=(--board "$BOARD_TYPE")
  [ "$1" = no ] || args+=(--need-debugger)
  [ "${2:-no}" = no ] || args+=(--any-type)
  read_devices
  line="$(helper "${args[@]}" < "$WORK/devices.json")" || exit 1
  IFS='|' read -r SERIAL BOARD_TYPE PCA found_port found_log <<< "$line"
  [ -n "$PORT" ] || PORT="$found_port"
  [ -n "$LOG_PORT" ] || LOG_PORT="$found_log"
}

# ---- what each step left -----------------------------------------------------------------------

state_file() {
  printf '%s/%s.state' "$STATE_DIR" "$SERIAL"
}

state_get() {
  local file
  [ -n "$SERIAL" ] || return 0
  file="$(state_file)"
  [ -f "$file" ] || return 0
  sed -n "s/^$1=//p" "$file" | tail -n 1
}

state_set() {
  [ "$DRY_RUN" = false ] && [ -n "$SERIAL" ] || return 0
  local file
  file="$(state_file)"
  mkdir -p "$STATE_DIR"
  {
    [ ! -f "$file" ] || grep -v "^$1=" "$file" || true
    printf '%s=%s\n' "$1" "$2"
  } > "$file.new"
  mv "$file.new" "$file"
}

# What serial-status last wrote: state, thing name, firmware, board, cloud, bt passkey, bt name, bt window.
said() {
  [ -f "$WORK/status" ] || return 0
  sed -n "s/^$1=//p" "$WORK/status" | head -n 1
}

board_says() {
  helper serial-status --port "$PORT" --record "$WORK/status" "$@"
}

# ---- checks of this computer -------------------------------------------------------------------

pass() { printf '  ok    %s\n' "$1"; }

failed() {
  printf '  FAIL  %s\n' "$1"
  shift
  local line
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
  CHECK_FAILS=$((CHECK_FAILS + 1))
}

warned() {
  printf '  warn  %s\n' "$1"
  shift
  local line
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
  CHECK_WARNS=$((CHECK_WARNS + 1))
}

# Run a check once, however many steps need it.
check_once() {
  local name="$1"
  shift
  case "$CHECKED" in
    *" $name "*) return 0 ;;
  esac
  CHECKED="$CHECKED$name "
  "check_$name" "$@"
}

check_nrfutil() {
  if [ ! -x "$NRFUTIL" ]; then
    failed "nrfutil was not found" \
      "Install nRF Util (https://www.nordicsemi.com/Products/Development-tools/nRF-Util), then:" \
      "nrfutil install device sdk-manager. If it is somewhere else: export NRFUTIL=<its path>"
    return 0
  fi
  local version missing=""
  version="$("$NRFUTIL" --version 2> /dev/null | head -n 1 || true)"
  "$NRFUTIL" device --version > /dev/null 2>&1 || missing="$missing device"
  "$NRFUTIL" sdk-manager --version > /dev/null 2>&1 || missing="$missing sdk-manager"
  if [ -n "$missing" ]; then
    failed "nrfutil has no$missing command" "nrfutil install$missing"
  else
    pass "nrfutil${version:+ ($version)}, with its device and sdk-manager commands"
  fi
}

check_toolchain() {
  if [ ! -d "$NCS_DIR/zephyr" ]; then
    failed "nRF Connect SDK $NCS_VERSION was not found at $NCS_DIR" \
      "nrfutil sdk-manager install $NCS_VERSION (on Linux and in WSL first:" \
      "nrfutil sdk-manager config install-dir set /opt/nordic/ncs), or export NCS_DIR=<where it is>"
    return 0
  fi
  local version commit
  version="$(awk '$1 == "VERSION_MAJOR" { a = $3 } $1 == "VERSION_MINOR" { b = $3 } $1 == "PATCHLEVEL" { c = $3 }
    END { if (a != "") print a "." b "." c }' "$NCS_DIR/nrf/VERSION" 2> /dev/null || true)"
  if [ "$version" != "${NCS_VERSION#v}" ]; then
    failed "the SDK at $NCS_DIR is ${version:-of no version it says}, not ${NCS_VERSION#v}" \
      "nrfutil sdk-manager install $NCS_VERSION, or export NCS_DIR=<where $NCS_VERSION is>"
    return 0
  fi
  commit="$(git -C "$NCS_DIR/nrf" rev-parse HEAD 2> /dev/null || true)"
  if ! load_toolchain; then
    failed "the SDK's toolchain for $NCS_VERSION did not load" "nrfutil sdk-manager install $NCS_VERSION"
    return 0
  fi
  if ! command -v west > /dev/null; then
    failed "the toolchain has no west" "nrfutil sdk-manager install $NCS_VERSION"
    return 0
  fi
  if [ "$commit" = "$NCS_COMMIT" ]; then
    pass "nRF Connect SDK $NCS_VERSION at $NCS_DIR, on the commit CI builds with, and its toolchain"
  else
    pass "nRF Connect SDK $NCS_VERSION at $NCS_DIR, and its toolchain"
    [ -z "$commit" ] || warned "its sdk-nrf is on another commit than CI's ($NCS_COMMIT)" \
      "scripts/new-board.sh check --deep says more"
  fi
  if [ "$DEEP" = true ]; then
    if scripts/check-west-workspace.sh "$NCS_DIR" "$NCS_COMMIT" > "$WORK/workspace.txt" 2>&1; then
      pass "$(tail -n 1 "$WORK/workspace.txt")"
    else
      warned "scripts/check-west-workspace.sh: $(tail -n 1 "$WORK/workspace.txt")" \
        "A build may still work; CI's SDK is exactly the tag's"
    fi
  fi
}

check_python() {
  if ! command -v python3 > /dev/null; then
    failed "python3 was not found" "Install Python 3.10 or later, or let this script use the SDK's: install the SDK"
    return 0
  fi
  if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2> /dev/null; then
    failed "$(python3 --version 2>&1) is too old: the tools need Python 3.10 or later" \
      "Install a newer one, or the SDK's toolchain, which has one"
    return 0
  fi
  local missing answer
  missing="$(helper pydeps || true)"
  if [ -n "$missing" ] && [ "$MODE" = check ] && [ -t 0 ]; then
    printf '        Python lacks %s. Install them now: python3 -m pip install -r tools/requirements.txt? [y/N] ' "$missing"
    IFS= read -r answer || answer=""
    case "$answer" in
      y|Y|yes) python3 -m pip install -r tools/requirements.txt || true
               missing="$(helper pydeps || true)" ;;
    esac
  fi
  if [ -n "$missing" ]; then
    failed "$(python3 --version 2>&1) has no $missing, which the tools need" \
      "python3 -m pip install -r tools/requirements.txt, best in a virtual environment:" \
      "python3 -m venv ~/.venvs/cranium && . ~/.venvs/cranium/bin/activate first. The SDK's toolchain has them all"
  else
    pass "$(python3 --version 2>&1), with pyserial, cbor2 and cryptography"
  fi
}

check_boards() {
  local listing jlink="" candidate
  for candidate in "$(command -v JLinkExe 2> /dev/null || true)" /Applications/SEGGER/JLink*/JLinkExe \
      /opt/SEGGER/JLink*/JLinkExe; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      jlink="$candidate"
      break
    fi
  done
  if [ -n "$jlink" ]; then
    pass "SEGGER's J-Link software"
  else
    warned "SEGGER's J-Link software was not found" \
      "nrfutil talks to the board's debugger through it: https://www.segger.com/downloads/jlink/"
  fi
  command -v python3 > /dev/null || return 0
  read_devices
  listing="$(helper boards < "$WORK/devices.json" 2> /dev/null || true)"
  case "$listing" in
    *"no board is plugged in"*|"")
      warned "no board is plugged in" "Plug the DK in by its debug USB port (J2) and switch it on" ;;
    *)
      pass "boards plugged in (nrfutil device list and the serial ports):"
      printf '%s\n' "$listing" | sed 's/^/      /' ;;
  esac
}

check_key() {
  if [ ! -f "$KEY" ]; then
    failed "no signing key at ~/.cranium/mcuboot_signing_key.pem" \
      "Get the team's key from its custodian (secrets/README.md), put it there, and chmod 600 it." \
      "Never make a new one with tools/keys.py generate: no board would take an image signed with it."
    return 0
  fi
  # The group's and others' permissions, of -rw-------.
  if [ "$(ls -ln "$KEY" | cut -c5-10)" != "------" ]; then
    warned "the signing key can be read by others" "chmod 600 ~/.cranium/mcuboot_signing_key.pem"
  fi
  if python3 tools/keys.py check > "$WORK/keys.txt" 2>&1; then
    pass "the signing key matches firmware/keys/fw_signing_pub.pem"
  elif grep -q "No module named" "$WORK/keys.txt"; then
    warned "the signing key is there, and could not be compared with firmware/keys/fw_signing_pub.pem" \
      "That takes the Python package cryptography: python3 -m pip install -r tools/requirements.txt"
  else
    failed "the signing key at ~/.cranium/mcuboot_signing_key.pem is not the team's" \
      "$(tail -n 1 "$WORK/keys.txt")" \
      "Every board would refuse an image signed with it. Get the team's key from its custodian" \
      "(secrets/README.md). Do not change firmware/keys/fw_signing_pub.pem to match it."
  fi
}

check_golden() {
  if python3 tools/golden.py check > "$WORK/golden.txt" 2>&1; then
    pass "the golden image agrees with firmware/golden.json and the bootloader's pin"
  else
    failed "the golden image: $(sed -n 's/^error: //p' "$WORK/golden.txt" | head -n 1)" \
      "Copy binaries/golden/ from whoever holds the signing key. It is not in git, and a rebuild won't match it"
  fi
}

check_wifi() {
  # Only whether it is there: it is root's, and its content is never read here.
  if [ -e "$WIFI" ]; then
    pass "the Wi-Fi network for the board, ~/.cranium/wifi_secrets.h (not read here)"
  else
    failed "no Wi-Fi network for the board at ~/.cranium/wifi_secrets.h" \
      "python3 tools/secrets.py wifi. Copy a phone hotspot's name exactly: it often has a curly apostrophe"
  fi
}

check_outputs() {
  local said_ status=0
  said_="$(helper outputs 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    pass "$said_"
  else
    failed "$said_" "Copy cloud/.deploy/outputs.json from whoever deployed the cloud (cloud/deploy.sh writes it)"
  fi
}

check_aws() {
  if ! command -v aws > /dev/null; then
    failed "the AWS CLI was not found" \
      "Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    return 0
  fi
  local version
  version="$(aws --version 2>&1 | head -n 1)"
  case "$version" in
    aws-cli/2.*) ;;
    *) failed "the AWS CLI is ${version%% *}, and v2 is needed" "Install the AWS CLI v2"; return 0 ;;
  esac
  # Whether the sign-in holds. What it says names the account, so none of it is shown.
  if aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION" > /dev/null 2>&1; then
    pass "signed in to AWS with the profile $AWS_PROFILE (${version%% *})"
  else
    failed "not signed in to AWS with the profile $AWS_PROFILE" \
      "aws login --profile $AWS_PROFILE --region $AWS_REGION, as an administrator (aws login --remote with no browser)"
  fi
}

# $1: yes if the steps cannot do without a token.
check_token() {
  local said_ status=0
  said_="$(helper token --online 2>&1)" || status=$?
  case "$status" in
    0) pass "a console token: $said_" ;;
    2)
      local fix=("On the console: Developer > API tokens > New token. Keep it readable by you alone:"
        "mkdir -p ~/.cranium && (umask 077 && pbpaste > ~/.cranium/console-token) on macOS; elsewhere"
        "(umask 077 && cat > ~/.cranium/console-token), paste it, Enter, then Ctrl-D")
      if [ "${1:-no}" = yes ]; then
        failed "no console token, which an nRF5340 DK's passkey needs (or --no-register)" "${fix[@]}"
      else
        warned "no console token: the release then comes from binaries/, and the console's view of the board is not checked" "${fix[@]}"
      fi ;;
    3)
      if [ "${1:-no}" = yes ]; then
        failed "$said_: an nRF5340 DK's passkey needs a release manager's token (or --no-register)"
      else
        warned "$said_: the release then comes from binaries/"
      fi ;;
    *) failed "the console token: $said_" ;;
  esac
}

check_node() {
  if command -v node > /dev/null; then
    pass "node, for the console's own check of an image's signature"
  else
    warned "node was not found: an image from binaries/ is not checked here before it goes on" \
      "The bootloader checks it anyway. To check it here too, install Node.js"
  fi
}

check_nrf5340dk_support() {
  if has_nrf5340dk_support; then
    pass "this checkout builds and provisions an nRF5340 DK"
  else
    failed "this checkout cannot build or provision an nRF5340 DK yet" \
      "That came with PR #5 (feature/nrf5340dk): git pull, once it is on main"
  fi
}

check_summary() {
  echo
  if [ "$CHECK_FAILS" -gt 0 ]; then
    say "$CHECK_FAILS to put right (FAIL), $CHECK_WARNS to know about (warn)."
    return 1
  fi
  if [ "$CHECK_WARNS" -gt 0 ]; then
    say "Ready, with $CHECK_WARNS to know about (warn)."
  else
    say "Ready."
  fi
  return 0
}

cmd_check() {
  use_nrfutil_path
  load_toolchain || true
  if [ -z "$BOARD_TYPE" ]; then
    local line
    read_devices
    if command -v python3 > /dev/null && line="$(helper boards --pick < "$WORK/devices.json" 2> /dev/null)"; then
      BOARD_TYPE="$(printf '%s' "$line" | cut -d'|' -f2)"
    fi
    BOARD_TYPE="${BOARD_TYPE:-nrf7002dk}"
  fi
  set_board_paths
  if [ "$BOARD_TYPE" = nrf7002dk ]; then
    say "What this computer needs to set up an $LABEL (for an nRF5340 DK: scripts/new-board.sh check --board nrf5340dk):"
  else
    say "What this computer needs to set up an $LABEL (for an nRF7002 DK: scripts/new-board.sh check --board nrf7002dk):"
  fi
  check_once nrfutil
  check_once toolchain
  check_once python
  check_once boards
  check_once key
  if [ "$BOARD_TYPE" = nrf7002dk ]; then
    check_once golden
    check_once wifi
  else
    check_once nrf5340dk_support
  fi
  check_once outputs
  check_once aws
  if [ "$BOARD_TYPE" = nrf5340dk ] && [ "$NO_REGISTER" = false ]; then
    check_once token yes
  else
    check_once token no
  fi
  check_once node
  check_summary
}

# Only what the steps that will run need. Nothing is done to the board if one fails.
preflight() {
  say "Checking this computer first:"
  local step
  for step in $1; do
    case "$step" in
      build)
        check_once nrfutil
        check_once toolchain
        check_once key
        [ "$BOARD_TYPE" = nrf7002dk ] || check_once nrf5340dk_support ;;
      flash)
        check_once nrfutil
        check_once toolchain ;;
      golden)
        check_once python
        check_once golden ;;
      release)
        check_once nrfutil
        check_once python
        check_once token no ;;
      provision)
        check_once python
        check_once outputs
        check_once aws
        if [ "$BOARD_TYPE" = nrf7002dk ]; then
          check_once wifi
        else
          check_once nrf5340dk_support
          if [ "$NO_REGISTER" = false ]; then check_once token yes; fi
        fi ;;
      verify)
        check_once python
        check_once token no ;;
    esac
  done
  if [ "$CHECK_FAILS" -gt 0 ]; then
    echo
    die "this computer is not ready: see FAIL above. Nothing was done to the board." \
      "scripts/new-board.sh check lists everything, with how to get it."
  fi
}

# ---- the steps ---------------------------------------------------------------------------------

golden_version() {
  sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' firmware/golden.json | head -n 1
}

# Every file at the top of binaries/ as it was, so that the build changes nothing there: a build of a
# version that is a release would otherwise put its own bytes over the release's.
keep_binaries() {
  mkdir -p "$WORK/binaries"
  : > "$WORK/binaries.list"
  local file
  for file in binaries/*; do
    [ -f "$file" ] || continue
    cp -p "$file" "$WORK/binaries/"
    printf '%s\n' "${file#binaries/}" >> "$WORK/binaries.list"
  done
}

put_back_binaries() {
  local file name changed=false
  for file in binaries/*; do
    [ -f "$file" ] || continue
    name="${file#binaries/}"
    if ! grep -qxF -- "$name" "$WORK/binaries.list"; then
      rm -f "$file"
      changed=true
    fi
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! cmp -s "$WORK/binaries/$name" "binaries/$name"; then
      cp -p "$WORK/binaries/$name" "binaries/$name"
      changed=true
    fi
  done < "$WORK/binaries.list"
  [ "$changed" = false ] || note "binaries/ is as it was before the build: this build's application stays in $BUILD_NAME/."
}

check_build() {
  local dir="$BUILD_NAME" missing="" file
  for file in mcuboot/zephyr/zephyr.hex app/zephyr/zephyr.signed.bin hci_ipc/zephyr/zephyr.hex; do
    [ -f "$dir/$file" ] || missing="$missing $dir/$file"
  done
  [ -z "$missing" ] || die "$dir/ is not a whole build: it has no$missing" \
    "Build it first: scripts/new-board.sh --only build"
  grep -q '^CONFIG_BT_HCI_RAW=y$' "$dir/hci_ipc/zephyr/.config" 2> /dev/null \
    || die "$dir/hci_ipc is not the Bluetooth controller" "Build again: scripts/new-board.sh --only build"
  if grep -E '^CONFIG_APP_TEST_FAULT_[A-Z0-9_]+=y$' "$dir/app/zephyr/.config" 2> /dev/null \
      | grep -qv '^CONFIG_APP_TEST_FAULT_NONE='; then
    die "$dir/ holds an image with a test fault built in" "Build again: scripts/new-board.sh --only build"
  fi
  local built_for
  built_for="$(sed -n 's/^CONFIG_APP_BOARD_TYPE="\(.*\)"$/\1/p' "$dir/app/zephyr/.config" 2> /dev/null || true)"
  [ -z "$built_for" ] || [ "$built_for" = "$BOARD_TYPE" ] \
    || die "$dir/ was built for the $built_for, and this board is an $LABEL"
  if [ "$BOARD_TYPE" = nrf7002dk ]; then
    python3 tools/golden.py check --config "$dir/mcuboot/zephyr/.config" > "$WORK/golden.txt" 2>&1 \
      || die "the bootloader in $dir/ does not pin the golden image: $(sed -n 's/^error: //p' "$WORK/golden.txt" | head -n 1)" \
        "Build again: scripts/new-board.sh --only build"
  fi
  ok "$dir/ has the bootloader, TF-M with the application, and the Bluetooth controller"
}

step_build() {
  say "Builds the bootloader, TF-M with the application at firmware/app/VERSION, and the network core's"
  say "Bluetooth controller, each signed with your key, in $BUILD_NAME/. It uploads nothing."
  local args=(--keep --no-upload)
  [ "$BOARD_TYPE" = nrf7002dk ] || args+=(--board "$BOARD_TYPE")
  if [ "$DRY_RUN" = true ]; then
    show_cmd scripts/build.sh "${args[@]}"
    return 0
  fi
  keep_binaries
  if ! run scripts/build.sh "${args[@]}"; then
    put_back_binaries
    die "the build failed: build.sh says why above" "The whole log is in $BUILD_NAME/last-build.log."
  fi
  put_back_binaries
  check_build
}

step_flash() {
  say "ERASES both cores of the board $SERIAL, TF-M storage with them, and writes the bootloader, TF-M with"
  say "the application, and the Bluetooth controller on the network core, from $BUILD_NAME/. The board then"
  say "starts in factory mode: LED1 flashes long every 2 seconds."
  if [ "$DRY_RUN" = true ]; then
    show_cmd "$(tilde "$NRFUTIL")" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh
    show_cmd west flash -d "$BUILD_NAME" --recover --dev-id "$SERIAL"
    show_cmd python3 "$HELPER" serial-status --port "$PORT" --wait 90 --expect-state FACTORY
    return 0
  fi
  check_build
  need_toolchain
  run west flash -d "$BUILD_NAME" --recover --dev-id "$SERIAL" \
    || die "west flash did not finish" "Close any serial terminal on the board, check its USB cable and power switch."
  board_says --wait 90 --expect-state FACTORY \
    || die "the board does not answer on $PORT in factory mode after the flash" \
      "If it is the wrong port: --port <the other one>. scripts/new-board.sh list shows them."
  ok "the board answers on its console, in factory mode"
}

seal_by_hand() {
  local answer
  printf '  Type sealed once LED1 has stayed on for about 45 s and the board has restarted, or refused if LED1 gave three slow blinks: '
  IFS= read -r answer || answer=""
  case "$answer" in
    sealed) return 0 ;;
    refused) die "the bootloader refused: neither copy is the pinned golden image" \
      "Run this step again: scripts/new-board.sh --from golden --serial-number $SERIAL" ;;
    *) die "the golden image is not known to be sealed" \
      "Run this step again: scripts/new-board.sh --from golden --serial-number $SERIAL" ;;
  esac
}

# $1: what to wait for, for the person.
watch_seal() {
  local status=0
  if [ -z "$LOG_PORT" ]; then
    seal_by_hand
    return 0
  fi
  note "Watching the bootloader's log on $LOG_PORT for 4 minutes. $1"
  helper watch-seal --port "$LOG_PORT" --timeout 240 || status=$?
  case "$status" in
    0) return 0 ;;
    1) die "the bootloader refused: neither copy is the pinned golden image" \
      "Run this step again: scripts/new-board.sh --from golden --serial-number $SERIAL" ;;
    *) seal_by_hand ;;
  esac
}

step_golden() {
  local golden
  golden="$(golden_version)"
  say "Puts the golden image $golden into the running slot through serial recovery (about 4 minutes), and then"
  say "you seal it with the gesture: the bootloader copies it into external flash, from where the rescue gesture"
  say "can always restore it. Only on a board with this project's bootloader, as the flash step puts on: on an"
  say "older one, the gesture can be a factory reset."
  if [ "$DRY_RUN" = true ]; then
    show_cmd python3 tools/golden.py check
    show_cmd python3 tools/golden.py restore --reset --serial-number "$SERIAL" --port "$PORT"
    show_cmd python3 "$HELPER" serial-status --port "$PORT" --wait 120 --expect-version "$golden"
    note "would ask for the gesture, and watch for it:"
    show_cmd python3 "$HELPER" watch-seal --port "$LOG_PORT" --timeout 240
    return 0
  fi
  run python3 tools/golden.py check || die "the golden image does not agree with firmware/golden.json" \
    "Copy binaries/golden/ from whoever holds the signing key."
  run python3 tools/golden.py restore --reset --serial-number "$SERIAL" --port "$PORT" \
    || die "the golden image did not go on" "golden.py says why above. Run this step again: --from golden"
  board_says --wait 120 --expect-version "$golden" > /dev/null \
    || die "the board does not run the golden image $golden after the restore"
  ok "the board runs the golden image $golden"

  echo
  say "  Now seal it, at the board:"
  say "    1. Press and hold RESET."
  say "    2. Press and hold Button 2."
  say "    3. Let go of RESET."
  say "    4. Keep holding Button 2 for 5 seconds, until LED1 blinks fast."
  say "    5. Let go of Button 2 within the next 5 seconds."
  say "  LED1 then stays on for about 45 s while it copies, and the board restarts."
  watch_seal "Do the gesture now."
  board_says --wait 120 --expect-version "$golden" > /dev/null \
    || die "the board does not run the golden image $golden after the gesture"
  ok "the golden image is sealed"

  local answer
  printf '  Do the gesture once more to check the copy: it should do nothing, with one slow blink.\n'
  printf '  Press Enter to watch for it, or type skip: '
  IFS= read -r answer || answer=skip
  if [ "$answer" != skip ]; then
    watch_seal "Do the gesture again now."
    board_says --wait 120 --expect-version "$golden" > /dev/null \
      || die "the board does not run the golden image $golden after the second gesture"
    ok "the golden copy is good"
  fi
}

step_release() {
  say "Installs the newest signed release for the $LABEL through serial recovery, in place of the image the"
  say "board runs now: the one given with --image, or the console's newest (with a console token), or the newest"
  say "in binaries/."
  local args=(release --board "$BOARD_TYPE" --fallback "$BUILD_NAME/app/zephyr/zephyr.signed.bin" --out-dir "$STATE_DIR/images")
  local layout
  # The flash layout the bootloader on the board was built for: serial recovery does not check it.
  layout="$(sed -n 's/^CONFIG_APP_IMAGE_LAYOUT=\([0-9][0-9]*\)$/\1/p' "$BUILD_NAME/app/zephyr/.config" 2> /dev/null || true)"
  [ -z "$layout" ] || args+=(--layout "$layout")
  [ -z "$IMAGE" ] || args+=(--image "$IMAGE")
  if [ "$DRY_RUN" = true ]; then
    show_cmd python3 "$HELPER" "${args[@]}"
    show_cmd python3 tools/recover.py --reset --serial-number "$SERIAL" --port "$PORT" upload "<that image>"
    show_cmd python3 "$HELPER" serial-status --port "$PORT" --wait 150 --expect-version "<its version>"
    return 0
  fi
  local line image version source sha256
  line="$(helper "${args[@]}")" || die "there is no image to install" "Pass one with --image <signed.bin>."
  IFS='|' read -r image version source sha256 <<< "$line"
  case "$source" in
    console) source="the console's newest release" ;;
    binaries) source="the newest in binaries/" ;;
    given) source="--image" ;;
    build) source="this build, which is no release" ;;
  esac
  note "$version, from $source: $image (SHA-256 $sha256)"
  run python3 tools/recover.py --reset --serial-number "$SERIAL" --port "$PORT" upload "$image" \
    || die "the image did not go on" "recover.py says why above. Run this step again: --from release"
  board_says --wait 150 --expect-version "$version" > /dev/null \
    || die "the board does not run $version after the upload"
  state_set release "$version"
  ok "the board runs $version"
}

step_provision() {
  if [ "$BOARD_TYPE" = nrf7002dk ]; then
    say "Sets the board's ID, sends it the Wi-Fi network from ~/.cranium/wifi_secrets.h (sudo may ask for your"
    say "password: the file is root's), has it make its own key pair, registers it in AWS IoT with a certificate and"
    say "the device policy, and loads the certificate, the root CA and the cloud settings. Then it waits for the"
    say "board to reach AWS IoT. The network's name and the AWS names are left out of what it prints."
  else
    say "Sets the board's ID, registers it in AWS IoT as a thing with board=nrf5340dk and no certificate, and gives"
    say "it its own Bluetooth passkey, registered with the console first. The passkey is never shown."
  fi
  local args=(-u tools/provision_device.py --port "$PORT" --profile "$AWS_PROFILE")
  [ -z "$DEVICE_ID" ] || args+=(--id "$DEVICE_ID")
  [ "$NEW_IDENTITY" = false ] || args+=(--new-identity)
  if [ "$BOARD_TYPE" = nrf5340dk ]; then
    args+=(--board nrf5340dk)
    [ "$NO_REGISTER" = false ] || args+=(--no-register)
    [ "$NEW_PASSKEY" = false ] || args+=(--new-passkey)
  fi
  show_cmd python3 "${args[@]}"
  [ "$DRY_RUN" = false ] || return 0
  if [ "$BOARD_TYPE" = nrf5340dk ] && ! has_nrf5340dk_support; then
    die "this checkout cannot provision an nRF5340 DK yet" "That came with PR #5 (feature/nrf5340dk)."
  fi
  # What it prints goes through redact, which leaves out the network's name and anything that names the account.
  if ! python3 "${args[@]}" 2>&1 | helper redact --indent 4; then
    die "provisioning stopped: provision_device.py says why above" \
      "Run it again with --from provision: it does only what is still missing."
  fi
  board_says --wait 30 --expect-state OPERATING > /dev/null \
    || die "the board is not out of factory mode after provisioning"
  state_set thing "$(said 'thing name')"
  ok "$(said 'thing name') is provisioned"
}

verify_bluetooth() {
  echo
  say "  At the board, hold Button 1 for 5 s and let go: LED1 flashes four times, and Bluetooth opens for 3 minutes."
  board_says --wait 90 --poll 2 --expect-bt-window open --quiet \
    || die "Bluetooth did not open: the board's window stays closed" \
      "Hold Button 1 for a full 5 s, then let go. Run this step again: --from verify"
  local name status=0 scan=(--prefix Cranium-) answer
  name="$(said 'bt name')"
  case "$name" in Cranium-*) scan=(--name "$name") ;; esac
  helper ble-scan "${scan[@]}" --timeout 20 || status=$?
  case "$status" in
    0) ok "the board advertises over Bluetooth${name:+ as $name}" ;;
    3)
      printf '  Does a phone (nRF Connect, or the Cranium app) see %s now? [y/N] ' "${name:-Cranium- and four hex digits}"
      IFS= read -r answer || answer=""
      case "$answer" in
        y|Y|yes) ok "the board advertises over Bluetooth (seen from a phone)" ;;
        *) die "the board is not seen over Bluetooth" "Hold Button 1 for 5 s again, and look once more: --from verify" ;;
      esac ;;
    *) die "the board's Bluetooth window is open, and nothing advertises as ${name:-Cranium-...}" \
      "Its controller may be missing on the network core: flash it again with --from flash" ;;
  esac
}

step_verify() {
  if [ "$BOARD_TYPE" = nrf7002dk ]; then
    say "Checks the board: what its serial console says, and that the console shows it online with that firmware."
  else
    say "Checks the board: what its serial console says, that the console lists it, and that it advertises over"
    say "Bluetooth."
  fi
  local release expect=(--expect-state OPERATING --expect-board "$BOARD_TYPE")
  release="$(state_get release)"
  [ -z "$release" ] || expect+=(--expect-version "$release")
  [ "$BOARD_TYPE" = nrf5340dk ] || expect+=(--expect-cloud connected)
  if [ "$DRY_RUN" = true ]; then
    show_cmd python3 "$HELPER" serial-status --port "$PORT" --wait 120 "${expect[@]}"
    if [ "$BOARD_TYPE" = nrf7002dk ]; then
      show_cmd python3 "$HELPER" console-status --thing "<its thing name>" --wait 300 --expect-online --expect-version "<its firmware>"
    else
      show_cmd python3 "$HELPER" console-status --thing "<its thing name>" --wait 60 --expect-listed
      note "would ask for Button 1 to be held, then:"
      show_cmd python3 "$HELPER" serial-status --port "$PORT" --wait 90 --expect-bt-window open
      show_cmd python3 "$HELPER" ble-scan --name "<its Bluetooth name>"
    fi
    return 0
  fi
  board_says --wait 120 "${expect[@]}" || die "the board is not as it should be: see above"
  local thing firmware status=0
  thing="$(said 'thing name')"
  firmware="$(said firmware)"
  if [ "$BOARD_TYPE" = nrf5340dk ] && [ "$NO_REGISTER" = false ] && [ "$(said 'bt passkey')" != set ]; then
    die "the board has no passkey of its own (bt passkey $(said 'bt passkey'))" "Provision it again: --from provision"
  fi
  if [ "$BOARD_TYPE" = nrf7002dk ]; then
    note "Waiting for the console to show $thing online with $firmware (up to 5 minutes):"
    helper console-status --thing "$thing" --wait 300 --expect-online --expect-version "$firmware" || status=$?
  else
    helper console-status --thing "$thing" --wait 60 --expect-listed || status=$?
  fi
  case "$status" in
    0) ok "the console shows $thing as it should" ;;
    2) note "The console's view was not checked: there is no console token. Look on the console's Overview." ;;
    *) die "the console does not show $thing as it should: see above" \
      "Give it a few minutes, then: scripts/new-board.sh --from verify --serial-number $SERIAL" ;;
  esac
  [ "$BOARD_TYPE" = nrf7002dk ] || verify_bluetooth
  state_set thing "$thing"
}

# ---- setup -------------------------------------------------------------------------------------

step_number() {
  local step n=0
  for step in $STEPS; do
    n=$((n + 1))
    [ "$step" = "$1" ] && break
  done
  printf '%s' "$n"
}

count_steps() {
  set -- $STEPS
  printf '%s' "$#"
}

valid_step() {
  case " $STEPS " in
    *" $1 "*) return 0 ;;
  esac
  if [ "$1" = golden ] && [ "$BOARD_TYPE" = nrf5340dk ]; then
    die "an nRF5340 DK has no golden step: its bootloader has no golden image" "Its steps: $STEPS"
  fi
  die "there is no step $1" "The steps of an $LABEL: $STEPS"
}

# The steps to run, one per line.
selected_steps() {
  local step started=false
  [ -n "$FROM" ] || started=true
  for step in $STEPS; do
    if [ -n "$ONLY" ]; then
      [ "$step" != "$ONLY" ] || printf '%s\n' "$step"
      continue
    fi
    [ "$step" != "$FROM" ] || started=true
    [ "$started" = false ] || printf '%s\n' "$step"
  done
  return 0
}

resolve_steps() {
  if [ "$RESUME" = true ]; then
    local last step next="" seen=false
    last="$(state_get last_step)"
    [ -n "$last" ] || die "nothing is recorded for the board $SERIAL yet, so there is nothing to resume" \
      "Start from the beginning: scripts/new-board.sh --serial-number $SERIAL"
    for step in $STEPS; do
      if [ "$seen" = true ]; then next="$step"; break; fi
      [ "$step" != "$last" ] || seen=true
    done
    FROM="${next:-verify}"
    note "Last time the board $SERIAL got through the $last step: going on from $FROM."
  fi
  [ -z "$FROM" ] || valid_step "$FROM"
  [ -z "$ONLY" ] || valid_step "$ONLY"
}

confirm_board() {
  local steps="$1" prompt answer
  case " $(printf '%s ' $steps)" in
    *" flash "*)
      prompt="This ERASES the board $SERIAL ($LABEL): its firmware, ID, Wi-Fi network, keys and certificates. Type its last 4 digits to go on: " ;;
    *" golden "*|*" release "*|*" provision "*)
      prompt="This writes to the board $SERIAL ($LABEL). Type its last 4 digits to go on: " ;;
    *) return 0 ;;
  esac
  if [ "$DRY_RUN" = true ]; then
    note "would ask: $prompt"
    return 0
  fi
  echo
  if [ -n "$CONFIRM" ]; then
    printf '%s%s\n' "$prompt" "$CONFIRM (from --confirm)"
    answer="$CONFIRM"
  else
    printf '%s' "$prompt"
    IFS= read -r answer || answer=""
  fi
  [ "$answer" = "${SERIAL: -4}" ] || die "that is not the last 4 digits of $SERIAL: nothing was done to the board" \
    "The serial number is on the debugger's sticker; scripts/new-board.sh list shows it too."
}

cmd_setup() {
  local steps step total
  if [ "$DRY_RUN" = true ]; then
    # Nothing at all is run: not even nrfutil device list.
    if [ -z "$BOARD_TYPE" ]; then
      BOARD_TYPE=nrf7002dk
      say "(No --board: these are an nRF7002 DK's steps. --board nrf5340dk shows the other's.)"
    fi
    SERIAL="${SERIAL:-<serial>}"
    PORT="${PORT:-<console port>}"
    LOG_PORT="${LOG_PORT:-<log port>}"
    set_board_paths
    resolve_steps
    steps="$(selected_steps)"
    say "Dry run: every command of setting up the $LABEL $SERIAL, and none of them run."
    note "would check this computer first, as: scripts/new-board.sh check --board $BOARD_TYPE"
    note "would find the boards with: $(tilde "$NRFUTIL") device list --json, and refuse unless exactly one is chosen"
    confirm_board "$steps"
  else
    use_nrfutil_path
    load_toolchain || true
    # A build alone needs no board, once the type is known.
    if [ "$ONLY" = build ] && [ -n "$BOARD_TYPE" ]; then
      SERIAL=""
    else
      command -v python3 > /dev/null || die "python3 was not found" "scripts/new-board.sh check says how to get it."
      # The debugger is needed to flash the board and to restart it into its bootloader.
      case "$ONLY$FROM" in
        provision|verify) choose_board no ;;
        *) choose_board yes ;;
      esac
    fi
    set_board_paths
    resolve_steps
    steps="$(selected_steps)"
    say "The $LABEL${SERIAL:+ $SERIAL}${PCA:+ ($PCA)}${PORT:+, its console on $PORT}."
    say "Steps: $(echo $steps)."
    echo
    preflight "$steps"
    confirm_board "$steps"
  fi
  total="$(count_steps)"
  for step in $steps; do
    CURRENT_STEP="$step"
    echo
    say "== Step $(step_number "$step") of $total: $step =="
    "step_$step"
    state_set last_step "$step"
    state_set board "$BOARD_TYPE"
  done
  CURRENT_STEP=""
  echo
  if [ "$DRY_RUN" = true ]; then
    say "Dry run: nothing was run."
  else
    say "Done: the $LABEL${SERIAL:+ $SERIAL} got through $(echo $steps)."
    [ -z "$SERIAL" ] || say "scripts/new-board.sh status $SERIAL shows it again at any time."
  fi
}

# ---- status and list ---------------------------------------------------------------------------

cmd_status() {
  use_nrfutil_path
  load_toolchain || true
  command -v python3 > /dev/null || die "python3 was not found" "scripts/new-board.sh check says how to get it."
  choose_board no yes
  [ -z "$BOARD_TYPE" ] || set_board_paths
  say "Board $SERIAL: ${LABEL:-of a type its debugger does not say}${PCA:+ ($PCA)}, its console on $PORT"
  local thing status=0 last
  if board_says --wait 10; then
    :
  else
    note "(the board does not answer on $PORT: is a serial terminal open on it, or is it restarting?)"
  fi
  thing="$(said 'thing name')"
  [ -n "$thing" ] || thing="$(state_get thing)"
  if [ -n "$thing" ]; then
    helper console-status --thing "$thing" || status=$?
    [ "$status" -ne 2 ] || note "The console's view needs a console token: scripts/new-board.sh check says how to make one."
  fi
  last="$(state_get last_step)"
  [ -z "$last" ] || note "scripts/new-board.sh took it through the $last step$( [ -z "$(state_get release)" ] || printf ', and installed %s' "$(state_get release)")."
}

cmd_list() {
  use_nrfutil_path
  load_toolchain || true
  command -v python3 > /dev/null || die "python3 was not found"
  read_devices
  helper boards < "$WORK/devices.json"
}

case "$MODE" in
  check) cmd_check ;;
  status) cmd_status ;;
  list) cmd_list ;;
  setup) cmd_setup ;;
esac
