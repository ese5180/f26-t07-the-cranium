# Cranium on the Pi: step 1, Mixxx metrics to JSON

A Raspberry Pi 4 or 5 (arm64, Raspberry Pi OS trixie) runs the team's Mixxx fork
([dbosket/mixxx](https://github.com/dbosket/mixxx), branch `cranium`, 2.7.0-alpha). This folder turns what
Mixxx is doing into the JSON messages that the later steps send to the nRF5340.

| File | What it is |
| --- | --- |
| `mixxx/controllers/Cranium-Metrics.midi.xml`, `.js` | A Mixxx mapping with no controls, loaded on the Midi Through port. Once a second it logs one `CRANIUM_METRICS {...}` line to `mixxx.log`. |
| `cranium_collect.py` | Reads those lines, and the play history in `mixxxdb.sqlite`, and writes the `np`/`hb` messages. |
| `cranium_stats.py` | An HTML dashboard of the play history (`--serve` for a live one on port 8080). |
| `bin/cranium-mixxx` | Starts Mixxx with the arguments the metrics need. |
| `bin/cranium-collect` | Runs the collector with the settings of `cranium.conf`. |
| `bin/cranium-install` | Copies the mapping into Mixxx's folder, and makes the desktop menu start Mixxx through `cranium-mixxx`. |
| `cranium.conf.default` | The settings. Change them in `~/.config/cranium/cranium.conf`, which is never in git. |

## The messages

The collector prints each message and appends it to `~/.cranium/messages.jsonl`. Every heartbeat it also
rewrites `~/.cranium/latest.json` (the last `hb`, now playing, and the raw metrics). The values are integers;
a key ending in `10` is in tenths:

```json
{"t":"np","ti":"Title","ar":"Artist","ge":"House","bpm10":1240,"dur":312}
{"t":"hb","up":600,"mx":1,"pl":1,"bpm10":1240,"cpu10":24,"cpux10":31,"lat10":213,"xr":0,"xrd":0,"tp":7,"min10":315}
```

The full list of keys is at the top of `cranium_collect.py`. A few things to know:

- `np` comes from Mixxx's History, which records a track when it becomes the main track. If a track was
  played within Mixxx's last 6 history entries, Mixxx does not record it again, so it gets no `np`. An
  untagged track takes its file name as its title.
- `mx` is 1 while metrics lines arrive, and 0 within about 5 s of Mixxx quitting.
- `xr` is Mixxx's `audio_latency_overload_count`. Mixxx counts at most one overload every 500 ms, so `xr` counts
  overload episodes, not raw xruns. `xrd` is how many are new since the last `hb`.
- `cpu10` is the audio callback's share of its time budget (`audio_latency_usage`), not system CPU.

## Setting up a Pi

From a clone of this repository on the Pi (`~/cranium` below):

```bash
sudo modprobe snd-seq-dummy                          # the Midi Through port; add snd-seq-dummy to /etc/modules to keep it
~/cranium/pi/bin/cranium-install
~/cranium/pi/bin/cranium-mixxx                       # or Mixxx from the desktop menu
```

`cranium-install` copies the mapping into `~/.mixxx/controllers`. It also adds a per-user copy of Mixxx's menu
entry, `~/.local/share/applications/org.mixxx.Mixxx.desktop`, which starts Mixxx through `cranium-mixxx`.
Without that copy, Mixxx started from the menu writes the metrics lines in late bursts: `mx` flickers
between 1 and 0, and the collector prints `metrics lines arrive N s late`. Deleting the copy undoes it.

In Mixxx: Preferences > Controllers > **Midi Through Port-0**: load the mapping **Cranium Metrics** and
tick **Enabled**. Mixxx saves these choices in `mixxx.cfg`, as `[ControllerPreset] Midi_Through_Port-0` (the
mapping's path) and `[Controller] Midi_Through_Port-0 1`. With Mixxx closed, you can write those lines
yourself instead of using the preferences.

Mixxx hides Midi Through unless `[Controller] midi_through_enabled 1` is set (the **Show MIDI Through
Port** box on the same page) or it runs with `--developer`. If the setting is missing, `cranium-mixxx` adds `--developer`.

Then, in a second terminal:

```bash
~/cranium/pi/bin/cranium-collect --heartbeat 2
```

It is working when every `hb` shows `"mx":1` while Mixxx runs, and a track played to the main mix
gives one `np`. If `mx` stays 0, check that the mapping is loaded and enabled on Midi Through Port-0
(above), then restart Mixxx: it loads the mapping only when it starts. If the collector prints
`metrics lines arrive N s late`, Mixxx was started without `cranium-mixxx`.

### Why the launcher

`bin/cranium-mixxx` passes these to Mixxx:

- `--log-flush-level warning`: the metrics lines are warnings. Without this flag Mixxx flushes them to the
  file only when its buffer fills or after a critical message, so they arrive late and in bursts.
- `--log-max-file-size` (`MIXXX_LOG_MAX_BYTES`, 500 MB): Mixxx stops logging at 100 MB by default, and it writes
  its own debug lines to the same file.
- `--settings-path`, if `MIXXX_DIR` is not `~/.mixxx`. The collector then reads that folder too.
- With `MIXXX_AUDIO=pw-jack` it runs `pw-jack mixxx`, for Mixxx's JACK API on PipeWire. With `native`, the
  default, Mixxx uses the API chosen in its preferences.

Mixxx rotates `mixxx.log` each time it starts (to `mixxx.log.1`, ...). The collector follows the new file.

## Tested

On a Pi 5 (Raspberry Pi OS trixie, Mixxx 2.7.0-alpha, ALSA at 48 kHz) on 2026-11-09: `mx` was 1 while
Mixxx ran and 0 within about 5 s of quitting it, `latest.json` updated every heartbeat, and each track
played gave one `np` with the right title and artist. A real audio overload (`xr`) has not been seen yet.
