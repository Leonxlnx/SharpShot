# Security policy

Please report security issues through [GitHub's private vulnerability-reporting form](https://github.com/Leonxlnx/SharpShot/security/advisories/new) instead of a public issue.

During normal use, SharpShot does not access the network or use elevated privileges. It reads desktop pixels only after the user invokes a screenshot or recording. Screenshots can be written to the clipboard and, when enabled, `Pictures\SharpShot`; completed recordings are finalized in that folder and copied to the clipboard as file-drop paths. Other persistent state is limited to local settings, runtime status, and the optional current-user startup entry.

Current Windows builds reserve `Win + Shift + A`. If the normal hotkey API refuses that chord, SharpShot installs a low-level keyboard hook for the running user session. The hook recognizes and suppresses only the exact recording chord, stores no events, text, or timings, and is removed on exit. It cannot access the UAC secure desktop.

The optional command-line self-test writes generated test patterns and a report to the output folder supplied by the person running it. The explicit `--self-test-live` variant also validates live desktop capture and H.264 encoding. Its temporary desktop-video probe is written only inside the supplied output folder and deleted before the test returns.

## SharpShot Studio alpha

Studio uses the same local native capture code through a short-lived helper. The
Electron renderer is sandboxed with context isolation and no Node integration;
the preload exposes a narrow API, IPC payloads and storage schemas are
validated, permissions and arbitrary navigation are denied, and local media is
served only through a restricted application protocol. FFmpeg and ffprobe are
invoked as child processes with argument arrays rather than shell command
strings.

Studio has no account, cloud upload, analytics, or telemetry service. An
explicit wallpaper-help action can open an allowlisted HTTPS URL in the system
browser. The packaged app does not fetch the linked artwork. The development
vendoring script can download one pinned FFmpeg archive and rejects a byte-size
or SHA-256 mismatch; an offline archive can be supplied instead.

Studio stores screenshots under `Pictures\SharpShot Studio\Screenshots`,
recordings under `Videos\SharpShot Studio\Recordings`, and exports at the
destination selected by the user. Settings/workflows/library/project JSON live
under Electron's per-user application-data directory. Imported media remains
on the local device. Startup registration is per-user and requires no
administrator rights.

Alpha executables and installers are not code-signed. Verify published
checksums or build from source before dismissing a Windows SmartScreen warning.

Release automation builds with read-only repository permissions, verifies an
existing version tag and clean tree, and transfers an exact checksummed asset
allowlist to a separate write-enabled draft job. Full Studio automation also
requires both canonical and packaged FFmpeg manifests to report verified
release compliance; the current runtime is blocked from public distribution.
Quick Capture has a separate FFmpeg-free draft workflow. This separation does
not replace code signing; any published binaries remain unsigned.
