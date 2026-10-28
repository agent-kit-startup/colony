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
 * The gates a folder setting may pre-answer, and with which label (ADR point 5, Amend
 * 2026-10-28: exactly one pair). Mirrors the kit's `PREANSWERABLE_GATES` and `PREANSWERS` in
 * src-tauri/src/agent.rs. `git-prod`, `kit-prod`, `queue-confirm`, `risk` and `ticket` are
 * never pre-answerable; every other gate stays the operator's.
 */
export const PREANSWERS: Readonly<Record<string, string>> = { "context-checkpoint": "Continue queue" };
export const PREANSWER_CLASSES: readonly string[] = Object.keys(PREANSWERS);
export const NEVER_PREANSWER = ["git-prod", "kit-prod", "queue-confirm", "risk", "ticket"] as const;
/** The first driver protocol that marks a reply `"source":"policy"` and puts `usage` on `hitl_gate`. */
export const PREANSWER_PROTOCOL = "1.4.0";

/** Whether a run that announced `protocol` in `run_start` takes a policy pre-answer (1.x, >= 1.4.0). */
export function protocolHasPreanswer(protocol: unknown): boolean {
  if (typeof protocol !== "string") return false;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(protocol.trim());
  return !!m && Number(m[1]) === 1 && Number(m[2]) >= 4;
}

export interface PreanswerInput {
  /** Ask ids the folder setting turned on (default: none). */
  enabled: readonly string[];
  /** The run's `run_start.protocol`. */
  protocol: unknown;
  askId: string;
  labels: readonly string[];
  /** Tokens the run reported so far, the open gate's `usage` included; null when none. */
  spent: number | null;
  /** The folder's per-run token budget; null when none is set. */
  budget: number | null;
}

export type PreanswerDecision = { send: true; label: string } | { send: false; reason: string };

/**
 * Whether Colony answers this gate from the folder setting instead of waiting for the
 * operator. Every condition must hold: an allowed pair, the setting on for it, an engine on
 * driver protocol 1.4.0 or newer (an older one would stamp the reply as the operator's), a
 * budget set and the run's reported tokens within it. Anything else leaves the gate to the
 * operator, as before.
 */
export function decidePreanswer(o: PreanswerInput): PreanswerDecision {
  const label = Object.hasOwn(PREANSWERS, o.askId) ? PREANSWERS[o.askId] : undefined;
  if (!label || (NEVER_PREANSWER as readonly string[]).includes(o.askId)) return { send: false, reason: "not pre-answerable" };
  if (!o.enabled.includes(o.askId)) return { send: false, reason: "setting off" };
  if (!protocolHasPreanswer(o.protocol)) return { send: false, reason: `engine protocol below ${PREANSWER_PROTOCOL}` };
  if (!o.labels.includes(label)) return { send: false, reason: `the gate has no "${label}" label` };
  if (o.budget === null) return { send: false, reason: "no token budget set" };
  if (o.spent === null) return { send: false, reason: "no token usage reported" };
  if (o.spent > o.budget) return { send: false, reason: "over the token budget" };
  return { send: true, label };
}

/** The folder setting's ask ids, keeping only allowed ones (an unknown or stale id is dropped). */
export function preanswerSetting(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && Object.hasOwn(PREANSWERS, x));
}
