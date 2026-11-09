#!/usr/bin/env bash
#
# Put the Bluetooth controller on a board's network core, over the debug port. This is the one step
# of moving a board to firmware 1.9.0 and later that cannot go over the air: MCUboot only updates the
# application core, and the network core has no bootloader of its own here. It is needed once per
# board, and only on a board whose network core still has the blinky from before 1.9.0.
#
#   scripts/board/flash-netcore.sh                      flash build/hci_ipc, from scripts/firmware/build.sh
#   scripts/board/flash-netcore.sh --serial-number <n>  on that probe (nrfutil device list shows it)
#   scripts/board/flash-netcore.sh --dry-run            say what would be done, and do nothing
#
# Only the network core's own flash is written, and only the pages the image covers. The application
# core is not touched: its bootloader, firmware, TF-M storage (the board's ID, Wi-Fi network, key and
# certificates) and the golden image stay as they are. The board restarts afterwards.
#
# Plug the board into the computer by USB (the debug port, J2), and close any serial terminal on it.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NRFUTIL="${NRFUTIL:-$HOME/.nrfutil/bin/nrfutil}"
HEX="$REPO_DIR/build/hci_ipc/zephyr/zephyr.hex"
serial=""
dry_run=false

die() {
  echo "error: $1" >&2
  [ $# -lt 2 ] || echo "$2" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --serial-number)
      [ $# -ge 2 ] || die "--serial-number needs a value"
      serial="$2"
      shift
      ;;
    --dry-run) dry_run=true ;;
    -h|--help)
      sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ -x "$NRFUTIL" ] || die "nrfutil was not found at $NRFUTIL" "Set NRFUTIL to where it is."
[ -f "$HEX" ] || die "there is no Bluetooth controller image at build/hci_ipc" \
  "Build first: scripts/firmware/build.sh --keep. From 1.9.0 every build makes it."
# The controller that scripts/firmware/build.sh made, and not something else left in build/.
grep -q '^CONFIG_BT_HCI_RAW=y$' "$REPO_DIR/build/hci_ipc/zephyr/.config" 2>/dev/null \
  || die "build/hci_ipc is not a Bluetooth controller build" "Build again: scripts/firmware/build.sh --keep."

if [ -z "$serial" ]; then
  probes="$("$NRFUTIL" device list --json 2>/dev/null \
    | python3 -I -c 'import json, sys
seen = set()
for line in sys.stdin:
    try:
        event = json.loads(line)
    except ValueError:
        continue
    for device in (event.get("data") or {}).get("devices", []):
        if device.get("serialNumber"):
            seen.add(device["serialNumber"])
print("\n".join(sorted(seen)))')"
  count="$(printf '%s' "$probes" | grep -c . || true)"
  [ "$count" -eq 1 ] || die "found $count debug probes, so it is not clear which board to flash" \
    "Plug in one board, or name its probe with --serial-number (nrfutil device list shows it)."
  serial="$probes"
fi

# shellcheck disable=SC2054 # the commas belong to the one --options value
program=("$NRFUTIL" device program --serial-number "$serial" --core Network --firmware "$HEX"
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ)
reset=("$NRFUTIL" device reset --serial-number "$serial" --reset-kind RESET_PIN)

echo "Network core of the board on probe $serial: Bluetooth controller from build/hci_ipc"
echo "The application core is not touched."
if [ "$dry_run" = true ]; then
  printf '  would run:'; printf ' %q' "${program[@]}"; echo
  printf '  would run:'; printf ' %q' "${reset[@]}"; echo
  exit 0
fi

"${program[@]}"
"${reset[@]}"
echo
echo "Done. The board restarts on the firmware it had. Once it runs 1.9.0 or later, hold Button 1 for"
echo "5 s: LED1 flashes four times and a phone can find it as Cranium- and four hex digits."
