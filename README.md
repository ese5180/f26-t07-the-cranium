# ESE5180: IoT Venture

## 3.1 Team Formation

**Team Number: T07**

**Team Name: Cranium**

| Team Member Name   | Email Address                  |
| ------------------ | ------------------------------ |
| Demetrius Bosket   | dbosket@engineering.upenn.edu  |
| Adam Shalabi       | adamshal@engineering.upenn.edu |
| Christian Durante  | cgd2@engineering.upenn.edu     |
| Vihaan Ravishankar | vihaan1@engineering.upenn.edu  |

**GitHub Repository URL: https://github.com/ese5180/f26-t07-the-cranium**

## 3.2 Concept Development

### Description

Cranium is a mounted attachment to beginner DJ controllers, starting with the Pioneer DDJ-FLX4, that removes the need for a laptop. A Raspberry Pi 4 runs Mixxx on a built-in 7-inch touchscreen, and a Nordic nRF7002 DK (an nRF5340 plus the nRF7002 Wi-Fi 6 chip) keeps every unit connected for signed over-the-air updates and fleet monitoring. This solution will be more familiar, user-friendly and cost-effective than directly upgrading these popular controllers to all-in-one DJ systems.

### Production Function

Cranium runs Mixxx, the open source DJ software, on a built-in Raspberry Pi 4 with a 7-inch touchscreen (a balance between usability and size), so up and coming hobbyist DJs can perform with less equipment and less risk than existing solutions. Instead of a cumbersome, personally valuable laptop, or an awkward phone mount that’s unusable with Mixxx’s GUI, Cranium is plug and play: the controller connects over USB, music loads from a USB drive, and the cable management is handled ahead of time. The nRF5340 on the nRF7002 DK handles the wireless side: Wi-Fi to AWS IoT for signed firmware updates, crash reports through Memfault and set history for our customer site, plus Bluetooth LE so our phone app can update a unit when no Wi-Fi is around.

### 3.2.3 Target Market & Demographics

We’re building a \$230 add-on that turns laptop-dependent DJ controllers like the Pioneer DDJ-FLX4 into standalone DJ systems, so DJs can leave their laptops at home without replacing the controller they already own. We’re targeting new and intermediate DJs in the U.S. who own an FLX4 and are moving into parties, events, and mobile gigs, with the broader DJ-controller market estimated at ~\$310m annually, 28% of which comes from the U.S., and a current FLX4 userbase of ~500,000 with an additional ~120,000 sold annually. Our first customer interview with an intermediate FLX4 owner validated laptop dependence as the core pain point, with Pioneer’s standalone XDJ line being their main potential alternative.

- Who will be using your product?
  - New and intermediate FLX4 DJs.
- Who will be purchasing your product?
  - FLX4 owners seeking standalone capability + their friends and family as gifts
- Where would you deploy your product?
  - U.S. first through online D2C, then globally.
- How large is the target market?
  - ~\$28M existing U.S. FLX4 market, growing by \$7.1M annually
- How much do you expect to capture? ~\$1.15M/year by Year 3 (about 5,000 units, or 1% adoption, at our \$230 price)
- What competitors are already in the space?
  - Pioneer’s XDJ systems as the traditional standalone alternative, less desirable standalone systems from Numark and Denon, and DeckShark as an early-stage add-on startup.
  - Standalone decks start at \$699 (Numark Mixstream Pro+), and the closest match, AlphaTheta’s OMNIS-DUO, is \$1,499. Some DJs get by with a phone and a DJ app, or a DIY Raspberry Pi build, which takes a tech-savvy user and time

### 3.2.4 Stakeholders

* Customer perspectives of 3 exact target customers (intermediate level Pioneer FLX4 owners who play small/medium live events)
  * Already held interviews, obtained specific pricing perspectives and target DJ controllers.
  * Price point is targeting to a common tipping point for customers
    * What they told us: price matters most. They want XDJ-style standalone use for under \$250, which is why we price at \$230.
  * Battery power is not important to them if it adds cost, so the MVP runs from a USB-C wall supply.
  * It has to feel robust. DeckShark’s 3D-printed hook-on case feels cheap to them, and they would rather slide the controller into a dock or rail, so our casework is a rail plus a screen and board frame.
* An EE and music technologist we reached through Demetrius’s Drexel contact, for input on audio processing.
* Competitor's (DeckShark) Community Discord - finding additional consumer perspectives and specific failure points of direct competitors.

### 3.2.5 System-Level Diagrams

- **Create a device block diagram that details the power architecture, microcontroller, & peripherals**

![Block diagram](<pics/Block Diagram.png>)

- **Create a communication diagram**

![Communication diagram](<pics/Communication Diagram.png>)

The table gives the same architecture in words.

| Block         | Now (MVP)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power         | 5.1 V / 3 A USB-C wall supply into the Raspberry Pi 4. The Pi powers the 7-inch display, and its USB ports power the FLX4, the music drive and (planned) the nRF7002 DK. No battery in the MVP.                                                                                                                                                                                                                                                                                                    |
| Processors    | Raspberry Pi 4 (2 GB): Mixxx, the touchscreen UI and audio. nRF5340 on the nRF7002 DK: Wi-Fi through the nRF7002, Bluetooth LE, MCUboot and TF-M secure boot, signed OTA updates and Memfault.                                                                                                                                                                                                                                                                                                     |
| Peripherals   | Pioneer DDJ-FLX4 over USB (MIDI control plus its built-in sound card, so audio leaves through the FLX4’s RCA master output and headphone jack), the 7-inch 800 x 480 DSI touchscreen, a USB drive for the music library, and on the DK an 8 MB external flash for the update slot and two buttons.                                                                                                                                                                                                |
| Communication | Wi-Fi from the nRF7002 DK to AWS IoT Core (MQTT with mutual TLS); update images come over HTTPS from S3, and Memfault data rides the same link. Bluetooth LE from our phone app, with passkey pairing, for status and updates when there is no Wi-Fi. The console, the customer site (craniumiot.com) and the apps talk to AWS. A UART link from the Pi to the nRF5340 for the heartbeat and session data is planned; it needs a 1.8 V to 3.3 V level shifter because the DK’s I/O runs at 1.8 V. |

### 3.2.6 Security Requirements Specification

| Code   | Name                  | Definition                                                                                                                                                                                                                                                                               |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC 01 | Firmware Verification | The system shall run only signed firmware images. Firmware images shall be protected from being modified or copied.                                                                                                                                                                      |
| SEC 02 | Initialization        | The device shall implement secure boot functionality to prevent unauthorized firmware modifications                                                                                                                                                                                      |
| SEC 03 | BLE Link              | The Bluetooth LE link shall require passkey pairing (authenticated and encrypted) before a phone can read a unit’s status or send it a firmware image. An image sent over Bluetooth shall install only after a button press on the unit and the same signature check as a Wi-Fi update. |
| SEC 04 | OTAFU                 | Updates shall be written to an inactive partition, and the device shall automatically roll back if the new image fails to boot. Updates shall start only when a release manager, signed in with a password and an authenticator code, deploys them, and not while audio is playing.      |
| SEC 05 | Physical security     | The enclosure shall be spill-resistant and include a lock slot, with no externally accessible debug headers. The unit shall mount securely to the controller without loading its ports.                                                                                                  |

### 3.2.7 Hardware Requirements Specification

| Code  | Name                    | Definition                                                                                                                                                                                                                                       |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HW 01 | Processors              | The device shall be controlled by the nRF5340 microcontroller on a Nordic nRF7002 DK, which manages the I/O peripherals, the nRF7002 Wi-Fi 6 companion chip and Bluetooth LE. A Raspberry Pi 4 (2 GB) shall run Mixxx and drive the touchscreen. |
| HW 02 | Operable without laptop | All playback functions, mixing, library browsing, and setup shall be fully operable using only the controller and built in screen. No external computer is required at any point.                                                                |
| HW 03 | Deck Interface          | USB-C female port, 2 buttons, 2 USB-A female ports, and a 7-inch 800 x 480 capacitive touchscreen                                                                                                                                                |
| HW 04 | Wired Audio Outputs     | Audio shall play through the controller’s built-in sound card (on the FLX4, the RCA master output and the 3.5 mm headphone jack), so the MVP adds no audio hardware. Dual XLR outputs should be added in a later revision.                      |
| HW 05 | Mechanical              | The unit shall mount on the FLX4 with zero mechanical load on the controller’s USB and RCA ports.                                                                                                                                               |

### 3.2.8 Software Requirements Specification

| Code   | Name                      | Definition                                                                                                                                                                                                                                 |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SRS 01 | Boot and Device Detection | The system shall boot within 30 seconds of power-on and shall recognize the controller within 5 seconds of connection. If the controller is disconnected, the system shall resume operation upon reconnection without requiring a restart. |
| SRS 02 | Audio Performance         | The system shall play audio with no more than 3 seconds of delay and no audio dropouts during a test with two decks and effects running.                                                                                                   |
| SRS 03 | MCU/PI Handshake          | The nRF5340 shall exchange a heartbeat with the Pi over UART and report the unit’s power status: USB supply present and supply voltage today, and battery level once a battery is fitted.                                                 |
| SRS 04 | Library Support           | The system shall support libraries prepared directly from a USB drive, keeping the user’s playlists and saved track markers.                                                                                                              |
| SRS 05 | Data Integrity            | The MCU shall trigger a graceful shutdown, with no filesystem corruption, when the user powers off or the supply runs low (battery below 5% once a battery is fitted).                                                                     |

# Power Budget

Rough budget for one unit, in milliamps at 5 V from the 5.1 V / 3 A USB-C supply. Nothing has been measured on an assembled unit yet, so these are datasheet and reference figures. We will check them with a USB power meter on the input and with the PPK2 on the nRF5340 rail.

| Load                                | Powered from | Typical (mA)  | Peak (mA)      | Basis                                                                                                                                                                                                         |
| ----------------------------------- | ------------ | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raspberry Pi 4 (2 GB) running Mixxx | USB-C supply | 600           | 1,400          | Raspberry Pi’s typical bare-board figure is 600 mA; a Pi 4 has been measured above 1,400 mA under full four-core load                                                                                        |
| Hosyond 7-inch DSI touchscreen      | From the Pi  | 440           | 440            | 2.2 W at 5 V (product listing), backlight on                                                                                                                                                                  |
| Pioneer DDJ-FLX4 controller         | Pi USB       | 500           | 500            | Rated USB bus power, 5 V / 500 mA                                                                                                                                                                             |
| nRF7002 DK (nRF5340 + nRF7002)      | Pi USB       | 60            | 250            | Estimate, including the DK’s on-board debugger. nRF7002: 191 mA transmitting at full power (2.4 GHz), 49.6 mA listening, about 1.1 mA average in power save. nRF5340 application core: about 8 mA at 128 MHz |
| USB flash drive (music library)     | Pi USB       | 100           | 200            | Estimate for a typical USB 2.0 flash drive                                                                                                                                                                    |
| Total                               |              | 1,700 (8.5 W) | 2,790 (14.0 W) | 57% (typical) and 93% (peak) of the 3 A supply                                                                                                                                                                |
| Pi USB ports only                   |              | 660           | 950            | FLX4, DK and drive together; the Pi 4 shares 1.2 A across its USB ports                                                                                                                                       |

The 3 A supply covers the peak case with little margin. The USB ports stay under the Pi’s 1.2 A limit as long as the library is on a flash drive rather than a bus-powered hard drive. If we need more headroom, the FLX4 can take power from its own power-only USB-C port instead of the Pi.

There is no battery in the MVP, and our interviewees did not rank battery power as important. If we add one later, a 10,000 mAh USB-C power bank (about 37 Wh) would run the typical load for roughly 3.5 hours.

The nRF7002 DK is not in the BOM sheet (see Hardware BOM), but it is in this budget because every unit runs one.

# Hardware BOM

From the Hardware BOM tab of the [Cranium BOM and Cost Model](https://docs.google.com/spreadsheets/d/1DxhXXcjT0Hgploqj7x2QWS54r0ZcuMWR_F7q05EQHGE/edit) sheet. Costs are per unit in USD. The 1K column uses unit prices at a 1,000-unit build, and parts without a volume quote stay at retail. Tax, freight, software and tooling are not in these totals; tooling is in the financial model.

| Item                 | Description                                                | Manufacturer, part no.                            | Distributor, part no.        | Qty | 1-unit build | 1K build |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------- | ---------------------------- | --- | ------------ | -------- |
| Electrical           |                                                            |                                                   |                              |     | \$116.55      | \$114.80  |
| Raspberry Pi         | Raspberry Pi 4 Model B, 2 GB RAM                           | Raspberry Pi Ltd, SC0193                          | CanaKit, PI4-2GB             | 1   | \$67.50       | \$67.50   |
| Touchscreen          | Hosyond 7-inch IPS capacitive DSI display, 800 x 480       | Hosyond, 7 Inch Touchscreen IPS DSI Display       | Amazon, B0D3QB7X4Z           | 1   | \$38.99       | \$38.99   |
| USB-A to USB-C cable | USB 2.0 data and power cable, 150 mm                       | CviLux USA, DH-20M50054                           | DigiKey, 2987-DH-20M50054-ND | 1   | \$1.32        | \$1.32    |
| USB-C power supply   | Official US wall supply, 5.1 V / 3 A, 1.5 m cord           | Raspberry Pi Ltd, SC0218                          | Adafruit, 4298               | 1   | \$8.74        | \$6.99    |
| Mechanical, catalog  |                                                            |                                                   |                              |     | \$0.86        | \$0.86    |
| ME-OTS-001           | Socket-head screw, 0-80 x 1/16 in, black-oxide alloy steel | Not disclosed, 91251A051                          | McMaster-Carr, 91251A051     | 2   | \$0.86        | \$0.86    |
| Mechanical, custom   |                                                            |                                                   |                              |     | \$2.11        | \$2.11    |
| ME-001               | Casework: rails                                            | Injection molder (not yet selected), ABS, 0.15 kg |                              | 1   | \$0.99        | \$0.99    |
| ME-002               | Casework: screen and board frame                           | Injection molder (not yet selected), ABS, 0.17 kg |                              | 1   | \$1.12        | \$1.12    |
| Packaging            |                                                            |                                                   |                              |     | \$1.97        | \$1.62    |
| PKG-001              | Corrugated box, white, 10 x 8 x 4 in inside                | ULINE, S-16535                                    | ULINE, S-16535               | 1   | \$1.97        | \$1.62    |
| Total per unit       |                                                            |                                                   |                              |     | \$121.49      | \$119.39  |

Casework is costed as material plus processing: ABS at \$3 per kg, with processing at 120% of the material cost.

Not in the BOM: nRF7002 DK. Each unit also uses a Nordic nRF7002 DK (NRF7002-DK). It carries the nRF5340 that runs our Zephyr firmware, the nRF7002 Wi-Fi 6 companion chip, and the 8 MB external flash that holds the update slot. Nordic hardware comes through the course and sits outside the parts budget, so the DK is left out of the totals above and out of the COGS in the financial model. For reference, it sells for about \$53 at U.S. distributors. A production unit would replace the DK with an nRF5340 and nRF7002 on our own board, which is not costed yet.

# Software BOM

Recurring costs to run the fleet, from the Software BOM tab of the [Cranium BOM and Cost Model](https://docs.google.com/spreadsheets/d/1DxhXXcjT0Hgploqj7x2QWS54r0ZcuMWR_F7q05EQHGE/edit) sheet. Development tools are left out, as the manual asks.

| Code   | What it pays for                                                                       | Provider                          | Monthly   | Annual    | Notes                                                                                               |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------- | --------- | --------- | --------------------------------------------------------------------------------------------------- |
| SW-001 | Device connectivity: MQTT, device shadows, OTA jobs                                    | AWS IoT Core                      | In SW-002 | In SW-002 | Pay per use: \$1.00 per million messages and \$0.08 per million connection-minutes                    |
| SW-002 | Cloud backend and console: Lambda, API Gateway, DynamoDB, S3, Cognito, Secrets Manager | Amazon Web Services               | \$10.00    | \$120.00   | Monthly budget cap set in cloud/infra/budget.yaml; actual use is a few dollars a month for 4 boards |
| SW-003 | Mixxx DJ software, our fork (dbosket/mixxx, branch cranium), running on the Pi         | Open source, GPL-2.0-or-later     | \$0        | \$0        | Shipping it means offering the source                                                               |
| SW-004 | Wi-Fi location for the board map                                                       | AWS Location Service              | In SW-002 | In SW-002 | \$1.00 per 1,000 positions, about \$0.15 per board per month                                          |
| SW-005 | Fleet management: crash reporting and diagnostics                                      | Memfault (Nordic)                 | \$0        | \$0        | Free tier during development; production plan still to be priced                                    |
| SW-006 | nRF Connect SDK v3.4.0 (Zephyr RTOS, MCUboot)                                          | Nordic Semiconductor, open source | \$0        | \$0        | Apache-2.0 and Nordic 5-Clause licenses                                                             |
| SW-007 | Raspberry Pi OS (trixie, arm64)                                                        | Raspberry Pi Ltd, open source     | \$0        | \$0        | Runs Mixxx and the metrics collector in pi/                                                         |
| SW-008 | Desktop console app for Windows and Linux                                              | Electron, open source (MIT)       | \$0        | \$0        |                                                                                                     |
| SW-009 | Domain (craniumiot.com) and DNS                                                        | Cloudflare                        | \$0.92     | \$11.00    | DNS is free; the domain renews at about \$11 a year                                                  |
| Total  | Four MVP boards                                                                        |                                   | \$10.92    | \$131.00   |                                                                                                     |

These totals cover the four MVP boards. At scale the cost grows with each board: at today’s 30-second heartbeat a board sends about 100,000 reports a month (about \$0.10 in AWS IoT Core), the rules, Lambda and DynamoDB behind them add about 10 to 20 cents, and Wi-Fi location adds about 15 cents. That is roughly \$0.35 to \$0.45 per board per month, before Memfault’s production plan.

# Financial Model

The full model is in the Cost Model tab of the [Cranium BOM and Cost Model](https://docs.google.com/spreadsheets/d/1DxhXXcjT0Hgploqj7x2QWS54r0ZcuMWR_F7q05EQHGE/edit) sheet, which follows Framework’s cost model. The figures below come straight from it.

Pricing strategy and sale price. We sell direct to consumers online for \$230 plus \$10 shipping, as a one-time purchase. There is no subscription, and firmware and feature updates are included. At \$230 we stay under the \$250 our interviewees set for XDJ-style standalone use, and under a third of the price of the cheapest standalone deck, the \$699 Numark Mixstream Pro+. Because we sell direct there is no distributor margin to cover, so we can price at about 1.9 times the \$122.72 FOB cost rather than the usual 2.5 times.

| Per unit                                                                            | USD     |
| ----------------------------------------------------------------------------------- | ------- |
| BOM (1K build)                                                                      | \$119.39 |
| Assembly, test and packout (FATP)                                                   | \$2.00   |
| Yield loss and rework                                                               | \$1.33   |
| COGS at FOB                                                                         | \$122.72 |
| Financing (10% a year for the 30 days between paying the manufacturer and the sale) | \$1.01   |
| COGS with financing                                                                 | \$123.72 |
| Logistics: freight in, warehousing, pick and pack, freight out                      | \$8.88   |
| Payment processing (Stripe, 2.9%)                                                   | \$6.96   |
| Duties                                                                              | \$0.00   |
| COGS fulfilled                                                                      | \$139.56 |
| Support, returns and warranty                                                       | \$0.74   |
| Fixed costs spread over 20,000 units (NRE, tooling, certification, excess stock)    | \$8.58   |
| Internal R&D and SG&A spread over 20,000 units                                      | \$17.78  |
| Fully loaded cost                                                                   | \$166.66 |
| Profit per unit at \$240                                                             | \$73.34  |

Program. The model assumes 20,000 units. Fixed costs are \$171,634: product NRE \$30,000, module NRE \$5,000, product tooling \$50,000, module tooling \$5,000, certification \$10,000, and 3% of the BOM for excess and obsolete stock. Internal costs add \$250,000 (development \$50,000, internal labor \$100,000, indirect marketing \$100,000), plus 1% promotional discounting and a \$3 direct acquisition cost per sale. With 5% remorse returns and 5% warranty returns, that gives \$4.56M in sales, \$0.19M from 1,000 refurbished units resold at 80%, \$4.75M total revenue against \$3.33M total cost, and \$1.42M gross profit, a 29.9% margin.

Recurring costs. Cloud and fleet costs (see Software BOM) are not in the Cost Model tab yet. At today’s reporting rate they come to roughly \$0.35 to \$0.45 per board per month, about \$13 to \$16 per unit over three years, which the \$73 profit per unit covers without a subscription.

Not included. The nRF7002 DK sits outside the BOM, so every figure above leaves it out (see Hardware BOM).


## CRANIUM Mix touchscreen application

The full editable CRANIUM Mix application is in
[`pi/cranium-mix/`](pi/cranium-mix/README.md), including the patched C++ engine,
800 x 480 touchscreen layout, CRANIUM branding, FLX4 mappings and Pi build tools.
The latest saved feature version includes waveform/encoder zoom and Beat FX
routing, selection, enable and timing fixes. See its README for current
validation limits and the Bookworm build steps. Existing Nordic firmware,
cloud/apps and Pi telemetry remain separate and unchanged by this source import.
