# SharpShot

[![Build](https://github.com/Leonxlnx/SharpShot/actions/workflows/build.yml/badge.svg)](https://github.com/Leonxlnx/SharpShot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-20252b.svg)](LICENSE)

SharpShot is a small Windows region-capture utility for people who want one shortcut and a clean PNG.

Press **Win + Shift + D**, drag a rectangle, and release. SharpShot copies the result to the clipboard and can save it automatically to `Pictures\SharpShot`.

## Why SharpShot?

- Native physical-pixel capture with Per-Monitor V2 DPI awareness
- Lossless PNG encoding; no JPEG conversion
- Auto Crisp chooses native, 2×, 3×, or 6× output from the selection size
- Local-range-clamped enlargement keeps UI edges clean without sharpening halos
- Global `Win + Shift + D` shortcut
- Multi-monitor and negative-origin desktop support
- Clipboard formats for modern apps and legacy bitmap consumers
- Silent start at Windows sign-in
- No installer, administrator rights, network access, telemetry, service, polling loop, or watchdog

Microsoft's current Windows shortcut reference does not list `Win + Shift + D` as a default shortcut. Another installed application or OEM utility can still register it. See [Microsoft's Windows shortcut reference](https://support.microsoft.com/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec).

## Install

1. Download the latest `SharpShot-v...-win-x64.zip` from [Releases](https://github.com/Leonxlnx/SharpShot/releases).
2. Select **Extract All** and move the extracted `SharpShot` folder somewhere permanent.
3. Run `SharpShot.exe`.
4. Right-click the tray icon and enable **Start with Windows** if desired.

Do not enable startup while running the executable from inside a ZIP or a temporary folder.

The current release is not code-signed, so Windows may show an **Unknown publisher** or SmartScreen warning. Verify the adjacent SHA-256 checksum before running it.

## Use

1. Press **Win + Shift + D**.
2. Drag over the area you want.
3. Release to copy it. With auto-save enabled (the default), SharpShot also saves a lossless PNG.

Press `Esc` or right-click to cancel. Double-click the tray icon to start a capture without the keyboard shortcut.

The tray menu also provides:

- **Auto Crisp — recommended** — automatically uses 6× for micro-crops, then 3×, 2×, or native pixels as the selection grows
- **Native (1×)** — exact source pixels, no resampling
- **Crisp (up to 2×)** — manual 2× enlargement with safety fallback for exceptionally large selections
- **Ultra (up to 3×)** — manual 3× enlargement with safety fallback for larger selections
- **Max (up to 6×)** — manual 6× enlargement for micro-crops, with automatic safety fallback for larger selections
- Automatic lossless PNG saving
- Open screenshot folder / open the last capture saved during the current session
- Start with Windows
- Exit

If the clipboard is unavailable, SharpShot still saves the PNG when auto-save is enabled. With auto-save disabled, SharpShot warns you and does not write the capture to disk.

## Quality, honestly

A screenshot cannot contain more real detail than the monitor rendered. Native mode preserves every available source pixel exactly. Crisp, Ultra, and Max create a controlled enlarged copy to avoid lower-quality downstream scaling; they do not invent missing detail.

Auto Crisp tries 6×, then 3×, then 2×, and uses the highest tier whose enlarged output fits within 4 megapixels and 4096 pixels per edge. Otherwise it stays native. In practice, 6× is reserved for source crops with at most 111,111 pixels of area and no edge longer than 682 pixels. Every enlargement is calculated directly from the captured pixels rather than chaining lower-resolution passes. The scaler uses Catmull-Rom reconstruction and clamps every output channel to nearby source colors, preventing the light and dark halos created by unconstrained sharpening.

SharpShot caps manually enlarged output at 16 megapixels and automatically steps down the 6× → 3× → 2× → 1× ladder for large selections. Automatically enlarged outputs stay within the 4-megapixel/4096-pixel budget for predictable speed and memory use; native captures are never downscaled to meet that budget. Scaling runs only after a capture and adds no idle work.

## Efficiency

SharpShot is a small .NET Framework tray application with no third-party dependencies. While idle it blocks in the native Windows message loop; it has no polling timer or background worker. On the development machine, an idle five-second sample used no measurable CPU time and approximately `27 MB` of private memory. Exact memory use varies by Windows version and display setup.

During capture, native output reuses the selected crop, enlargement streams through four cached rows, PNG data is carried without an extra exact-length copy, and the persistent clipboard is flushed without an additional app-side full-bitmap clone. Automatically enlarged output is capped at about 15.3 MB of raw pixels before encoding.

## Privacy

SharpShot captures pixels locally. It has no networking or telemetry code. Its only on-disk and registry state is:

- screenshots under `Pictures\SharpShot` when auto-save is enabled;
- settings and runtime status under `%LOCALAPPDATA%\SharpShot`;
- an optional current-user `Run` entry when **Start with Windows** is enabled.

## Build from source

Requirements:

- Windows 10 or 11, x64
- .NET Framework 4.8 compiler/runtime (included on current supported Windows installations; the Developer Pack may be needed on stripped-down systems)
- PowerShell 5.1 or newer

Run:

```powershell
.\build.ps1
```

The portable ZIP is written to `artifacts\`. The build script compiles only the checked-in C# source using the Windows .NET Framework compiler, generates the application icon, runs pixel/DPI/PNG self-tests, and packages checksums.

The normal self-test uses generated patterns only. Run `SharpShot.exe --self-test-live <output-folder>` explicitly to add an interactive desktop-capture check; it validates capture in memory and does not save desktop pixels.

## Known limitations

- GDI capture is 8-bit SDR. HDR desktops may be tone-mapped by Windows.
- Protected video, the UAC secure desktop, and some exclusive full-screen content may appear black.
- The global shortcut is available only while signed in and while SharpShot is running.
- Another application or OEM utility can claim the shortcut. SharpShot reports that shortcut registration failed and remains available from its tray icon.

## Contributing

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Leonxlnx
