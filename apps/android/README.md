# Cranium for Android

A Kotlin app for a release manager: sign in to the console, pick a firmware release that is on AWS,
and send it to an nRF7002 DK board over Bluetooth LE with MCUmgr. It follows
[`docs/mobile-apps.md`](../../docs/mobile-apps.md); the board's side is in
[`firmware/README.md`](../../firmware/README.md#firmware-update-over-bluetooth).

The app only uploads. It never asks the board to test, confirm, erase or reset: the board refuses
those, and a person installs the image by pressing Button 1 at the board.

Each connection still shows `[BT] refused a command: group 0, id 6, op 0` on the board's console.
That is mcumgr-ble asking for the board's SMP buffer sizes as it connects, which it always does; the
board takes only the image group, and the library goes on without the answer. It does no harm.

## What it needs

- JDK 17 and the Android SDK command-line tools. On a Mac, without sudo:

  ```sh
  brew install openjdk@17
  brew install --cask android-commandlinetools
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  SDK=/opt/homebrew/share/android-commandlinetools
  yes | sdkmanager --sdk_root=$SDK --licenses
  sdkmanager --sdk_root=$SDK "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
  echo "sdk.dir=$SDK" > apps/android/local.properties
  ```

- The configuration: `apps/configure.sh` writes `apps/config/cranium.json` from the deployed stack.
  Without it the build uses `apps/config/cranium.example.json`, says so, and the app cannot sign in.

## Build

Debug, with the unit tests:

```sh
cd apps/android
./gradlew testDebugUnitTest assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`.

Release, signed:

```sh
apps/android/build-release.sh
```

It writes `apps/dist/cranium-android-<version>.apk` and checks it with `apksigner verify`. The
signing key is `~/.cranium/android/cranium-release.jks`, with its passwords in
`~/.cranium/android/keystore.properties`; the script makes both the first time. Back them up:
a phone only takes an update signed with the same key. The app's version is `craniumVersionName`
in `gradle.properties`, and has nothing to do with the firmware's.

Gradle is held to 1.5 GB and two workers (`gradle.properties`). Run `./gradlew --stop` when done.

## Install on a phone

- Over USB, with USB debugging on: `adb install -r apps/dist/cranium-android-<version>.apk`.
- Or share the APK privately with the team (a direct message, a drive folder only the team can
  open). The phone has to allow installing apps from wherever it was opened.

Android 8.0 (API 26) or later, with Bluetooth LE.

## Do not publish the APK

The APK holds the console URL, the login domain and the client ID of the account it was built for.
Never attach it to a public GitHub release and never commit it: git ignores `*.apk` and
`apps/dist/` for that reason. The same goes for `apps/config/cranium.json` and the keystore.

## What is tested

`./gradlew testDebugUnitTest` runs JVM tests of the parts that need no phone: reading the MCUboot
header and comparing versions, decoding the release list, the checks on a downloaded image, which
releases are offered, and the sign-in request (PKCE and the authorize URL). Sign-in against
Cognito, the API calls and everything over Bluetooth take a phone, a deployed stack and a board,
and have not been tried yet.
