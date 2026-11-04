# Versions

Four things have their own version number, changelog and git tags. A small change or a fix is a patch (1.11.0 to
1.11.1); something new is a minor version (1.11.x to 1.12.0). Each version is a git tag on the commit it was built from,
so `git checkout <tag>` gives exactly that source.

| What | Version lives in | Changelog | Tag | Shown |
| --- | --- | --- | --- | --- |
| Firmware | `firmware/app/VERSION` (`scripts/build.sh` sets the next one) | [`firmware/CHANGELOG.md`](../firmware/CHANGELOG.md) | `firmware-v1.12.0` | On the console's Firmware page, each release with its note from the changelog |
| Console (website, API, AWS stack) | `cloud/VERSION` | [`cloud/CHANGELOG.md`](../cloud/CHANGELOG.md) | `console-v1.9.1` | On the console (its version and What's new) |
| iPhone app | `MARKETING_VERSION` in `apps/ios/project.yml` | [`apps/ios/CHANGELOG.md`](../apps/ios/CHANGELOG.md) | `ios-v0.4.0` | More, Help, About in the app; the console's Apps page |
| Android app | `craniumVersionName` in `apps/android/gradle.properties` | [`apps/android/CHANGELOG.md`](../apps/android/CHANGELOG.md) | `android-v0.4.0` | More, Help, About in the app; the console's Apps page |

The two phone apps keep the same number for the same features.

## Making a version

1. Change the code, and bump the version in its file. Firmware: `scripts/build.sh` takes the next unused one by itself.
2. Add the entry at the top of its changelog. The first paragraph is what people see, at most 440 characters.
3. Commit both with the change, and tag that commit: `git tag -a console-v1.10.0 -m "<the first paragraph>"`, then
   `git push origin main console-v1.10.0`. Tags are only ever added, never moved or deleted.

Every version listed in a changelog with a commit has its tag. A few early firmware numbers (1.0.1, 1.0.2, 1.1.6, 1.7.3,
1.7.5, 1.7.6) were earlier code built under a newer number and have no commit of their own, so no tag.

The console's versions before 1.9.1, and the apps' before 0.4.0, were given afterwards from the history.
