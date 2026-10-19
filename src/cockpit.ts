// Native Mission Control views (center tabs): Mission, Plans, Queue and Flight Log. They
// render the kit server's snapshot (./snapshot.ts, live over SSE) and turn its copy-only
// actions into real ones through the cockpit host: a driver run of the active plan, the
// queue runner or an interactive vendor CLI in a terminal tab, opening a plan or file.
// Nothing here runs /git-prod or any production promotion.
import { h } from "./api";
import { gateControls, type RunControls } from "./agent";
import { elapsed, type KitRun, type Launch, kitRuns, launches, mergeRuns } from "./launches";
import { runLabel, runs } from "./runs";
import { type J, type McPlan, obj, snapshot, str } from "./snapshot";
import { prose } from "./transcript";
import { ago, bar, btn, card, chip, empty, lifecycleChip, rerender } from "./ui";

export interface CockpitHost {
  status(msg: string): void;
  openRepoFile(rel: string): void;
  /** Driver run of the folder's active plan (opens its agent tab). */
  runPlan(): Promise<unknown>;
  /** `agent-kit run-plan-all` in a terminal tab, after a confirmation. */
  runQueue(): Promise<unknown>;
  /** The vendor CLI in a terminal tab; `prompt` is one allowlisted kit slash command. */
  interactive(prompt?: string, why?: string): Promise<unknown>;
  showTab(id: string): void;
  focusRun(runId: number): void;
  copy(text: string, what: string): void;
  /** The opened folder (launches in other folders do not move its Mission view). */
  workspaceRoot(): string;
}

/** Base: a scrollable center view that re-renders on snapshot or run changes while shown. */
abstract class View {
  readonly el: HTMLElement;
  protected body = h("div", { class: "cv-body" });
  private dirty = true;
  visible = false;

  constructor(protected host: CockpitHost, cls: string) {
    this.el = h("div", { class: `cv ${cls}` }, this.body);
    snapshot.on((why) => why === "data" && this.invalidate());
    runs.on((c) => (c.kind === "state" || c.kind === "gate" || (c.kind === "event" && c.ev.type === "tick_end")) && this.invalidate());
  }

  invalidate() {
    this.dirty = true;
    if (this.visible) this.flush();
  }

  /** Force the next show to render (e.g. after a folder switch). */
  get isDirty() {
    return this.dirty;
  }

  show() {
    this.visible = true;
    this.flush();
  }

  hide() {
    this.visible = false;
  }

  /**
   * Re-render now, unless the operator is typing in a field this view rebuilds (then on
   * blur). A field the view keeps across renders (`keepsFocus`, e.g. the engine picker)
   * does not hold the view back: it is re-attached and gets its focus back.
   */
  flush(force = false) {
    if (!this.dirty) return;
    const a = document.activeElement as HTMLElement | null;
    const field = a && this.el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) ? a : null;
    const kept = !!field && this.keepsFocus(field);
    if (!force && field && !kept) {
      field.addEventListener("blur", () => this.flush(), { once: true });
      return;
    }
    this.dirty = false;
    const sel = kept && field instanceof HTMLInputElement ? [field.selectionStart, field.selectionEnd] : null;
    rerender(this.el, () => this.body.replaceChildren(...this.render()));
    if (kept && field && field.isConnected && document.activeElement !== field) {
      field.focus({ preventScroll: true });
      try {
        if (sel && field instanceof HTMLInputElement) field.setSelectionRange(sel[0], sel[1]);
      } catch {
        /* number inputs have no selection */
      }
    }
  }

  /** Form fields that survive a re-render (the same node is re-attached). */
  protected keepsFocus(_el: HTMLElement): boolean {
    return false;
  }

  protected abstract render(): Node[];

  protected noData(): Node[] | null {
    if (snapshot.data) return null;
    const f = snapshot.feed;
    return [empty(f.error ? `Mission Control data unavailable: ${f.error}` : "Waiting for the Mission Control server…")];
  }
}

function todoLine(label: string, t: { id: string; content: string } | null): HTMLElement | null {
  if (!t) return null;
  return h("div", { class: "todo-line" }, h("span", { class: "dim" }, label), h("code", {}, t.id), h("span", { class: "clamp-2", title: t.content }, t.content));
}

const KIND_LABEL: Record<Launch["kind"], string> = { driver: "▶ run-plan", interactive: "⌘ interactive", queue: "⇶ run-plan-all" };
const planName = (f: string) => f.replace(/\.plan\.md$/, "");
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateChip(l: Launch): HTMLElement {
  if (l.state === "ended") return chip(`ended · exit ${l.exitCode ?? "signal"}`, l.exitCode === 0 ? "chip-done" : "chip-failed");
  if (l.state === "gate") return chip("awaiting gate", "chip-gate");
  return chip(l.state, l.state === "running" ? "chip-running" : "chip-backlog");
}

/** One Colony launch (driver run or agent terminal tab); a click focuses its tab. */
function launchRow(l: Launch, kit: KitRun | undefined, host: CockpitHost): HTMLElement {
  const gateTip = l.gate ? `\nopen gate ${l.gate}${l.kind === "driver" ? "" : " (seen in the terminal output)"}` : "";
  const row = h(
    "div",
    { class: "row click run-row", title: `${l.label} · ${l.root}${gateTip}${kit ? `\nkit reports: ${kit.label}` : ""}` },
    stateChip(l),
    h("span", { class: "dim small run-kind" }, KIND_LABEL[l.kind]),
    h("span", { class: "grow ellipsis" }, h("strong", {}, l.plan ? planName(l.plan) : l.kind === "interactive" ? "no plan" : "HANDOFF plan"), h("span", { class: "dim" }, ` · ${l.backend}`)),
    ...(kit ? [chip("kit sees it", "chip-done")] : []),
    h("span", { class: "dim small", title: l.startedAt }, `${clock(l.startedAt)} · ${elapsed(l.startedAt)}`),
  );
  row.dataset.launch = l.tabId;
  row.dataset.state = l.state;
  row.dataset.plan = l.plan;
  row.addEventListener("click", () => (l.runId !== undefined ? host.focusRun(l.runId) : host.showTab(l.tabId)));
  return row;
}

/**
 * The queue is held when HANDOFF names another plan than the queue cursor while the queue
 * status still says running: a run outside the queue took HANDOFF over.
 */
function queueHold(q: Record<string, unknown>, queue: string[], cursor: number): { plan: string; inQueue: boolean } | null {
  const active = snapshot.activePlanFile;
  if (cursor < 0 || cursor >= queue.length || !active || queue[cursor] === active || !/\brunning\b/i.test(str(q.status))) return null;
  return { plan: active, inQueue: queue.includes(active) };
}

function holdText(hold: { plan: string; inQueue: boolean }, cursorPlan: string): string {
  return hold.inQueue
    ? `HANDOFF is on ${planName(hold.plan)} while the queue cursor still points at ${planName(cursorPlan)}.`
    : `Held by an out-of-queue run: HANDOFF is on ${planName(hold.plan)}, not on the queue cursor ${planName(cursorPlan)}.`;
}

// ---- Mission -------------------------------------------------------------------------
export class MissionView extends View {
  constructor(host: CockpitHost, private controls: RunControls) {
    super(host, "cv-mission");
    launches.on(() => this.invalidate());
  }

  protected keepsFocus(el: HTMLElement): boolean {
    return this.controls.el.contains(el);
  }

  protected render(): Node[] {
    const out: Node[] = [this.hero()];
    if (!snapshot.data) {
      out.push(...(this.noData() ?? []));
      return out;
    }
    out.push(h("div", { class: "grid" }, this.needsYou(), this.runsCard(), this.queueCard(), this.flightCard(), this.activityCard(), this.repoCard()));
    return out;
  }

  private hero(): HTMLElement {
    const now = snapshot.now;
    const plan = snapshot.activePlanFile;
    const sys = snapshot.system;
    // A run Colony launched on another plan than HANDOFF's: show it as the active run
    // until HANDOFF (and so the snapshot) switches to it.
    const pend = snapshot.data ? launches.pending(this.host.workspaceRoot()) : null;
    const pp = pend ? snapshot.plans().find((p) => p.file === pend.plan) : undefined;
    const pr = pend ? (pp?.progress ?? {}) : obj(now.progress);
    const total = Number(pr.total) || 0;
    const done = Number(pr.completed) || 0;
    const actions = h(
      "div",
      { class: "actions" },
      btn("▶ Run plan", () => void this.host.runPlan(), { class: "primary", "data-act": "run-plan", title: "agent-kit run-plan --events ndjson on the active plan; the run opens as a tab with its transcript and gates" }),
      btn("⇶ Run queue", () => void this.host.runQueue(), { "data-act": "run-queue", title: "agent-kit run-plan-all in a terminal tab (the kit has no driver mode for the queue runner)" }),
      btn("⌘ Open interactive", () => void this.host.interactive(), { "data-act": "interactive", title: "The engine's own CLI (claude or codex) in a terminal tab, on your login" }),
      ...(pend ? [btn("Open plan", () => this.host.openRepoFile(pp?.path || `.cursor/plans/${pend.plan}`))] : plan ? [btn("Open plan", () => this.host.openRepoFile(str(now.planPath) || `.cursor/plans/${plan}`))] : []),
      ...(snapshot.data && str(now.sourcePath) ? [btn("Open HANDOFF", () => this.host.openRepoFile(str(now.sourcePath)))] : []),
    );
    const title = pend ? pp?.id || planName(pend.plan) : plan ? str(now.planId) || plan : snapshot.data ? "No active plan" : "Mission";
    const kicker = [str(sys.name), snapshot.git.branch ? `⎇ ${snapshot.git.branch}` : "", pend ? "active run" : str(now.mode)].filter(Boolean).join(" · ") || "Mission Control";
    const todo = (t: J | null | undefined) => (t && obj(t).id ? { id: str(t.id), content: str(t.content) } : null);
    const lc = pend ? (pp?.lifecycle ?? "") : str(now.lifecycle);
    let pending: HTMLElement[] = [];
    if (pend) {
      const note = h(
        "div",
        { class: "launch-pending click", title: "Open its tab" },
        chip("launched from Colony", "chip-running"),
        stateChip(pend),
        h("span", { class: "grow" }, `${KIND_LABEL[pend.kind]} · ${pend.backend} · started ${clock(pend.startedAt)} (${elapsed(pend.startedAt)}) · waiting for HANDOFF to switch to this plan. HANDOFF still names ${plan ? planName(plan) : "no plan"}; ▶ Run plan runs that one.`),
      );
      note.dataset.plan = pend.plan;
      note.dataset.launch = pend.tabId;
      note.addEventListener("click", () => (pend.runId !== undefined ? this.host.focusRun(pend.runId) : this.host.showTab(pend.tabId)));
      pending = [note];
    }
    return h(
      "section",
      { class: "hero" },
      h(
        "div",
        { class: "hero-top" },
        h("div", { class: "grow" }, h("div", { class: "hero-kicker dim" }, kicker), h("h2", {}, title), h("div", { class: "dim mono small" }, pend ? pend.plan : plan || "HANDOFF names no plan: agent-kit run-plan will stop with “no active plan”.")),
        ...(lc ? [lifecycleChip(lc)] : []),
      ),
      ...pending,
      ...(total ? [h("div", { class: "hero-progress" }, bar(done, total), h("span", { class: "dim" }, `${done} of ${total} to-dos`))] : []),
      ...[todoLine("Now", pend ? (pp?.currentTodo ?? null) : todo(now.currentTodo)), todoLine("Next", pend ? (pp?.nextTodo ?? null) : todo(now.nextTodo))].filter((x): x is HTMLElement => !!x),
      ...(!pend && str(now.gaps) ? [h("div", { class: "gaps clamp-3", title: str(now.gaps) }, h("span", { class: "ag-warn" }, "Gaps "), str(now.gaps))] : []),
      actions,
      this.controls.el,
      this.controls.note,
    );
  }

  private needsYou(): HTMLElement {
    const gates = runs.gates();
    const att = snapshot.attention;
    const tickets = Array.isArray(snapshot.gateExit.tickets) ? snapshot.gateExit.tickets : [];
    const items: Node[] = [];
    for (const g of gates) {
      const r = runs.runs.get(g.runId);
      const c = h("div", { class: "gate compact" }, h("div", { class: "dim small" }, r ? runLabel(r) : `#${g.runId}`), h("div", { class: "inbox-line" }, g.line), ...gateControls(g, (m) => this.host.status(m)));
      items.push(c);
    }
    for (const a of att.slice(0, 4)) {
      const row = h("div", { class: "row click" }, chip(str(a.severity || a.group, "info"), a.group === "blocking" ? "chip-gate" : ""), h("span", { class: "grow ellipsis", title: str(a.findingsSummary) }, str(a.label)));
      row.addEventListener("click", () => this.host.showTab("inbox"));
      items.push(row);
    }
    if (tickets.length) items.push(h("div", { class: "row" }, chip(`${tickets.length}`, "chip-gate"), h("span", { class: "grow" }, "gate-exit ticket(s) pending: see Flight Log")));
    const n = gates.length + att.length + tickets.length;
    const title = h("span", {}, "Needs you ", n ? chip(String(n), gates.length ? "chip-gate" : "") : "");
    return card(title, ...(items.length ? items : [empty("Nothing waits for you.")]), ...(att.length > 4 ? [btn(`All ${att.length} in Inbox`, () => this.host.showTab("inbox"), { class: "link" })] : []));
  }

  private runsCard(): HTMLElement {
    const { mine, kit, kitSeen } = mergeRuns(launches.list(), kitRuns());
    const rows: Node[] = mine.slice(0, 8).map((l) => launchRow(l, kitSeen.get(l.tabId), this.host));
    if (mine.length > 8) rows.push(h("div", { class: "dim small" }, `${mine.length - 8} older launch(es) in this window`));
    for (const k of kit.slice(0, 4)) {
      const r = h("div", { class: "row kit-run", title: k.label }, chip("kit", ""), h("span", { class: "grow ellipsis" }, k.plan ? h("strong", {}, planName(k.plan)) : "", k.plan ? " · " : "", k.label), ...(k.at ? [h("span", { class: "dim small" }, ago(k.at))] : []));
      r.dataset.kit = k.key;
      rows.push(r);
    }
    const live = mine.filter((l) => l.state !== "ended").length;
    const title = h("span", {}, "Agent runs ", live ? chip(`${live} live`, "chip-running") : "");
    return card(title, ...(rows.length ? rows : [empty("No runs in this window. ▶ Run plan, ⌘ Open interactive and the plan actions start one; each opens as its own tab.")]));
  }

  private queueCard(): HTMLElement {
    const q = snapshot.runQueue;
    const queue: string[] = Array.isArray(q.queue) ? q.queue.map(String) : [];
    const cursor = typeof q.cursor === "number" ? q.cursor : -1;
    const hold = queueHold(q, queue, cursor);
    const mark = (i: number) => (i !== cursor ? String(i + 1) : hold ? "⏸" : "▶");
    const rows = queue.slice(0, 6).map((p, i) => h("div", { class: `row ${i === cursor ? (hold ? "held" : "current") : ""}` }, h("span", { class: "dim num-col" }, mark(i)), h("span", { class: "grow ellipsis" }, p.replace(/\.plan\.md$/, "")), ...(q.outcomes?.[p] ? [chip(String(q.outcomes[p]))] : [])));
    const held = hold ? [h("div", { class: "queue-held" }, chip("held", "chip-gate"), h("span", { class: "grow" }, holdText(hold, queue[cursor])))] : [];
    const more = btn("Open Queue", () => this.host.showTab("queue"), { class: "link" });
    return card("Queue", ...held, ...(rows.length ? rows : [empty("No run-plan-all queue in HANDOFF.")]), more);
  }

  private flightCard(): HTMLElement {
    const f = snapshot.flightLog;
    const cur = str(f.current);
    const more = btn("Open Flight Log", () => this.host.showTab("flight"), { class: "link" });
    return card("Flight log", cur ? h("div", { class: "clamp-4", title: cur }, chip(str(f.currentKind, "now")), " ", cur) : empty("No open residuals."), more);
  }

  private activityCard(): HTMLElement {
    const list = snapshot.activity.slice(0, 8);
    return card("Activity", ...(list.length ? list.map((a) => h("div", { class: "row" }, chip(str(a.kind)), h("span", { class: "grow ellipsis", title: str(a.label) }, str(a.label)), h("span", { class: "dim" }, ago(a.at)))) : [empty("No recent activity.")]));
  }

  private repoCard(): HTMLElement {
    const g = snapshot.git;
    const checks = Array.isArray(snapshot.health.checks) ? snapshot.health.checks : [];
    const flow = obj(g.flow);
    const ab = (x: J) => (x && typeof x === "object" ? `↑${x.ahead ?? 0} ↓${x.behind ?? 0}` : "");
    return card(
      "Repository",
      h("div", { class: "row" }, h("strong", {}, `⎇ ${str(g.branch, "?")}`), h("span", { class: "dim" }, g.dirty ? `${g.dirtyCount ?? "?"} changed` : "clean"), h("span", { class: "spacer" }), btn("Git", () => this.host.showTab("git"), { class: "link" })),
      ...(g.lastCommit ? [h("div", { class: "mono small ellipsis", title: str(g.lastCommit) }, str(g.lastCommit))] : []),
      ...(flow.vsMain || flow.vsStaging ? [h("div", { class: "dim small" }, [flow.vsStaging ? `vs staging ${ab(flow.vsStaging)}` : "", flow.vsMain ? `vs main ${ab(flow.vsMain)}` : ""].filter(Boolean).join(" · "))] : []),
      h("div", { class: "chips" }, ...checks.map((c: J) => chip(`${c.ok ? "✓" : "✕"} ${str(c.label || c.id)}`, c.ok ? "chip-done" : "chip-failed"))),
    );
  }
}

// ---- Plans ---------------------------------------------------------------------------
const PLAN_FILTERS: [string, string, (p: McPlan) => boolean][] = [
  ["open", "Open", (p) => p.lifecycle !== "completed"],
  ["queue", "In queue", (p) => p.queueRole !== "none"],
  ["backlog", "Backlog", (p) => p.lifecycle === "backlog"],
  ["parked", "Parked", (p) => p.lifecycle === "parked"],
  ["incomplete", "Incomplete", (p) => p.lifecycle === "incomplete"],
  ["completed", "Completed", (p) => p.lifecycle === "completed"],
  ["all", "All", () => true],
];
const TODO_ICON: Record<string, string> = { completed: "✓", in_progress: "●", pending: "○", cancelled: "✕" };

export class PlansView extends View {
  private filter = "open";
  private query = "";
  private expanded = new Set<string>();
  private search = h("input", { type: "search", placeholder: "Filter plans", class: "search" });

  constructor(host: CockpitHost) {
    super(host, "cv-plans");
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.invalidate();
      this.flush(true);
      this.search.focus();
    });
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const plans = snapshot.plans();
    const active = snapshot.activePlanFile;
    const chips = PLAN_FILTERS.map(([id, label, f]) => {
      const n = plans.filter(f).length;
      const b = btn(`${label} ${n}`, () => {
        this.filter = id;
        this.invalidate();
      }, { class: `filter ${this.filter === id ? "on" : ""}` });
      b.dataset.filter = id;
      return b;
    });
    const f = PLAN_FILTERS.find((x) => x[0] === this.filter)?.[2] ?? (() => true);
    const order = (p: McPlan) => (p.file === active ? 0 : p.queueRole === "executing" ? 1 : p.queueIndex !== null ? 2 + p.queueIndex : 50);
    const shown = plans
      .filter(f)
      .filter((p) => !this.query || `${p.id} ${p.file} ${p.overview}`.toLowerCase().includes(this.query))
      .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
    return [
      h("div", { class: "toolbar" }, h("div", { class: "chips" }, ...chips), this.search),
      h("div", { class: "plan-list" }, ...(shown.length ? shown.map((p) => this.row(p, p.file === active)) : [empty("No plans match.")])),
    ];
  }

  private row(p: McPlan, active: boolean): HTMLElement {
    const open = this.expanded.has(p.file);
    const acts: HTMLElement[] = [btn("Open", () => this.host.openRepoFile(p.path || `.cursor/plans/${p.file}`), { title: p.path })];
    if (active) acts.unshift(btn("▶ Run", () => void this.host.runPlan(), { class: "primary", "data-act": "run-plan", title: "agent-kit run-plan --events ndjson (this is the HANDOFF plan)" }));
    else if (p.lifecycle !== "completed") {
      acts.unshift(
        btn("Run…", () => void this.host.interactive(`/run-plan ${p.file}`, `agent-kit run-plan only runs the HANDOFF plan (${snapshot.activePlanFile || "none"}). This opens your agent interactively with /run-plan ${p.file}, which activates it.`), {
          "data-act": "run-other",
          title: "Opens your agent interactively with /run-plan <plan> (agent-kit run-plan has no plan argument)",
        }),
      );
    }
    if (p.lifecycle === "backlog") acts.push(btn("Edit…", () => void this.host.interactive(`/backlog-edit ${p.file}`), { title: "/backlog-edit in your agent, interactively" }));
    if (["parked", "incomplete", "executing", "awaiting_user"].includes(p.lifecycle)) acts.push(btn("Resume…", () => void this.host.interactive(`/continue-plan ${p.file}`), { title: "/continue-plan in your agent, interactively" }));
    const head = h(
      "div",
      { class: `plan-row ${active ? "active" : ""}` },
      h("span", { class: "caret" }, open ? "▾" : "▸"),
      lifecycleChip(p.lifecycle),
      h("div", { class: "plan-name grow" }, h("div", { class: "ellipsis" }, h("strong", {}, p.id), active ? chip("active", "chip-running") : "", p.queueRole !== "none" ? chip(p.queueRole.replace(/_/g, " ")) : ""), h("div", { class: "dim small ellipsis", title: p.overview }, p.overview)),
      h("div", { class: "plan-progress" }, bar(p.progress.completed, p.progress.total), h("span", { class: "dim small" }, p.progress.label || `${p.progress.completed}/${p.progress.total}`)),
      h("div", { class: "actions" }, ...acts),
    );
    head.dataset.plan = p.file;
    head.addEventListener("click", () => {
      if (open) this.expanded.delete(p.file);
      else this.expanded.add(p.file);
      this.invalidate();
    });
    if (!open) return head;
    const todos = p.todos.length
      ? p.todos.map((t) => h("div", { class: `todo st-${t.status}` }, h("span", { class: "todo-icon" }, TODO_ICON[t.status] ?? "·"), h("code", {}, t.id), h("span", { class: "clamp-2", title: t.content }, t.content)))
      : [empty("No to-do list in the snapshot.")];
    return h("div", { class: "plan-wrap open" }, head, h("div", { class: "todos" }, ...todos));
  }
}

// ---- Queue ---------------------------------------------------------------------------
export class QueueView extends View {
  constructor(host: CockpitHost) {
    super(host, "cv-queue");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const q = snapshot.runQueue;
    const queue: string[] = Array.isArray(q.queue) ? q.queue.map(String) : [];
    const cursor = typeof q.cursor === "number" ? q.cursor : -1;
    const plans = new Map(snapshot.plans().map((p) => [p.file, p]));
    const hold = queueHold(q, queue, cursor);
    const head = h(
      "section",
      { class: "hero" },
      h("div", { class: "hero-top" }, h("div", { class: "grow" }, h("div", { class: "hero-kicker dim" }, "run-plan-all"), h("h2", {}, queue.length ? `${queue.length} plans · cursor ${cursor >= 0 ? cursor + 1 : "-"}${hold ? " · held" : ""}` : "No queue")), hold ? chip("held", "chip-gate") : "", q.nextUpPlan ? chip(`next up ${String(q.nextUpPlan).replace(/\.plan\.md$/, "")}`) : ""),
      ...(hold ? [h("div", { class: "queue-held" }, h("span", { class: "grow" }, holdText(hold, queue[cursor]), " The queue resumes at its cursor once that run hands HANDOFF back (Queue status in HANDOFF)."))] : []),
      h(
        "div",
        { class: "actions" },
        btn("⇶ Run queue", () => void this.host.runQueue(), { class: "primary", "data-act": "run-queue", title: "agent-kit run-plan-all in a terminal tab" }),
        btn("Open HANDOFF", () => this.host.openRepoFile(".cursor/HANDOFF.md")),
      ),
      h("p", { class: "hint" }, "The kit runs the queue with agent-kit run-plan-all, which has no driver mode yet: it opens in a terminal tab and its numbered gates are answered there."),
    );
    const rows = queue.map((file, i) => {
      const p = plans.get(file);
      const state = i < cursor ? "past" : i === cursor ? (hold ? "held" : "current") : "future";
      const r = h(
        "div",
        { class: `q-row ${state}` },
        h("span", { class: "q-idx" }, i !== cursor ? String(i + 1) : hold ? "⏸" : "▶"),
        h("div", { class: "grow" }, h("div", { class: "ellipsis" }, h("strong", {}, file.replace(/\.plan\.md$/, ""))), p ? h("div", { class: "dim small ellipsis" }, p.currentTodo ? `${p.currentTodo.id}` : p.overview) : h("div", { class: "dim small" }, "plan file not in the snapshot")),
        ...(q.outcomes?.[file] ? [chip(String(q.outcomes[file]), String(q.outcomes[file]) === "completed" ? "chip-done" : "chip-parked")] : []),
        ...(p ? [lifecycleChip(p.lifecycle), h("div", { class: "plan-progress" }, bar(p.progress.completed, p.progress.total), h("span", { class: "dim small" }, `${p.progress.completed}/${p.progress.total}`))] : []),
        btn("Open", () => this.host.openRepoFile(p?.path || `.cursor/plans/${file}`)),
      );
      r.dataset.plan = file;
      return r;
    });
    const status = str(q.status);
    return [head, h("div", { class: "q-list" }, ...(rows.length ? rows : [empty("HANDOFF has no run-plan-all queue. /run-plan-all in your agent proposes one.")])), ...(status ? [card("Queue status (HANDOFF)", prose(status))] : [])];
  }
}

// ---- Flight Log ----------------------------------------------------------------------
export class FlightLogView extends View {
  constructor(host: CockpitHost) {
    super(host, "cv-flight");
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const f = snapshot.flightLog;
    const out: Node[] = [];
    const entry = (label: string, text: string, kind: string, source: string, command: string | null, at?: string) =>
      h(
        "div",
        { class: `fl-card ${label === "Now" ? "now" : ""}` },
        h("div", { class: "row" }, chip(label, label === "Now" ? "chip-gate" : ""), kind ? chip(kind) : "", h("span", { class: "dim small grow ellipsis" }, [at, source].filter(Boolean).join(" · ")), btn("Open", () => this.host.openRepoFile(source || ".cursor/HANDOFF.md"), { class: "link" }), ...(command ? [btn("Copy fix prompt", () => this.host.copy(command, "fix prompt"), { class: "link", title: "Copied for your agent's chat input" })] : [])),
        h("div", { class: "fl-text" }, text),
      );
    if (str(f.current)) out.push(entry("Now", str(f.current), str(f.currentKind), str(f.sourcePath), str(obj(f.currentAction).command) || null));
    for (const w of Array.isArray(f.warnings) ? f.warnings : []) out.push(entry(str(w.title, "Warning"), str(w.text), str(w.kind, "warning"), str(w.sourcePath), str(obj(w.action).command) || null));
    const tickets = Array.isArray(f.tickets) && f.tickets.length ? f.tickets : Array.isArray(snapshot.gateExit.tickets) ? snapshot.gateExit.tickets : [];
    if (tickets.length) {
      out.push(
        card(
          "Gate-exit tickets",
          ...tickets.map((t: J) => h("div", { class: "row" }, chip(str(t.branchState, "ticket")), h("span", { class: "grow ellipsis", title: str(t.headline) }, `${str(t.askId)} · ${str(t.headline)}`), h("span", { class: "dim small" }, ago(t.openedAt)), ...(t.url ? [btn("Copy URL", () => this.host.copy(str(t.url), "ticket URL"), { class: "link" })] : []))),
          h("div", { class: "hint" }, "Triage with agent-kit ground-control (status / accept / discard) in a terminal."),
          btn("Copy agent-kit ground-control status", () => this.host.copy("agent-kit ground-control status", "command"), { class: "link" }),
        ),
      );
    }
    const triages = Array.isArray(f.quietOpenTriages) ? f.quietOpenTriages : [];
    if (triages.length) out.push(card("Open triages", ...triages.map((t: J) => h("div", { class: "row" }, chip(str(t.kind)), h("span", { class: "grow ellipsis", title: str(t.findingsSummary) }, str(t.label)), btn("Inbox", () => this.host.showTab("inbox"), { class: "link" })))));
    const past = Array.isArray(f.past) ? f.past : [];
    for (const p of past) out.push(entry("Earlier", str(p.text), str(p.kind), str(p.sourcePath), null, str(p.at)));
    // Ticks of the runs in this window (live), then the at-rest tick logs (runLogs).
    const live = runs
      .list()
      .flatMap((r) => r.reviews.map((rv) => ({ r, rv })))
      .sort((a, b) => b.rv.at.localeCompare(a.rv.at));
    if (live.length) {
      out.push(
        card(
          "Ticks in this window",
          ...live.map(({ r, rv }) => {
            const row = h("div", { class: "row click" }, chip(`tick ${rv.tick}`), h("span", { class: "grow ellipsis mono small" }, rv.resultLine || "no LOOP_TICK_RESULT"), h("span", { class: "dim small" }, `${runLabel(r)} · ${rv.files.length} files`));
            row.addEventListener("click", () => this.host.focusRun(r.id));
            return row;
          }),
        ),
      );
    }
    const logs = snapshot.runLogs;
    out.push(
      card(
        "Tick logs (.cursor/loop-logs)",
        ...(logs.length
          ? logs.map((l) => {
              const res = obj(l.result);
              const row = h(
                "div",
                { class: "log-row" },
                h("div", { class: "row" }, chip(str(l.kind)), h("strong", { class: "ellipsis grow mono small" }, str(l.id)), str(l.sentinel) ? chip(str(l.sentinel).replace(/^LOOP_TICK_RESULT:\s*/, ""), "chip-done") : "", ...(Array.isArray(l.gates) && l.gates.length ? [chip(`gates ${l.gates.join(", ")}`, "chip-gate")] : []), h("span", { class: "dim small" }, ago(l.updatedAt)), btn("Open", () => this.host.openRepoFile(str(l.path)), { class: "link" })),
                str(l.lastText) ? h("div", { class: "dim small clamp-3", title: str(l.lastText) }, str(l.lastText)) : "",
                res.isError ? h("div", { class: "ag-err small" }, `result: ${str(res.subtype, "error")}`) : "",
              );
              return row;
            })
          : [empty("No headless tick logs yet.")]),
      ),
    );
    return out.length ? out : [empty("Flight log is empty.")];
  }
}
