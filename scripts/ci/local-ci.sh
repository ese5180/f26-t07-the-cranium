#!/usr/bin/env bash
#
# Local CI: the checks that GitHub Actions ran for this repository, run on your own computer instead.
# GitHub Actions is off for this repository (docs/ci.md, "Local CI (GitHub Actions is off)").
#
#   scripts/ci/local-ci.sh                 the jobs that the changes against origin/main call for
#   scripts/ci/local-ci.sh --all           every job
#   scripts/ci/local-ci.sh --job NAME      that job only; repeat it for more ("firmware" is all three builds)
#   scripts/ci/local-ci.sh --list          which jobs would run, and why, without running any
#   scripts/ci/local-ci.sh --doctor        what this computer can run, and what to install for the rest
#   scripts/ci/local-ci.sh --post          after the run, set the commit status "local-ci" on HEAD on GitHub
#   --base REF                             compare with REF instead of origin/main
#   --install-packages                     on Linux or Windows, also install the desktop app's package, start
#                                          it and remove it again, as the packaging workflows did
#
# The jobs are those of .github/workflows/ci.yml, lint.yml, codeql.yml, cranium-mix.yml, firmware-image.yml,
# desktop-linux.yml and desktop-windows.yml, which this script only reads. Heavy jobs wait their turn
# through a memory gate: CRANIUM_HEAVY if set ("off" for none), else ~/cranium-work/heavy.sh if there,
# else scripts/ci/heavy.sh. Nothing here uploads, flashes or deploys anything.
#
# Exit status: 0 when no job failed (a skip is never counted as a pass, and is listed as a skip), 1 when a
# job failed, 2 when a job the changes call for could not run on this computer, 3 when --post could not
# post. Logs: .local-ci/runs/<time>-<commit>/, the newest also at .local-ci/latest (not in git).

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$REPO/scripts/ci/local-ci.sh"
GH_REPO=ese5180/f26-t07-the-cranium
CI_DIR="$REPO/.local-ci"
CACHE="$CI_DIR/cache"
WORKFLOWS="$REPO/.github/workflows"
# The SDK version the firmware is built with, as scripts/firmware/build.sh pins it.
NCS_VERSION="$(sed -n 's/^NCS_VERSION=\(v[0-9][0-9.]*\)$/\1/p' "$REPO/scripts/firmware/build.sh")"
NCS_VERSION="${NCS_VERSION:-v3.4.0}"

JOBS="scan lint codeql host-tests python-tests closed-loop cloud-tests desktop-core android ios macos
  firmware-default firmware-no-bt firmware-nrf5340dk cranium-mix firmware-image desktop-linux desktop-windows"

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) OS=windows ;;
  *) OS=other ;;
esac

die() {
  echo "local-ci: $*" >&2
  exit 2
}

usage() {
  sed -n '3,23p' "$SELF" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------------------------------------
# The jobs: their names, workflows, the paths that call for them, and what they need.

job_title() {
  case "$1" in
    scan) echo "No private key in git" ;;
    lint) echo "Workflows, scripts and secrets" ;;
    codeql) echo "CodeQL" ;;
    host-tests) echo "Host tests" ;;
    python-tests) echo "Python tests" ;;
    closed-loop) echo "Closed-loop bench" ;;
    cloud-tests) echo "Cloud tests" ;;
    desktop-core) echo "Desktop app (core)" ;;
    android) echo "Android app" ;;
    ios) echo "iPhone app" ;;
    macos) echo "Mac app" ;;
    firmware-default) echo "Firmware (default)" ;;
    firmware-no-bt) echo "Firmware (no Bluetooth)" ;;
    firmware-nrf5340dk) echo "Firmware (nRF5340 DK)" ;;
    cranium-mix) echo "CRANIUM Mix host checks" ;;
    firmware-image) echo "Firmware build image" ;;
    desktop-linux) echo "Linux packages" ;;
    desktop-windows) echo "Windows installers" ;;
  esac
}

job_workflow() {
  case "$1" in
    lint) echo lint.yml ;;
    codeql) echo codeql.yml ;;
    cranium-mix) echo cranium-mix.yml ;;
    firmware-image) echo firmware-image.yml ;;
    desktop-linux) echo desktop-linux.yml ;;
    desktop-windows) echo desktop-windows.yml ;;
    *) echo ci.yml ;;
  esac
}

# The changed paths that call for a job (shell patterns, where * crosses folders). ci.yml itself has no
# path filters: these are the folders each job builds or reads, with the files its tests read from
# elsewhere (the cloud tests read apps/, firmware/ and docs/, and every app carries cloud/web's pages).
# The other workflows' filters are copied as they are.
job_paths() {
  local bundle="apps/shared/* apps/config/* cloud/web/* cloud/VERSION"
  local firmware="firmware/app/* firmware/netcore/* firmware/keys/* firmware/certs/* firmware/golden.json"
  firmware="$firmware tools/* scripts/firmware/build.sh"
  case "$1" in
    scan | lint | codeql) echo "*" ;;
    host-tests) echo "firmware/* .github/workflows/ci.yml" ;;
    python-tests) echo "firmware/* tools/* scripts/board/* scripts/firmware/* .github/workflows/ci.yml" ;;
    closed-loop) echo "closed-loop/* .github/workflows/ci.yml" ;;
    cloud-tests)
      echo "cloud/* apps/* firmware/app/* firmware/certs/* firmware/keys/* firmware/golden.json"
      echo "scripts/firmware/* binaries/golden/* docs/* .prettierrc* .prettierignore .github/workflows/ci.yml"
      ;;
    desktop-core) echo "apps/desktop/* $bundle .github/workflows/ci.yml" ;;
    android) echo "apps/android/* $bundle .github/workflows/ci.yml" ;;
    ios) echo "apps/ios/* $bundle .github/workflows/ci.yml" ;;
    macos) echo "apps/macos/* $bundle .github/workflows/ci.yml" ;;
    firmware-default | firmware-no-bt | firmware-nrf5340dk) echo "$firmware .github/workflows/ci.yml" ;;
    cranium-mix) echo "pi/cranium-mix/* .github/workflows/cranium-mix.yml" ;;
    firmware-image) echo "tools/firmware-image/* .github/workflows/firmware-image.yml" ;;
    desktop-linux | desktop-windows)
      echo "apps/desktop/* apps/shared/* apps/config/cranium.example.json cloud/web/src/*"
      echo "cloud/web/build-bundle.mjs cloud/VERSION .github/workflows/$1.yml"
      ;;
  esac
}

# Light jobs run at once; the rest go through the memory gate, one at a time.
job_heavy() {
  case "$1" in scan | lint) return 1 ;; esac
  return 0
}

# A skip of these never makes the run incomplete: CodeQL, the image and the packages were never checks
# of a pull request on Actions either (codeql.yml was, and needs a CLI of about a gigabyte), and the Mac
# app's job was allowed to fail.
job_optional() {
  case "$1" in codeql | firmware-image | desktop-linux | desktop-windows | macos) return 0 ;; esac
  return 1
}

# The Mac app's job had continue-on-error: a failure is shown and does not fail the run.
job_may_fail() {
  [ "$1" = macos ]
}

# ---------------------------------------------------------------------------------------------------------
# What this computer has. Found once, then handed to each job through the environment.

have() {
  command -v "$1" > /dev/null 2>&1
}

# "v3.4.0" for an SDK folder, from its nrf/VERSION, or nothing.
sdk_version_of() {
  [ -f "$1/nrf/VERSION" ] || return 0
  awk '$1 == "VERSION_MAJOR" { a = $3 } $1 == "VERSION_MINOR" { b = $3 } $1 == "PATCHLEVEL" { c = $3 }
    $1 == "EXTRAVERSION" { e = $3 } END { printf "v%s.%s.%s%s", a, b, c, (e == "" ? "" : "-" e) }' "$1/nrf/VERSION"
}

find_nrfutil() {
  local candidate
  for candidate in "${NRFUTIL:-}" "$HOME/.nrfutil/bin/nrfutil" "$(command -v nrfutil 2> /dev/null)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 0
}

# The nRF Connect SDK of NCS_VERSION, into NCS: ZEPHYR_BASE's, NCS_DIR, nrfutil's install folder, then
# where nrfutil puts it on each system. One of another version is passed over, and named in SDK_NOTE.
find_ncs() {
  local install_dir="" candidate version
  NCS=""
  if [ -n "$NRFUTIL_BIN" ]; then
    install_dir="$("$NRFUTIL_BIN" sdk-manager config show 2> /dev/null | awk '$1 == "install-dir:" && $2 != "unset" { print $2; exit }')"
  fi
  for candidate in "${ZEPHYR_BASE:+$(dirname "$ZEPHYR_BASE")}" "${NCS_DIR:-}" \
    "${install_dir:+$install_dir/$NCS_VERSION}" "/opt/nordic/ncs/$NCS_VERSION" "$HOME/ncs/$NCS_VERSION" \
    "/c/ncs/$NCS_VERSION" "$HOME/ncs"; do
    [ -n "$candidate" ] && [ -d "$candidate/zephyr" ] || continue
    version="$(sdk_version_of "$candidate")"
    if [ -n "$version" ] && [ "$version" != "$NCS_VERSION" ]; then
      SDK_NOTE="${SDK_NOTE:+$SDK_NOTE; }$candidate is $version, not $NCS_VERSION"
      continue
    fi
    NCS="$(cd "$candidate" && pwd)"
    return 0
  done
  return 0
}

# The toolchain's python3 for NCS_VERSION, as nrfutil names it, else from the toolchains' index.
find_toolchain_python() {
  local dir index id
  if [ -n "$NRFUTIL_BIN" ]; then
    dir="$("$NRFUTIL_BIN" sdk-manager toolchain env --ncs-version "$NCS_VERSION" --as-script sh 2> /dev/null |
      sed -n 's/^export PATH=\([^:]*\):.*/\1/p' | head -n 1)"
    [ -n "$dir" ] && [ -x "$dir/python3" ] && { echo "$dir/python3"; return 0; }
  fi
  [ -n "$NCS" ] || return 0
  index="$(dirname "$NCS")/toolchains/toolchains.json"
  [ -f "$index" ] || return 0
  id="$(awk -v want="\"$NCS_VERSION\"" '/"bundle_id"/ { gsub(/[",]/, "", $2); id = $2 }
    { gsub(/[ ,]/, "") } $0 == want { print id; exit }' "$index")"
  [ -n "$id" ] && [ -x "$(dirname "$index")/$id/bin/python3" ] && echo "$(dirname "$index")/$id/bin/python3"
  return 0
}

# What firmware/tests/requirements.txt asks for: the Python tests, imgtool and the firmware jobs' tools.
python_has_requirements() {
  "$1" -c 'import cbor2, click, cryptography, intelhex, serial, yaml' > /dev/null 2>&1
}

# A Python with those packages: CRANIUM_PYTHON, the SDK toolchain's, python3 on the PATH, or the one this
# script made before in .local-ci/cache/venv. Without any, a job makes that one (ensure_python).
find_python() {
  local candidate path
  for candidate in "${CRANIUM_PYTHON:-}" "$TOOLCHAIN_PY" python3.12 python3 python \
    "$CACHE/venv/bin/python3" "$CACHE/venv/Scripts/python.exe"; do
    [ -n "$candidate" ] || continue
    path="$(command -v "$candidate" 2> /dev/null)" || continue
    python_has_requirements "$path" && { echo "$path"; return 0; }
  done
  return 0
}

# Any Python 3.10 or newer, to make a virtual environment from; 3.12 first, as on Actions.
find_base_python() {
  local candidate path
  for candidate in python3.12 "$TOOLCHAIN_PY" python3 python; do
    [ -n "$candidate" ] || continue
    path="$(command -v "$candidate" 2> /dev/null)" || continue
    "$path" -c 'import sys, venv; sys.exit(sys.version_info < (3, 10))' 2> /dev/null && { echo "$path"; return 0; }
  done
  return 0
}

# A JDK of 17 or newer, 17 first, as on Actions.
java_ok() {
  [ -x "$1/bin/java" ] && "$1/bin/java" -version 2>&1 |
    awk -F'"' '/version/ { split($2, v, "."); exit !(v[1] + 0 >= 17) }'
}

find_java() {
  local candidate
  for candidate in "${JAVA_HOME:-}" \
    "$([ "$OS" = macos ] && /usr/libexec/java_home -v 17 2> /dev/null)" \
    /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
    /usr/lib/jvm/java-17-openjdk* /usr/lib/jvm/temurin-17* \
    "$([ "$OS" = macos ] && /usr/libexec/java_home 2> /dev/null)" \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home /usr/lib/jvm/java-21-openjdk* \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home" "/c/Program Files/Android/Android Studio/jbr"; do
    [ -n "$candidate" ] && java_ok "$candidate" && { echo "$candidate"; return 0; }
  done
  return 0
}

# ANDROID_HOME, local.properties (this checkout's, or the main checkout's for a git worktree), then where
# Android Studio, Homebrew and Debian put the SDK.
find_android_sdk() {
  local candidate properties main from_properties=""
  main="$(cd "$REPO" && git rev-parse --path-format=absolute --git-common-dir 2> /dev/null)"
  for properties in "$REPO/apps/android/local.properties" "${main:+$(dirname "$main")/apps/android/local.properties}"; do
    if [ -z "$from_properties" ] && [ -f "$properties" ]; then
      from_properties="$(sed -n 's/^sdk\.dir=//p' "$properties" | head -n 1)"
    fi
  done
  for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$from_properties" "$HOME/Library/Android/sdk" \
    /opt/homebrew/share/android-commandlinetools /usr/local/share/android-commandlinetools "$HOME/Android/Sdk" \
    /usr/lib/android-sdk "${LOCALAPPDATA:+$LOCALAPPDATA/Android/Sdk}"; do
    [ -n "$candidate" ] && [ -d "$candidate/platforms" ] && { echo "$candidate"; return 0; }
  done
  return 0
}

find_gate() {
  case "${CRANIUM_HEAVY:-}" in
    off | none | 0) echo "" ;;
    "") if [ -x "$HOME/cranium-work/heavy.sh" ]; then echo "$HOME/cranium-work/heavy.sh"; else echo "$REPO/scripts/ci/heavy.sh"; fi ;;
    *) echo "$CRANIUM_HEAVY" ;;
  esac
}

detect() {
  SDK_NOTE=""
  NRFUTIL_BIN="$(find_nrfutil)"
  find_ncs
  TOOLCHAIN_PY="$(find_toolchain_python)"
  PY="$(find_python)"
  BASE_PY="$(find_base_python)"
  JDK="$(find_java)"
  ANDROID_SDK="$(find_android_sdk)"
  GATE="$(find_gate)"
  NODE_MAJOR=""
  have node && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null)"
  export LOCALCI_NCS="$NCS" LOCALCI_PY="$PY" LOCALCI_BASE_PY="$BASE_PY" LOCALCI_NRFUTIL="$NRFUTIL_BIN"
  export LOCALCI_JDK="$JDK" LOCALCI_ANDROID_SDK="$ANDROID_SDK"
}

# Why a job cannot run here, as "kind|reason", or nothing when it can. The kinds: os (not on this system),
# tool (something to install), absent (not in this tree), design (never run locally).
job_blocker() {
  local missing=""
  case "$1" in
    scan) ;;
    lint)
      for tool in shellcheck actionlint gitleaks; do have "$tool" || missing="$missing $tool"; done
      [ -z "$missing" ] || echo "tool|install${missing} (brew install shellcheck actionlint gitleaks; on Linux their release binaries, at the versions lint.yml names)"
      ;;
    codeql) have codeql || echo "tool|the CodeQL CLI is not installed (github.com/github/codeql-action/releases, about 1 GB with its query packs)" ;;
    host-tests | python-tests)
      have make || missing="$missing make"
      have cc || have gcc || have clang || missing="$missing a C compiler"
      [ -n "$NCS" ] || have git || missing="$missing git"
      if [ "$1" = python-tests ] && [ -z "$PY" ] && [ -z "$BASE_PY" ]; then missing="$missing Python 3.10+"; fi
      [ -z "$missing" ] || echo "tool|install${missing}"
      ;;
    closed-loop)
      if [ "$OS" = windows ]; then
        echo "os|needs macOS or Linux (the bench runs .venv/bin/python)"
      elif [ ! -x "$REPO/closed-loop/.venv/bin/python" ] && [ -z "$BASE_PY" ]; then
        echo "tool|install Python 3.12"
      fi
      ;;
    cloud-tests)
      have node && have npx || echo "tool|install Node.js 22"
      ;;
    desktop-core)
      if ! have node || ! have npm; then
        echo "tool|install Node.js 22"
      elif [ "$OS" = linux ] && [ -z "${DISPLAY:-}" ] && ! have xvfb-run; then
        echo "tool|install xvfb (sudo apt-get install xvfb libgbm1 libnss3 libasound2t64), or run with a display"
      fi
      ;;
    android)
      [ -n "$JDK" ] || missing="$missing JDK 17 (brew install openjdk@17, or set JAVA_HOME)"
      [ -n "$ANDROID_SDK" ] || missing="$missing the Android SDK (Android Studio, or set ANDROID_HOME)"
      have node || missing="$missing Node.js 22"
      [ -z "$missing" ] || echo "tool|install${missing}"
      ;;
    ios | macos)
      if [ "$OS" != macos ]; then
        echo "os|needs macOS (Xcode)"
      else
        have xcodebuild || missing="$missing Xcode"
        have xcodegen || missing="$missing xcodegen (brew install xcodegen)"
        [ "$1" = macos ] || have node || missing="$missing Node.js 22"
        [ -z "$missing" ] || echo "tool|install${missing}"
      fi
      ;;
    firmware-default | firmware-no-bt | firmware-nrf5340dk)
      if [ "$OS" = windows ]; then
        echo "os|scripts/firmware/build.sh runs on macOS and Linux"
      else
        [ -n "$NRFUTIL_BIN" ] || missing="$missing nrfutil (docs/new-board-setup.md)"
        [ -n "$NCS" ] || missing="$missing the nRF Connect SDK $NCS_VERSION with its toolchain (nrfutil sdk-manager install $NCS_VERSION, or set NCS_DIR)"
        [ -n "$PY" ] || [ -n "$BASE_PY" ] || missing="$missing Python 3.10+"
        [ -z "$missing" ] || echo "tool|install${missing}${SDK_NOTE:+ ($SDK_NOTE)}"
      fi
      ;;
    cranium-mix)
      if [ ! -d "$REPO/pi/cranium-mix" ]; then
        echo "absent|pi/cranium-mix is not in this tree"
      else
        have node || missing="$missing Node.js 22"
        [ -n "$BASE_PY" ] || missing="$missing Python 3.12"
        [ -z "$missing" ] || echo "tool|install${missing}"
      fi
      ;;
    firmware-image)
      echo "design|builds a multi-gigabyte toolchain image and publishes it to GitHub Packages; build it by hand with docker build tools/firmware-image"
      ;;
    desktop-linux)
      if [ "$OS" != linux ]; then
        echo "os|needs Linux (.deb, .rpm and AppImage); its tests and the app's start are in desktop-core"
      else
        for tool in node npm dpkg-deb rpm; do have "$tool" || missing="$missing $tool"; done
        [ -n "${DISPLAY:-}" ] || have xvfb-run || missing="$missing xvfb-run"
        [ -z "$missing" ] || echo "tool|install${missing} (apps/desktop/scripts/ci-setup-linux.sh installs rpm)"
      fi
      ;;
    desktop-windows)
      if [ "$OS" != windows ]; then
        echo "os|needs Windows (the installers); its tests and the app's start are in desktop-core"
      else
        for tool in node npm powershell; do have "$tool" || missing="$missing $tool"; done
        [ -z "$missing" ] || echo "tool|install${missing}"
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------
# Which files changed, and which jobs they call for.

BASE_REF=origin/main
CHANGED=""

changed_files() {
  local merge_base
  git -C "$REPO" rev-parse --verify --quiet "$BASE_REF^{commit}" > /dev/null ||
    die "no $BASE_REF here: git fetch origin, or name another with --base"
  merge_base="$(git -C "$REPO" merge-base "$BASE_REF" HEAD)" || die "HEAD and $BASE_REF have no common commit"
  {
    git -C "$REPO" diff --name-only "$merge_base" HEAD
    # What is not committed yet counts too, so that a run before a commit checks it.
    git -C "$REPO" diff --name-only HEAD
    git -C "$REPO" ls-files --others --exclude-standard
  } | sort -u
}

# The first changed file that calls for a job, with how many more do, or nothing.
job_reason() {
  local job="$1" patterns pattern file first="" count=0
  patterns="$(job_paths "$job")"
  if [ "$patterns" = "*" ]; then
    echo "every change"
    return 0
  fi
  # The patterns are matched against the changed names, never expanded against the files on disk.
  set -f
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    for pattern in $patterns; do
      # shellcheck disable=SC2254 # the patterns are meant as patterns
      case "$file" in $pattern)
        count=$((count + 1))
        [ -n "$first" ] || first="$file"
        break
        ;;
      esac
    done
  done <<< "$CHANGED"
  set +f
  [ "$count" -eq 0 ] && return 0
  if [ "$count" -eq 1 ]; then echo "$first"; else echo "$first and $((count - 1)) more"; fi
}

expand_job() {
  case "$1" in
    firmware) echo firmware-default firmware-no-bt firmware-nrf5340dk ;;
    *)
      for known in $JOBS; do [ "$known" = "$1" ] && { echo "$1"; return 0; }; done
      die "no job named $1; the jobs: $(echo $JOBS) (and firmware, for all three builds)"
      ;;
  esac
}

# Configurations of ci.yml's firmware matrix that this script does not build: a branch that adds one has
# to add it here too.
unknown_firmware_configurations() {
  [ -f "$WORKFLOWS/ci.yml" ] || return 0
  sed -n 's/^ *- configuration: *//p' "$WORKFLOWS/ci.yml" | while IFS= read -r name; do
    case "$name" in default | "no Bluetooth" | "nRF5340 DK") ;; *) echo "$name" ;; esac
  done
}

# ---------------------------------------------------------------------------------------------------------
# The jobs themselves. Each runs in a process of its own (through the gate when heavy), in the root of the
# checkout, and stops at its first failing step.

step() {
  echo
  echo "==> $*"
}

# A folder whose python3 runs $1, first on the PATH. A script, not a link: a link to a virtual
# environment's python, outside that environment, would not see its packages.
python_shim() {
  mkdir -p "$2"
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$1" > "$2/python3"
  chmod +x "$2/python3"
  export PATH="$2:$PATH"
}

# PATH starts with a folder whose python3 is the Python with the test requirements, as on Actions, where
# that Python was the only one. Made in .local-ci/cache/venv when this computer has none.
ensure_python() {
  local py="$LOCALCI_PY" shim="$CACHE/python-shim"
  if [ -z "$py" ]; then
    step "No Python here has firmware/tests/requirements.txt: making .local-ci/cache/venv"
    [ -n "$LOCALCI_BASE_PY" ] || { echo "no Python 3.10+ found" >&2; return 1; }
    "$LOCALCI_BASE_PY" -m venv "$CACHE/venv"
    py="$CACHE/venv/bin/python3"
    [ -x "$py" ] || py="$CACHE/venv/Scripts/python.exe"
    "$py" -m pip install --quiet --requirement firmware/tests/requirements.txt
  fi
  python_shim "$py" "$shim"
  echo "python3 is $py ($("$py" --version 2>&1))"
}

# ZEPHYR_BASE for the host and Python tests: the SDK's, else the few files of it they read, fetched once
# into .local-ci/cache/sdk-files by firmware/tests/fetch-sdk-files.sh, as on Actions.
ensure_zephyr_base() {
  if [ -n "$LOCALCI_NCS" ]; then
    export ZEPHYR_BASE="$LOCALCI_NCS/zephyr"
  else
    local files="$CACHE/sdk-files"
    if [ ! -f "$files/.complete" ]; then
      step "No nRF Connect SDK $NCS_VERSION here: fetching the files the tests read"
      rm -rf "$files"
      mkdir -p "$files"
      firmware/tests/fetch-sdk-files.sh "$files"
      touch "$files/.complete"
    fi
    export ZEPHYR_BASE="$files/zephyr"
  fi
  echo "ZEPHYR_BASE is $ZEPHYR_BASE"
}

# Runs a command for at most $1 seconds, also where there is no timeout(1).
run_with_timeout() {
  local seconds="$1"
  shift
  if have timeout; then
    timeout "$seconds" "$@"
    return
  fi
  "$@" &
  local pid=$! watchdog status
  (sleep "$seconds" && kill "$pid" 2> /dev/null) &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2> /dev/null
  wait "$watchdog" 2> /dev/null
  return "$status"
}

# Runs firmware/tests/hil/$1 and fails unless its last OK or FAILED line is one of the rest.
run_python_test() {
  local test="$1" log
  shift
  log="$(mktemp)"
  echo
  echo "--- $test"
  if [ "$test" = test_board.py ]; then
    python3 firmware/tests/hil/run_sharded.py --jobs 8 --split-classes "firmware/tests/hil/$test" 2>&1 | tee "$log"
  else
    python3 "firmware/tests/hil/$test" 2>&1 | tee "$log"
  fi
  local result want
  result="$(grep -E '^(OK|FAILED)' "$log" | tail -n 1)"
  rm -f "$log"
  for want in "$@"; do
    [ "$result" = "$want" ] && return 0
  done
  echo "error: $test ended with \"$result\", expected $(printf '"%s" ' "$@")(a new skip has to be listed in ci.yml and here, with its reason)" >&2
  return 1
}

job_scan() {
  scripts/ci/scan-tracked-files.sh
}

job_lint() {
  local pinned
  pinned="$(sed -n 's/^ *ACTIONLINT_VERSION: *//p' "$WORKFLOWS/lint.yml")"
  step "Workflows (actionlint $(actionlint -version | head -n 1), lint.yml pins $pinned)"
  actionlint
  step "Shell scripts (shellcheck $(shellcheck --version | sed -n 's/^version: //p'), warnings and errors)"
  git ls-files -z '*.sh' ':!firmware/tests/hil/build_image.sh' | xargs -0 shellcheck -S warning -f gcc
  step "Release notes script (scripts/tests/notes-test.sh)"
  scripts/tests/notes-test.sh
  pinned="$(sed -n 's/^ *GITLEAKS_VERSION: *//p' "$WORKFLOWS/lint.yml")"
  # The whole history of this commit. Actions scanned every branch it fetched; a clone's branches differ
  # from person to person (a fetched pull request of someone else's, say), so here it is HEAD's history.
  step "Secrets (gitleaks $(gitleaks version), lint.yml pins $pinned; the history of HEAD, with .gitleaks.toml)"
  gitleaks git --redact --no-banner --no-color --config .gitleaks.toml --log-opts=HEAD .
}

# codeql.yml: javascript-typescript, python and actions, with the security-extended queries and no build.
# Actions compared the results with main's; this fails on any result, so read them in the SARIF files.
job_codeql() {
  local language pack found total=0
  for language in javascript-typescript python actions; do
    pack="${language%%-*}"
    step "CodeQL, $language"
    rm -rf "$CACHE/codeql/$language"
    mkdir -p "$CACHE/codeql"
    codeql database create "$CACHE/codeql/$language" --language="$language" --build-mode=none \
      --source-root="$REPO" --overwrite --quiet
    codeql database analyze "$CACHE/codeql/$language" --download --format=sarif-latest \
      --output="$LOCALCI_RUN_DIR/codeql-$language.sarif" \
      "codeql/$pack-queries:codeql-suites/$pack-security-extended.qls"
    found="$(node -e 'const s = require(process.argv[1]); console.log(s.runs.reduce((n, r) => n + (r.results || []).length, 0))' \
      "$LOCALCI_RUN_DIR/codeql-$language.sarif")"
    echo "$found results"
    total=$((total + found))
  done
  [ "$total" -eq 0 ] || { echo "error: CodeQL found $total results: see codeql-*.sarif in $LOCALCI_RUN_DIR" >&2; return 1; }
}

job_host_tests() {
  ensure_zephyr_base
  step "The tests, with the address and undefined-behaviour sanitizers"
  make -C firmware/tests/host
}

job_python_tests() {
  ensure_python
  ensure_zephyr_base
  step "The console's real code, built for a pseudo-terminal"
  make -C firmware/tests/host build/console_sim build/console_sim_fault
  step "The tests of the new-board script"
  run_python_test test_new_board.py OK
  step "The tests, failing on any skip that is not listed"
  # As in ci.yml. Two tests may skip there and not here: test_golden.py checks binaries/cranium-1.3.0-0,
  # and test_flash_layout.py the last build in build/, when this checkout has them.
  run_python_test test_board.py OK
  run_python_test test_recover.py OK
  run_python_test test_golden.py 'OK (skipped=1)' OK
  run_python_test test_golden_promote.py OK
  run_python_test test_build_report.py OK
  run_python_test test_memory_budget.py OK
  run_python_test test_check_image.py OK
  run_python_test test_flash_layout.py 'OK (skipped=1)' OK
  run_python_test test_memfault_upload.py OK
  run_python_test test_provision.py OK
  run_python_test test_bt_only_check.py OK
}

job_closed_loop() {
  cd closed-loop
  if [ ! -x .venv/bin/python ]; then
    step "The bench's own environment, closed-loop/.venv"
    "$LOCALCI_BASE_PY" -m venv .venv
  fi
  .venv/bin/python -m pip install --quiet --requirement requirements.txt
  step "./bench test, failing on any skip"
  ./bench test 2>&1 | tee "$LOCALCI_RUN_DIR/closed-loop-bench.log"
  [ "$(grep -E '^(OK|FAILED)' "$LOCALCI_RUN_DIR/closed-loop-bench.log" | tail -n 1)" = OK ]
}

node_note() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" = 22 ] || echo "note: Node.js $major here; Actions used 22"
}

job_cloud_tests() {
  node_note
  step "Formatting (Prettier 3.3.3, as ci.yml)"
  npx --yes prettier@3.3.3 --check .
  step "API"
  (cd cloud/api && node --test)
  step "Website"
  (cd cloud/web && node --test)
  step "Local preview"
  (cd cloud/dev && node --test)
}

# The app from the checkout, started once with the example configuration, until it has drawn the customer
# site's sign-in offscreen. Up to three tries, as on Actions.
desktop_smoke() {
  local try log="$LOCALCI_RUN_DIR/desktop-smoke.log" picture="$LOCALCI_RUN_DIR/desktop-smoke.png"
  local runner=()
  if [ "$OS" = linux ] && [ -z "${DISPLAY:-}" ]; then runner=(xvfb-run -a); fi
  for try in 1 2 3; do
    rm -f "$log" "$picture"
    CRANIUM_DESKTOP_SMOKE="$picture" run_with_timeout 90 ${runner[@]+"${runner[@]}"} npx electron . > "$log" 2>&1 || true
    cat "$log"
    if grep -q '"smoke":"done","url":"cranium-app://bundle/#/sign-in"' "$log"; then
      echo "The app started and drew the sign-in page (try $try)."
      return 0
    fi
    echo "warning: the app did not start on try $try"
  done
  echo "error: the app did not start in three tries" >&2
  return 1
}

desktop_install() {
  step "Install (Electron and electron-builder, at the lockfile's versions)"
  npm ci --no-audit --no-fund
  step "Tests"
  npm test
}

job_desktop_core() {
  node_note
  cd apps/desktop
  desktop_install
  step "Start the app once"
  node node_modules/electron/install.js
  if [ "$OS" = linux ]; then
    local sandbox=node_modules/electron/dist/chrome-sandbox
    # Electron's setuid sandbox helper, as a package installs it; without sudo, no sandbox for this check.
    if sudo -n true 2> /dev/null; then
      sudo chown root:root "$sandbox" && sudo chmod 4755 "$sandbox"
    else
      echo "note: no sudo without a password, so the app starts without Chromium's sandbox here"
      export ELECTRON_DISABLE_SANDBOX=1
    fi
  fi
  node scripts/prepare.mjs --example
  desktop_smoke
}

job_android() {
  export JAVA_HOME="$LOCALCI_JDK" ANDROID_HOME="$LOCALCI_ANDROID_SDK"
  echo "JAVA_HOME=$JAVA_HOME"
  echo "ANDROID_HOME=$ANDROID_HOME"
  cd apps/android
  trap './gradlew --stop > /dev/null 2>&1 || true' EXIT
  step "Unit tests and a debug build"
  ./gradlew --console=plain --no-daemon testDebugUnitTest assembleDebug
}

xcode_cleanup() {
  xcrun simctl shutdown all > /dev/null 2>&1 || true
}

job_ios() {
  trap xcode_cleanup EXIT
  xcodebuild -version
  step "The logic package's build and tests"
  (cd apps/ios/CraniumKit && swift test)
  step "The app, compiled for iPhone without signing"
  apps/ios/scripts/generate.sh
  xcodebuild -project apps/ios/Cranium.xcodeproj -scheme Cranium -configuration Debug \
    -destination 'generic/platform=iOS' -derivedDataPath "$CACHE/DerivedData-ios" CODE_SIGNING_ALLOWED=NO build
}

job_macos() {
  trap xcode_cleanup EXIT
  xcodebuild -version
  step "The app and its tests, built for the Mac without a team"
  apps/macos/scripts/generate.sh --ad-hoc
  xcodebuild -project apps/macos/Cranium.xcodeproj -scheme Cranium -configuration Debug \
    -destination 'platform=macOS' -derivedDataPath "$CACHE/DerivedData-macos" CODE_SIGNING_ALLOWED=NO test
}

# One configuration of ci.yml's firmware matrix, built by scripts/firmware/build.sh without the signing key
# (a throwaway key signs the application, which no board takes) into .local-ci/build/, so that a checkout's
# own build/ is never touched. Then the memory floors and the configuration's own checks, as in ci.yml.
job_firmware() {
  local configuration="$1" board=nrf7002dk build="$CI_DIR/build/$2" image config imgtool
  # Not local: the trap that removes it runs after this function has returned.
  keys=""
  local args=(--keep --no-upload --without-key --build-dir "$build")
  case "$configuration" in
    "no Bluetooth") args+=(--cmake-arg -DSB_EXTRA_CONF_FILE=no_bt_sysbuild.conf) ;;
    "nRF5340 DK") board=nrf5340dk ;;
  esac
  args+=(--board "$board")
  ensure_python
  export NCS_DIR="$LOCALCI_NCS"
  [ -z "$LOCALCI_NRFUTIL" ] || export NRFUTIL="$LOCALCI_NRFUTIL"

  # The golden key's public half, so that the bootloader is built with promotion over the air as a release
  # is; its private half is thrown away at once, as in ci.yml.
  keys="$(mktemp -d)"
  trap 'rm -rf "$keys"' EXIT
  python3 tools/golden_promote.py genkey --private "$keys/private.pem" --public "$keys/public.pem" > /dev/null
  rm -f "$keys/private.pem"
  export CRANIUM_GOLDEN_PROMOTE_KEY="$keys/public.pem"

  step "Build: scripts/firmware/build.sh ${args[*]}"
  scripts/firmware/build.sh "${args[@]}"
  step "The memory headroom of each image (tools/memory_budget.py, floors in tools/memory_budgets.json)"
  python3 -I tools/memory_budget.py --build "$build" --configuration "$configuration" \
    --summary "$LOCALCI_RUN_DIR/$2-memory.md" --json "$LOCALCI_RUN_DIR/$2-memory.json"

  step "The configuration's own checks"
  image="$build/app/zephyr/zephyr.signed.bin"
  config="$build/app/zephyr/.config"
  imgtool="$LOCALCI_NCS/bootloader/mcuboot/scripts/imgtool.py"
  test -s "$image"
  if python3 "$imgtool" verify -k firmware/keys/fw_signing_pub.pem "$image" > /dev/null 2>&1; then
    echo "error: this image verifies against the project's own key, which a check build must never have" >&2
    return 1
  fi
  echo "The image does not verify against the project's key: it was signed with a throwaway one."
  case "$configuration" in
    default)
      grep -qx 'CONFIG_APP_BT_OTA=y' "$config" ||
        { echo "error: the default configuration has lost firmware update over Bluetooth" >&2; return 1; }
      ;;
    "no Bluetooth")
      if grep -qx 'CONFIG_APP_BT_OTA=y' "$config" || grep -qx 'CONFIG_BT=y' "$config"; then
        echo "error: no_bt_sysbuild.conf did not turn Bluetooth off" >&2
        return 1
      fi
      test -d "$build/netcore_blinky"
      ;;
    "nRF5340 DK")
      for setting in CONFIG_APP_BT_ONLY=y CONFIG_APP_BT_OTA=y CONFIG_APP_BT_STATIC_PASSKEY=y; do
        grep -qx "$setting" "$config" || { echo "error: the nRF5340 DK's build does not have $setting" >&2; return 1; }
      done
      if grep -qE '^CONFIG_(WIFI|AWS_IOT|APP_LOCATION|MEMFAULT)=y$' "$config"; then
        echo "error: the nRF5340 DK's build has Wi-Fi, AWS IoT, the location or Memfault in it" >&2
        return 1
      fi
      test -s "$build/hci_ipc/zephyr/zephyr.hex"
      local type layout
      type="$(python3 -I tools/check_image.py --board "$image")"
      layout="$(python3 -I tools/check_image.py --layout "$image")"
      [ "$type" = nrf5340dk ] && [ "$layout" = 1 ] ||
        { echo "error: the image says board type \"$type\" and flash layout \"$layout\", not nrf5340dk and 1" >&2; return 1; }
      echo "Board type $type and flash layout $layout, from TLVs 0xA1 and 0xA2."
      ;;
  esac
  echo
  echo "Not here: tools/build_report.py, which needs binaries/ to hold this build, and build.sh --without-key"
  echo "puts binaries/ back as it was. The sizes are in the memory table above and in build.sh's output."
}

job_cranium_mix() {
  python_shim "$LOCALCI_BASE_PY" "$CACHE/python-shim-mix"
  cd pi/cranium-mix
  step "Controller, Pi helper, package and source-layout checks"
  bash tools/test.sh
}

job_desktop_linux() {
  cd apps/desktop
  desktop_install
  step "Build the packages"
  npm run dist -- linux --example
  step "Look into them"
  local version appimage deb rpm entry list
  version="$(node scripts/version-of.mjs linux)"
  appimage="dist/Cranium-$version.AppImage"
  deb="dist/cranium_${version}_amd64.deb"
  rpm="dist/cranium-$version.x86_64.rpm"
  for file in "$appimage" "$deb" "$rpm"; do test -f "$file" || { echo "error: $file was not built" >&2; return 1; }; done
  [ "$(dpkg-deb -f "$deb" Package)" = cranium ] || { echo "error: the .deb's package is not cranium" >&2; return 1; }
  list="$(dpkg-deb -c "$deb")"
  for path in ./usr/lib/udev/rules.d/70-cranium-jlink.rules ./usr/share/applications/cranium.desktop \
    ./opt/Cranium/cranium ./opt/Cranium/chrome-sandbox; do
    grep -q " $path\$" <<< "$list" || { echo "error: the .deb has no $path" >&2; return 1; }
  done
  entry="$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/applications/cranium.desktop)"
  grep -qx 'Name=Cranium' <<< "$entry" && grep -qx 'Icon=cranium' <<< "$entry" &&
    grep -q '^Exec=/opt/Cranium/cranium' <<< "$entry" || { echo "error: the .deb's menu entry is not right" >&2; return 1; }
  grep -qE './usr/share/icons/hicolor/[0-9]+x[0-9]+/apps/cranium\.png$' <<< "$list" ||
    { echo "error: the .deb has no icon" >&2; return 1; }
  [ "$(rpm -qp --queryformat '%{NAME}' "$rpm" 2> /dev/null)" = cranium ] || { echo "error: the .rpm's package is not cranium" >&2; return 1; }
  rpm -qlp "$rpm" 2> /dev/null | grep -qx /usr/lib/udev/rules.d/70-cranium-jlink.rules ||
    { echo "error: the .rpm has no udev rule" >&2; return 1; }
  chmod +x "$appimage"
  local extract
  extract="$(mktemp -d)"
  (cd "$extract" && "$REPO/apps/desktop/$appimage" --appimage-extract cranium.desktop > /dev/null)
  grep -qx 'Name=Cranium' "$extract/squashfs-root/cranium.desktop" || { echo "error: the AppImage's entry is not named Cranium" >&2; return 1; }
  rm -rf "$extract"
  echo "The AppImage, the .deb and the .rpm of $version look right."
  if [ "${LOCALCI_INSTALL:-0}" != 1 ]; then
    echo "Not installed: run with --install-packages to install the .deb, start it and remove it (sudo apt-get)."
    return 0
  fi
  step "Install the .deb, start the app, and remove it"
  sudo apt-get install -y -qq "./$deb" > /dev/null
  test -x /usr/bin/cranium && test -f /usr/lib/udev/rules.d/70-cranium-jlink.rules && test -f /usr/share/applications/cranium.desktop
  local code=0
  if [ -n "${DISPLAY:-}" ]; then run_with_timeout 25 cranium > /dev/null 2>&1 || code=$?; else run_with_timeout 25 xvfb-run -a cranium > /dev/null 2>&1 || code=$?; fi
  sudo apt-get remove -y -qq cranium > /dev/null
  [ "$code" = 124 ] || [ "$code" = 143 ] || { echo "error: the installed app stopped by itself (exit $code) instead of running" >&2; return 1; }
  test ! -e /usr/bin/cranium || { echo "error: the command stayed after removing the package" >&2; return 1; }
  echo "Installed, started under its sandbox, and removed."
}

job_desktop_windows() {
  cd apps/desktop
  desktop_install
  step "Start the app once from the checkout"
  node scripts/prepare.mjs --example
  desktop_smoke
  step "Build the installers"
  npm run dist -- windows --example
  step "Check what was built"
  local version names product
  version="$(node scripts/version-of.mjs windows)"
  names="$(node scripts/installers.mjs windows "$version")"
  for name in "Cranium-Setup-$version.exe" "Cranium-$version-portable.exe"; do
    grep -qx "$name" <<< "$names" || { echo "error: $name was not built" >&2; return 1; }
  done
  test -f dist/win-unpacked/Cranium.exe || { echo "error: the program is not Cranium.exe" >&2; return 1; }
  product="$(powershell -NoProfile -Command "(Get-Item 'dist/win-unpacked/Cranium.exe').VersionInfo.ProductName" | tr -d '\r')"
  [ "$product" = Cranium ] || { echo "error: the program says it is \"$product\", not Cranium" >&2; return 1; }
  echo "The installers of $version are there."
  if [ "${LOCALCI_INSTALL:-0}" != 1 ]; then
    echo "Not installed: run with --install-packages to install it silently and uninstall it again."
    return 0
  fi
  step "Install it silently, then uninstall it"
  local dir start_menu uninstallers
  dir="$(cygpath -u "$LOCALAPPDATA")/Programs/Cranium"
  start_menu="$(cygpath -u "$APPDATA")/Microsoft/Windows/Start Menu/Programs/Cranium.lnk"
  MSYS_NO_PATHCONV=1 "./dist/Cranium-Setup-$version.exe" /S
  for _ in $(seq 1 90); do [ -f "$dir/Cranium.exe" ] && [ -f "$start_menu" ] && break; sleep 1; done
  test -f "$dir/Cranium.exe" && test -f "$start_menu" || { echo "error: not installed, or no Start menu entry" >&2; return 1; }
  uninstallers=("$dir"/Uninstall*.exe)
  MSYS_NO_PATHCONV=1 "${uninstallers[0]}" /S
  for _ in $(seq 1 90); do [ -e "$dir/Cranium.exe" ] || [ -e "$start_menu" ] || break; sleep 1; done
  test ! -e "$dir/Cranium.exe" && test ! -e "$start_menu" || { echo "error: the uninstaller left the app" >&2; return 1; }
  echo "Installed, found in the Start menu, and uninstalled."
}

run_job_body() {
  cd "$REPO" || exit 1
  set -e
  case "$1" in
    scan) job_scan ;;
    lint) job_lint ;;
    codeql) job_codeql ;;
    host-tests) job_host_tests ;;
    python-tests) job_python_tests ;;
    closed-loop) job_closed_loop ;;
    cloud-tests) job_cloud_tests ;;
    desktop-core) job_desktop_core ;;
    android) job_android ;;
    ios) job_ios ;;
    macos) job_macos ;;
    firmware-default) job_firmware default "$1" ;;
    firmware-no-bt) job_firmware "no Bluetooth" "$1" ;;
    firmware-nrf5340dk) job_firmware "nRF5340 DK" "$1" ;;
    cranium-mix) job_cranium_mix ;;
    desktop-linux) job_desktop_linux ;;
    desktop-windows) job_desktop_windows ;;
    *) die "no job body for $1" ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------
# Listing, the doctor, running, the summary and the commit status.

format_time() {
  printf '%d:%02d' $(($1 / 60)) $(($1 % 60))
}

print_list() {
  local job reason blocker
  echo "Base: $BASE_REF (merge base $(git -C "$REPO" merge-base "$BASE_REF" HEAD | cut -c1-8)); HEAD $(git -C "$REPO" rev-parse --short HEAD)"
  echo "Changed files, with what is not committed yet: $(grep -c . <<< "$CHANGED" || true)"
  echo
  printf '%-20s %-6s %s\n' JOB RUNS WHY
  for job in $JOBS; do
    if [ "$MODE" = all ]; then
      reason="--all"
    elif [ -n "$ONLY" ]; then
      case " $ONLY " in *" $job "*) reason="--job" ;; *) reason="" ;; esac
    else
      reason="$(job_reason "$job")"
    fi
    blocker="$(job_blocker "$job")"
    if [ -z "$reason" ]; then
      printf '%-20s %-6s %s\n' "$job" no "no changes call for it ($(job_workflow "$job"))"
    elif [ -n "$blocker" ]; then
      printf '%-20s %-6s %s\n' "$job" skip "${blocker#*|} [called for by: $reason]"
    else
      printf '%-20s %-6s %s\n' "$job" yes "$reason"
    fi
  done
  list_warnings
}

list_warnings() {
  local name
  unknown_firmware_configurations | while IFS= read -r name; do
    echo "warning: ci.yml's firmware matrix has the configuration \"$name\", which this script does not build: add it here"
  done
  if [ "$ACTION" != doctor ] && [ -z "$CHANGED" ] && [ "$MODE" = changed ]; then
    echo "note: no changes against $BASE_REF, so only the jobs every change calls for run; --all runs everything"
  fi
}

print_doctor() {
  echo "System:        $OS ($(uname -sm))"
  echo "Memory gate:   ${GATE:-none (CRANIUM_HEAVY=off)}"
  echo "nrfutil:       ${NRFUTIL_BIN:-not found (docs/new-board-setup.md)}"
  echo "SDK $NCS_VERSION:   ${NCS:-not found${SDK_NOTE:+ ($SDK_NOTE)}; set NCS_DIR, or install it with nrfutil sdk-manager}"
  echo "Python + reqs: ${PY:-none yet; a job makes .local-ci/cache/venv from ${BASE_PY:-a Python 3.10+, which is missing}}"
  echo "Node.js:       $(if have node; then node --version; else echo "not found (install Node.js 22)"; fi)${NODE_MAJOR:+$([ "$NODE_MAJOR" = 22 ] || echo "; Actions used 22")}"
  echo "JDK:           ${JDK:-not found (brew install openjdk@17, or set JAVA_HOME)}"
  echo "Android SDK:   ${ANDROID_SDK:-not found (Android Studio, or set ANDROID_HOME)}"
  if [ "$OS" = macos ]; then
    local xcode
    xcode="$(xcodebuild -version 2> /dev/null)" || xcode="not found"
    echo "Xcode:         $(echo "$xcode" | head -n 1)"
  fi
  local tool
  for tool in shellcheck actionlint gitleaks xcodegen codeql docker; do
    printf '%-14s %s\n' "$tool:" "$(command -v "$tool" 2> /dev/null || echo "not found")"
  done
  if have gh && gh auth token > /dev/null 2>&1; then
    echo "gh:            signed in (--post can set the status, with write access to $GH_REPO)"
  else
    echo "gh:            $(if have gh; then echo "not signed in: gh auth login"; else echo "not found: install GitHub CLI, then gh auth login"; fi) (only --post needs it)"
  fi
  echo
  printf '%-20s %s\n' JOB "ON THIS COMPUTER"
  local job blocker
  for job in $JOBS; do
    blocker="$(job_blocker "$job")"
    if [ -z "$blocker" ]; then
      printf '%-20s %s\n' "$job" "can run"
    else
      printf '%-20s %s\n' "$job" "${blocker%%|*}: ${blocker#*|}"
    fi
  done
  list_warnings
}

# Runs one job, gated when heavy, with its output in the log, and records "result|seconds|note".
run_job() {
  local job="$1" log="$RUN_DIR/$1.log" start status blocker result note=""
  blocker="$(job_blocker "$job")"
  if [ -n "$blocker" ]; then
    # A job that the changes call for and that cannot run on this computer leaves the run incomplete,
    # unless it is optional, not in this tree, or never run locally.
    result="not-run"
    case "${blocker%%|*}" in absent | design) result="skipped" ;; esac
    if job_optional "$job"; then result="skipped"; fi
    echo "${blocker#*|}" > "$log"
    echo "$result|0|${blocker#*|}" > "$RUN_DIR/$job.result"
    printf '%-31s %s\n' "$(job_title "$job")" "$result: ${blocker#*|}"
    return 0
  fi
  printf '%-31s running (log: %s)\n' "$(job_title "$job")" "${log#"$REPO"/}"
  start="$(date +%s)"
  {
    echo "local-ci: $(job_title "$job") ($(job_workflow "$job")), commit $(git -C "$REPO" rev-parse HEAD), $(date)"
    if job_heavy "$job" && [ -n "$GATE" ]; then
      echo "Through the memory gate $GATE"
      "$GATE" bash "$SELF" --run-job "$job"
    else
      bash "$SELF" --run-job "$job"
    fi
  } > "$log" 2>&1
  status=$?
  local seconds=$(($(date +%s) - start))
  if [ "$status" -eq 0 ]; then
    result=passed
  elif job_may_fail "$job"; then
    result=allowed-failure
    note="allowed to fail, as on Actions"
  else
    result=failed
  fi
  [ "$status" -eq 0 ] || tail -n 15 "$log" | sed 's/^/    | /'
  echo "$result|$seconds|$note" > "$RUN_DIR/$job.result"
  printf '%-31s %s in %s\n' "$(job_title "$job")" "$result" "$(format_time "$seconds")"
}

SUMMARY_STATE=success
SUMMARY_TEXT=""

summarize() {
  local job line result seconds note passed=0 failed=0 skipped=0 notrun=0 total=0 failed_names="" skipped_names="" notrun_names=""
  {
    echo
    printf '%-31s %-18s %7s  %s\n' JOB RESULT TIME NOTE
    for job in $SELECTED; do
      line="$(cat "$RUN_DIR/$job.result")"
      result="${line%%|*}"
      seconds="${line#*|}"
      note="${seconds#*|}"
      seconds="${seconds%%|*}"
      total=$((total + seconds))
      case "$result" in
        passed) passed=$((passed + 1)) ;;
        failed) failed=$((failed + 1)); failed_names="$failed_names $job" ;;
        allowed-failure) skipped_names="$skipped_names $job(failed,allowed)" ;;
        skipped) skipped=$((skipped + 1)); skipped_names="$skipped_names $job" ;;
        not-run) notrun=$((notrun + 1)); notrun_names="$notrun_names $job" ;;
      esac
      printf '%-31s %-18s %7s  %s\n' "$(job_title "$job")" "$result" "$(format_time "$seconds")" "$note"
    done
    echo
    echo "Total $(format_time "$total"): $passed passed, $failed failed, $skipped skipped, $notrun could not run here. Logs: ${RUN_DIR#"$REPO"/}"
    list_warnings
  } > "$RUN_DIR/summary.txt"
  # Written first and shown after, so that the counts stay in this shell.
  cat "$RUN_DIR/summary.txt"
  local unknown=""
  case "$SELECTED" in *firmware-default*) unknown="$(unknown_firmware_configurations | tr '\n' ',' | sed 's/,$//')" ;; esac
  if [ "$failed" -gt 0 ]; then
    SUMMARY_STATE=failure
    SUMMARY_TEXT="failed:$failed_names; $passed passed"
  elif [ -n "$unknown" ]; then
    SUMMARY_STATE=error
    SUMMARY_TEXT="ci.yml builds firmware \"$unknown\", which local-ci does not; $passed passed"
  elif [ "$notrun" -gt 0 ]; then
    SUMMARY_STATE=error
    SUMMARY_TEXT="could not run here:$notrun_names; $passed passed"
  else
    SUMMARY_STATE=success
    SUMMARY_TEXT="$passed passed"
    [ "$skipped" -eq 0 ] || SUMMARY_TEXT="$SUMMARY_TEXT, $skipped skipped:$skipped_names"
  fi
  SUMMARY_TEXT="$SUMMARY_TEXT ($MODE, $(format_time "$total"), $OS)"
}

# --post needs a commit that GitHub has and a tree that is exactly that commit.
check_postable() {
  [ -z "$ONLY" ] || die "--post describes a whole run: use it with --all or with no --job"
  have gh || die "--post needs the GitHub CLI: install it, then gh auth login"
  gh auth token > /dev/null 2>&1 || die "--post needs gh to be signed in: gh auth login"
  [ -z "$(git -C "$REPO" status --porcelain)" ] ||
    die "--post needs a clean tree, so that the status describes exactly HEAD: commit or stash first"
  [ -n "$(git -C "$REPO" branch -r --contains HEAD 2> /dev/null)" ] ||
    die "--post needs HEAD on GitHub: push it first (git push), then run again"
}

post_status() {
  local sha="$1" state="$SUMMARY_STATE" description="$SUMMARY_TEXT" remaining
  if [ "$(git -C "$REPO" rev-parse HEAD)" != "$sha" ]; then
    echo "local-ci: HEAD moved during the run; nothing posted" >&2
    return 3
  fi
  if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    state=error
    description="the run changed files in the tree: $(git -C "$REPO" status --porcelain | head -n 3 | awk '{ print $2 }' | tr '\n' ' ')"
  fi
  remaining="$(gh api rate_limit --jq '.resources.core.remaining' 2> /dev/null)"
  if [ "${remaining:-0}" -lt 1 ]; then
    echo "local-ci: the GitHub API limit is used up until $(gh api rate_limit --jq '.resources.core.reset | todate' 2> /dev/null); nothing posted. Run again with --post later." >&2
    return 3
  fi
  description="$(printf '%s' "$description" | cut -c1-140)"
  if gh api --method POST "repos/$GH_REPO/statuses/$sha" -f state="$state" -f context=local-ci \
    -f description="$description" > /dev/null; then
    echo "Posted local-ci = $state on $(echo "$sha" | cut -c1-8): $description"
  else
    echo "local-ci: posting the status failed" >&2
    return 3
  fi
}

# ---------------------------------------------------------------------------------------------------------
# All in one function, called on the last line: bash has then read the whole file before any of it runs,
# so a checkout or an edit during a long run cannot change what this run does.

main() {
  MODE=changed
  ONLY=""
  ACTION=run
  POST=0
  export LOCALCI_INSTALL=0

  if [ "${1:-}" = --run-job ]; then
    [ $# -ge 2 ] || die "--run-job needs a job"
    # Set by the parent run.
    : "${LOCALCI_RUN_DIR:?}" "${LOCALCI_NCS?}" "${LOCALCI_PY?}" "${LOCALCI_BASE_PY?}"
    run_job_body "$2"
    exit $?
  fi

  while [ $# -gt 0 ]; do
    case "$1" in
      --all) MODE=all ;;
      --job)
        [ $# -ge 2 ] || die "--job needs a name"
        ONLY="$ONLY $(expand_job "$2")"
        MODE=chosen
        shift
        ;;
      --list) ACTION=list ;;
      --doctor) ACTION=doctor ;;
      --post) POST=1 ;;
      --base)
        [ $# -ge 2 ] || die "--base needs a ref"
        BASE_REF="$2"
        shift
        ;;
      --install-packages) LOCALCI_INSTALL=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  [ "$MODE" != all ] || [ -z "$ONLY" ] || die "use --all or --job, not both"

  detect

  if [ "$ACTION" = doctor ]; then
    print_doctor
    exit 0
  fi

  CHANGED="$(changed_files)" || exit 2

  if [ "$ACTION" = list ]; then
    print_list
    exit 0
  fi

  [ "$POST" = 0 ] || check_postable

  SELECTED=""
  for job in $JOBS; do
    if [ "$MODE" = all ]; then
      SELECTED="$SELECTED $job"
    elif [ "$MODE" = chosen ]; then
      case " $ONLY " in *" $job "*) SELECTED="$SELECTED $job" ;; esac
    elif [ -n "$(job_reason "$job")" ]; then
      SELECTED="$SELECTED $job"
    fi
  done

  SHA="$(git -C "$REPO" rev-parse HEAD)"
  RUN_DIR="$CI_DIR/runs/$(date +%Y%m%d-%H%M%S)-$(echo "$SHA" | cut -c1-8)"
  mkdir -p "$RUN_DIR" "$CACHE" || die "could not make $RUN_DIR"
  export LOCALCI_RUN_DIR="$RUN_DIR"
  ln -sfn "runs/$(basename "$RUN_DIR")" "$CI_DIR/latest" 2> /dev/null || true
  # Keep the newest twenty runs.
  # shellcheck disable=SC2012 # the run folders have plain names
  ls -1d "$CI_DIR"/runs/*/ 2> /dev/null | sort | awk '{ name[NR] = $0 } END { for (i = 1; i <= NR - 20; i++) print name[i] }' |
    while IFS= read -r old; do rm -rf "$old"; done

  echo "local-ci on $OS, commit $(echo "$SHA" | cut -c1-8), $MODE jobs:$SELECTED"
  echo "Memory gate for heavy jobs: ${GATE:-none}"
  echo
  for job in $SELECTED; do
    run_job "$job"
  done
  summarize

  status=0
  case "$SUMMARY_STATE" in
    failure) status=1 ;;
    error) status=2 ;;
  esac
  if [ "$POST" = 1 ]; then
    post_status "$SHA" || status=3
  fi
  exit "$status"
}

main "$@"
exit $?
