# Privacy

Colony collects no telemetry. It sends no usage events, crash reports, identifiers or prompt text anywhere, and it has no account or sign-in of its own.

## Network calls Colony makes itself

Colony opens a network connection on its own only when you ask for one of these actions in `Run → Engine…` or `Help → About Colony…`:

| Action | Request | Code |
|--------|---------|------|
| `Install engine` / `Update engine` with no version typed | GET `https://api.github.com/repos/<repo>/releases?per_page=30` (the release list; default repo `agent-kit-startup/agent-kit`, `COLONY_ENGINE_REPO` overrides it), then the small `engine.json` of the newest releases from the release downloads until one speaks a driver protocol this Colony installs | `src-tauri/src/engine.rs` (`latest_version`) |
| `Install engine` / `Update engine` | GET `agent-kit-engine-<version>.tar.gz`, `SHA256SUMS` (and `SHA256SUMS.minisig` once an engine signing key is configured) from the release downloads (default `https://github.com/<repo>/releases/download`, `COLONY_ENGINE_DOWNLOAD_BASE` overrides it) | `src-tauri/src/engine.rs` (`download_base`, `install_engine`) |
| `Check for updates` / `Update and restart` (direct builds only; package builds do not contain the updater) | GET `https://github.com/agent-kit-startup/colony/releases/latest/download/latest.json`, and for `Update and restart` the AppImage it names, through `tauri-plugin-updater` (its own HTTPS client, not `curl`; the download is checked against the release key before it is installed) | `src-tauri/src/appupdate.rs` |
| `Install Node runtime` | GET the pinned official Node build and `SHASUMS256.txt` from `https://nodejs.org/dist` (`COLONY_NODE_DIST_BASE` overrides it) | `src-tauri/src/engine.rs` (`install_node`) |

Each of these is a download of public files, made with the system `curl` except the app update. Nothing runs on a timer or at startup.

## Tools Colony starts for you

Colony starts other programs on your machine, and those programs make their own network calls under your own login:

- The Agent Kit engine and each vendor's agent CLI (`claude`, `codex`, Cursor `agent`) talk to their vendor. Colony passes them no credentials and reads none; they use the login or API key you set up for them.
- `git` and `gh` (Git, Pull requests and CI/CD views, host requests you approve) talk to your git remote and to GitHub, exactly as they do in your own terminal.
- The Mission Control web panel is the engine's local dashboard server on `127.0.0.1`.

## Data that stays on your machine

Settings live in `~/.config/io.missionkit.colony/settings.json`. The managed engine and Node runtime live under `~/.local/share/colony/`. The Chats card and the Context sources strips read local file titles, sizes and line counts only; they do not upload them.

## License

The software is Apache-2.0, as is, with no warranty. See [LICENSE](LICENSE).
