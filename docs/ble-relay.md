# Bluetooth relay

When a board has no Wi-Fi, a phone running the Cranium app can carry the board's own connection to AWS IoT
over Bluetooth LE. The board keeps its end-to-end TLS and MQTT session with its own X.509 certificate. The
phone only moves opaque bytes between Bluetooth and a TCP connection to the AWS IoT endpoint on port 8883,
the way a Wi-Fi router would. It never sees plain text and holds no credential of the board's. AWS IoT and the
console change nothing: the board shows as online, with its own identity.

Status: firmware 1.21.0 (opt-in build for the nRF7002 DK) and the iPhone and Android apps, as draft pull
requests. **Not tried on hardware.** The nRF5340 DK is not part of this; see [Later](#later).

- [How it works](#how-it-works)
- [Choosing the approach](#choosing-the-approach)
- [The relay protocol](#the-relay-protocol)
- [Wi-Fi or relay](#wi-fi-or-relay)
- [Reconnection and buffering](#reconnection-and-buffering)
- [Security](#security)
- [The apps](#the-apps)
- [Cost in flash and RAM](#cost-in-flash-and-ram)
- [What is left](#what-is-left)
- [Decisions for the owner](#decisions-for-the-owner)
- [Later](#later)

## How it works

```
 board (nRF7002 DK)                          phone (Cranium app)                 AWS IoT
 ------------------                          -------------------                 -------
 cloud.c, aws_iot, mqtt_helper  (unchanged)
 TLS socket (Zephyr + mbedTLS,  (unchanged)
   key and certificate in TF-M)
 relay socket  <-- L2CAP CoC frames -->      RelayPump  <-- TCP :8883 -->        <thing>'s session
 (src/bt/ble_relay.c)                        (bytes only)
```

1. After a minute with no Wi-Fi, a provisioned board starts Bluetooth and advertises the relay service
   (`D38F3C14-34A8-4CDD-8E9A-BDB7FE83A2F0`). The advertisement carries the service and the board's random
   Bluetooth name (`Cranium-XXXX`) and nothing of its cloud name, as for Bluetooth update.
2. The user turns the relay on for a board in the app. The app connects, reads the PSM from the service's one
   characteristic (`D38F3C15-…`), and opens an L2CAP connection-oriented channel on it.
3. The board sends HELLO with its thing name. The app goes on only if that is the board the user picked.
4. The board's cloud connection goes over the relay: `cloud_connect()` sees no Wi-Fi and an open channel.
   `mqtt_helper` resolves the endpoint and opens its TLS socket as always. While that connection is being
   made, the endpoint's name resolves to 192.0.2.1 (TEST-NET-1, routed nowhere), and the TCP socket under the
   TLS socket is the relay socket. Its `connect()` sends OPEN (host and port). The app checks the host, opens
   TCP to it, and answers OPENED.
5. From then on, the TLS records go both ways as DATA frames: the TLS handshake with the board's certificate,
   MQTT CONNECT and SUBSCRIBE, the shadow reports, events, Memfault chunks, commands and job messages.
6. Wi-Fi back for 30 s: the board sends CLOSE (hand-back), ends the relayed connection and connects again
   over Wi-Fi at once. The relay offer stops.

## Choosing the approach

The board's TLS lives in Zephyr's socket layer: `mqtt_helper` makes a socket with `IPPROTO_TLS_1_2`, sets the
security tag (201, the board's key and certificate in TF-M protected storage) and the host name, and Zephyr's
`sockets_tls.c` runs mbedTLS over a TCP socket that it makes with `zsock_socket()`. Three ways to put
Bluetooth under that were weighed.

### 1. MQTT custom transport over L2CAP, with TLS done by hand

Zephyr's MQTT library can take a custom transport (`CONFIG_MQTT_LIB_CUSTOM_TRANSPORTS`). The transport would
run mbedTLS itself over the L2CAP byte stream, with the board's key from TF-M.

- `mqtt_helper` (and NCS's `aws_iot` above it, which `cloud.c` uses) always sets `MQTT_TRANSPORT_SECURE` and
  always resolves the host first. A custom transport means a second MQTT client next to `aws_iot`, or a fork of
  `mqtt_helper`: two connection paths in `cloud.c` to keep the same.
- The TLS set-up that `sockets_tls.c` does (credentials from the security tag, SNI, peer verification, the
  record buffers, the handshake loop) would be written again, by hand, for one path. That is where mistakes
  in the security of a connection come from.
- A second mbedTLS context next to the socket layer's would double the 16 KB input record buffer at the
  moment both exist. The board does not have that RAM.

### 2. A relay socket family under the TLS socket (chosen)

Zephyr looks for a socket implementation in a fixed order: TLS (priority 45), then any registered family,
then the native one (50). The relay registers a family at 48 that answers only while a relayed connection is
being made, and only for IPv4 TCP. The TLS socket asks for its TCP socket in that window and gets the relay
socket; everything above it is unchanged.

- No change to `mqtt_helper`, `aws_iot`, the TLS layer or the board's credentials. `cloud.c` gains six lines
  around `aws_iot_connect()`.
- DNS: `mqtt_helper` resolves the endpoint with `getaddrinfo()`, and the same string is the TLS host name for
  SNI and certificate checks, so the name cannot be swapped for an address. Zephyr's DNS hook for offloaded
  sockets (`socket_offload_dns_register()`, which needs `CONFIG_NET_SOCKETS_OFFLOAD`) is switched on only
  around that one `aws_iot_connect()`, and answers only that host name. Any other name fails while it is on.
  Its results are allocated as the native resolver's are, so a result from either one is freed correctly by
  the other's `freeaddrinfo()`. `CONFIG_NET_SOCKETS_OFFLOAD` adds the hook, one pointer per network interface
  and a check in the send path, and leaves out `getnameinfo()`, which nothing uses. No socket is offloaded.
- The relay socket implements only what `sockets_tls.c` calls on its carrier: a blocking `connect()`,
  non-blocking `sendto()` and `recvfrom()`, `poll()`, `fcntl()` for the blocking flag, `SO_ERROR`, `shutdown()`
  and `close()`. It follows `socketpair.c` in the SDK: one poll signal for readable, one for writable.

### 3. PPP (or IP) over Bluetooth

The board would run an IP link to the phone (PPP over a serial-like channel, or 6LoWPAN-style IPSP), and the
phone would route or NAT it to the internet.

- iOS lets an app neither route packets nor run a NAT: that takes a Network Extension (a packet tunnel
  provider), with its own entitlement, review and memory limit, and a VPN profile the user approves. Android
  would need a `VpnService` or a user-space TCP/IP stack in the app.
- The phone would have to run a TCP/IP stack per board for nothing: the board only ever talks to one host on
  one port.
- On the board, a second network interface and PPP framing cost more flash and RAM than the relay, with the
  same TLS on top.

## The relay protocol

### L2CAP or GATT

The relay uses an L2CAP connection-oriented channel (LE credit-based flow control):

- iOS (`CBPeripheral.openL2CAPChannel`, iOS 11 and later) and Android (`BluetoothDevice.createInsecureL2capChannel`,
  API 29 and later) both hand it over as an input and an output stream. macOS has the same API as iOS.
- Credits are real flow control in both directions: the board gives the phone a credit only for room it has,
  and a phone that stops reading stops the board's sends.
- Throughput is better than notifications and write-without-response, with less overhead per byte.

The PSM is allocated by the stack and published in a readable characteristic, as Apple's guidance has it,
so the apps never assume a number.

GATT (a write-without-response characteristic in, notifications out, the same frames) would be the
fallback for Web Bluetooth, which has no L2CAP, and so for the desktop app if it ever relays from a browser
engine. It is not built: GATT has no flow control from board to phone beyond the link's, and the board would
need a buffer for notifications. The Mac app can use L2CAP as the iPhone app does.

### Frames

The channel is a byte stream to the apps, so every message is a frame: a type byte, a 16-bit little-endian
length, and that many bytes (at most 512). `src/policy/ble_relay_proto.h` defines them; the apps' tests hold
the same sample bytes that `build/ble_relay_tests --print` prints.

| Type | Name | From | Payload |
| --- | --- | --- | --- |
| 0x01 | HELLO | board | version (1), flags (0), largest DATA it takes (u16), thing name |
| 0x02 | OPEN | board | port (u16), host |
| 0x03 | OPENED | phone | none |
| 0x04 | DATA | either | bytes of the TLS stream |
| 0x05 | CLOSE | either | reason: 0 normal, 1 refused, 2 connect failed, 3 peer closed, 4 timeout, 5 protocol, 6 hand-back |

A reader skips a frame type it does not know, so a later version can add frames. One channel carries one
stream at a time; after a CLOSE the next OPEN starts a new one on the same channel. The board sends one frame
per SDU of at most 247 bytes; the phone may send frames split or joined across SDUs as it likes.

## Wi-Fi or relay

`src/policy/ble_relay_policy.c` decides, and the host tests cover it:

- **Offer.** The board advertises the relay when it is provisioned, not in factory mode, no Bluetooth update
  window or post-update status is open, and Wi-Fi has been down for 60 s without a break. A window that opens
  takes the radio: the relay's advertising stops and its phone is let go. The offer comes back when the window
  closes.
- **Path.** Each cloud connection picks its path when it starts: Wi-Fi if Wi-Fi is up, else the relay if a
  channel is open. A connection keeps its path to the end.
- **Hand-back.** A relayed connection ends once Wi-Fi has been back for 30 s; the board then connects again at
  once, over Wi-Fi.
- **Updates.** No firmware comes over the relay: the image download is HTTPS straight from S3, which the relay
  socket does not carry. A job offer that arrives over the relay is left queued in AWS IoT, and the board takes
  it once it is on Wi-Fi again. An update already under way goes on as it would with no network.
- The board's restart rules (`stuck.c`) count Wi-Fi link time only, so a relay that cannot reach the cloud
  never restarts the board.

## Reconnection and buffering

The relay is a pipe, not a store:

- When the Bluetooth link or the channel goes, the stream ends (reason "link"), the TLS socket reads an error,
  MQTT goes down, and the board's usual back-off reconnects over whatever is there: Wi-Fi, or the same phone
  once it is back, or another.
- When the phone's TCP connection ends, the phone sends CLOSE "peer closed"; the board sees the end of the
  stream, and reconnects the same way.
- OPENED must come within 15 s of OPEN, or the stream ends with "timeout".
- Nothing is replayed across connections. TLS forbids it, and the board's own logic already deals with
  reconnects: QoS 1 shadow reports are sent again by the next report, events wait in their queue, Memfault
  chunks wait for their acknowledgement.
- Buffers on the board: 768 bytes in (three credits of 247), two 247-byte SDUs out. The phone buffers at most
  64 KB from TCP before it stops reading the socket.

## Security

**What the phone can do:** drop bytes, delay them, end the connection, or refuse to relay. That is what any
router on the path can do.

**What it cannot do:** read or change what the board and AWS IoT say, or speak for the board.

- The board runs TLS itself, as before, with peer verification required (`ZSOCK_TLS_PEER_VERIFY_REQUIRED`), the
  Amazon root CA from its own protected storage and the endpoint's name for SNI and the certificate check. The
  address 192.0.2.1 plays no part in that check. A phone that connected somewhere else could not show a
  certificate for the endpoint's name, so the handshake would fail.
- The board's private key never leaves TF-M. The phone gets nothing that would let it connect as the board.
  AWS IoT's policy ties the certificate to the thing name, as always.
- TLS stops replay, reordering and changed bytes within a connection; each connection has a new handshake.
- The phone connects only to the host the board names in OPEN, only if it has the form
  `<prefix>-ats.iot.<region>.amazonaws.com` for the region the app is configured for, and only on port 8883. A
  board, or anything pretending to be one, cannot use a phone as a proxy to anywhere else.
- The app relays only for the board the user picked, which it checks against HELLO.

**Pairing and bonding.** The relay channel and the PSM characteristic need no pairing (security level 1),
and no bond is made. Pairing would add nothing to the confidentiality or integrity above, which TLS gives
end to end, and the board's pairing needs a passkey from its console each time, because it keeps no bonds by
design (`bt_ota.conf`). A relay that asked for that at every reconnect would be no use. The update service and
offline mode keep needing an authenticated pairing; a relay link can never pair (`on_pairing_accept`) and
reaches nothing that needs it.

What an unencrypted Bluetooth link gives away:

- **Who the board is, to someone listening.** HELLO carries the thing name. The TLS 1.2 handshake also sends
  the board's certificate in clear, and its subject is `CN=<thing name>`, as on any network. Over Wi-Fi only
  someone on that network sees it; over the relay, anyone in Bluetooth range who follows the connection does.
  TLS 1.3 would encrypt the certificate, and an encrypted link would hide both from passive listeners.
- **Denial of service.** The board takes one Bluetooth connection at a time. A phone that holds the link
  without relaying keeps others away, but only on a board that has no Wi-Fi anyway, and only until a window is
  opened with Button 1, which drops it.

## The apps

The iPhone and Android apps have the same relay (draft PR, paired with the firmware one):

- `RelayProtocol` (frames, a streaming reader, the host check) and `RelayPump` (the state machine and the
  bounded pipe), with no Bluetooth or sockets in them, tested with a fake channel and a fake socket.
- `RelayLink`: scan for the relay service, connect, read the PSM, open the L2CAP channel (iOS
  `CBL2CAPChannel`, Android `createInsecureL2capChannel`), then TCP with `NWConnection` (iOS) or a plain
  `Socket` (Android). No TLS in the app: the bytes are already the board's TLS.
- Shell bridge: feature `bleRelay`, methods `ble.relay.start {thing}` and `ble.relay.stop`, event
  `ble.relay.state {state, thing, bytesUp, bytesDown}`. The page shows "Relaying for <board>".
- The endpoint: no app has the AWS IoT endpoint today, and it is never written into the repository. The app
  takes the host from OPEN and checks it against the configured region (above).
- iOS background: the iPhone app has no Bluetooth background mode, so relaying lasts while the app is in the
  foreground; when it goes to the background iOS suspends it, the relay stops, and the board reconnects when it
  can. With the `bluetooth-central` background mode CoreBluetooth would keep the link and wake the app for
  incoming data, but iOS still suspends the app between those events and may close its TCP connection while it
  is suspended, so even then relaying in the background would last only while iOS lets it. Android keeps relaying as long as the app's process runs; a
  foreground service with a "Relaying for <board>" notification is what keeps it going with the screen off.
- The Mac and desktop apps come later. The Mac app can share the iPhone code (CraniumKit already builds for
  macOS). The desktop app would need the GATT fallback.

## Cost in flash and RAM

nRF7002 DK, application image, measured with `tools/memory_budget.py` on builds made with
`scripts/firmware/build.sh --keep --no-upload --without-key`:

| Build | Flash free | RAM free | Floors (flash / RAM) |
| --- | ---: | ---: | --- |
| default (no relay) | 38,138 | 924 | 37,888 / 900, unchanged |
| BLE relay (`--cmake-arg -DSB_EXTRA_CONF_FILE=ble_relay_sysbuild.conf`) | 24,722 | 2,452 | 24,576 / 2,304, new |

The relay takes **13,416 bytes of flash and 2,568 bytes of RAM**. The default build has 924 bytes of RAM free,
so the relay cannot simply be switched on there: it is opt-in, and its build gives it the 4,096 bytes that
`bt_ota.conf` adds to the kernel heap for Bluetooth (`CONFIG_HEAP_MEM_POOL_SIZE` 44,240 back to 40,144, the
value without Bluetooth). Whether that heap is still enough with Wi-Fi, Bluetooth and TLS all running is the
first thing to check on hardware (`HEAP` on the serial console).

Where the RAM goes: the 768-byte receive ring, two transmit buffers (596 bytes), the L2CAP channel (232), the
endpoint's name while routing (129), about 100 bytes of state, and about 740 bytes in the Bluetooth host's
dynamic-channel support and the offload hook. The flash: the dynamic-channel code in the Bluetooth host, the
relay module and socket, and the DNS hook. The ring and the transmit buffers are Kconfig options
(`CONFIG_APP_BLE_RELAY_RX_SIZE`, `CONFIG_APP_BLE_RELAY_TX_BUFFERS`); halving the ring would save 512 bytes at
some cost in throughput.

## What is left

- Everything on hardware: L2CAP with iOS and Android, a full TLS handshake through the relay (the AWS
  certificate chain is about 5 KB), MQTT keep-alive across the relay, hand-back to Wi-Fi, a link lost mid-stream.
- RAM: whether the relay build leaves enough heap for the Wi-Fi stack and TLS at the same time, under load.
- Android: a foreground service for relaying with the screen off. iOS: the `bluetooth-central` background mode
  and state restoration for the Bluetooth connection.
- The desktop app (GATT fallback) and the Mac app.
- The console could show "via Bluetooth relay" for a board, from a field in its report.

## Decisions for the owner

1. **Pairing for the relay.** As built, the relay link needs no pairing. The alternative is to bond once with
   the passkey so that only the owner's phones can relay and the link is encrypted. That needs
   `CONFIG_BT_BONDABLE` and `CONFIG_BT_SETTINGS`, which the update's security rules forbid today, and RAM and
   flash for stored bonds.
2. **The exact endpoint in the apps.** As built, the apps accept any AWS IoT ATS endpoint in their configured
   region. To accept only the fleet's own, `GET /api/apps/config` would also return the endpoint (the API
   already reads it for provisioning). That is a console change.
3. **Flash and RAM floors** for the new "BLE relay" build in `tools/memory_budgets.json`, and whether to make
   room so that the relay can be on by default.

## Later

The nRF5340 DK has no Wi-Fi, so a relay would be its only way to the cloud. It would need the cloud client
itself first (identity, MQTT and TLS, none of which its Bluetooth-only build has), so it is not part of this.
