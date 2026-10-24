// COLONY_SMOKE steps for the live launches (./launches.ts) and the context sources strip
// (./contextstrip.ts). Called by the main smoke after its driver run and interactive tabs:
// the Mission view's Agent runs card lists the driver run and a `/run-plan <plan>`
// interactive tab (fixture `fake-claude.sh`, which prints a HITL_GATE line), the hero shows
// that plan as launched from Colony until HANDOFF switches to it over SSE, the queue card
// shows a queue held by an out-of-queue run, and both kinds of agent tab list their
// context sources. HANDOFF is restored afterwards. No synthetic input: DOM clicks only.
import { api, errText } from "./api";
import type { CockpitHost } from "./cockpit";
import { type KitRun, launches, mergeRuns } from "./launches";
import { snapshot } from "./snapshot";
import type { TermView } from "./termview";

export interface SmokeLiveCtx {
  root: string;
  fixture: boolean;
  planFile: string;
  runId: number;
  log(step: string, ok: boolean, detail?: unknown): Promise<unknown>;
  wait(ms: number): Promise<unknown>;
  until(cond: () => boolean, ms: number): Promise<boolean>;
  view(id: string): HTMLElement;
  shot(name: string): Promise<void>;
  host: CockpitHost;
  activeTab(): string;
  closeTab(id: string): Promise<void>;
  openInEditor(path: string): Promise<unknown>;
  /** The run dialog's engine picker (focused while HANDOFF switches, as after a pick). */
  picker: HTMLElement;
}

/** Claude Code's project folder name for a folder (same rule as src-tauri/src/context.rs). */
const slug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, "-");

async function stripRows(c: SmokeLiveCtx, tab: HTMLElement) {
  await c.until(() => !!tab.querySelector(".ctx-strip .ctx-row"), 5000);
  const rows = [...tab.querySelectorAll<HTMLElement>(".ctx-strip .ctx-row")];
  return rows.map((r) => ({ path: r.dataset.path ?? "", kind: r.dataset.kind ?? "", exists: r.dataset.exists === "true", el: r }));
}

export async function smokeLive(c: SmokeLiveCtx) {
  const { root, planFile } = c;
  const mission = () => c.view("mission");
  c.host.showTab("mission");
  await c.wait(300);
  // 1. The driver run of this smoke is listed (ended), and its tab lists its context.
  const runRow = mission().querySelector<HTMLElement>(`.run-row[data-launch="run:${c.runId}"]`);
  await c.log("agent-runs-driver", !!runRow && runRow.dataset.state === "ended", { state: runRow?.dataset.state, plan: runRow?.dataset.plan, text: runRow?.textContent?.slice(0, 160) });
  // The run's strip follows its engine (the smoke ran it on codex): AGENTS.md, no Claude memory.
  const runTab = c.view(`run:${c.runId}`);
  const runRows = await stripRows(c, runTab);
  const runEngine = runTab.querySelector<HTMLElement>(".ctx-strip")?.dataset.engine ?? "";
  const claudeLike = !["codex", "cursor-agent", "cursor-acp"].includes(runEngine);
  await c.log(
    "context-strip-run",
    runRows.some((r) => r.path === `${root}/AGENTS.md`) &&
      runRows.some((r) => r.path === `${root}/.cursor/HANDOFF.md`) &&
      (claudeLike ? runRows.some((r) => r.path.endsWith(`/.claude/projects/${slug(root)}/memory/MEMORY.md`)) : runRows.every((r) => !r.path.includes("/.claude/"))),
    { engine: runEngine, rows: runRows.map((r) => `${r.exists ? "✓" : "-"} ${r.kind} ${r.path}`) },
  );
  if (!c.fixture) return;

  // 2. An interactive /run-plan <plan> tab (a plan action) is listed while it runs.
  const t = (await c.host.interactive(`/run-plan ${planFile}`, "smoke")) as { id: string; view: TermView } | undefined;
  if (!t) return c.log("agent-runs-interactive", false, "the interactive tab did not open");
  await c.until(() => t.view.output.includes("HITL_GATE"), 8000);
  c.host.showTab("mission");
  await c.until(() => mission().querySelector<HTMLElement>(`.run-row[data-launch="${t.id}"]`)?.dataset.state === "gate", 4000);
  const row = mission().querySelector<HTMLElement>(`.run-row[data-launch="${t.id}"]`);
  const listed = { state: row?.dataset.state, plan: row?.dataset.plan, text: row?.textContent?.slice(0, 160), launches: launches.list().map((l) => `${l.kind}:${l.state}:${l.plan}`) };
  const pending = mission().querySelector<HTMLElement>(".launch-pending");
  const heroTitle = mission().querySelector(".hero h2")?.textContent ?? "";
  const handoffPlan = snapshot.activePlanFile;
  const planId = snapshot.plans().find((p) => p.file === planFile)?.id ?? planFile;
  await c.shot("launched");
  row?.click();
  await c.wait(200);
  await c.log("agent-runs-interactive", row?.dataset.state === "gate" && row.dataset.plan === planFile && c.activeTab() === t.id, { ...listed, focused: c.activeTab() });
  await c.log("mission-launched", handoffPlan !== planFile && pending?.dataset.plan === planFile && heroTitle === planId, { handoffPlan, heroTitle, pending: pending?.textContent?.slice(0, 200) });

  // Kit rows merge into Colony's launches: one naming the live launch's plan is the same
  // run, another plan and a queue runner process are listed as kit rows.
  const kit: KitRun[] = [
    { key: "activity:same", plan: planFile, label: "claude · running · sse-check", at: null, source: "activity" },
    { key: "activity:other", plan: "other.plan.md", label: "claude · running · x", at: null, source: "activity" },
    { key: "process:42", plan: "", label: "agent-kit run-plan-all --backend claude", at: null, source: "process" },
  ];
  const merged = mergeRuns(launches.list(), kit);
  await c.log("agent-runs-kit-merge", merged.kitSeen.get(t.id)?.key === "activity:same" && merged.kit.map((k) => k.key).join(",") === "activity:other,process:42", { seen: [...merged.kitSeen].map(([id, k]) => `${id}=${k.key}`), kit: merged.kit.map((k) => k.key) });

  // 3. The interactive tab's context strip; a row opens the file in the editor.
  const tab = c.view(t.id);
  const rows = await stripRows(c, tab);
  const handoffRow = rows.find((r) => r.kind === "handoff");
  const user = rows.find((r) => r.kind === "user");
  const memory = rows.find((r) => r.kind === "memory");
  tab.querySelector<HTMLDetailsElement>(".ctx-strip")!.open = true;
  await c.wait(200);
  await c.shot("context");
  let proof = "";
  if (handoffRow?.exists) {
    handoffRow.el.click();
    for (let i = 0; i < 25 && !proof; i++) {
      await c.wait(200);
      proof = await api.readTextFile(`${root}/.cursor/editor-proof.txt`).catch(() => "");
    }
  }
  // A source outside the folder (~/.claude/CLAUDE.md) is readable once listed (jail exemption).
  const outside = user?.exists ? await api.readTextFile(user.path).then((x) => `read ${x.length} chars`, (e) => `refused: ${errText(e)}`) : "no user CLAUDE.md";
  await c.log(
    "context-strip-interactive",
    tab.querySelector<HTMLElement>(".ctx-strip")?.dataset.engine === "claude" && proof.trim() === `opened ${root}/.cursor/HANDOFF.md` && !!memory?.path.endsWith(`/.claude/projects/${slug(root)}/memory/MEMORY.md`) && rows.some((r) => r.path === `${root}/CLAUDE.md`) && (!user?.exists || outside.startsWith("read")),
    { rows: rows.map((r) => `${r.exists ? "✓" : "-"} ${r.kind} ${r.path}`), proof: proof.trim(), outside, summary: tab.querySelector(".ctx-strip summary")?.textContent },
  );

  // 4. HANDOFF switches to the plan (over SSE, no reload): the hero follows, and a queue
  // whose cursor is on another plan while its status says running shows as held.
  const handoffPath = `${root}/.cursor/HANDOFF.md`;
  const original = await api.readTextFile(handoffPath).catch(() => null);
  if (original === null) {
    await c.log("handoff-switch", false, "no .cursor/HANDOFF.md in the smoke folder");
  } else {
    // The operator's last click was the engine picker (in the run dialog, over Mission):
    // the view must still follow HANDOFF.
    c.host.showTab("mission");
    await c.wait(200);
    void c.host.runPlan();
    await c.wait(100);
    c.picker.focus();
    const pickerFocused = document.activeElement === c.picker;
    const updatesBefore = snapshot.feed.updates;
    await api.writeTextFile(
      handoffPath,
      `# HANDOFF\n\n- **Plan:** \`${planFile}\`\n- **Mode:** run-plan-all\n- **Run queue:** [colony-queue-a.plan.md, colony-queue-b.plan.md]\n- **Queue cursor:** 0 (current: colony-queue-a.plan.md)\n- **Queue status:** running (Colony smoke)\n`,
    );
    const switched = await c.until(() => snapshot.activePlanFile === planFile && snapshot.feed.updates > updatesBefore, 30000);
    await c.wait(400);
    const heroLive = mission().querySelector(".hero h2")?.textContent ?? "";
    const stillFocused = document.activeElement === c.picker;
    const pendingLive = !!mission().querySelector(".launch-pending");
    const heldLive = !!mission().querySelector(".queue-held");
    await c.log("mission-follows-with-focus", switched && pickerFocused && heroLive === planId && !pendingLive && heldLive && stillFocused, { pickerFocused, heroLive, pendingLive, heldLive, stillFocused });
    document.querySelector<HTMLButtonElement>('#run-dialog [data-act="run-cancel"]')?.click();
    c.host.showTab("mission");
    await c.wait(400);
    const hero = mission().querySelector(".hero h2")?.textContent ?? "";
    const held = mission().querySelector(".queue-held")?.textContent ?? "";
    await c.shot("held");
    c.host.showTab("queue");
    await c.wait(300);
    const heldRow = c.view("queue").querySelector<HTMLElement>(".q-row.held");
    await c.log("handoff-switch", switched && !mission().querySelector(".launch-pending") && hero === planId, { switched, activePlan: snapshot.activePlanFile, hero, updates: `${updatesBefore} -> ${snapshot.feed.updates}` });
    await c.log("queue-held", held.includes("out-of-queue") && heldRow?.dataset.plan === "colony-queue-a.plan.md" && !c.view("queue").querySelector(".q-row.current"), { held, heldRow: heldRow?.dataset.plan, status: snapshot.runQueue.status });
    await api.writeTextFile(handoffPath, original);
    const back = await c.until(() => snapshot.activePlanFile !== planFile, 30000);
    c.host.showTab("mission");
    await c.wait(300);
    // HANDOFF moved on: the launch was confirmed once, so it does not wait for HANDOFF again.
    await c.log("handoff-restored", back && !mission().querySelector(".launch-pending"), { activePlan: snapshot.activePlanFile, pending: !!mission().querySelector(".launch-pending") });
  }
  await c.closeTab(t.id);
  await c.wait(200);
  c.host.showTab("mission");
  await c.wait(200);
  await c.log("agent-runs-closed", !mission().querySelector(`.run-row[data-launch="${t.id}"]`), launches.list().map((l) => l.tabId));
}
