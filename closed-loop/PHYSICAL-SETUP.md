# One-time physical setup

The computer-side setup is installed on this Mac. The Pi and its SD card are
not needed for this lab loop. This programs the **nRF7002 DK's nRF5340**, so use
the project development board rather than another lab group's device.

## Connect the peripheral test

1. Plug the DK's **debug/J-Link USB** into the Mac with a data cable. Keep it
   connected for programming and its UART0 virtual serial port. Disconnect
   other Nordic development boards during the initial selection.
2. Plug a **physical Saleae** into the Mac. Logic 2 is installed locally and
   the launcher enables its Automation API on port 10430 automatically.
3. Attach Saleae **channel 0 to DK P0.22 (UART RX)**, **channel 1 to P0.20
   (UART TX)**, and a ground lead to DK GND. Those pin assignments come from
   NCS 3.4.0's nrf7002dk UART0 pinctrl, not Arduino D0/D1. Match the silkscreen
   or board drawings when locating the physical pads/header pins.
4. These are logic signals at the DK's actual VDD level. Use a Saleae model/
   threshold that supports that level. Do not connect a 5 V serial adapter.
   The Mac supplies the test messages through debug VCOM, so no Pi wiring is
   needed for the checkoff.

## Prepare the PPK2 measurement rail

The measured MCU is the **nRF5340**. Measuring only the Wi-Fi companion's
**P23/VBAT** rail will not prove this firmware's power reduction.

Nordic's [nRF5340 + IOVDD measurement configuration](https://docs.nordicsemi.com/r/bundle/ug_nrf7002_dk/page/ug/nrf7002_dk/nrf5340_nrf7002_measure_current.html)
routes that domain to **P22 VDD_MEAS**, with **SB16 opened and SB17 closed**.
Have a teaching-team member help with this one-time board preparation if it
has not already been done. Check your board revision against the guide before
changing solder bridges. Restore its normal jumper/bridge arrangement when
returning it to another use.

The default workbench uses **PPK2 ampere mode**, which meters an existing
supply in series:

1. With board power disconnected, remove the P22 VDD measurement jumper and
   prepare the nRF5340 route as shown in the guide. Verify the load and supply
   sides from the board drawing; the guide identifies **P22 pin 1** as the
   load-side input when supplying this domain externally.
2. Put PPK2 **VIN on the supply side** and **VOUT on the load/nRF5340 side**
   of this open measurement path. Connect PPK2 GND to DK GND. Do not leave a
   jumper or another supply path bypassing the meter.
3. The DK keeps its normal upstream supply and debug USB. The debugger's own
   consumption must stay outside the measured nRF5340 rail. Ensure attached
   signal leads do not back-power the rail.
4. Plug the PPK2's data USB into the Mac. Close nRF Connect Power Profiler if
   it has the PPK2 open; one program owns it at a time.
5. Measure/check the actual rail voltage and enter it in the setup wizard.
   The DK may use **1.8 V**; do not assume 3.3 V. The code accepts 1.7-3.6 V
   for this rail. In ampere mode this value calibrates readings; the script
   does not command a source voltage.
6. Keep BLE clients disconnected for the idle-power comparison. Before relying
   on absolute current figures, qualify the PPK2 with a known load using your
   lab's procedure. Record the actual rail/voltage and any attached debug
   connections in the run notes.

The script connects the PPK2 measurement path only after you confirm the
physical setup, and switches it off in cleanup on success or failure. It also
checks sample coverage and stops a capture on excessive mean current. That
software check supplements correct wiring; it does not substitute for it.

## Start it

1. Double-click **Configure Bench.command** in this folder. It finds the
   selected USB devices and asks you to identify a port only if ambiguous.
   Confirm the checked rail/polarity/voltage by typing `READY` once. The
   selection is saved locally and excluded from Git.
2. Double-click **Start AI Loop.command**. It runs readiness checks, starts
   Hapimatic/Logic 2, creates one Codex session with the saved requirements,
   and sends the prompt automatically. The terminal prints a private access
   token if Hapimatic's browser asks for it. It is not a new AI subscription.
3. Keep the Mac awake with its lid open and the rig connected. You can watch
   captures in Logic 2 and the loop in Hapimatic. The agent stops on a pass,
   physical block or three attempts; it does not keep making arbitrary edits.
4. The complete report is `captures/<UTC-run-id>/report.json`; the README's
   results section updates from it. A blocked run means no hardware pass.

For the optional radio proof, allow the Mac's Bluetooth permission when needed
and run `.venv/bin/python tools/radio-smoke.py`. It builds/flashes the candidate
and confirms two ordered events over real BLE, then powers the measured rail
off. Disconnect its receiver before the next idle measurement.

For a future live Pi connection, use a **3.3/1.8 V compatible** level arrangement
appropriate to the DK's actual rail, common ground and crossed TX/RX; do not
join the Pi's 5 V pin to an MCU GPIO. Configure an actual Mixxx journal producer
before using `tools/relay-journal.py`; this bench does not invent song history.
