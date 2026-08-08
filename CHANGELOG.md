# Changelog

## 1.1.0 — 2026-08-08

- Added Auto Crisp, which selects native, 2×, or 3× output from the crop size.
- Replaced bicubic plus unconstrained sharpening with local-range-clamped Catmull-Rom enlargement.
- Eliminated new per-channel edge extrema from the enlargement pipeline.
- Reduced scaling scratch memory to four cached source and horizontal scanlines.
- Added regression tests for Auto Crisp boundaries, flat colors, and channel halos.

## 1.0.0 — 2026-08-08

- Initial public release.
- Added native-pixel region capture with `Win + Shift + D`.
- Added Native 1×, Crisp 2×, and Ultra 3× output modes.
- Added lossless PNG clipboard and automatic-save support.
- Added silent per-user startup and tray controls.
- Added Per-Monitor V2 DPI support and multi-monitor capture.
- Added pixel-alignment regression coverage for 125% display scaling.
