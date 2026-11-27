# INFO and USB ratings — NauticMixxx 2.0

Touch INFO in the upper-right corner to show or hide detailed track information.
In PERFORMANCE, the page shows the loaded track from DECK 1 or DECK 2; its deck
buttons choose the track being inspected. Audio and the full deck footer continue
running. The main accelerated waveforms are hidden while INFO is open.
In BROWSE, INFO follows the highlighted row without loading or decoding its audio.

The page displays exported title, artist, album, duration, BPM, key, rating, color,
genre, date added, artwork and comment. Missing fields remain empty. Touch a field,
or turn BROWSER and press it, to use Information Jump. Genre, artist, album, BPM,
key and color reuse the USB browser's existing category groups. The title returns
to the saved track list from which the track was loaded. Tracks without a rekordbox
catalog have limited metadata and no category jumps or USB rating edit.

Select the rating row, hold BROWSER and turn to preview 0–5 stars. Releasing the
encoder saves the rating. The on-screen rating buttons provide the same edit.
Holding the encoder in INFO never enters GRID or navigates the covered page.

## Persistence and compatibility

The official rekordbox EXPORT manual confirms that CUE GRID INFO/Update Collection
returns cues, beat positions and ratings from a device to the original desktop
collection. Tracks exported by another computer, or removed from that collection,
cannot be returned this way. This is a device-to-desktop import, not a live desktop
library update.

This candidate writes the rating field in the connected legacy DeviceSQL
`PIONEER/rekordbox/export.pdb`. It validates the live session, database fingerprint,
track ID and exported audio path, and changes only that track's one-byte rating
field. Pages, IDs, playlists, unknown bytes and ANLZ files are preserved. The update
runs outside the GUI/audio threads, uses atomic replacement, and retains one
recovery copy at `export.pdb.nauticmixxx-rating-backup`. On failure the displayed
rating returns to its saved value and INFO shows the error. Generic audio-tag and
collection writers still cannot modify USB exports.

On sandboxed macOS, select the USB in the system folder dialog to grant read/write
access. Automatic removable-volume discovery retains read-only access. Existing
bookmarks created by earlier read-only candidates may require selecting the USB
again in the new candidate.

Rating write/read/reconnection is verified with isolated synthetic exports and a
copy of a real export, including byte preservation. Importing that edited rating
through desktop CUE GRID INFO still requires an actual rekordbox round-trip check.
This candidate does not add cue/beat-grid ANLZ writeback or Device Library Plus
writing. Those formats require their own preservation and hardware validation.

## Research sources

- [Official rekordbox 7.214 manual, page 52](https://cdn.rekordbox.com/files/20260409151936/rekordbox7.214_manual_EN.pdf): CUE GRID INFO return path and collection association limits.
- [Official rekordbox 6.8 EXPORT manual, page 92](https://cdn.rekordbox.com/files/20231201105226/rekordbox6.8.0_manual_EN.pdf): device updates include cues, grids, colors, ratings and comments; available updates depend on the player.
- [Deep Symmetry DeviceSQL format analysis](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html): track ID at 0x48 and rating at 0x59, with live page/row directories.
- [Holzhaus/rekordcrate writing tests](https://github.com/Holzhaus/rekordcrate/blob/main/tests/test_pdb_write.rs): exported databases can be modified and parsed again, including five-star track ratings.
- [dylanljones/pyrekordbox](https://github.com/dylanljones/pyrekordbox): desktop databases, analysis/settings and Device Library Plus; these do not establish legacy RX3 PDB writeback by themselves.
- [fragmede/rekordbox-pdb fixed-field editor](https://github.com/fragmede/rekordbox-pdb/blob/main/src/rekordbox_pdb/edit.py): independently documents in-place fixed-field editing, preserving bookkeeping for nonstructural edits. This implementation does not bundle or copy that library.
- [ntamas94/pioneered-by-ntamas](https://github.com/ntamas94/pioneered-by-ntamas) and [TeamDeckshark/bitedj](https://github.com/TeamDeckshark/bitedj): existing visual/skin references, not evidence of the rekordbox desktop return path.

## WAVEFORM COLOR

SHORTCUT keeps the original BLUE/RGB/3BAND controls and #007CE0 selection fill.
Each button now contains its corresponding blue, multicolor or white/yellow/blue
sample above the label, drawn natively and scaled with the interface.
