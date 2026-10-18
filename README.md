# Mission Kit Colony

Colony is the Mission Kit desktop IDE: a Tauri 2 cockpit with Mission Control as its home screen. It drives the open [Agent Kit](https://github.com/agent-kit-startup/agent-kit) CLI and each vendor's own agent on the user's own subscription or API key.

Private, closed-source product repository. No open-source license is granted.

## Status

Cockpit alpha. Linux (Omarchy / Hyprland) is the first target.

| Area | What works |
|------|------------|
| Workspace | `Open folder` (Ctrl+O), the folder as the first CLI argument, recent folders on the welcome screen. File access is limited to the opened folder. |
| Mission Control | Home tab: the installed kit's unforked dashboard server, started for the opened folder on a free loopback port. "Copy path" opens the file in Colony and the run command starts an Agent run after you confirm; every other action still copies (see Mission Control embedding). |
| Explorer | Lazy file tree (`.git` hidden), refresh button. |
| Editor | Monaco with one tab per file, dirty marker, Ctrl+S save, Ctrl+W close (asks before dropping unsaved changes), Ctrl+P quick open. |
| Terminals | Real PTYs running your `$SHELL` in the opened folder, several tabs (`+` or Ctrl+Shift+T), Ctrl+` to show / hide, Ctrl+Shift+C / Ctrl+Shift+V copy and paste (wired, not yet verified on WebKitGTK). |
| Agent | `agent-kit run-plan --events ndjson` for the opened folder, or for another folder with `Run in folder…` (engine picker, tick budget). Several runs at once, one per folder (the kit has no run lock); pick which one to follow. Live NDJSON event log, HITL gates answered from buttons or free text, "Stop at gate" and "Kill". Needs a folder with the kit installed and an active plan. |
| Open in my editor | `Open in editor` (Ctrl+Shift+E) hands the active file, or the folder from the Mission Control tab, to your own editor; right-click a file or folder in the Explorer for that one. |
| Inbox | `Inbox` (badge = open decisions): every open HITL gate from every run in this window, any engine, oldest first, with the run's folder, engine, plan and tick. A button or free text answers it: the driver-protocol line `{"type":"hitl_reply","askId":...,"reply":...}` goes to that run's stdin only. A card leaves when it is answered, the tick ends or the run exits. Colony never answers a gate by itself. |
| Engine picker | Per run: engine (`--backend`: `claude`, `codex`, `cursor-acp`, `cursor-agent`, `auto`; the ones not on PATH are marked), `--on-limit` engine for the next fresh tick after a vendor usage limit, optional `--model`, tick budget. Each choice is remembered for the opened folder in the settings file. The note under the picker says how a gate answer reaches that engine (`cursor-agent` has no input channel: a gate ends the tick). |
| Review | `◇ Review` tab: every tick of every run in this window with the files it changed (added, modified, deleted, renamed; new untracked files included, `.gitignore` respected), a Monaco side-by-side diff per file, commits made during the tick, the `LOOP_TICK_RESULT` line, "Copy patch". A tick is the working tree change from the previous tick end (or the run start) to its own end, captured as git tree objects through a throwaway index, so your index, worktree and refs are never touched; an edit you make between two ticks shows up in the next tick. A run killed mid-tick still gets its partial tick. |
| Git | Status, per-file diff, commit (optionally `git add -A`; hooks always run), push without force. Pushing `main`, `master`, `prod`, `production` or `release` needs a typed `yes`. |

Not yet: engine choice per to-do (the CLI picks the backend per run), OS keychain for vendor keys (left out: the product plan says the IDE never reads, stores or relays vendor tokens; the agent CLIs keep their own login), signed bundles.

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

## Settings

`~/.config/io.missionkit.colony/settings.json` (the ⚙ button creates it and opens it in a Colony tab). Read on every use: a saved edit applies at once.

```json
{
  "editor": { "command": ["zed", "{path}"], "terminal": false },
  "workspaces": { "/home/me/code/repo": { "backend": "claude" } }
}
```

Open in my editor picks, in order: `editor.command` (a string split on spaces, or an argv array; the path is appended or replaces `{path}`), `$VISUAL`, `$EDITOR`, then `xdg-open`. `$VISUAL` / `$EDITOR` run in a new Colony terminal tab through `sh -c '<editor> "$@"'`, the way git runs them, so terminal editors (and wrappers such as `omarchy-launch-editor --inline`) work; a configured command runs detached unless it is a terminal editor (`nvim`, `vim`, `hx`, ...). `editor.terminal` forces either way. The path is always its own argument.

## Runtime environment

| Variable | Effect |
|----------|--------|
| `WEBKIT_DISABLE_DMABUF_RENDERER` | Colony sets it to `1` at startup on NVIDIA + Wayland (WebKitGTK's DMA-BUF renderer hangs there; found in the Colony UI benchmark). A value you set yourself always wins. |
| `COLONY_ENABLE_DMABUF=1` | Keep the DMA-BUF renderer on NVIDIA + Wayland. |
| `COLONY_AGENT_KIT_BIN`, `COLONY_NODE_BIN`, `COLONY_GIT_BIN` | Use these binaries instead of the ones found on PATH. |
| `COLONY_DASHBOARD_SERVE` | Path to a `dashboard/serve.mjs` to run instead of the one next to the installed `agent-kit`. |
| `COLONY_SMOKE=<log file>` | Code-path smoke: after the folder opens, open `README.md`, append a line and save, run `echo colony-ok-$((6*7)) > smoke.txt` in a terminal, open `README.md` in your editor, read git status, start a one-tick driver run (answering its gate through the gate button if it opens one), check the tick review, log each step as JSON to the file, then exit. Use a scratch clone: it edits `README.md` and writes files. With `EDITOR=packaging/smoke/fake-editor.sh` and `COLONY_AGENT_KIT_BIN=packaging/smoke/fake-agent-kit.sh` (plus `COLONY_DASHBOARD_SERVE` pointing at the installed kit's `dashboard/serve.mjs`) the editor and the driver are fixtures, so the gate answer and the review are checked end to end with no agent. During the smoke Colony does not focus the editor or the terminal, but the window itself may still take focus from your compositor. |

A desktop launcher often starts apps without your shell's PATH. Colony appends `~/.local/share/mise/shims`, `~/.local/bin`, `~/.cargo/bin` and the newest mise Node install to PATH at startup, so the dashboard server and the CLI resolve the same tools as your terminal.

## Mission Control embedding

Colony follows the kit's embeddable contract (`docs/mission-control-embedding.md` in the kit): it runs `node <agent-kit package>/dashboard/serve.mjs` with `MISSION_CONTROL_REPO_ROOT=<opened folder>` and `PORT=<free port>`, loads `http://127.0.0.1:<port>/` in the home pane, and defines `window.__MISSION_CONTROL_ACTIONS__` inside that frame only. The hook offers every record (always `kind: "copy"`, every string untrusted) to the Colony window first. Colony runs a real host action for exactly two shapes and keeps the copy for everything else (`src/mcactions.ts`): a `filePicker` record holding a plain repo-relative path (no absolute, `~`, `..` or control characters; the Rust side still jails it to the folder) opens that file in a Colony tab, and a `chatInput` record that is exactly `/run-plan` or `/run-plan <plan basename>` starts an Agent run of the folder's active plan after a native confirmation dialog. Terminal commands, PIDs, prompts, `/run-plan-all` and `/git-prod` stay copy, as does any record Colony does not answer within 1.5 s. The server is stopped when Colony exits (also on a crash, through a parent-death signal). Its log is under `~/.cache/colony/dashboard-<port>.log`.
