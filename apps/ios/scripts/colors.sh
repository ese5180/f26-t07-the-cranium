#!/usr/bin/env bash
#
# Make the app's colours from the web console's own: every colour token of
# cloud/web/src/site/assets/app.css becomes a colour set in App/Assets.xcassets/Console/, with its
# light and its dark value, so that the app and the console are one palette.
#
#   apps/ios/scripts/colors.sh
#
# Two families come out of it:
#   Page<Name>    the tokens of :root, light, and of :root in prefers-color-scheme: dark
#   Panel<Name>   the tokens of an ink panel (.on-ink), which is dark in both themes, with the
#                 lighter ink the stylesheet gives it on a dark page
# App/Theme.swift names them. Run this again after the console's colours change; the colour sets
# are in git, so a build does not need it.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSS="$IOS_DIR/../../cloud/web/src/site/assets/app.css"
OUT="$IOS_DIR/App/Assets.xcassets/Console"

[ -f "$CSS" ] || { echo "error: $CSS not found" >&2; exit 1; }

python3 -I - "$CSS" "$OUT" <<'PY'
import json, os, re, shutil, sys

css_path, out = sys.argv[1], sys.argv[2]
css = open(css_path, encoding="utf-8").read()
css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)

def block_after(start):
    """The text between the brace that follows `start` and the brace that closes it."""
    open_at = css.index("{", start)
    depth, index = 0, open_at
    while True:
        if css[index] == "{": depth += 1
        elif css[index] == "}":
            depth -= 1
            if depth == 0: return css[open_at + 1:index]
        index += 1

def tokens(text):
    found = {}
    for name, value in re.findall(r"--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;", text):
        found[name] = value.lower()
    return found

light = tokens(block_after(css.index(":root {")))
dark_media = block_after(css.index("@media (prefers-color-scheme: dark)"))
dark = tokens(dark_media[dark_media.index(":root"):])
ink_start = css.index(".on-ink,\n.execution:not(.is-idle, .is-compact) {")
panel = tokens(block_after(ink_start))
dark_ink_media = css.index("@media (prefers-color-scheme: dark)", ink_start)
panel_dark = tokens(block_after(css.index(".on-ink", dark_ink_media)))

def camel(name):
    return "".join(part[:1].upper() + part[1:] for part in name.split("-"))

def components(hex_value):
    r, g, b = (int(hex_value[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return {"alpha": "1.000", "red": f"{r:.3f}", "green": f"{g:.3f}", "blue": f"{b:.3f}"}

def colorset(name, light_value, dark_value):
    folder = os.path.join(out, f"{name}.colorset")
    os.makedirs(folder, exist_ok=True)
    content = {
        "colors": [
            {"color": {"color-space": "srgb", "components": components(light_value)}, "idiom": "universal"},
            {
                "appearances": [{"appearance": "luminosity", "value": "dark"}],
                "color": {"color-space": "srgb", "components": components(dark_value)},
                "idiom": "universal",
            },
        ],
        "info": {"author": "xcode", "version": 1},
    }
    with open(os.path.join(folder, "Contents.json"), "w", encoding="utf-8") as handle:
        json.dump(content, handle, indent=2)
        handle.write("\n")

shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
with open(os.path.join(out, "Contents.json"), "w", encoding="utf-8") as handle:
    json.dump({"info": {"author": "xcode", "version": 1}}, handle, indent=2)
    handle.write("\n")

made = 0
for name, value in light.items():
    colorset("Page" + camel(name), value, dark.get(name, value))
    made += 1
# Inside an ink panel: its own value where it has one, else the page's dark one.
for name in light:
    base = panel.get(name, dark.get(name, light[name]))
    colorset("Panel" + camel(name), base, panel_dark.get(name, base))
    made += 1
print(f"made {made} colour sets in {out}")
PY
