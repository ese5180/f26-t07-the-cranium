# CRANIUM closed-loop bench

Work on the nRF7002 DK's nRF5340 companion, not the live DJ audio engine.
Read README.md, PHYSICAL-SETUP.md, requirements.json and the selected prompt first.

During an autonomous firmware optimization run:

- Use the `cranium-bench` MCP tools to build, flash, capture and read results.
  Long operations return job IDs; check them no more than once every 10 seconds.
- Begin with `cranium_doctor`. If blocked, stop and report the exact physical
  requirement. Never substitute simulations, cached results or guessed ports.
- Limit firmware changes to `app/src/` and `app/profiles/optimized.json`.
  Development notes and generated README/evidence updates are also permitted. Keep the
  baseline profile, requirements, acceptance tools and tests unchanged. Ask the
  user to scope any change outside those paths. This restriction applies to
  firmware-optimization runs, not maintenance of the workbench itself.
- Work in a new local branch after checking for unrelated user changes.
  Do not reset, clean, stash, overwrite or commit someone else's changes.
- Record the requirement and a numerical pass test before changing firmware.
  Make one reasoned change per attempt. Keep CRC/sequence behavior and payload
  fidelity intact. Do not remove functionality to meet a power target.
- Call `cranium_test`, then `cranium_start_run`. Wait for the final measured
  report. Source, image and artifact hashes must correspond to that run.
- At most three real experiments per explicitly started AI loop. Stop on pass,
  missing hardware, instrument/calibration faults, exhausted budget, or 40 minutes.
  Do not change thresholds or tool code to manufacture a pass.
- A failed candidate is flashed back to the built baseline where possible.
  Revert only YOUR candidate changes before declaring failure; preserve reports.
  If rollback fails, say so and stop. Never use erase-all or recover.
- Commit successful candidate changes with actual measured numbers and the
  report path. Never claim HIL/low-power completion from unit tests or builds.
- Do not start other agents, alter the sibling Mixxx/BiteDJ projects, access
  music USBs/SD cards, publish, push, send messages, or run indefinite tasks.

Power authority is the saved physical configuration in bench.local.json.
Never enable it yourself: a person must have selected the actual devices and
verified the rail, voltage and wiring once through Configure Bench.command.
All subsequent bounded bench runs within that setup may operate automatically.
Always let the PowerMeter context turn the PPK2 output off on exit.

After the run, explain the feature, what was measured, why it passed or failed,
and what remains unverified. The README contains the teaching-team explanation.
