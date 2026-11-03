#!/usr/bin/env bash
#
# Write apps/config/cranium.json, which both phone apps read at build time, from the deployed
# stack's outputs in cloud/.deploy/outputs.json (written by cloud/deploy.sh).
#
# The file names the AWS account, so git ignores it and it never goes in the public repository.
# See docs/mobile-apps.md.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUTS="$REPO_DIR/cloud/.deploy/outputs.json"
CONFIG="$REPO_DIR/apps/config/cranium.json"

[ -f "$OUTPUTS" ] || { echo "error: $OUTPUTS not found: run cloud/deploy.sh, or copy it from whoever deployed" >&2; exit 1; }

python3 -I - "$OUTPUTS" "$CONFIG" <<'PY'
import json, os, sys
outputs = json.load(open(sys.argv[1]))
missing = [k for k in ("ConsoleUrl", "LoginDomain", "MobileClientId", "Region", "UserPoolId") if not outputs.get(k)]
if missing:
    sys.exit("error: the stack has no " + ", ".join(missing) + ": deploy the current cloud/infra/template.yaml first")
# The apps' own sign-in screen talks to the user pool itself (SRP), as the console's page does:
# it needs the pool and its Region, and the pool's ID begins with the Region.
if not outputs["UserPoolId"].startswith(outputs["Region"] + "_"):
    sys.exit("error: the user pool " + outputs["UserPoolId"] + " is not in " + outputs["Region"])
config = {
    "consoleUrl": outputs["ConsoleUrl"].rstrip("/"),
    "loginDomain": "https://" + outputs["LoginDomain"].removeprefix("https://").rstrip("/"),
    "mobileClientId": outputs["MobileClientId"],
    "redirectUri": "cranium://signin",
    "region": outputs["Region"],
    "userPoolId": outputs["UserPoolId"],
}
os.makedirs(os.path.dirname(sys.argv[2]), exist_ok=True)
with open(sys.argv[2], "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
print("wrote", os.path.relpath(sys.argv[2]))
PY
