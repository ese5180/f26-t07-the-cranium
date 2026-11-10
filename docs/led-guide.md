# What the board's LEDs mean

A quick guide to reading a Cranium board from across the room: every LED pattern on the nRF7002 DK and the
nRF5340 DK, what it means, and what to do about it. The code behind it is `firmware/app/src/ui.c` (LED1 and
LED2 on both boards) and `firmware/app/src/bt_only/bt_only_leds.c` (LED3 and LED4, nRF5340 DK only).

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
| Double flash | `█·█·····█·█·····` | dark | Downloading or checking an update | Keep it powered |
| Triple flash | `█·█·█···········` | dark | New firmware running on trial | Keep it powered; it confirms itself once it reaches the cloud |
| Fast blink | `█·█·█·█·█·█·█·█·` | dark | An update is waiting for a button press (only firmware before 1.7.2, golden image 1.5.0, or a build with `CONFIG_APP_OTA_REQUIRE_USER_CONSENT`) | **Button 1** installs it, **Button 2** declines it |
| Four flashes | `█·█·█·█·········` | dark | Bluetooth update window open for 180 s, nothing linked yet (Bluetooth builds; hold **Button 1** for 5 s to open it) | Connect from the app's **Bluetooth** page |

## nRF5340 DK (Bluetooth only)

LED1 and LED2 use the same patterns as the nRF7002 DK where the state exists on this board (there is no
Wi-Fi or cloud here). LED3 and LED4 are extra.

| What you see | LEDs | Meaning | What to do |
| --- | --- | --- | --- |
| Long flash | LED1 `████············` | Factory mode, waiting for `INIT` | **Board setup** or `INIT` on the serial console |
| Short flash | LED1 `█···············` | Set up, but no passkey of its own: nothing can pair without the serial console | Provision it in **Board setup** |
| Taking turns | LED1 and LED2, as above | Ready: nothing to do, a Bluetooth window can be opened | Nothing |
| Four flashes | LED1 `█·█·█·█·········` | Bluetooth is open, nothing paired yet | Connect from the app's **Bluetooth** page |
| Double flash | LED1 `█·█·····█·█·····` | A phone or computer is paired | Send the update |
| Fast blink | LED1 `█·█·█·█·█·█·█·█·` | An image has arrived | **Button 1** installs it, **Button 2** erases it |
| Triple flash | LED1 `█·█·█···········` | New firmware running on trial | A person has to prove it works |
| LED3 steady | LED3 `████████████████` | A phone or computer is connected | — |
| LED3 fast blink | LED3 `█·█·█·█·█·█·█·█·` | An image is arriving | Keep the device near the board |
| LED4 steady | LED4 on for 30 s | Something went wrong that a person should see: a refused command or upload, a failed pairing, an image that did not stay (reverted), or Bluetooth failing to start | Look at the serial console or the app for the reason |

## Patterns that override the state (both boards)

| What you see | Meaning |
| --- | --- |
| LED1 and LED2 blinking **together**, 5 times a second | **Identify** from the console (Devices → a board → Identify), 15 s unless asked otherwise. Then the state shows again |
| Both dark ½ s, then LED1, LED2 and both for 1 s each, then dark ½ s | The **hardware self-test** (`SELFTEST`, from firmware 1.17.1, nRF7002 DK only) |
| Every LED dark for about a minute and a half | The bootloader is swapping in a new image after an update. Don't unplug it |

## Buttons, for reference

- **Button 1**: accepts a waiting update where a press is needed (see the fast blink). Held for 5 seconds and
  released, it opens the Bluetooth window on Bluetooth builds (nothing from the cloud or the console can).
- **Button 2**: declines a waiting update, closes a Bluetooth window or erases an image that has arrived; held
  for 5 seconds and released, it erases everything provisioned (factory reset), the passkey too.
- Held through a reset, **Button 2** starts the golden image restore (see `firmware/README.md`).

The full detail, with each version's changes, is in [firmware/README.md](../firmware/README.md#what-the-leds-show).
