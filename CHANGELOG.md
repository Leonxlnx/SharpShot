# Changelog

## SharpShot Studio 0.2.0-alpha.1 — Unreleased

- Added the first Windows-only Studio shell while preserving SharpShot Native as
  the small standalone capture utility.
- Added a sandboxed Electron main/preload/renderer architecture with local
  settings, launch-at-login support, close-to-tray behavior, a lazily created
  editor window, and a native capture helper.
- Added persistent screenshot and video workflows with multiple global
  shortcut bindings, collision validation, and explicit registration status.
- Added native one-shot screenshot and recording commands with atomic result
  files, same-shortcut recording stop, Windows file clipboard support, recorded
  click data, and optional system-audio/microphone sidecars.
- Added a local media index, safe media protocol, imports, capture
  reconciliation, versioned project JSON, delayed autosave, and project
  validation.
- Added a coherent dark tactile editor using normal inline SVG icons, responsive
  shell and inspector layouts, and direct video move, resize, and non-destructive
  crop controls with preview/export parity.
- Reworked the app navigation and Studio tool rail around a dark cobalt identity,
  removed nested selected tiles and side stripes, raised small-text contrast,
  and added a short reduced-motion-aware startup reveal using the real app icon.
- Added persisted manual zooms, direct focus placement, a zoom timeline, and
  bounded click-generated auto zoom for Video-to-Studio recordings.
- Added persisted manual/SRT/VTT captions with output-canvas preview, safe
  content-relative retiming, and MP4/GIF caption burn-in.
- Added a persisted music timeline with three bundled CC0 tracks or local audio
  import, trim/split, fades, gain, mute, embedded-source volume, and
  export-accurate ducking. Separately captured WAV stems remain unattached.
- Added local MP4 and GIF export planning and rendering with progress,
  cancellation, media probing, collision-safe output finalization, zoom and
  captions, and timed opaque redactions; MP4 additionally renders the editor
  audio mix.
- Added up to 64 timed opaque redaction rectangles with direct preview
  move/resize, timeline trimming, persistence, black/dark/white presets, and
  MP4/GIF burn-in. Unsupported overlay types fail export instead of disappearing.
- Reduced renderer/package weight by serving full background masters through the
  trusted local media protocol while bundling only thumbnails, removing more than
  13 MB of duplicate assets.
- Stabilized renderer subscriptions, batched startup media reconciliation, paged
  large libraries, capped long-project timeline ticks, cached gesture geometry,
  and preserved audio state during visual-only edits.
- Added a pinned, hash-restorable Windows x64 FFmpeg shared runtime with
  per-file hashes, license texts, provenance records, and package verification.
  Full public distribution remains blocked until the incorporated dependency
  inventory and corresponding-source review are complete.
- Added eight original SharpShot backgrounds, including four center-safe 4K
  masters, an original application icon, a normal inline SVG interface-icon
  system, and three clearly inventoried CC0 music tracks.
- Added four unmodified 4K cinematic landscapes from Budgie Backgrounds v3.0
  under CC0-1.0, with pinned source provenance, hashes, a shipped license, and
  lightweight picker thumbnails.
- Added local background import and an external link to official Apple wallpaper
  guidance. Apple artwork is intentionally not bundled, copied, cached, or
  hotlinked.
- Documented the unsigned-alpha warning and the deliberately unfinished status
  of other annotation types, editable cursor replacement, automatic
  transcription, separate-stem mixing, cloud, collaboration, AI generation,
  webcam, and macOS support.
- Added planned Full Studio installer/portable and Quick Capture artifacts,
  exact release manifests/checksums, production-only package allowlists, legal
  notice verification, a compliance-gated Full draft workflow, and an
  independently verified Quick draft workflow. These artifacts are not yet
  claims about files published on GitHub Releases.

## 1.5.0 — 2026-08-09

- Replaced the full-area magenta transparency-key countdown with a small opaque neutral surface, eliminating pink flashes and reducing redraw work.
- Refined the recording controller into a smaller, calmer pill with a clear square Stop action, instant press feedback, and redraws only when its visible state changes.
- Added a Direct3D 11 device manager to the hardware Media Foundation path so color conversion and H.264 encoding stay on the GPU/video stack when Windows supports it, with the existing software fallback intact.
- Replaced per-frame GDI screen copies with DXGI Desktop Duplication for normal single-monitor regions and GPU-crop only the selected rectangle; unsupported, rotated, cross-monitor, or multi-adapter cases fall back to GDI automatically.
- Removed that remaining readback from the normal path: Desktop Duplication and Media Foundation now share one D3D11 device and pass tracked DXGI surfaces directly to the hardware encoder, eliminating both full-frame CPU copies and the re-upload.
- Added a bounded encoder-recycled surface pool (four surfaces at 60 FPS, three at 30 FPS); when all surfaces are busy, the recorder drops a frame instead of stalling the foreground renderer.
- Lowered only the recorder worker and its shared GPU device to background priority so an already-busy browser or game wins scheduling contention.
- Extended the direct GPU-surface path down to 640 × 360, cutting measured frame work by 56–79% at common small recording sizes while keeping a lightweight software encoder for truly tiny regions.
- Reused the last crop for pointer-only DXGI updates and limited cursor synchronization to its clipped overlap with the selected region.
- Reduced high-resolution capture pressure by using 60 FPS through 1280 × 720 and an efficient 30 FPS above it while preserving native selected pixels and proportional per-frame bitrate.
- Replaced active spin-based frame pacing with Windows high-resolution waitable timers, retaining the old bounded fallback only on systems without that timer support.

## 1.4.0 — 2026-08-09

- Added native H.264 MP4 area recording on `Win + Shift + A` with a three-second countdown.
- Added a compact, capture-excluded recording controller with an immediate Stop action; pressing the recording shortcut again also stops.
- Added a no-poll, exact-chord compatibility hook so the requested `Win + Shift + A` works even though current Windows builds reserve it for Windows tips.
- Record at native pixels and up to 60 FPS with Windows Media Foundation hardware transforms when available and a software fallback.
- Select the lightweight software encoder through 854 × 480 and the hardware-enabled path above it, with two-way compatibility fallback and one lazy process-wide Media Foundation runtime.
- Keep capture latency bounded by skipping late frame times instead of queueing stale frames or growing memory.
- Include the pointer, finalize every recording through a temporary file, save it automatically, and copy the finished MP4 as a persistent file-drop clipboard item.
- Added clearer, sortable screenshot and recording filenames with capture type, local time, and dimensions.

## 1.3.1 — 2026-08-09

- Made selection-sized clipboard PNGs the default so tiny captures stay visually small when pasted into chats and browsers that ignore DPI metadata.
- Kept Auto Crisp XXL for the separately auto-saved lossless PNG, preserving the high-resolution asset without inflating its pasted display size.
- Added one explicit tray toggle for full-resolution pasting when raw enlarged dimensions are desired.
- Flush the compact clipboard copy before enlargement and skip enlargement entirely when both chat-sized paste and auto-save-off are selected.
- Updated the live selection badge and completion notification to show clipboard and saved dimensions separately.

## 1.3.0 — 2026-08-09

- Extended Auto Crisp to every whole-number scale from 2× through 12×, eliminating large quality cliffs between fixed tiers.
- Kept 3×–12× automatic output within the fast 4-megapixel/4096-pixel budget.
- Added a separate 8.5-megapixel 2× budget so a normal 1920 × 1080 region can become a 4K image.
- Preserved exact Native 1× pixels instead of applying destructive cosmetic sharpening.
- Moved opaque desktop crops and enlarged outputs to a 24-bit RGB path, removing one quarter of interpolation work and raw pixel memory.
- Added deterministic parallel reconstruction for large outputs using at most four short-lived workers and four cached scanlines per worker.
- Removed the hotkey's timer-tick dispatch delay by posting capture directly through the Windows message queue.
- Added 12× DPI/extrema, adaptive-boundary, symmetry, 24-bit PNG, and opaque ownership regression coverage.

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
