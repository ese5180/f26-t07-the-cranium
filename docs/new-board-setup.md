# Setting up a blank board

How to take an nRF7002 DK from nothing to a board that runs our firmware, has the golden image as its way back,
and shows up online in the console. It takes about 20 minutes.

**Only for a blank board, or one you mean to wipe.** Step 3 erases the whole chip, including TF-M storage, where a
board keeps its ID, Wi-Fi network, private key and certificates. Never run it on a working board: to update one,
use the console or `scripts/ota.sh`.

## What you need

| Thing | Why | Where it comes from |
| --- | --- | --- |
| nRF7002 DK and a USB cable | The board, and its debug port | The kit |
| nRF Connect SDK v3.4.0 and `nrfutil` | Building and flashing | nRF Connect for VS Code, or `nrfutil toolchain-manager` |
| The signing key, `~/.cranium/mcuboot_signing_key.pem` | Every image must be signed with it, or the bootloader won't run it | Whoever holds the team key: see [`secrets/README.md`](../secrets/README.md). `python tools/keys.py check` confirms you have the right one |
| The golden image, `binaries/golden/cranium-1.5.0-0.signed.bin` | The bootloader only restores that exact file | Copy it from whoever holds the signing key. It isn't in git, and a rebuild won't match it |
| The Wi-Fi network, `~/.cranium/wifi_secrets.h` | The board's network | `python tools/secrets.py wifi`. A phone hotspot's name often has a curly apostrophe: copy the exact spelling |
| An AWS sign-in with administrator rights | Registering the board in AWS IoT | `aws login --profile cranium --region us-east-1` |
| `cloud/.deploy/outputs.json` | The AWS IoT endpoint, and where firmware downloads from | Written by `cloud/deploy.sh`. Copy it from whoever deployed |

Run the Python tools from an nRF Connect SDK terminal, which has `pyserial` and `cbor2`. Close any serial terminal on the
board first: only one program can use a port at a time.

Find your debug probe's serial number with `nrfutil device list`. The commands below call it `<probe>`. The tools have a
default, which is our bench's probe, and it fails on any other.

## 1. Check the key and the golden image

```sh
python tools/keys.py check
python tools/golden.py check
```

Both must pass. The second checks that the golden file, `firmware/golden.json` and the bootloader's settings agree.

## 2. Build

```sh
scripts/build.sh --keep
```

This builds the bootloader, which holds the golden image's pin, and the application at the version in
`firmware/app/VERSION`. Each image is signed with your key.

## 3. Flash everything, erasing the chip

From an nRF Connect SDK terminal, in the repository:

```sh
west flash --recover
```

This erases both cores and writes the bootloader, TF-M with the application, and the network core's blinky. The board then
starts in **factory mode**: LED1 flashes long every 2 seconds, and its boot log says `State FACTORY`. That's expected.

## 4. Put the golden image on, and seal it

The golden copy goes into external flash, where the rescue button restores it from. First put 1.5.0 into the running slot,
which takes about 4 minutes:

```sh
python tools/golden.py restore --reset --serial-number <probe>
```

Then seal it with the gesture:

1. Press and hold RESET.
2. Press and hold Button 2.
3. Let go of RESET.
4. Keep holding Button 2 for 5 seconds, until LED1 blinks fast.
5. Let go within the next 5 seconds.

LED1 stays on while it copies, for about 45 seconds. The boot log says `sealed`, and the board runs 1.5.0. Do the gesture
again: it should do nothing, with one slow blink. That shows the copy is good.

**Only do this gesture on a board flashed with this bootloader.** On an older one, holding Button 2 while the application
starts is a factory reset.

## 5. Provision it

```sh
python tools/provision_device.py
```

This uses the board's serial console. It:

1. Sets the board's ID with `INIT`. The default is its chip's 16-digit identifier, or pass `--id <name>`.
2. Sends the Wi-Fi network from `~/.cranium/wifi_secrets.h`, with echo off, so the password never shows.
3. Has the board make its own key pair. The private key never leaves the board.
4. Registers the board in AWS IoT as `cranium-<its identifier>`, with a certificate for that key.
5. Loads the certificate, Amazon's root certificate, the AWS IoT endpoint and the download address onto the board.

It finishes by waiting for the board to reach AWS IoT. If the board was registered before and has been wiped, add
`--new-identity`, which retires its old certificate.

## 6. Update it to the current firmware

Open the console at https://console.craniumiot.com. The board should be online, running 1.5.0. On **Firmware**, deploy the
newest release. **Golden 1.5.0 waits for Button 1, so press it once** when the page asks. From 1.7.2 on, updates start by
themselves.

## 7. Check it

| Check | How | Expect |
| --- | --- | --- |
| Online | Console, Overview | Online, with a recent heartbeat |
| Firmware | Overview, or `STATUS` on the serial console | The release you deployed, confirmed |
| Provisioned | `python tools/provision_device.py --status` | State `OPERATING`; ID, Wi-Fi and certificates set |
| Bootloader | `python tools/recover.py --reset list` | The running image in slot 0. Then `python tools/recover.py reset` boots it again |

## If something goes wrong

| What you see | What to do |
| --- | --- |
| The build stops about the signing key | You don't have `~/.cranium/mcuboot_signing_key.pem`. Get the team key; don't generate a new one, or no existing board will accept your images |
| `golden.py check` fails | Your golden file isn't the frozen one. Copy `binaries/golden/` from the key holder |
| The gesture gives three slow blinks and `refused` | Neither copy is the pinned golden image. Run step 4's `restore` again |
| Provisioning can't find the network | Usually the hotspot isn't on, or its name differs by a character. Keep the phone on the hotspot screen, and check the name with `python tools/secrets.py wifi` |
| Provisioning fails at AWS | Your AWS sign-in has expired, or isn't an administrator's. Run `aws login` again |
| The board is offline afterwards | Usually the hotspot: give it a few minutes. `python tools/provision_device.py --wifi` sends the network again |
| You need to start over | `west flash --recover` and begin at step 3. Provisioning again needs `--new-identity` |

## Don't

- Don't run `west flash --recover`, `nrfutil device recover` or a full erase on a working board. They wipe its identity.
- Don't flash with `nrfutil device program` without `--options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE`. Its
  default erases TF-M storage.
- Don't hold Button 2 for 5 seconds while the board is running. That's a factory reset.
- Don't commit anything from `~/.cranium`, or `cloud/.deploy`.

More detail: [`firmware/README.md`](../firmware/README.md) for the firmware, the golden image and the serial console, and
[`docs/aws-iot.md`](aws-iot.md) for the board's identity in AWS.
