# FFmpeg runtime notice

SharpShot invokes the programs in this directory as separate child processes.
SharpShot's application code remains available under the MIT license. FFmpeg,
its shared libraries, and their incorporated third-party components remain
under their own licenses.

## Exact build

- Runtime: FFmpeg `n8.1.2-34-g9b6c8969e0-20260731`
- Provider: [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- Provider provenance: FFmpeg's
  [official download page](https://ffmpeg.org/download.html#build-windows)
  lists BtbN as a Windows binary provider.
- Immutable release:
  [`autobuild-2026-07-31-14-10`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-31-14-10)
- Archive: `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip`
- Archive SHA-256:
  `c222a490dde4e7059f45495deef6bfb98dbcacc2b43df5b607546252037aa95c`
- FFmpeg source commit:
  [`9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b`](https://github.com/FFmpeg/FFmpeg/tree/9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b)
- Build scripts commit:
  [`a99e8230eae00d1cee38f23076a7a1f55cd984e2`](https://github.com/BtbN/FFmpeg-Builds/tree/a99e8230eae00d1cee38f23076a7a1f55cd984e2)

The complete archive hash and every redistributed file's byte count and
SHA-256 are recorded in `runtime-manifest.json`.
`BUILD_CONFIGURATION.txt` preserves the exact compiler and complete configure
line reported by the redistributed executable.

## License status

This is BtbN's **LGPL shared** variant. `ffmpeg -version` reports
`--enable-version3 --enable-shared --disable-static`; it does not report
`--enable-gpl` or `--enable-nonfree`. GPL-only `libx264` and `libx265` are
disabled. The resulting FFmpeg runtime reports GNU Lesser General Public
License version 3 or later (`LGPL-3.0-or-later`), not MIT and not GPL.
This matches BtbN's
[documented build variants](https://github.com/BtbN/FFmpeg-Builds#targets-variants-and-addins)
and FFmpeg's own
[license description](https://github.com/FFmpeg/FFmpeg/blob/9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b/LICENSE.md).

The unmodified license supplied in the binary archive is
`FFMPEG-LGPL-3.0.txt`. `GNU-GPL-3.0.txt` accompanies it because LGPLv3
incorporates GPLv3's terms. The application loads no FFmpeg library into the
Electron process; `ffmpeg.exe` and `ffprobe.exe` load the adjacent shared DLLs
and are invoked through command-line arguments with no shell interpolation.

Users may replace the executables and DLLs in this directory with a compatible
LGPL build. SharpShot intentionally does not depend on `libx264`; its MP4 path
uses Windows Media Foundation's `h264_mf` encoder and FFmpeg's native AAC
encoder. The runtime also contains the GIF encoder and palette filters.

This notice describes the bundled build and is not legal advice. Codec patent
rules can be separate from copyright licenses and vary by jurisdiction and use.

## Corresponding source and reproducibility

The binaries are unmodified. Exact corresponding FFmpeg source is available
from the commit above or as a
[source archive](https://github.com/FFmpeg/FFmpeg/archive/9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b.tar.gz).
The exact build recipes, dependency revisions, patches, and Docker-based build
entry points are available from the pinned BtbN build-scripts commit above or
as a
[build-source archive](https://github.com/BtbN/FFmpeg-Builds/archive/a99e8230eae00d1cee38f23076a7a1f55cd984e2.tar.gz).

GPLv3 section 6(d) permits corresponding source to be hosted on a different
server when the binary download gives clear directions and equivalent access.
Every page or release that offers this SharpShot package must therefore repeat
the exact source and build-source links above (or attach those exact archives),
keep them available for as long as the binary is offered, and place the
directions next to the binary download. FFmpeg's own
[license-compliance checklist](https://ffmpeg.org/legal.html) is the release
operator's primary checklist.

The BtbN LGPL variant incorporates a broad set of external components whose
licenses remain their own. The pinned build scripts identify their exact source
revisions and retrieval locations. This notice verifies the aggregate FFmpeg
license configuration and excludes GPL/nonfree configure modes, but it does
not claim to be an exhaustive, lawyer-reviewed inventory of every incorporated
component's notice obligation. A public release operator remains responsible
for that dependency-level review and for providing corresponding source access.

`desktop/scripts/vendor-ffmpeg.ps1` downloads only the immutable archive above,
rejects any archive whose SHA-256 differs, copies a minimal runtime set, and
then verifies every file. `desktop/scripts/verify-ffmpeg.ps1` additionally
checks the reported license configuration and required codecs, muxers, and
filters; its optional smoke test creates and probes real H.264/AAC MP4 and GIF
outputs.

The upstream archive also contains `ffplay`, headers, import libraries,
presets, and generated HTML manuals. SharpShot does not use those files, so
they are not redistributed. All runtime DLL dependencies of `ffmpeg.exe` and
`ffprobe.exe` are retained.

The current SharpShot Studio alpha is unsigned, and package verification
confirms these executable hashes remain identical after electron-builder copies
them. If Studio code signing is enabled later, its packager must exclude these
third-party executables or publish an explicit signed-binary manifest; otherwise
the packaged hashes and the statement that the binaries are unmodified would no
longer be accurate.
