# scripts

## The ones you run

| Script | What it does |
| --- | --- |
| `build.sh` | Builds the firmware with the next unused version, and leaves the signed image in `binaries/` |
| `ota.sh` | Installs an image from `binaries/` on the board over the air, and follows it to the end. With an API token it needs no AWS credentials; with no USB, it follows through the cloud |
| `open-console.sh` | Signs in to AWS and opens the console |
| `github-release.sh` | Publishes a signed image as a GitHub Release, for whoever holds the signing key |

A normal update is:

```sh
scripts/build.sh    # makes binaries/cranium-<version>-0.signed.bin
scripts/ota.sh      # installs the newest one, or upload it on the console's Firmware page
```

`build.sh --help` lists its options. Run them from a normal terminal: they load the nRF Connect SDK toolchain themselves.

### `ota.sh` with an API token

A release manager can let `ota.sh`, or an assistant that runs it for them, update the board without AWS
credentials:

1. On the console, open **Developer > API tokens**, choose **New token**, give it a name and a lifetime (1 to
   90 days), and copy the token. It starts with `crn_` and is shown only once.
2. Keep it where `ota.sh` looks, readable by you alone:

   ```sh
   mkdir -p ~/.cranium && (umask 077 && pbpaste > ~/.cranium/console-token)   # mode 600
   ```

   `CRANIUM_TOKEN=crn_…` works instead, and is used first.
3. Run `scripts/ota.sh` as usual. It finds the console in `cloud/.deploy/outputs.json` (or
   `CRANIUM_CONSOLE_URL`), uploads and deploys through `/api/t/` with curl, and follows the board through the
   console. `--thing <name>` picks the board when there are several.

The script refuses a token file that is a link, someone else's, or not mode 600, and it never prints the
token. The token acts as you, with the role you have when it is used: a viewer's token cannot install
anything. Revoke it on the same page when it is no longer needed. `scripts/ota.sh --aws` uses AWS
credentials instead, as before. More in [`docs/aws-iot.md`](../docs/aws-iot.md#api-tokens).

## Used by CI and the other scripts

| Script | What it does |
| --- | --- |
| `scan-tracked-files.sh` | Fails if a tracked file holds a private key or Wi-Fi secrets |
| `check-west-workspace.sh` | Checks CI's cached SDK against the pinned version |
| `verify-github-release.sh` | Checks a published release's files |
| `release-lib.sh` | Checks shared by the two release scripts |

Setting up a blank board is in [`docs/new-board-setup.md`](../docs/new-board-setup.md).

## Where things go

| Folder | What's in it | In git? |
| --- | --- | --- |
| `binaries/` | Every build's signed image, and `latest.*` pointing at the newest | No, only its README |
| `binaries/golden/` | The frozen golden image. Irreplaceable: see `binaries/README.md` | No |
| `build/` | The last build's working files, and `last-build.log` | No |
| `build-bench/` | Test images and their builds | No |
| `build-hil/` | Test bench logs and results | No |
| `ota-demo/` | Demo images and the checkoff study guide, on this Mac only | No |
