# Mission Kit Colony

Colony is the Mission Kit desktop IDE: a Tauri 2 cockpit with Mission Control as its home screen. It drives the open [Agent Kit](https://github.com/agent-kit-startup/agent-kit) CLI and each vendor's own agent on the user's own subscription or API key.

Private, closed-source product repository. No open-source license is granted.

## Status

Cockpit alpha. Linux (Omarchy / Hyprland) is the first target.

| Area | What works |
|------|------------|
| Workspace | `Open folder` (Ctrl+O), the folder as the first CLI argument, recent folders on the welcome screen. File access is limited to the opened folder. |
| Mission Control | Home tab: the installed kit's unforked dashboard server, started for the opened folder on a free loopback port. |
| Explorer | Lazy file tree (`.git` hidden), refresh button. |
| Editor | Monaco with one tab per file, dirty marker, Ctrl+S save, Ctrl+W close (asks before dropping unsaved changes), Ctrl+P quick open. |
| Terminals | Real PTYs running your `$SHELL` in the opened folder, several tabs (`+` or Ctrl+Shift+T), Ctrl+` to show / hide, Ctrl+Shift+C / Ctrl+Shift+V copy and paste (wired, not yet verified on WebKitGTK). |
| Agent | `agent-kit run-plan --events ndjson` for the opened folder (backend picker, tick budget), live NDJSON event log, HITL gates answered from buttons or free text, "Stop at gate" and "Kill". Needs a folder with the kit installed and an active plan. |
| Git | Status, per-file diff, commit (optionally `git add -A`; hooks always run), push without force. Pushing `main`, `master`, `prod`, `production` or `release` needs a typed `yes`. |

Not yet: cross-vendor HITL inbox, per-tick review diff, engine picker per to-do, OS keychain, "Open in my editor", real Mission Control host actions (the panel still copies), signed bundles.

## Requirements (Linux)

- Rust stable via rustup (`~/.cargo/bin` on PATH for builds).
- Node.js 20+ and pnpm 10.
- Tauri 2 system libraries: `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `base-devel` (Arch package names).
- The Agent Kit CLI on PATH: `npm i -g @dadado/agent-kit-cli` (provides `agent-kit` and `dashboard/serve.mjs`).

## Build and run

```bash
pnpm install --frozen-lockfile
pnpm tauri dev                   # development, hot reload on http://localhost:1420
pnpm tauri build                 # release binary + .deb bundle
./src-tauri/target/release/colony ~/code/some-repo
```

`pnpm tauri build` writes `src-tauri/target/release/colony` and `src-tauri/target/release/bundle/deb/Colony_<version>_amd64.deb`. A plain `cargo build --release` is not enough for a runnable binary: the Tauri CLI enables the custom protocol that serves the built frontend.

## Launcher (per user, no sudo)

```bash
pnpm tauri build
packaging/install-local-launcher.sh
```

This writes `~/.local/bin/colony` (wrapper around `src-tauri/target/release/colony`) and `~/.local/share/applications/colony.desktop`, so Colony shows up in the app launcher. `colony ~/code/some-repo` opens a folder directly. Rebuilding updates the same binary; the launcher does not need to be reinstalled.

## Runtime environment

| Variable | Effect |
|----------|--------|
| `WEBKIT_DISABLE_DMABUF_RENDERER` | Colony sets it to `1` at startup on NVIDIA + Wayland (WebKitGTK's DMA-BUF renderer hangs there; found in the Colony UI benchmark). A value you set yourself always wins. |
| `COLONY_ENABLE_DMABUF=1` | Keep the DMA-BUF renderer on NVIDIA + Wayland. |
| `COLONY_AGENT_KIT_BIN`, `COLONY_NODE_BIN`, `COLONY_GIT_BIN` | Use these binaries instead of the ones found on PATH. |
| `COLONY_DASHBOARD_SERVE` | Path to a `dashboard/serve.mjs` to run instead of the one next to the installed `agent-kit`. |
| `COLONY_SMOKE=<log file>` | Code-path smoke: after the folder opens, open `README.md`, append a line and save, run `echo colony-ok-$((6*7)) > smoke.txt` in a terminal, read git status, start a one-tick driver run, log each step as JSON to the file, then exit. Use a scratch folder: it edits `README.md` and writes `smoke.txt`. During the smoke Colony does not focus the editor or the terminal, but the window itself may still take focus from your compositor. |

A desktop launcher often starts apps without your shell's PATH. Colony appends `~/.local/share/mise/shims`, `~/.local/bin`, `~/.cargo/bin` and the newest mise Node install to PATH at startup, so the dashboard server and the CLI resolve the same tools as your terminal.

## Mission Control embedding

Colony follows the kit's embeddable contract (`docs/mission-control-embedding.md` in the kit): it runs `node <agent-kit package>/dashboard/serve.mjs` with `MISSION_CONTROL_REPO_ROOT=<opened folder>` and `PORT=<free port>`, loads `http://127.0.0.1:<port>/` in the home pane, and defines `window.__MISSION_CONTROL_ACTIONS__` inside that frame only. In the alpha the hook still copies to the clipboard: no host action ships before the interpolation review the contract requires. The server is stopped when Colony exits (also on a crash, through a parent-death signal). Its log is under `~/.cache/colony/dashboard-<port>.log`.
