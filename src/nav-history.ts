// Back-forward history of the main pane (pure: no DOM, no imports). An entry is a tab id
// (a rail view, a run, a terminal, a file); the tab strip itself holds
// documents only, so Back / Forward (Alt+Left / Alt+Right) are how the user returns to a
// view. Browser semantics: a new visit drops the forward entries, a closed tab leaves the
// history, and moves skip ids whose tab is gone.

export class NavHistory {
  private entries: string[] = [];
  private index = -1;
  private readonly max: number;

  constructor(max = 50) {
    this.max = max;
  }

  current(): string | null {
    return this.entries[this.index] ?? null;
  }

  /** Record that `id` is now shown. */
  visit(id: string): void {
    if (this.entries[this.index] === id) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(id);
    if (this.entries.length > this.max) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  canBack(exists: (id: string) => boolean): boolean {
    return this.find(-1, exists) >= 0;
  }

  canForward(exists: (id: string) => boolean): boolean {
    return this.find(1, exists) >= 0;
  }

  /** Move to the previous entry whose tab is open; null when there is none. */
  back(exists: (id: string) => boolean): string | null {
    return this.move(-1, exists);
  }

  forward(exists: (id: string) => boolean): string | null {
    return this.move(1, exists);
  }

  /** A tab closed: drop its entries. When it was the current one, the entry before it (or
   *  else after it) becomes current. */
  forget(id: string): void {
    const kept: string[] = [];
    let at = -1;
    this.entries.forEach((e, i) => {
      // Removing an entry can leave two equal neighbours: they become one.
      if (e !== id && kept[kept.length - 1] !== e) kept.push(e);
      if (i === this.index) at = kept.length - 1;
    });
    this.entries = kept;
    this.index = kept.length ? Math.max(at, 0) : -1;
  }

  reset(): void {
    this.entries = [];
    this.index = -1;
  }

  private find(step: 1 | -1, exists: (id: string) => boolean): number {
    for (let i = this.index + step; i >= 0 && i < this.entries.length; i += step) if (exists(this.entries[i])) return i;
    return -1;
  }

  private move(step: 1 | -1, exists: (id: string) => boolean): string | null {
    const i = this.find(step, exists);
    if (i < 0) return null;
    this.index = i;
    return this.entries[i];
  }
}
