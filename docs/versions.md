# Versions

Four things have their own version number, changelog and git tags. A small change or a fix is a patch (1.11.0 to
1.11.1); something new is a minor version (1.11.x to 1.12.0). Each version is a git tag on the commit it was built from,
so `git checkout <tag>` gives exactly that source.

| What | Version lives in | Changelog | Tag | Shown |
| --- | --- | --- | --- | --- |
| Firmware | `firmware/app/VERSION` (`scripts/build.sh` sets the next one) | [`firmware/CHANGELOG.md`](../firmware/CHANGELOG.md) | `firmware-v1.12.0` | On the console's Firmware page, each release with its note from the changelog |
| Console (website, API, AWS stack) | `cloud/VERSION` | [`cloud/CHANGELOG.md`](../cloud/CHANGELOG.md) | `console-v1.10.0` | At the foot of every page of the console ("Console 1.10.0"), What's new on its History page, and `GET /api/me` |
| iPhone app | `MARKETING_VERSION` in `apps/ios/project.yml` | [`apps/ios/CHANGELOG.md`](../apps/ios/CHANGELOG.md) | `ios-v0.5.1` | More, Help, About in the app; the console's Apps page, from the changelog as deployed |
| Android app | `craniumVersionName` in `apps/android/gradle.properties` | [`apps/android/CHANGELOG.md`](../apps/android/CHANGELOG.md) | `android-v0.5.0` | More, Help, About in the app; the console's Apps page, each version as it was published |

The two phone apps keep the same number for the same features.

## Making a version

1. Change the code, and bump the version in its file. Firmware: `scripts/build.sh` takes the next unused one by itself.
2. Add the entry at the top of its changelog. The first paragraph is what people see, at most 440 characters.
3. Commit both with the change, and tag that commit: `git tag -a console-v1.11.0 -m "<the first paragraph>"`, then
   `git push origin main console-v1.11.0`. Tags are only ever added, never moved or deleted.

Every version listed in a changelog with a commit has its tag. A few early firmware numbers (1.0.1, 1.0.2, 1.1.6, 1.7.3,
1.7.5, 1.7.6) were earlier code built under a newer number and have no commit of their own, so no tag.

The console's versions before 1.9.1, and the apps' before 0.4.0, were given afterwards from the history.

## How the console shows them

`cloud/deploy.sh` writes `versions.json` while it packages the stack (`cloud/web/build-versions.mjs`), beside
`history.json`, in two places that git ignores: the site's assets and the API's code. It holds the console's version
from `cloud/VERSION`, the commit and whether the files matched it, and every entry of the four changelogs, newest
first, each its version and first paragraph (and its commit and date where the entry names them). So:

- **The console's version** is at the foot of every page, "Console 1.10.0 · 1a2b3c4", from `GET /api/me`, which says
  `console: { version, commit }`. The phone apps read it there too.
- **What's new**, on the History page, lists the console's versions with their notes, the deployed one marked.
- **The iPhone app** on the Apps page has the version and note of the newest entry in `apps/ios/CHANGELOG.md`, as
  deployed: it is built from the repository and never uploaded. A new iPhone version shows after the next deployment.

A checkout that was never deployed has no `versions.json`: the foot says the version is not known, and What's new
points to `cloud/CHANGELOG.md`. The local preview (`cloud/dev/preview.mjs`) makes it from the checkout.

So a new console version shows once it is deployed: bump `cloud/VERSION`, add its entry, commit, tag, deploy.

## Publishing an Android version

`apps/android/build-release.sh` builds the signed APK, `apps/dist/cranium-android-<version>.apk`, and publishes it on
the console's Apps page with your API token (`apps/android/publish.sh`; `--no-publish` to skip). The note is the first
paragraph of the version's entry in `apps/android/CHANGELOG.md`, so write the entry before the build. The console takes
a version once and only upward, by `craniumVersionName` and by `craniumVersionCode`; publishing the same APK again is
fine, other bytes under a published version are refused. To publish an APK built earlier, give its `versionCode`:
`apps/android/publish.sh apps/dist/cranium-android-0.4.0.apk --version-code 4`. How it goes, step by step:
[`docs/mobile-apps.md`](mobile-apps.md#the-apps-page).
