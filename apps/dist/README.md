# Published phone app builds

The newest build of each app, byte for byte what the console's Apps page serves, put here by
`apps/fetch-builds.sh` (or `apps/release.sh <version> --wait`). Check them with `shasum -a 256 -c SHA256SUMS`.
How to install them: [`../README.md`](../README.md). Local builds also land in this folder; git ignores those
unless a script adds them on purpose.
