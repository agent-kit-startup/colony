// Native kit views (plan colony-sidebar-native-kit s3): the rail items and Workspace sections
// the web Mission Control panel used to serve in a frame. Each reads the kit's snapshot
// (./snapshot.ts) or the kit CLI, and turns the panel's copy records into Colony's own
// actions where Colony has one (open a file in the editor, run an allowlisted slash command
// through the interactive agent, focus a terminal); the rest stays a copy. Functional parity
// with the kit, not a visual copy of its page. Snapshot fields newer than the engine are
// feature-detected: an older engine gets an "Update the engine" state, never an error.
// Repo text (titles, descriptions, commands) is always rendered as text.
import { type CommandRow, type CommandsCatalog, api, errText, h } from "./api";
import { type CockpitHost, View } from "./cockpit";
import { type EnemyPreference, type GameState, type Ledger, type Purse, buildEndsAt, MAP_RADIUS, overclockActive, ring, TILES, TUNING, turnsLeft, wallet } from "@dadado/oligarchy-engine";
import * as og from "./oligarchy";
import { catalogSource, rules } from "./oligarchycatalog";
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
          h("div", { class: "actions" }, btn("Copy reap command", () => this.host.copy(REAP_AUDIT, "reap command"), { class: "status-bar-btn", "data-act": "reap", title: `${REAP_AUDIT}\n(for a terminal in this folder)` })),
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

// ---- Workspace → Memory ----------------------------------------------------------------
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
      this.toolbar([["all", "All", all.length], ["kit", "Kit", kit], ["project", "Editable", all.length - kit]], btn("Copy create prompt", () => this.host.copy(SKILL_CREATE, "create prompt"), { class: "status-bar-btn", "data-act": "skill-create", title: "For your agent's chat input" })),
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
    const filters: [string, string, number][] = [["all", "All", c.commands.length], ...layers.map((l): [string, string, number] => [l, l[0].toUpperCase() + l.slice(1), c.commands.filter((r) => r.layer === l).length]).filter((f) => f[2] > 0)];
    const shown = c.commands.filter((r) => (this.filter === "all" || r.layer === this.filter) && this.matches(r.name, r.description));
    return [
      this.toolbar(filters),
      h("p", { class: "dim small" }, `Agent Kit ${c.kitVersion} · catalog ${c.catalogVersion}. Run opens your agent with the command (Colony's allowlist decides which); Copy is for your agent's chat input. /git-prod and /kit-prod are never run from here.`),
      card(
        { title: "Commands", icon: "commands", aside: [h("span", { class: "card-count" }, `${shown.length} of ${c.commands.length}`)] },
        ...(shown.length
          ? shown.map((r) => {
              const slash = `/${r.name}`;
              const act = r.run
                ? btn("Run", () => void this.host.interactive(slash, `Workspace → Commands: ${r.description}`), { class: "link", "data-act": "run", title: `Open your agent with ${slash} (asks first)` })
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

// ---- Oligarchy (the game) --------------------------------------------------------------
// The public rules engine (@dadado/oligarchy-engine) over the kit's outcome ledger, bound to the
// catalog of this build (./oligarchycatalog.ts). Earned totals come only from the ledger; what the
// player builds and spends is Colony's own state, kept per folder. The ledger is folded only while
// this view is on screen (the engine's host contract), so an attack never lands unseen.

/** Colony's own art (Apache-2.0, assets/art/), by catalog art id. Other ids show their glyph. */
const ART: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../assets/art/*.webp", { eager: true, query: "?url", import: "default" })).map(([path, url]) => [path.replace(/^.*\/|\.webp$/g, ""), url]),
);

export interface GameHost {
  /** Pick a folder (the welcome screen's Open folder). */
  openFolder(): void;
  /** Back to the welcome screen, with no folder open. */
  welcome(): void;
}

export class ColonyView extends View {
  private timer = 0;
  private selected: number | null = null;

  constructor(host: KitViewsHost, private game: GameHost) {
    super(host, "kv kv-colony");
  }

  show() {
    super.show();
    // Build timers are evaluated on render: refresh once a minute while the view is open.
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.invalidate(), 60_000);
  }

  hide() {
    super.hide();
    window.clearInterval(this.timer);
  }

  private root(): string {
    return this.host.workspaceRoot();
  }

  private enemy(): EnemyPreference {
    const root = this.root();
    return root ? og.parseEnemy(localStorage.getItem(og.enemyKey(root))) : "on";
  }

  private ledger(): Ledger {
    return og.ledgerOf(this.root() ? snapshot.outcomeLedger : null);
  }

  /** The player's state brought up to now (persisted only on change). No folder: a new colony, never saved. */
  state(now = Date.now()): GameState {
    const root = this.root();
    if (!root) return rules.newGame();
    let raw: unknown = null;
    try {
      raw = JSON.parse(localStorage.getItem(og.stateKey(root)) ?? "null");
    } catch {
      raw = null;
    }
    const { state, changed } = og.advance(rules, raw, this.ledger(), now, this.enemy());
    if (changed) this.save(state);
    return state;
  }

  private save(s: GameState): boolean {
    const root = this.root();
    if (!root) return false;
    try {
      localStorage.setItem(og.stateKey(root), JSON.stringify(s));
      return true;
    } catch {
      return false;
    }
  }

  private apply(next: GameState | null, failed: string): boolean {
    if (!next || !this.save(next)) {
      this.host.status(`Oligarchy: ${failed}`);
      return false;
    }
    this.invalidate();
    return true;
  }

  /** Spend and start a build on the selected hex, or the first free one (the Build button). */
  build(id: string): boolean {
    const now = Date.now();
    const s = this.state(now);
    const ledger = this.ledger();
    const terrain = og.terrainFor(this.root());
    const hex = og.hexFor(rules, s, ledger, id, terrain, this.selected);
    if (hex === null) return this.apply(null, "no free ground for it yet");
    this.selected = null;
    return this.apply(rules.queueBuild(s, ledger, id, hex, { now, terrain }), "could not start the build");
  }

  repair(builtId: number): boolean {
    const now = Date.now();
    return this.apply(rules.queueRepair(this.state(now), this.ledger(), builtId, { now }), "could not start the repair");
  }

  counter(id: string): boolean {
    return this.apply(rules.pickCountermeasure(this.state(), this.ledger(), id), "could not pay for the countermeasure");
  }

  protected render(): Node[] {
    const root = this.root();
    if (root) {
      const nd = this.noData();
      if (nd) return nd;
      if (!snapshot.outcomeLedger) return [needsEngine(this.host as KitViewsHost, "Oligarchy (it grows from the kit's outcome ledger)", "1.9.0")];
    }
    const summary = root ? obj(snapshot.outcomeLedger) : {};
    const now = Date.now();
    const s = this.state(now);
    const ledger = this.ledger();
    const w = wallet(ledger, s);
    const overclock = overclockActive(ledger.flow, now);
    const green = rules.greenTiles(ledger, s);
    const reach = rules.revealedRing(ledger, s);
    const tier = rules.unlockedTier(ledger, s);
    const terrain = og.terrainFor(root);
    const name = (id: string) => rules.structures.find((x) => x.id === id)?.name ?? id;
    const flow = ledger.flow ?? {};
    const flowText = overclock
      ? `Flow overclock on: a streak of ${flow.streak} closed to-dos, builds run 25% faster`
      : typeof flow.streak === "number"
        ? `Flow streak ${flow.streak} (overclock at ${TUNING.flowStreak} closes in a row, the last within 2 h)`
        : "Flow: no closed to-do in a mission yet";
    const res = (label: string, k: "logic" | "compute" | "rare") => h("div", { class: "colony-resource" }, h("span", { class: "dim small" }, label), h("strong", { class: "colony-resource-value" }, String(w[k])), h("span", { class: "dim small mono" }, `${ledger.totals[k]} earned · ${s.spent[k]} spent`));
    const queue = s.queue.map((b) => {
      const ends = buildEndsAt(b, overclock);
      const at = new Date(ends);
      return row([h("strong", { class: "grow" }, `${b.rebuildOf !== undefined ? "Repair: " : ""}${name(b.structure)}`), h("span", { class: "dim small mono", title: at.toISOString() }, `${og.formatDuration(ends - now)} left · ready at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`)]);
    });
    const recent = arrOf(summary.recent).slice(0, 6);
    const placeholder = catalogSource === "placeholder";
    const cards = rules.structures.map((st) => {
      const blocked = rules.buildBlocker(s, ledger, st.id);
      const hex = blocked ? null : og.hexFor(rules, s, ledger, st.id, terrain, this.selected);
      const blocker = !root ? "Open a folder to build" : (blocked ?? (hex === null ? "No free ground for it yet" : null));
      const n = s.built.filter((b) => b.structure === st.id).length;
      const url = st.art ? ART[st.art] : undefined;
      const art = url ? h("img", { class: "colony-card-art", src: url, alt: "", loading: "lazy", decoding: "async" }) : h("div", { class: "colony-card-art colony-card-art-none", "aria-hidden": "true" }, h("span", { class: "colony-card-glyph" }, st.glyph));
      const where = hex !== null && this.selected === hex ? ` on hex ${hex}` : "";
      const b = btn(blocker ?? "Build", () => void this.build(st.id), { class: "status-bar-btn", "data-act": "build", "data-structure": st.id, title: blocker ?? `Spend ${og.formatCost(st.cost)} and start building${where}`, "aria-label": `Build ${st.name}` });
      if (blocker) b.disabled = true;
      return h(
        "div",
        { class: "card colony-card" },
        art,
        h("strong", {}, st.name, ...(n ? [h("span", { class: "dim small" }, ` ×${n}`)] : [])),
        h("div", { class: "dim small" }, st.blurb),
        h("div", { class: "dim small mono" }, `${og.formatCost(st.cost)} · ${og.formatDuration(st.build_minutes * 60_000)}${rules.spanOf(st.id) === 2 ? " · two hexes" : ""}`),
        b,
      );
    });
    const offline = s.built.filter((b) => s.offline.includes(b.id));
    const repairs = offline.map((b) => {
      const busy = s.queue.some((q) => q.rebuildOf === b.id);
      const r = btn(busy ? "Repairing" : "Repair", () => void this.repair(b.id), { class: "status-bar-btn", "data-act": "repair", "data-built": String(b.id), title: "Half its cost and half its build time" });
      if (busy) r.disabled = true;
      return row([h("strong", { class: "grow" }, name(b.structure)), chip("offline", "chip-gate"), r]);
    });
    return [
      h(
        "div",
        { class: "toolbar" },
        h("strong", {}, `${green} of ${TILES.length} tiles green · threat tier ${tier}`),
        h("span", { class: "dim small" }, flowText),
        ...(placeholder ? [h("span", { class: "chip", "data-catalog": "placeholder", title: "This build plays the engine's placeholder catalog. Colony release builds play the game's own." }, "Placeholder catalog")] : []),
      ),
      ...(root
        ? []
        : [
            emptyCta({
              icon: "folder",
              headline: "Your colony grows from the work you ship",
              support: "Open a folder: closed to-dos, passing tests, green CI and releases there earn the resources you build with. Until then this is a new colony with nothing earned.",
              actions: [
                { label: "Open folder", onClick: () => this.game.openFolder(), act: "open-folder", title: "Pick the folder whose shipped work grows this colony" },
                { label: "Back", onClick: () => this.game.welcome(), act: "welcome", title: "Back to the welcome screen" },
              ],
            }),
          ]),
      h(
        "div",
        { class: "colony-layout" },
        h(
          "div",
          { class: "card colony-map-card" },
          this.map(s, green, reach, terrain),
          ...(this.selected !== null ? [h("div", { class: "dim small" }, `Hex ${this.selected} selected: Build puts a structure there when it fits.`)] : []),
          ...(root && summary.available === false ? [empty("The ledger was not read on this refresh (snapshot budget); totals come back on the next one.")] : []),
          ...(root && summary.available !== false && !ledger.total ? [empty("Nothing earned yet. Close a to-do, pass the tests (agent-kit outcome-ledger test) or ship a green CI run and the ground starts to turn.")] : []),
        ),
        h(
          "div",
          { class: "colony-side" },
          card({ title: "Resources", icon: "overview" }, h("div", { class: "colony-resources" }, res("Logic", "logic"), res("Compute", "compute"), res("Rare", "rare"))),
          this.threatCard(s, w, name),
          ...(repairs.length ? [card({ title: "Offline", icon: "shield" }, ...repairs)] : []),
          card({ title: "Build queue", icon: "elapsed", aside: [h("span", { class: "card-count" }, `${s.queue.length}/${TUNING.maxBuilds}`)] }, ...(queue.length ? queue : [empty("Nothing under construction. Timers are read when this view refreshes; nothing runs in the background.")])),
          card({ title: "Ship log", icon: "activity" }, ...(recent.length ? recent.map((r: J) => row([chip(og.KIND_LABEL[str(r.kind)] ?? "Outcome"), h("span", { class: "grow ellipsis", title: str(r.label) }, str(r.label))])) : [empty("No outcomes yet.")])),
        ),
      ),
      h("div", { class: "colony-cards" }, ...cards),
      h("p", { class: "dim small" }, "Resources come only from verified outcomes in the kit's ledger, never from lines of code, commits or time. One outcome is one turn: attacks move only when you ship, and nothing lands while you are away. What you build is kept by Colony for this folder."),
    ];
  }

  private threatCard(s: GameState, w: Purse, name: (id: string) => string): HTMLElement {
    const enemy = h("select", { class: "colony-enemy", "data-act": "enemy", "aria-label": "Enemy", title: "How often the Oligarchy attacks" });
    for (const [v, label] of [["on", "Enemy on"], ["rare", "Enemy rare"], ["off", "Enemy off"]] as const) {
      const o = h("option", { value: v }, label);
      if (v === this.enemy()) o.selected = true;
      enemy.append(o);
    }
    enemy.addEventListener("change", () => {
      const root = this.root();
      if (!root) return;
      localStorage.setItem(og.enemyKey(root), og.parseEnemy(enemy.value));
      this.invalidate();
    });
    if (!this.root()) enemy.disabled = true;
    const head = { title: "Oligarchy", icon: "shield" as const, aside: [enemy] };
    const t = s.threat;
    const last = s.lastResolution;
    const lastLine = last ? h("div", { class: "dim small" }, `Last attack: ${rules.threats.find((x) => x.id === last.threat)?.name ?? last.threat}, ${last.outcome === "capture" ? "captured" : last.outcome === "half" ? "half the damage" : "full damage"}.`) : null;
    if (!t) return card(head, empty("No attack in flight."), ...(lastLine ? [lastLine] : []));
    const threat = rules.threats.find((x) => x.id === t.id);
    const left = turnsLeft(s) ?? 0;
    const target = s.built.find((b) => b.id === t.target);
    const cost = rules.countermeasureCost(t.id);
    const affordable = w.logic >= cost.logic && w.compute >= cost.compute && w.rare >= cost.rare;
    const picks = t.picked
      ? [h("div", { class: "small" }, `Answered with ${rules.countermeasures().find((c) => c.id === t.picked)?.name ?? t.picked}.`)]
      : [
          h("div", { class: "dim small" }, `Pick one countermeasure (${og.formatCost(cost)}). The right one captures the attack; one of the same family halves it.`),
          h(
            "div",
            { class: "colony-counters" },
            ...rules.countermeasures().map((c) => {
              const b = btn(c.name, () => void this.counter(c.id), { class: "status-bar-btn", "data-act": "counter", "data-threat": c.id, title: `${c.family} · ${og.formatCost(cost)}` });
              if (!affordable) b.disabled = true;
              return b;
            }),
          ),
        ];
    return card(
      { ...head, aside: [chip(`${left} ${left === 1 ? "turn" : "turns"} left`, "chip-gate"), enemy] },
      h("strong", { "data-threat-live": t.id }, threat?.name ?? t.id),
      h("div", { class: "dim small" }, `Tier ${threat?.tier ?? "?"} · ${threat?.family ?? ""} · ${threat?.vector ?? ""}${target ? ` · aimed at ${name(target.structure)}` : ""}`),
      ...picks,
      ...(lastLine ? [lastLine] : []),
    );
  }

  /** The hex map (SVG): static geometry and catalog glyphs only, no snapshot text. */
  private map(s: GameState, green: number, reach: number, terrain: readonly string[]): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const size = 14;
    const marks = og.tileMarks(rules, s);
    const span = size * Math.sqrt(3) * (MAP_RADIUS + 0.6);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "colony-map");
    svg.setAttribute("viewBox", `${(-span).toFixed(1)} ${(-span).toFixed(1)} ${(span * 2).toFixed(1)} ${(span * 2).toFixed(1)}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Colony map: ${green} of ${TILES.length} tiles green`);
    TILES.forEach((t, i) => {
      const cx = size * Math.sqrt(3) * (t.q + t.r / 2);
      const cy = size * 1.5 * t.r;
      const poly = document.createElementNS(NS, "polygon");
      poly.setAttribute("class", `colony-tile${this.selected === i ? " selected" : ""}`);
      poly.dataset.hex = String(i);
      poly.dataset.tile = ring(i) > reach ? "fog" : s.barren.includes(i) ? "barren" : i < green ? "green" : "ground";
      poly.dataset.terrain = terrain[i];
      poly.setAttribute(
        "points",
        [0, 1, 2, 3, 4, 5]
          .map((k) => {
            const a = (Math.PI / 180) * (60 * k - 30);
            return `${(cx + size * Math.cos(a)).toFixed(1)},${(cy + size * Math.sin(a)).toFixed(1)}`;
          })
          .join(" "),
      );
      if (this.root() && ring(i) <= reach) {
        poly.addEventListener("click", () => {
          this.selected = this.selected === i ? null : i;
          this.invalidate();
        });
      }
      svg.append(poly);
      const m = marks.get(i);
      if (m) {
        const text = document.createElementNS(NS, "text");
        text.setAttribute("class", "colony-glyph");
        text.dataset.mark = m.mark;
        text.setAttribute("x", cx.toFixed(1));
        text.setAttribute("y", (cy + 4).toFixed(1));
        text.setAttribute("text-anchor", "middle");
        text.textContent = m.glyph;
        const title = document.createElementNS(NS, "title");
        title.textContent = `${m.name}${m.mark === "built" ? "" : ` (${m.mark === "queued" ? "under construction" : "offline"})`}`;
        text.append(title);
        svg.append(text);
      }
    });
    return svg;
  }
}
