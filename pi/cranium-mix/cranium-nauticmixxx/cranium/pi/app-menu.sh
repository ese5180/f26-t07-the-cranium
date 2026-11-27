#!/bin/bash
if [ ! -f "$XDG_RUNTIME_DIR/cranium-developer" ]; then
  exec /usr/local/bin/cranium-session kiosk
fi
exec swaynag -t warning --layer overlay -m 'CRANIUM Developer Tools' \
  -Z 'CRANIUM' '/usr/local/bin/cranium-launch nauticmixxx' \
  -Z 'BiteDJ' '/usr/local/bin/cranium-launch bitedj' \
  -Z 'Mixxx' '/usr/local/bin/cranium-launch mixxx' \
  -Z 'PERFORMANCE' 'foot -e /usr/local/bin/cranium-performance --seconds 120 --interval 5 --show' \
  --dismiss-button 'Cancel' --background '161616' --button-background '333333'
