#!/usr/bin/env bash
#
# Put the Cranium app on a phone, from this checkout (macOS or Linux; Windows: apps/install.ps1).
#
#   apps/install.sh android                     the APK in apps/dist/ on the one phone adb sees (USB)
#   apps/install.sh android --pair IP:PORT CODE  pair with a phone over Wi-Fi first (Android 11+:
#                                                Developer options > Wireless debugging > Pair with code)
#   apps/install.sh android --wifi IP:PORT       connect to a phone already paired over Wi-Fi, then install
#   apps/install.sh iphone                      on a Mac: build this checkout's app and install it on your
#                                               iPhone by cable or over Wi-Fi; elsewhere: the SideStore steps
#   apps/install.sh iphone --schedule           the same, then keep it opening and up to date every hour
#   apps/install.sh check                       what this computer has and lacks for each
#
# Android: the phone needs USB debugging on (Settings > About phone > tap Build number 7 times, then
# Settings > System > Developer options > USB debugging), and says "Allow USB debugging?" once. The
# APK is checked against apps/dist/SHA256SUMS before it goes on. From app 0.7.0 on, every later
# version reaches the phone by itself: the app offers it, and installs it with a tap.
#
# iPhone: a free Apple ID can install only on your own devices, for 7 days at a time. The first time,
# apps/ios/scripts/phone.sh walks you through Xcode once; after that this script (renew.sh) does it.
# See apps/README.md.

set -euo pipefail

APPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$APPS_DIR/dist"
say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

newest() {   # newest() android|ios: the newest build file in apps/dist/, or nothing
  local kind="$1" ext
  [ "$kind" = android ] && ext=apk || ext=ipa
  { ls -1 "$DIST"/cranium-"$kind"-*."$ext" 2>/dev/null || true; } | sort -V | tail -n 1
}

check_sum() {
  local file="$1" name want got
  name="$(basename "$file")"
  [ -f "$DIST/SHA256SUMS" ] || fail "apps/dist/SHA256SUMS is missing"
  want="$( { grep "  $name\$" "$DIST/SHA256SUMS" || true; } | cut -d ' ' -f 1)"
  [ -n "$want" ] || fail "$name is not in apps/dist/SHA256SUMS"
  got="$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$file")"
  [ "$want" = "$got" ] || fail "$name does not match apps/dist/SHA256SUMS: run apps/fetch-builds.sh again"
}

find_adb() {
  local candidate
  for candidate in "$(command -v adb 2>/dev/null || true)" "${ANDROID_HOME:-}/platform-tools/adb" \
                   "$HOME/Library/Android/sdk/platform-tools/adb" "$HOME/Android/Sdk/platform-tools/adb" \
                   /opt/homebrew/bin/adb /usr/local/bin/adb; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

adb_help() {
  say "adb (Android's platform tools) is not installed. Install it, then run this again:"
  say "  macOS:          brew install --cask android-platform-tools"
  say "  Debian/Ubuntu:  sudo apt install adb"
  say "  Fedora:         sudo dnf install android-tools"
  say "  Or from Google: https://developer.android.com/tools/releases/platform-tools"
  say "Or skip it: open the console's Apps page on the phone and tap Download (then allow installs from the browser)."
}

android() {
  local adb apk
  adb="$(find_adb)" || { adb_help; exit 1; }
  apk="$(newest android)"
  [ -n "$apk" ] || fail "no Android build in apps/dist/: run apps/fetch-builds.sh android"
  check_sum "$apk"
  case "${1:-}" in
    --pair)
      [ $# -ge 3 ] || fail "usage: apps/install.sh android --pair IP:PORT CODE"
      "$adb" pair "$2" "$3"
      say "Paired. Now connect: on the phone, Wireless debugging shows IP address & Port (not the pairing port);"
      say "  apps/install.sh android --wifi <that IP:PORT>"
      return 0 ;;
    --wifi)
      [ $# -ge 2 ] || fail "usage: apps/install.sh android --wifi IP:PORT"
      "$adb" connect "$2" ;;
    "") ;;
    *) fail "unknown option ${1}" ;;
  esac
  local phones
  phones="$( { "$adb" devices | awk 'NR>1 && $2=="device" {print $1}'; } || true)"
  if [ -z "$phones" ]; then
    say "No phone is ready. Plug it in with USB debugging on and accept \"Allow USB debugging?\","
    say "or use --pair / --wifi for Wireless debugging. (\"unauthorized\" means the phone still has to allow it.)"
    "$adb" devices
    exit 1
  fi
  [ "$(printf '%s\n' "$phones" | wc -l | tr -d ' ')" = 1 ] || fail "more than one phone: set ANDROID_SERIAL to one of: $(echo $phones)"
  say "Installing $(basename "$apk") on $phones…"
  "$adb" -s "$phones" install -r "$apk"
  say "Done. Open Cranium on the phone and sign in. From 0.7.0 on, it offers each new version by itself."
}

iphone() {
  if [ "$(uname -s)" != Darwin ] || ! command -v xcodebuild >/dev/null 2>&1; then
    local ipa; ipa="$(newest ios)"
    say "This computer cannot build iPhone apps (that needs a Mac with Xcode). Two free ways instead:"
    say "  1. SideStore, on the iPhone itself: install it once (apps/README.md, \"iPhone without a Mac\"), then on the"
    say "     console's Apps page press Make my SideStore link, Add to SideStore, and install Cranium from it."
    [ -n "$ipa" ] && say "     The same build is in git: $(basename "$ipa") (SideStore can also import it from Files)."
    say "  2. Ask a teammate with a Mac to run apps/install.sh iphone with your iPhone plugged in."
    exit 0
  fi
  [ -f "$APPS_DIR/config/cranium.json" ] || fail "apps/config/cranium.json is missing: run apps/configure.sh, or Download the configuration on the Apps page"
  if [ ! -s "$HOME/.cranium/apple-team-id" ]; then
    say "First time on this Mac: Xcode has to install the app once (it registers the iPhone with your Apple ID)."
    say "Running apps/ios/scripts/phone.sh: press Run in Xcode, then come back and run this again."
    exec "$APPS_DIR/ios/scripts/phone.sh"
  fi
  "$APPS_DIR/ios/scripts/renew.sh"
  if [ "${1:-}" = --schedule ]; then "$APPS_DIR/ios/scripts/renew.sh" --schedule; fi
  say "Done. Without --schedule, run this again within 7 days; with it, the Mac keeps the app opening and installs"
  say "each new version from main whenever the iPhone is on this Mac's Wi-Fi."
}

check() {
  local have
  have() { command -v "$1" >/dev/null 2>&1 && echo "yes" || echo "no"; }
  say "This computer:"
  say "  git $(have git), python3 $(have python3), curl $(have curl)"
  say "  adb (Android): $(find_adb >/dev/null && echo yes || echo 'no — see apps/install.sh android')"
  if [ "$(uname -s)" = Darwin ]; then
    say "  Xcode (iPhone): $(have xcodebuild), xcodegen: $(have xcodegen) (brew install xcodegen)"
    say "  Apple team known: $([ -s "$HOME/.cranium/apple-team-id" ] && echo yes || echo 'no — apps/ios/scripts/phone.sh once')"
  else
    say "  iPhone: not from this computer (needs a Mac); use SideStore"
  fi
  say "  apps/config/cranium.json: $([ -f "$APPS_DIR/config/cranium.json" ] && echo yes || echo 'no — apps/configure.sh, or the Apps page')"
  say "Builds in apps/dist/:"
  local file
  for file in "$(newest android)" "$(newest ios)"; do [ -n "$file" ] && say "  $(basename "$file")"; done
  if adb="$(find_adb)"; then say "Android phones adb sees:"; "$adb" devices | awk 'NR>1 && NF {print "  " $0}'; fi
  if [ "$(uname -s)" = Darwin ] && command -v xcrun >/dev/null 2>&1; then
    say "iPhones this Mac sees:"
    { xcrun devicectl list devices 2>/dev/null || true; } | awk '/iPhone/ && !/simulated/ {print "  " $0}' | cut -c1-110
  fi
}

case "${1:-}" in
  android) shift; android "$@" ;;
  iphone|ios) shift; iphone "$@" ;;
  check) check ;;
  -h|--help|"") sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) fail "unknown command $1 (android, iphone or check)" ;;
esac
