#!/usr/bin/env bash
#
# Run a heavy command (a build, a whole test suite) one at a time on this computer, and only when there is
# memory for it. scripts/ci/local-ci.sh runs its heavy jobs through this when no other gate is set up
# (docs/ci.md, "Local CI (GitHub Actions is off)").
#
#   scripts/ci/heavy.sh make -C firmware/tests/host
#
# It waits for its turn, then for at least CRANIUM_HEAVY_NEED_GB gigabytes of memory to be available
# (default 3), then runs the command with a lower priority and exits with its status. The turn is a
# folder lock holding the holder's process ID, shared by every checkout of this user; a lock whose holder
# has died, or that has had no process ID for a minute, is taken over. The command runs with
# CRANIUM_HEAVY_HELD=1, so that scripts/ci/local-ci.sh under it takes no second turn. The memory check
# reads vm_stat on macOS and /proc/meminfo on Linux; elsewhere (Git Bash on Windows) it only takes turns.

set -u

lock="${CRANIUM_HEAVY_LOCK:-${TMPDIR:-/tmp}/cranium-heavy-$(id -u 2> /dev/null || echo user).lock}"
need_gb="${CRANIUM_HEAVY_NEED_GB:-3}"

if [ $# -eq 0 ]; then
  sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
fi

# Gigabytes available now, with one decimal, or nothing when this system has no way to tell.
available_gb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemAvailable:/ { printf "%.1f", $2 / 1e6 }' /proc/meminfo
  elif command -v vm_stat > /dev/null 2>&1; then
    vm_stat | awk '/page size of/ { size = $8 }
      /Pages free/ { free = $3 } /Pages inactive/ { inactive = $3 } /Pages speculative/ { speculative = $3 }
      END { gsub("\\.", "", free); gsub("\\.", "", inactive); gsub("\\.", "", speculative)
        printf "%.1f", (free + inactive + speculative) * size / 1e9 }'
  fi
}

# A lock is stale when its holder has died, or when it has had no process ID for a minute (its holder
# was stopped between making it and writing the ID). It is taken over by renaming it first, which only
# one waiter can do, so that two waiters never both remove it and both run.
stale() {
  local holder age
  holder="$(cat "$lock/pid" 2> /dev/null || true)"
  if [ -n "$holder" ]; then
    ! kill -0 "$holder" 2> /dev/null
    return
  fi
  age=$(($(date +%s) - $(stat -c %Y "$lock" 2> /dev/null || stat -f %m "$lock" 2> /dev/null || date +%s)))
  [ "$age" -gt 60 ]
}

waited=0
until mkdir "$lock" 2> /dev/null; do
  holder="$(cat "$lock/pid" 2> /dev/null || true)"
  # Only the waiter that holds $lock.takeover judges and renames a stale lock, so no waiter renames a lock
  # that another has just made after both found the old one stale. One left by a waiter that died in it
  # is cleared after a minute.
  if mkdir "$lock.takeover" 2> /dev/null; then
    if [ -d "$lock" ] && stale && mv "$lock" "$lock.stale.$$" 2> /dev/null; then
      rm -rf "$lock.stale.$$"
      rmdir "$lock.takeover"
      continue
    fi
    rmdir "$lock.takeover"
  elif [ -n "$(find "$lock.takeover" -maxdepth 0 -mmin +1 2> /dev/null)" ]; then
    rmdir "$lock.takeover" 2> /dev/null || true
  fi
  [ $((waited % 60)) -eq 0 ] && echo "heavy.sh: waiting for another heavy job (pid ${holder:-?}) to finish" >&2
  sleep 5
  waited=$((waited + 5))
done
echo $$ > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock" 2> /dev/null || true' EXIT
trap 'exit 130' INT TERM

waited=0
while :; do
  now="$(available_gb)"
  [ -n "$now" ] || break
  awk -v a="$now" -v n="$need_gb" 'BEGIN { exit !(a < n) }' || break
  [ $((waited % 60)) -eq 0 ] && echo "heavy.sh: waiting for ${need_gb} GB of memory (now ${now} GB)" >&2
  sleep 10
  waited=$((waited + 10))
done

export CRANIUM_HEAVY_HELD=1
if command -v nice > /dev/null 2>&1; then
  nice -n 10 "$@"
else
  "$@"
fi
