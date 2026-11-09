#!/usr/bin/env bash
#
# Check, before a fleet-management (manual 3.11) demonstration, that everything it needs is in place:
# the console answers, the demo releases are on its Firmware page, the board is known and how it is,
# and Memfault has the board, the releases and the crash demonstration's symbols. It only reads:
# nothing is deployed, sent or changed. docs/fleet-demo.md is the demonstration itself.
#
#   scripts/fleet/fleet-check.sh
#
# Needs: ~/.cranium/console-token (an API token from the console's Tokens page), cloud/.deploy/outputs.json
# (written by cloud/deploy.sh; ~/cranium-work/deploy has one), ~/.cranium/memfault.json and
# ~/.cranium/memfault_org_token, python3 and curl. AWS sign-in only for the stack's state (optional).
# Prints no token, key, address or account number.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CRASH_DEMO="${CRASH_DEMO:-1.14.0+1}"
FIX_RELEASE="${FIX_RELEASE:-1.14.2+0}"
failed=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; failed=1; }
note() { printf '  note  %s\n' "$*"; }

outputs=""
for candidate in "$REPO_DIR/cloud/.deploy/outputs.json" "$HOME/cranium-work/deploy/cloud/.deploy/outputs.json"; do
  if [ -f "$candidate" ] && grep -q '"ConsoleUrl"\|ConsoleUrl' "$candidate"; then outputs="$candidate"; break; fi
done

echo "Console"
if [ -z "$outputs" ]; then
  bad "no cloud/.deploy/outputs.json: run cloud/deploy.sh once"
elif [ ! -s "$HOME/.cranium/console-token" ]; then
  bad "no ~/.cranium/console-token: make one on the console's Tokens page"
else
  console="$(python3 -I -c 'import json,sys
o=json.load(open(sys.argv[1]))
o=o if isinstance(o,dict) else {x["OutputKey"]:x["OutputValue"] for x in o}
print(o["ConsoleUrl"].rstrip("/"))' "$outputs")"
  api() { curl -sS --max-time 20 -H "Authorization: Bearer $(cat "$HOME/.cranium/console-token")" "$console/api/t/$1"; }
  if firmware="$(api firmware)" && [ -n "$firmware" ]; then
    FLEET_JSON="$firmware" python3 -I - "$CRASH_DEMO" "$FIX_RELEASE" <<'PY' || failed=1
import json, os, sys
crash, fix = sys.argv[1], sys.argv[2]
versions = {r["version"] for r in json.loads(os.environ["FLEET_JSON"]).get("releases", [])}
ok = True
for version, what in ((crash, "crash demonstration"), (fix, "the release that ends it")):
    if version in versions:
        print("  ok    %s %s is on the Firmware page" % (what, version))
    else:
        print("  FAIL  %s %s is not on the Firmware page" % (what, version)); ok = False
sys.exit(0 if ok else 1)
PY
  else
    bad "the console's firmware list could not be read"
  fi
  if devices="$(api devices)" && [ -n "$devices" ]; then
    FLEET_JSON="$devices" python3 -I - <<'PY'
import json, os
boards = json.loads(os.environ["FLEET_JSON"]).get("devices", [])
if not boards:
    print("  FAIL  no board is registered")
for b in boards:
    fw = (b.get("fw") or {}).get("version")
    state = "online" if b.get("online") else "offline (plug it in and let it reach Wi-Fi)"
    print("  %s  board %s: %s, firmware %s, update %s" % ("ok  " if b.get("online") else "note", b.get("name") or "?", state, fw, (b.get("ota") or {}).get("state")))
PY
  else
    bad "the console's board list could not be read"
  fi
fi

echo "Memfault"
if [ ! -s "$HOME/.cranium/memfault_org_token" ] || [ ! -s "$HOME/.cranium/memfault.json" ]; then
  bad "no Memfault token or project in ~/.cranium (docs/memfault.md)"
else
  python3 -I - "$CRASH_DEMO" "$FIX_RELEASE" <<'PY' || failed=1
import base64, json, os, sys, urllib.request
crash, fix = sys.argv[1], sys.argv[2]
home = os.path.expanduser("~/.cranium")
cfg = json.load(open(os.path.join(home, "memfault.json")))
token = open(os.path.join(home, "memfault_org_token")).read().strip()
base = "https://api.memfault.com/api/v0/organizations/%s/projects/%s/" % (cfg["org"], cfg["project"])
def get(path):
    request = urllib.request.Request(base + path)
    request.add_header("Authorization", "Basic " + base64.b64encode((":" + token).encode()).decode())
    with urllib.request.urlopen(request, timeout=20) as answer:
        return json.load(answer).get("data", [])
ok = True
try:
    devices = get("devices?per_page=50")
    print("  %s  %d board(s) in the project" % ("ok  " if devices else "FAIL", len(devices)))
    ok = ok and bool(devices)
    for d in devices:
        print("  note  a board last seen %s" % ((d.get("last_seen") or "never")[:16].replace("T", " ") + " UTC"))
    releases = {r.get("version") for r in get("releases?per_page=50")}
    for version in ("1.14.0+0", fix):
        if version in releases:
            print("  ok    release %s is in Memfault (its symbols too: it was built and uploaded together)" % version)
        else:
            print("  FAIL  release %s is not in Memfault" % version); ok = False
    print("  note  the crash demonstration %s is a test image: its symbols are uploaded, it has no release (docs/memfault.md)" % crash)
    issues = get("issues?per_page=50")
    print("  note  %d issue(s) so far; the crash demonstration adds one with its backtrace" % len(issues))
except Exception as error:
    print("  FAIL  Memfault could not be asked: %s" % str(error)[:120]); ok = False
sys.exit(0 if ok else 1)
PY
fi

echo "AWS"
if command -v aws >/dev/null && aws sts get-caller-identity --profile "${AWS_PROFILE:-cranium}" >/dev/null 2>&1; then
  state="$(aws cloudformation describe-stacks --profile "${AWS_PROFILE:-cranium}" --region "${AWS_REGION:-us-east-1}" --stack-name cranium-ota --query 'Stacks[0].StackStatus' --output text 2>/dev/null)"
  case "$state" in *COMPLETE) [[ "$state" == *ROLLBACK* ]] && bad "stack $state" || ok "stack $state" ;; *) bad "stack ${state:-unknown}" ;; esac
else
  note "not signed in to AWS: the stack was not checked (aws login --profile cranium, for the live logs too)"
fi

echo
if [ "$failed" = 0 ]; then echo "Ready for the demonstration (docs/fleet-demo.md)."; else echo "Something above needs fixing before the demonstration."; fi
exit "$failed"
