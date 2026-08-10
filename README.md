# SharpShot

[![Build](https://github.com/Leonxlnx/SharpShot/actions/workflows/build.yml/badge.svg)](https://github.com/Leonxlnx/SharpShot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-20252b.svg)](LICENSE)

SharpShot is a small Windows region-capture utility for fast, clean screenshots and screen recordings.

Press **Win + Shift + D**, drag a rectangle, and release. SharpShot copies a chat-sized lossless PNG that keeps the selection's original dimensions. With auto-save enabled, it separately saves the Auto Crisp XXL version to `Pictures\SharpShot`.

Press **Win + Shift + A**, select an area, and SharpShot counts down `3, 2, 1` before recording a native-pixel H.264 MP4. Press the shortcut again or click the floating **Stop** control to finalize, save, and copy the video as a pasteable file.

## Planned downloads

The 0.2.0-alpha.1 Studio and 1.5.0 Quick artifacts below are planned names, not
claims about what is already published on GitHub Releases:

| Planned artifact | Current release status |
| --- | --- |
| **Full installer — recommended for local Studio testing** (`SharpShot-Studio-Setup-0.2.0-alpha.1-win-x64.exe`) | Locally packageable; public release is blocked by the FFmpeg compliance gate |
| **Full portable** (`SharpShot-Studio-0.2.0-alpha.1-win-x64.zip`) | Locally packageable; public release is blocked by the same gate |
| **Quick Capture** (`SharpShot-Quick-1.5.0-win-x64.zip`) | Contains no FFmpeg runtime and is independently eligible for a verified prerelease |

Check [GitHub Releases](https://github.com/Leonxlnx/SharpShot/releases) for
artifacts that have actually been published. The Full names above must not be
published while the bundled FFmpeg manifest is
`blocked-incomplete-third-party-inventory`.
**Never run Full Studio and Quick Capture simultaneously:** both own the same
global shortcuts, and Windows can register each chord to only one process.

These planned builds are not code-signed. Windows can show **Unknown publisher** or a
Microsoft Defender SmartScreen warning; this is not bypassed. Verify the
published `SHA256SUMS.txt`, or inspect the [source](https://github.com/Leonxlnx/SharpShot)
and [MIT license](LICENSE) before running it.

## Native capture and Studio

The repository now contains two deliberately different Windows experiences:

| Experience | Best for | Runtime model |
| --- | --- | --- |
| **SharpShot Quick 1.5** | The fastest screenshot or quick recording with the smallest idle footprint | Portable .NET Framework tray app; blocks in the Windows message loop while idle |
| **SharpShot Studio 0.2.0-alpha.1** | Configurable capture workflows, a local library, projects, editing, and export | Electron main/tray process with a native capture helper; the Chromium editor window is created only when opened and destroyed when closed |

The native app remains the stable, always-ready utility documented below. Studio
is a local development alpha under [`desktop/`](desktop/README.md); no current
Full binary is authorized for public distribution. Its capture path
still delegates to the native Windows helper rather than recording through a
browser API. Do not run Native and Studio at the same time with the same global
shortcuts; Windows can register a chord to only one process.

### Studio alpha status

| Area | Current status |
| --- | --- |
| Area screenshot and quick video | Connected to the native selector/recorder; save and clipboard completion are local |
| Shortcut workflows | Persistent screenshot/video recipes and multiple global shortcut bindings; conflicts are reported instead of silently replaced |
| Local library and projects | Local media index, JSON project persistence, autosave, and safe media URLs are implemented; the renderer integration is still alpha |
| Core editing | Non-destructive trim, split, delete/ripple-delete, reorder, speed, direct move/resize/crop, canvas/background/frame controls, and bounded undo/redo are implemented |
| Zoom and captions | Persisted manual zoom, click-generated auto zoom, direct focus control, SRT/VTT import, caption editing, timeline lanes, and MP4/GIF caption burn-in are implemented |
| Audio | Embedded-source volume plus a persisted music lane with bundled CC0 or imported tracks, trim/split/fades/gain/mute, source ducking, and MP4 mixing are implemented; separately captured WAV stems are not attached automatically |
| Export | Local MP4 and GIF rendering through the bundled FFmpeg runtime to a user-selected destination, including zoom and captions; MP4 also supports the editor audio mix |
| Cursor and Redact | When enabled, the cursor is burned into the captured video. Redact supports up to 64 timed opaque black, dark, or white rectangles with direct preview move/resize, timeline trimming, persistence, and MP4/GIF burn-in. Editable cursor replacement, blur/pixelation, and other annotation types are not shipped |
| Cloud, collaboration, AI, webcam, macOS | Not included in this alpha |

Studio includes eight original backgrounds, four additional 4K CC0 cinematic
landscapes, an original app icon, normal inline SVG action icons, and three
CC0 starter music tracks. Apple wallpaper artwork is **not**
bundled or hotlinked: Studio can open Apple's wallpaper guidance in the default
browser and can import a local image that the user has the right to use. See
[`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md) for current asset provenance,
runtime notices, and the explicit Full-distribution compliance block.

### Where files go

- Quick Capture saves screenshots and recordings under `Pictures\SharpShot`.
- Studio screenshots default to `Pictures\SharpShot Studio\Screenshots`.
- Studio recordings default to `Videos\SharpShot Studio\Recordings`.
- Studio's export dialog starts in `Videos\SharpShot Studio\Exports`, but you can choose another local destination.

Studio exposes the three default output folders in **Settings → Output folders**.

## Why SharpShot Native?

- Native physical-pixel capture with Per-Monitor V2 DPI awareness
- Lossless PNG encoding; no JPEG conversion
- Auto Crisp XXL chooses the densest whole-number scale from 2× through 12×, or exact native output
- Local-range-clamped enlargement keeps UI edges clean without sharpening halos
- Chat-sized paste keeps tiny captures visually tiny instead of exposing their enlarged pixel dimensions
- Global `Win + Shift + D` shortcut
- Global `Win + Shift + A` area-recording shortcut
- Native H.264 MP4 recording at 60 FPS through 720p and an efficient 30 FPS above it
- GPU-based Desktop Duplication capture, compact capture-excluded Stop control, and bounded-latency frame scheduling
- Multi-monitor and negative-origin desktop support
- Clipboard formats for modern apps and legacy bitmap consumers
- Silent start at Windows sign-in
- No installer, administrator rights, network access, telemetry, service, polling loop, or watchdog

Microsoft's current Windows shortcut reference does not list `Win + Shift + D` as a default shortcut, but it does assign `Win + Shift + A` to focusing a Windows tip when one is available. SharpShot first tries the normal Windows hotkey registration. When Windows reserves the recording chord, SharpShot falls back to a narrowly scoped event hook that recognizes and suppresses only the exact `Win + Shift + A` chord while SharpShot is running. It does not log or store keyboard input and does not poll. Another installed application or OEM utility can still create a conflict. See [Microsoft's Windows shortcut reference](https://support.microsoft.com/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec).

## Install Quick Capture

1. When `SharpShot-Quick-1.5.0-win-x64.zip` is listed on [Releases](https://github.com/Leonxlnx/SharpShot/releases), download that exact file. Until then, build it locally with `.\build.ps1`.
2. Select **Extract All** and move the extracted `SharpShot` folder somewhere permanent.
3. Run `SharpShot.exe`.
4. Right-click the tray icon and enable **Start with Windows** if desired.

Do not enable startup while running the executable from inside a ZIP or a temporary folder.

The current release is not code-signed, so Windows may show an **Unknown publisher** or SmartScreen warning. Verify the adjacent SHA-256 checksum before running it.

## Take a screenshot

1. Press **Win + Shift + D**.
2. Drag over the area you want.
3. Release to copy it at the selection's original dimensions. With auto-save enabled (the default), SharpShot separately saves the enlarged lossless PNG.

Press `Esc` or right-click to cancel. Double-click the tray icon to start a capture without the keyboard shortcut.

The tray menu also provides:

- **Auto Crisp XXL — recommended** — automatically uses up to 12× for micro-crops, 2× for normal 1080p-class regions, or exact native pixels for already-large captures
- **Native (1×)** — exact source pixels, no resampling
- **Crisp (up to 2×)** — manual 2× enlargement with safety fallback for exceptionally large selections
- **Ultra (up to 3×)** — manual 3× enlargement with safety fallback for larger selections
- **Max (up to 6×)** — manual 6× enlargement for micro-crops, with automatic safety fallback for larger selections
- **Paste at selection size — best for chats** — enabled by default; turn it off when you intentionally want the enlarged raw dimensions on the clipboard
- Automatic lossless PNG saving
- Open captures folder / open the last capture saved during the current session
- Start with Windows
- Exit

If the clipboard is unavailable, SharpShot still saves the PNG when auto-save is enabled. With auto-save disabled, SharpShot warns you and does not write the capture to disk.

Screenshots use names such as `Screenshot 2026-08-09 at 14.32.08 - 640x360.png`.

## Record a screen area

1. Press **Win + Shift + A**.
2. Drag over an area at least 48 × 48 pixels.
3. After the `3, 2, 1` countdown, recording starts.
4. Press **Win + Shift + A** again or click the square **Stop** button in the small floating controller.

SharpShot finalizes the MP4 to a temporary file first, atomically gives it its final name, saves it to `Pictures\SharpShot`, and places that saved file on the Windows clipboard. Applications that accept pasted files—such as many chat clients—can then receive it with `Ctrl + V`. File-paste support is controlled by the receiving application, so it is not universal.

Recordings include the mouse pointer and use names such as `Recording 2026-08-09 at 14.34.12 - 1920x1080.mp4`. Version 1.5 records video only; it does not record microphone or system audio.

The floating controller is placed above the selected area when space allows. On Windows 10 version 2004 and newer, SharpShot asks Windows to exclude that controller from captured content. This is best-effort platform behavior rather than a content-protection guarantee.

## Quality, honestly

A screenshot cannot contain more real detail than the monitor rendered. Native mode preserves every available source pixel exactly. Crisp, Ultra, and Max create a controlled enlarged copy to avoid lower-quality downstream scaling; they do not invent missing detail.

PNG DPI metadata cannot force a display size in Discord, WhatsApp, Slack, browser chats, or most other messaging software. Those applications normally use raw pixel dimensions, so an 11× file looks 11× larger. SharpShot therefore pastes the exact selection dimensions by default and keeps the enlarged version as the separately auto-saved asset. Disable **Paste at selection size** when the receiving application supports density metadata or when full enlarged dimensions are intentionally wanted.

Auto Crisp XXL tries every whole-number scale from 12× down through 3× and takes the highest one whose output fits within 4 megapixels and 4096 pixels per edge. If none fits, it can use 2× up to 8.5 megapixels and the same 4096-pixel edge limit; this lets a 1920 × 1080 region become a 3840 × 2160 image. Already-large captures stay native. Every enlargement is calculated directly from the captured pixels rather than chaining lower-resolution passes. The scaler uses Catmull-Rom reconstruction and clamps every output channel to nearby source colors, preventing the light and dark halos created by unconstrained sharpening.

True Native 1× remains byte-for-byte source pixels. SharpShot does not fake extra 1× sharpness with an edge filter: that would alter text, colors, and evidence without recovering detail. Instead, Auto enlarges more normal captures before they reach the native fallback. Manual enlargement remains capped at 16 megapixels and safely steps down the 6× → 3× → 2× → 1× ladder for large selections. Scaling runs only after a capture and adds no idle work.

Screen recordings preserve the selected native pixel grid whenever it fits the encoder ceiling. Regions up to 1280 × 720 target 60 FPS; larger regions target an efficient 30 FPS. A selection beyond 4096 × 2304 (or 2304 × 4096 in portrait) is downscaled once, with its full aspect ratio retained, instead of silently cropping its right or bottom edge. Dimensions are made even for codec compatibility. Bitrate scales with resolution and frame rate between 4 and 50 Mbps, so the per-frame quality budget stays proportional. Regions below 640 × 360 prefer Windows' lightweight software H.264 encoder; 640 × 360 and larger enable hardware transforms and supply a Direct3D 11 device manager so Windows can keep conversion and encoding on its GPU/video path. Either path can fall back to the other when Windows does not provide the preferred transform. High profile is requested first with Main profile as a compatibility fallback.

## Efficiency

SharpShot is a small .NET Framework tray application with no third-party dependencies. While idle it blocks in the native Windows message loop; it has no polling timer or persistent background worker. On the development machine, an idle five-second sample used no measurable CPU time and approximately `27 MB` of private memory. Exact memory use varies by Windows version and display setup.

The hotkey posts capture directly to the Windows message queue instead of waiting for a timer tick. The selection-sized PNG is flushed to the clipboard before enlargement, so chat pasting becomes available first; if auto-save is off, no unused enlarged image is created. During capture, opaque desktop pixels stay on a 24-bit RGB path instead of carrying a redundant alpha channel, native output reuses the selected crop, and enlargement streams through four cached rows per worker. Outputs of at least 1.5 megapixels can briefly use up to four CPU cores for reconstruction. No scaling work remains afterward; Windows may retain idle thread-pool threads without consuming CPU. PNG data is carried without an extra exact-length copy, and the persistent clipboard is flushed without an additional app-side full-bitmap clone.

High-factor Auto outputs remain capped at 4 megapixels (about 11.4 MiB of raw RGB). The wider 2× budget tops out at 8.5 megapixels (about 24.3 MiB of raw RGB), while large native captures are never downscaled merely to satisfy an enlargement budget.

For a region contained on one unrotated display, recording uses Windows' DXGI Desktop Duplication path. Capture and Media Foundation share one Direct3D 11 device, the selected rectangle stays on the GPU, and the encoder receives tracked DXGI surface samples directly—there is no full-frame GPU readback, system-memory copy, or upload in the normal path. Pointer-only desktop updates reuse the existing crop, and cursor composition avoids the GPU/GDI synchronization entirely while the pointer is outside the selected region; when it overlaps, only the clipped cursor rectangle is marked dirty. At most four reusable surfaces may be in flight at 60 FPS and three at 30 FPS; if the encoder is busy, SharpShot drops a recorder frame instead of blocking the foreground app. Unsupported, rotated, cross-monitor, multi-adapter, or surface-incompatible cases switch automatically to the compatible CPU/GDI path. The recorder worker and its GPU work run at background priority so an active browser or game wins scheduling contention. Media Foundation starts lazily on the first recording and is reused rather than repeatedly rebuilding its process-wide platform state. There is no unbounded app-side queue: if capture or encoding is briefly late, SharpShot skips stale frame times so memory and interaction latency stay bounded. Frame pacing uses a high-resolution Windows waitable timer instead of burning CPU in a spin loop; the one-millisecond timer-period fallback is requested only while recording on older systems and restored afterward. The compact countdown and controller redraw only while their visible state is changing. Idle behavior remains the normal Windows message loop with no recording worker or polling timer.

The adaptive paths are measured rather than cosmetic. On the development machine, replacing the old GDI capture loop reduced average capture-call time from roughly 30–35 ms to 0.6 ms at 640 × 360, 0.9 ms at 1280 × 720, and 1.6 ms at 1920 × 1080; each two-second end-to-end probe then finished in about two seconds instead of 3.8–4.1 seconds. In alternating 1080p encoder probes, supplying the Direct3D device manager reduced Media Foundation CPU time by roughly 75% versus the previous hardware-enabled path. Hardware and driver behavior varies, so both capture and encoder compatibility fallbacks remain automatic.

The recording shortcut uses Windows' constant-time `RegisterHotKey` path when available. Its compatibility hook is installed only when Windows refuses that registration, performs a few integer comparisons per keyboard event, and immediately returns for every unrelated key. No keyboard history, text, or timing data is retained.

## Privacy

SharpShot Native captures pixels locally. It has no networking or telemetry code. Its only on-disk and registry state is:

- screenshots under `Pictures\SharpShot` when auto-save is enabled;
- recordings under `Pictures\SharpShot` after every completed recording;
- settings and runtime status under `%LOCALAPPDATA%\SharpShot`;
- an optional current-user `Run` entry when **Start with Windows** is enabled.

SharpShot Studio is also local-first: it has no account, upload, analytics, or
telemetry service. Its packaged capture, project, and export flows do not need a
network connection. An explicit **Get wallpapers from Apple** action opens an
approved HTTPS page in the system browser; it does not download or cache Apple
artwork. The build-only FFmpeg vendoring script downloads one pinned archive
when a local archive is not supplied.

## Build SharpShot Native from source

Requirements:

- Windows 10 or 11, x64
- .NET Framework 4.8 compiler/runtime (included on current supported Windows installations; the Developer Pack may be needed on stripped-down systems)
- PowerShell 5.1 or newer

Run:

```powershell
.\build.ps1
```

The portable ZIP is written to `artifacts\native`. The build script resets only
that native artifact directory, compiles the checked-in C# source using the
Windows .NET Framework compiler, generates the application icon, runs
pixel/DPI/PNG self-tests, packages checksums, re-extracts and verifies the exact
archive contents, and self-tests the packaged executable.

The normal self-test uses generated patterns only. Run `SharpShot.exe --self-test-live <output-folder>` explicitly to add interactive desktop-capture and H.264-finalization checks. The live test briefly writes its codec probe inside the requested output folder, validates the MP4 container, and deletes it before returning.

For Studio development, tests, media-runtime verification, and Windows package
commands, see [`desktop/README.md`](desktop/README.md). Native and Studio releases
are unsigned at this stage, so Windows may display **Unknown publisher** or a
SmartScreen warning. Verify release checksums before running either build.
The guarded release procedure is documented in [`RELEASING.md`](RELEASING.md).

## Known limitations

- Recording capture is currently 8-bit SDR. HDR desktops may be tone-mapped by Windows.
- Protected video, the UAC secure desktop, and some exclusive full-screen content may appear black.
- Screen recording is silent in version 1.5; microphone and system-audio capture are not included.
- The Windows clipboard carries the saved MP4 as a file-drop item. Receiving applications decide whether `Ctrl + V` accepts video files.
- The recording controller exclusion requires Windows 10 version 2004 or newer and remains best-effort.
- The global shortcut is available only while signed in and while SharpShot is running.
- Windows itself reserves `Win + Shift + A` on current builds; SharpShot's exact-chord compatibility hook overrides that Windows-tip action while SharpShot is running. Secure-desktop input is never intercepted.
- Another application or OEM utility can still claim or intercept either shortcut. SharpShot reports a registration failure if neither the native registration nor compatibility path can be installed, and keeps the corresponding action in its tray menu.

## Contributing

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Leonxlnx. Bundled CC0 music, Electron's incorporated
components, and the replaceable LGPL FFmpeg runtime retain their upstream terms;
see [`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md).
