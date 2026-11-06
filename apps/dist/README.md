# Published app builds

The newest build of each app:

- **The phone apps:** byte for byte what the console's Apps page serves, put here by `apps/fetch-builds.sh` (or
  `apps/release.sh <version> --wait`).
- **The desktop app for Windows and Linux:** what its release job built, put here by
  `apps/fetch-desktop-builds.sh <windows|linux> <version>` ([docs/desktop-app.md](../../docs/desktop-app.md#releases)).
  GitHub takes no file over 100 MiB (104,857,600 bytes) in git, so such an installer is kept in parts of 90 MiB:
  `<installer>.part01`, `.part02`, ..., and its whole SHA-256 in `<installer>.sha256`. For 0.1.0 that is the AppImage
  (about 126 MB, two parts); `Cranium-Setup-<version>.exe` and the `.deb` (about 100.6 MB) are whole. To install the
  AppImage from here:

  ```
  apps/join-build.sh apps/dist/Cranium-0.1.0.AppImage ~/Applications
  ~/Applications/Cranium-0.1.0.AppImage
  ```

  `join-build.sh` joins the parts in order, checks the joined file against its SHA-256 and keeps it only if it
  matches, made executable.

`SHA256SUMS` and `latest.json` list every build here; both scripts write them (`apps/write-dist-index.py`). Check the
builds with `shasum -a 256 -c SHA256SUMS`. How to install them: [`../README.md`](../README.md). Local builds also land
in this folder; git ignores those unless a script adds them on purpose.
