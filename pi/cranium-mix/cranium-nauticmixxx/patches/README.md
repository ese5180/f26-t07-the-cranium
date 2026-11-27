# NauticMixxx native patches

## 0028 — Integrated updates and display corrections for v1.9.1

Adds a signed macOS Sparkle adapter, Qt update choices/status, Windows signed
manifest and payload verification, and a helper that waits for process shutdown
before installation. Immediate restarts are blocked by playback and Auto DJ.
The raw 6% range badge and fullscreen window constraints are corrected.
Sparkle must be fetched using the pinned SDK script; release keys remain outside
the source tree. The test probe is never installed or packaged.

## 0020 — Waveform ecosystem and overview divisions for v1.7

Unifies BLUE/RGB/3Band rendering across Performance, Browser and track previews.
Updates CUE/loop triangles, marker layering and HOT CUE placement; removes the
cyan bar countdown. Overview divisions switch between 30-second TIME SCALE
marks and PHRASE blocks decoded from Rekordbox PSSI/PQTZ. Later HOT CUE letters
progressively overlap earlier ones. Playheads remain red stopped and white
playing, with width 2 in the skin. Fixes retired controller preference-page
references and adds native regression tests. The Inpulse 500 rim calibration
and skin geometry are maintained in the overlay's controller and skin files.


## 0019 — Startup update notice for v1.6

Apply after 0001–0018. Adds one asynchronous GitHub latest-release request at
startup with a five-second deadline, strict stable version parsing and no
retries, redirects or background polling. The English notice offers Download
(the trusted NauticMixxx release page), Later and Skip this version.

The product version comes from nautic/VERSION in this workspace or the
NAUTICMIX_VERSION CMake argument in reconstructed source trees. Mixxx's own
engine version remains unchanged for configuration/database compatibility.
Playback or Auto DJ cancels the check and dismisses an already open notice.
Malformed feeds, drafts, prereleases, HTTP/network errors, oversized responses
and late responses are silently ignored. StartupUpdateCheckerTest covers the
version policy and real HTTP transport against a local deterministic server.

## 0017 — English by default

New configurations use `en_US` independently of the operating-system language.
Explicit user language preferences and command-line overrides still apply.
Installation profiles also set `Locale en_US`.

## 0016 — Selección automática de controladores RX3 para v1.5

Prioriza los presets completos de DDJ-400, DDJ-SX, DDJ-SX2, DDJ-SX3,
DDJ-WeGO3, DDJ-FLX4 y Roland DJ-505 cuando el nombre del puerto MIDI contiene
el modelo. Conserva la búsqueda normal de mappings si falta el preset RX3.
La detección y los mensajes de navegación requieren prueba con cada equipo.

## 0015 — Timing del decodificador Rekordbox para v1.4

Aplica después de 0014. Proyecta grid, cues, loops y waveforms sobre la
coordenada del PCM abierto. Compensa el inicio de MP3 únicamente cuando
CoreAudio y el tag Info/Xing confirman trimming. Conserva los WAV y el
export original. Incluye pruebas METRONOME y arranque aislado para bundles
macOS de test con plantilla interna. Evidencia y límites en
[BEATGRID-TIMING-1.4.md](../docs/BEATGRID-TIMING-1.4.md).

## 0014 — Categorías exportadas y lista RX3 expandida para v1.3

Aplica después de 0013. Lee las categorías visibles y su orden de las tablas
16/17 de `export.pdb` y los asocia a la sesión temporal del USB. SOURCE deja
la selección en la barra de categorías; terminar de preparar el dispositivo
no abre PLAYLIST. TRACK, PLAYLIST y las agrupaciones de metadatos admitidas
requieren confirmación para entrar, y BACK restaura el nivel anterior. Las
listas finales ocultan la columna intermedia y muestran PREVIEW, TRACK,
ARTIST, BPM y GENRE. MATCHING y FOLDER exportadas muestran un panel
«COMING SOON»; REC queda para una versión futura. El USB permanece en sólo
lectura.

## 0013 — Preparación automática de USB Rekordbox para v1.3

Aplica después de 0001–0012. Inicia la detección de volúmenes y la lectura de
catálogos al arrancar y al conectar un USB, sin depender de SOURCE. Conserva
autorizaciones macOS para unidades desconectadas, prepara cada sesión en segundo
plano, rechaza resultados de conexiones anteriores y muestra el estado real del
dispositivo en la skin. Elimina la vista HTML original de Rekordbox y el mensaje
que pedía reabrir SOURCE. El candidato macOS v1.3 se comprobó con un USB
Rekordbox real; la conexión en caliente sigue pendiente de prueba física.

## 0012 — NauticMixxx 1.2 USB preferences

Apply after 0001–0011. This patch enforces Rekordbox USB operation on startup,
fixes the requested deck and waveform defaults, narrows waveform selection to
BLUE/RGB/3Band, and autoloads the RX3 Inpulse 500 mapping when present. It also
removes Mixxx's duplicate stock Inpulse 500 preset. The portable profile and
controller script live outside this native patch in `profile/` and `controllers/`.


`0001-rx3-waveform-edge-beat-grid.patch` applies to the Mixxx 2.5.6 tag. It adds two legacy-skin properties to both waveform backends:

- `DownbeatColor`: color used every four beats, anchored to the first beatgrid marker/downbeat.
- `BeatTickLength`: logical pixel length of the tick drawn from both waveform edges.

The same patch includes the two macOS ARM64 build fixes required by the official Mixxx 2.5 release dependency environment: explicit static `mpg123` linkage and quoting an application bundle name that contains spaces.

The shipped NauticMixxx build is configured with `AU_EFFECTS=OFF`, `QML=OFF`, `MACOS_BUNDLE=ON`, `MACOS_BUNDLE_NAME="NauticMixxx"`, `BUILD_TESTING=ON` and `CMAKE_BUILD_TYPE=Release`.

`0002-rekordbox-macos-sandbox-usb.patch` adds Rekordbox database discovery for
both `PIONEER` and `.PIONEER`, plus a security-scoped directory picker and
persistent bookmark fallback for sandboxed macOS builds. The packaged app is
also signed with `com.apple.security.files.removable-volumes.read-write`, so a
normally mounted Rekordbox USB is discovered automatically.

`0003-rekordbox-macos-tcc-and-retry.patch` fixes the remaining macOS TCC
boundary: metadata-only discovery of `export.pdb` is not treated as proof that
its bytes are readable. Mixxx asks the user to select the USB root once, keeps
the security-scoped bookmark active, and only marks a device as parsed after a
successful transaction so failed imports can be retried.


## 0004 — RX3 0.12.0 visual canvas

`0004-rx3-reference-scaling-readouts.patch` applies after 0001–0003. All changes are opt-in; skins without the new properties retain their existing display behavior.

- Root `<ReferenceSize>1280,800</ReferenceSize>` scales the live legacy widget tree uniformly and centers the canvas. It rescales QSS lengths and font metrics from immutable reference values to avoid cumulative rounding. The waveform viewer forwards scaling to its renderer so its visible time span stays constant, including OpenGL renderers.
- `<Rx3Format>deck</Rx3Format>` on NumberPos renders `mm:ss.mmm` with smaller milliseconds; `transport` renders remaining `hh:mm:ss`; `bars` follows the actual beat grid and refreshes after analysis/grid changes even while paused.
- `<Rx3Format>bpm</Rx3Format>` on Number/NumberBpm reduces the decimal suffix; `beat-ms` displays the duration of one beat from BPM (floored, as in the supplied reference).
- `<Rx3Badge>true</Rx3Badge>` on HotcueButton paints a small colored badge inside the full native clickable cell. A–H use the fixed RX3 palette `#FF376F`, `#45ACDB`, `#7DC13D`, `#AA72FF`, `#30D26E`, `#E0641B`, `#305AFF`, `#C3AF04`.

### Reconstruct on macOS ARM64

Requirements: Xcode command-line tools, CMake, Ninja, Python 3, Git, curl and unzip. Run from the project root:

```sh
sh scripts/build-mixxx-rx3-macos.sh
```

The script downloads official Mixxx 2.5.6 source and the official 2.5 ARM64 dependency environment, verifies both SHA-256 digests, applies all seventeen patches, builds the app and runs the RX3 tests. It writes a signed bundle to `tmp/mixxx-native-rebuild/stage/NauticMixxx.app`; it does not install or modify controller settings. Use `RX3_BUILD_ROOT` to choose another build/cache directory and `RX3_BUILD_JOBS` to adjust parallelism. Allow roughly 8 GB of free disk space.

## Patch 0009: public product identity

`0009-nauticmixxx-product-branding.patch` changes the application name reported
by the engine to NauticMixxx. The bundle name, icon and 1.0.0 release metadata
are supplied by the build and packaging scripts; Mixxx attribution remains in
About, licenses and source notices.

The recovered working source is currently in `tmp/mixxx-native/mixxx-2.5.6`, with dependencies in `tmp/mixxx-native/buildenv` and build output in `tmp/mixxx-native/build`. The downloadable source archive SHA-256 is `9cfc9025d50d2511767ee52a07b8854f75c581f0585197d043bc219fcf9f9050`; the dependency ZIP SHA-256 is `b76685e77f681baf8fdc5037297b0f16d323a405d09ce276d8844304530278e1`.

Validation covers formatting edge cases, beat-map changes, repeated 1280×800 → 1920×1080 → 1024×640 resizes without widget recreation, and existing beat/cue/button behavior. GUI validation uses an isolated profile with a synthetic 120 BPM track, checks STATUS/BEAT FX, full-cell hot cue clicks, and window maximize/restore. Controller hardware is not exercised by these visual tests.


## 0005 — RX3 0.13.0 playback display state

Apply `0005-rx3-master-loop-visual-state.patch` after 0004. `<Rx3DisplayState>true</Rx3DisplayState>` creates a skin-owned presentation model before parsing widget bindings. It publishes `[RX3Display],master1`, `master2` and `master_bpm`. Playing decks take precedence over paused decks; the current playing master stays selected when the other starts, and stopping it hands off to the other playing deck. An explicit Mixxx sync leader is honored while playing. With no decks playing, the last loaded master remains selected. It never writes transport, sync or BPM controls. Old MASTER is cleared before the new one is set.

`<Rx3Format>loop</Rx3Format>` renders loop sizes including reciprocal fractions. Floating-point validation uses Mixxx's FpClassify wrappers so release fast-math optimization cannot discard NaN checks. Skin bindings use `beatloop_size`/`loop_enabled`, fixed quantize slots, played overview shading and white playheads. Controller mappings are unchanged.

0.13.0 validation: 69 native tests plus GUI checks of two playing decks, master handoff, quantize disappearance with stable CONTINUE position, played shading, solid white cursor, active 2-beat / 1/2-beat loops and inactive blank loop readout. The official-Windows 0.12.0 compatibility ZIP remains a separate, older package and does not include this native model.


## 0006 — RX3 0.15.1 browser and hot cues

`0006-rx3-browser-grid-hotcue.patch` applies after 0001–0005. The new `Rx3Browser` skin node wraps the existing Mixxx library and sidebar. Its original SOURCE supported both the PC collection and Rekordbox devices; patch 0010 deliberately removes the PC source. Tall track rows, stored waveform summaries, artwork, row numbers, TRACK/ARTIST columns, category/folder navigation and search remain available for the selected USB. `[RX3Browser]` event controls connect the Inpulse encoder to this native view. USB TRACK/PLAYLIST retain the selected device. No on-screen LOAD buttons are added.

`Rx3Hotcue` is an opt-in DefaultMark property: A–H waveform badges use the fixed RX3 A–H palette documented above, appear at both waveform edges and leave the signal unobstructed. The STATUS hot-cue cells use the same palette. `Rx3Overview` draws a unipolar overview with paired badges. `Rx3Format=browse` displays remaining mm:ss. Other skins keep their legacy drawing behavior.

Preview reads use a bounded cache of stored analyses without opening cloud audio files during paint. Missing cover art failures are cached only for the RX3 browser. Unanalyzed tracks have no invented waveform preview. Rekordbox's existing backend does not expose the PC library's preview/artwork columns; this patch does not replace its parser or fabricate missing data.

Validation: 74 native regression tests, including paired badge rendering at pixel ratios 1 and 2; 60 mapping tests using the actual MIDI components; 22 display state checks and AUTOLOOP, loop-adjust and Sound Color FX regression scripts. All six patches were applied successfully to a clean official 2.5.6 source archive. The physical controller still needs a hands-on VINYL ON/OFF check. QA discovered the mounted USB but its database import returned a parser exception; USB playlist contents were not verified.

This release needs the patched native runtime. The existing Windows 0.14.0 compatibility ZIP remains separate; it does not receive this native browser. Windows native 0.15.1 has build recipes, but no Windows binary was built or tested on this Mac.

0.15.1 final polish: measured three-band overview colors now match the browser previews (blue bass, orange mids, white highs), edge badges remain fully visible, category icons use separate large icon/small label sizes, INFO shows selected-track metadata, and the footer deck badge keeps its compact width. Two additional pixel tests verify band order and silence.


## 0007 — RX3 0.16.0 navigation and deck states

Apply after 0001–0006. Native BROWSE remembers the logical focus on hide and restores it on open without clearing the current search or track selection. The controller no longer forces the folder tree when reopening; the BEAT GRID hold threshold is 2000 ms, including the release-time fallback.

The RX3 skin opts out of pre/post-roll decorations with `ShowPreroll=false` in both waveform backends, and the shader renderer's marker countdown with `ShowUntilNextMark=false`. Other skins retain their defaults. Assigned RX3 hotcue pads always use black letters; empty pads use white. RX3 Overview paints red “Not Loaded.” for empty decks, leaves a four-reference-pixel gap below the signal, then draws a two-pixel white baseline. Browser decks use a full-height overview beside the time column and a compact BPM box; empty BPM readouts are hidden.

For the XDJ_RX3_Mixxx skin only, windowed startup restores a 1280×800 logical-pixel canvas. Closing in fullscreen persists that state; reopening keeps fullscreen and proportional reference scaling. The normal Mixxx behavior for other skins is unchanged. Physical screen dimensions quoted as 34:21 do not override the explicitly requested 1280×800 pixel canvas (16:10).

Validation: 75 native tests, including dark/bright assigned pad colors and empty lettering; 63 controller tests, including the 1999/2000 ms boundary and reopening without folder-focus writes; existing display, loop and Sound Color FX regressions. Native QA checked browser layout, empty decks, removal of decorative triangles, and fullscreen close/reopen. Startup logs report the reference canvas size.


## 0008 — Safe USB library state restoration

Apply after 0001–0007. Library view state now stores row and column numbers rather than live `QModelIndex` objects. Reopening the same Rekordbox USB can rebuild the source data behind an existing proxy model; cached indexes then retain invalid internal pointers and previously caused an `EXC_BAD_ACCESS` in `QSortFilterProxyModel::parent()` while restoring the selection. The view now validates the active model, reconstructs fresh indexes, skips rows that no longer exist and preserves the current row/column when possible.

Validation includes a regression test that saves a selection, resets and repopulates the source behind a `QSortFilterProxyModel`, then restores the same state key. The RX3 and Rekordbox USB suites continue to pass.

## 0010 — Rekordbox USB-only operation

Apply after 0001–0009. `[Library] UsbOnlyMode=1` suppresses the first-run music
directory chooser, disables automatic and manual local scans, rejects attempts
to add local directories and disables the corresponding preference controls.
The RX3 browser opens on SOURCE, removes SOFTWARE CONTROL and exposes only
detected Rekordbox devices with TRACK and PLAYLIST navigation. The internal
database remains available to the engine for transient state and history, but
is not a navigable music source.

This patch also versions the advanced Rekordbox runtime that previously existed
only in the corresponding-source tree: direct PDB/ANLZ catalog access, imported
waveforms and strict track capability policies. USB-backed tracks may be loaded
and played, but they cannot be persisted into the local collection, exported,
rewritten or passed to local analysis jobs.


## 0011 — RX3 1.1 display geometry and playhead

Apply after 0001–0010. `ReferenceFill=true` makes the live canvas fill its
viewport while fonts and fixed dimensions retain uniform reference scaling.
Flexible waveform/layout regions absorb the remaining width. Without this
opt-in, `ReferenceSize` keeps its original centered aspect ratio behavior.

`PlayPosWidth` specifies a width of 1–4 reference pixels (default 1). Both
waveform backends and overview cursors use it; the RX3 skin selects 2 and
`PlayPosColor=#ff0000`. Resizing preserves the reference width. The skin aligns
the lower waveform edge with the STATUS / BEAT FX panel and leaves a ten-pixel
gap above the mode strip at 1280×800.

The regression suite covers fill at matching and different aspect ratios,
resizes with an unchanged scale factor, widget/control identity, legacy
letterboxing and invalid/missing cursor width values. The patch also carries
an existing test sampling-coordinate correction from the working source so
reconstructed and working tests match.

## 0018 — Audio reconfiguration deadlock

Apply after 0001–0017. Replaces the PortAudio finished callback mutex with a
lock-free atomic completion signal. Blocking secondary streams skip the callback
handshake and use Pa_AbortStream. SoundManager stops the clock device first and
starts it last so its callbacks cannot access secondary streams during teardown
or FIFO initialization.

StreamCompletionTest covers completion before/during wait, timeout, late/repeated
callbacks and reset. SoundReconfigurationHardwareTest.HerculesBoothWithM2Main is
opt-in with NAUTIC_AUDIO_HARDWARE_TEST=1 and requires real M2/Inpulse 500 devices.
Run it with an external process timeout. It alternates booth 1–2 off/on while
headphones 3–4 and M2 main remain configured, using all three synchronization
modes at 44.1 and 48 kHz.

## 0021 — Browser playback state and vector icons

Apply after 0001–0020. Tracks on either main deck are bright green (#01FF02)
with a vector PLAY indicator while playing, then dark green (#008A01) after
60 seconds of elapsed playback in one load, retained for the application session.
Pauses, replacement, preview decks and seek distance do not count. Tracking
continues when the browser is hidden and identities include the USB session.
The state is presentation-only and never mutates USB history or SQL play counts.

The note/H marker and sidebar categories use font-independent vector icons.
ALAC/AAC in M4A is distinguished asynchronously with TagLib audio properties.
The skin uses matching 2 px STATUS tab padding on all sides.

## 0022 — Controller preference teardown after device deletion

Apply after 0001–0021. Retains the actual openChanged connection handles and
disconnects them without dereferencing a fresh device list during teardown.
ControllerManager clears its device list before deleting enumerators, which
own those devices. This addresses the reported macOS 1.7.0 stack in
QObject::disconnect / DlgPrefControllers::destroyControllerWidgets.

## 0023 — Overview position progress

Apply after 0001–0022. The RX3 overview axis is gray ahead of the current
playhead and white behind it, including after a seek back. The rendering
helper is shared by PERFORMANCE and BROWSER. Tests cover start, end, seek,
invalid positions and both standard and Retina pixel ratios.

## 0024 — Animated deck playback badge

Apply after 0001–0023. Opt-in RX3 deck labels paint DECK and the numeral in a
compact fixed layout. Red/orange waves grow through three vector stages and
then disappear. Animation runs only with a loaded playing track and resets on
pause/unload. The approximate cadence is 200 ms per stage (800 ms per cycle),
independent of BPM; Pioneer does not document the exact animation period.


## 0025 — USB browser navigation and touch search

Version 1.9 development adds immediate category previews, a fixed RX3 category
order, stable logical USB slots, paired browse columns, controller focus
handoff, and a touch search keyboard. Expanded track views fit exactly twelve
rows. USB folder playback uses temporary tracks with a dedicated policy that
allows analysis but blocks persistence, importing and metadata writes. MATCHING
uses NauticMixxx harmonic/tempo suggestions; RELATED KEY remains a placeholder.
The deck badge is moved down slightly. Native tests cover geometry, matching,
category order, keyboard input, and USB folder confinement/policy.

- `0026-performance-grid-and-selected-deck.patch`: user-selected deck independent
  of playback MASTER, selected GRID downbeat lines and tools, paired badge blink,
  directional beat-jump rendering and a frameless 1280×800 macOS RX3 window.

- `0027-browser-continuous-column-divider.patch`: removes reserved left-list scrollbar gaps and paints one full-height gray divider between USB browse columns, including header and blank rows. Overflow remains navigable.


- `0028-integrated-updates-and-display-corrections.patch`: integrated signed updates, pad feedback, selected-deck stability, typography and fullscreen display corrections from v1.9.1.

## 0029 — SHORTCUT and explicit deck selection (v2.0)

Apply after 0001–0028. Adds the RX3 touch/encoder SHORTCUT panel, persistent local settings, validated read-only rekordbox MY SETTINGS imports, explicit deck selection targets and PERFORMANCE LOAD selection. The engine supports fractional quantization, hot-cue recall policy, jog response, fader curves, needle lock and routed beat-quantized effect activation. The RX3 range badge has a one-pixel text stroke and green/red/white/unboxed WIDE states. Skin and controller assets are installed alongside the native patch. See `docs/SHORTCUT-2.0-EN.md` for gestures, supported USB fields and hardware validation requirements.


## 0030 — INFO, USB ratings and waveform samples (v2.0)

Adds the native INFO page, highlighted Browse-row details, category Information
Jump, saved load-source lists, and context-aware held encoder rating edits.
Explicit rating writes validate session and track identity, atomically update the
legacy DeviceSQL rating byte, keep one recovery copy and publish the new rating
after success. Generic tag writers retain USB read-only protection. Desktop
CUE GRID INFO import remains a separate physical round-trip check.

Adds BLUE/RGB/3BAND samples drawn inside the existing SHORTCUT buttons. See
[INFO-USB-2.0-EN.md](../docs/INFO-USB-2.0-EN.md) for behavior and primary sources.

## 0031 — Emergency playback, precise tempo and SHORTCUT USB layout (v2.0)

Apply after 0001–0030. Cache USB playback PCM for emergency loops, invalidate lost
mounts, restrict affected deck transport and SYNC, allow recovery loads, and show
per-deck unavailable-source presentation. Preserve precise constant PQTZ BPM while
retaining changing grids. Keep discovery fingerprints current after rating writes.
Leave the shared footer fully clear and group USB slot, name and settings rows.
Controller SYNC assets are updated alongside this patch. See
[EMERGENCY-SYNC-2.0-EN.md](../docs/EMERGENCY-SYNC-2.0-EN.md).

## 0032 — Keep active loops when jumping to Hot Cues (v2.0)

Apply after 0001–0031. Relocate the loop and hot-cue seek together in the audio
callback. Beat loops retain their musical length; manually trimmed loops retain
sample duration. Quantize snaps the destination and preserves playback phase,
including sub-beat loops. Normal pad activation/release, explicit hot-cue jumps,
paused preview and reverse keep the loop enabled. Saved loop recalls retain their
own boundaries; relocating one through a normal hot cue leaves its stored cue
unchanged. Seven native regressions cover these interactions.

## 0033 — Complete empty-deck logo above waveform rows (v2.0)

Apply after 0001–0032. Bind the empty-deck presentation to an exclusive
logo/signal stack: hide the complete native signal page while both decks are
empty, and select it when either deck loads. The skin separates deck information
cards from that stack so they remain visible and interactive. This hides native
OpenGL ancestors instead of relying on an alien logo's stacking order. Restore
the correct page after countdown/INFO transitions. Two native regressions cover
full-logo composition at 1280×800 and 1920×1080, either-deck loading/unloading,
exclusive waveform visibility and delayed page restoration.

## 0034 — Move the frameless RX3 window from its empty top margin (v2.0)

Apply after 0001–0033. Handle left-button dragging only in the first 10 pixels
of the window, excluding 10-pixel side insets and every child control. Listen
on the existing canvas and SkinContainer margins without adding an overlay
or changing REMAIN. Prefer native system movement and provide a mouse-grab
fallback; stop on release/hide and exclude maximized/full-screen windows.
Native regressions cover the hit area, REMAIN clicks and fallback movement.

## 0035 — Persistent Beat FX Bank and momentary contextual X-PAD (v2.0)

Apply after 0001–0034. Replace the skin's simultaneous effect selectors and
deck-loop X-PAD connections with a native four-favorite Bank and horizontal
touch/mouse pad. Save stable effect IDs immediately, preserve occupied and
unavailable registrations, support targeted deletion, and recall via Unit 1's
first effect slot. Touch enables and release/cancel disables the unit; view
switching alone preserves activation. Select a contextual processor parameter,
adapt beat/pitch cells and continuous gray-center rails, keep readouts synchronized
and preserve engine quantization. Empty slots always open a curated performance-effect
chooser, matching the RX3 selector; other skins retain their effect lists. Repair
old utility favorites on explicit selection and preserve active parameters when
registering the current processor. Keep selection independent of activation
and outline selected favorites/parameter cells in white. Center the RX3 selector
name and render the BEAT readout unit smaller than its value. Sixteen native
regressions use real effect slots and parameters. The skin overlay supplies
the placeholder, styling and dynamic right-hand time label. See
[BEAT-FX-2.0-EN.md](../docs/BEAT-FX-2.0-EN.md) for supported processors and scope.


## 0036 — Complete overview playing-address warning (v2.0)

Apply after 0001–0035. Dim the entire horizontal address during the warning off
phase, including its gray segment, rather than only hiding the small white
remaining portion. Honor the existing Waveform EndOfTrackWarningTime setting;
zero disables the warning. Keep the default 30-second threshold and faster
cadence below 15 seconds. Native regressions cover threshold boundaries,
TIME/REMAIN pixels, actual WOverview timer-driven paints and pause behavior.


## 0037 — Native RX3 performance and encoder-operated USB workflows (v2.0)

Apply after 0001–0036. Implement both Beat Loop tables, paused/playing Gate Cue,
independent Release FX, safe asynchronous headphone preview, retained Memory
Cues/Loops and Active Loop triggering. Add dedicated ANLZ performance writes,
DeviceSQL playlist/history append operations and asynchronous MY SETTINGS SAVE
with source/volume identity guards and recovery copies. Preserve unedited
imported timing, unknown metadata and existing track rows.

Add one shared encoder TOOLS contract for tags, four playlist favorites,
combined filters, related keys, memory/performance saves, preview, REC and
configured software audio paths. Add Auto Cue levels, originating-list CONTINUE,
EJECT LOCK, guarded recorder commands and elapsed time. Add controller-independent
microphone tone/low-cut and normal dB-based talkover, including supported USB
mixer-setting fields. Use actual macOS
filesystem information when the bundled Qt reports a different mounted volume.
The controller/skin overlay supplies the pad controls and retains established
Inpulse 500 gestures. See [scope and unfinished integration](../docs/RX3-WORKFLOW-2.0-EN.md).
The patch does not implement Link Export or registered MATCHING pairs and does
not complete the explicitly deferred Beat FX/Sound Color FX catalogs.


## 0038 — Beat FX audio, exact timing and shared encoder controls (v2.0)

Apply after 0037. Scope safe parameter initialization to explicit RX3 loads,
open both FILTER cutoffs, enable REVERB send and use decay on its X-PAD.
Add opt-in exact timing to ECHO/PHASER/TREMOLO while retaining legacy knob
rounding by default. Extend ECHO to four beats/six seconds and TREMOLO to
16 cycles per beat; advance both ECHO read heads even for an unchanged delay.

Add held bank replacement and SOURCE → TOOLS → BEAT FX for common encoder selection,
LEVEL / DEPTH, routing, AUTO/MANUAL/TAP tempo, momentary X-PAD and bank storage.
Advance one beat/pitch cell per encoder tick and show its actual value. Keep
TOOLS accessible without USB. Correct one-past-buffer dry addition.
Forward the selected master deck's beat metadata to master effects and manual
tempo/phase to unit 1. Add real processor audio and menu lifecycle regression
coverage; preserve established controller mappings. The complete RX3 effect
catalog remains deferred. See [controls](../docs/BEAT-FX-CONTROLS-EN.md).


## 0039 — Encoder access to SHORTCUT CLOSE (v2.0)

Apply after 0038. Include CLOSE immediately after TOOLS in SHORTCUT's shared
encoder focus order, with the same white focus outline as other actions.
Pressing the encoder closes SHORTCUT and restores the underlying page through
the existing close path. Keep touch closing and controller gestures intact.
Regression covers forward/backward focus, close activation, previous-page
restoration and preserved deck settings through the common controller controls.


## 0040 — Preserve RX3 overview colors at track end (v2.0)

Apply after 0039. Skip the stock red end-of-track background and outline for
RX3 overviews. Preserve playing-address blinking, its threshold and cadence,
waveform shading, markers and transport behavior. Other skins retain their
existing end-of-track colors. Native painting regression compares the complete
RX3 image with the end flag on/off both near the end and at zero remaining,
and checks that stock overviews still draw their red warning.


## 0041 — USB-only SOURCE rows and encoder BACK in TOOLS (v2.0)

Apply after 0040. Remove the synthetic TOOLS device row and its source-info
presentation; preserve the top TOOLS button and the controller-accessible
SHORTCUT TOOLS action. Include the existing BACK button after the last action
in every common encoder tool menu, with blue focus feedback. Preserve edit
completion, touch actions, direct back gestures and safe nested-menu callbacks.
Regression exercises forward/reverse BACK focus, touch selection after BACK,
empty menus and replacement callbacks, plus mouse-free SHORTCUT access to
BEAT FX without a USB device. Established mappings remain unchanged.

## 0042 — SOURCE MY SETTINGS and visible navigation (v2.0)

Apply after 0041. Keep MY SETTINGS inside the right SOURCE panel, with LOAD,
BACKGROUND COLOR, WAVEFORM COLOR and encoder-selectable BACK. Reuse the
SHORTCUT loader without showing SHORTCUT, explicitly passing the panel's USB
root. Expose SOURCE, BROWSE, TAG LIST, PLAYLIST, SEARCH and MENU above the
full-width page title; source navigation resolves the highlighted USB first.
Preserve the existing controller gestures and add common navigation commands.
Turn past the USB rows to reach MY SETTINGS and the header actions. Render
separate USB icon/label/arrow areas, and store the portable Nautic accent in
its own JSON file without altering Pioneer settings or databases. Regression
covers selected-source loading, missing files, SOURCE header order, encoder
access without USB and per-device accent validation/preservation. The skin
contains corresponding header/focus styles and mirrors the six navigation
commands in PERFORMANCE's existing topbar outside this native patch.

## 0043 — Separate UTILITY settings and transactional encoder editing (v2.0)

- Keep MENU/TOOLS operation actions; hold MENU for UTILITY or select its
  encoder-accessible TOOLS entry. Preserve the original PERFORMANCE topbar.
- Add a two-column DECK/MIXER/GENERAL settings table with live values,
  preview/apply/cancel editing, unavailable-setting explanations and BACK.
- Reuse SHORTCUT controls and persist per-deck Auto Cue thresholds. Read live
  headphones, deck settings, EQ and load policy; show mixed/custom values.
- Fix empty-phrase data fallback to time-scale overview marks. Preserve the
  browser return title and avoid a stale USB/playlist breadcrumb over menus.
- Native tests cover held MENU release suppression, return state, touch and
  encoder transactions, missing capability, live values and phrase fallback.
- Full hardware UTILITY parity remains incomplete; see docs/UTILITY-2.0-EN.md.

## 0044 — Unified UTILITY operations and stopwatch (v2.0)

- Make MENU, the existing tools command and SHORTCUT's UTILITY button open
  one grouped table. Retain established controller bindings.
- Place all former TOOLS operations under DECK, MIXER, EFFECTS, BROWSER and
  RECORDING; waveform options belong to DISPLAY and language/version to GENERAL.
- Remove hardware-only and unimplemented RX3 placeholder rows. Actual audio
  controls still require a configured input/output and retain their safeguards.
- Reuse operation panels with live edits and preserve table focus, selected
  USB/track/playlist context and correct return titles. Keep transactional
  preview/apply/cancel for ordinary settings.
- Match BROWSER's black/gray alternating rows and continuous gray divider.
- Draw REMAIN's stopwatch as a scalable vector instead of a font glyph.
- Native checks exercise all operation entry/return paths, unavailable-source
  messages, action callback ownership, row colors/divider and existing FX editing.
