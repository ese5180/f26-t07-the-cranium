# Published app builds

The newest build of each app:

- **The phone apps:** byte for byte what the console's Apps page serves, put here by `apps/fetch-builds.sh` (or
  `apps/release.sh <version> --wait`).
- **The desktop app for Windows and Linux:** what its release job built, put here by
  `apps/fetch-desktop-builds.sh <windows|linux> <version>` ([docs/desktop-app.md](../../docs/desktop-app.md#releases)).
  A file over the 100 MiB (104,857,600 bytes) GitHub takes in git stays in the release run's artifact only. For 0.1.0
  that is the AppImage (about 126 MB): `Cranium-Setup-<version>.exe` and the `.deb` (about 100.6 MB, under the limit)
  come here; the AppImage, and any installer that grows past the limit, is downloaded from the release run instead.

`SHA256SUMS` and `latest.json` list every build here; both scripts write them (`apps/write-dist-index.py`). Check the
builds with `shasum -a 256 -c SHA256SUMS`. How to install them: [`../README.md`](../README.md). Local builds also land
in this folder; git ignores those unless a script adds them on purpose.
