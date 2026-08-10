# Releasing SharpShot

The following are planned Windows x64 artifact names. They are not a claim that
these versions are already available on GitHub Releases.

| Planned asset | Current status |
| --- | --- |
| `SharpShot-Studio-Setup-0.2.0-alpha.1-win-x64.exe` | Full Studio installer; locally packageable, public distribution blocked |
| `SharpShot-Studio-0.2.0-alpha.1-win-x64.zip` | Full Studio portable; locally packageable, public distribution blocked |
| `SharpShot-Quick-1.5.0-win-x64.zip` | Lightweight capture-only portable; independently eligible for a verified draft prerelease |

Do not run Full Studio and Quick Capture simultaneously. Both register the same
global capture shortcuts, and Windows permits only one owner per chord.

## Release contracts

Studio is version `0.2.0-alpha.1` and uses the exact planned tag
`studio-v0.2.0-alpha.1`. Quick Capture remains `1.5.0` and uses the separate
exact tag `v1.5.0`. The workflows reject every other tag; update the code,
lockfile, scripts, documentation, and workflow guards together for a future
version.

All planned binaries are unsigned. Windows can show **Unknown publisher** or a
Microsoft Defender SmartScreen warning. Release notes must never imply that the
warning is bypassed; direct users to the adjacent checksum, the
[source](https://github.com/Leonxlnx/SharpShot), and the [MIT license](LICENSE).

The current Full Studio FFmpeg manifest is
`blocked-incomplete-third-party-inventory`. The two pinned upstream revisions
recorded in the runtime notice are useful provenance, but they are not complete
notice or corresponding-source coverage for the incorporated dependency graph.
Full Studio must not be publicly distributed until both the canonical and
packaged manifests say exactly `complianceStatus: verified`. See
[`COMPLIANCE-BLOCKED.md`](desktop/resources/ffmpeg/win32-x64/COMPLIANCE-BLOCKED.md).
Quick Capture contains no FFmpeg runtime and is eligible for release
independently.

## Build all three packages locally

Local development packages remain available while Full public distribution is
blocked. From the repository root on Windows, run:

```powershell
.\build.ps1

Push-Location .\desktop
try {
    npm ci
    npm audit --audit-level=high
    npm run release:verify-static
    npm test
    npm run media:vendor
    npm run media:smoke
    npm run package:win
}
finally {
    Pop-Location
}
```

This produces the Quick ZIP under `artifacts\native` and the Full installer and
portable ZIP under `artifacts\desktop`. `package:win` verifies the unsigned NSIS
bootstrap, extracts its embedded x64 application with electron-builder's pinned
7-Zip, and subjects that payload and the portable ZIP to the same runtime,
legal-notice, architecture, version, and production-content checks. It does not
run the installer.

These commands do not create a tag, commit, push, release manifest, or GitHub
release. Treat the Full outputs as local-only development artifacts while the
compliance marker is blocked. Do not copy them into a public release manually.

## Conditional Full draft workflow

The guarded root `release.ps1` is the public Full release path; it is not a
compliance bypass or the local-build command above. It requires a clean commit
carrying the exact Studio tag and checks the canonical compliance marker before
starting the heavy pipeline. With the current blocked marker it stops before
building.

Only after the inventory is completed and independently reviewed may the marker
be changed to `verified`. The script will then run the native self-tests,
`npm ci`, dependency audit, static release checks, Studio tests, media vendoring
and smoke checks, Windows packaging, packaged-runtime compliance checks, and
Setup extraction verification. It assembles exactly:

```text
SharpShot-Studio-Setup-0.2.0-alpha.1-win-x64.exe
SharpShot-Studio-0.2.0-alpha.1-win-x64.zip
SharpShot-Quick-1.5.0-win-x64.zip
release-manifest.json
SHA256SUMS.txt
```

There is no skip-tests option. The manifest has stable metadata with no
generation timestamp and records the exact tag, source commit, platform, file
size, SHA-256, and `authenticode: unsigned` for every package. The checksum file
contains exactly the three packages plus the manifest—never itself, a path,
duplicate, or partial name. Outputs are tested and hash-verified, not claimed to
be bit-for-bit reproducible across build machines.

`.github/workflows/release.yml` uses the same exact tag and compliance gate. Its
unprivileged build job may transfer only the five-file allowlist. A separate
write-enabled job revalidates the tag commit, manifest, hashes, package metadata,
and `complianceStatus: verified` before it can call
`gh release create --verify-tag --draft --prerelease --latest=false`. The current
blocked runtime therefore cannot reach the draft job.

## Quick-only draft workflow

`.github/workflows/quick-release.yml` accepts only the existing exact `v1.5.0`
tag. Its read-only build job compiles and self-tests Quick Capture, asserts the
ZIP contains no FFmpeg executable, probe, or DLL, and produces the ZIP plus its
SHA-256 file. A separate write-enabled job rechecks the tag commit, two-file
allowlist, checksum, and FFmpeg-free archive before creating a draft prerelease
with `--verify-tag --draft --prerelease --latest=false`.

Neither workflow publishes a non-draft release automatically. Review any draft,
download it on a clean Windows machine, verify its checksum, test one edition at
a time, and only then publish it manually.

GitHub's guidance recommends full commit-SHA pins for Actions and draft-first
release assembly:

- [Secure use of GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [`gh release create`](https://cli.github.com/manual/gh_release_create)
