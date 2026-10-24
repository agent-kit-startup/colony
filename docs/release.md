# Release and install

How a Colony release is built, signed, published and installed. Linux x86_64 only for now.

## Identity checklist

Colony publishes under its own identity, not the personal `dadado` account (the kit's plan `mission-kit-desktop-ide-2026-10-08`, to-do `phase3-distribution-identity-and-curl-install` (a)).

| Item | State (2026-10-19) | Owner |
|------|--------------------|-------|
| Publishing account | `agent-kit-startup` (a GitHub user account, not an org), 2FA on | operator |
| GitHub App `Colony Release (agent-kit-startup)` | App ID 5382060, Contents read/write only, webhook off, installed on `agent-kit-startup/colony` only; secrets `COLONY_RELEASE_APP_ID`, `COLONY_RELEASE_APP_PRIVATE_KEY` set. Not used by the release workflow yet (it uses the run's own `GITHUB_TOKEN`); kept for publishing to a second repository. | operator |
| App private key (`.pem`) | in `~/.config/colony-release/` (700 / 600); move into the password manager | operator, owed |
| Release signing key | Tauri signer key (minisign format), key id `9A9BB4349C2248C6`, private key in the operator's `~/.tauri/colony-updater.key`; secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set. The public key is pinned in `packaging/install.sh`. | operator |
| npm account | none: Colony is not on npm, and installs without npm | - |
| CI auth without surprise expiry | the release job uses only the per-run `GITHUB_TOKEN` and the signing key (no expiry) | - |
| Download host | the GitHub Releases of this public repository (default base of `install.sh`; operator decision `Usar GitHub Releases`, 2026-10-23). No separate release host. | - |
| `colony.missionkit.io` | a redirect only: `/install.sh` to `https://github.com/agent-kit-startup/colony/releases/latest/download/install.sh` (and `/` to the repository). DNS and the redirect are not set up yet. | operator, owed |

## Cutting a release

1. Bump the same version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` (merged to `main`).
2. Push the tag `v<version>` on that commit. Pushing a tag is a release: operator only.
3. `.github/workflows/release.yml` checks that the tag matches the three versions and that the signing key secret exists (it refuses an unsigned release), builds with `pnpm tauri build`, runs `cargo test`, assembles the files with `packaging/make-release.sh`, signs `SHA256SUMS` with `pnpm tauri signer sign`, installs the result with `packaging/install.sh` from a `file://` base on the runner, and creates the GitHub release with the files.
4. A plain `v<x.y.z>` tag becomes the **Latest** release, which is what `install.sh` installs by default. A tag with a pre-release suffix (`v0.2.0-rc.1`) is created as a prerelease: GitHub never reports a prerelease as latest, so it is only installed with `--version 0.2.0-rc.1`. Use a suffix for a test release.

Release files:

| File | What |
|------|------|
| `colony-<version>-linux-x86_64.tar.gz` | `colony-<version>-linux-x86_64/colony` (binary) and `colony.png` (icon): what `install.sh` installs |
| `Colony_<version>_amd64.deb` | the Tauri `.deb` bundle (system install with `sudo apt install ./Colony_...deb`) |
| `install.sh` | the installer of this release |
| `SHA256SUMS` | sha256 of the three files above |
| `SHA256SUMS.sig` | base64 of a minisign signature of `SHA256SUMS` by key `9A9BB4349C2248C6` |

## Where `install.sh` downloads from

This repository is public, so its GitHub release files download anonymously and the GitHub Release is the download base; nothing is copied anywhere else.

- Latest version: the tag `https://github.com/agent-kit-startup/colony/releases/latest` redirects to (`.../releases/tag/v<version>`), read from the redirect without the GitHub API (no rate limit, no JSON). With no published release the redirect lands on `.../releases` and the installer says so.
- Files: `https://github.com/agent-kit-startup/colony/releases/download/v<version>/<file>`, the same `<base>/v<version>/<file>` shape as a local base.
- The installer itself: `https://github.com/agent-kit-startup/colony/releases/latest/download/install.sh` (the release attaches its own `install.sh`). `https://colony.missionkit.io/install.sh` is only a redirect to it (operator, owed).

`COLONY_DOWNLOAD_BASE` (`https://` or `file://`) replaces the GitHub base, for tests or a mirror. With it set, the latest version is read from `<base>/LATEST` (one line), as the release workflow and the install smoke do:

```
<base>/LATEST                         one line: the latest version
<base>/v<version>/...                 the release files listed above
```

## Installing

```bash
curl -fsSL https://github.com/agent-kit-startup/colony/releases/latest/download/install.sh | sh
curl -fsSL https://github.com/agent-kit-startup/colony/releases/latest/download/install.sh | sh -s -- --version 0.1.0
curl -fsSL https://github.com/agent-kit-startup/colony/releases/latest/download/install.sh | sh -s -- --uninstall
```

`install.sh` (POSIX `sh`, no sudo):

1. Resolves the latest release (GitHub `releases/latest`, or `<base>/LATEST` when `COLONY_DOWNLOAD_BASE` is set) unless `--version` or `COLONY_VERSION` names one.
2. Downloads `SHA256SUMS` and `SHA256SUMS.sig` and checks the signature against the pinned public key: with `minisign` when it is installed, else with OpenSSL 3 (Ed25519 over the BLAKE2b-512 hash, then the global signature over the trusted comment: the checks minisign makes). With neither it stops and says which package to install. It never installs unverified.
3. Downloads the tarball and checks its sha256 against `SHA256SUMS`.
4. Installs into `${XDG_DATA_HOME:-~/.local/share}/colony/app/<version>/`, points `colony/app/current` at it, writes the launcher `~/.local/bin/colony` and the desktop entry `colony.desktop`, keeps the version it replaced (go back with `--version`) and removes older ones. It refuses to overwrite a `~/.local/bin/colony` it did not write (for example the one from `packaging/install-local-launcher.sh`).
5. Warns when `webkit2gtk-4.1` is missing or the launcher folder is not on `PATH`.

`--uninstall` removes the app folder, the launcher (only if this installer wrote it) and the desktop entry. The managed engine (`colony/engine`), the Node runtime (`colony/runtime`) and the settings (`~/.config/colony`) stay, and their paths are printed.

Environment: `COLONY_DOWNLOAD_BASE` (`https://` or `file://`; default `https://github.com/agent-kit-startup/colony/releases/download`), `COLONY_VERSION`, `COLONY_BIN_DIR` (default `~/.local/bin`).

## Smoke

`packaging/smoke/install-smoke.sh` runs offline: it signs a fake release (stub binary, built with `packaging/make-release.sh`) with a throwaway key, serves it over `file://` and installs it into a scratch `HOME` with a `PATH` without `minisign`. Checks: the install with the OpenSSL verifier (and with `minisign` when installed), refusal of a changed `SHA256SUMS`, of a signature by another key, of a changed trusted comment, of a changed tarball and of a non-https base, an upgrade that keeps exactly the previous version, the uninstall (engine kept), and that a foreign launcher is not overwritten.

## Not yet

- The Tauri updater (`tauri-plugin-updater` with `plugins.updater.pubkey` in `tauri.conf.json`): the signing key is the updater key, so turning it on later needs no new key.
- macOS and Windows builds, arm64, AppImage.
- The managed engine's own signature check (`ENGINE_SIGNING_PUBKEY` in `src-tauri/src/engine.rs`) waits for the kit's engine signing key.
