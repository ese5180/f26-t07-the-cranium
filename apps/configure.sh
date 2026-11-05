#!/usr/bin/env bash
#
# Write apps/config/cranium.json, which both phone apps read at build time, from the deployed
# stack's outputs in cloud/.deploy/outputs.json (written by cloud/deploy.sh).
#
# The file names the AWS account, so git ignores it and it never goes in the public repository.
# See docs/mobile-apps.md.
#
# The customer side of the apps (docs/mobile-apps.md, "Customers") needs the customer pool and the
# phone apps' client of it, from console 2.0.1 on. A stack without them gets a file without the
# four customer keys: the apps then sign in admins only, and say so.

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
console = outputs["ConsoleUrl"].rstrip("/")
config = {"consoleUrl": console}
# The customer pool is in the stack's Region too. Its API is the console's API under /api/c/, on the
# customer site's name once that is set, else on the console's.
customer = [k for k in ("CustomerUserPoolId", "CustomerMobileClientId") if outputs.get(k)]
if len(customer) == 2:
    if not outputs["CustomerUserPoolId"].startswith(outputs["Region"] + "_"):
        sys.exit("error: the customer pool " + outputs["CustomerUserPoolId"] + " is not in " + outputs["Region"])
    config.update({
        "customerApiUrl": (outputs.get("CustomerUrl") or console).rstrip("/"),
        "customerClientId": outputs["CustomerMobileClientId"],
        "customerRegion": outputs["Region"],
        "customerUserPoolId": outputs["CustomerUserPoolId"],
    })
else:
    print("note: the stack has no CustomerMobileClientId yet (console 2.0.1): the apps will sign in admins only."
          " Deploy the current cloud/infra/template.yaml, then run this again.", file=sys.stderr)
config.update({
    "loginDomain": "https://" + outputs["LoginDomain"].removeprefix("https://").rstrip("/"),
    "mobileClientId": outputs["MobileClientId"],
    "redirectUri": "cranium://signin",
    "region": outputs["Region"],
    "userPoolId": outputs["UserPoolId"],
})
os.makedirs(os.path.dirname(sys.argv[2]), exist_ok=True)
with open(sys.argv[2], "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
print("wrote", os.path.relpath(sys.argv[2]))
PY
