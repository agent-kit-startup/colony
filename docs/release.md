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
| Game content deploy key | a read-only deploy key on the private `agent-kit-startup/colony-game` (title `colony release (read-only)`); its private key is the secret `COLONY_GAME_DEPLOY_KEY` of the Environment `game-content`, whose deployment policy admits only `v*` tags. The release job names that Environment and reads `content/catalog.json` with it (see [Game content](../README.md#game-content)). | operator, owed |
| CI auth without surprise expiry | the release job uses only the per-run `GITHUB_TOKEN`, the signing key and the game content deploy key (none expires) | - |
| Download host | the GitHub Releases of this public repository (default base of `install.sh`; operator decision `Usar GitHub Releases`, 2026-10-23). No separate release host. | - |
| `colony.missionkit.io` | a redirect only: `/install.sh` to `https://github.com/agent-kit-startup/colony/releases/latest/download/install.sh` (and `/` to the repository). DNS and the redirect are not set up yet. | operator, owed |

## Cutting a release

1. Bump the same version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` (merged to `main`).
2. Push the tag `v<version>` on that commit. Pushing a tag is a release: operator only.
3. `.github/workflows/release.yml` checks that the tag matches the three versions and that the signing key secret exists (it refuses an unsigned release), fetches the game's catalog from `agent-kit-startup/colony-game` with the `game-content` deploy key and checks it against the engine (an official release without the key or the file fails here), builds with `pnpm tauri build`, runs `cargo test`, assembles the files with `packaging/make-release.sh`, signs `SHA256SUMS` with `pnpm tauri signer sign`, installs the result with `packaging/install.sh` from a `file://` base on the runner, and creates the GitHub release with the files.
4. A plain `v<x.y.z>` tag becomes the **Latest** release, which is what `install.sh` installs by default. A tag with a pre-release suffix (`v0.2.0-rc.1`) is created as a prerelease: GitHub never reports a prerelease as latest, so it is only installed with `--version 0.2.0-rc.1`. The version check of step 3 still applies, so the three version files must carry the same suffixed version. The suffix carries into every file name as is: `v0.3.0-rc.1` produced `colony-0.3.0-rc.1-linux-x86_64.tar.gz`, `Colony_0.3.0-rc.1_amd64.deb` and `Colony_0.3.0-rc.1_amd64.AppImage` (release run 41219807456).

Release files:

| File | What |
|------|------|
| `colony-<version>-linux-x86_64.tar.gz` | `colony-<version>-linux-x86_64/colony` (binary, direct channel) and `colony.png` (icon): what `install.sh` installs |
| `colony-<version>-linux-x86_64-package.tar.gz` | the same layout, binary built with `--no-default-features` (package channel, no updater): the source of distro packages (AUR `missionkit-colony-bin`, omarchy-pkgs; see [Arch package (AUR)](#arch-package-aur)) |
| `Colony_<version>_amd64.deb` | the Tauri `.deb` bundle (system install with `sudo apt install ./Colony_...deb`) |
| `Colony_<version>_amd64.AppImage` | the Tauri AppImage (direct channel): the build that updates itself in place |
| `Colony_<version>_amd64.AppImage.sig` | its updater signature (`createUpdaterArtifacts`, release key) |
| `latest.json` | the updater manifest (`tauri-plugin-updater` static JSON): version, notes, date and the AppImage entry `linux-x86_64-appimage` (URL + signature) |
| `install.sh` | the installer of this release |
| `SHA256SUMS` | sha256 of every file above |
| `SHA256SUMS.sig` | base64 of a minisign signature of `SHA256SUMS` by key `9A9BB4349C2248C6` |

## App updates and distribution channels

The channel is chosen at build time with a Cargo feature (`src-tauri/src/appupdate.rs`); a tag builds both:

| Channel | Build | Updates |
|---------|-------|---------|
| `direct` (default feature `channel-direct`) | `pnpm tauri build` | The official `tauri-plugin-updater` reads `https://github.com/agent-kit-startup/colony/releases/latest/download/latest.json` (prereleases are never "latest", so they never reach it), checks the minisign signature of the download against `plugins.updater.pubkey` (the release key `9A9BB4349C2248C6`, the same key `install.sh` pins) with `requireSignedVersion` (the signed trusted comment must name the announced version: no downgrade through a crafted `latest.json`), and installs it in place. User-started only: `Help → About Colony… → Check for updates / Update and restart`; nothing checks on a timer or at startup. |
| `package` | `pnpm tauri build --no-bundle -- --no-default-features` | The updater crate is not compiled in. About says updates come from the package manager (`pacman -Syu` on Arch and Omarchy). AUR `missionkit-colony-bin` and omarchy-pkgs package the `-package` tarball. |

What updates in place, on Linux: the plugin (2.14) installs an AppImage (rewrites the file, per user, no root) or a `.deb`/`.rpm` (as root through `pkexec dpkg -i` / `rpm -U`). It has no installer for the per-user tarball of `install.sh`; an unmarked binary falls through to the AppImage routine, which would overwrite it with AppImage bytes. So Colony installs in place only when it runs from the AppImage (`APPIMAGE` set and the AppImage bundle marker). From the tarball the check still says whether a newer release exists, and the update is the install line again (it keeps the previous version); from the `.deb` it is the newer `.deb`. `latest.json` lists only the AppImage.

`createUpdaterArtifacts` is passed with `--config` in the release workflow, not set in `tauri.conf.json`, so a local `pnpm tauri build` needs no signing key. The release workflow fails when the AppImage signature or `latest.json` is missing.

## Arch package (AUR)

`packaging/aur/missionkit-colony-bin/` holds the files of the AUR package `missionkit-colony-bin`: `PKGBUILD`, `.SRCINFO` and two desktop entries. The package is not `colony-bin`: that AUR name belongs to Project-Colony's launcher, another project, whose package installs `/usr/bin/colony`, `colony.desktop` and the hicolor `colony.png`.

So that the two packages share no file and install side by side, this one installs everything as `colony-hde` (HDE: Hybrid Development Environment). It declares no conflict with `colony-bin` and does not provide `colony`:

| Installed file | From |
|----------------|------|
| `/usr/bin/colony-hde` | `colony` of the `-package` tarball, unchanged |
| `/usr/share/applications/colony-hde.desktop` | `Exec=colony-hde %f`, `Icon=colony-hde`, `StartupWMClass=colony-hde` |
| `/usr/share/applications/colony-hde-handler.desktop` | the `colony://play` link: `Exec=colony-hde %u`, `MimeType=x-scheme-handler/colony;`, hidden from launchers |
| `/usr/share/icons/hicolor/256x256/apps/colony-hde.png` | `colony.png` of the tarball |
| `/usr/share/licenses/missionkit-colony-bin/NOTICE`, `seti-ui.MIT.txt` | the repository at the release tag |

What the other name changes at run time:

- The command is `colony-hde`, and so are the window class and app id (GTK takes them from the name the binary was started with), which is why the desktop entry says `StartupWMClass=colony-hde`. A Hyprland rule or `omarchy-launch-or-focus` call written for the curl install's `colony` class does not match the packaged window.
- Single instance, `File → New window` and the host-request CLI use the path of the running binary and need nothing.
- `Settings → Omarchy integration…` writes the menu entries and the bar widget with the name of the running binary (`command_name` in `src-tauri/src/omarchy_shell.rs`), so they run `colony-hde`. Releases up to v0.5.1 wrote `colony` there: package a release that has this change.
- Settings, the managed engine and the Node runtime stay in `~/.config/colony` and `~/.local/share/colony`, shared with a curl install of the same user. The curl install is unchanged (`~/.local/bin/colony`).

Bumping the package to a new release (stable versions only: a `pkgver` cannot carry a pre-release suffix):

1. Download `SHA256SUMS` and `SHA256SUMS.sig` of the release and check the signature: `base64 -d SHA256SUMS.sig > SHA256SUMS.minisig`, then `minisign -Vm SHA256SUMS -x SHA256SUMS.minisig -P <PUBKEY of packaging/install.sh>`.
2. Set `pkgver` (and `pkgrel=1`) in `PKGBUILD`, put the `-package.tar.gz` line of the verified `SHA256SUMS` first in `sha256sums`, and refresh the two license file sums if `NOTICE` or `licenses/seti-ui.MIT.txt` changed at the tag (`updpkgsums` rewrites all five).
3. `makepkg -f` in a scratch copy of the folder, list the result with `bsdtar -tf`, then `makepkg --printsrcinfo > .SRCINFO`. `pnpm test` (`scripts/aurpkg.test.mjs`) checks the folder: the file names, the desktop entries, the pinned sums of the local files and that `.SRCINFO` matches `PKGBUILD`.
4. Operator only: push `PKGBUILD`, `.SRCINFO` and the two desktop entries to the AUR repository. Set the `# Maintainer:` line to the AUR account before the first push.

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

## Engine signature

The engine Colony installs is a kit release, not part of the Colony release, and it has its own key. `ENGINE_SIGNING_PUBKEY` in `src-tauri/src/engine.rs` pins the kit's engine signing public key (minisign key id `EE66495404D7ADCF`). The kit's tag CI signs the engine's `SHA256SUMS` with the secret `ENGINE_SIGNING_KEY` and publishes `SHA256SUMS.minisig` next to it. `Install engine` and `Update engine` download that file, check it over `SHA256SUMS` before the sha256 is trusted, and refuse a release without a valid one.

- Kit releases up to v6.16.1 have no `SHA256SUMS.minisig`, so a Colony built with the key does not install them, by version or as the newest one. An engine that is already installed keeps running and stays available to `Roll back`: the check runs when an engine is installed, not when it starts.
- The updater installs the newest kit release inside `ENGINE_PROTOCOL_RANGE` and does not fall back to an older signed one: when that newest release is unsigned, the install fails with `this release has no engine signature`.
- Before cutting a Colony release, check that the newest kit release inside the range is signed by the pinned key, or a fresh install has no engine to install. Download its `SHA256SUMS` and `SHA256SUMS.minisig` into one folder, then `minisign -Vm SHA256SUMS -P <the RW... line>`, or `COLONY_TEST_ENGINE_SUMS=<folder>/SHA256SUMS cargo test --manifest-path src-tauri/Cargo.toml -- --ignored the_pinned_key_verifies_a_kit_release`.
- A new key means a new Colony release: the key is a constant in the binary.

## Not yet

- `install.sh` installing the AppImage (so the curl install updates itself too): the AppImage needs FUSE (`fuse2`) on the host, which Omarchy and Arch do not install by default.
- macOS and Windows builds, arm64.
