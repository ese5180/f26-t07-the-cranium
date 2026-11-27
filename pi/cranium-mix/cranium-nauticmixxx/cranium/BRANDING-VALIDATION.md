# CRANIUM startup branding — 2026-11-09

The startup splash and the empty-deck background now use a white, widely
spaced CRANIUM wordmark on black. The asset is an outlined SVG generated
from the bundled Open Sans Regular font, with no runtime font dependency.
The existing progress-bar style was compared byte-for-byte and is unchanged.
Its animation/progress mechanism is unchanged. Custom startup artwork now
also takes precedence over the engine's seasonal default splash.

The real Qt LaunchImage widget was rendered at 800×480 and 1280×800 with
progress set to 48%; the CRANIUM mark and existing progress bar were checked.
Captures are in `nauticmixxx-build/cranium-startup-800x480.png` and
`nauticmixxx-build/cranium-startup-1280x800.png`.

- ARM64 native suite: 188 passed, 10 optional fixture/render checks skipped.
- Source validation passed, including the empty-logo layout/visibility checks.
- Engine source: `1466ea6f494019b8fa848d0c83e194009cc3de33`.
- Overlay/package source: `d484210ed1e99d4a44fcb97ce0c7ca45c19d2cc1`.
- Archive: `nauticmixxx-build/bundle-cranium-branding/nauticmixxx-arm64-bookworm.tar.gz`.
- SHA-256: `770470aa9adf2394273330749dd286273acda5c72b878fb6c8788192ca18789e`.
- Archive checksum and startup/idle SVG references verified. Preview tools are
  outside the shipped app. Prior pinch, playback-guard and USB fixes remain.
- The verified update is staged on the identified Pi SD card. It replaces
  the still-pending pinch package, preserving the original normal boot
  command and including both pinch controls and CRANIUM branding in one boot.
  Evidence: `nauticmixxx-build/evidence/20261109T192257Z/`.
  On-device installation occurs on the next Pi boot.

The artwork generator and font attribution are in `cranium/branding/`.
Upstream copyright, source authors and license files remain present.
