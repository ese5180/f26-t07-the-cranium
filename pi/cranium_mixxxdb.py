"""Mixxx's play history, read from its database (mixxxdb.sqlite): the one place for its queries,
used by cranium_collect.py and cranium_stats.py. Standard library only.

Mixxx records each track that becomes the main audible track in a "History" playlist, a Playlists
row with hidden = 2 (PlaylistDAO::PLHT_SET_LOG), one playlist per session. The database is opened
read only, which is safe while Mixxx runs. PlaylistTracks.id is INTEGER PRIMARY KEY without
AUTOINCREMENT: ids are in the order rows were added, but the id of a deleted newest row is used again.
"""
import collections
import os
import sqlite3

SET_LOG = 2

Play = collections.namedtuple("Play", "id session session_name track_id added position title artist "
                                      "album genre bpm key duration filename")

_SELECT = f"""
SELECT pt.id, pt.playlist_id, p.name, pt.track_id, pt.pl_datetime_added, pt.position,
       l.title, l.artist, l.album, l.genre, l.bpm, l.key, l.duration, tl.filename
FROM PlaylistTracks pt
JOIN Playlists p ON p.id = pt.playlist_id
JOIN library   l ON l.id = pt.track_id
LEFT JOIN track_locations tl ON tl.id = l.location
WHERE p.hidden = {SET_LOG}
"""

# The newest play: by id, the order the rows were added.
NEWEST_SQL = _SELECT + "ORDER BY pt.id DESC LIMIT 1"

# Every play with a time, in the order they were played.
ALL_SQL = _SELECT + "AND pt.pl_datetime_added IS NOT NULL ORDER BY pt.pl_datetime_added, pt.position, pt.id"


def connect(db, timeout=1.0):
    """Read only. Raises sqlite3.Error if the file cannot be opened."""
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=timeout)


def newest_play(con):
    row = con.execute(NEWEST_SQL).fetchone()
    return Play(*row) if row else None


def all_plays(con):
    return [Play(*row) for row in con.execute(ALL_SQL)]


def title_of(play):
    """The title, or for an untagged track its file name without the extension, or ""."""
    return (play.title or "").strip() or os.path.splitext(play.filename or "")[0]
