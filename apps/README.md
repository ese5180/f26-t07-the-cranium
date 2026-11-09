# The Cranium phone apps

Two apps, one for iPhone (`ios/`, Swift) and one for Android (`android/`, Kotlin), with the same screens: sign in, the
boards, firmware, deployments, the activity log, and updating a board over Bluetooth, for the team in admin mode; and a
customer side, as on the customer website. The newest published build of each (0.8.0 now) is in [`dist/`](dist/), with
its SHA-256 in `dist/SHA256SUMS`. More detail: [`docs/mobile-apps.md`](../docs/mobile-apps.md),
[`ios/README.md`](ios/README.md), [`android/README.md`](android/README.md).

For a Windows PC or a Linux computer there is the desktop app, the same pages in a window of their own, with the USB
console and Bluetooth: [`desktop/README.md`](desktop/README.md) and [`docs/desktop-app.md`](../docs/desktop-app.md).

## What updates without a reinstall

From 0.8.0 the screens are the console's and the customer site's own pages, which each app keeps on the phone and
brings up to date from the console by itself, on any network ([The app shell](../docs/mobile-apps.md#the-app-shell)).

| Changes | Reaches the phones | How |
| --- | --- | --- |
| Anything on the screens: pages, words, the Bluetooth update flow, the sign-in pages | At the app's next start, anywhere, free | Deploy the console (Actions → Deploy console, or `cloud/deploy.sh` on the owner's laptop: [docs/ci.md](../docs/ci.md#deploying-the-console-from-github-actions)); each app checks every file against its SHA-256 before it uses it |
| The native shell: what the bridge can do (Bluetooth, Face ID and the fingerprint, the clipboard, sharing), the web view | Only with a new app | Android: the app updates itself, as below. iPhone: SideStore, or `renew.sh` from the Mac |

When the console's pages need more than an app's bridge offers, that app keeps the pages it has and its settings say it
needs an update. The 0.7 screens are still there for 0.8.0, as **Classic app** (in the app's settings, or by holding
its icon).

## Get the app on your phone

### Android

Pick one:

1. **From the console, on the phone (easiest).** Open the console's **Apps** page on the phone, tap **Download** under
   Android, open the file, and allow installs from the browser when Android asks. Sign in.
2. **From a computer with this checkout, by USB or Wi-Fi.** Turn on USB debugging on the phone once (Settings > About
   phone > tap **Build number** 7 times; then Settings > System > Developer options > **USB debugging**). Then:

   | Computer | Command |
   | --- | --- |
   | macOS, Linux | `apps/install.sh android` |
   | Windows | `powershell -ExecutionPolicy Bypass -File apps\install.ps1` |

   Over Wi-Fi instead of a cable (Android 11+): Developer options > **Wireless debugging** > **Pair device with pairing
   code**, then `apps/install.sh android --pair <IP:PORT> <CODE>` and `apps/install.sh android --wifi <IP:PORT>` (on
   Windows: `-Pair <IP:PORT> -Code <CODE>`, then `-Wifi <IP:PORT>`). The script tells you how to get `adb` if it is
   missing (macOS `brew install --cask android-platform-tools`, Ubuntu `sudo apt install adb`, Windows
   `winget install Google.PlatformTools`).
3. **Build it yourself:** [`android/README.md`](android/README.md).

From version 0.7.0 on, **the app updates itself**: it checks the console when it opens and once a day, says *Update
available*, and installs the new version with a tap (Android asks once to allow installs from the app).

### iPhone, with a Mac

A free Apple ID is enough. Once:

1. Xcode from the App Store, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
2. Xcode > Settings > Accounts > **+** > Apple ID.
3. On the iPhone: Settings > Privacy & Security > **Developer Mode**, on (it restarts).
4. The app's configuration: `apps/configure.sh` (with AWS access), or **Download the configuration** on the console's
   Apps page into `apps/config/cranium.json`.
5. Plug the iPhone in and run `apps/install.sh iphone`. The first time it opens Xcode: press **Run**, then on the
   iPhone Settings > General > VPN & Device Management > trust your Apple ID.

Then keep it opening and up to date, with no cable: `apps/install.sh iphone --schedule`. Every hour the Mac renews the
7-day signature when it is due and installs each new version from `main`, whenever the iPhone is on the Mac's Wi-Fi.
`apps/ios/scripts/renew.sh --status` says how it stands.

### iPhone, without a Mac (SideStore)

Free, open source, and nothing to do with Apple's paid programme; each person uses their own Apple ID. Check
[sidestore.io](https://sidestore.io) first for your iOS version: recent iOS releases have broken its refresh before, and
whether it works on iOS 26.4 and later is not certain.

1. On the iPhone: **LocalDevVPN** from the App Store, and Developer Mode on (above).
2. On any computer (Mac, Windows, Linux), with the iPhone on USB: get **iloader** only from
   [its GitHub page](https://github.com/nab138/iloader) or iloader.app, sign in with your Apple ID (a spare one is
   safer), choose **SideStore (Stable)**, and install. It also puts the pairing file on the phone.
3. On the iPhone: trust your Apple ID (Settings > General > VPN & Device Management), open SideStore, sign in, and turn
   on LocalDevVPN when asked.
4. On the console's **Apps** page, on the phone: **Make my SideStore link** > **Add to SideStore**, then install
   **Cranium** from it. New versions then show in SideStore with an Update button, wherever you are. SideStore
   re-signs every 7 days; open it now and then with LocalDevVPN on.

The same build is in git as `dist/cranium-ios-<version>.ipa` (unsigned: SideStore signs it with your Apple ID).

## Check this computer

`apps/install.sh check` lists what is there and what is missing (git, python3, adb, Xcode, xcodegen, the configuration,
the builds in `dist/`, and the phones it can see).

## Release a new version (team)

1. Write the entry at the top of `ios/CHANGELOG.md` and/or `android/CHANGELOG.md` as `## <version>`; its first paragraph
   is what people see (at most 440 characters). Commit.
2. `apps/release.sh <version>` (both apps), or `apps/release.sh <version> android` / `ios`. It sets the version numbers,
   commits, pushes, and tags `android-v<version>` / `ios-v<version>`. GitHub's **Release the apps** workflow then builds,
   signs and publishes them on the console's Apps page; phones get them as above. From GitHub's website instead:
   Actions > Release the apps > **Run workflow**.
3. `apps/release.sh <version> --wait` also waits for the workflow and puts the published builds in `dist/`
   (`apps/fetch-builds.sh`, checked against the console's SHA-256), committed to git.

## The builds in `dist/`

| File | What |
| --- | --- |
| `cranium-android-<version>.apk` | The signed Android app, as the console serves it |
| `cranium-ios-<version>.ipa` | The unsigned iPhone app, for SideStore |
| `SHA256SUMS` | `shasum -a 256 -c SHA256SUMS` (Windows: `Get-FileHash`) checks them |
| `latest.json` | Version, size and SHA-256 of each, for scripts |

Only the newest of each is kept in the tree; git's history has the older ones, and the console has every one. The
builds hold `config/cranium.json`: the console's address, its Cognito sign-in domain and its user pool and client IDs,
which the public website serves to every visitor too. No password, key or token is in them; nobody signs in without an
account the team made.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| Android: "App not installed" | An older build signed with another key is on the phone: uninstall Cranium, install again |
| `adb devices` says `unauthorized` | Unlock the phone and accept "Allow USB debugging?" |
| iPhone: "Untrusted Developer" | Settings > General > VPN & Device Management > your Apple ID > Trust |
| iPhone app stopped opening after 7 days | `apps/install.sh iphone` (or turn on `--schedule`); SideStore: open it with LocalDevVPN on |
| "Developer Mode required" | Settings > Privacy & Security > Developer Mode, on |
| The app says the board's passkey is on the clipboard | In the phone's pairing box: tap the field, **Paste**, **Pair** |
