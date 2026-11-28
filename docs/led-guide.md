# What the board's LEDs mean

A quick guide to reading a Cranium board from across the room: every LED pattern on the nRF7002 DK, what it
means, and what to do about it. The code behind it is `firmware/app/src/ui.c` (LED1 and LED2).

## How to read the patterns

Every pattern repeats every **2 seconds**, in 16 steps of 125 ms. In the strips below, each character is one
step, left to right: `█` is on, `·` is off.

```
█···············   one short flash (125 ms) every 2 s
████············   one long flash (half a second) every 2 s
```

## nRF7002 DK (Wi-Fi and Bluetooth)

Only LED1 and LED2 are wired to the nRF5340 application core on this board; LED3 and LED4 are never lit by
the firmware.

| What you see | LED1 | LED2 | Meaning | What to do |
| --- | --- | --- | --- | --- |
| Long flash | `████············` | dark | Factory mode, waiting for `INIT` | Set the board up: console **Board setup**, or `INIT` on the serial console |
| Short flash | `█···············` | dark | Set up, but not provisioned yet (no certificate) | Finish **Board setup** (provisioning) |
| Slow blink | `████████········` | dark | Joining Wi-Fi | Wait; if it never stops, check the Wi-Fi settings and that the network is in range |
| Medium blink | `████····████····` | dark | On Wi-Fi, connecting to the cloud | Wait; if it never stops, check the board's certificate and the time |
| Taking turns | `██··██··██··██··` | `··██··██··██··██` | Online, nothing to do | Nothing: all is well |
| Double flash | `█·█·····█·█·····` | dark | Downloading or checking an update from the cloud; on a Bluetooth build with its window open, a phone or computer is paired | Keep it powered; over Bluetooth, send the update |
| Triple flash | `█·█·█···········` | dark | New firmware running on trial | Keep it powered; it confirms itself once it reaches the cloud |
| Fast blink | `█·█·█·█·█·█·█·█·` | dark | An update is waiting for a button press: an image that arrived over Bluetooth, or one from the cloud on firmware before 1.7.2, golden image 1.5.0 or a build with `CONFIG_APP_OTA_REQUIRE_USER_CONSENT` | **Button 1** installs it, **Button 2** declines (or erases) it |
| Four flashes | `█·█·█·█·········` | dark | Bluetooth update window open for 180 s, nothing linked yet (Bluetooth builds; hold **Button 1** for 5 s to open it) | Connect from the app's **Bluetooth** page |

## Patterns that override the state

| What you see | Meaning |
| --- | --- |
| LED1 and LED2 blinking **together**, 5 times a second | **Identify** from the console (Devices → a board → Identify), 15 s unless asked otherwise. Then the state shows again |
| Every LED dark for about a minute and a half | The bootloader is swapping in a new image after an update. Don't unplug it |

## Buttons, for reference

- **Button 1**: accepts a waiting update where a press is needed (see the fast blink). Held for 5 seconds and
  released, it opens the Bluetooth window on Bluetooth builds (nothing from the cloud or the console can).
- **Button 2**: declines a waiting update, closes a Bluetooth window or erases an image that has arrived; held
  for 5 seconds and released, it erases everything provisioned (factory reset), the passkey too.
- Held through a reset, **Button 2** starts the golden image restore (see `firmware/README.md`).

The full detail, with each version's changes, is in [firmware/README.md](../firmware/README.md#what-the-leds-show).
