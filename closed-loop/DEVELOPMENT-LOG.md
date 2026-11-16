# Development record

## 2026-11-12: AI implementation from requirements

- User requested an autonomous closed-loop development setup for the CRANIUM
  DJ product and supplied the Venture Manual. Section 3.7 and the course-linked
  starter kit were read before choosing the MCU feature and measurements.
- Numerical tests were defined in requirements.json before this run's firmware
  implementation or any physical measurement. Requirements prompts are retained
  under prompts/. No fixture or invented power number counts as a pass.
- Implemented the UART telemetry peripheral, CRC/sequence handling and encrypted
  BLE forwarding, plus baseline and event-driven/slow-advertising profiles.
- Repaired a real build issue: Zephyr Kconfig split source paths at the space
  in ESE 5180; build inputs now use a stable space-free task cache.
- Repaired a real configuration issue: the nRF5340 network core required the
  HCI IPC serialization selection. Both application/network domains now build.
- Corrected output collection to use this sysbuild's separate domain HEX files,
  and set NRFUTIL_HOME to the SDK's existing device plug-in location.
- Exercised the actual C parser, independent capture decoder, power-data quality
  gates, rollback/cleanup, MCP handshake and refusal of simulated hardware.
- Installed and exercised the actual Hapimatic core server/daemon and Logic 2
  automation API. A one-second simulated capture/export is labelled simulation
  and cannot satisfy the HIL acceptance path.
- No physical DK, Saleae or PPK2 was present. Real flash, UART timing, BLE transfer
  and before/after current remain pending. The autonomous AI loop was not
  started against absent hardware and no working Pi/SD image was changed.

## 2026-11-15: aligned with the professor's public example

- Reviewed ese5180/hapimatic-test-v1 at commit 1816e0a as a structure/workflow
  guideline. Retained the Nordic UART/BLE product feature instead of inventing
  an accelerometer requirement or copying STM32 power registers/results.
- Moved the public application to app/, added its exact-commit NCS west
  manifest, board-specific overlay and CMake-generated profile header.
- Added a standalone PPK2 measure/hold entry point matching the example's
  command pattern; no Saleae is needed for those partial measurements.
- Improved stopped-stream draining before calibration and allowed the setup
  wizard to finish PPK2 configuration without a physical analyzer.
- Verified matching profile builds, recursive dependency paths, 26 host tests,
  and a blocked PPK2 preflight without energizing unverified hardware.
- Prepared public source, a comparison table, pending power-results table,
  wiring/build instructions, sanitized software evidence and host-only CI.
