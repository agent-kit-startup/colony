// The TTY sessions of this window, for the Terminals view (plan colony-sidebar-native-kit
// s3): the drawer's shells and the centre terminal tabs (interactive vendor CLIs, the queue
// runner), open, exited or closed. A shell closed in the drawer bar stays listed here with
// its last folder, so the view can open a new shell there. Terminal control itself stays in
// the drawer bar (ADR 2026-10-24 amend point 3): nothing here spawns or kills a process.
import { api } from "./api";

export type TtyPlace = "drawer" | "tab";
export type TtyState = "open" | "exited" | "closed";

export interface TtySession {
  /** `drawer:<n>` (the drawer's shell number) or the centre tab id (`term:<n>`). */
  key: string;
  place: TtyPlace;
  label: string;
  /** The argv it runs; null for the user's login shell. */
  argv: string[] | null;
  /** The folder it started in (the opened folder). */
  root: string;
  /** Its current folder, read from the shell (Linux /proc) while open; the last one read after. */
  cwd: string;
  /** The terminal title the program set (OSC 0/2), often the running command; "" if none. */
  title: string;
  state: TtyState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** The PTY id while the process may still run (-1 before spawn). */
  ptyId: number;
}

/** Closed sessions kept per window (oldest dropped first). */
const MAX_CLOSED = 50;

class TtyRegistry {
  private rows: TtySession[] = [];
  private listeners = new Set<() => void>();

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Newest first. */
  list(): TtySession[] {
    return [...this.rows].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(key: string): TtySession | undefined {
    return this.rows.find((r) => r.key === key);
  }

  add(s: Omit<TtySession, "state" | "exitCode" | "endedAt" | "title" | "cwd" | "ptyId">): TtySession {
    const row: TtySession = { ...s, cwd: s.root, title: "", state: "open", exitCode: null, endedAt: null, ptyId: -1 };
    this.rows = this.rows.filter((r) => r.key !== s.key);
    this.rows.push(row);
    this.emit();
    return row;
  }

  update(key: string, patch: Partial<TtySession>) {
    const r = this.get(key);
    if (!r) return;
    Object.assign(r, patch);
    this.emit();
  }

  exited(key: string, code: number | null) {
    const r = this.get(key);
    if (!r || r.state !== "open") return;
    this.update(key, { state: "exited", exitCode: code, endedAt: Date.now() });
  }

  closed(key: string) {
    const r = this.get(key);
    if (!r) return;
    this.update(key, { state: "closed", endedAt: r.endedAt ?? Date.now() });
    const closed = this.rows.filter((x) => x.state === "closed");
    if (closed.length > MAX_CLOSED) {
      const drop = new Set(closed.sort((a, b) => a.startedAt - b.startedAt).slice(0, closed.length - MAX_CLOSED));
      this.rows = this.rows.filter((x) => !drop.has(x));
    }
  }

  /** Read the current folder of every open session (one /proc read each). */
  async refreshCwds(): Promise<void> {
    let changed = false;
    for (const r of this.rows) {
      if (r.state !== "open" || r.ptyId < 0) continue;
      const cwd = await api.ptyCwd(r.ptyId).catch(() => null);
      if (cwd && cwd !== r.cwd) {
        r.cwd = cwd;
        changed = true;
      }
    }
    if (changed) this.emit();
  }
}

export const ttys = new TtyRegistry();
