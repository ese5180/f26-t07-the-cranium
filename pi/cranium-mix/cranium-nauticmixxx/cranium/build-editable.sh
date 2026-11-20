#!/bin/bash
# Run on ARM64 Debian 12 with the normal Mixxx build dependencies installed.
# Builds the PERSISTENT native tree; never downloads/resets/reapplies it.
set -euo pipefail
project=$(cd "$(dirname "$0")/.." && pwd)
engine=${CRANIUM_NAUTIC_ENGINE_SOURCE:-$(dirname "$project")/cranium-nauticmixxx-engine}
build_root=${CRANIUM_NAUTIC_BUILD_ROOT:?Set an output directory outside both source repositories}
jobs=${CRANIUM_BUILD_JOBS:-1}
disable_pch=${CRANIUM_DISABLE_PCH:-ON}
if [ "$(uname -s)/$(uname -m)" != Linux/aarch64 ]; then
  echo 'Build this Pi candidate on 64-bit ARM Linux, using Debian Bookworm dependencies.' >&2
  exit 1
fi
test -f "$engine/src/widget/wrx3browser.h"
python3 "$project/../tools/check-layout.py" --engine "$engine"
cmake -S "$engine" -B "$build_root/native" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$build_root/stage" \
  -DCMAKE_INSTALL_LIBDIR=lib -DNAUTICMIX_VERSION="$(cat "$project/VERSION")" \
  -DQT6=ON -DQML=OFF -DOPTIMIZE=portable -DENGINEPRIME=OFF -DKEYFINDER=OFF \
  -DBUILD_LOW_MEMORY=ON -DCMAKE_DISABLE_PRECOMPILE_HEADERS="$disable_pch" \
  -DBUILD_TESTING=ON -DBUILD_BENCH=OFF -DINSTALL_USER_UDEV_RULES=OFF
cmake --build "$build_root/native" --target mixxx mixxx-test --parallel "$jobs"
QT_QPA_PLATFORM=offscreen NAUTIC_SKIN_DIR="$project/skins/XDJ_RX3_Mixxx" \
  NAUTIC_RX3_STYLESHEET="$project/skins/XDJ_RX3_Mixxx/style.qss" \
  "$build_root/native/mixxx-test" --resource-path "$engine/res" \
  --gtest_filter='Rx3*:RekordboxDecoderTimingTest.*:RekordboxUsbSessionAudioTest.*:RekordboxWaveformImporterTest.*:TrackCapabilityPolicyTest.*' \
  --gtest_output="xml:$build_root/cranium-native-tests.xml"
cmake --install "$build_root/native" --strip
python3 "$project/packaging/linux/stage-package.py" "$build_root/stage" "$engine" "$project"
python3 "$project/scripts/test-linux-package.py" --stage "$build_root/stage"
echo "Staged source build: $build_root/stage/bin/nauticmixxx"
echo 'This staged directory still needs Pi-compatible dependency packaging and hardware validation.'
