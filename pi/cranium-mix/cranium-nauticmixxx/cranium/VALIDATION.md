# Editable source preparation — November 8, 2026

- Pinned NauticMixxx 2.0.0 overlay: `c73631bafbc7150587cf9de0c32437531d295103`.
- Pinned Mixxx 2.5.6 engine: `3ebac449e7e5fe2a0186596657696e87ce8b0e56`.
- All 44 native patches passed application checks and applied successfully.
- Linux icon/resource preparation completed with Pillow 12.0.0 in a project venv.
- Full native source committed as `bc25f0f` and tagged `cranium/nautic-2.0.0-base`.
- Re-running the preparation helper retained the prepared source unchanged.
- An isolated temporary Git fixture verified that export/replay retains both a
  modified C++ file and a newly added native header. No fake feature patch or
  fixture was saved into the development repositories.
- The upstream release validator passed public-input audit, Windows input/skin
  packaging contracts, 10/10 USB-only source contracts, skin/mapping/effects XML,
  controller script suites and FLX4 full-preset/browser checks.
- The Linux package fixture passed isolated-profile preservation and identity
  checks. This uses fixture executables; it is not a native application launch.
- Python compilation, shell syntax and Git whitespace checks passed.

No NauticMixxx C++ binary was compiled in this setup turn. The validator explicitly
reported that native tests were not compiled/executed. No 800×480 interface
adaptation, NauticMixxx card installation, Pi rendering, controller/audio routing,
recording or sustained playback result is claimed. Native build/mount/deployment
steps are documented in `README.md` for the next trial.

Source preparation and validation logs are in the sibling `nauticmixxx-build`
directory. No music USB data, databases, personal profiles or credentials were
included in these source repositories.
