#!/usr/bin/env bash
#
# Build a signed release APK of the Cranium app: apps/dist/cranium-android-<versionName>.apk.
#
# The release key lives outside the repository, in ~/.cranium/android:
#   cranium-release.jks    the keystore (PKCS12)
#   keystore.properties    its passwords, which app/build.gradle.kts reads
# Both are made here with keytool the first time. The passwords are never printed.
#
# The APK holds the console URL, login domain and client ID of the stack in
# apps/config/cranium.json. Share it with the team directly. Never attach it to a public release.
#
# It is then published on the console's Apps page, where the team downloads it, with your API token
# (apps/android/publish.sh). Without a token it says how to make one, and the APK stays in apps/dist/.
#
#   apps/android/build-release.sh                 build, then publish on the console
#   apps/android/build-release.sh --no-publish    build only
#
# Exit status 3: built, but the publish failed.

set -euo pipefail

publish=true
for argument in "$@"; do
  case "$argument" in
    --no-publish) publish=false ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option $argument (see --help)" >&2; exit 1 ;;
  esac
done

ANDROID_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="$(cd "$ANDROID_DIR/.." && pwd)"
DIST_DIR="$APPS_DIR/dist"
KEY_DIR="$HOME/.cranium/android"
KEYSTORE="$KEY_DIR/cranium-release.jks"
PROPERTIES="$KEY_DIR/keystore.properties"
KEY_ALIAS="cranium-release"

fail() { echo "error: $*" >&2; exit 1; }

# JDK 17: JAVA_HOME if set, else Homebrew's openjdk@17.
if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
                   /usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; do
    if [ -x "$candidate/bin/java" ]; then export JAVA_HOME="$candidate"; break; fi
  done
fi
[ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ] \
  || fail "no JDK 17 found: brew install openjdk@17, or set JAVA_HOME"
export PATH="$JAVA_HOME/bin:$PATH"

# The Android SDK: sdk.dir in local.properties, else ANDROID_HOME.
SDK_DIR="$(sed -n 's/^sdk\.dir=//p' "$ANDROID_DIR/local.properties" 2>/dev/null | tail -n 1)"
SDK_DIR="${SDK_DIR:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}}"
[ -n "$SDK_DIR" ] && [ -d "$SDK_DIR" ] \
  || fail "no Android SDK: put sdk.dir in apps/android/local.properties (see apps/android/README.md)"
APKSIGNER="$(ls -1d "$SDK_DIR"/build-tools/*/apksigner 2>/dev/null | sort | tail -n 1)"
[ -n "$APKSIGNER" ] || fail "no apksigner under $SDK_DIR/build-tools: install build-tools with sdkmanager"

VERSION_NAME="$(sed -n 's/^craniumVersionName=//p' "$ANDROID_DIR/gradle.properties" | tail -n 1)"
[ -n "$VERSION_NAME" ] || fail "no craniumVersionName in apps/android/gradle.properties"

if [ ! -f "$APPS_DIR/config/cranium.json" ]; then
  echo "warning: apps/config/cranium.json not found. This APK gets the example configuration and" >&2
  echo "         cannot sign in. Run apps/configure.sh first to build one the team can use." >&2
  EXAMPLE_CONFIG=1
else
  EXAMPLE_CONFIG=0
fi

# The release key, made once. An update to an installed app must be signed with the same key.
umask 077
if [ ! -f "$KEYSTORE" ] && [ ! -f "$PROPERTIES" ]; then
  command -v openssl >/dev/null || fail "openssl is needed to draw the keystore password"
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"
  CRANIUM_KEYSTORE_PASSWORD="$(openssl rand -hex 24)"
  export CRANIUM_KEYSTORE_PASSWORD
  # PKCS12 has one password for the store and the key.
  "$JAVA_HOME/bin/keytool" -genkeypair -noprompt \
    -keystore "$KEYSTORE" -storetype PKCS12 \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=Cranium Android release" \
    -storepass:env CRANIUM_KEYSTORE_PASSWORD -keypass:env CRANIUM_KEYSTORE_PASSWORD >/dev/null 2>&1 \
    || { rm -f "$KEYSTORE"; fail "keytool could not create $KEYSTORE"; }
  {
    echo "# The Cranium Android release key. Keep this file and cranium-release.jks together, and back both up."
    echo "storeFile=$KEYSTORE"
    echo "storeType=PKCS12"
    echo "storePassword=$CRANIUM_KEYSTORE_PASSWORD"
    echo "keyAlias=$KEY_ALIAS"
    echo "keyPassword=$CRANIUM_KEYSTORE_PASSWORD"
  } > "$PROPERTIES"
  unset CRANIUM_KEYSTORE_PASSWORD
  echo "Made a new release key in $KEY_DIR. Back it up: every later version must be signed with it."
elif [ ! -f "$KEYSTORE" ] || [ ! -f "$PROPERTIES" ]; then
  fail "only one of $KEYSTORE and $PROPERTIES exists. Restore the other from the backup; a new key cannot update an installed app"
fi
chmod 700 "$KEY_DIR"
chmod 600 "$KEYSTORE" "$PROPERTIES"

# A clean release build, in a Gradle that stops when it is done.
cd "$ANDROID_DIR"
rm -rf app/build/outputs/apk/release
CRANIUM_KEYSTORE_PROPERTIES="$PROPERTIES" ./gradlew --no-daemon --console=plain assembleRelease

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || fail "no signed APK at $APK: the release signing was not picked up"

mkdir -p "$DIST_DIR"
OUT="$DIST_DIR/cranium-android-$VERSION_NAME.apk"
cp "$APK" "$OUT"
"$APKSIGNER" verify --verbose "$OUT" | grep -E '^(Verifies|Verified using)' || fail "apksigner does not verify $OUT"

echo "Built $OUT"
if [ "$EXAMPLE_CONFIG" = 1 ]; then
  echo "warning: this APK has the example configuration and cannot sign in." >&2
fi
echo "It holds this stack's console URL and client ID: share it privately, never in a public release."

# On the console's Apps page, as scripts/build.sh puts a firmware build on its Firmware page. Never an APK that
# cannot sign in: a version is published once.
if [ "$publish" = false ]; then
  echo "Next: publish it on the console's Apps page with apps/android/publish.sh."
  exit 0
fi
if [ "$EXAMPLE_CONFIG" = 1 ]; then
  echo "Not published: it has the example configuration. Run apps/configure.sh, then build again." >&2
  exit 0
fi
echo
set +e
"$ANDROID_DIR/publish.sh" "$OUT"
published=$?
set -e
case "$published" in
  0) ;;
  2) echo "The APK is in apps/dist/: publish it later with apps/android/publish.sh." ;;
  *)
    echo "warning: built, but not published: see above. The APK is in apps/dist/." >&2
    exit 3 ;;
esac
