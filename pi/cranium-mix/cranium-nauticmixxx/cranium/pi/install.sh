#!/bin/bash
# Restore normal boot before attempting installation; always return to a normal boot.
set -u
package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
exec >> "$package/install.log" 2>&1
cd "$package" || exit 1
echo "CRANIUM update: $(date -u)"
sha256sum --check cmdline.before.sha256 || exit 1
cp cmdline.before.txt /boot/firmware/cmdline.txt || exit 1
sync
/usr/bin/python3 "$package/installer.py"
result=$?
echo "Installer exit: $result"
sync
exit 0
