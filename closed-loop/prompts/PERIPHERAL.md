Requirement: CRANIUM must accept track/session events over its nRF5340 UART0
and provide them to a subscribed BLE laptop client. Use C1 framing with CRC-16,
bounded payload length and monotonically advancing uint32 sequence numbers.
Reject corruption and duplicate/stale frames. UART receipt ACK must not be
represented as confirmed BLE delivery.

Write the pass test before a change. At 115200 baud, use Saleae channel 0 on
UART RX/P0.22 and channel 1 on UART TX/P0.20 to independently verify the exact
100 test messages, one duplicate, one corrupted-CRC frame, and <=50 ms ACK
latency. Save raw CSV and .sal captures and the exact firmware image hashes.
Run tools/radio-smoke.py separately to confirm two real BLE notifications and
their order; disconnect it before the idle-power test. Read AGENTS.md and use
the fixed acceptance tools. Do not claim the optional radio test passed unless
its physical notifications are recorded.
