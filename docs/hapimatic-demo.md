# Hapimatic demo: the closed-loop bench

The one document for setting up, running and showing the closed-loop bench ([`closed-loop/`](../closed-loop/README.md))
for manual section 3.7. It covers setup, wiring, the run, results and fixes. The firmware, the UART protocol and the
design are explained in [`closed-loop/README.md`](../closed-loop/README.md).

## What the demo shows

An AI coding agent, driven through Hapimatic, works on the nRF5340 firmware of an nRF7002 DK against fixed numbers in
[`requirements.json`](../closed-loop/requirements.json), set before any change. It builds two profiles of the bench's
own Zephyr app, a **baseline** (100 ms advertising, status LED and a 50 ms heartbeat) and an **optimized** candidate
(1000 ms advertising, LED off, waiting on UART events). It flashes them in turn, checks UART timing on a Saleae
(100 frames acknowledged, a duplicate and a bad CRC rejected, every ACK starting within 50 ms) and measures current on
a PPK2 (three alternating 15-second pairs: the optimized median must be at least 25% lower, every pair must improve,
and at least 90% of the samples must arrive). It reads the saved evidence. If good measurements show the candidate
falls short, it makes one bounded change and measures again, up to three experiments or 40 minutes. The loop is closed
when measurements decide the next change or show that the candidate passes.

**Where it stands** ([`VALIDATION.md`](../closed-loop/VALIDATION.md)): software only so far. The 29 host tests pass
(CI job "Closed-loop bench"), both profiles build for both cores (hashes in
[`evidence/software-validation.json`](../closed-loop/evidence/software-validation.json)), and the bench refuses
missing or unverified hardware before it powers or flashes anything. No flash, UART timing, Bluetooth delivery or
before/after current has been measured, nor has a whole agent-driven run on hardware: the demo is the
first physical run. A build, a host test or a simulated capture
never counts as a physical pass.

## Before you start

**The Mac**
- [ ] The owner's Mac is already set up: setup done, both profiles built in `closed-loop/build/`, and
      `bench.local.json` set for the DK with J-Link serial 1050797470. Configure Bench (step 1) still has to pick the
      Saleae and the PPK2 and record the wiring check.
- [ ] On another Mac (Apple Silicon): clone this repository, then `cd closed-loop && ./setup.sh && ./bench test`
      (29 tests pass). Details: [Another Mac](#another-mac).
- [ ] Mac on power, awake, lid open, for the whole run.

**The coding agent**
- [ ] Its CLI is installed and signed in, and `bench.local.json` names it: `agent` (Hapimatic's name for it), plus
      `agent_cli` (its path) if it is not on PATH.
- [ ] It has the bench's MCP server `cranium-bench` (`closed-loop/mcp-server`). `setup.sh` adds it when `agent_config`
      names the agent's TOML file of MCP servers; otherwise add it in the agent's own settings. Without it the agent has
      no `cranium_*` tools.

**The DK (nRF7002 DK)**
- [ ] Debug (J-Link) USB into the Mac with a data cable. Other Nordic boards unplugged.
- [ ] **The run overwrites Cranium on this DK.** It flashes the bench app over Cranium's firmware and its bootloader
      (both cores; no erase-all). Use a spare DK if there is one. To get Cranium back, re-flash it over USB
      ([After the demo](#after-the-demo)).
- [ ] Nothing connected to it over Bluetooth (phone apps, laptops): idle current is measured with no client.
- [ ] Nothing else holding its serial port: close the Cranium app's Serial console and any serial terminal.

**The Saleae (logic levels only)**
- [ ] USB into the Mac.
- [ ] **Channel 0 to P0.22** (UART RX), **channel 1 to P0.20** (UART TX), a ground lead to **DK GND**. These are UART0's
      pins in NCS 3.4.0, not Arduino D0/D1: find them on the silkscreen or the board drawing.
- [ ] Signals are at the DK's own rail, which may be 1.8 V: use a threshold that reads it. **Never 5 V**: no 5 V serial
      adapter, nothing from the Pi. The Mac sends the test frames through the DK's debug VCOM, so the Pi is not needed.

**The PPK2 (ampere mode, on P22 VDD_MEAS)**
- [ ] The one-time board change, made with the board unpowered as
      [Nordic's nRF5340 + IOVDD guide](https://docs.nordicsemi.com/r/bundle/ug_nrf7002_dk/page/ug/nrf7002_dk/nrf5340_nrf7002_measure_current.html)
      shows: **SB16 open, SB17 closed**, P22 jumper removed. Check the board revision against the guide first, and ask
      the teaching team if unsure. This measures the nRF5340 plus IOVDD, not the Wi-Fi chip's P23/VBAT rail.
- [ ] **VIN to the supply side** of P22, **VOUT to the load (nRF5340) side** (the guide gives P22 pin 1 as the load
      side), PPK2 GND to DK GND. No jumper or other supply bypasses the meter, and the debugger's supply stays
      outside it.
- [ ] Data USB into the Mac. nRF Connect Power Profiler closed: only one program can use the PPK2 at a time.
- [ ] Rail voltage measured (often 1.8 V, not 3.3 V): Configure Bench asks for it.
- [ ] Before relying on absolute figures, qualify the PPK2 with a known load (your lab's procedure). Note the rail
      voltage and any debug connections attached, for the run notes.
- [ ] With the jumper out, the nRF5340 has power only while the bench holds the PPK2 path open, so the board looks
      dead between runs.

## Run it

Everything runs from `closed-loop/`, by double-clicking in Finder or from Terminal.

1. **Configure Bench.command.** It asks, in order (starting Logic 2 along the way):
   - the DK's VCOM (UART0) port. If it lists several, pick UART0's (on the owner's Mac, the `uart_port` already in
     `bench.local.json`). It reads the J-Link serial from the port, or asks for the number printed on the board.
   - the physical Saleae. With none plugged in, it says the full run stays blocked.
   - the PPK2 data port.
   - the measured rail voltage in mV (1700 to 3600; for 1.8 V type `1800`).
   - whether the rail, polarity, voltage and common ground are checked: type `READY` exactly. That sets
     `power_wiring_verified`; any other answer saves it as false.

   It saves `bench.local.json` (Git-ignored) and prints two checks, `power_only` and `full_hil`. Leave Logic 2 open.
2. **`./bench doctor`** must print `"ready": true` and `"blocking": []`. Otherwise, fix each `blocking` line using
   [If something goes wrong](#if-something-goes-wrong) and run it again. It only reads; it never powers or flashes.
3. **Start AI Loop.command.** It checks that the agent is set and found, starts Hapimatic and Logic 2, and runs the same
   readiness check. If that fails, it prints "The AI loop is waiting for physical setup:" and the list. Otherwise it
   starts the agent with [`prompts/AUTOPILOT.md`](../closed-loop/prompts/AUTOPILOT.md) as its first message and opens
   the run in the browser. Terminal prints `Hapimatic: http://127.0.0.1:3006`. If the browser asks for an access token,
   paste it: the launcher put it on the clipboard. Clicking again does not start a second run while one is active.
4. **Watch.** The agent calls `cranium_doctor`, runs the host tests (`cranium_test`), starts a real experiment
   (`cranium_start_run`), checks the job no more than once every 10 seconds, and reads the report. Then it either
   stops on a pass or makes one change and runs again.

**Point at on screen**
- **Hapimatic** (browser): the agent's steps and tool calls, and the requirement and pass test it writes down before
  any change. Its edits are limited to `app/src/` and `app/profiles/optimized.json`
  ([`AGENTS.md`](../closed-loop/AGENTS.md)), and it keeps notes in `DEVELOPMENT-LOG.md`.
- **Logic 2**: a 12-second capture for each image. Channel 0 carries the `C1:…` frames in and channel 1 the
  `ACK:<seq>:OK:…` replies; the last two frames get `DUP` and `CRC`. Timing is judged from these physical edges, not
  from the serial port.
- **The DK**: LED0 is active in baseline rounds and off in optimized rounds.
- **Progress**: `tail -f "$(ls -t .state/jobs/*.log | head -1)"` prints `Round 1: flash and measure baseline` and so on,
  up to round 3, optimized.
- **`requirements.json`**: the fixed numbers. The agent may not change them, the baseline or the test code.

**Where results land**
- `captures/<UTC run id>/report.json`: the whole run (private, Git-ignored). Each image has a folder
  `<round>-<profile>/` holding `flash.log`, `stimulus.json`, `capture.sal` and `digital.csv` (Saleae),
  `functional.json` (UART verdict), `ppk2-raw.bin`, `ppk2-calibration.json`, `current.csv` and `power.json`.
- `./bench latest` prints the last run's report.
- `closed-loop/README.md`: its status line and "Results and checkoff" section update from each report automatically.
- `evidence/`: the publishable record (so far the software validation). A passing candidate is committed with its
  measured numbers and report path.

**What a pass looks like**
- `report.json`: `"status": "passed"` and `"hardware_passed": true`.
- In all six rounds, `functional` has `"passed": true`, `"frames": 102` (100 valid, a duplicate, a bad CRC) and
  `ack_latency_ms_max` of at most 50. Each `power` has `coverage` of at least 0.90.
- `power_comparison`: `reduction_percent` at least 25, `every_pair_improved: true`, and `baseline_median_uA` and
  `optimized_median_uA` are the before/after figures.
- The README status reads "Latest physical peripheral and idle-power checks passed."
- `blocked` (nothing was powered or flashed), `failed` (see `error`; `baseline_restored: true` means it put the
  baseline back) and `interrupted` are not hardware passes. The raw captures and `artifacts_sha256` stay either way.

**How long:** the docs give no total. For each of the six flashes in one experiment, `requirements.json` sets a 5 s
settle, the 12 s Saleae capture, another 5 s settle and the 15 s PPK2 capture. Both profiles are built first. The
agent stops after a pass, a physical block, three experiments or 40 minutes.

## If something goes wrong

The agent stops on instrument or wiring faults instead of changing the firmware. Fix the cause, then run Configure Bench
(if a device changed), `./bench doctor`, and Start AI Loop again.

| Message | Fix |
| --- | --- |
| `Open Saleae Logic 2 and enable Automation API on port 10430: …` | Logic 2 isn't running with its automation server on port 10430. Quit Logic 2 if you opened it yourself, then run Configure Bench or Start AI Loop: both start it with automation on 10430. |
| `Set the nRF7002 DK J-Link serial in bench.local.json` | Run Configure Bench. `board_serial` must be the number (1050797470 on the owner's DK). |
| `Connect the DK debug USB and select its VCOM uart_port` | Plug in the DK's debug USB (data cable). The port name can change after replugging, so run Configure Bench again. |
| `Selected VCOM must belong to the configured J-Link serial` | The saved port belongs to another board. Unplug other Nordic boards and run Configure Bench again. |
| `Connect and select a real Saleae; simulated devices cannot pass HIL` | Plug in the Saleae and run Configure Bench again so it saves the device. |
| `Connect and select the Nordic PPK2` | Plug in its data USB, close Power Profiler, run Configure Bench again and pick the data port. |
| `Verify power-rail wiring and voltage, then set power_wiring_verified=true` | Check the PPK2 wiring, then run Configure Bench and type `READY`. Don't set the flag by hand without checking. |
| `Disconnect BLE receivers for the matched advertising-idle power test` | Disconnect every phone or laptop from `CRANIUM-Link`. `radio_disconnected_for_power` must be `true` in `bench.local.json` (the default). |
| `Saleae RX and TX must use separate channels` | Set `rx_channel` to 0 and `tx_channel` to 1 in `bench.local.json`. |
| `Set agent (…) in bench.local.json` or `The coding agent set in bench.local.json was not found…` | Set `agent`. Install and sign in to its CLI, or set `agent_cli` to its full path. |
| The agent has no `cranium_doctor` tool | Register `cranium-bench` (see [Before you start](#before-you-start)) and start the loop again. |
| `Run setup.sh to install Hapimatic` (or `Saleae Logic 2`) | Run `./setup.sh`. |
| `Hapimatic startup timed out; see .state/hapi-server.log` | Read that log. Something else may be using port 3006. |
| A serial-port error on the DK's port (for example `Could not exclusively lock port …`), or `Unexpected serial reply …` | Another app holds the port, usually the Cranium app's Serial console. Close it and any serial terminal; the bench needs the port to itself. |
| `Another bench run owns the instruments` or `Another workbench job is already running` | An earlier run, or a `./bench hold`, still has the rig. Wait for it to end; never run `hold` alongside a run. |
| `Three-attempt budget used; stop and report to the user` | The loop used its three experiments. A new Start AI Loop after that run has ended starts a fresh budget. |
| `logic capture frame count: RX=… ACK=…, expected 102` | Check the Saleae leads (ch0 P0.22, ch1 P0.20, GND) and that the threshold suits the DK's rail. |
| `invalid PPK2 sample coverage …`, `current outside credible measurement range; check rail and wiring` or `PPK2 stream failed to become quiet before calibration` | Check VIN and VOUT, that the P22 jumper is out, the voltage, and the USB data port. Close Power Profiler. |
| `PPK2 overcurrent limit; output will be switched off` | Stop. Look for a short or a reversed path before trying again. |

If the agent itself won't start, `./bench run` runs the same measured experiment by hand.

## After the demo

1. Let the agent finish (pass, block or budget). The bench switches the PPK2 output off itself.
2. Unplug the PPK2 and the Saleae leads.
3. Refit the P22 jumper: without it, or the PPK2 in the path, the nRF5340 has no power and the next flash fails. If the
   DK goes back to normal use, return SB16/SB17 to their normal arrangement as Nordic's guide shows.
4. Put Cranium back: re-flash it over USB as for a new board ([new-board-setup.md](new-board-setup.md), the quick way).
   From the repository root, run `scripts/board/new-board.sh --serial-number 1050797470`. The bench app replaced the
   bootloader, so an over-the-air update can't do it. The script erases the chip, then puts the bootloader, golden
   image, newest release and provisioning back (about 20 minutes per that guide; provisioning needs a release manager's
   console token).
5. Check the clone. The agent works on a new local branch and may commit a passing candidate there; it never pushes.
   The run also rewrites `closed-loop/README.md`'s results sections and `DEVELOPMENT-LOG.md`. Keep anything worth
   keeping through a normal PR, then return the clone to `main`.

## Other bench commands

```sh
./bench test                       # 29 host tests; no hardware
./bench build --profile baseline   # both cores of one profile, into build/baseline/
./bench build --profile optimized
./bench doctor                     # readiness; read-only
./bench measure --seconds 20       # PPK2 only (1 to 60 s): no Saleae, no flash, not a pass
./bench hold --seconds 120         # keep the PPK2 path powered (at most 15 minutes); Ctrl+C releases it
./bench run                        # one full experiment by hand, without the agent
./bench latest                     # the last run's report
```

**Open Workbench.command** opens Hapimatic without starting the agent. Optional radio proof:
`.venv/bin/python tools/radio-smoke.py` flashes the candidate and confirms two ordered events over real Bluetooth.
Disconnect its receiver before any idle measurement.

## Another Mac

- Apple Silicon macOS; NCS 3.4.0 and its Nordic toolchain (installed with Nordic's usual tools); Python 3.11+; the
  coding agent's CLI, signed in.
- `git clone https://github.com/ese5180/f26-t07-the-cranium.git`, then `cd f26-t07-the-cranium/closed-loop && ./setup.sh`.
  Setup installs the pinned Python packages, downloads Hapimatic and Logic 2 (each checked against its SHA-256 in
  `upstream.lock.json`) and creates `bench.local.json` from `bench.example.json`. It ends with "CRANIUM software setup
  ready. No board flashed and no PPK2 output enabled." Use `CRANIUM_SDK` and `CRANIUM_TOOLCHAIN` for an SDK outside the
  standard locations.
- Set `agent`, `agent_cli` and `agent_config` in `bench.local.json`, then run `./setup.sh` again so it registers
  `cranium-bench` with the agent.
- `./bench test` (29 pass), then build both profiles. Then follow [Before you start](#before-you-start) and
  [Run it](#run-it).

## Manual 3.7 checklist

| Item | Where it stands |
| --- | --- |
| Peripheral feature from a requirements prompt, validated with the Saleae | Prompt and pass test ready (`closed-loop/prompts/PERIPHERAL.md`, `requirements.json`); needs the run on the board |
| Low-power feature from a prompt, PPK2 before and after | Prompt and pass test ready (`closed-loop/prompts/LOW-POWER.md`); needs the PPK2 run on the prepared board |
| 3.7.1 Code in the GitHub repository | Done: `closed-loop/` on main |
| 3.7.2 PDF of the current README to Gradescope | After the run, put the measured results into the README's 3.7 table ("Shown on a board"), then print the README from GitHub to PDF |
| 3.7.3 Teaching Team checkoff | Submit 3.7.1 and 3.7.2 first; then demonstrate both features and explain them without AI tools (talking points at the end of the README's 3.7 section). Up to 3 attempts, before Nov 25, 2026 |
