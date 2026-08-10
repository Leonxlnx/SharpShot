# Third-party and asset notices

SharpShot's MIT license applies to the application code and the original
project-owned assets identified below. Third-party assets and runtimes remain
subject to their own licenses. This file records current provenance and known
notices; it is not a complete dependency inventory or legal advice.

## Original SharpShot artwork

The repository does not copy interface icons or bundled wallpapers from Cap,
Tella, Apple, or another product.

### Original backgrounds

SharpShot Studio includes eight original backgrounds. Four retain the image
generator's 1672 × 941 source size and four are finished as center-safe
3840 × 2160 masters:

| File | Display name | Provenance |
| --- | --- | --- |
| `dusk-fold.png` | Dusk Fold | 1672 × 941; OpenAI image generation; SHA-256 recorded |
| `glacier-glass.png` | Glacier Glass | 1672 × 941; OpenAI image generation; SHA-256 recorded |
| `solar-silk.png` | Solar Silk | 1672 × 941; OpenAI image generation; SHA-256 recorded |
| `midnight-bloom.png` | Midnight Bloom | 1672 × 941; OpenAI image generation; SHA-256 recorded |
| `obsidian-tide.webp` | Obsidian Tide | 3840 × 2160; OpenAI image generation; q100 WebP package; prompt and SHA-256 recorded |
| `cobalt-bloom.webp` | Cobalt Bloom | 3840 × 2160; OpenAI image generation; q100 WebP package; prompt and SHA-256 recorded |
| `moss-alloy.webp` | Moss Alloy | 3840 × 2160; OpenAI image generation; q100 WebP package; prompt and SHA-256 recorded |
| `lunar-paper.webp` | Lunar Paper | 3840 × 2160; OpenAI image generation; q100 WebP package; prompt and SHA-256 recorded |

No third-party images were used as generation inputs. The collection manifest,
prompts, source dimensions, finishing method, and available per-file hashes are
recorded in
[`desktop/resources/backgrounds/manifest.json`](desktop/resources/backgrounds/manifest.json).
These files are distributed with SharpShot under the repository's MIT license.

### Application and interface icons

The SharpShot Studio application icon and tray mark are original project
assets. The active interface uses normal inline SVG icons authored in code.
Superseded tactile PNG studies are ignored local development artifacts; they are
not referenced by source, tracked in the public repository, or included in a
package.

### Apple artwork is not included

SharpShot does not bundle, mirror, cache, or hotlink Apple wallpapers, logos, or
other Apple artwork. The editor's **Get wallpapers from Apple** action opens an
official Apple support page in the user's default browser. A user can import a
local image, but that user remains responsible for having the right to use it.

This separation is intentional: an official download intended for personal
wallpaper use is not, by itself, a redistribution license for a third-party
application. Relevant official pages are Apple's
[website terms](https://www.apple.com/legal/internet-services/terms/site.html),
[wallpaper guidance](https://support.apple.com/guide/mac-help/mchlp3013/mac),
and [rights and permissions contact](https://www.apple.com/legal/contact/rights-permissions.html).

## Starter music

SharpShot Studio includes three unmodified MP3 files selected from
iamoneabe's **Vintage Collection**:

| File | Title | Creator | License |
| --- | --- | --- | --- |
| `desktop/resources/audio/music/beauty-beat.mp3` | Beauty Beat | iamoneabe | CC0-1.0 |
| `desktop/resources/audio/music/evening.mp3` | Evening | iamoneabe | CC0-1.0 |
| `desktop/resources/audio/music/floating-away.mp3` | Floating Away | iamoneabe | CC0-1.0 |

The creator released the collection under CC0 1.0 Universal, permits
commercial use, modification, and redistribution, and states that the
collection is not registered with YouTube Content ID or another copyright
system. Attribution is not required, but this notice is retained for clear
provenance.

- Creator release: <https://iamoneabe.itch.io/vintage-collection>
- OpenGameArt release and downloads:
  <https://opengameart.org/content/vintage-collection-vgm-sfx-tracks-stuff-vol-i>
- License: [CC0 1.0 Universal](desktop/resources/audio/LICENSE-CC0-1.0.txt)
- Retrieval date: 2026-08-09
- Exact download URLs, byte sizes, durations, media properties, and SHA-256
  hashes: [`desktop/resources/audio/manifest.json`](desktop/resources/audio/manifest.json)

The original MP3 byte streams are preserved; SharpShot does not normalize
or transcode these bundled source files. A third party can still make an
incorrect automated copyright claim, so the manifest and original release
pages are kept as provenance for disputes.

## Desktop media runtime

Local SharpShot Studio packages include unmodified FFmpeg and ffprobe programs
with their shared libraries. The pinned BtbN Windows x64 aggregate reports the
LGPL shared configuration and no GPL/nonfree configure switch. SharpShot invokes
the tools as child processes; the MIT license applies to SharpShot code, not to
the FFmpeg runtime. This does **not** establish a complete license inventory for
the many statically incorporated dependencies.

- Exact version, source/build commits, aggregate license analysis, and upstream
  source links:
  [`desktop/resources/ffmpeg/win32-x64/THIRD_PARTY_NOTICES.md`](desktop/resources/ffmpeg/win32-x64/THIRD_PARTY_NOTICES.md)
- Archive and per-file SHA-256 hashes:
  [`desktop/resources/ffmpeg/win32-x64/runtime-manifest.json`](desktop/resources/ffmpeg/win32-x64/runtime-manifest.json)
- Exact compiler and complete configure line reported by the binary:
  [`desktop/resources/ffmpeg/win32-x64/BUILD_CONFIGURATION.txt`](desktop/resources/ffmpeg/win32-x64/BUILD_CONFIGURATION.txt)
- LGPLv3 and incorporated GPLv3 texts:
  [`desktop/resources/ffmpeg/win32-x64/FFMPEG-LGPL-3.0.txt`](desktop/resources/ffmpeg/win32-x64/FFMPEG-LGPL-3.0.txt),
  [`desktop/resources/ffmpeg/win32-x64/GNU-GPL-3.0.txt`](desktop/resources/ffmpeg/win32-x64/GNU-GPL-3.0.txt)
- Pinned vendoring and verification:
  [`desktop/MEDIA_RUNTIME.md`](desktop/MEDIA_RUNTIME.md)

`runtime-manifest.json` therefore marks the current runtime
`blocked-incomplete-third-party-inventory`. Full Studio packages containing it
must not be publicly distributed. The FFmpeg and BtbN revisions above are useful
provenance but are not sufficient corresponding-source or notice coverage for
the complete incorporated dependency graph. The evidence and unblocking
requirements are in
[`desktop/resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md`](desktop/resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md).
Quick Capture contains no FFmpeg runtime and is outside this block.

## Electron desktop runtime

SharpShot Studio 0.2.0-alpha.1 pins Electron 43.3.0 and React 19.2.8. Exact direct and
transitive JavaScript dependency versions are locked in
[`desktop/package-lock.json`](desktop/package-lock.json); the authoritative
declared package identity and versions are in
[`desktop/package.json`](desktop/package.json).

Electron is MIT-licensed and incorporates Chromium, Node.js, and other
components under their respective licenses. The Electron distribution carries
its `LICENSE` and `LICENSES.chromium.html` notices into packaged applications.
React 19.2.8, React DOM 19.2.8, and Scheduler 0.27.0 are MIT-licensed and ship
the identical 1,088-byte license text (SHA-256
`da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93`).
That exact upstream byte stream is checked in and packaged as
[`desktop/resources/licenses/REACT-FAMILY-MIT.txt`](desktop/resources/licenses/REACT-FAMILY-MIT.txt).
Build-only tools such as TypeScript, Vite, Vitest, electron-vite, and
electron-builder are not SharpShot application code and retain their upstream
terms.
