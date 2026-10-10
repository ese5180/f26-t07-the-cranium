# Local secrets

Nothing in this directory is committed except this file and the `*.example` templates
(see `.gitignore`). It holds what each developer needs on their own machine and must
never be pushed, pasted into chat, or attached to an issue.

| File | What it is | How it gets here |
| --- | --- | --- |
| `mcuboot_signing_key.pem` | ECDSA P-256 private key that signs every firmware image. The boards only run images signed with it. | `python tools/keys.py generate`, or from the team's key custodian over a secure channel |

The public half of the signing key is committed at `firmware/keys/fw_signing_pub.pem`.
That is safe: a public key can only verify signatures, not create them.

If the signing key is lost, no new firmware can be installed over the air on boards
that trust it; they have to be reflashed over the debug port with a bootloader built
for a new key. If it leaks, anyone can sign firmware those boards will accept. Keep
exactly as many copies as you need, and know where each one is.
