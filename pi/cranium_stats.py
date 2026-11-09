#!/usr/bin/env python3
"""Cranium play-stats dashboard, built from Mixxx's own play history.

Mixxx records every track that becomes audible on the main mix in "History"
playlists (Playlists.hidden = 2) inside ~/.mixxx/mixxxdb.sqlite. This script
reads that database read-only (safe while Mixxx is running) and renders a
self-contained HTML dashboard: top tracks, top artists, genres, BPM, play
time, sessions, and recent plays.

Usage:
  python3 cranium_stats.py                      # writes cranium_dashboard.html
  python3 cranium_stats.py --serve              # live dashboard on http://<pi-ip>:8080
  python3 cranium_stats.py --json               # print stats as JSON (for Memfault/other tools)
  python3 cranium_stats.py --db /path/to/mixxxdb.sqlite

Standard library only, so it runs on the Pi as-is.
"""
import argparse
import html
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_DB = os.path.expanduser("~/.mixxx/mixxxdb.sqlite")
SET_LOG = 2  # PlaylistDAO::PLHT_SET_LOG: Mixxx's play-history playlists

PLAYS_SQL = """
SELECT pt.playlist_id, p.name, pt.pl_datetime_added,
       l.id, COALESCE(NULLIF(TRIM(l.artist), ''), 'Unknown artist'),
       COALESCE(NULLIF(TRIM(l.title), ''), 'Untitled'),
       COALESCE(l.album, ''), COALESCE(NULLIF(TRIM(l.genre), ''), 'Unknown'),
       l.bpm, l.key, l.duration
FROM PlaylistTracks pt
JOIN Playlists p ON p.id = pt.playlist_id
JOIN library   l ON l.id = pt.track_id
WHERE p.hidden = ? AND pt.pl_datetime_added IS NOT NULL
ORDER BY pt.pl_datetime_added, pt.position
"""


def parse_utc(s):
    # SQLite CURRENT_TIMESTAMP is UTC: "YYYY-MM-DD HH:MM:SS"
    try:
        return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def load_plays(db_path):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        rows = con.execute(PLAYS_SQL, (SET_LOG,)).fetchall()
    finally:
        con.close()
    plays = []
    for (pl_id, pl_name, ts, tid, artist, title, album, genre, bpm, key, dur) in rows:
        t = parse_utc(ts)
        if t is None:
            continue
        plays.append(dict(session=pl_id, session_name=pl_name, at=t.astimezone(),
                          track_id=tid, artist=artist, title=title, album=album,
                          genre=genre, bpm=bpm or 0.0, key=key or "", duration=float(dur or 0)))
    # Mixxx stores when a track became the main audible track, not how long it
    # played. Estimate play time as the gap to the next play in the same
    # session, capped at the track's length.
    by_session = defaultdict(list)
    for p in plays:
        by_session[p["session"]].append(p)
    for items in by_session.values():
        for cur, nxt in zip(items, items[1:] + [None]):
            dur = cur["duration"] if cur["duration"] > 0 else 240.0
            gap = (nxt["at"] - cur["at"]).total_seconds() if nxt else dur
            cur["played_s"] = max(0.0, min(gap, dur))
    return plays


def compute_stats(plays):
    tracks = Counter()
    track_time = Counter()
    artist_plays = Counter()
    artist_time = Counter()
    genres = Counter()
    hours = Counter()
    bpm_bins = Counter()
    sessions = defaultdict(lambda: {"plays": 0, "seconds": 0.0, "start": None, "artists": set()})
    for p in plays:
        tkey = (p["title"], p["artist"])
        tracks[tkey] += 1
        track_time[tkey] += p["played_s"]
        artist_plays[p["artist"]] += 1
        artist_time[p["artist"]] += p["played_s"]
        genres[p["genre"]] += 1
        hours[p["at"].hour] += 1
        if p["bpm"] > 0:
            bpm_bins[int(p["bpm"] // 5 * 5)] += 1
        s = sessions[p["session"]]
        s["plays"] += 1
        s["seconds"] += p["played_s"]
        s["start"] = s["start"] or p["at"]
        s["artists"].add(p["artist"])
        s["name"] = p["session_name"]
    bpms = [p["bpm"] for p in plays if p["bpm"] > 0]
    total_s = sum(p["played_s"] for p in plays)
    return {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "totals": {
            "plays": len(plays),
            "minutes": round(total_s / 60),
            "unique_tracks": len(tracks),
            "unique_artists": len(artist_plays),
            "sessions": len(sessions),
            "avg_bpm": round(sum(bpms) / len(bpms), 1) if bpms else None,
        },
        "top_tracks": [{"title": t, "artist": a, "plays": n, "minutes": round(track_time[(t, a)] / 60, 1)}
                       for (t, a), n in tracks.most_common(10)],
        "top_artists": [{"artist": a, "minutes": round(s / 60, 1), "plays": artist_plays[a]}
                        for a, s in artist_time.most_common(10)],
        "top_genres": [{"genre": g, "plays": n} for g, n in genres.most_common(8)],
        "plays_by_hour": [hours.get(h, 0) for h in range(24)],
        "bpm_histogram": [{"bpm": b, "plays": bpm_bins[b]} for b in sorted(bpm_bins)],
        "sessions": [{"name": s["name"], "start": s["start"].strftime("%a %b %d, %H:%M"),
                      "plays": s["plays"], "minutes": round(s["seconds"] / 60),
                      "artists": len(s["artists"])}
                     for s in sorted(sessions.values(), key=lambda s: s["start"], reverse=True)[:8]],
        "recent": [{"title": p["title"], "artist": p["artist"], "at": p["at"].strftime("%b %d, %H:%M"),
                    "bpm": round(p["bpm"]) if p["bpm"] else None}
                   for p in reversed(plays[-12:])],
    }


def fmt_minutes(m):
    return f"{m // 60}h {m % 60}m" if m >= 60 else f"{m}m"


def bar_rows(items, label, value, unit, sub=None):
    if not items:
        return '<p class="empty">No plays yet. Play a few tracks in Mixxx.</p>'
    top = max(value(i) for i in items) or 1
    out = []
    for n, i in enumerate(items, 1):
        pct = 100 * value(i) / top
        subtxt = f'<span class="sub">{html.escape(sub(i))}</span>' if sub else ""
        out.append(
            f'<div class="row"><span class="rank">{n}</span>'
            f'<div class="lbl"><span class="name">{html.escape(label(i))}</span>{subtxt}'
            f'<div class="bar"><div style="width:{pct:.1f}%"></div></div></div>'
            f'<span class="val">{value(i):g} {unit if value(i) != 1 else unit.rstrip("s")}</span></div>')
    return "\n".join(out)


def render_html(stats, refresh_s=None):
    t = stats["totals"]
    hours = stats["plays_by_hour"]
    hmax = max(hours) or 1
    hour_cols = "".join(
        f'<div class="hcol" title="{h}:00, {v} plays"><div style="height:{100 * v / hmax:.0f}%"></div>'
        f'<span>{h if h % 6 == 0 else ""}</span></div>' for h, v in enumerate(hours))
    bh = stats["bpm_histogram"]
    bmax = max((b["plays"] for b in bh), default=1)
    bpm_cols = "".join(
        f'<div class="hcol" title="{b["bpm"]}-{b["bpm"] + 4} BPM, {b["plays"]} plays">'
        f'<div style="height:{100 * b["plays"] / bmax:.0f}%"></div><span>{b["bpm"]}</span></div>' for b in bh) \
        or '<p class="empty">No BPM data yet.</p>'
    sessions = "".join(
        f'<tr><td>{html.escape(s["name"] or "")}</td><td>{s["start"]}</td>'
        f'<td>{s["plays"]}</td><td>{fmt_minutes(s["minutes"])}</td><td>{s["artists"]}</td></tr>'
        for s in stats["sessions"]) or '<tr><td colspan="5" class="empty">No sessions yet.</td></tr>'
    recent = "".join(
        f'<li><div><span class="name">{html.escape(r["title"])}</span>'
        f'<span class="sub">{html.escape(r["artist"])}</span></div>'
        f'<span class="meta">{r["at"]}{" · " + str(r["bpm"]) + " BPM" if r["bpm"] else ""}</span></li>'
        for r in stats["recent"]) or '<li class="empty">Nothing played yet.</li>'
    now = stats["recent"][0] if stats["recent"] else None
    now_html = (f'<div class="now"><span class="tag">Last played</span>'
                f'<span class="name big">{html.escape(now["title"])}</span>'
                f'<span class="sub">{html.escape(now["artist"])} · {now["at"]}</span></div>') if now else ""
    tiles = [("Tracks played", t["plays"]), ("Time played", fmt_minutes(t["minutes"])),
             ("Unique tracks", t["unique_tracks"]), ("Artists", t["unique_artists"]),
             ("Sets", t["sessions"]), ("Average BPM", t["avg_bpm"] or "–")]
    tiles_html = "".join(f'<div class="tile"><span class="sub">{k}</span><span class="num">{v}</span></div>'
                         for k, v in tiles)
    meta_refresh = f'<meta http-equiv="refresh" content="{refresh_s}">' if refresh_s else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">{meta_refresh}
<title>Cranium Stats</title>
<style>
:root {{ --bg:#101213; --card:#1a1d1f; --line:#2a2e31; --text:#f2f2ef; --muted:#9aa09d; --accent:#3ddc84; --accent-dim:#1f6e44; }}
@media (prefers-color-scheme: light) {{ :root {{ --bg:#f4f4f1; --card:#ffffff; --line:#e3e3de; --text:#151716; --muted:#61665f; --accent:#11994f; --accent-dim:#bfe8cf; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }}
main {{ max-width:1180px; margin:0 auto; padding:28px 16px 48px; }}
header {{ display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin-bottom:20px; }}
h1 {{ margin:0; font-size:30px; font-weight:650; letter-spacing:-0.02em; }}
h2 {{ margin:0 0 14px; font-size:16px; font-weight:600; }}
.sub, .meta, .gen {{ color:var(--muted); font-size:13px; }}
.now {{ display:flex; flex-direction:column; text-align:right; }}
.tag {{ color:var(--accent); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; }}
.big {{ font-size:18px; font-weight:600; }}
.tiles {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:16px; }}
.tile {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; }}
.num {{ font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr)); gap:16px; align-items:start; }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; min-width:0; }}
.row {{ display:grid; grid-template-columns:22px minmax(0,1fr) auto; gap:10px; align-items:center; padding:6px 0; }}
.rank {{ color:var(--muted); font-variant-numeric:tabular-nums; text-align:right; }}
.lbl {{ min-width:0; }}
.name {{ display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }}
.lbl .sub {{ display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }}
.bar {{ height:4px; background:var(--line); border-radius:2px; margin-top:5px; }}
.bar div {{ height:100%; background:var(--accent); border-radius:2px; }}
.val {{ color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; white-space:nowrap; }}
.hist {{ display:flex; align-items:flex-end; gap:3px; height:150px; padding-bottom:18px; }}
.hcol {{ flex:1; height:100%; display:flex; flex-direction:column; justify-content:flex-end; position:relative; min-width:0; }}
.hcol div {{ background:var(--accent); border-radius:3px 3px 0 0; min-height:2px; }}
.hcol span {{ position:absolute; bottom:-18px; left:50%; transform:translateX(-50%); font-size:11px; color:var(--muted); }}
table {{ width:100%; border-collapse:collapse; font-size:14px; }}
th {{ text-align:left; color:var(--muted); font-weight:500; font-size:12px; padding:0 8px 8px 0; }}
td {{ padding:7px 8px 7px 0; border-top:1px solid var(--line); font-variant-numeric:tabular-nums; }}
ul {{ list-style:none; margin:0; padding:0; }}
li {{ display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid var(--line); }}
li:first-child {{ border-top:0; }}
li > div {{ min-width:0; }}
li .meta {{ white-space:nowrap; }}
.empty {{ color:var(--muted); }}
.wide {{ grid-column:1/-1; }}
.note {{ color:var(--muted); font-size:12px; margin-top:20px; }}
@media (max-width:640px) {{ .now {{ text-align:left; }} .tablewrap {{ overflow-x:auto; }} }}
</style></head><body><main>
<header><div><h1>Cranium stats</h1><span class="gen">Updated {stats["generated_at"].replace("T", " ")[:16]}</span></div>{now_html}</header>
<section class="tiles">{tiles_html}</section>
<section class="grid">
  <div class="card"><h2>Top tracks</h2>{bar_rows(stats["top_tracks"], lambda i: i["title"], lambda i: i["plays"], "plays", lambda i: i["artist"])}</div>
  <div class="card"><h2>Top artists</h2>{bar_rows(stats["top_artists"], lambda i: i["artist"], lambda i: i["minutes"], "min", lambda i: f'{i["plays"]} play' + ('s' if i["plays"] != 1 else ''))}</div>
  <div class="card"><h2>Top genres</h2>{bar_rows(stats["top_genres"], lambda i: i["genre"], lambda i: i["plays"], "plays")}</div>
  <div class="card"><h2>Recently played</h2><ul>{recent}</ul></div>
  <div class="card"><h2>When you play</h2><div class="hist">{hour_cols}</div><span class="sub">Plays by hour of day</span></div>
  <div class="card"><h2>Tempo</h2><div class="hist">{bpm_cols}</div><span class="sub">Plays by BPM (5 BPM buckets)</span></div>
  <div class="card wide"><h2>Recent sets</h2><div class="tablewrap"><table>
    <tr><th>Set</th><th>Started</th><th>Tracks</th><th>Time</th><th>Artists</th></tr>{sessions}</table></div></div>
</section>
<p class="note">Source: Mixxx play history. Play time is estimated from when each track became the main track, capped at its length.</p>
</main></body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB, help=f"Mixxx database (default {DEFAULT_DB})")
    ap.add_argument("--out", default="cranium_dashboard.html", help="HTML output path")
    ap.add_argument("--json", action="store_true", help="print stats as JSON instead of HTML")
    ap.add_argument("--serve", action="store_true", help="serve a live dashboard")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--refresh", type=int, default=15, help="browser refresh seconds in --serve mode")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"Mixxx database not found: {args.db}\nRun Mixxx once, or pass --db.")

    if args.json:
        print(json.dumps(compute_stats(load_plays(args.db)), indent=2, default=str))
        return

    if args.serve:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                try:
                    stats = compute_stats(load_plays(args.db))
                    if self.path.startswith("/stats.json"):
                        body, ctype = json.dumps(stats, default=str).encode(), "application/json"
                    else:
                        body, ctype = render_html(stats, args.refresh).encode(), "text/html; charset=utf-8"
                    self.send_response(200)
                except sqlite3.Error as e:
                    body, ctype = f"Database busy or unreadable: {e}".encode(), "text/plain"
                    self.send_response(503)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        print(f"Serving on http://0.0.0.0:{args.port}  (JSON at /stats.json)")
        ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
        return

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(render_html(compute_stats(load_plays(args.db))))
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()