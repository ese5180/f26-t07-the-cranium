# Saved Cranium native changes

The original 44 NauticMixxx patches remain in the upstream `patches/` folder.
Future native changes are retained here as `0099-cranium-native.patch`, an
aggregate diff against the prepared engine's `cranium/nautic-2.0.0-base` tag.

Commit edits in the sibling `cranium-nauticmixxx-engine` repository, run
`python3 cranium/export-engine-patch.py` from the overlay repository, then commit
the resulting patch here. Fresh source preparation applies it after the pinned
NauticMixxx baseline. Layout/controller edits in this overlay need no engine patch.
