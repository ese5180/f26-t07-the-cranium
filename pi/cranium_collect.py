#!/usr/bin/env python3
"""Cranium step 1: collect Mixxx metrics and turn them into JSON.

Reads (in Mixxx's settings folder, ~/.mixxx unless --mixxx-dir says otherwise)
  mixxx.log        CRANIUM_METRICS lines written by the Cranium Metrics mapping (1/s)
  mixxxdb.sqlite   Mixxx play history (title/artist of each new track)

Writes (default folder ~/.cranium/, change with --out-dir)
  latest.json      snapshot, rewritten every heartbeat: health + now playing + raw metrics
  messages.jsonl   one JSON message per line, appended: every "np" and "hb"
  ...and prints every message to the terminal.

Messages (integers only; keys ending in 10 are tenths, e.g. bpm10=1240 -> 124.0 BPM):
  {"t":"np","ti":"Title","ar":"Artist","ge":"House","bpm10":1240,"dur":312}
      when a new track becomes the main track. Mixxx does not log a track again that was played
      within its last 6 history entries, so replaying one of those gives no "np".
  {"t":"hb","up":600,"mx":1,"pl":1,"bpm10":1240,"cpu10":24,"cpux10":31,"lat10":213,
   "xr":0,"xrd":0,"tp":7,"min10":315}
      every --heartbeat seconds (default 10):
      up  uptime of this script (s)      mx  1 if Mixxx metrics are arriving
      pl  decks playing                  bpm10  first playing deck's BPM x10
      cpu10/cpux10  engine load % x10, now / max since last hb
      lat10  output latency ms x10       xr/xrd  overloads this Mixxx session / new since last hb
                                         (Mixxx counts at most one overload per 500 ms)
      tp  tracks played since start      min10  minutes with any deck playing x10

These are the same messages the later steps send to the nRF.

Usage:
  python3 cranium_collect.py                 # run until Ctrl+C
  python3 cranium_collect.py --heartbeat 2   # faster updates while testing
  python3 cranium_collect.py --mixxx-dir DIR # Mixxx started with --settings-path DIR
Standard library only.
"""
import argparse
import json
import os
import re
import sqlite3
import time

HOME = os.path.expanduser("~")
METRICS_RE = re.compile(r"CRANIUM_METRICS (\{.*\})\s*$")
TEXT_MAX = 40
LATE_S = 3          # a metrics line written this many seconds after its "t": Mixxx is not flushing its log
NOW_PLAYING_SQL = """
SELECT pt.id, pt.track_id, pt.pl_datetime_added,
       l.title, l.artist, l.genre, l.bpm, l.duration, tl.filename
FROM PlaylistTracks pt
JOIN Playlists p ON p.id = pt.playlist_id
JOIN library   l ON l.id = pt.track_id
LEFT JOIN track_locations tl ON tl.id = l.location
WHERE p.hidden = 2              -- Mixxx's play-history ("History") playlists
ORDER BY pt.id DESC
LIMIT 1
"""


class LogTail:
    """Follows mixxx.log like `tail -F`: waits for it to exist, and keeps going
    when Mixxx replaces it on restart.

    A log that is there at startup is read from where it ends then, as its lines are old.
    A log that appears later (Mixxx's first start, or a rotation) is read from its start."""

    def __init__(self, path):
        self.path, self.f, self.inode, self.buf = path, None, None, ""
        self._open(at_end=True)

    def _open(self, at_end=False):
        try:
            f = open(self.path, "r", encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return
        if at_end:
            f.seek(0, os.SEEK_END)
        self.f, self.inode, self.buf = f, os.fstat(f.fileno()).st_ino, ""

    def lines(self):
        if self.f is None:
            self._open()
            if self.f is None:
                return []
        try:
            st = os.stat(self.path)
            if st.st_ino != self.inode or st.st_size < self.f.tell():   # Mixxx restarted
                self.f.close()
                self.f = None
                self._open()
                if self.f is None:
                    return []
        except FileNotFoundError:
            pass
        chunk = self.f.read()
        if not chunk:
            return []
        self.buf += chunk
        *out, self.buf = self.buf.split("\n")
        return out


def clip(s):
    s = (s or "").strip()
    return s if len(s) <= TEXT_MAX else s[: TEXT_MAX - 1] + "…"


def x10(value):
    try:
        return int(round(float(value or 0) * 10))
    except (TypeError, ValueError):
        return 0


class Collector:
    def __init__(self, args):
        self.args = args
        self.tail = LogTail(args.log)
        self.started = time.monotonic()
        self.latest, self.latest_at = None, 0.0
        self.cpu_max = 0.0
        self.xruns_at_last_hb = None
        self.tracks_played = 0
        self.play_seconds = 0.0
        self.history_read = False       # the history there was at startup has been seen
        self.last_np = None             # (row id, track id, time added) of the newest history row
        self.now_playing = None
        self.last_hb = None
        self.log_lag = None             # seconds between the newest metrics line's "t" and reading it
        self.late_warned = False
        os.makedirs(args.out_dir, exist_ok=True)
        self.jsonl = os.path.join(args.out_dir, "messages.jsonl")
        self.snapshot = os.path.join(args.out_dir, "latest.json")

    # ---- inputs
    def read_metrics(self):
        for line in self.tail.lines():
            m = METRICS_RE.search(line)
            if not m:
                continue
            try:
                metrics = json.loads(m.group(1))
            except ValueError:
                continue
            now = time.monotonic()
            if self.latest and any(d.get("playing") for d in self.latest.get("decks", [])):
                self.play_seconds += min(now - self.latest_at, 2.0)
            if self.latest and (metrics.get("xruns") or 0) < (self.latest.get("xruns") or 0):
                self.xruns_at_last_hb = 0           # counter reset: Mixxx restarted
            self.latest, self.latest_at = metrics, now
            self.cpu_max = max(self.cpu_max, float(metrics.get("latency_usage_pct") or 0))
            self.check_lag(metrics)

    def check_lag(self, metrics):
        """Says once when lines arrive late. Mixxx started without --log-flush-level warning (from the
        desktop menu, say) writes them in bursts when its buffer fills, so mx flickers between 1 and 0."""
        try:
            self.log_lag = round(time.time() - float(metrics["t"]) / 1000, 1)
        except (KeyError, TypeError, ValueError):
            self.log_lag = None
            return
        if self.log_lag > LATE_S and not self.late_warned:
            self.late_warned = True
            print(f"# metrics lines arrive {self.log_lag:.0f} s late: Mixxx is not flushing its log. "
                  "Start it with pi/bin/cranium-mixxx, or run pi/bin/cranium-install to make the "
                  "desktop menu do that.", flush=True)
        elif self.log_lag < 1:
            self.late_warned = False

    def read_now_playing(self):
        if not os.path.exists(self.args.db):
            self.history_read = True    # no database yet, so no old history: every row will be new
            return
        try:
            con = sqlite3.connect(f"file:{self.args.db}?mode=ro", uri=True, timeout=1)
            try:
                row = con.execute(NOW_PLAYING_SQL).fetchone()
            finally:
                con.close()
        except sqlite3.Error as e:
            print(f"(database busy: {e})", flush=True)
            return
        current = row[:3] if row else None
        last, self.last_np = self.last_np, current
        if not self.history_read:                   # first look: don't re-announce old history
            self.history_read = True
            return
        # A new play is a row newer than the last one seen. PlaylistTracks.id has no
        # AUTOINCREMENT, so after the newest row is deleted the next play reuses its id: the
        # same id with another track or time is new too. A smaller id is an older row, shown
        # because newer ones were deleted (Mixxx's history cleanup, or by hand): not a new play.
        if current is None or current == last:
            return
        if last is not None and current[0] < last[0]:
            return
        _, _, _, title, artist, genre, bpm, dur, filename = row
        title = (title or "").strip() or os.path.splitext(filename or "")[0]
        self.tracks_played += 1
        self.now_playing = {"ti": clip(title) or "Untitled", "ar": clip(artist) or "Unknown artist",
                            "ge": clip(genre), "bpm10": x10(bpm), "dur": int(dur or 0)}
        self.emit({"t": "np", **self.now_playing})

    # ---- outputs
    def heartbeat(self):
        now = time.monotonic()
        alive = self.latest is not None and now - self.latest_at < 5
        m = self.latest or {}
        playing = [d for d in m.get("decks", []) if d.get("playing")] if alive else []
        xr = int(m.get("xruns") or 0) if alive else 0
        base = self.xruns_at_last_hb if self.xruns_at_last_hb is not None else xr
        hb = {"t": "hb", "up": int(now - self.started), "mx": int(alive), "pl": len(playing),
              "bpm10": x10(playing[0].get("bpm")) if playing else 0,
              "cpu10": x10(m.get("latency_usage_pct")) if alive else 0,
              "cpux10": x10(self.cpu_max),
              "lat10": x10(m.get("output_latency_ms")) if alive else 0,
              "xr": xr, "xrd": max(0, xr - base), "tp": self.tracks_played,
              "min10": x10(self.play_seconds / 60)}
        self.xruns_at_last_hb = xr
        self.cpu_max = float(m.get("latency_usage_pct") or 0) if alive else 0.0
        self.last_hb = hb
        self.emit(hb)
        self.write_snapshot(alive)

    def emit(self, msg):
        line = json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
        print(line, flush=True)
        with open(self.jsonl, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def write_snapshot(self, alive):
        snap = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "mixxx_metrics_live": alive,
                "heartbeat": self.last_hb, "now_playing": self.now_playing,
                "log_lag_s": self.log_lag if alive else None,
                "raw_metrics": self.latest if alive else None}
        tmp = self.snapshot + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.snapshot)              # readers never see a half-written file

    def run(self):
        print(f"# reading {self.args.log} and {self.args.db}", flush=True)
        print(f"# writing {self.snapshot} and {self.jsonl}  (Ctrl+C to stop)", flush=True)
        next_db = next_hb = time.monotonic()
        while True:
            self.read_metrics()
            now = time.monotonic()
            if now >= next_db:
                self.read_now_playing()
                next_db = now + 2
            if now >= next_hb:
                self.heartbeat()
                next_hb = now + self.args.heartbeat
            time.sleep(0.2)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mixxx-dir", default=os.path.join(HOME, ".mixxx"),
                    help="Mixxx's settings folder, as given to Mixxx's --settings-path (default ~/.mixxx)")
    ap.add_argument("--log", help="Mixxx's log (default MIXXX_DIR/mixxx.log)")
    ap.add_argument("--db", help="Mixxx's database (default MIXXX_DIR/mixxxdb.sqlite)")
    ap.add_argument("--out-dir", default=os.path.join(HOME, ".cranium"))
    ap.add_argument("--heartbeat", type=float, default=10.0, help="seconds between hb messages")
    args = ap.parse_args(argv)
    args.mixxx_dir = os.path.expanduser(args.mixxx_dir)
    args.log = args.log or os.path.join(args.mixxx_dir, "mixxx.log")
    args.db = args.db or os.path.join(args.mixxx_dir, "mixxxdb.sqlite")
    return args


def main():
    try:
        Collector(parse_args()).run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
