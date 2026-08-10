# SharpShot Quick

[![Build](https://github.com/Leonxlnx/SharpShot/actions/workflows/build.yml/badge.svg)](https://github.com/Leonxlnx/SharpShot/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-20252b.svg)](LICENSE)

SharpShot Quick is a tiny native Windows tool for fast screenshots and short screen recordings. It stays in the notification area, works locally, and has no accounts, telemetry, network code, Electron, FFmpeg, or third-party runtime dependencies.

## Install

1. Download `SharpShot-Quick-1.5.0-win-x64.zip` and its `.sha256.txt` file from [Releases](https://github.com/Leonxlnx/SharpShot/releases).
2. Verify the ZIP if you want the strongest check:

   ```powershell
   (Get-FileHash .\SharpShot-Quick-1.5.0-win-x64.zip -Algorithm SHA256).Hash
   ```

3. Select **Extract all**. Do not run the app inside the ZIP.
4. Open the extracted `SharpShot` folder and double-click **Install.cmd**.

The installer verifies every packaged file, runs the built-in synthetic self-test, installs per-user to `%LOCALAPPDATA%\Programs\SharpShot Quick`, creates Desktop and Start Menu shortcuts, registers a normal **Installed apps** entry, and starts the tray app. It does not need administrator rights.

The release is currently unsigned, so Windows may show **Unknown publisher** or SmartScreen. Use **More info → Run anyway** only after the checksum matches the release page.

### Portable use

Skip `Install.cmd` and run `SharpShot.exe` directly from a permanent extracted folder. Enable **Start with Windows** from the tray menu only after moving the folder where you want to keep it.

### Uninstall

Open **Settings → Apps → Installed apps → SharpShot Quick → Uninstall**. Captures in `Pictures\SharpShot` and local preferences are kept.

## 60-second tutorial

### Screenshot

1. Press **Win + Shift + D**.
2. Drag around the area you want.
3. Release to copy it. By default, a lossless PNG is also saved to `Pictures\SharpShot`.

Press **Esc** or right-click while selecting to cancel without saving.

### Quick video

1. Press **Win + Shift + A**.
2. Drag around the recording area.
3. Press **Esc** during selection or the countdown to cancel.
4. After recording starts, press **Win + Shift + A** again or click the floating square Stop button.

The finalized H.264 MP4 is saved to `Pictures\SharpShot` and copied as a pasteable file. `Esc` intentionally does not delete an active recording; this prevents an accidental key press from losing captured video.

Do not run SharpShot Quick and SharpShot Studio together: both use the same global shortcuts.

## Tray controls

- Capture now / Record screen area
- Auto Crisp XXL, Native 1×, Crisp 2×, Ultra 3×, and Max 6× screenshot modes
- Compact chat-sized clipboard output with optional full-resolution PNG auto-save
- Open captures folder / last capture
- Start with Windows
- Exit safely after an active MP4 has finalized

## Privacy and reliability

- Windows-only, x64, .NET Framework 4.8
- No networking, telemetry, cloud upload, service, driver, watchdog, or administrator access
- Screenshots and recordings are written locally and finalized before clipboard copy
- Native DXGI/Desktop Duplication and Media Foundation hardware paths with automatic GDI/software fallback
- 60 FPS through 1280 × 720; efficient 30 FPS above it
- Region selection supports multiple monitors and per-monitor DPI

## Build from source

Requirements: Windows 10/11 x64, PowerShell 5.1+, and the .NET Framework 4.8 compiler/runtime.

```powershell
git clone https://github.com/Leonxlnx/SharpShot.git
cd SharpShot
.\build.ps1
```

The script compiles checked-in C# with the Windows compiler, generates the icon, runs synthetic pixel/DPI/PNG/recording tests, packages the exact portable file set, re-extracts and retests it, and writes:

- `artifacts\native\SharpShot-Quick-1.5.0-win-x64.zip`
- `artifacts\native\SharpShot-Quick-1.5.0-win-x64.zip.sha256.txt`

The interactive `--self-test-live` path is opt-in; normal builds never capture the developer's desktop.

## Scope

Quick intentionally does screenshot and quick video only. The unfinished multi-track Studio editor is developed separately and will be published later when its UX, packaging, and binary-license review are ready.

## Contributing and security

Focused issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/Leonxlnx/SharpShot/security/advisories/new).

## License

[MIT](LICENSE) © 2026 Leonxlnx
