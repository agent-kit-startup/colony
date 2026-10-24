// The kit's repository readiness report (.cursor/context/readiness.json, written by
// `agent-kit doctor`, which /agent-kit-onboard runs), read from the opened folder. Colony
// renders it as the first-run mission list; it keeps no checklist of its own and runs no
// fix: every action goes through /agent-kit-onboard in the agent.
import { api, errText } from "./api";
import { arr, type J, obj, str } from "./snapshot";

export const READINESS_FILE = ".cursor/context/readiness.json";
/** The kit's install marker (the same file the Rust side checks for `hasKit`). */
const KIT_FILE = ".cursor/agent-kit.json";

export type CheckStatus = "ready" | "auto_fix" | "needs_choice" | "manual" | "blocked";
const STATUSES: CheckStatus[] = ["ready", "auto_fix", "needs_choice", "manual", "blocked"];

export interface ReadinessCheck {
  id: string;
  title: string;
  pillar: string;
  status: CheckStatus;
  essential: boolean;
  /** The first action's recommendation (the kit's next step for this check). */
  next: string;
}

export interface Readiness {
  generatedAt: string;
  /** Every check in report order (pillar order, then check order). */
  checks: ReadinessCheck[];
  essentials: ReadinessCheck[];
  /** Essential checks not `ready`, in report order (agent-kit-onboard Start or Resume, rule 5). */
  unresolved: ReadinessCheck[];
  /** Non-essential checks not `ready` (they reach the Inbox as attention items). */
  optionalOpen: number;
  /** "Detected:" facts with report evidence: purpose, stack, package manager. */
  detected: string[];
  /** "Fixed:" safe local fixes already applied. */
  fixed: string[];
}

/** Parse a readiness report; tolerant of missing fields, strict on the schema version. */
export function parseReadiness(text: string): Readiness {
  const d = JSON.parse(text) as J;
  if (d.schemaVersion !== 1) throw new Error(`unsupported readiness schemaVersion ${String(d.schemaVersion)}`);
  const checks: ReadinessCheck[] = [];
  for (const p of arr(d.pillars)) {
    for (const c of arr(p.checks)) {
      const status = STATUSES.includes(c.status) ? (c.status as CheckStatus) : "blocked";
      checks.push({ id: str(c.id), title: str(c.title) || str(c.id), pillar: str(p.pillar), status, essential: c.essential === true, next: str(arr(c.actions)[0]?.recommendation) });
    }
  }
  const essentials = checks.filter((c) => c.essential);
  const scan = obj(d.scan);
  const purpose = obj(scan.purpose);
  const stack = obj(scan.stack);
  const detected = [
    str(purpose.value) && str(purpose.value) !== "unknown" ? `purpose ${str(purpose.value)}${str(purpose.confidence) ? ` (${str(purpose.confidence)} confidence)` : ""}` : "",
    str(stack.language) && str(stack.language) !== "unknown" ? `stack ${str(stack.language)}${str(stack.framework) && stack.framework !== stack.language ? ` / ${str(stack.framework)}` : ""}` : "",
    str(stack.packageManager) ? `package manager ${str(stack.packageManager)}` : "",
    scan.isGreenfield === true ? "new project (greenfield)" : "",
  ].filter(Boolean);
  return {
    generatedAt: str(d.generatedAt),
    checks,
    essentials,
    unresolved: essentials.filter((c) => c.status !== "ready"),
    optionalOpen: checks.filter((c) => !c.essential && c.status !== "ready").length,
    detected,
    fixed: arr(d.appliedSafeFixes).map((a) => str(a.recommendation) || str(a.id)).filter(Boolean),
  };
}

class ReadinessStore {
  /** null: no report yet (absent, unreadable or not loaded). */
  report: Readiness | null = null;
  /** Why the report could not be used ("" when absent or fine). */
  error = "";
  loaded = false;
  /** The folder has the kit installed (re-checked on every read: an install in a terminal
   *  tab turns the no-kit screen into the readiness list without reopening the folder). */
  kit = false;
  private root = "";
  private text = "";
  private busy = false;
  private last = 0;
  private listeners = new Set<() => void>();

  on(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** A new folder: forget the old report. */
  reset(root: string, hasKit: boolean) {
    this.root = root;
    this.kit = hasKit;
    this.report = null;
    this.error = "";
    this.text = "";
    this.loaded = false;
    this.last = 0;
    this.emit();
  }

  /** Read the report again; `minGapMs` skips the read when the last one is that recent. */
  async load(minGapMs = 0) {
    const root = this.root;
    if (!root || this.busy || Date.now() - this.last < minGapMs) return;
    this.busy = true;
    this.last = Date.now();
    let text = "";
    let error = "";
    let kit = this.kit;
    try {
      kit = await api.readTextFile(`${root}/${KIT_FILE}`).then(() => true, () => false);
      text = await api.readTextFile(`${root}/${READINESS_FILE}`);
    } catch (e) {
      // An absent report is the normal first-run state, not an error.
      if (!/no such file|not found/i.test(errText(e))) error = errText(e);
    } finally {
      this.busy = false;
    }
    if (root !== this.root) return;
    const wasLoaded = this.loaded;
    this.loaded = true;
    if (wasLoaded && kit === this.kit && text === this.text && error === this.error) return;
    this.kit = kit;
    this.text = text;
    this.error = error;
    this.report = null;
    if (text) {
      try {
        this.report = parseReadiness(text);
      } catch (e) {
        this.error = `${READINESS_FILE}: ${errText(e)}`;
      }
    }
    this.emit();
  }
}

export const readiness = new ReadinessStore();
