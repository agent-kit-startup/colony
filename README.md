# Mission Kit Colony

Colony is the Mission Kit desktop IDE: a Tauri 2 cockpit with Mission Control as its home screen. It drives the open [Agent Kit](https://github.com/agent-kit-startup/agent-kit) CLI and each vendor's own agent on the user's own subscription or API key.

Private, closed-source product repository. No open-source license is granted.

## Status

Cockpit alpha. Linux (Omarchy / Hyprland) is the first target.

The cockpit is the center of the window. Its first tabs are Mission Control itself, as native views fed by the kit's own data (see Mission Control data): Mission, Plans, Queue, Inbox, Review, Git and Flight Log (Ctrl+1 to Ctrl+7). Every agent run opens as its own tab next to them, and so does an interactive agent. Files open in tabs after those.

| Area | What works |
|------|------------|
| Workspace | `Open folder` (Ctrl+O), the folder as the first CLI argument, recent folders on the welcome screen. File access is limited to the opened folder. |
| Mission | Home tab: the active plan from HANDOFF (lifecycle, progress, current and next to-do, gaps), `▶ Run plan`, `⏭ Run queue`, `⌘ Open interactive`, the engine picker, then cards for what needs you (live gates answerable in place, attention items, gate-exit tickets), the agent runs of this window, the queue, the flight log, recent activity and the repository (branch flow, health checks). |
| Plans | Every plan of the snapshot with filters (open, in queue, backlog, parked, incomplete, completed, all) and search, progress, queue role; a row expands to its to-do list. Actions: `Open` (editor), `▶ Run` on the HANDOFF plan (driver run), `Run…` on any other open plan, `Edit…` on a backlog plan and `Resume…` on a parked, incomplete or executing one: those open your agent interactively with `/run-plan <plan>`, `/backlog-edit <plan>` or `/continue-plan <plan>` after a confirmation (`agent-kit run-plan` has no plan argument; it always runs the HANDOFF plan). |
| Queue | The `run-plan-all` queue from HANDOFF: order, cursor, outcomes, each plan's lifecycle and progress, the queue status note. `⏭ Run queue` starts `agent-kit run-plan-all --backend <engine>` in a terminal tab after a confirmation; its numbered-list gates are answered in that terminal (the kit has no driver mode for the queue runner). |
| Agent tab | One center tab per `agent-kit run-plan --events ndjson` run, opened and focused when the run starts (from `▶ Run plan`, a view, or `More → Run plan in another folder…`). A readable transcript: assistant text as prose, tool calls collapsible with their results, thinking folded, each tick's `LOOP_TICK_RESULT` as a summary card (exit, pending before and after, stop, usage limit, link to its Review), HITL gates inline with answer buttons and free text, answered gates marked. `Raw log`, `Stop at gate`, `Kill`. Several runs at once, one per folder (the kit has no run lock). Needs a folder with the kit installed and an active plan. |
| Open interactive | `⌘ Interactive` opens the engine's own CLI, unmodified (`claude` or `codex`; the Cursor engines open whichever of those is on PATH), in a center terminal tab in the opened folder, with the picker's model. Colony passes no credentials and reads none: the CLI uses your own login, and its environment is the same as a shell tab's. |
| Inbox | Live gates: every open HITL gate from every run in this window, any engine, oldest first (tab badge = their count). A button or free text answers it: the driver-protocol line `{"type":"hitl_reply","askId":...,"reply":...}` goes to that run's stdin only. A card leaves when it is answered, the tick ends or the run exits. Colony never answers a gate by itself. Below: Mission Control's attention items (open the file, or `Ask agent` for an allowlisted kit command such as `/plan-review-triage`; anything else copies) and pending gate-exit tickets. |
| Review | Every tick of every run in this window with the files it changed (added, modified, deleted, renamed; new untracked files included, `.gitignore` respected), a Monaco side-by-side diff per file, commits made during the tick, the `LOOP_TICK_RESULT` line, "Copy patch". A tick is the working tree change from the previous tick end (or the run start) to its own end, captured as git tree objects through a throwaway index, so your index, worktree and refs are never touched; an edit you make between two ticks shows up in the next tick. A run killed mid-tick still gets its partial tick. |
| Git | Branch flow from the snapshot (upstream, vs staging, vs main, staging vs main), last commit and graph; working tree status, per-file diff, commit (optionally `git add -A`; hooks always run), push without force. Pushing `main`, `master`, `prod`, `production` or `release` needs a typed `yes`. Production promotion: Colony never runs `/git-prod` or any prod promotion; after a typed `yes` it copies `/git-prod` for your own agent session. |
| Flight Log | The current residual and earlier ones, operator warnings, gate-exit tickets, open triages, the ticks of this window's runs, and the headless tick logs (`.cursor/loop-logs`) with their result, sentinel and gates (open a log in the editor). "Copy fix prompt" copies. |
| Explorer | Lazy file tree (`.git` hidden), refresh button. |
| Editor | Monaco with one tab per file, dirty marker, Ctrl+S save, Ctrl+W close (asks before dropping unsaved changes), Ctrl+P quick open. |
| Terminals | Real PTYs running your `$SHELL` in the opened folder at the bottom, several tabs (`+` or Ctrl+Shift+T), Ctrl+` to show / hide, Ctrl+Shift+C / Ctrl+Shift+V copy and paste (wired, not yet verified on WebKitGTK). |
| Open in my editor | `Open in editor` (Ctrl+Shift+E) hands the active file, or the folder, to your own editor; right-click a file or folder in the Explorer for that one. |
| Engine picker | In the Mission tab: engine (`--backend`: `claude`, `codex`, `cursor-acp`, `cursor-agent`, `auto`; the ones not on PATH are marked), `--on-limit` engine for the next fresh tick after a vendor usage limit, optional `--model`, tick budget. Each choice is remembered for the opened folder in the settings file. The note under the picker says how a gate answer reaches that engine (`cursor-agent` has no input channel: a gate ends the tick). The same engine picks the vendor CLI for `Open interactive` and the backend of `Run queue`. |
| Web panel | `More → Mission Control (web panel)`: the kit's own page in a tab, as a fallback (see Mission Control web panel). |
| Skins | `More → Skin`: Bare Metal (default) or Legacy for the whole window, web panel included; saved as `ui.skin` in the settings file. |

Not yet: engine choice per to-do (the CLI picks the backend per run), a driver run of a plan other than the HANDOFF one and gates of the queue runner in the Inbox (both need the kit: `run-plan` has no plan argument and `run-plan-all` no `--events ndjson`), backlog actions without an agent (the kit exposes them only as slash commands), OS keychain for vendor keys (left out: the product plan says the IDE never reads, stores or relays vendor tokens; the agent CLIs keep their own login), signed bundles.

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
  "ui": { "skin": "bare-metal" },
  "editor": { "command": ["zed", "{path}"], "terminal": false },
  "workspaces": { "/home/me/code/repo": { "backend": "claude" } }
}
```

`ui.skin` is the look of the whole window: `bare-metal` (the default, neutral greys) or `legacy` (the slate palette of the kit's original Mission Control); `More → Skin` switches and saves it. Both are one design token set (`--mc-*` in `src/styles.css`) that the chrome, the native views, Monaco and the terminals read, and the web panel follows (see Mission Control web panel).

Open in my editor picks, in order: `editor.command` (a string split on spaces, or an argv array; the path is appended or replaces `{path}`), `$VISUAL`, `$EDITOR`, then `xdg-open`. `$VISUAL` / `$EDITOR` run in a new Colony terminal tab through `sh -c '<editor> "$@"'`, the way git runs them, so terminal editors (and wrappers such as `omarchy-launch-editor --inline`) work; a configured command runs detached unless it is a terminal editor (`nvim`, `vim`, `hx`, ...). `editor.terminal` forces either way. The path is always its own argument.

## Runtime environment

| Variable | Effect |
|----------|--------|
| `WEBKIT_DISABLE_DMABUF_RENDERER` | Colony sets it to `1` at startup on NVIDIA + Wayland (WebKitGTK's DMA-BUF renderer hangs there; found in the Colony UI benchmark). A value you set yourself always wins. |
| `COLONY_ENABLE_DMABUF=1` | Keep the DMA-BUF renderer on NVIDIA + Wayland. |
| `COLONY_AGENT_KIT_BIN`, `COLONY_NODE_BIN`, `COLONY_GIT_BIN`, `COLONY_CLAUDE_BIN`, `COLONY_CODEX_BIN` | Use these binaries instead of the ones found on PATH. |
| `COLONY_DASHBOARD_SERVE` | Path to a `dashboard/serve.mjs` to run instead of the one next to the installed `agent-kit`. |
| `COLONY_SMOKE=<log file>` | Code-path smoke: after the folder opens, check that the native views render the kit server's snapshot (Mission, Plans with one row per plan, Queue, Inbox, Git, Flight Log), write `.cursor/plans/colony-sse-smoke.plan.md` and wait for it to reach the Plans view over SSE, open `README.md`, append a line and save, run `echo colony-ok-$((6*7)) > smoke.txt` in a terminal, open `README.md` in your editor, check the web panel and its host actions, read git status, start a one-tick driver run by clicking the Mission view's `▶ Run plan` (it must open and focus its agent tab), answer its gate from the agent tab, check the transcript and the tick review, start the queue runner from the Queue view and an interactive agent from the Plans view, log each step as JSON to the file, then exit. Use a scratch clone: it edits `README.md` and writes files. With `EDITOR=packaging/smoke/fake-editor.sh`, `COLONY_AGENT_KIT_BIN=packaging/smoke/fake-agent-kit.sh` and `COLONY_CLAUDE_BIN=packaging/smoke/fake-claude.sh` (plus `COLONY_DASHBOARD_SERVE` pointing at the installed kit's `dashboard/serve.mjs`) the editor, the driver, the queue runner and the vendor CLI are fixtures, so the gate answer, the transcript, the review and both terminal tabs are checked end to end with no agent (the fixture run also starts a second fixture run in a sibling `repo2` folder, when present, to check that the Inbox routes each answer to its own run). With the real CLI the queue runner runs with `--dry-run` and the vendor CLI is only resolved, never started. Set `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to scratch folders too, or the smoke writes its engine choice into your real settings file and the scratch folder into your recent folders. During the smoke Colony does not focus the editor or the terminal, but the window itself may still take focus from your compositor. `COLONY_SMOKE_SHOTS=1` also pauses at a few views (a `pause` step in the log) until `<folder>/.git/colony-shot-<name>` exists, so a runner can take screenshots. |

A desktop launcher often starts apps without your shell's PATH. Colony appends `~/.local/share/mise/shims`, `~/.local/bin`, `~/.cargo/bin` and the newest mise Node install to PATH at startup, so the dashboard server and the CLI resolve the same tools as your terminal.

## Mission Control data

Colony runs the installed kit's unforked dashboard server for the opened folder (`node <agent-kit package>/dashboard/serve.mjs` with `MISSION_CONTROL_REPO_ROOT=<opened folder>` and `PORT=<free port>`, on loopback) and is a read-only client of its data API: `GET /dashboard-data.json` once, then `GET /api/events` (SSE, a full snapshot per change). The Colony page cannot read that server itself (the server answers CORS only for its own origin), so the Rust side fetches both over loopback HTTP/1.0 and forwards each snapshot unchanged (`src-tauri/src/mcdata.rs`); the stream reconnects on its own. The views read the snapshot contract of the kit (`docs/contracts/mission-control-snapshot.schema.json`, `dashboardDataVersion` 1.6.0), mostly its `missionControl` projection, and tolerate any nested field being absent. `GET /api/config` is asked too and is a 404 on kit 6.2.0 (the server only accepts config writes there), so the views use the snapshot's `system` summary. Colony never writes to the server. The status bar shows the feed (live or offline, age of the last snapshot, data version).

## Mission Control web panel

The kit's own page stays reachable under `More → Mission Control (web panel)`. Colony follows the kit's embeddable contract (`docs/mission-control-embedding.md` in the kit): it runs `node <agent-kit package>/dashboard/serve.mjs` with `MISSION_CONTROL_REPO_ROOT=<opened folder>` and `PORT=<free port>`, loads `http://127.0.0.1:<port>/?colony-skin=<skin>` in that tab, and defines `window.__MISSION_CONTROL_ACTIONS__` inside that frame only. The hook offers every record (always `kind: "copy"`, every string untrusted) to the Colony window first. The same frame script selects the panel's skin to match Colony's before the panel paints: it writes the kit's own preference key (`agent-kit:dashboard-skin`, `cursor` for Bare Metal or `legacy`; `src/skin.ts` maps Colony's skin to the kit's value and already accepts `bare-metal`, the kit's planned new name). Colony runs a real host action for exactly two shapes and keeps the copy for everything else (`src/mcactions.ts`): a `filePicker` record holding a plain repo-relative path (no absolute, `~`, `..` or control characters; the Rust side still jails it to the folder) opens that file in a Colony tab, and a `chatInput` record that is exactly `/run-plan` or `/run-plan <plan basename>` starts an agent run (its own tab) of the folder's active plan after a native confirmation dialog. Terminal commands, PIDs, prompts, `/run-plan-all` and `/git-prod` stay copy, as does any record Colony does not answer within 1.5 s. The server is stopped when Colony exits (also on a crash, through a parent-death signal). Its log is under `~/.cache/colony/dashboard-<port>.log`.
