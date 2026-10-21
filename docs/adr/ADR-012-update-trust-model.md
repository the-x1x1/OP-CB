# ADR-012 — Update trust model

Status: Accepted · 2026-09-21 · Package: `@worldview/updater`

## Decision

Updates flow GitHub Release → signed metadata (`latest.yml`) → download → signature/hash verification → install on restart. Until a Windows code-signing certificate is configured (`SIGNING_REQUIRED` blocker), builds are unsigned: the updater only checks, displays availability and lets the user install a test build manually; background download/auto-install is enabled by configuration once signing exists. Channels: `stable` and `prerelease` (opt-in); a prerelease can never replace a stable install unless the user opted in. No OS security setting is weakened to simulate silent updates.

## Amendments

- 2026-10-20 (automatic updates before signing, operator decision: "so I never work off an old version"): on Windows, where electron-updater installs through the NSIS installer, an **unsigned** build with Update automatically on (now the default; settings migration 008 turns it on once in older settings files) downloads a newer release in the background and installs it when the app quits, or at once when the operator presses **Restart to update** on the card the window shows (`components/update-notice.tsx`); the installer then runs silently and the app starts again. What protects the download until a certificate exists: it comes over HTTPS from the project's own GitHub release, and electron-updater checks it against the SHA-512 in that release's `latest.yml` before running it; the Authenticode check (`verifyUpdateCodeSignature`) applies as soon as builds are signed. That is the same trust as downloading the installer from the release page by hand, without the step. Never a downgrade, never a prerelease unless opted in, never while working offline. The app asks shortly after it starts (20 s) and every four hours. The Linux `.deb` is the package manager's to install: there the card says a version is available and nothing is downloaded.
