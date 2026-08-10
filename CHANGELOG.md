# Changelog

## 1.5.0 — 2026-08-09

- Added native H.264 screen-area recording with `Win + Shift + A`, same-shortcut stop, pointer capture, clipboard file copy, and safe MP4 finalization.
- Added a compact countdown and recording controller with selection/countdown cancellation through `Esc`.
- Added a Direct3D 11 and DXGI Desktop Duplication fast path with Media Foundation hardware encoding and automatic software/GDI fallbacks.
- Added bounded recycled GPU surfaces, frame dropping instead of capture stalls, background worker priority, and high-resolution waitable-timer pacing.
- Tuned capture for 60 FPS through 1280 × 720 and efficient 30 FPS above it while keeping the selected region at native resolution.
- Kept the application dependency-free, local-only, and FFmpeg-free.

## 1.2.0 — 2026-08-09

- Added Max 6× enlargement for micro-crops.
- Extended Auto Crisp to choose from 6×, 3×, 2×, and native output.
- Added a 4-megapixel and 4096-pixel automatic-enlargement budget for predictable speed and memory use.
- Added safe 6× downgrade handling under the existing 16-megapixel manual output cap.
- Removed redundant native-crop, clipboard-bitmap, and encoded-PNG copies from the capture pipeline.
- Replaced per-channel rounding calls and a redundant row clear with pixel-identical inline work.
- Added 6× dimension, DPI, extrema, threshold, and downgrade regression tests.

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
