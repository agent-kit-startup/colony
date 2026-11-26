// Native kit views (plan colony-sidebar-native-kit s3): the rail items and Workspace sections
// the web Mission Control panel used to serve in a frame. Each reads the kit's snapshot
// (./snapshot.ts) or the kit CLI, and turns the panel's copy records into Colony's own
// actions where Colony has one (open a file in the editor, run an allowlisted slash command
// through the interactive agent, focus a terminal); the rest stays a copy. Functional parity
// with the kit, not a visual copy of its page. Snapshot fields newer than the engine are
// feature-detected: an older engine gets an "Update the engine" state, never an error.
// Repo text (titles, descriptions, commands) is always rendered as text.
import { type CommandRow, type CommandsCatalog, api, errText, h } from "./api";
import { type CockpitHost, launchGoal, View } from "./cockpit";
import { type J, obj, snapshot, str } from "./snapshot";
import { type TtySession, ttys } from "./ttys";
import { ago, btn, card, chip, checkChip, empty, emptyCta, metaRow } from "./ui";

export interface KitViewsHost extends CockpitHost {
  showEngine(): void;
}

/** Mission Control data that first carried `rules` and `memory.decisionIndex` (kit #1361). */
export const WORKSPACE_DOCS_VERSION = "1.10.0";

/** "Update the engine" for a field this engine's snapshot does not carry. */
function needsEngine(host: KitViewsHost, what: string, version: string): HTMLElement {
  const v = snapshot.version || "unknown";
  return emptyCta({
    icon: "engine",
    headline: "Update the engine",
    support: `${what} need Mission Control data ${version} or newer: an Agent Kit release after 6.12.0. This engine serves data ${v}.`,
    actions: [{ label: "Engine…", onClick: () => host.showEngine(), act: "engine", title: "Pick or update the engine Colony runs the kit with" }],
  });
}

/** A searchable, filterable list view: the toolbar keeps its search field across renders. */
abstract class ListView extends View {
  protected filter = "all";
  protected query = "";
  protected search: HTMLInputElement;

  constructor(host: KitViewsHost, cls: string, placeholder: string) {
    super(host, `kv ${cls}`);
    this.search = h("input", { type: "search", placeholder, class: "search" });
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.invalidate();
    });
  }

  protected get kit(): KitViewsHost {
    return this.host as KitViewsHost;
  }

  protected keepsFocus(el: HTMLElement): boolean {
    return el === this.search;
  }

  protected matches(...fields: unknown[]): boolean {
    return !this.query || fields.map((f) => (Array.isArray(f) ? f.join(" ") : String(f ?? ""))).join(" ").toLowerCase().includes(this.query);
  }

  /** Filter buttons `[id, label, count]`; only the active one's 1px border colour changes. */
  protected toolbar(filters: [string, string, number][], ...actions: Node[]): HTMLElement {
    const chips = filters.map(([id, label, n]) => {
      const b = btn(`${label} ${n}`, () => {
        this.filter = id;
        this.invalidate();
      }, { class: `filter kv-filter${this.filter === id ? " on" : ""}`, "aria-pressed": String(this.filter === id) });
      b.dataset.filter = id;
      return b;
    });
    return h("div", { class: "toolbar" }, h("div", { class: "chips" }, ...chips), h("div", { class: "actions" }, this.search, ...actions));
  }

  protected openBtn(path: string): HTMLElement {
    return btn("Open", () => this.host.openRepoFile(path), { class: "link", title: `Open ${path} in the editor`, "data-act": "open" });
  }
}

/** One list row: the main line, then optional detail and meta lines. */
function row(main: (Node | string)[], detail?: string, meta?: HTMLElement, key = ""): HTMLElement {
  const el = h("div", { class: "kv-row" }, h("div", { class: "row" }, ...main), ...(detail ? [h("div", { class: "dim small clamp-2", title: detail }, detail)] : []), ...(meta ? [meta] : []));
  if (key) el.dataset.key = key;
  return el;
}

const managed = (j: J) => (j.kitManaged === true ? chip("kit", "chip-parked") : chip("project", "chip-done"));

// ---- Processes -------------------------------------------------------------------------
export const REAP_AUDIT = ".cursor/scripts/plan-external-review.sh --reap-audit-sessions";

export class ProcessesView extends View {
  constructor(host: KitViewsHost) {
    super(host, "kv kv-processes");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const list = snapshot.processes;
    const audit = obj(snapshot.system.detachedAuditSessions);
    const out: Node[] = [h("p", { class: "dim small" }, "A live ps snapshot of node, git and dashboard processes, refreshed with the kit's data. Agent runs started in Colony are under Cockpit → Agent runs.")];
    if (typeof audit.count === "number" && audit.count > 0) {
      const age = typeof audit.oldestAgeSeconds === "number" ? `, oldest about ${Math.round(audit.oldestAgeSeconds / 60)} min` : "";
      out.push(
        card(
          { title: "Detached audit sessions", icon: "shield", aside: [chip(String(audit.count), "chip-gate")] },
          h("div", { class: "small" }, `${audit.count} host-wide agent-kit-audit-* plan-review ${audit.count === 1 ? "PTY is" : "PTYs are"} still alive${age}. The audit launcher disposes of them on its next spawn, or reap them now from a terminal.`),
          h(
            "div",
            { class: "actions" },
            btn("Reap now", () => void this.host.reapAuditSessions(), { class: "status-bar-btn", "data-act": "reap-run", title: `${REAP_AUDIT} in a terminal tab of this folder, after a confirmation` }),
            btn("Copy reap command", () => this.host.copy(REAP_AUDIT, "reap command"), { class: "status-bar-btn link", "data-act": "reap", title: `${REAP_AUDIT}\n(for a terminal in this folder)` }),
          ),
        ),
      );
    }
    if (!list.length) {
      out.push(emptyCta({ icon: "processes", headline: "All quiet", support: "No relevant processes running. Node, git and dashboard processes appear here while they run." }));
      return out;
    }
    out.push(
      card(
        { title: "Processes", icon: "processes", aside: [h("span", { class: "card-count" }, `${list.length} running`)] },
        ...list.map((p) => {
          const pid = str(p.pid);
          return row(
            [chip(str(p.label, "other")), h("span", { class: "grow ellipsis mono small", title: str(p.command) }, str(p.command, "—")), btn("Copy PID", () => this.host.copy(pid, `PID ${pid}`), { class: "link", "data-act": "copy-pid", title: `Copy ${pid} (for kill, ps or top in a terminal)` })],
            str(p.description),
            metaRow([
              { icon: "processes", text: `PID ${pid}`, mono: true },
              { icon: "activity", text: `CPU ${str(p.cpu, "—")}% · MEM ${str(p.mem, "—")}%`, mono: true },
              p.etime ? { icon: "elapsed", text: `up ${str(p.etime)}`, mono: true } : null,
            ]),
            pid,
          );
        }),
      ),
    );
    return out;
  }
}

// ---- Terminals -------------------------------------------------------------------------
export interface TerminalsHost {
  /** Show the session's terminal: the drawer shell (opening the drawer) or the centre tab. */
  focus(s: TtySession): void;
  /** A new shell (same argv) in the drawer, in the opened folder. */
  reopen(s: TtySession): void;
  workspaceRoot(): string;
}

const TTY_STATE: Record<string, [string, string]> = { open: ["open", "chip-done"], exited: ["exited", "chip-gate"], closed: ["closed", "chip-parked"] };

export class TerminalsView extends View {
  private timer = 0;

  constructor(host: KitViewsHost, private term: TerminalsHost) {
    super(host, "kv kv-terminals");
    ttys.on(() => this.invalidate());
  }

  show() {
    super.show();
    void ttys.refreshCwds();
    // The shells' folders change while the view is open (a `cd`): read them every few seconds.
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void ttys.refreshCwds(), 3000);
  }

  hide() {
    super.hide();
    window.clearInterval(this.timer);
  }

  protected render(): Node[] {
    const list = ttys.list();
    const root = this.term.workspaceRoot();
    const head = h("p", { class: "dim small" }, "Every terminal of this window: the drawer's shells, closed ones included, and the agent and queue terminal tabs. The drawer bar starts, shows and closes shells; Reopen starts a new shell in the drawer.");
    if (!list.length) return [head, emptyCta({ icon: "terminals", headline: "No terminals yet", support: "Open a shell with + in the drawer bar (Ctrl+` shows the drawer)." })];
    const rel = (p: string) => (root && (p === root || p.startsWith(`${root}/`)) ? `.${p.slice(root.length)}` || "." : p);
    const rows = list.map((s) => {
      const [label, cls] = TTY_STATE[s.state];
      const acts: HTMLElement[] = [];
      if (s.state !== "closed") acts.push(btn("Focus", () => this.term.focus(s), { class: "link", "data-act": "focus", title: s.place === "drawer" ? "Show this shell in the drawer" : "Show this terminal tab" }));
      // Reopen: drawer shells only (by key: a shell may sit in the editor area, a centre
      // PTY in the drawer; kit ADR 2026-10-24 amend 2026-11-07).
      if (s.key.startsWith("drawer:") && s.state !== "open" && (!s.root || s.root === root)) acts.push(btn("Reopen", () => this.term.reopen(s), { class: "link", "data-act": "reopen", title: `A new ${s.argv ? s.argv.join(" ") : "shell"} in the drawer, in the opened folder` }));
      const code = s.exitCode === null ? "" : ` (code ${s.exitCode})`;
      return row(
        [chip(`${label}${s.state === "exited" ? code : ""}`, cls), h("strong", { class: "ellipsis" }, s.label), chip(s.place === "drawer" ? "drawer" : "tab"), h("span", { class: "grow" }), ...acts],
        s.title ? `Title: ${s.title}` : undefined,
        metaRow([
          { icon: "folder", text: rel(s.cwd), mono: true, title: s.cwd },
          s.argv ? { icon: "terminals", text: s.argv.join(" "), mono: true } : { icon: "terminals", text: "login shell" },
          { icon: "updated", text: s.endedAt ? `${s.state} ${ago(new Date(s.endedAt).toISOString())}` : `started ${ago(new Date(s.startedAt).toISOString())}`, mono: true },
        ]),
        s.key,
      );
    });
    const open = list.filter((s) => s.state === "open").length;
    return [head, card({ title: "Terminals", icon: "terminals", aside: [h("span", { class: "card-count" }, `${open} open · ${list.length - open} ended`)] }, ...rows)];
  }
}

// ---- Memory (a rail item since amend 2026-11-19) ---------------------------------------
export class MemoryView extends View {
  constructor(host: KitViewsHost, private openDecisions: () => void) {
    super(host, "kv kv-memory");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const m = snapshot.memory;
    const stats = obj(m.errorStats);
    const tags = Array.isArray(stats.topTags) ? stats.topTags : [];
    const errors = Array.isArray(m.recentErrors) ? m.recentErrors : [];
    const decisions = Array.isArray(m.recentDecisions) ? m.recentDecisions : [];
    return [
      h(
        "div",
        { class: "grid" },
        card(
          { title: "Memory", icon: "field-report" },
          h("div", { class: "chips" }, chip(`${Number(m.errors) || 0} errors`), chip(`${Number(m.decisions) || 0} decisions`), ...(typeof stats.last30d === "number" ? [chip(`${stats.last30d} errors in 30 days`)] : []), ...(typeof stats.weeklyRate === "number" ? [chip(`${stats.weeklyRate} / week`)] : [])),
          ...(tags.length ? [h("div", { class: "chips" }, ...tags.map((t: J) => chip(`${str(t.tag)} ${Number(t.count) || 0}`, "chip-parked")))] : []),
          h("div", { class: "actions" }, btn("Decisions", () => this.openDecisions(), { class: "link", title: "Workspace → Decisions: every ADR by Status and date" }), btn("Open the index", () => this.host.openRepoFile(".cursor/memory/_index.md"), { class: "link", "data-act": "open" })),
        ),
        card(
          { title: "Recent decisions", icon: "review" },
          ...(decisions.length ? decisions.map((d: J) => row([h("span", { class: "grow ellipsis mono small" }, str(d.id)), btn("Open", () => this.host.openRepoFile(str(d.path)), { class: "link", "data-act": "open" })])) : [empty("No decision records.")]),
        ),
      ),
      card(
        { title: "Recent errors", icon: "field-report", aside: [h("span", { class: "card-count" }, `${errors.length} shown`)] },
        ...(errors.length
          ? errors.map((e: J) =>
              row(
                [h("strong", { class: "grow ellipsis", title: str(e.title) }, str(e.title, str(e.id))), btn("Open", () => this.host.openRepoFile(str(e.path)), { class: "link", "data-act": "open" })],
                str(e.cause) || str(e.error),
                metaRow([{ icon: "updated", text: str(e.date), mono: true }, Array.isArray(e.tags) && e.tags.length ? { icon: "checklist", text: e.tags.slice(0, 6).join(", ") } : null]),
                str(e.id),
              ),
            )
          : [empty("No error records.")]),
      ),
    ];
  }
}

// ---- Workspace → Health ----------------------------------------------------------------
export class HealthView extends View {
  constructor(host: KitViewsHost) {
    super(host, "kv kv-health");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const hl = snapshot.health;
    const checks = Array.isArray(hl.checks) ? hl.checks : [];
    const failing = checks.filter((c: J) => !c.ok).length;
    const status = str(hl.status, failing ? "degraded" : "ok");
    return [
      card(
        { title: "Health", icon: "health", aside: [chip(status, status === "ok" ? "chip-done" : "chip-failed"), h("span", { class: "card-count" }, `${checks.length - failing} of ${checks.length} pass`)] },
        ...(checks.length
          ? checks.map((c: J) => row([checkChip(str(c.label, str(c.id)), c.ok ? "ok" : "fail"), h("span", { class: "grow dim small mono" }, str(c.id)), ...(str(c.detail) ? [h("span", { class: "dim small ellipsis", title: str(c.detail) }, str(c.detail))] : [])], undefined, undefined, str(c.id)))
          : [empty("No health checks in the snapshot.")]),
      ),
    ];
  }
}

// ---- Workspace → Decisions -------------------------------------------------------------
const ADR_STATUS = ["accepted", "proposed", "superseded", "deprecated", "unknown"];
const STATUS_CHIP: Record<string, string> = { accepted: "chip-done", proposed: "chip-gate", superseded: "chip-parked", deprecated: "chip-parked", unknown: "" };

export class DecisionsView extends ListView {
  constructor(host: KitViewsHost) {
    super(host, "kv-decisions", "Filter decisions (title, id, tag)");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const index = snapshot.decisionIndex;
    if (!index) {
      // An older engine: the gate, then the few records its snapshot does carry.
      const recent = Array.isArray(snapshot.memory.recentDecisions) ? snapshot.memory.recentDecisions : [];
      return [
        needsEngine(this.kit, "The decision index (title, Status, date, tags of every ADR)", WORKSPACE_DOCS_VERSION),
        card({ title: "Recent decisions (this engine)", icon: "review" }, ...(recent.length ? recent.map((d: J) => row([h("span", { class: "grow ellipsis mono small" }, str(d.id)), this.openBtn(str(d.path))], undefined, undefined, str(d.id))) : [empty("No decision records.")])),
      ];
    }
    const count = (s: string) => index.filter((d) => str(d.status, "unknown") === s).length;
    const filters: [string, string, number][] = [["all", "All", index.length], ...ADR_STATUS.map((s): [string, string, number] => [s, s[0].toUpperCase() + s.slice(1), count(s)]).filter((f) => f[2] > 0 || f[0] === this.filter)];
    const shown = index.filter((d) => (this.filter === "all" || str(d.status, "unknown") === this.filter) && this.matches(d.title, d.id, d.tags, d.statusText));
    return [
      this.toolbar(filters, btn("Open the index", () => this.host.openRepoFile(".cursor/memory/_index.md"), { class: "status-bar-btn", "data-act": "open-index" })),
      card(
        { title: "Decisions", icon: "review", aside: [h("span", { class: "card-count" }, `${shown.length} of ${index.length}`)] },
        ...(shown.length
          ? shown.slice(0, 300).map((d) => {
              const st = str(d.status, "unknown");
              const amends = Array.isArray(d.amends) ? d.amends : [];
              return row(
                [chip(st, STATUS_CHIP[st] ?? ""), h("strong", { class: "grow ellipsis", title: str(d.title) }, str(d.title, str(d.id))), this.openBtn(str(d.path))],
                str(d.statusText),
                metaRow([{ icon: "updated", text: str(d.date), mono: true }, { icon: "review", text: str(d.id), mono: true }, amends.length ? { icon: "plans", text: `amended ${amends.join(", ")}`, mono: true } : null, Array.isArray(d.tags) && d.tags.length ? { icon: "checklist", text: d.tags.slice(0, 8).join(", ") } : null]),
                str(d.id),
              );
            })
          : [empty(this.query ? "No decision matches the search." : "No decisions with this Status.")]),
        ...(shown.length > 300 ? [empty(`${shown.length - 300} more: narrow the search.`)] : []),
      ),
    ];
  }
}

// ---- Workspace → Rules -----------------------------------------------------------------
export class RulesView extends ListView {
  constructor(host: KitViewsHost) {
    super(host, "kv-rules", "Filter rules");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const rules = snapshot.rules;
    if (!rules) return [needsEngine(this.kit, "Rules (the .cursor/rules list with descriptions and scope)", WORKSPACE_DOCS_VERSION)];
    const f: Record<string, (r: J) => boolean> = { all: () => true, always: (r) => r.alwaysApply === true, scoped: (r) => r.alwaysApply !== true, kit: (r) => r.kitManaged === true, project: (r) => r.kitManaged !== true };
    const filters: [string, string, number][] = [
      ["all", "All", rules.length],
      ["always", "Always on", rules.filter(f.always).length],
      ["scoped", "Scoped", rules.filter(f.scoped).length],
      ["kit", "Kit", rules.filter(f.kit).length],
      ["project", "Project", rules.filter(f.project).length],
    ];
    const shown = rules.filter((r) => (f[this.filter] ?? f.all)(r) && this.matches(r.id, r.description, r.globs));
    return [
      this.toolbar(filters),
      card(
        { title: "Rules", icon: "shield", aside: [h("span", { class: "card-count" }, `${shown.length} of ${rules.length}`)] },
        ...(shown.length
          ? shown.map((r) =>
              row(
                [h("strong", { class: "grow ellipsis mono small" }, str(r.id)), r.alwaysApply === true ? chip("always on", "chip-gate") : chip("scoped"), managed(r), this.openBtn(str(r.path))],
                str(r.description),
                Array.isArray(r.globs) && r.globs.length ? metaRow([{ icon: "folder", text: r.globs.join(", "), mono: true }]) : undefined,
                str(r.id),
              ),
            )
          : [empty("No rule matches.")]),
      ),
    ];
  }
}

// ---- Workspace → Agents, Skills --------------------------------------------------------
export class AgentsView extends ListView {
  constructor(host: KitViewsHost) {
    super(host, "kv-agents", "Filter agents");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const all = snapshot.agents;
    const shown = all.filter((a) => (this.filter === "all" || (this.filter === "kit") === (a.kitManaged === true)) && this.matches(a.id, a.description));
    const kit = all.filter((a) => a.kitManaged === true).length;
    return [
      this.toolbar([["all", "All", all.length], ["kit", "Kit", kit], ["project", "Project", all.length - kit]]),
      card(
        { title: "Agents", icon: "agents", aside: [h("span", { class: "card-count" }, `${shown.length} of ${all.length}`)] },
        ...(shown.length ? shown.map((a) => row([h("strong", { class: "grow ellipsis mono small" }, str(a.id)), managed(a), this.openBtn(str(a.path, `.cursor/agents/${str(a.file)}`))], str(a.description).replace(/^:\s*/, ""), undefined, str(a.id))) : [empty(all.length ? "No agent matches." : "No agent definitions in .cursor/agents/.")]),
      ),
    ];
  }
}

const SKILL_CREATE = "Create a new Agent Skill under .cursor/skills/ (directory with a SKILL.md markdown body). Ask me for the name and behavior first.";

export class SkillsView extends ListView {
  constructor(host: KitViewsHost) {
    super(host, "kv-skills", "Filter skills");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const all = snapshot.skills;
    const shown = all.filter((s) => (this.filter === "all" || (this.filter === "kit") === (s.kitManaged === true)) && this.matches(s.id, s.title, s.description, s.category));
    const kit = all.filter((s) => s.kitManaged === true).length;
    return [
      this.toolbar(
        [["all", "All", all.length], ["kit", "Kit", kit], ["project", "Editable", all.length - kit]],
        btn("New skill", () => void launchGoal(this.host, "backlog-add", SKILL_CREATE, "Skills: /backlog-add plans the new skill with to-dos; it asks for the name and behavior and before it writes."), { class: "status-bar-btn", "data-act": "skill-create-run", title: "Open your agent already running /backlog-add with the create-skill prompt" }),
        btn("Copy create prompt", () => this.host.copy(SKILL_CREATE, "create prompt"), { class: "status-bar-btn link", "data-act": "skill-create", title: "For your agent's chat input" }),
      ),
      card(
        { title: "Skills", icon: "checklist", aside: [h("span", { class: "card-count" }, `${shown.length} of ${all.length}`)] },
        ...(shown.length
          ? shown.map((s) => {
              const desc = str(s.description).replace(/^#\s*/, "");
              return row([h("strong", { class: "grow ellipsis", title: str(s.id) }, str(s.title, str(s.id))), chip(str(s.category)), managed(s), this.openBtn(str(s.file))], desc && desc !== str(s.title) ? desc : str(s.id), undefined, str(s.id));
            })
          : [empty(all.length ? "No skill matches." : "No skills in .cursor/skills/.")]),
      ),
    ];
  }
}

// ---- Workspace → Commands --------------------------------------------------------------
/** The kit's commands catalog (`agent-kit commands --json`, Colony's Rust allowlist verdict per row). */
export class CommandsView extends ListView {
  private catalog: CommandsCatalog | null = null;
  private error = "";
  private loading: Promise<void> | null = null;

  constructor(host: KitViewsHost) {
    super(host, "kv-commands", "Filter commands");
  }

  /** Read the catalog again on the next show (a folder switch, an engine update). */
  reset() {
    this.catalog = null;
    this.error = "";
    this.loading = null;
    this.invalidate();
  }

  show() {
    super.show();
    this.load();
  }

  /** Loaded rows, for the smoke. */
  rows(): CommandRow[] {
    return this.catalog?.commands ?? [];
  }

  get loadError(): string {
    return this.error;
  }

  load(): Promise<void> {
    this.loading ??= api.commandsCatalog().then(
      (c) => {
        this.catalog = c;
        this.error = "";
        this.invalidate();
      },
      (e) => {
        this.catalog = null;
        this.error = errText(e);
        this.invalidate();
      },
    );
    return this.loading;
  }

  protected render(): Node[] {
    const c = this.catalog;
    if (!c && !this.error) return [empty("Loading the commands catalog…")];
    if (!c) {
      const files = snapshot.data ? arrOf(snapshot.data.commands) : [];
      return [
        emptyCta({ icon: "engine", headline: this.error.startsWith("Update the engine") ? "Update the engine" : "Commands catalog unavailable", support: this.error, actions: [{ label: "Engine…", onClick: () => this.kit.showEngine(), act: "engine" }, { label: "Try again", onClick: () => this.reset(), act: "retry" }] }),
        ...(files.length ? [card({ title: "Command files", icon: "commands" }, ...files.map((f) => row([h("span", { class: "grow ellipsis mono small" }, `/${str(f.id)}`), this.openBtn(str(f.path))], undefined, undefined, str(f.id))))] : []),
      ];
    }
    const layers = ["kit", "project", "factory"];
    // A meta row outside the factory workspace is not shown (catalog `hidden`, amend 2026-11-16 decision 5).
    const rows = c.commands.filter((r) => !r.hidden);
    const filters: [string, string, number][] = [["all", "All", rows.length], ...layers.map((l): [string, string, number] => [l, l[0].toUpperCase() + l.slice(1), rows.filter((r) => r.layer === l).length]).filter((f) => f[2] > 0)];
    const shown = rows.filter((r) => (this.filter === "all" || r.layer === this.filter) && this.matches(r.name, r.description));
    return [
      this.toolbar(filters),
      h("p", { class: "dim small" }, `Agent Kit ${c.kitVersion} · catalog ${c.catalogVersion}. Run opens your agent already running the command with its context (the goal, plan, branch, PR or SHA it takes); Colony's allowlist decides which rows run. /git-prod and /kit-prod open interactively after a confirmation, and their own production gate in the session is the yes. Copy is for your agent's chat input.`),
      card(
        { title: "Commands", icon: "commands", aside: [h("span", { class: "card-count" }, `${shown.length} of ${rows.length}`)] },
        ...(shown.length
          ? shown.map((r) => {
              const slash = `/${r.name}`;
              const asks = r.interactiveOnly || r.layer === "project";
              const act = r.run
                ? btn("Run", () => void this.host.launch(r, `Workspace → Commands: ${r.description}`), { class: "link", "data-act": "run", title: `Open your agent already running ${slash} with its context${asks ? " (asks first)" : ""}` })
                : btn("Copy", () => this.host.copy(slash, slash), { class: "link", "data-act": "copy", title: `Copy ${slash} for your agent's chat input` });
              return row([h("strong", { class: "mono small" }, slash), chip(r.layer), ...(r.headless ? [chip("headless")] : []), h("span", { class: "grow" }), act, this.openBtn(`.cursor/commands/${r.name}.md`)], r.description, undefined, r.name);
            })
          : [empty("No command matches.")]),
      ),
    ];
  }
}

// biome-ignore lint: the snapshot is open JSON
const arrOf = (v: unknown): J[] => (Array.isArray(v) ? (v as any[]).filter((x) => x && typeof x === "object") : []);
