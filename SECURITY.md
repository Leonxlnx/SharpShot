# Security policy

Please report security issues through [GitHub's private vulnerability-reporting form](https://github.com/Leonxlnx/SharpShot/security/advisories/new) instead of a public issue.

During normal use, SharpShot does not access the network or use elevated privileges. It reads desktop pixels only after the user invokes capture and writes only to the clipboard, `Pictures\SharpShot`, local settings, and the optional current-user startup entry.

The optional command-line self-test writes generated test patterns and a report to the output folder supplied by the person running it. The explicit `--self-test-live` variant also validates a desktop capture in memory but does not save those desktop pixels.
