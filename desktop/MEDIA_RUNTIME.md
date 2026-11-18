# Media runtime

SharpShot Studio packages a pinned Windows x64 FFmpeg runtime for local MP4
and GIF exports. The source repository keeps its licenses, manifest, provenance,
and compliance notice in Git. The large executables and DLLs are restored from
one hash-verified upstream archive before packaging and are intentionally
ignored by Git. This makes vendoring repeatable and tamper-evident; it is not a
claim that an independent build would produce identical bytes.

From `desktop`:

```powershell
npm run media:vendor
npm run media:verify
npm run media:smoke
```

`media:vendor` downloads the pinned upstream archive, verifies its SHA-256, and
copies only `ffmpeg`, `ffprobe`, and their required shared DLLs into
`resources/ffmpeg/win32-x64`. Pass a previously downloaded archive for an
offline build:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vendor-ffmpeg.ps1 `
  -ArchivePath C:\Downloads\ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip
```

Local packaging runs `media:verify` first and refuses a missing or altered
runtime. Package verification also checks that the bundled manifest exactly
matches the canonical manifest, required SharpShot, React-family, CC0, FFmpeg,
and Electron notices are present, and no source maps, tests, stale
`renderer-browser` output, or tactile studies ship. `media:smoke` is the slower
Windows integration check: it produces and probes a composited H.264/AAC MP4
and a two-pass palette GIF.

The packaged runtime layout is:

```text
resources/
  ffmpeg/
    win32-x64/
      ffmpeg.exe
      ffprobe.exe
      avcodec-62.dll
      avdevice-62.dll
      avfilter-11.dll
      avformat-62.dll
      avutil-60.dll
      swresample-6.dll
      swscale-9.dll
      BUILD_CONFIGURATION.txt
      COMPLIANCE-BLOCKED.md
      FFMPEG-LGPL-3.0.txt
      GNU-GPL-3.0.txt
      THIRD_PARTY_NOTICES.md
      runtime-manifest.json
```

The provider labels this archive its LGPL shared variant, and the aggregate
FFmpeg configuration reports version 3-or-later shared mode without GPL or
nonfree configure switches. That aggregate label does not establish complete
license and notice coverage for the many incorporated dependencies. See
`resources/ffmpeg/win32-x64/THIRD_PARTY_NOTICES.md` for the pinned version,
commits, upstream links, archive hash, and recorded build configuration, and
`resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md` for the known gap.

## Distribution status

`runtime-manifest.json` currently says:

```text
blocked-incomplete-third-party-inventory
```

Full Studio may still be built and verified locally, but packages containing
this runtime must not be publicly distributed. The pinned FFmpeg commit and
BtbN build-scripts commit are provenance; together they are not sufficient
corresponding-source or notice coverage for the full dependency graph. Quick
Capture contains no FFmpeg runtime and is eligible for release independently.

The public Full path in [`release.ps1`](../release.ps1) calls the shared
compliance policy with `-PublicRelease` before building and checks the packaged
manifest again afterward. Only exact `complianceStatus: verified` in both
places permits assembly. The separate draft workflow repeats that check before
receiving write access. Local `media:verify`, `media:smoke`, and `package:win`
intentionally do not request public-release authorization.

To unblock a future Full release, follow every evidence and review requirement
in `COMPLIANCE-BLOCKED.md`, replace or fully inventory the runtime, regenerate
the manifest and notices, and rerun the real media and packaged-payload checks.
Do not change the marker based only on the aggregate LGPL label or the two
pinned upstream links. FFmpeg's official
[license-compliance checklist](https://ffmpeg.org/legal.html) remains relevant;
this repository does not claim legal advice.

## Future code signing

The manifest currently verifies the unmodified upstream FFmpeg byte streams.
The alpha package is unsigned, and local package verification requires the
packaged FFmpeg hashes to match the source manifest. Before enabling a Windows
signing certificate, configure and test the packager so third-party
`ffmpeg.exe` and `ffprobe.exe` are excluded from application signing, or publish
a separate signed-binary manifest and update the provenance notice. Do not
weaken package verification merely to accept silently altered executable hashes.
