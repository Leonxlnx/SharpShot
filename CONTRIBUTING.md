# Contributing

Thanks for helping improve SharpShot.

## Before opening a pull request

1. Keep changes focused and avoid third-party dependencies unless one has a clear, measured benefit.
2. Preserve the screenshot and recording flows documented in README.
3. Keep all UI text and documentation in clear English.
4. Run `.\build.ps1` on Windows and include the self-test result in the pull request.
5. For capture or DPI changes, test at 100%, 125%, 150%, and 200% display scaling when possible.
6. Do not add Studio, Electron, FFmpeg, telemetry, or network dependencies to the Quick branch.

## Bug reports

Please include:

- Windows version;
- SharpShot version;
- monitor count, resolution, and display scaling;
- the selected quality mode;
- exact steps to reproduce the issue;
- what you expected and what happened;
- whether the issue occurs in Native 1× mode.
- for video issues, the selected resolution, approximate duration, and whether hardware encoding was available.

Do not attach screenshots containing secrets or private workspace content.
