# binaries

Every `west build` of this checkout stores its signed image here, by itself. Git ignores
everything in this folder except this file.

| File | What it is |
| --- | --- |
| `latest.signed.bin` | The newest build |
| `latest.json` | Its version, size, SHA-256, git commit and build time |
| `cranium-<version>-<build>.signed.bin` | Each version, the newest ten of them |

Two ways to put an image on a board over the air:

- **From the command line:** `scripts/ota.sh` installs the newest build, and
  `scripts/ota.sh binaries/cranium-1.2.0-0.signed.bin` installs that one.
- **From the website:** on the console's Firmware page, choose the file here. The server
  checks its signature against the project's public key before it stores anything, and
  then offers to deploy it.

A release must be newer than every release uploaded before it, so set a new version in
`firmware/app/VERSION` before you build. Images built by the test bench and images with a
test fault built in are not kept here.
