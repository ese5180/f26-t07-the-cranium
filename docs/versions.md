# Versions

Four things have their own version number, changelog and git tags. The rule is the same for all four: the last number
for a small change or a fix (1.11.0 to 1.11.1), the middle one for a larger update (1.11.x to 1.12.0), and never the
first. Each version is a git tag on the commit it was built from, so `git checkout <tag>` gives exactly that source.

| What | Version lives in | Changelog | Now (2026-11-05) | Shown |
| --- | --- | --- | --- | --- |
| Firmware | `firmware/app/VERSION` (`scripts/build.sh` sets the next one) | [`firmware/CHANGELOG.md`](../firmware/CHANGELOG.md) | 1.14.0, tag `firmware-v1.14.0` (da27f3a): on the console, in Memfault, and on the board | On the console's Firmware page, each release with its note from the changelog |
| Console (website, API, AWS stack) | `cloud/VERSION` | [`cloud/CHANGELOG.md`](../cloud/CHANGELOG.md) | 2.1.0, tag `console-v2.1.0` (bcc5a19): deployed | At the foot of every page of the console ("Console 2.1.0"), What's new on its History page, and `GET /api/me` |
| iPhone app | `MARKETING_VERSION` in `apps/ios/project.yml` (and `CURRENT_PROJECT_VERSION`, the build, counts the versions) | [`apps/ios/CHANGELOG.md`](../apps/ios/CHANGELOG.md) | 0.7.2, tag `ios-v0.7.2` (e64bee5): published | More, Help, About in the app; the console's Apps page and every member's SideStore source, each version as it was published (before the first, from the changelog as deployed) |
| Android app | `craniumVersionName` in `apps/android/gradle.properties` | [`apps/android/CHANGELOG.md`](../apps/android/CHANGELOG.md) | 0.7.2, tag `android-v0.7.2` (e64bee5): published | More, Help, About in the app; the console's Apps page, each version as it was published |

The two phone apps keep the same number for the same features.

## Making a version

1. Change the code, and bump the version in its file. Firmware: `scripts/build.sh` takes the next unused one by itself.
2. Add the entry at the top of its changelog. The first paragraph is what people see, at most 440 characters.
3. Commit both with the change, and tag that commit: `git tag -a console-v2.1.1 -m "<the first paragraph>"`, then
   `git push origin main console-v2.1.1`. Tags are only ever added, never moved or deleted.

Every version listed in a changelog with a commit has its tag. A few early firmware numbers (1.0.1, 1.0.2, 1.1.6, 1.7.3,
1.7.5, 1.7.6) were earlier code built under a newer number and have no commit of their own, so no tag.

The console's versions before 1.9.1, and the apps' before 0.4.0, were given afterwards from the history.

The console's 2.0.0 (the customer site) broke the rule: it should have been 1.11.0. Its tag stays, because tags are
never moved, so the console goes on from 2.x (2.0.1, 2.1.0, ...) under the same rule.

## How the console shows them

`cloud/deploy.sh` writes `versions.json` while it packages the stack (`cloud/web/build-versions.mjs`), beside
`history.json`, in two places that git ignores: the site's assets and the API's code. It holds the console's version
from `cloud/VERSION`, the commit and whether the files matched it, and every entry of the four changelogs, newest
first, each its version and first paragraph (and its commit and date where the entry names them). So:

- **The console's version** is at the foot of every page, "Console 2.1.0 · bcc5a19", from `GET /api/me`, which says
  `console: { version, commit }`. The phone apps read it there too.
- **What's new**, on the History page, lists the console's versions with their notes, the deployed one marked.
- **The iPhone app** on the Apps page is the newest version published as an IPA, with its note (below). Before any is
  published, the page has the version and note of the newest entry in `apps/ios/CHANGELOG.md`, as deployed.

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

## Publishing an iPhone version

`apps/ios/scripts/build-ipa.sh` builds the unsigned IPA, `apps/dist/cranium-ios-<version>.ipa`, and
`apps/ios/scripts/publish.sh` publishes it on the console with your API token (`build-ipa.sh --publish` does both),
where every member's SideStore source lists it. The note is the first paragraph of the version's entry in
`apps/ios/CHANGELOG.md`; the build is `CURRENT_PROJECT_VERSION`, read from the IPA's own Info.plist. The console takes
a version once and only upward, by `MARKETING_VERSION` and by `CURRENT_PROJECT_VERSION`, so raise both. How it goes:
[`docs/mobile-apps.md`](mobile-apps.md#updates-on-every-phone).

## Releasing from anywhere

A tag does it all: `.github/workflows/release-apps.yml` builds and publishes the app the tag names, on GitHub Actions,
once the commit has the new version and its changelog entry. Push the tag from any clone, or make it on GitHub's
website (Releases > Draft a new release > Choose a tag > Create new tag on publish), or run the workflow again from
Actions > Release the apps > Run workflow:

```sh
git tag -a android-v0.7.3 -m "<the first paragraph>" && git push origin main android-v0.7.3
git tag -a ios-v0.7.3 -m "<the first paragraph>" && git push origin main ios-v0.7.3
```

`apps/release.sh <version>` does the same for both apps, the version numbers and the commit included
([`apps/README.md`](../apps/README.md#release-a-new-version-team)). The workflow released both apps' 0.7.1 and 0.7.2, and
the iPhone app's 0.7.0, this way ([`docs/ci.md`](ci.md#releasing-the-apps)), and it refuses a tag that is not the version in the app's files. It needs
four repository secrets, all set now. The owner sets them from a clone (each read from standard input, none echoed;
[`docs/ci.md`](ci.md#releasing-the-apps) has what each holds and what they risk):

```sh
REPO=ese5180/f26-t07-the-cranium
base64 -i ~/.cranium/android/cranium-release.jks | gh secret set ANDROID_KEYSTORE_BASE64 --repo "$REPO"
gh secret set ANDROID_KEYSTORE_PROPERTIES --repo "$REPO" < ~/.cranium/android/keystore.properties
gh secret set CRANIUM_CONFIG_JSON --repo "$REPO" < apps/config/cranium.json
gh secret set CRANIUM_CONSOLE_TOKEN --repo "$REPO" < ~/.cranium/console-token
```

The token is a release manager's and lasts at most 90 days: set `CRANIUM_CONSOLE_TOKEN` again with a new one before it
runs out.
