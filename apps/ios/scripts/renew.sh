#!/usr/bin/env bash
#
# Keep the Cranium app opening on your iPhone without pressing Run in Xcode every week.
#
# An app signed by a free Personal Team stops opening when its provisioning profile ends, 7 days
# after Xcode made it. This builds the app from the newest commit on main, with a new profile when
# the old one has 36 hours or less left, and installs it on the iPhone by cable or over Wi-Fi.
# What the app stored stays.
#
#   apps/ios/scripts/renew.sh               build and install now
#   apps/ios/scripts/renew.sh --if-due      only when the installed app has 36 hours or less left
#   apps/ios/scripts/renew.sh --schedule    run --if-due every hour from now on (a LaunchAgent: yours, not root's)
#   apps/ios/scripts/renew.sh --unschedule  stop that
#   apps/ios/scripts/renew.sh --status      when the app stops opening, and whether the iPhone is in reach
#
# First, once: install with Run in Xcode (scripts/phone.sh). That registers the iPhone with the
# team, and has you trust the developer on the phone. Over Wi-Fi the iPhone has to be on the Mac's
# network, unlocked at least once since it restarted, and ticked "Connect via network" in Xcode >
# Window > Devices and Simulators. The Mac has to be awake; an hourly check catches up after sleep.
#
# Which iPhone: the one whose UDID is in ~/.cranium/iphone-udid, or else the only iPhone paired
# with this Mac. A failure shows a notification. The log is ~/Library/Logs/cranium-renew.log.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/../.." && pwd)"
STATE_DIR="$HOME/.cranium"
UDID_FILE="$STATE_DIR/iphone-udid"
EXPIRES_FILE="$STATE_DIR/iphone-app-expires"   # when the installed app stops opening, in Unix seconds
OLD_PROFILES="$STATE_DIR/old-profiles"
CACHE="$HOME/Library/Caches/cranium-renew"
SRC="$CACHE/src"                                # a worktree of this repository, at main
DERIVED="$CACHE/derived"
LOCK="$CACHE/lock"
NOT_BEFORE_FILE="$CACHE/not-before"             # Apple kept the old profile: wait until it ends
LOG="$HOME/Library/Logs/cranium-renew.log"
LABEL="com.craniumiot.renew-iphone"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROFILE_DIRS=("$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
              "$HOME/Library/MobileDevice/Provisioning Profiles")
MARGIN=$((36 * 3600))
WARN=$((12 * 3600))

BUNDLE_ID="${CRANIUM_BUNDLE_ID:-}"
if [ -z "$BUNDLE_ID" ] && [ -f "$STATE_DIR/apple-bundle-id" ]; then
  BUNDLE_ID="$(tr -d '[:space:]' < "$STATE_DIR/apple-bundle-id")"
fi
BUNDLE_ID="${BUNDLE_ID:-com.craniumiot.cranium}"

mkdir -p "$CACHE" "$(dirname "$LOG")"

say() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$line"
  echo "$line" >> "$LOG"
}

notify() {
  osascript -e "display notification \"$1\" with title \"Cranium iPhone app\"" >/dev/null 2>&1 || true
}

fail() {
  say "error: $1"
  notify "$1"
  exit 1
}

when() {
  date -r "$1" '+%a %d %b %H:%M'
}

# "<expiry in Unix seconds> <devices>" for a provisioning profile, if it is this app's; else nothing.
profile_info() {
  security cms -D -i "$1" 2>/dev/null | python3 -I -c '
import datetime, plistlib, sys
try:
    p = plistlib.loads(sys.stdin.buffer.read())
except Exception:
    sys.exit(0)
app_id = p.get("Entitlements", {}).get("application-identifier", "")
if app_id.endswith("." + sys.argv[1]):
    # plistlib gives the date in UTC without saying so; timestamp() would take it as local time.
    expires = p["ExpirationDate"].replace(tzinfo=datetime.timezone.utc)
    print(int(expires.timestamp()), ",".join(p.get("ProvisionedDevices", [])))
' "$BUNDLE_ID"
}

# Every cached profile of this app, one per line: "<expiry> <path>".
our_profiles() {
  local dir file info
  for dir in "${PROFILE_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    for file in "$dir"/*.mobileprovision "$dir"/*.provisionprofile; do
      [ -f "$file" ] || continue
      info="$(profile_info "$file")"
      [ -z "$info" ] || echo "${info%% *} $file"
    done
  done
}

# When the installed app stops opening: what this script last installed, or else the newest
# profile Xcode has for the app (Run in Xcode used it); 0 if neither is known.
installed_expiry() {
  if [ -s "$EXPIRES_FILE" ]; then
    tr -d '[:space:]' < "$EXPIRES_FILE"
    return
  fi
  our_profiles | sort -n | tail -1 | cut -d' ' -f1 | grep . || echo 0
}

# "<udid>\t<name>" of the iPhone to use, or an error on stderr.
find_iphone() {
  local json want=""
  json="$(mktemp)"
  [ ! -s "$UDID_FILE" ] || want="$(tr -d '[:space:]' < "$UDID_FILE")"
  if ! xcrun devicectl --quiet --timeout 30 list devices --json-output "$json" >/dev/null 2>&1; then
    rm -f "$json"
    echo "Xcode's devicectl could not list the devices" >&2
    return 1
  fi
  python3 -I - "$json" "$want" <<'EOF'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
want = sys.argv[2]
phones = [d for d in devices
          if d.get("hardwareProperties", {}).get("reality") == "physical"
          and d.get("hardwareProperties", {}).get("deviceType") == "iPhone"
          and d.get("connectionProperties", {}).get("pairingState") == "paired"]
if want:
    phones = [d for d in phones if d["hardwareProperties"].get("udid") == want]
if len(phones) != 1:
    print("found %d paired iPhones%s; put the UDID of the one to use in ~/.cranium/iphone-udid"
          % (len(phones), " with that UDID" if want else ""), file=sys.stderr)
    sys.exit(1)
d = phones[0]
print("%s\t%s" % (d["hardwareProperties"]["udid"], d.get("deviceProperties", {}).get("name", "iPhone")))
EOF
  local status=$?
  rm -f "$json"
  return $status
}

in_reach() {
  xcrun devicectl --quiet --timeout 45 device info details --device "$1" >/dev/null 2>&1
}

status() {
  local expiry now phone
  now="$(date +%s)"
  expiry="$(installed_expiry)"
  if [ "$expiry" -eq 0 ]; then
    echo "The app: no install known. Press Run in Xcode once (scripts/phone.sh)."
  elif [ ! -s "$EXPIRES_FILE" ]; then
    echo "The app: not installed by this script yet. Xcode's profile for it ends $(when "$expiry"),"
    echo "  so an app put on the iPhone with Run in Xcode opens until then."
  elif [ "$expiry" -le "$now" ]; then
    echo "The app: stopped opening $(when "$expiry")."
  else
    echo "The app: opens until $(when "$expiry"), $(( (expiry - now) / 3600 )) hours from now."
  fi
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "Schedule: on, every hour (renews when 36 hours or less are left)."
  else
    echo "Schedule: off (renew.sh --schedule turns it on)."
  fi
  if phone="$(find_iphone 2>&1)"; then
    if in_reach "${phone%%$'\t'*}"; then
      echo "iPhone: ${phone#*$'\t'}, in reach."
    else
      echo "iPhone: ${phone#*$'\t'}, not in reach now (asleep, away, or not on this network)."
    fi
  else
    echo "iPhone: $phone"
  fi
  [ ! -f "$LOG" ] || { echo "Last log lines:"; tail -3 "$LOG" | sed 's/^/  /'; }
}

schedule() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$IOS_DIR/scripts/renew.sh</string>
    <string>--if-due</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  plutil -lint -s "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "On: every hour this Mac is awake, it renews the app when 36 hours or less are left."
  echo "renew.sh --status says how it stands; renew.sh --unschedule stops it."
}

unschedule() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Off. The app keeps opening until its profile ends; Run in Xcode renews it by hand."
}

# Profiles moved aside so that Xcode makes a new one, put back if the build fails.
MOVED=()
put_back() {
  local file
  for file in ${MOVED[@]+"${MOVED[@]}"}; do
    mv -f "$OLD_PROFILES/$(basename "$file")" "$file" 2>/dev/null || true
  done
}

renew() {
  local if_due="$1" now expiry phone udid name commit app info new_expiry devices line file

  now="$(date +%s)"
  expiry="$(installed_expiry)"
  if [ "$if_due" = true ] && [ "$expiry" -gt $((now + MARGIN)) ]; then
    exit 0
  fi
  if [ "$if_due" = true ] && [ -s "$NOT_BEFORE_FILE" ] && [ "$now" -lt "$(tr -d '[:space:]' < "$NOT_BEFORE_FILE")" ]; then
    exit 0
  fi

  # One run at a time; a lock older than 3 hours is from a run that died.
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
      rmdir "$LOCK" 2>/dev/null || true
      mkdir "$LOCK" 2>/dev/null || { say "another renewal is running"; exit 0; }
    else
      say "another renewal is running"
      exit 0
    fi
  fi
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

  phone="$(find_iphone 2>&1)" || fail "$phone"
  udid="${phone%%$'\t'*}"
  name="${phone#*$'\t'}"
  if ! in_reach "$udid"; then
    if [ "$if_due" = true ]; then
      say "$name is not in reach; trying again in an hour"
      if [ "$expiry" -gt 0 ] && [ "$expiry" -le $((now + WARN)) ]; then
        notify "The app stops opening $(when "$expiry"). Bring $name near this Mac, unlocked, on its Wi-Fi."
      fi
      exit 0
    fi
    fail "$name is not in reach: unlock it, and plug it in or put it on this Mac's Wi-Fi"
  fi

  [ -f "$REPO_DIR/apps/config/cranium.json" ] || fail "apps/config/cranium.json is missing: run apps/configure.sh"

  # The newest commit on main, in a worktree of its own, so that work in progress is never built.
  if [ ! -e "$SRC/.git" ]; then
    git -C "$REPO_DIR" worktree add --detach "$SRC" main >/dev/null 2>&1 \
      || fail "could not make a copy of main in $SRC"
  fi
  git -C "$SRC" checkout -q -f --detach main || fail "could not check out main in $SRC"
  commit="$(git -C "$SRC" rev-parse --short HEAD)"
  mkdir -p "$SRC/apps/config"
  cp "$REPO_DIR/apps/config/cranium.json" "$SRC/apps/config/cranium.json"

  # A profile with 36 hours or less left goes aside, so that Xcode makes a new one for 7 days.
  while read -r line; do
    [ -n "$line" ] || continue
    file="${line#* }"
    if [ "${line%% *}" -le $((now + MARGIN)) ]; then
      mkdir -p "$OLD_PROFILES"
      mv -f "$file" "$OLD_PROFILES/" && MOVED+=("$file")
    fi
  done <<< "$(our_profiles)"

  say "building $commit for $name"
  if ! "$SRC/apps/ios/scripts/generate.sh" > "$CACHE/build.log" 2>&1; then
    put_back
    fail "the project could not be made; see $CACHE/build.log"
  fi
  if ! nice -n 10 xcodebuild -project "$SRC/apps/ios/Cranium.xcodeproj" -scheme Cranium \
      -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" \
      -allowProvisioningUpdates -jobs 4 build >> "$CACHE/build.log" 2>&1; then
    put_back
    fail "the build failed (is Xcode still signed in to your Apple ID?); see $CACHE/build.log"
  fi

  app="$DERIVED/Build/Products/Debug-iphoneos/Cranium.app"
  [ -f "$app/embedded.mobileprovision" ] || fail "the build made no signed app at $app"
  info="$(profile_info "$app/embedded.mobileprovision")"
  [ -n "$info" ] || fail "the app's profile is not for $BUNDLE_ID"
  new_expiry="${info%% *}"
  devices="${info#* }"
  case ",$devices," in
    *",$udid,"*) ;;
    *) fail "the profile does not list $name: press Run in Xcode once with it plugged in" ;;
  esac
  if [ "$new_expiry" -le $((now + MARGIN)) ]; then
    if [ "$new_expiry" -gt "$now" ]; then
      # Apple gave back the profile it had made: it makes a new one only once that one ends.
      echo "$new_expiry" > "$NOT_BEFORE_FILE"
      say "Apple kept the profile that ends $(when "$new_expiry"); trying again just after that"
      exit 0
    fi
    fail "Xcode signed the app with a profile that has ended; open Xcode, check the account, and Run once"
  fi
  rm -f "$NOT_BEFORE_FILE"

  if ! xcrun devicectl --timeout 300 device install app --device "$udid" "$app" > "$CACHE/install.log" 2>&1; then
    fail "the install on $name failed (locked, or out of reach?); see $CACHE/install.log"
  fi
  umask 077
  echo "$new_expiry" > "$EXPIRES_FILE"
  say "installed $commit on $name; it opens until $(when "$new_expiry")"
  notify "Renewed on $name: it opens until $(when "$new_expiry")."
}

case "${1:-}" in
  "") renew false ;;
  --if-due) renew true ;;
  --schedule) schedule ;;
  --unschedule) unschedule ;;
  --status) status ;;
  -h|--help) sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *) echo "error: unknown option: $1 (see --help)" >&2; exit 1 ;;
esac
