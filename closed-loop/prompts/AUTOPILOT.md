Implement CRANIUM requirement CRANIUM-CL-01 using this workbench. Work
independently through the measured feedback loop after reading AGENTS.md.

Our DJ appliance uses a Raspberry Pi for Mixxx and an nRF7002 DK (nRF5340 MCU)
as the wireless companion. The useful peripheral feature is reliable UART
ingress for track/session history, forwarded as newline-delimited JSON over
encrypted BLE Nordic UART Service notifications. Preserve track identifiers,
event order and payload bytes. UART ACK means receipt, not radio delivery.

First call cranium_doctor. If ready, run the existing tests and a real baseline/
candidate experiment BEFORE making further changes. Use the saved Saleae raw
edges and PPK2 current data to decide whether a change is needed. The workbench
already contains an initial low-power candidate; do not edit merely to create
activity. If it passes, record/commit the validated candidate and stop.

Acceptance is fixed in requirements.json: all 100 valid frames acknowledged;
duplicate and corrupted-CRC frames rejected; ACK starts within 50 ms of the
last received byte (20 us stop-bit sampling tolerance). Both profiles must
pass. Idle power uses three alternating matched 15-second measurements for
each profile after settling. Optimized median current must drop at least 25%,
with every paired repeat improving and at least 90% PPK2 sample coverage.
No BLE receiver may be connected during those advertising-idle measurements.

If a FUNCTIONAL failure is supported by a good capture, or power reduction is
insufficient with correct rail/calibration, make one bounded firmware change,
rebuild and repeat. Prefer longer idle advertising intervals (maximum 3200 ms),
no idle LED, and event-driven sleeps. Keep the UART responsive and the radio
feature present. Do not change the reference baseline, acceptance numbers,
drivers, SDK, board pinout or power configuration. Instrument/USB/wiring errors
are physical blocks, not firmware bugs to hide.

Use only the named MCP bench tools for hardware. Keep a short development log
in DEVELOPMENT-LOG.md, then finish with a README-based explanation the project
team can deliver without AI. Stop after success, a physical block, three real
experiments or 40 minutes. Do not modify the DJ interface or play music.
