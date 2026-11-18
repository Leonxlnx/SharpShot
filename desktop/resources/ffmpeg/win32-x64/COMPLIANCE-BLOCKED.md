# Public distribution blocked

`runtime-manifest.json` marks this FFmpeg runtime
`blocked-incomplete-third-party-inventory`. SharpShot may use and verify the
runtime for local development, but **Full Studio packages containing these
binaries must not be published**. SharpShot Quick does not contain FFmpeg and
is outside this block.

## Why the current evidence is incomplete

The pinned runtime is BtbN's
`ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip`, built from FFmpeg
commit `9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b` with BtbN build-scripts commit
`a99e8230eae00d1cee38f23076a7a1f55cd984e2`.

Running that exact build-script revision's generator for `win64 lgpl-shared
8.1` reproduces the shipped configure line and resolves 81 enabled recipe
scripts. The build uses static dependency resolution while producing shared
FFmpeg libraries. The binary archive does not contain a resolved
dependency/source inventory or the exact notices for those incorporated
components.

The pinned recipes also leave inputs unresolved:

- the Windows base image uses mutable `base:latest`, clones crosstool-ng without
  checking out a commit, and statically links the GCC/C++ runtimes;
- the enabled rav1e recipe runs unversioned `cargo update cc`, then builds a
  static Rust library with a static C runtime;
- the final FFmpeg build asks `pkg-config` for static dependency closure.

Those facts prevent reconstructing every exact incorporated revision and
license notice from the archive and pinned build-scripts commit alone. A
package-name or SPDX guess is not a substitute for the upstream notice text.

Primary evidence:

- [FFmpeg's compliance checklist](https://ffmpeg.org/legal.html), including
  exact corresponding source and repeating the review for LGPL libraries
  compiled into FFmpeg
- [FFmpeg's pinned license description](https://github.com/FFmpeg/FFmpeg/blob/9b6c8969e05b4f0b29f0f85cd501be6b3e582e6b/LICENSE.md)
- [BtbN's pinned FFmpeg build command](https://github.com/BtbN/FFmpeg-Builds/blob/a99e8230eae00d1cee38f23076a7a1f55cd984e2/build.sh)
- [BtbN's pinned Windows base image](https://github.com/BtbN/FFmpeg-Builds/blob/a99e8230eae00d1cee38f23076a7a1f55cd984e2/images/base-win64/Dockerfile)
- [BtbN's pinned rav1e recipe](https://github.com/BtbN/FFmpeg-Builds/blob/a99e8230eae00d1cee38f23076a7a1f55cd984e2/scripts.d/50-rav1e.sh)

## Unblocking Full Studio

Replace this runtime with a reproducible minimal build whose container digest,
toolchain, dependency sources, submodules, and language lockfiles are immutable.
The build must emit and retain:

1. an exact component/revision inventory and link evidence;
2. unmodified upstream license and required notice files;
3. exact corresponding-source archives and build instructions;
4. the complete configure line, binary hashes, and the existing real media
   capability tests.

After a dependency-level review confirms the bundle is complete, change
`complianceStatus` to exactly `verified`, update the manifest hashes, and rerun
the public-release contract. No other status authorizes publication.

This engineering gate is not legal advice.
