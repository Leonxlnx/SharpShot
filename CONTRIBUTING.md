# Contributing

Thanks for helping improve SharpShot.

## Before opening a pull request

1. Keep changes focused and avoid third-party dependencies unless one has a clear, measured benefit.
2. Preserve the `Win + Shift + D → drag → release` screenshot interaction and the `Win + Shift + A → drag → 3, 2, 1 → record` interaction.
3. Keep all UI text and documentation in clear English.
4. Run `.\build.ps1` on Windows for native changes and include the self-test result in the pull request.
5. For capture or DPI changes, test screenshots and recording selection at 100%, 125%, 150%, and 200% display scaling when possible.
6. Do not add copied product icons, Apple artwork, or assets without a clear
   redistribution license and recorded provenance.

## Studio changes

SharpShot Studio is under `desktop/`. Use Node.js 22.12 or newer and run:

```powershell
Set-Location .\desktop
npm ci
npm run release:verify-static
npm test
npm run typecheck
npm run build
```

Changes to export planning or the media runtime should also pass:

```powershell
npm run media:verify
npm run media:smoke
```

The large FFmpeg executables and DLLs are restored from a pinned, hash-verified
archive and ignored by Git. This is verifiable vendoring, not a claim that
independent builds are byte-for-byte reproducible. Do not commit an arbitrary
local FFmpeg build. Asset additions need a
source URL or original-generation record, license, retrieval date where
applicable, and a SHA-256 in the relevant manifest. See
[`desktop/README.md`](desktop/README.md) and
[`THIRD_PARTY_ASSETS.md`](THIRD_PARTY_ASSETS.md).

Generated `artifacts`, native/media runtimes, test screenshots, and local design
studies are intentionally ignored. Do not stage generated executables, packages,
or personal capture media. Release operators should follow
[`RELEASING.md`](RELEASING.md); pull requests must not create tags or releases.

## Bug reports

Please include:

- Windows version;
- SharpShot version;
- monitor count, resolution, and display scaling;
- the selected quality mode;
- exact steps to reproduce the issue;
- what you expected and what happened;
- whether the issue occurs in Native 1× mode.

Do not attach screenshots containing secrets or private workspace content.
