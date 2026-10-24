// Native Mission Control views (center tabs): Mission, Plans, Queue and Flight Log. They
// render the kit server's snapshot (./snapshot.ts, live over SSE) and turn its copy-only
// actions into real ones through the cockpit host: a driver run of the active plan, the
// queue runner or an interactive vendor CLI in a terminal tab (a saved chat resumed
// included), opening a plan or file.
// Nothing here runs /git-prod or any production promotion.
import { type ChatSession, h } from "./api";
import type { RunControls } from "./agent";
import { chats } from "./chats";
import { pendingGates } from "./gates";
import { icon, type IconKind } from "./icons";
import { gateCard, triageChip } from "./inbox";
import { elapsed, type KitRun, type Launch, kitRuns, launches, mergeRuns } from "./launches";
import { type Readiness, READINESS_FILE, type ReadinessCheck, readiness } from "./readiness";
import { liveQueueRun, type QueueState, queuePosition, type Run, runLabel, runs } from "./runs";
import { type J, type McPlan, obj, snapshot, str } from "./snapshot";
import { inlineMd, plainMd, prose } from "./transcript";
import { ago, btn, bytes, card, cardHeader, type CheckTone, checkChip, chip, empty, iconBtn, lifecycleChip, metaRow, pill, rerender, type Step, stepbar, stepper, type Tone } from "./ui";

export interface CockpitHost {
  status(msg: string): void;
  openRepoFile(rel: string): void;
  /** Driver run of the folder's active plan (opens its agent tab). */
  runPlan(): Promise<unknown>;
  /** `agent-kit run-plan-all` in a terminal tab, after a confirmation. */
  runQueue(): Promise<unknown>;
  /** The vendor CLI in a terminal tab; `prompt` is one allowlisted kit slash command. */
  interactive(prompt?: string, why?: string): Promise<unknown>;
  /** `claude --resume <id>` in a terminal tab labelled `title`, or focus its open tab. */
  resumeChat(id: string, title: string): Promise<unknown>;
  showTab(id: string): void;
  focusRun(runId: number): void;
  copy(text: string, what: string): void;
  /** The opened folder (launches in other folders do not move its Mission view). */
  workspaceRoot(): string;
  /** `agent-kit install` in a bottom terminal tab, after a confirmation (it asks its own questions there). */
  installKit(): Promise<unknown>;
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
   * blur). A field the view keeps across renders (`keepsFocus`) does not hold the view
   * back: it is re-attached and gets its focus back.
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

type Todo = { id: string; content: string } | null;

/** Mission status of the dashboard's nowStatusMeta(): label, pill tone and mark. */
function statusMeta(status: string): [string, Tone, string] {
  if (status === "executing") return ["Executing", "running", "\u25B6"]; // now-status-executing is green
  if (status === "awaiting_user") return ["Awaiting", "awaiting", "\u23EF"];
  if (status === "completed") return ["Completed", "completed", "\u2713"];
  return ["Idle", "idle", "\u25CB"];
}

/**
 * Previous / current / next steps as the dashboard's renderNowStepper() words them; a
 * completed mission shows its renderNowCompletedStepper(): Final step, then Next (up).
 */
function missionSteps(prev: Todo, cur: Todo, next: Todo, o: { status: string; planDone: boolean; nextUpPlan: string; done: number; total: number }): Step[] {
  if (o.status === "completed") {
    const count = o.total > 0 ? `${Math.min(o.done, o.total)} of ${o.total} steps done` : "no steps recorded";
    const last = cur ?? prev;
    return [
      { label: "Final step", todo: last, text: "Plan complete", mark: "\u2713", state: "done", cls: "now-step-final now-step-done" },
      o.nextUpPlan
        ? { label: "Next up", text: `${planName(o.nextUpPlan)} (next plan in the run queue)`, mark: "\u25CB", state: "pending", cls: "now-step-next" }
        : { label: "Next", text: `None: mission complete (${count})`, mark: "\u2014", state: "empty", cls: "now-step-next now-step-terminal" },
    ];
  }
  const live = statusMeta(o.status)[2];
  const mark = o.planDone ? "\u2713" : o.status === "executing" || o.status === "awaiting_user" ? live : "\u25B6";
  const awaiting = o.status === "awaiting_user";
  return [
    { label: "Previous", todo: prev, text: "None \u2014 first step", mark: prev ? "\u2713" : "\u25CB", state: prev ? "done" : "empty", cls: "now-step-previous" },
    {
      label: "Current",
      todo: cur,
      text: o.planDone ? "Plan complete" : awaiting ? "Awaiting user decision" : "\u2014",
      mark,
      state: o.planDone ? "done" : cur ? "current" : "empty",
      cls: `now-step-current${o.planDone ? " now-step-done" : ""}`,
    },
    {
      label: o.planDone && o.nextUpPlan ? "Next up" : "Next",
      todo: next,
      text: o.planDone ? (o.nextUpPlan ? `${planName(o.nextUpPlan)} (next plan in the run queue)` : "None \u2014 plan complete") : awaiting ? "Awaiting user decision" : "None \u2014 last step",
      mark: "\u25CB",
      state: next ? "pending" : "empty",
      cls: "now-step-next",
    },
  ];
}

/** Total and current-step time of the active plan (dashboard now-meta timing). */
function timing(now: J): string {
  const started = str(now.timingStartedAt);
  if (!started || Number.isNaN(Date.parse(started))) return "";
  const frozen = str(now.timingFrozenAt);
  if (frozen) return `${typeof now.totalElapsedMs === "number" ? fmtMs(now.totalElapsedMs) : elapsed(started)} total (stopped)`;
  const stage = str(now.currentStageStartedAt);
  return `${elapsed(started)} total${stage && stage !== started ? ` \u00b7 ${elapsed(stage)} this step` : ""}`;
}
const fmtMs = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`);

/** Flight Log entry kinds with their own color (dashboard flight-log-kind-*). */
const flKind = (k: string) => (k === "ok" || k === "warning" ? k : k === "advice" || k === "prompt" ? "advice" : "residual");

const KIND_LABEL: Record<Launch["kind"], string> = { driver: "run-plan", interactive: "interactive", queue: "run-plan-all" };
const KIND_ICON: Record<Launch["kind"], IconKind> = { driver: "play", interactive: "terminals", queue: "queue" };
const planName = (f: string) => f.replace(/\.plan\.md$/, "");
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateChip(l: Launch): HTMLElement {
  if (l.state === "ended") return l.exitCode === 0 ? pill("Ended · exit 0", "completed", "\u2713") : pill(`Ended · exit ${l.exitCode ?? "signal"}`, "failed", "\u2715");
  if (l.state === "gate") return pill("Awaiting gate", "awaiting", "\u23EF");
  return l.state === "running" ? pill("Running", "running", "\u25B6") : pill(l.state, "backlog", "\u25CB");
}

/** One Colony launch (driver run or agent terminal tab); a click focuses its tab. */
function launchRow(l: Launch, kit: KitRun | undefined, host: CockpitHost): HTMLElement {
  const gateTip = l.gate ? `\nopen gate ${l.gate}${l.runId !== undefined ? "" : " (seen in the terminal output)"}` : "";
  const name = l.plan ? planName(l.plan) : l.queue ? queueText(l.queue) : l.kind === "interactive" ? "no plan" : "HANDOFF plan";
  const row = h(
    "div",
    { class: "row click run-row", title: `${name}\n${l.label} · ${l.root}${gateTip}${kit ? `\nkit reports: ${kit.label}` : ""}` },
    stateChip(l),
    // The one flexible field: the name ellipsizes (full text in the row title); the fields
    // after it drop whole by card width (container queries in styles.css), never cut.
    h("span", { class: "grow ellipsis run-name" }, h("strong", {}, name)),
    ...(kit ? [chip("kit sees it", "chip-done run-kit")] : []),
    h(
      "span",
      { class: "run-meta mono", title: `${KIND_LABEL[l.kind]} · ${l.backend} · started ${l.startedAt}` },
      h("span", { class: "run-kind" }, icon(KIND_ICON[l.kind], "btn-icon"), KIND_LABEL[l.kind]),
      h("span", { class: "run-backend" }, l.backend),
      h("span", { class: "run-clock" }, clock(l.startedAt)),
      h("span", { class: "run-elapsed" }, elapsed(l.startedAt)),
    ),
  );
  row.dataset.launch = l.tabId;
  row.dataset.state = l.state;
  row.dataset.plan = l.plan;
  if (l.queue) row.dataset.queueCursor = String(l.queue.cursor ?? "");
  row.addEventListener("click", () => (l.runId !== undefined ? host.focusRun(l.runId) : host.showTab(l.tabId)));
  return row;
}

/** A queue plan is finished when its outcome or its lifecycle says completed (a deferred or
 *  blocked plan behind the cursor is passed, not done: no green check for it). */
function finished(q: J, file: string): boolean {
  if (String(q.outcomes?.[file] ?? "") === "completed") return true;
  return snapshot.plans().find((p) => p.file === file)?.lifecycle === "completed";
}

/** Run queue is the primary action only when the queue can move: not held, cursor inside the
 *  queue, and some plan from the cursor on without an outcome yet. */
function queueRunnable(q: J, queue: string[], cursor: number, held: boolean): boolean {
  if (held || !queue.length || cursor >= queue.length) return false;
  return queue.slice(Math.max(cursor, 0)).some((f) => !q.outcomes?.[f]);
}

/** `queue 2/8 · <current plan>` for a driver queue run. */
function queueText(q: QueueState): string {
  return `queue ${queuePosition(q)}${q.current ? ` · ${planName(q.current)}` : ""}`;
}

/**
 * The queue as Mission and the Queue view show it: the list from the snapshot, the cursor
 * and status from the live `run-plan-all` driver run when there is one (its `queue_state`
 * events), else from the snapshot. Both are read-only projections of HANDOFF.
 */
function queueNow(root: string): { q: J; queue: string[]; cursor: number; hold: { plan: string; inQueue: boolean } | null; live: Run | null } {
  const q = snapshot.runQueue;
  const queue: string[] = Array.isArray(q.queue) ? q.queue.map(String) : [];
  const live = liveQueueRun(root);
  const lq = live?.queue && live.queue.total > 0 ? live.queue : null;
  const cursor = lq ? (lq.cursor ?? -1) : typeof q.cursor === "number" ? q.cursor : -1;
  const held = lq?.status?.toLowerCase() === "held";
  const active = snapshot.activePlanFile;
  const hold = held ? { plan: active, inQueue: queue.includes(active) } : lq && lq.status?.toLowerCase() !== "running" ? null : queueHold(q, queue, cursor);
  return { q, queue, cursor, hold, live };
}

/** The live queue run: position, current plan, status, its open gate; a click opens it. */
function liveQueueNote(live: Run, host: CockpitHost): HTMLElement {
  const q = live.queue;
  const held = q?.status?.toLowerCase() === "held";
  const note = h(
    "div",
    { class: "launch-pending click queue-live", title: "Open its tab" },
    held ? pill("Queue held", "awaiting", "\u23F8") : pill("Queue run", "running", "\u21F6"),
    ...(live.gate ? [pill(`Gate ${live.gate.askId}`, "awaiting", "\u23EF")] : []),
    h("span", { class: "grow" }, `#${live.id} · ${live.backend} · ${q ? `${queueText(q)}${q.status ? ` · ${q.status}` : ""}` : "waiting for the first queue_state"} · started ${clock(live.startedAt)} (${elapsed(live.startedAt)})${live.gate ? " · answer it in the Inbox" : ""}`),
  );
  note.dataset.run = String(live.id);
  note.dataset.cursor = String(q?.cursor ?? "");
  note.dataset.status = q?.status ?? "";
  note.addEventListener("click", () => host.focusRun(live.id));
  return note;
}

const RUN_QUEUE_TIP = "agent-kit run-plan-all: an agent run whose gates reach the Inbox (engine driver protocol 1.2.0 or newer), else a terminal tab";

const CHAT_SOURCE: Record<ChatSession["titleSource"], string> = { custom: "name you set", ai: "title from Claude Code", "first-prompt": "first prompt", none: "no title" };
const CHATS_SHOWN = 8;

/** One saved chat; a click (or Resume) opens it again in a terminal tab. */
function chatRow(c: ChatSession, host: CockpitHost): HTMLElement {
  const title = c.title || "Untitled chat";
  const saved = new Date(c.modified).toISOString();
  const resume = () => void host.resumeChat(c.id, c.title);
  const row = h(
    "div",
    { class: "row click chat-row", title: `${title} (${CHAT_SOURCE[c.titleSource]})\nsession ${c.id} · ${bytes(c.sizeBytes)} · saved ${saved}\nclaude --resume ${c.id}` },
    h("span", { class: "grow ellipsis" }, c.title ? h("strong", {}, title) : h("span", { class: "dim" }, title)),
    h("span", { class: "run-meta mono" }, h("span", {}, ago(saved)), h("span", {}, c.id.slice(0, 8))),
    btn("Resume", resume, { class: "link", "data-act": "resume" }),
  );
  row.dataset.chat = c.id;
  row.dataset.source = c.titleSource;
  row.addEventListener("click", (ev) => !(ev.target as HTMLElement).closest("button") && resume());
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

// ---- First run -----------------------------------------------------------------------
/** Readiness status -> check chip tone and label (readiness.json status vocabulary). */
const CHECK_STATUS: Record<ReadinessCheck["status"], [CheckTone, string]> = {
  ready: ["ok", "ready"],
  auto_fix: ["todo", "safe fix"],
  needs_choice: ["todo", "needs your choice"],
  manual: ["manual", "manual"],
  blocked: ["fail", "blocked"],
};

const ONBOARD = "/agent-kit-onboard";
const ONBOARD_WHY = "/agent-kit-onboard runs agent-kit doctor, applies only safe local fixes and asks you before anything else (CI/CD, hooks, remotes and scaffold always wait for your answer).";
const KIT_INSTALL = "npx @dadado/agent-kit-cli@latest install";

/** First-run state of the opened folder: what the Mission view puts first. */
type FirstRun = { kind: "no-kit" } | { kind: "no-report"; error: string } | { kind: "unresolved"; r: Readiness };

function firstRunState(): FirstRun | null {
  if (!readiness.loaded) return null;
  if (!readiness.kit) return { kind: "no-kit" };
  if (!readiness.report) return { kind: "no-report", error: readiness.error };
  return readiness.report.unresolved.length ? { kind: "unresolved", r: readiness.report } : null;
}

/** One mission of the list: marker, title (and detail), status chip; `current` is the next action. */
function missionRow(o: { title: string; detail?: string; tone: CheckTone; status: string; state: "done" | "current" | "pending"; tip?: string }): HTMLElement {
  return h(
    "li",
    { class: `fr-mission ${o.state}`, title: o.tip ?? [o.title, o.detail].filter(Boolean).join("\n") },
    h("span", { class: "now-step-marker", "aria-hidden": "true" }, o.state === "done" ? "✓" : o.state === "current" ? "▶" : "○"),
    h("span", { class: "fr-mission-text" }, h("span", { class: "fr-mission-title ellipsis" }, o.title), ...(o.detail ? [h("span", { class: "fr-mission-detail ellipsis" }, o.detail)] : [])),
    checkChip(o.status, o.tone),
  );
}

const onboardBtn = (host: CockpitHost, cls = "primary") =>
  iconBtn("play", `Ask agent: ${ONBOARD}`, () => void host.interactive(ONBOARD, ONBOARD_WHY), { class: cls, "data-act": "onboard", title: `Opens your agent interactively with ${ONBOARD}` });

/**
 * The welcome and readiness screen: the kit's onboarding as a mission list, in the order of
 * /agent-kit-onboard's first message (Repository preparation: N of M essential checks
 * ready / Detected / Fixed / Next: one action). Colony only reads readiness.json and opens
 * the agent with /agent-kit-onboard; it applies nothing itself.
 */
function firstRunCard(fr: FirstRun, host: CockpitHost): HTMLElement {
  const recheck = iconBtn("refresh", "Check again", () => void readiness.load(), { class: "link", "data-act": "readiness-recheck", title: `Read ${READINESS_FILE} again (also read on every Mission Control update)` });
  const steps = (install: "done" | "current", onboard: "current" | "pending") => [
    missionRow({ title: "Install Agent Kit", detail: install === "done" ? "" : KIT_INSTALL, tone: install === "done" ? "ok" : "todo", status: install === "done" ? "ready" : "next", state: install }),
    missionRow({ title: "Prepare the repository", detail: `${ONBOARD}: readiness checks, purpose, profile`, tone: "todo", status: onboard === "current" ? "next" : "after install", state: onboard }),
    missionRow({ title: "Start a first plan", detail: "/start-project", tone: "todo", status: "after onboarding", state: "pending" }),
  ];
  let body: Node[];
  let aside: Node[] = [recheck];
  if (fr.kind === "no-kit") {
    body = [
      h("h2", { class: "now-plan-name" }, "This folder has no Agent Kit yet"),
      h("p", { class: "fr-lead" }, "Colony's missions come from the kit: plans, HANDOFF and the repository readiness checks. Three steps lead from here to a first plan."),
      h("ol", { class: "fr-missions", "aria-label": "First-run missions" }, ...steps("current", "pending")),
      h("div", { class: "fr-next" }, h("strong", {}, "Next: "), "install the kit in a terminal tab; the installer asks its own questions there."),
      h(
        "div",
        { class: "actions now-actions" },
        iconBtn("terminals", "Install in a terminal", () => void host.installKit(), { class: "primary", "data-act": "install-kit", title: `${KIT_INSTALL} in a terminal tab of this folder, after a confirmation` }),
        btn("Copy command", () => host.copy(KIT_INSTALL, "the install command"), { class: "status-bar-btn" }),
      ),
    ];
  } else if (fr.kind === "no-report") {
    body = [
      h("h2", { class: "now-plan-name" }, "Prepare the repository"),
      h("p", { class: "fr-lead" }, fr.error ? `${READINESS_FILE} could not be used: ${fr.error}` : `No readiness report yet. ${ONBOARD} checks the folder (agent-kit doctor), writes ${READINESS_FILE} and walks the essential checks with you; they show here as missions.`),
      h("ol", { class: "fr-missions", "aria-label": "First-run missions" }, ...steps("done", "current")),
      h("div", { class: "fr-next" }, h("strong", {}, "Next: "), `run ${ONBOARD} in your agent.`),
      h("div", { class: "actions now-actions" }, onboardBtn(host)),
    ];
  } else {
    const { r } = fr;
    const ready = r.essentials.length - r.unresolved.length;
    const first = r.unresolved[0];
    aside = [pill(`${ready} of ${r.essentials.length} ready`, "awaiting", "⏯"), recheck];
    const rows = r.essentials.map((c) => {
      const [tone, label] = CHECK_STATUS[c.status];
      return missionRow({ title: c.title, detail: c.status === "ready" ? "" : c.next, tone, status: label, state: c.status === "ready" ? "done" : c === first ? "current" : "pending", tip: `${c.title} · ${c.id} (${c.pillar})${c.next ? `\n${c.next}` : ""}` });
    });
    body = [
      h("h2", { class: "now-plan-name" }, `Repository preparation: ${ready} of ${r.essentials.length} essential checks ready.`),
      stepbar(ready, r.essentials.length, true, false),
      h("div", { class: "fr-facts" }, h("div", {}, h("strong", {}, "Detected: "), r.detected.length ? r.detected.join(" · ") : "nothing reported"), h("div", { title: r.fixed.join("\n") }, h("strong", {}, "Fixed: "), !r.fixed.length ? "none" : r.fixed.length <= 2 ? r.fixed.join(" · ") : `${r.fixed.length} safe local fixes applied`)),
      h("ol", { class: "fr-missions", "aria-label": "Essential readiness checks" }, ...rows),
      h("div", { class: "fr-next clamp-2", title: first.next || first.title }, h("strong", {}, "Next: "), `${first.title}${first.next ? ` — ${first.next}` : ""}`),
      h(
        "div",
        { class: "actions now-actions" },
        onboardBtn(host),
        btn("Open readiness.json", () => host.openRepoFile(READINESS_FILE), { class: "status-bar-btn" }),
        ...(r.optionalOpen ? [btn(`${r.optionalOpen} optional check${r.optionalOpen === 1 ? "" : "s"} in the Inbox`, () => host.showTab("inbox"), { class: "link", title: "Non-essential checks reach the Inbox as attention items" })] : []),
      ),
    ];
  }
  const c = h("section", { class: "hero card first-run" }, cardHeader({ title: "First run", icon: "checklist", aside }), ...body);
  c.dataset.firstRun = fr.kind;
  c.dataset.keepScroll = "first-run";
  return c;
}

/** With an active plan the hero stays: the open essentials shrink to one line above it. */
function firstRunStrip(fr: FirstRun, host: CockpitHost): HTMLElement {
  const r = fr.kind === "unresolved" ? fr.r : null;
  const first = r?.unresolved[0];
  const text = r && first ? `Repository preparation: ${r.essentials.length - r.unresolved.length} of ${r.essentials.length} essential checks ready. Next: ${first.title}${first.next ? ` — ${first.next}` : ""}` : `No readiness report yet: ${ONBOARD} prepares the repository.`;
  const s = h("section", { class: "first-run-strip", title: text }, pill("First run", "awaiting", "⏯"), h("span", { class: "grow ellipsis" }, text), onboardBtn(host, "status-bar-btn"));
  s.dataset.firstRun = fr.kind;
  return s;
}

// ---- Mission -------------------------------------------------------------------------
/**
 * Mission home, one fold like the dashboard overview (dashboard.html, min-width 1024px):
 * open gates pinned on top, then a 2x2 grid in pilot order: Current mission (the active
 * run, the current and next to-do), Needs you over Agent runs, Flight Log Now, Queue. At
 * >= 1024px the page does not scroll; each panel scrolls inside. Chats, Activity and the
 * health checks live in the Activity view; the engine form is the run dialog.
 */
export class MissionView extends View {
  constructor(host: CockpitHost, private controls: RunControls) {
    super(host, "cv-mission");
    launches.on(() => this.invalidate());
    // The engine shows in the hero meta row; the run dialog changes it.
    controls.backend.addEventListener("change", () => this.invalidate());
    readiness.on(() => this.invalidate());
    // /agent-kit-onboard rewrites readiness.json; the server's next snapshot is the cue.
    snapshot.on((why) => why === "data" && void readiness.load(3000));
  }

  protected render(): Node[] {
    // Open gates are pinned above everything else: they block a run until answered.
    const out: Node[] = [...this.gateStrip()];
    // First run (no kit, no readiness report, or open essential checks): the readiness
    // missions take the hero's place; without the kit they are the whole view. An active
    // plan keeps its hero and the missions shrink to a strip above the fold.
    const fr = firstRunState();
    if (fr?.kind === "no-kit") {
      out.push(h("div", { class: "first-run-screen" }, firstRunCard(fr, this.host)));
      return out;
    }
    const keepHero = !!fr && !!(snapshot.activePlanFile || launches.pending(this.host.workspaceRoot()));
    if (fr && keepHero) out.push(firstRunStrip(fr, this.host));
    const lead = fr && !keepHero ? firstRunCard(fr, this.host) : this.hero();
    if (!snapshot.data) {
      out.push(h("div", { class: "mission-fold mission-fold-wait" }, lead, ...(this.noData() ?? [])));
      return out;
    }
    // First run without a plan: the missions take the whole left column; a fresh folder
    // has no queue, so the Queue card waits until there is a plan.
    if (fr && !keepHero) out.push(h("div", { class: "mission-fold mission-fold-first-run" }, lead, h("div", { class: "mission-stack" }, this.needsYou(), this.runsCard()), this.flightCard()));
    else out.push(h("div", { class: "mission-fold" }, lead, h("div", { class: "mission-stack" }, this.needsYou(), this.runsCard()), this.flightCard(), this.queueCard()));
    return out;
  }

  private hero(): HTMLElement {
    const now = snapshot.now;
    const plan = snapshot.activePlanFile;
    const sys = snapshot.system;
    // A run Colony launched on another plan than HANDOFF's: show it as the active run
    // until HANDOFF (and so the snapshot) switches to it.
    const pend = snapshot.data ? launches.pending(this.host.workspaceRoot()) : null;
    const liveQ = liveQueueRun(this.host.workspaceRoot());
    const pp = pend ? snapshot.plans().find((p) => p.file === pend.plan) : undefined;
    const pr = pend ? (pp?.progress ?? {}) : obj(now.progress);
    const total = Number(pr.total) || 0;
    const done = Number(pr.completed) || 0;
    const planDone = total > 0 && done >= total;
    const run = iconBtn("play", "Run plan", () => void this.host.runPlan(), {
      class: plan && !planDone ? "primary" : "status-bar-btn",
      "data-act": "run-plan",
      title: plan ? "Run the HANDOFF plan (agent-kit run-plan --events ndjson): pick the engine, then the run opens as a tab with its transcript and gates" : "HANDOFF names no active plan: agent-kit run-plan would stop with “no active plan”",
    });
    run.disabled = !plan;
    const actions = h(
      "div",
      { class: "actions now-actions" },
      run,
      iconBtn("terminals", "Open interactive", () => void this.host.interactive(), { class: "status-bar-btn", "data-act": "interactive", title: "The engine's own CLI (claude or codex) in a terminal tab, on your login" }),
      ...(pend
        ? [btn("Open plan", () => this.host.openRepoFile(pp?.path || `.cursor/plans/${pend.plan}`), { class: "status-bar-btn" })]
        : plan
          ? [btn("Open plan", () => this.host.openRepoFile(str(now.planPath) || `.cursor/plans/${plan}`), { class: "status-bar-btn" })]
          : []),
      ...(snapshot.data && str(now.sourcePath) ? [btn("Open HANDOFF", () => this.host.openRepoFile(str(now.sourcePath)), { class: "status-bar-btn" })] : []),
    );
    const title = pend ? pp?.id || planName(pend.plan) : plan ? str(now.planId) || plan : snapshot.data ? "No active plan" : "Mission";
    const todo = (t: J | null | undefined): Todo => (t && obj(t).id ? { id: str(t.id), content: str(t.content) } : null);
    const lc = pend ? (pp?.lifecycle ?? "") : str(now.lifecycle);
    const status = pend ? (pend.state === "gate" ? "awaiting_user" : pend.state === "ended" ? "idle" : "executing") : str(now.status, plan ? "idle" : "");
    const [stLabel, stTone, stMark] = statusMeta(status);
    let pending: HTMLElement[] = [];
    if (pend) {
      const note = h(
        "div",
        { class: "launch-pending click", title: "Open its tab" },
        pill("Launched from Colony", "running", "▶"),
        stateChip(pend),
        h("span", { class: "grow" }, `${KIND_LABEL[pend.kind]} · ${pend.backend} · started ${clock(pend.startedAt)} (${elapsed(pend.startedAt)}) · waiting for HANDOFF to switch to this plan. HANDOFF still names ${plan ? planName(plan) : "no plan"}; Run plan runs that one.`),
      );
      note.dataset.plan = pend.plan;
      note.dataset.launch = pend.tabId;
      note.addEventListener("click", () => (pend.runId !== undefined ? this.host.focusRun(pend.runId) : this.host.showTab(pend.tabId)));
      pending = [note];
    }
    const cur = pend ? (pp?.currentTodo ?? null) : todo(now.currentTodo);
    const prev = pend ? ([...(pp?.todos ?? [])].reverse().find((t) => t.status === "completed") ?? null) : todo(now.previousTodo);
    const next = pend ? (pp?.nextTodo ?? null) : todo(now.nextTodo);
    const mode = pend ? `${KIND_LABEL[pend.kind]} · ${pend.backend}` : str(now.mode);
    const engine = this.controls.backend.value;
    const meta = metaRow([
      { icon: "folder", text: str(sys.name), title: `Folder: ${str(sys.name)}` },
      { icon: "git", text: str(snapshot.git.branch), mono: true, title: `Branch: ${str(snapshot.git.branch)}` },
      { icon: "mode", text: mode, title: `Mode: ${mode}`, live: status === "executing" },
      engine ? { icon: "engine", text: engine, mono: true, title: `Engine: ${engine} (Run plan and Open interactive). Click to change it in the run dialog.`, onClick: () => void this.host.runPlan() } : null,
      pend ? { icon: "elapsed", text: `${clock(pend.startedAt)} · ${elapsed(pend.startedAt)}`, mono: true, title: `Started ${pend.startedAt}` } : null,
      !pend && str(now.modifiedAt) ? { icon: "updated", text: ago(now.modifiedAt), mono: true, title: `Updated ${str(now.modifiedAt)}` } : null,
      !pend ? { icon: "elapsed", text: timing(now), mono: true, title: "Elapsed on this plan" } : null,
    ]);
    const gaps = !pend ? str(now.gaps) : "";
    const hero = h(
      "section",
      { class: "hero card" },
      cardHeader({ title: "Current mission", aside: [...(status ? [pill(stLabel, stTone, stMark)] : []), ...(lc && lc !== status ? [lifecycleChip(lc)] : [])] }),
      h("h2", { class: "now-plan-name" }, title),
      h("div", { class: "hero-file mono" }, pend ? pend.plan : plan || "HANDOFF names no plan: agent-kit run-plan will stop with “no active plan”."),
      ...pending,
      ...(liveQ ? [liveQueueNote(liveQ, this.host)] : []),
      ...(total ? [stepbar(done, total, !!cur && !planDone, true, "to-dos")] : []),
      ...(plan || pend ? [stepper(missionSteps(prev, cur, next, { status, planDone, nextUpPlan: pend ? "" : str(now.nextUpPlan), done, total }))] : []),
      ...(gaps ? [h("div", { class: "gaps clamp-3", title: plainMd(gaps) }, h("span", { class: "ag-warn" }, "Gaps "), ...inlineMd(gaps))] : []),
      meta,
      actions,
    );
    hero.dataset.keepScroll = "hero";
    return hero;
  }

  /** Every open gate (driver runs and terminal tabs), full prompt and answer controls. */
  private gateStrip(): HTMLElement[] {
    const gates = pendingGates();
    if (!gates.length) return [];
    const s = h(
      "section",
      { class: "gate-strip", "aria-label": "Gates waiting for Ground Control" },
      h("div", { class: "panel-row" }, pill(`${gates.length} gate${gates.length === 1 ? "" : "s"} waiting for Ground Control`, "awaiting", "⏯"), h("span", { class: "grow" }), btn("Open Inbox", () => this.host.showTab("inbox"), { class: "link" })),
      ...gates.map((g) => gateCard(g, this.host, "compact mission-gate")),
    );
    s.dataset.keepScroll = "gates";
    return [s];
  }

  private needsYou(): HTMLElement {
    const gates = pendingGates();
    const att = snapshot.attention;
    const tickets = Array.isArray(snapshot.gateExit.tickets) ? snapshot.gateExit.tickets : [];
    const items: Node[] = [];
    if (gates.length) items.push(h("div", { class: "row" }, chip(`${gates.length}`, "chip-gate"), h("span", { class: "grow" }, `gate${gates.length === 1 ? "" : "s"} pinned at the top of Mission`)));
    for (const a of att.slice(0, 4)) {
      const row = h("div", { class: "row click" }, triageChip(a), h("span", { class: "grow ellipsis", title: str(a.findingsSummary) || str(a.label) }, str(a.label)));
      row.addEventListener("click", () => this.host.showTab("inbox"));
      items.push(row);
    }
    if (tickets.length) {
      const row = h("div", { class: "row click", title: "Triage them in the Inbox (Gate exits)" }, chip(`${tickets.length}`, "chip-gate"), h("span", { class: "grow" }, `gate-exit ticket${tickets.length === 1 ? "" : "s"} pending`));
      row.addEventListener("click", () => this.host.showTab("inbox"));
      items.push(row);
    }
    const n = gates.length + att.length + tickets.length;
    const hidden = att.length - Math.min(att.length, 4);
    const c = card(
      { title: "Needs you", aside: n ? [gates.length ? pill(`${n} waiting`, "awaiting", "⏯") : chip(String(n))] : [] },
      ...(items.length ? items : [empty("Nothing waits for you.")]),
      ...(hidden ? [btn(`+${hidden} more in the Inbox`, () => this.host.showTab("inbox"), { class: "link", "data-act": "needs-more" })] : []),
    );
    c.classList.add("needs-you");
    c.dataset.keepScroll = "needs";
    return c;
  }

  private runsCard(): HTMLElement {
    const { mine, kit, kitSeen } = mergeRuns(launches.list(), kitRuns());
    const rows: Node[] = mine.slice(0, 8).map((l) => launchRow(l, kitSeen.get(l.tabId), this.host));
    if (mine.length > 8) rows.push(h("div", { class: "dim small" }, `${mine.length - 8} older launch(es) in this window`));
    for (const k of kit.slice(0, 4)) {
      const r = h("div", { class: "row kit-run", title: k.plan ? `${planName(k.plan)} · ${k.label}` : k.label }, chip("kit", ""), h("span", { class: "grow ellipsis" }, k.plan ? h("strong", {}, planName(k.plan)) : "", k.plan ? " · " : "", k.label), ...(k.at ? [h("span", { class: "run-meta mono" }, ago(k.at))] : []));
      r.dataset.kit = k.key;
      rows.push(r);
    }
    const live = mine.filter((l) => l.state !== "ended").length;
    // The web Mission Control's name for this panel: Crew Monitor.
    const c = card({ title: "Crew Monitor", aside: live ? [pill(`${live} live`, "running", "▶")] : [] }, ...(rows.length ? rows : [empty("No runs in this window. Run plan, Open interactive and the plan actions start one; each opens as its own tab.")]));
    c.classList.add("runs-card");
    c.dataset.keepScroll = "runs";
    return c;
  }

  private queueCard(): HTMLElement {
    const { q, queue, cursor, hold, live } = queueNow(this.host.workspaceRoot());
    const mark = (i: number) => (i !== cursor ? String(i + 1) : hold ? "⏸" : "▶");
    const rows = queue.map((p, i) => h("div", { class: `row q-mini ${i < cursor ? (finished(q, p) ? "past" : "past-open") : i === cursor ? (hold ? "held" : "current") : ""}`, title: q.outcomes?.[p] ? `${p} · ${String(q.outcomes[p])}` : p }, h("span", { class: "q-mark" }, mark(i)), h("span", { class: "grow ellipsis" }, planName(p)), ...(q.outcomes?.[p] ? [chip(String(q.outcomes[p]))] : [])));
    const held = hold ? [h("div", { class: "queue-held" }, pill("Held", "awaiting", "⏸"), h("span", { class: "grow" }, holdText(hold, queue[cursor])))] : [];
    const acts = h(
      "div",
      { class: "actions" },
      iconBtn("queue", "Run queue", () => void this.host.runQueue(), { class: "status-bar-btn", "data-act": "run-queue", title: RUN_QUEUE_TIP }),
      btn("Open Queue", () => this.host.showTab("queue"), { class: "link" }),
    );
    const pos = queue.length && cursor >= 0 ? [h("span", { class: "card-count mono", title: "Queue cursor: the plan the queue runs now" }, `plan ${Math.min(cursor + 1, queue.length)} of ${queue.length}`)] : [];
    const liveRow = live ? [h("div", { class: "row dim small queue-live-row" }, chip("live", "chip-done"), h("span", { class: "grow ellipsis" }, `queue run #${live.id} · ${live.backend}${live.queue?.status ? ` · ${live.queue.status}` : ""}`))] : [];
    const c = card({ title: "Queue", aside: pos }, ...held, ...liveRow, ...(rows.length ? rows : [empty("No run-plan-all queue in HANDOFF.")]), ...(queue.length ? [acts] : []));
    c.classList.add("queue-card");
    c.dataset.keepScroll = "queue";
    return c;
  }

  private flightCard(): HTMLElement {
    const f = snapshot.flightLog;
    const cur = str(f.current);
    const warnings = Array.isArray(f.warnings) ? f.warnings.length : 0;
    const more = btn(warnings ? `Open Flight Log (${warnings} warning${warnings === 1 ? "" : "s"})` : "Open Flight Log", () => this.host.showTab("flight"), { class: "link" });
    const c = card(
      "Flight Log",
      cur ? h("div", { class: `flight-log-card flight-log-card-current flight-log-kind-${flKind(str(f.currentKind))}`, title: plainMd(cur) }, h("span", { class: "flight-log-card-label" }, `Now · ${str(f.currentKind, "residual")}`), h("div", { class: "flight-log-card-text" }, ...inlineMd(cur))) : empty("All clear: no open residuals."),
      more,
    );
    c.classList.add("flight-card");
    c.dataset.keepScroll = "flight";
    return c;
  }
}

// ---- Activity ------------------------------------------------------------------------
/** Saved chats, the kit's recent activity and the health checks: out of the Mission fold. */
export class ActivityView extends View {
  /** The Chats card lists every chat of the read, not only the newest few. */
  private allChats = false;

  constructor(host: CockpitHost) {
    super(host, "cv-activity");
    chats.on(() => {
      // A new folder (or a failed read) starts folded again.
      if (!chats.list) this.allChats = false;
      this.invalidate();
    });
  }

  protected render(): Node[] {
    // Saved chats do not need the kit's data.
    if (!snapshot.data) return [h("div", { class: "grid" }, this.chatsCard()), ...(this.noData() ?? [])];
    return [h("div", { class: "grid" }, this.chatsCard(), this.activityCard(), this.healthCard())];
  }

  private chatsCard(): HTMLElement {
    const l = chats.list;
    const all = l?.sessions ?? [];
    const rows: Node[] = (this.allChats ? all : all.slice(0, CHATS_SHOWN)).map((c) => chatRow(c, this.host));
    if (!this.allChats && all.length > CHATS_SHOWN)
      rows.push(
        btn(`All ${all.length} chats`, () => {
          this.allChats = true;
          this.invalidate();
        }, { class: "link" }),
      );
    const older = l ? l.total - all.length : 0;
    if (older > 0) rows.push(h("div", { class: "dim small" }, `${older} older chat${older === 1 ? "" : "s"} not listed (only the newest ${all.length} are read)`));
    const refresh = iconBtn("refresh", chats.loading ? "Reading…" : "Refresh", () => void chats.refresh(), { class: "link", "data-act": "chats-refresh", title: "Read the saved sessions of this folder again" });
    const none = empty(
      l || !chats.loading
        ? "No saved chats for this folder. Claude Code saves each session per start folder (~/.claude/projects/<folder>/); this list shows the ones started in this workspace folder. Open interactive with the claude engine starts one."
        : "Reading the saved chats…",
    );
    const body = chats.error ? [empty(`Saved chats unavailable: ${chats.error}`)] : rows.length ? rows : [none];
    return card({ title: "Chats", aside: [...(l?.total && !chats.error ? [h("span", { class: "card-count mono", title: l.dir ?? "" }, `${l.total} saved`)] : []), refresh] }, ...body);
  }

  private activityCard(): HTMLElement {
    const list = snapshot.activity.slice(0, 20);
    return card("Activity", ...(list.length ? list.map((a) => h("div", { class: "row" }, chip(str(a.kind)), h("span", { class: "grow ellipsis", title: str(a.label) }, str(a.label)), h("span", { class: "run-meta mono" }, ago(a.at)))) : [empty("No recent activity.")]));
  }

  private healthCard(): HTMLElement {
    const checks = Array.isArray(snapshot.health.checks) ? snapshot.health.checks : [];
    return card("Health", ...(checks.length ? [h("div", { class: "chips" }, ...checks.map((c: J) => checkChip(str(c.label || c.id), c.ok ? "ok" : "fail")))] : [empty("No health checks in the snapshot.")]));
  }
}

// ---- Plans ---------------------------------------------------------------------------
const PLAN_FILTERS: [string, string, (p: McPlan) => boolean][] = [
  ["open", "Open", (p) => p.lifecycle !== "completed"],
  ["backlog", "Backlog", (p) => p.lifecycle === "backlog"],
  ["parked", "Parked", (p) => p.lifecycle === "parked"],
  ["incomplete", "Incomplete", (p) => p.lifecycle === "incomplete"],
  ["completed", "Completed", (p) => p.lifecycle === "completed"],
  ["all", "All", () => true],
];
/** Frontmatter strings can reach the snapshot with their YAML escapes (\\"): show plain quotes. */
const unescapeQuotes = (t: string) => t.replace(/\\"/g, '"');
const TODO_ICON: Record<string, string> = { completed: "✓", in_progress: "▶", pending: "○", cancelled: "✕" };

/** run-plan-all queue role (dashboard .queue-role-pill: colored text, no fill). */
const ROLE: Record<string, [string, string]> = { next_up: ["Next up", "next-up"], queued: ["Queued", "queued"], executing: ["Executing", "executing"], done: ["Done", "done"] };
function rolePill(role: string): HTMLElement {
  const [label, cls] = ROLE[role] ?? [role.replace(/_/g, " "), "queued"];
  return h("span", { class: `role-pill role-${cls}` }, label);
}

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
    const acts: HTMLElement[] = [btn("Open", () => this.host.openRepoFile(p.path || `.cursor/plans/${p.file}`), { class: "status-bar-btn", title: p.path })];
    // The HANDOFF plan runs from Mission (Run plan); other open plans get activated here.
    if (!active && p.lifecycle !== "completed") {
      acts.unshift(
        btn("Run…", () => void this.host.interactive(`/run-plan ${p.file}`, `agent-kit run-plan only runs the HANDOFF plan (${snapshot.activePlanFile || "none"}). This opens your agent interactively with /run-plan ${p.file}, which activates it.`), {
          class: "status-bar-btn",
          "data-act": "run-other",
          title: "Opens your agent interactively with /run-plan <plan> (agent-kit run-plan has no plan argument)",
        }),
      );
    }
    if (p.lifecycle === "backlog") acts.push(btn("Edit…", () => void this.host.interactive(`/backlog-edit ${p.file}`), { class: "status-bar-btn", title: "/backlog-edit in your agent, interactively" }));
    if (["parked", "incomplete", "executing", "awaiting_user"].includes(p.lifecycle)) acts.push(btn("Resume…", () => void this.host.interactive(`/continue-plan ${p.file}`), { class: "status-bar-btn", title: "/continue-plan in your agent, interactively" }));
    const inProgress = p.todos.filter((t) => t.status === "in_progress").length;
    const pct = p.progress.total ? Math.round((100 * p.progress.completed) / p.progress.total) : 0;
    const head = h(
      "div",
      { class: `plan-row ${active ? "active" : ""}` },
      h("span", { class: "caret" }, open ? "▾" : "▸"),
      h(
        "div",
        { class: "plan-main grow" },
        h(
          "div",
          { class: "plan-title-line" },
          h("strong", { class: "plan-title ellipsis", title: `${p.id}\n${p.file}` }, p.id),
          lifecycleChip(p.lifecycle),
          ...(active ? [h("span", { class: "role-pill role-active" }, "● HANDOFF")] : []),
          ...(p.queueRole !== "none" && !(p.queueRole === "executing" && p.lifecycle === "executing") ? [rolePill(p.queueRole)] : []),
          h("span", { class: "plan-count" }, p.progress.label || `${p.progress.completed} of ${p.progress.total} complete`),
        ),
        ...(p.progress.total ? [stepbar(p.progress.completed, p.progress.total, inProgress > 0, false)] : []),
        ...(p.overview ? [h("div", { class: "plan-overview clamp-2", title: unescapeQuotes(p.overview) }, unescapeQuotes(p.overview))] : []),
        metaRow([
          { icon: "plans", text: p.file, mono: true, title: p.path },
          { icon: "checklist", text: `${pct}%`, mono: true },
          inProgress ? { icon: "elapsed", text: `${inProgress} in progress` } : null,
          p.currentTodo || p.nextTodo ? { icon: "mode", text: `Next: ${(p.currentTodo ?? p.nextTodo)!.id}`, mono: true, title: (p.currentTodo ?? p.nextTodo)!.content } : null,
        ]),
      ),
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
      ? p.todos.map((t) => h("div", { class: `todo st-${t.status}` }, h("span", { class: "todo-icon" }, TODO_ICON[t.status] ?? "·"), h("span", { class: "now-todo-id" }, t.id), h("span", { class: "clamp-2", title: unescapeQuotes(t.content) }, unescapeQuotes(t.content))))
      : [empty("No to-do list in the snapshot.")];
    return h("div", { class: "plan-wrap open" }, head, h("div", { class: "todos" }, ...todos));
  }
}

// ---- Queue ---------------------------------------------------------------------------
export class QueueView extends View {
  constructor(host: CockpitHost) {
    super(host, "cv-queue");
    // A live queue run's queue_state moves the cursor before the next snapshot does.
    runs.on((c) => c.kind === "state" && c.run.command === "run-plan-all" && this.invalidate());
  }

  protected render(): Node[] {
    const nd = this.noData();
    if (nd) return nd;
    const { q, queue, cursor, hold, live } = queueNow(this.host.workspaceRoot());
    const plans = new Map(snapshot.plans().map((p) => [p.file, p]));
    // Done = finished plans only (a passed, deferred plan is not done); the label says plans.
    const done = queue.filter((f) => finished(q, f)).length;
    const runnable = queueRunnable(q, queue, cursor, !!hold);
    const running = live ? live.queue?.status?.toLowerCase() !== "stopped" : /\brunning\b/i.test(str(q.status));
    const [stLabel, stTone, stMark]: [string, Tone, string] = hold ? ["Held", "awaiting", "\u23F8"] : running ? ["Running", "executing", "\u25B6"] : queue.length ? ["Idle", "idle", "\u25CB"] : ["No queue", "idle", "\u25CB"];
    const head = h(
      "section",
      { class: "hero card" },
      cardHeader({ title: "Run queue", icon: "queue", aside: [pill(stLabel, stTone, stMark)] }),
      h("h2", { class: "now-plan-name" }, queue.length ? `${queue.length} plans · cursor ${cursor >= 0 ? cursor + 1 : "-"}${hold ? " · held" : ""}` : "No queue"),
      ...(queue.length ? [stepbar(done, queue.length, cursor >= 0 && cursor < queue.length && !hold, true, "plans done")] : []),
      metaRow([
        { icon: "mode", text: "run-plan-all", mono: true },
        q.nextUpPlan ? { icon: "plans", text: `Next up: ${planName(String(q.nextUpPlan))}`, mono: true } : null,
        // No cut at a fixed length: the meta value ellipsizes by width, the title has it all.
        str(q.status) ? { icon: "updated", text: str(q.status).split("\n")[0], title: str(q.status) } : null,
      ]),
      ...(hold ? [h("div", { class: "queue-held" }, pill("Held", "awaiting", "\u23F8"), h("span", { class: "grow" }, holdText(hold, queue[cursor] ?? ""), " The queue resumes at its cursor once that run hands HANDOFF back (Queue status in HANDOFF)."))] : []),
      ...(live ? [liveQueueNote(live, this.host)] : []),
      h(
        "div",
        { class: "actions now-actions" },
        iconBtn("queue", "Run queue", () => void this.host.runQueue(), { class: runnable ? "primary" : "status-bar-btn", "data-act": "run-queue", title: runnable ? RUN_QUEUE_TIP : `${RUN_QUEUE_TIP}. Nothing left to run from the cursor: every plan has an outcome or the queue is held.` }),
        btn("Open HANDOFF", () => this.host.openRepoFile(".cursor/HANDOFF.md"), { class: "status-bar-btn" }),
      ),
      h("p", { class: "hint" }, "Run queue starts agent-kit run-plan-all. On an engine with driver protocol 1.2.0 or newer it runs as an agent tab: its gates appear in the Inbox and this view follows its queue_state events. An older engine opens it in a terminal tab, where its numbered gates are answered."),
    );
    const rows = queue.map((file, i) => {
      const p = plans.get(file);
      const state = i < cursor ? (finished(q, file) ? "past" : "past-open") : i === cursor ? (hold ? "held" : "current") : "future";
      const outcome = q.outcomes?.[file] ? String(q.outcomes[file]) : "";
      const marker = state === "past" ? "\u2713" : state === "current" ? "\u25B6" : state === "held" ? "\u23F8" : String(i + 1);
      const r = h(
        "div",
        { class: `q-row ${state}` },
        h("span", { class: "q-idx now-step-marker", "aria-hidden": "true" }, marker),
        h(
          "div",
          { class: "grow q-main" },
          h("div", { class: "plan-title-line" }, h("strong", { class: "ellipsis", title: `${p?.id || planName(file)}\n${file}` }, p?.id || planName(file)), ...(p ? [lifecycleChip(p.lifecycle)] : []), ...(outcome && outcome !== p?.lifecycle ? [chip(outcome, outcome === "completed" ? "chip-done" : "chip-parked")] : []), ...(p ? [h("span", { class: "plan-count" }, p.progress.label || `${p.progress.completed} of ${p.progress.total} complete`)] : [])),
          ...(p && p.progress.total ? [stepbar(p.progress.completed, p.progress.total, p.todos.some((t) => t.status === "in_progress"), false)] : []),
          p ? metaRow([{ icon: "plans", text: file, mono: true }, p.currentTodo ? { icon: "mode", text: `Next: ${p.currentTodo.id}`, mono: true, title: p.currentTodo.content } : null]) : h("div", { class: "dim small" }, "plan file not in the snapshot"),
        ),
        btn("Open", () => this.host.openRepoFile(p?.path || `.cursor/plans/${file}`), { class: "status-bar-btn" }),
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
        { class: `fl-card flight-log-card flight-log-kind-${flKind(kind)} ${label === "Now" ? "now flight-log-card-current" : label === "Earlier" ? "flight-log-card-past" : "flight-log-card-warning"}` },
        h("span", { class: "flight-log-card-label" }, [label, kind.toLowerCase() === label.toLowerCase() ? "" : kind].filter(Boolean).join(" · ")),
        h("div", { class: "flight-log-card-text fl-text" }, text),
        metaRow([at ? { icon: "updated", text: `${ago(at)}`, mono: true, title: at } : null, source ? { icon: "plans", text: source, mono: true } : null], "flight-log-card-meta"),
        h(
          "div",
          { class: "flight-log-card-actions" },
          btn("Open", () => this.host.openRepoFile(source || ".cursor/HANDOFF.md"), { class: "status-bar-btn" }),
          ...(command ? [btn("Copy fix prompt", () => this.host.copy(command, "fix prompt"), { class: "status-bar-btn", title: "Copied for your agent's chat input" })] : []),
        ),
      );
    if (str(f.current)) out.push(entry("Now", str(f.current), str(f.currentKind), str(f.sourcePath), str(obj(f.currentAction).command) || null));
    for (const w of Array.isArray(f.warnings) ? f.warnings : []) out.push(entry(str(w.title, "Warning"), str(w.text), str(w.kind, "warning"), str(w.sourcePath), str(obj(w.action).command) || null));
    // Gate-exit tickets are triaged in the Inbox (Gate exits); here only a pointer to it.
    const tickets = Array.isArray(f.tickets) && f.tickets.length ? f.tickets : Array.isArray(snapshot.gateExit.tickets) ? snapshot.gateExit.tickets : [];
    if (tickets.length) out.push(h("div", { class: "row" }, chip(String(tickets.length), "chip-gate"), h("span", { class: "grow" }, `gate-exit ticket${tickets.length === 1 ? "" : "s"} pending`), btn("Open in the Inbox", () => this.host.showTab("inbox"), { class: "link" })));
    const triages = Array.isArray(f.quietOpenTriages) ? f.quietOpenTriages : [];
    if (triages.length) out.push(card("Open triages", ...triages.map((t: J) => h("div", { class: "row" }, triageChip(t), h("span", { class: "grow ellipsis", title: str(t.findingsSummary) }, str(t.label)), btn("Inbox", () => this.host.showTab("inbox"), { class: "link" })))));
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
            const row = h("div", { class: "row click" }, chip(`tick ${rv.tick}`), h("span", { class: "grow ellipsis mono small" }, rv.resultLine || "no LOOP_TICK_RESULT"), h("span", { class: "run-meta mono" }, `${runLabel(r)} · ${rv.files.length} files`));
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
                h("div", { class: "row" }, chip(str(l.kind)), h("strong", { class: "ellipsis grow mono small" }, str(l.id)), str(l.sentinel) ? chip(str(l.sentinel).replace(/^LOOP_TICK_RESULT:\s*/, ""), "chip-done") : "", ...(Array.isArray(l.gates) && l.gates.length ? [chip(`gates ${l.gates.join(", ")}`, "chip-gate")] : []), h("span", { class: "run-meta mono" }, ago(l.updatedAt)), btn("Open", () => this.host.openRepoFile(str(l.path)), { class: "link" })),
                str(l.lastText) ? h("div", { class: "dim small clamp-3", title: str(l.lastText) }, str(l.lastText)) : "",
                res.isError ? h("div", { class: "ag-err small" }, `result: ${str(res.subtype, "error")}`) : "",
              );
              return row;
            })
          : [empty("No headless tick logs yet.")]),
      ),
    );
    return out.length ? out : [empty("Flight Log is empty.")];
  }
}
