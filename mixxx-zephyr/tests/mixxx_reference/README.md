# Mixxx reference sources

Unmodified files from Mixxx (GPL-2.0-or-later), commit
`2f4234b03fe481e8971b6c6c9458abe6b0bdffc3` (`main`, 2026-10-24):

| File | From |
| --- | --- |
| `engine/enginexfader.cpp`, `engine/enginexfader.h` | `src/engine/` |
| `util/alphabetafilter.h` | `src/util/` |

The tests compile them next to the port and check that both give the same
numbers. `util/math.h` and `util/types.h` here are small stand-ins for the Mixxx
headers of the same name, which pull in Qt.
