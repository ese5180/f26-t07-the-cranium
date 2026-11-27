#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [ "$(uname -s)/$(uname -m)" != Linux/aarch64 ]; then
  echo 'Run this on ARM64 Debian 12 Bookworm, not the Mac host.' >&2
  exit 1
fi
. /etc/os-release
if [ "$VERSION_ID" != 12 ]; then
  echo 'This dependency list targets Debian 12 Bookworm.' >&2
  exit 1
fi
mapfile -t packages < <(tr '[:space:]' '\n' < "$root/cranium-nauticmixxx/cranium/build-dependencies.txt" | sed '/^$/d')
sudo apt-get update
sudo apt-get install -y "${packages[@]}"
