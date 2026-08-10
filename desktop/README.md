# SharpShot Studio

SharpShot Studio is the local Windows workflow and editing companion to the
small SharpShot Native capture utility. The internal desktop package is
`sharpshot-studio` version `0.2.0-alpha.1`; Windows packages use the product name
**SharpShot Studio** and the application ID `com.leonlin.sharpshot.studio`.

> **Alpha notice:** Studio 0.2.0-alpha.1 is an engineering alpha, not a claim of full
> Cap, Tella, or cloud-editor parity. Capture, local editing, and export are real.
> Features that do not persist and export correctly are not presented as working.

## Architecture

- The Electron main process owns the tray, settings, workflow persistence,
  global shortcut registration, local library, project autosave, and export
  jobs.
- Screenshot and recording workflows launch the short-lived native Windows
  helper in `resources/native/win32-x64`; Electron does not capture the desktop
  through `getDisplayMedia`.
- The Studio renderer is created when a window is opened and destroyed when it
  closes, releasing Chromium renderer memory. The Electron main/tray process
  remains available for Studio shortcuts until **Quit** is selected from the
  tray menu.
- The renderer is sandboxed with context isolation and no Node integration.
  Narrow, validated IPC methods are exposed from the preload; navigation,
  permissions, popups, and external links are restricted by the main process.
- Media and projects stay local. There is no SharpShot account, cloud upload,
  collaboration service, analytics, or telemetry.

SharpShot Native remains available from the repository root for people who
want only the smallest always-ready screenshot/quick-recording path. Running
Native and Studio simultaneously with identical shortcuts causes a normal
Windows hotkey conflict; use one shortcut owner at a time.

## What works in 0.2.0-alpha.1

| Surface | Status |
| --- | --- |
| Area capture | Native area selection, lossless screenshot output, native-pixel H.264 video, local save, clipboard completion, countdown, and same-shortcut stop |
| Workflows | Persistent screenshot/video recipes, multiple shortcut bindings per workflow, enable/disable, and explicit collision or registration errors |
| Recording tracks | Visible cursor burn-in plus optional lossless system-audio and microphone WAV sidecars; availability depends on Windows devices and drivers. Video-to-Studio also records bounded click metadata for automatic zoom generation |
| Library | Local media registration, import, reveal-in-folder, safe ranged media serving, and startup reconciliation of Studio screenshots and recordings |
| Projects | Versioned local JSON schema, validation, project listing/load/save, delayed autosave, and bounded undo/redo foundations |
| Core editor | Non-destructive trim, split, delete/ripple-delete, reorder, speed, direct video move/resize/crop, canvas, imported or built-in backgrounds, frame, corners, shadow, and bounded undo/redo |
| Zoom and captions | Persisted manual zooms, click-generated auto zoom, direct focus positioning, a zoom timeline, manual/SRT/VTT captions, output-canvas preview, and caption burn-in for MP4 and GIF |
| Audio editor | Embedded-source volume, a persisted music timeline, three bundled CC0 tracks or local audio import, trim/split, fades, gain, mute, and export-accurate source ducking. Separate Studio WAV stems are not attached automatically |
| Export | Local MP4 and GIF rendering with zoom/caption support, MP4 audio mixing, cancellation, progress events, media probing, collision-safe finalization, and Windows file clipboard support |
| Safe Redact | Up to 64 timed, fully opaque axis-aligned rectangles with black/dark/white presets, direct preview move/resize, timeline trimming, persistence, and MP4/GIF burn-in |
| Visual assets | Eight original built-in backgrounds, four 4K CC0 cinematic landscapes, an original application icon, normal inline SVG action icons, and three CC0 starter music tracks |

Safe Redact is the only visual-annotation surface in this alpha. Unsupported
persisted overlays are preserved but rejected during export rather than silently
omitted. Blur/pixelation, freeform annotations, editable cursor replacement,
automatic transcription, AI cutting, voice cleanup, automatic mixing of
separately captured WAV stems, cloud sharing, team collaboration, webcam
composition, hosted links, and macOS support are not part of this alpha.

Only MP4 and GIF are supported export formats in the current export engine.
Any preview-only or disabled control is not a release promise.

## Efficiency boundaries

Studio is designed to keep expensive work out of the idle path: shortcut
dispatch is event-driven, the native helper exists only during capture, FFmpeg
runs only for probe/export jobs, and the Chromium renderer process is released
when the Studio window closes. Export and recorder queues are bounded and both
support cancellation or stop.

An Electron tray process is still materially larger than SharpShot Native's
small .NET message-loop process. No Studio CPU or memory number is published
until it has a repeatable release-build benchmark. Use SharpShot Native when the
absolute smallest always-on footprint matters; open Studio for configurable
workflows and editing.

## Built-in backgrounds and Apple artwork

The bundled wallpaper collection is original SharpShot artwork generated from
text prompts for this project. Four are center-safe 3840 × 2160 masters and four
retain the image generator's 1672 × 941 source size:

- Dusk Fold — 1672 × 941
- Glacier Glass — 1672 × 941
- Solar Silk — 1672 × 941
- Midnight Bloom — 1672 × 941
- Obsidian Tide — 3840 × 2160
- Cobalt Bloom — 3840 × 2160
- Moss Alloy — 3840 × 2160
- Lunar Paper — 3840 × 2160

Prompts and generation provenance are recorded in
[`resources/backgrounds/manifest.json`](resources/backgrounds/manifest.json).
Four additional unmodified 4K landscapes from Budgie Backgrounds v3.0 are
included under CC0-1.0: Lake Sherburne, Ocean Waves, Valley Midnight, and Beacon
Street Sunset. Their pinned source commit, hashes, and license are recorded in
the same manifest and in the repository asset notice.

The brand uses the original SharpShot application artwork; action and
navigation controls use ordinary inline SVG icons. Superseded tactile PNG
studies are local development artifacts: they are ignored by Git, unreferenced
by the renderer, and excluded from every package.

Apple wallpapers, logos, and other Apple artwork are **not bundled, copied,
cached, or hotlinked**. The editor can open an official Apple support page in
the user's normal browser and can import a local PNG, JPEG, WebP, or GIF. The person
importing a background is responsible for having the right to use it. See the
repository's [`THIRD_PARTY_ASSETS.md`](../THIRD_PARTY_ASSETS.md).

## Local files

Default capture locations are:

```text
Pictures\SharpShot Studio\Screenshots
Videos\SharpShot Studio\Recordings
```

Exports are written to the destination selected by the user in the save flow.

Electron's per-user application-data directory contains `settings.json`,
`workflows.json`, `library.json`, project JSON files, and short-lived native
result records. **Start with Windows** uses Electron's current-user login-item
registration and does not require administrator rights.

## Use a local alpha package

The planned local package names are:

- `SharpShot-Studio-Setup-0.2.0-alpha.1-win-x64.exe` — recommended per-user installer;
- `SharpShot-Studio-0.2.0-alpha.1-win-x64.zip` — complete portable build.

These Full packages are not currently authorized for public distribution: the
bundled FFmpeg runtime is marked
`blocked-incomplete-third-party-inventory`. Developers can build them locally
for verification. Quick Capture contains no FFmpeg and can be released
independently as `SharpShot-Quick-1.5.0-win-x64.zip`. Do not run Quick Capture
and Full Studio at the same time because both own the same global shortcuts.

Extract the ZIP before running it; do not launch the executable from inside the
archive. Studio is not currently code-signed, so read the signing warning below
and verify the checksum published with the release.

## Develop on Windows

Requirements:

- Windows 10 or 11, x64
- Node.js 22.12 or newer and npm
- PowerShell 5.1 or newer
- .NET Framework 4.8 compiler/runtime; the Developer Pack may be required to
  rebuild the native helper

Build and test the standalone native app from the repository root when needed:

```powershell
.\build.ps1
```

Studio packaging has its own safe native-runtime preflight. It compiles the
current sorted native source set in `desktop/.staging`, verifies the x64 PE and
embedded `1.5.0.0` version, runs the isolated self-test in a hidden process,
records source/output SHA-256 hashes, and swaps the complete runtime directory
without resetting the repository's shared `artifacts` directory:

```powershell
Set-Location .\desktop
npm run native:vendor
npm run native:verify
```

Then install the pinned JavaScript dependencies and restore the pinned FFmpeg
runtime:

```powershell
npm ci
npm run media:vendor
npm run media:verify
npm test
npm run typecheck
npm run build
```

`media:vendor` downloads the pinned archive labeled by its provider as the LGPL
shared variant, verifies its SHA-256, and copies only the required programs and
DLLs. To build offline, pass
a previously downloaded archive as documented in
[`MEDIA_RUNTIME.md`](MEDIA_RUNTIME.md).

Start the development app with:

```powershell
npm run dev
```

Set `SHARPSHOT_NATIVE_ENGINE_MOCK=1` only for UI work that intentionally does
not invoke real capture.

For renderer-only browser QA, run:

```powershell
npm run qa:renderer
```

Then open `http://127.0.0.1:4174` manually. This command invokes plain Vite and
cannot start Electron, the preload, or native capture code; the renderer uses
its development preview data. It also does not open a browser automatically.
Use `npm run qa:renderer:build` for a non-interactive standalone renderer build.

## Package and verify

Run these commands from `desktop`:

```powershell
# Unpacked directory for local inspection
npm run package:dir

# Portable Windows x64 ZIP
npm run package:zip

# NSIS installer plus portable ZIP
npm run package:win
```

Outputs are written below `artifacts\desktop` at the repository root. The
package scripts refuse to continue when the pinned FFmpeg files are missing or
altered. Verification also checks the native runtime, MIT/third-party/Electron
legal notices, and rejects source maps, tests, stale renderer-browser output,
and superseded tactile assets. For a real media integration check, run
`npm run media:smoke` before packaging.

`package:win` also verifies the unsigned Setup's MZ/PE and version resources,
opens its embedded 7z payload with the pinned electron-builder extractor, and
runs the same verifier against the extracted x64 Studio application. It never
runs the installer, writes registry state, or creates shortcuts. The outer NSIS
bootstrap is the standard x86 stub; the extracted application and native helper
are the components required to be PE x64.

The eight built-in background masters ship once as runtime resources. The
renderer bundle carries only their lightweight thumbnails, avoiding the former
13,182,461-byte duplicate payload while preserving preview and export access.

Local Studio packages currently contain an unmodified, replaceable FFmpeg
shared runtime whose aggregate configuration reports `LGPL-3.0-or-later`.
SharpShot invokes `ffmpeg.exe` and `ffprobe.exe` as child processes; those files
are not covered by SharpShot's MIT license. The current binary provenance and
known notices are recorded in
[`resources/ffmpeg/win32-x64/THIRD_PARTY_NOTICES.md`](resources/ffmpeg/win32-x64/THIRD_PARTY_NOTICES.md),
but the incorporated dependency inventory is incomplete. See
[`resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md`](resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md).

The root `release.ps1` is intentionally stricter than a local package command:
it refuses Full public release unless both canonical and packaged FFmpeg
manifests say exactly `verified`; only then can it run all tests and assemble
the five release files. The current runtime remains blocked. See
[`../RELEASING.md`](../RELEASING.md).

## Signing and Windows warnings

Alpha packages are not code-signed. Windows can display **Unknown publisher**
or a Microsoft Defender SmartScreen warning for the installer or executable.
That warning is not suppressed or worked around. Verify the release checksum
and build from source when provenance matters.

## License

SharpShot application source and original project-owned assets are available
under the repository's [MIT license](../LICENSE). Bundled CC0 music, FFmpeg,
and the runtime's incorporated third-party components retain their own terms
and notices; see
[`THIRD_PARTY_ASSETS.md`](../THIRD_PARTY_ASSETS.md).
