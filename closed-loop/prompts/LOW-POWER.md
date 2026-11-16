Requirement: reduce CRANIUM's wireless companion's idle current while retaining
the measured UART feature. Compare the same nRF5340+IOVDD rail under the same
voltage, supply, radio-disconnected state and instrumentation. The Pi and DJ
audio playback are outside this experiment.

The fixed reference uses 100 ms advertising and an active status LED/50 ms
heartbeat. The initial candidate uses 1000 ms advertising, LED off, and a main
thread waiting for UART events. Measure the baseline first, not an estimate.
Use three alternating baseline/candidate pairs, 15 seconds each after settling,
with >=90% sample coverage. Require >=25% median current reduction and an
improvement in every pair. Both images must still pass the Saleae packet test.
If it fails with valid measurements, adjust only the candidate as AGENTS.md
permits; test, flash and remeasure. Retain failures. Never fabricate mA values,
change the reference or weaken a threshold. Stop after three attempts.
