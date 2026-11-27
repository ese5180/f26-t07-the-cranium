# Link Export transport requirements — NauticMixxx 2.0.0

This is an integration design, not a claim that Link Export is implemented.
The user confirmed on October 10, 2026 that rekordbox may run on the same
computer or on a separate computer used to prepare music.

## Required workflows

| Workflow | Source lifetime | Current status |
| --- | --- | --- |
| Prepare in rekordbox on computer A, export USB, play in NauticMixxx on computer B | The USB contains the music and exported analysis; computer A can be off | Native DeviceSQL USB playback already available |
| Online rekordbox and NauticMixxx on one computer | A live service, distinct local endpoint and compatible device identity are needed | Link transport pending |
| Online rekordbox on A and NauticMixxx on B | Live discovery, catalog access and audio transfer across their connection | Link transport pending |

The offline workflow must remain independent of rekordbox installation, account,
collection location and drive letters on the performance computer. Source paths
remain bound to the exported USB. Controller mappings cannot supply that library
or make portable playback depend on their vendor software.

## Transport boundaries

RX3 USB Link Export is a device/driver connection. The Inpulse 500 supplies a
controller/audio interface and does not become an RX3 USB device when mapped in
NauticMixxx. A normal host USB port cannot be assumed to expose that identity.
A shared exported folder, XML import or copied PDB is portable-source ingestion;
it does not demonstrate live Link Export interoperability.

The PC implementation therefore needs an explicit transport adapter independent
of MIDI/HID controller profiles. A network-based PRO DJ LINK client is a possible
implementation route, subject to actual rekordbox recognition. The protocol
research separates discovery/number claiming, metadata database requests and NFS
file transfer. Same-host operation also needs validated address/port ownership;
loopback must not be assumed compatible with device discovery. Current rekordbox
security/handshake behavior requires a real application test.

## Integration contracts

- Discovery must distinguish local and remote sessions, avoid occupied player
  numbers and report connection errors in SOURCE and the encoder menu.
- Each remote catalog needs its own session identifier. Existing USB identities
  and permission to write USB files must never be borrowed by a remote source.
- Catalog and analysis reads belong on workers; network timeouts and file fetching
  must not block the audio callback or browser.
- Playback needs bounded buffering, explicit stream-loss behavior and an emergency
  transition. An online source must not point at a path on another computer as
  though it were a local file.
- USB-only writeback stays scoped to mounted device exports. Remote cue/grid
  changes cannot be labeled saved in rekordbox without a verified write protocol.
- SOURCE/TOOLS uses the same move/enter/back controls for every current and future
  controller. Dedicated hardware controls are optional accelerators.

## Acceptance evidence still required

The connection must be tested with installed rekordbox versions for both same-host
and two-computer configurations: recognition, browsing, cue/grid/analysis retrieval,
loading either deck, headphone preview, continued playback, disconnect/reconnect,
occupied device numbers and unavailable audio files. Packet-parser or copied-export
tests alone do not close these requirements. No live Link Export test has passed
in the current implementation.

## Primary protocol references

- [rekordbox USB Export / Link Export](https://rekordbox.com/en/support/usb-export/)
- [RX3 support](https://support.alphatheta.com/en-us/products/4416587179673)
- [PRO DJ LINK protocol research](https://dysentery.deepsymmetry.org/dysentery/track_metadata.html)
