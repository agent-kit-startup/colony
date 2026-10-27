// Driver chat, the pure part (kit ADR 2026-10-26_driver-chat-side-agent-programmatic-resolver):
// the deferred gates the kit helper `agent-kit queue gates --json` prints, the resolution
// note check (the same rule the kit applies to `run-plan-all --note`), the chat agent's model
// per role and the re-probe diff that offers a relaunch. No model call and no I/O here:
// Node runs it with its types stripped (scripts/resolver.test.mjs).

export interface DeferredGate { plan: string; gate: string; asks: string[] }
/** `decideQueueEndGatesAsk` as `agent-kit queue gates --json` prints it. */
export interface GatesDecision { ask: boolean; reason: string; labels: string[]; gates: DeferredGate[] }

/** The helper's JSON, or null when it is not that shape (then nothing is shown as a gate). */
export function parseDecision(v: unknown): GatesDecision | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ask !== "boolean" || !Array.isArray(o.gates)) return null;
  const gates: DeferredGate[] = [];
  for (const g of o.gates) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    if (typeof r.plan !== "string" || typeof r.gate !== "string") continue;
    gates.push({ plan: r.plan, gate: r.gate, asks: Array.isArray(r.asks) ? r.asks.filter((a): a is string => typeof a === "string") : [] });
  }
  return { ask: o.ask, reason: typeof o.reason === "string" ? o.reason : "", labels: Array.isArray(o.labels) ? o.labels.map(String) : [], gates };
}

/** Largest note Colony passes on argv (bytes, as agent.rs MAX_NOTE). */
export const MAX_NOTE = 32 * 1024;

/**
 * Why `note` cannot go to `run-plan-all --note`, or null when it can. A note is context for
 * the relaunched session, never an answer: a line that starts with `HITL_GATE:` or
 * `HITL_REPLY:` (after spaces or `>` quotes) is refused, as the kit and agent.rs refuse it.
 */
export function noteProblem(note: string): string | null {
  const n = note.trim();
  if (!n) return "The resolution note is empty";
  if (new TextEncoder().encode(n).length > MAX_NOTE) return `The resolution note is longer than ${MAX_NOTE / 1024} KB`;
  if (n.startsWith("@")) return "A resolution note may not start with @ (the kit would read it as a file path)";
  if (n.includes("\0")) return "The resolution note contains a NUL byte";
  for (const line of n.split(/\r?\n/)) {
    const l = line.replace(/^[\s>]+/, "");
    if (l.startsWith("HITL_GATE:") || l.startsWith("HITL_REPLY:")) return "A resolution note may not contain a HITL_GATE: or HITL_REPLY: line: a note is context, never a gate answer";
  }
  return null;
}

/** Engines whose vendor CLI the chat agent opens (vendor.rs `interactive`). The others have
 *  no interactive vendor CLI of their own here; the chat agent is not offered for them. */
export const CHAT_ENGINES = ["claude", "codex"] as const;

/**
 * Small tier (Ask `driver-chat-model-tier`, operator 2026-10-26): the cheapest model class of
 * the chat's backend. Only Claude Code has a known alias for it; another engine starts on its
 * own default model until a chat model is set (Queue view → Driver chat → Chat model).
 */
const SMALL_TIER: Record<string, string> = { claude: "haiku" };

/** The chat agent's model: the saved chat model, else the small tier, else the vendor default (""). */
export function chatModel(engine: string, saved: string | undefined): { model: string; source: "saved" | "small tier" | "vendor default" } {
  const s = (saved ?? "").trim();
  if (s) return { model: s, source: "saved" };
  const small = SMALL_TIER[engine];
  return small ? { model: small, source: "small tier" } : { model: "", source: "vendor default" };
}

/** A stable key of the deferred gates (plan + gate text), order-free. */
export function gatesKey(d: GatesDecision | null): string {
  if (!d) return "";
  return JSON.stringify(d.gates.map((g) => `${g.plan}\u0000${g.gate}`).sort());
}

/**
 * What changed between two probes of the same folder: plans whose deferred row left the list
 * (an operator session or the orchestrator moved it on), plans whose gate text changed, and
 * plans newly deferred. The first probe (no `prev`) changes nothing: nothing to compare.
 */
export function gatesChange(prev: GatesDecision | null, next: GatesDecision | null): { gone: string[]; changed: string[]; added: string[] } {
  if (!prev || !next) return { gone: [], changed: [], added: [] };
  const before = new Map(prev.gates.map((g) => [g.plan, g.gate]));
  const after = new Map(next.gates.map((g) => [g.plan, g.gate]));
  const gone = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...after.entries()].filter(([p, g]) => before.has(p) && before.get(p) !== g).map(([p]) => p);
  const added = [...after.keys()].filter((p) => !before.has(p));
  return { gone, changed, added };
}

/**
 * Whether the driver chat offers "Relaunch with resolution" after a re-probe of HANDOFF: the
 * setting is on, no queue run is live in the folder, and a deferred gate moved (its row left
 * the list or its gate text changed). A plan that was just deferred is not a reason: nothing
 * was resolved yet. It only offers: the operator confirms every relaunch, and the new run's
 * own gates (queue-confirm included) still wait for the operator.
 */
export function offerRelaunch(enabled: boolean, prev: GatesDecision | null, next: GatesDecision | null, live: boolean): boolean {
  if (!enabled || live) return false;
  const c = gatesChange(prev, next);
  return c.gone.length > 0 || c.changed.length > 0;
}

/**
 * Ask classes a setting may pre-answer on the operator's behalf (ADR point 5): none until a
 * later Accepted amendment names one. `git-prod`, `kit-prod`, `queue-confirm`, `risk` and
 * `ticket` are never pre-answerable.
 */
export const PREANSWER_CLASSES: readonly string[] = [];
export const NEVER_PREANSWER = ["git-prod", "kit-prod", "queue-confirm", "risk", "ticket"] as const;
