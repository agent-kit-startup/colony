// Mission Control snapshot store: the native views read the kit server's data API
// (GET /dashboard-data.json, then live snapshots from /api/events SSE) through the Rust
// proxy in src-tauri/src/mcdata.rs. Read-only consumer of the kit's snapshot contract
// (docs/contracts/mission-control-snapshot.schema.json, dashboardDataVersion 1.6.0):
// top-level fields are typed by the contract; nested collector shapes are open, so every
// accessor below tolerates a missing or differently shaped field.
import { api, Channel, errText, type McEvent } from "./api";

// biome-ignore lint: the snapshot is open JSON
export type J = Record<string, any>;

export interface McPlan {
  id: string;
  file: string;
  path: string;
  overview: string;
  lifecycle: string;
  parked: boolean;
  backlog: boolean;
  queueRole: string;
  queueIndex: number | null;
  progress: { completed: number; total: number; label: string };
  currentTodo: { id: string; content: string; status: string } | null;
  nextTodo: { id: string; content: string; status: string } | null;
  todos: { id: string; content: string; status: string }[];
}

export interface FeedState { connected: boolean; detail: string; updates: number; error: string | null; at: string | null }

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : v == null ? d : String(v));
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const todo = (v: unknown) => {
  const t = obj(v);
  return t.id || t.content ? { id: str(t.id), content: str(t.content), status: str(t.status) } : null;
};

class SnapshotStore {
  data: J | null = null;
  feed: FeedState = { connected: false, detail: "not started", updates: 0, error: null, at: null };
  private listeners = new Set<(why: "data" | "feed") => void>();
  private channel: Channel<McEvent> | null = null;

  on(fn: (why: "data" | "feed") => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(why: "data" | "feed") {
    for (const fn of this.listeners) {
      try {
        fn(why);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Drop the current folder's data (a new folder is opening). */
  reset() {
    if (this.channel) this.channel.onmessage = () => {};
    this.channel = null;
    this.data = null;
    this.feed = { connected: false, detail: "starting", updates: 0, error: null, at: null };
    this.emit("data");
    this.emit("feed");
  }

  private accept(text: string, live: boolean) {
    let parsed: J;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.feed.error = `snapshot is not JSON: ${errText(e)}`;
      return this.emit("feed");
    }
    this.data = parsed;
    this.feed.at = str(parsed.generatedAt) || new Date().toISOString();
    this.feed.error = typeof parsed.error === "string" ? parsed.error : null;
    if (live) this.feed.updates += 1;
    this.emit("data");
    this.emit("feed");
  }

  /** First snapshot over GET, then the SSE stream (its first message is the cached snapshot). */
  async connect() {
    try {
      this.accept(await api.mcSnapshot(), false);
    } catch (e) {
      this.feed.error = errText(e);
      this.emit("feed");
    }
    const ch = new Channel<McEvent>();
    this.channel = ch;
    ch.onmessage = (m) => {
      if (this.channel !== ch) return;
      if (m.kind === "snapshot") this.accept(m.data, true);
      else {
        this.feed.connected = m.connected;
        this.feed.detail = m.detail;
        this.emit("feed");
      }
    };
    await api.mcSubscribe(ch);
  }

  async refresh() {
    try {
      this.accept(await api.mcSnapshot(), false);
    } catch (e) {
      this.feed.error = errText(e);
      this.emit("feed");
    }
  }

  // ---- accessors (all tolerant) -----------------------------------------------------
  get mc(): J {
    return obj(this.data?.missionControl);
  }
  get now(): J {
    return obj(this.mc.now);
  }
  get system(): J {
    return obj(this.data?.system);
  }
  get handoff(): J {
    return obj(this.system.handoff);
  }
  get git(): J {
    return obj(this.data?.git);
  }
  get runQueue(): J {
    return obj(this.mc.runQueue);
  }
  get flightLog(): J {
    return obj(this.mc.flightLog);
  }
  get attention(): J[] {
    return arr(this.mc.attention);
  }
  get activity(): J[] {
    return arr(this.mc.activity);
  }
  get runLogs(): J[] {
    return arr(this.data?.runLogs);
  }
  get gateExit(): J {
    return obj(this.data?.gateExit);
  }
  get health(): J {
    return obj(this.data?.health);
  }
  get processes(): J[] {
    return arr(this.data?.processes);
  }

  /** The plan `agent-kit run-plan` will run: the HANDOFF plan, per the snapshot. */
  get activePlanFile(): string {
    return str(this.now.planFile) || str(this.handoff.plan);
  }

  /** Mission Control's plan projection joined with the to-do lists of the raw plans. */
  plans(): McPlan[] {
    const raw = new Map(arr(this.data?.plans).map((p) => [str(p.file), p]));
    return arr(this.mc.plans).map((p) => {
      const pr = obj(p.progress);
      const r = raw.get(str(p.file)) ?? {};
      return {
        id: str(p.id),
        file: str(p.file),
        path: str(p.path),
        overview: str(p.overview),
        lifecycle: str(p.lifecycle, "unknown"),
        parked: !!p.parked,
        backlog: !!p.backlog,
        queueRole: str(p.queueRole, "none"),
        queueIndex: typeof p.queueIndex === "number" ? p.queueIndex : null,
        progress: { completed: num(pr.completed), total: num(pr.total), label: str(pr.label) },
        currentTodo: todo(p.currentTodo),
        nextTodo: todo(p.nextTodo),
        todos: arr(obj(r.todos).items).map((t) => ({ id: str(t.id), content: str(t.content), status: str(t.status) })),
      };
    });
  }
}

export const snapshot = new SnapshotStore();
export { arr, num, obj, str };
